// train.js
const https = require('https');
const fs = require('fs');
const {
    buildSalvos, generateTrainingData, RandomForest,
    extractFeatures, computeClusterMeta, getActiveCluster,
    hasAlertInWindow, timeToNextAlert,
    RECENT_GAPS_COUNT, FEATURE_NAMES
} = require('./shared');

const API_BASE = 'https://agg.rocketalert.live/api/v1/alerts/details';
const HTTP_TIMEOUT_MS = 30000;
const MODEL_PATH = './model.json';

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

function evaluateResidual(rf, salvos, label) {
    const timestamps = salvos.map(s => s.timestamp);
    const warmup = 2 * 3600;
    const minNow = salvos[0].timestamp + warmup;
    const lastTs = salvos[salvos.length - 1].timestamp;

    console.log(`\n  ${label} — Residual prediction quality:`);

    let maeSum = 0, maeN = 0;
    const buckets = [
        { label: '0-5m elpsd', lo: 0, hi: 5, predSum: 0, actualSum: 0, n: 0 },
        { label: '5-15m', lo: 5, hi: 15, predSum: 0, actualSum: 0, n: 0 },
        { label: '15-60m', lo: 15, hi: 60, predSum: 0, actualSum: 0, n: 0 },
        { label: '1-6h', lo: 60, hi: 360, predSum: 0, actualSum: 0, n: 0 },
        { label: '6h+', lo: 360, hi: Infinity, predSum: 0, actualSum: 0, n: 0 },
    ];

    for (let nowSec = minNow; nowSec <= lastTs; nowSec += 120) {
        const { salvos: active } = getActiveCluster(salvos, nowSec);
        if (active.length < 3) continue;

        const gaps = [];
        for (let i = 1; i < active.length; i++) {
            const g = (active[i].timestamp - active[i - 1].timestamp) / 60;
            if (g > 0) gaps.push(g);
        }
        const recentGaps = gaps.slice(-RECENT_GAPS_COUNT);
        if (recentGaps.length < 3) continue;

        const activeLastTs = active[active.length - 1].timestamp;
        const elapsed = (nowSec - activeLastTs) / 60;

        const actualTTNA = timeToNextAlert(timestamps, nowSec);
        if (actualTTNA === null) continue;
        const actualCapped = Math.min(actualTTNA, 480);

        const meta = computeClusterMeta(active, nowSec);
        const features = extractFeatures(recentGaps, elapsed, meta);
        const predicted = rf.predict(features);

        const err = Math.abs(predicted - actualCapped);
        maeSum += err;
        maeN++;

        for (const b of buckets) {
            if (elapsed >= b.lo && elapsed < b.hi) {
                b.predSum += predicted;
                b.actualSum += actualCapped;
                b.n++;
                break;
            }
        }
    }

    console.log(`  Overall MAE: ${(maeSum / maeN).toFixed(1)} minutes (n=${maeN})`);
    console.log(`  ${'Elapsed'.padEnd(12)} ${'N'.padStart(6)} ${'AvgPred'.padStart(8)} ${'AvgActual'.padStart(10)} ${'MAE'.padStart(8)}`);
    for (const b of buckets) {
        if (b.n === 0) continue;
        console.log(
            `  ${b.label.padEnd(12)} ${String(b.n).padStart(6)} ${(b.predSum / b.n).toFixed(1).padStart(8)} ${(b.actualSum / b.n).toFixed(1).padStart(10)}`
        );
    }

    // Now evaluate as probability predictor for various windows
    console.log(`\n  ${label} — Probability calibration (using tree distribution):`);
    const showers = [5, 10, 15, 30, 60];
    const extraAfter = 12 * 3600;
    const maxNow = lastTs + extraAfter;

    for (const shower of showers) {
        let brierSum = 0, n = 0;
        const numBins = 10;
        const bins = Array.from({ length: numBins }, () => ({ count: 0, sumPred: 0, sumOutcome: 0 }));

        for (let nowSec = minNow; nowSec <= maxNow; nowSec += 180) {
            const { salvos: active } = getActiveCluster(salvos, nowSec);
            if (active.length < 3) continue;

            const gaps = [];
            for (let i = 1; i < active.length; i++) {
                const g = (active[i].timestamp - active[i - 1].timestamp) / 60;
                if (g > 0) gaps.push(g);
            }
            const recentGaps = gaps.slice(-RECENT_GAPS_COUNT);
            if (recentGaps.length < 3) continue;

            const activeLastTs = active[active.length - 1].timestamp;
            const elapsed = (nowSec - activeLastTs) / 60;

            const meta = computeClusterMeta(active, nowSec);
            const features = extractFeatures(recentGaps, elapsed, meta);

            // Use tree distribution for probability
            const pred = rf.predictProb(features, shower);
            const occurred = hasAlertInWindow(timestamps, nowSec, nowSec + shower * 60) ? 1 : 0;

            brierSum += (pred - occurred) ** 2;
            n++;

            const bin = Math.min(numBins - 1, Math.floor(pred * numBins));
            bins[bin].count++;
            bins[bin].sumPred += pred;
            bins[bin].sumOutcome += occurred;
        }

        const brier = n > 0 ? brierSum / n : 999;
        const baseRate = bins.reduce((s, b) => s + b.sumOutcome, 0) / n;
        const baselineBrier = baseRate * (1 - baseRate);
        const skill = 1 - brier / Math.max(0.001, baselineBrier);
        console.log(`\n  Window=${String(shower).padStart(3)}m: Brier=${brier.toFixed(4)}, Skill=${skill.toFixed(3)}, BaseRate=${pct(baseRate)}, N=${n}`);

        for (let b = 0; b < numBins; b++) {
            const info = bins[b];
            if (!info.count) continue;
            const avgPred = info.sumPred / info.count;
            const empirical = info.sumOutcome / info.count;
            const delta = empirical - avgPred;
            console.log(
                `    ${(b * 10)}-${(b + 1) * 10}%`.padEnd(12) +
                `n=${String(info.count).padStart(5)} ` +
                `pred=${pct(avgPred).padStart(6)} ` +
                `actual=${pct(empirical).padStart(6)} ` +
                `Δ=${(delta >= 0 ? '+' : '') + pct(delta)}`
            );
        }
    }

    // Elapsed-specific probability breakdown
    console.log(`\n  Elapsed × Window probability matrix:`);
    const elBuckets = [
        { label: '0-5m', lo: 0, hi: 5 },
        { label: '5-15m', lo: 5, hi: 15 },
        { label: '15-60m', lo: 15, hi: 60 },
        { label: '1-6h', lo: 60, hi: 360 },
        { label: '6h+', lo: 360, hi: Infinity },
    ];
    const windows = [5, 15, 60];

    const matrix = {};
    for (const eb of elBuckets) {
        matrix[eb.label] = {};
        for (const w of windows) {
            matrix[eb.label][w] = { predSum: 0, actualSum: 0, n: 0 };
        }
    }

    for (let nowSec = minNow; nowSec <= maxNow; nowSec += 300) {
        const { salvos: active } = getActiveCluster(salvos, nowSec);
        if (active.length < 3) continue;
        const gaps = [];
        for (let i = 1; i < active.length; i++) {
            const g = (active[i].timestamp - active[i - 1].timestamp) / 60;
            if (g > 0) gaps.push(g);
        }
        const recentGaps = gaps.slice(-RECENT_GAPS_COUNT);
        if (recentGaps.length < 3) continue;
        const activeLastTs = active[active.length - 1].timestamp;
        const elapsed = (nowSec - activeLastTs) / 60;
        const meta = computeClusterMeta(active, nowSec);
        const features = extractFeatures(recentGaps, elapsed, meta);

        for (const eb of elBuckets) {
            if (elapsed >= eb.lo && elapsed < eb.hi) {
                for (const w of windows) {
                    const pred = rf.predictProb(features, w);
                    const occurred = hasAlertInWindow(timestamps, nowSec, nowSec + w * 60) ? 1 : 0;
                    matrix[eb.label][w].predSum += pred;
                    matrix[eb.label][w].actualSum += occurred;
                    matrix[eb.label][w].n++;
                }
                break;
            }
        }
    }

    const header = '  ' + 'Elapsed'.padEnd(10) + windows.map(w => `${w}m pred/actual`.padStart(16)).join('');
    console.log(header);
    for (const eb of elBuckets) {
        let row = '  ' + eb.label.padEnd(10);
        for (const w of windows) {
            const m = matrix[eb.label][w];
            if (m.n === 0) { row += '       -        '; continue; }
            const p = m.predSum / m.n;
            const a = m.actualSum / m.n;
            row += `${pct(p).padStart(6)}/${pct(a).padStart(5)}`.padStart(16);
        }
        console.log(row);
    }
}

