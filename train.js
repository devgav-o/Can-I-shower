const https = require('https');
const fs = require('fs');
const {
    buildSalvos, computeRisk,
    hasAlertInWindow, parseIsraelTimestamp, DEFAULT_PARAMS,
} = require('./shared');

const API_BASE = 'https://agg.rocketalert.live/api/v1/alerts/details';
const HTTP_TIMEOUT_MS = 30000;

const POP_SIZE = 100;
const GENERATIONS = 10;
const MUTATION_RATE = 0.35;
const ELITE_COUNT = 10;

const PARAM_RANGES = {
    growth_rate:      { min: 0.003,  max: 0.03 },
    drop_per_salvo:   { min: 0.05,   max: 0.8 },
    satiation_boost:  { min: 0.2,    max: 5 },
    satiation_decay:  { min: 0.05,   max: 1.0 },
    base_duration:    { min: 3,      max: 15 },
    barrage_halflife: { min: 3,      max: 120 },
};

const CEASEFIRE_GAP_MIN = 720;

function isoDate(d) { return d.toISOString().slice(0, 10); }
function pct(v) { return (v * 100).toFixed(1) + '%'; }

function splitConflictWindows(salvos) {
    const sorted = [...salvos].sort((a, b) => a.timestamp - b.timestamp);
    if (sorted.length === 0) return [];
    const windows = [];
    let start = 0;
    for (let i = 1; i < sorted.length; i++) {
        const gapMin = (sorted[i].timestamp - sorted[i - 1].timestamp) / 60;
        if (gapMin > CEASEFIRE_GAP_MIN) {
            if (i - start >= 3) windows.push(sorted.slice(start, i));
            start = i;
        }
    }
    if (sorted.length - start >= 3) windows.push(sorted.slice(start));
    return windows;
}

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
                                timestamp: parseIsraelTimestamp(a.timeStamp),
                                type: a.alertTypeId,
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

function randomParams() {
    const p = {};
    for (const [key, range] of Object.entries(PARAM_RANGES)) {
        p[key] = range.min + Math.random() * (range.max - range.min);
    }
    return p;
}

function clampParams(p) {
    const c = {};
    for (const [key, range] of Object.entries(PARAM_RANGES)) {
        c[key] = Math.max(range.min, Math.min(range.max, p[key]));
    }
    return c;
}

function crossover(a, b) {
    const child = {};
    for (const key of Object.keys(PARAM_RANGES)) {
        child[key] = Math.random() < 0.5 ? a[key] : b[key];
    }
    return child;
}

function mutate(p) {
    const m = { ...p };
    for (const [key, range] of Object.entries(PARAM_RANGES)) {
        if (Math.random() < MUTATION_RATE) {
            const span = range.max - range.min;
            m[key] += (Math.random() - 0.5) * span * 0.4;
        }
    }
    return clampParams(m);
}

function buildTestPointsForSet(salvos) {
    const timestamps = salvos.map(s => s.timestamp);
    const startSec = salvos[0].timestamp;
    const endSec = salvos[salvos.length - 1].timestamp + 4 * 3600;
    const step = 300;
    const durations = [5, 10, 15, 30, 60];
    const points = [];

    for (let nowSec = startSec; nowSec <= endSec; nowSec += step) {
        const actuals = durations.map(dur =>
            hasAlertInWindow(timestamps, nowSec, nowSec + dur * 60) ? 1 : 0
        );
        points.push({ nowSec, durations, actuals });
    }
    return { salvos, points };
}

function evaluateFitness(params, periodData) {
    let brierSum = 0, n = 0;
    for (const { salvos, points } of periodData) {
        for (const { nowSec, durations, actuals } of points) {
            const pastSalvos = [];
            for (const s of salvos) {
                if (s.timestamp > nowSec) break;
                pastSalvos.push(s);
            }
            if (pastSalvos.length < 2) continue;
            for (let d = 0; d < durations.length; d++) {
                const pred = computeRisk(pastSalvos, durations[d], nowSec, params);
                brierSum += (pred.risk - actuals[d]) ** 2;
                n++;
            }
        }
    }
    return n > 0 ? brierSum / n : 1;
}

const SEEDS = [
    { growth_rate: 0.005, drop_per_salvo: 0.3, satiation_boost: 2, satiation_decay: 0.1, base_duration: 10, barrage_halflife: 15 },
    { growth_rate: 0.008, drop_per_salvo: 0.2, satiation_boost: 1, satiation_decay: 0.2, base_duration: 8, barrage_halflife: 30 },
    { growth_rate: 0.015, drop_per_salvo: 0.5, satiation_boost: 3, satiation_decay: 0.08, base_duration: 5, barrage_halflife: 10 },
    { growth_rate: 0.01, drop_per_salvo: 0.15, satiation_boost: 4, satiation_decay: 0.15, base_duration: 12, barrage_halflife: 45 },
    { growth_rate: 0.02, drop_per_salvo: 0.4, satiation_boost: 0.5, satiation_decay: 0.5, base_duration: 7, barrage_halflife: 20 },
];

