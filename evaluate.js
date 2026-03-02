// evaluate.js
const https = require('https');
const {
    buildSalvos, getActiveCluster, computeRisk, hasAlertInWindow
} = require('./shared');

const API_BASE = 'https://agg.rocketalert.live/api/v1/alerts/details';
const HTTP_TIMEOUT_MS = 30000;

function isoDate(d) { return d.toISOString().slice(0, 10); }
function pct(v) { return (v * 100).toFixed(1) + '%'; }

function fetchAlerts(from, to) {
    const url = new URL(`${API_BASE}?from=${from}&to=${to}`);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: url.hostname, path: url.pathname + url.search, method: 'GET',
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.success) return reject(new Error(json.error || 'API error'));
                    const alerts = [];
                    for (const day of json.payload) {
                        for (const a of day.alerts) {
                            if (a.alertTypeId !== 1 && a.alertTypeId !== 2) continue;
                            alerts.push({
                                location: a.name,
                                timestamp: Math.floor(new Date(a.timeStamp + '+03:00').getTime() / 1000),
                                type: a.alertTypeId
                            });
                        }
                    }
                    resolve(alerts);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        const t = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, HTTP_TIMEOUT_MS);
        req.on('close', () => clearTimeout(t));
        req.end();
    });
}

async function fetchDateRange(fromDate, toDate) {
    console.log(`  Fetching ${isoDate(fromDate)} → ${isoDate(toDate)}...`);
    const alerts = await fetchAlerts(isoDate(fromDate), isoDate(toDate));
    console.log(`  Got ${alerts.length} alerts`);
    return alerts;
}