async function main() {
    console.log('=== TRAINING SURVIVAL REGRESSION FOREST ===\n');
    console.log(`Features: ${FEATURE_NAMES.length} (${FEATURE_NAMES.join(', ')})`);
    console.log('Model predicts TIME-TO-NEXT-EVENT (minutes)');
    console.log('P(alert in W) = fraction of trees predicting residual ≤ W\n');

    console.log('Fetching historical data...');
    const [alerts1, alerts2] = await Promise.all([
        fetchDateRange(new Date(Date.UTC(2025, 5, 15)), new Date(Date.UTC(2025, 5, 23))),
        fetchDateRange(new Date(Date.UTC(2026, 1, 28)), new Date(Date.UTC(2026, 2, 15)))
    ]);

    console.log(`\nTotal alerts: ${alerts1.length + alerts2.length}`);
    const { salvos: salvos1 } = buildSalvos(alerts1);
    const { salvos: salvos2 } = buildSalvos(alerts2);
    console.log(`Period 1 (Jun 2025): ${salvos1.length} salvos`);
    console.log(`Period 2 (Feb 2026+): ${salvos2.length} salvos`);

    console.log('\nGenerating regression training data...');
    const td1 = generateTrainingData(salvos1, { maxSamples: 12000 });
    const td2 = generateTrainingData(salvos2, { maxSamples: 12000 });
    const X = [...td1.X, ...td2.X];
    const y = [...td1.y, ...td2.y];

    // Stats on target
    const sortedY = [...y].sort((a, b) => a - b);
    console.log(`Training samples: ${X.length}`);
    console.log(`Target (time-to-next) stats:`);
    console.log(`  min=${sortedY[0].toFixed(1)}m, p25=${sortedY[Math.floor(y.length * 0.25)].toFixed(1)}m, median=${sortedY[Math.floor(y.length * 0.5)].toFixed(1)}m, p75=${sortedY[Math.floor(y.length * 0.75)].toFixed(1)}m, max=${sortedY[y.length - 1].toFixed(1)}m`);
    console.log(`  mean=${(y.reduce((a, b) => a + b, 0) / y.length).toFixed(1)}m`);

    if (X.length < 100) {
        console.error('Not enough training data.');
        process.exit(1);
    }

    console.log('\nTraining Random Forest (120 trees, depth 12)...');
    const startTime = Date.now();
    const rf = new RandomForest(120, 12, 10, 0.7);
    rf.fit(X, y);
    console.log(`Training completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    if (salvos1.length >= 5) evaluateResidual(rf, salvos1, 'Period 1 (Jun 2025)');
    if (salvos2.length >= 5) evaluateResidual(rf, salvos2, 'Period 2 (Feb 2026+)');

    // Cross-validation on regression
    console.log('\n5-fold CV (regression MAE)...');
    const indices = Array.from({ length: X.length }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    let cvMAESum = 0, cvN = 0;
    const foldSize = Math.floor(X.length / 5);
    for (let fold = 0; fold < 5; fold++) {
        const valIdx = new Set(indices.slice(fold * foldSize, (fold + 1) * foldSize));
        const tX = [], tY = [], vX = [], vY = [];
        for (let i = 0; i < X.length; i++) {
            if (valIdx.has(i)) { vX.push(X[i]); vY.push(y[i]); }
            else { tX.push(X[i]); tY.push(y[i]); }
        }
        const cvRF = new RandomForest(80, 12, 10, 0.7);
        cvRF.fit(tX, tY);
        let mae = 0;
        for (let i = 0; i < vX.length; i++) {
            mae += Math.abs(cvRF.predict(vX[i]) - vY[i]);
        }
        mae /= vX.length;
        cvMAESum += mae * vX.length;
        cvN += vX.length;
        console.log(`  Fold ${fold + 1}: MAE=${mae.toFixed(1)}m (n=${vX.length})`);
    }
    console.log(`  Mean CV MAE: ${(cvMAESum / cvN).toFixed(1)}m`);

    // Save
    const modelData = {
        version: 5,
        trainedAt: new Date().toISOString(),
        modelType: 'regression_residual',
        trainSamples: X.length,
        targetStats: {
            mean: y.reduce((a, b) => a + b, 0) / y.length,
            median: sortedY[Math.floor(y.length * 0.5)],
        },
        periods: [
            { label: 'Jun 2025', from: '2025-06-15', to: '2025-06-22', alerts: alerts1.length },
            { label: 'Feb 2026+', from: '2026-02-28', to: 'ongoing', alerts: alerts2.length }
        ],
        featureNames: FEATURE_NAMES,
        forest: rf.toJSON()
    };

    fs.writeFileSync(MODEL_PATH, JSON.stringify(modelData));
    const fileSizeKB = (Buffer.byteLength(JSON.stringify(modelData)) / 1024).toFixed(0);
    console.log(`\nModel saved to ${MODEL_PATH} (${fileSizeKB} KB)`);
    console.log('Done.');
}

main().catch(e => { console.error('Training failed:', e); process.exit(1); });