function geneticSearch(salvoSets) {
    const periodData = salvoSets.map(s => buildTestPointsForSet(s));
    const totalPoints = periodData.reduce((s, d) => s + d.points.length, 0);
    console.log(`  ${periodData.length} periods, ${totalPoints} total test points`);
    const seeded = SEEDS.map(s => clampParams(s));
    const random = Array.from({ length: POP_SIZE - seeded.length }, () => randomParams());
    let population = [...seeded, ...random];

    let bestEver = null;
    let bestScore = Infinity;

    for (let gen = 0; gen < GENERATIONS; gen++) {
        const scored = population.map(p => ({
            params: p,
            score: evaluateFitness(p, periodData),
        })).sort((a, b) => a.score - b.score);

        if (scored[0].score < bestScore) {
            bestScore = scored[0].score;
            bestEver = scored[0].params;
        }

        if ((gen + 1) % 10 === 0)
            console.log(`  Gen ${gen + 1}: best=${scored[0].score.toFixed(4)}, avg=${(scored.reduce((s, x) => s + x.score, 0) / scored.length).toFixed(4)}`);

        const elite = scored.slice(0, ELITE_COUNT).map(s => s.params);
        const newPop = [...elite];

        while (newPop.length < POP_SIZE) {
            const a = elite[Math.floor(Math.random() * elite.length)];
            const b = elite[Math.floor(Math.random() * elite.length)];
            newPop.push(mutate(crossover(a, b)));
        }
        population = newPop;
    }

    console.log(`  Best Brier: ${bestScore.toFixed(4)}`);
    return bestEver;
}

async function main() {
    console.log('=== TRAINING HUNGER MODEL (Genetic Algorithm) ===\n');

    console.log('Fetching historical data...');
    const t0 = Date.now();
    const [alerts1, alerts2] = await Promise.all([
        fetchAlerts(isoDate(new Date(Date.UTC(2025, 5, 15))), isoDate(new Date(Date.UTC(2025, 5, 23)))),
        fetchAlerts(isoDate(new Date(Date.UTC(2026, 1, 28))), isoDate(new Date(Date.UTC(2026, 2, 15)))),
    ]);
    console.log(`  Got ${alerts1.length + alerts2.length} alerts in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const parsed1 = buildSalvos(alerts1);
    const parsed2 = buildSalvos(alerts2);
    console.log(`  Period 1 (Jun 2025): ${parsed1.salvos.length} salvos`);
    console.log(`  Period 2 (Feb 2026+): ${parsed2.salvos.length} salvos`);

    const allSalvoSets = splitConflictWindows([...parsed1.salvos, ...parsed2.salvos]);
    console.log(`  Split into ${allSalvoSets.length} conflict windows:`);
    for (const w of allSalvoSets) {
        const spanH = ((w[w.length - 1].timestamp - w[0].timestamp) / 3600).toFixed(1);
        console.log(`    ${w.length} salvos over ${spanH}h`);
    }

    console.log('\nRunning genetic algorithm...');
    const t1 = Date.now();
    const params = geneticSearch(allSalvoSets);
    console.log(`  Done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    console.log(`  Best params: ${JSON.stringify(params, null, 2)}`);

    const model = {
        params,
        trainedAt: new Date().toISOString(),
        conflictWindows: allSalvoSets.map(s => ({
            from: new Date(s[0].timestamp * 1000).toISOString(),
            to: new Date(s[s.length - 1].timestamp * 1000).toISOString(),
            salvos: s.length,
        })),
    };

    fs.writeFileSync('model.json', JSON.stringify(model, null, 2));
    console.log('\nWrote model.json');

    const lastSet = allSalvoSets[allSalvoSets.length - 1];
    console.log('\nSanity trajectory (duration=10m, last period):');
    const lastSalvo = lastSet[lastSet.length - 1];
    console.log(`  ${'Elapsed'.padEnd(10)} ${'Risk'.padStart(7)} ${'Hunger'.padStart(8)} ${'Barrage'.padStart(9)} ${'BWeight'.padStart(8)}`);
    for (const e of [0, 2, 5, 10, 20, 30, 60, 120, 240, 480, 1440, 4320, 14400]) {
        const fakeNow = lastSalvo.timestamp + e * 60;
        const pastSalvos = lastSet.filter(s => s.timestamp <= fakeNow);
        if (pastSalvos.length < 2) continue;
        const pred = computeRisk(pastSalvos, 10, fakeNow, params);
        const hi = pred.hungerInfo;
        const label = e < 60 ? `${e}m` : e < 1440 ? `${(e / 60).toFixed(0)}h` : `${(e / 1440).toFixed(0)}d`;
        console.log(`  ${label.padEnd(10)} ${pct(pred.risk).padStart(7)} ${hi.hunger.toFixed(4).padStart(8)} ${pct(hi.barrageRisk).padStart(9)} ${hi.barrageWeight.toFixed(3).padStart(8)}`);
    }
}

main().catch(e => { console.error('Training failed:', e); process.exit(1); });