function evaluatePeriod(allSalvos, timestamps, label) {
    const warmup = 2 * 3600;
    const extraAfter = 12 * 3600;
    const minNow = allSalvos[0].timestamp + warmup;
    const maxNow = allSalvos[allSalvos.length - 1].timestamp + extraAfter;

    const windows = [5, 10, 15, 30, 60];

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${label}`);
    console.log(`${'='.repeat(60)}`);

    for (const window of windows) {
        let brierSum = 0, n = 0;
        const numBins = 10;
        const bins = Array.from({ length: numBins }, () => ({ count: 0, sumPred: 0, sumOutcome: 0 }));

        const elBuckets = [
            { label: '0-5m', lo: 0, hi: 5, predSum: 0, actualSum: 0, n: 0 },
            { label: '5-15m', lo: 5, hi: 15, predSum: 0, actualSum: 0, n: 0 },
            { label: '15-60m', lo: 15, hi: 60, predSum: 0, actualSum: 0, n: 0 },
            { label: '1-6h', lo: 60, hi: 360, predSum: 0, actualSum: 0, n: 0 },
            { label: '6h+', lo: 360, hi: Infinity, predSum: 0, actualSum: 0, n: 0 },
        ];

        for (let nowSec = minNow; nowSec <= maxNow; nowSec += 180) {
            const { salvos: active } = getActiveCluster(allSalvos, nowSec);
            if (active.length < 2) continue;

            const pred = computeRisk(active, window, nowSec);
            const occurred = hasAlertInWindow(timestamps, nowSec, nowSec + window * 60) ? 1 : 0;

            brierSum += (pred.risk - occurred) ** 2;
            n++;

            const bin = Math.min(numBins - 1, Math.floor(pred.risk * numBins));
            bins[bin].count++;
            bins[bin].sumPred += pred.risk;
            bins[bin].sumOutcome += occurred;

            const elapsed = pred.minutesSinceLastAlert;
            for (const eb of elBuckets) {
                if (elapsed >= eb.lo && elapsed < eb.hi) {
                    eb.predSum += pred.risk;
                    eb.actualSum += occurred;
                    eb.n++;
                    break;
                }
            }
        }

        const brier = n > 0 ? brierSum / n : 999;
        const baseRate = bins.reduce((s, b) => s + b.sumOutcome, 0) / n;
        const baselineBrier = baseRate * (1 - baseRate);
        const skill = 1 - brier / Math.max(0.001, baselineBrier);
        console.log(`\n  Window=${String(window).padStart(3)}m: Brier=${brier.toFixed(4)}, Skill=${skill.toFixed(3)}, BaseRate=${pct(baseRate)}, N=${n}`);

        console.log(`  ${'Bin'.padEnd(10)} ${'N'.padStart(5)} ${'Pred'.padStart(7)} ${'Actual'.padStart(7)} ${'Δ'.padStart(8)}`);
        for (let b = 0; b < numBins; b++) {
            const info = bins[b];
            if (!info.count) continue;
            const avgPred = info.sumPred / info.count;
            const empirical = info.sumOutcome / info.count;
            const delta = empirical - avgPred;
            console.log(
                `  ${(b * 10 + '-' + (b + 1) * 10 + '%').padEnd(10)} ${String(info.count).padStart(5)} ${pct(avgPred).padStart(7)} ${pct(empirical).padStart(7)} ${((delta >= 0 ? '+' : '') + pct(delta)).padStart(8)}`
            );
        }

        console.log(`  By elapsed:`);
        console.log(`  ${'Elapsed'.padEnd(10)} ${'N'.padStart(6)} ${'Pred'.padStart(7)} ${'Actual'.padStart(7)} ${'Δ'.padStart(8)}`);
        for (const eb of elBuckets) {
            if (eb.n === 0) continue;
            const ap = eb.predSum / eb.n;
            const ar = eb.actualSum / eb.n;
            const d = ar - ap;
            console.log(
                `  ${eb.label.padEnd(10)} ${String(eb.n).padStart(6)} ${pct(ap).padStart(7)} ${pct(ar).padStart(7)} ${((d >= 0 ? '+' : '') + pct(d)).padStart(8)}`
            );
        }
    }

    // Sanity check
    console.log(`\n  Sanity — predictions at various elapsed:`);
    const lastSalvo = allSalvos[allSalvos.length - 1];
    const testElapsed = [0, 2, 5, 10, 20, 30, 60, 120, 360, 720, 1440];
    for (const e of testElapsed) {
        const fakeNow = lastSalvo.timestamp + e * 60;
        const { salvos: active } = getActiveCluster(allSalvos, fakeNow);
        if (active.length < 2) { console.log(`  e=${String(e).padStart(5)}m: insufficient data`); continue; }
        const p5 = computeRisk(active, 5, fakeNow);
        const p15 = computeRisk(active, 15, fakeNow);
        const p60 = computeRisk(active, 60, fakeNow);
        const p999 = computeRisk(active, 999, fakeNow);
        const ri = p15.rateInfo;
        console.log(
            `  e=${String(e).padStart(5)}m: ` +
            `P(5)=${pct(p5.risk).padStart(6)} ` +
            `P(15)=${pct(p15.risk).padStart(6)} ` +
            `P(60)=${pct(p60.risk).padStart(6)} ` +
            `P(999)=${pct(p999.risk).padStart(6)} ` +
            `wait=${p15.expectedWait != null ? p15.expectedWait.toFixed(0).padStart(4) + 'm' : ' N/A'} ` +
            `cRate=${(ri.conflictRate * 60).toFixed(2)}/h ` +
            `bRate=${(ri.adjustedBurstRate * 60).toFixed(2)}/h ` +
            `decay=${ri.burstDecay.toFixed(3)}`
        );
    }
}

async function main() {
    console.log('=== EVALUATING DUAL-RATE MODEL ===\n');
    console.log('CONFLICT rate = sustained rate over days (floor)');
    console.log('BURST rate = immediate barrage rate (decays with elapsed)');
    console.log('Risk = max(conflict prob, burst prob)\n');

    console.log('Fetching historical data...');
    const [alerts1, alerts2] = await Promise.all([
        fetchDateRange(new Date(Date.UTC(2025, 5, 15)), new Date(Date.UTC(2025, 5, 23))),
        fetchDateRange(new Date(Date.UTC(2026, 1, 28)), new Date(Date.UTC(2026, 2, 15)))
    ]);

    console.log(`\nTotal alerts: ${alerts1.length + alerts2.length}`);
    const parsed1 = buildSalvos(alerts1);
    const parsed2 = buildSalvos(alerts2);
    console.log(`Period 1 (Jun 2025): ${parsed1.salvos.length} salvos`);
    console.log(`Period 2 (Feb 2026+): ${parsed2.salvos.length} salvos`);

    for (const [label, parsed] of [['Period 1', parsed1], ['Period 2', parsed2]]) {
        const gaps = [];
        for (let i = 1; i < parsed.salvos.length; i++) {
            const g = (parsed.salvos[i].timestamp - parsed.salvos[i - 1].timestamp) / 60;
            if (g > 0) gaps.push(g);
        }
        if (gaps.length === 0) continue;
        const sorted = [...gaps].sort((a, b) => a - b);
        const spanHours = ((parsed.salvos[parsed.salvos.length - 1].timestamp - parsed.salvos[0].timestamp) / 3600).toFixed(1);
        const avgRate = (parsed.salvos.length / (spanHours / 1)).toFixed(2);
        console.log(`\n  ${label}: ${gaps.length} gaps over ${spanHours}h = ${avgRate} salvos/h avg`);
        console.log(`    gaps: min=${sorted[0].toFixed(1)}m, median=${sorted[Math.floor(gaps.length / 2)].toFixed(1)}m, mean=${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)}m, max=${sorted[gaps.length - 1].toFixed(1)}m`);
    }

    const timestamps1 = parsed1.salvos.map(s => s.timestamp);
    const timestamps2 = parsed2.salvos.map(s => s.timestamp);

    if (parsed1.salvos.length >= 5) evaluatePeriod(parsed1.salvos, timestamps1, 'Period 1 (Jun 2025)');
    if (parsed2.salvos.length >= 5) evaluatePeriod(parsed2.salvos, timestamps2, 'Period 2 (Feb 2026+)');

    console.log('\n\nDone.');
}

main().catch(e => { console.error('Evaluation failed:', e); process.exit(1); });