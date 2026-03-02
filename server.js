const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = 3000;

const API_BASE = 'https://agg.rocketalert.live/api/v1/alerts/details';
const FETCH_INTERVAL = 5 * 60 * 1000;
const HISTORY_DAYS = 90;
const SALVO_WINDOW_SEC = 120;

let parsedCache = null;
let lastFetch = null;
let allAlerts = [];

function isoDate(d) {
    return d.toISOString().slice(0, 10);
}

function fetchAlerts(from, to) {
    const url = new URL(`${API_BASE}?from=${from}&to=${to}`);
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'GET',
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
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function mergeAlerts(existing, incoming) {
    const seen = new Set(existing.map(a => `${a.timestamp}:${a.location}`));
    let added = 0;
    for (const a of incoming) {
        const key = `${a.timestamp}:${a.location}`;
        if (!seen.has(key)) {
            existing.push(a);
            seen.add(key);
            added++;
        }
    }
    if (added > 0) existing.sort((a, b) => a.timestamp - b.timestamp);
    return added;
}

function buildSalvos(alerts) {
    if (alerts.length === 0) return { salvos: [], locations: [] };
    const sorted = [...alerts].sort((a, b) => a.timestamp - b.timestamp);
    const locationSet = new Set();
    const salvos = [];
    let curSalvo = { timestamp: sorted[0].timestamp, locations: new Set() };

    for (const a of sorted) {
        locationSet.add(a.location);
        if (a.timestamp - curSalvo.timestamp <= SALVO_WINDOW_SEC) {
            curSalvo.locations.add(a.location);
        } else {
            salvos.push(curSalvo);
            curSalvo = { timestamp: a.timestamp, locations: new Set([a.location]) };
        }
    }
    salvos.push(curSalvo);

    return { salvos, locations: Array.from(locationSet).sort() };
}

async function fetchHistorical() {
    const now = new Date();
    const from = new Date(now.getTime() - HISTORY_DAYS * 86400000);
    const [historical, realtime] = await Promise.all([
        fetchAlerts(isoDate(from), isoDate(now)),
        fetchRealtimeCached().catch(() => [])
    ]);
    mergeAlerts(allAlerts, historical);
    mergeAlerts(allAlerts, realtime);
    parsedCache = buildSalvos(allAlerts);
    lastFetch = Date.now();
    console.log(`Historical fetch: ${allAlerts.length} alerts, ${parsedCache.salvos.length} salvos`);
}

function fetchRealtimeCached() {
    const url = new URL('https://agg.rocketalert.live/api/v2/alerts/real-time/cached');
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: url.hostname,
            path: url.pathname,
            method: 'GET',
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.success) return reject(new Error(json.error || 'API error'));
                    const alerts = [];
                    for (const group of json.payload) {
                        for (const a of group.alerts) {
                            if (a.alertTypeId !== 1 && a.alertTypeId !== 2) continue;
                            alerts.push({
                                location: a.name,
                                timestamp: Math.floor(new Date(a.timeStamp + '+03:00').getTime() / 1000),
                                type: a.alertTypeId
                            });
                        }
                    }
                    resolve(alerts);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function fetchRecent() {
    const now = new Date();
    const from = new Date(now.getTime() - 2 * 86400000);
    const [historical, realtime] = await Promise.all([
        fetchAlerts(isoDate(from), isoDate(now)).catch(() => []),
        fetchRealtimeCached().catch(() => [])
    ]);
    const added = mergeAlerts(allAlerts, historical) + mergeAlerts(allAlerts, realtime);
    if (added > 0) parsedCache = buildSalvos(allAlerts);
    lastFetch = Date.now();
}

function getActiveSalvos(salvos) {
    const now = Math.floor(Date.now() / 1000);
    const day = 86400;
    const clusterGap = 7 * day;
    const activeWindow = 48 * 3600;
    if (salvos.length === 0) return [];
    const recent = salvos.filter(s => now - s.timestamp < activeWindow);
    if (recent.length === 0) {
        let clusterStart = salvos.length - 1;
        for (let i = salvos.length - 1; i > 0; i--) {
            if (salvos[i].timestamp - salvos[i - 1].timestamp > clusterGap) {
                clusterStart = i;
                break;
            }
        }
        return salvos.slice(clusterStart);
    }
    let clusterStart = salvos.length - 1;
    for (let i = salvos.length - 1; i > 0; i--) {
        if (salvos[i].timestamp - salvos[i - 1].timestamp > clusterGap) {
            clusterStart = i;
            break;
        }
    }
    return salvos.slice(clusterStart);
}

function fitWeibull(gaps) {
    if (gaps.length === 0) return { k: 1, lambda: 1 };
    let bestK = 1, bestLambda = 1, bestLL = -Infinity;
    for (let k = 0.3; k <= 3.0; k += 0.02) {
        const sumXk = gaps.reduce((s, x) => s + Math.pow(x, k), 0);
        const lambda = Math.pow(sumXk / gaps.length, 1 / k);
        let ll = 0;
        for (const x of gaps) ll += Math.log(k) - Math.log(lambda) + (k - 1) * Math.log(x / lambda) - Math.pow(x / lambda, k);
        if (ll > bestLL) { bestLL = ll; bestK = k; bestLambda = lambda; }
    }
    return { k: bestK, lambda: bestLambda };
}

function weibullCondSurv(elapsed, shower, k, lambda) {
    return Math.exp(Math.pow(elapsed / lambda, k) - Math.pow((elapsed + shower) / lambda, k));
}

function weibullExpectedResidual(elapsed, k, lambda) {
    let integral = 0;
    const dt = 0.5;
    const maxT = Math.max(lambda * 5, elapsed + 300);
    const logSurvElapsed = -Math.pow(elapsed / lambda, k);
    for (let t = elapsed; t < maxT; t += dt) {
        const logSurvT = -Math.pow(t / lambda, k);
        integral += Math.exp(logSurvT - logSurvElapsed) * dt;
    }
    return Math.max(1, integral);
}

function computeExpectedNextAlert(gaps, elapsed, k, lambda) {
    const weibullEst = weibullExpectedResidual(elapsed, k, lambda);
    const open = gaps.filter(g => g > elapsed);
    if (open.length < 2) return Math.max(1, weibullEst);
    const empiricalEst = open.reduce((s, g) => s + (g - elapsed), 0) / open.length;
    return Math.max(1, 0.5 * weibullEst + 0.5 * empiricalEst);
}

function computePrediction(salvos, duration, now) {
    const gaps = [];
    for (let i = 1; i < salvos.length; i++) {
        gaps.push((salvos[i].timestamp - salvos[i - 1].timestamp) / 60);
    }
    const recentGaps = gaps.slice(-20);
    const { k, lambda } = fitWeibull(recentGaps);
    const lastTs = salvos[salvos.length - 1].timestamp;
    const elapsed = (now - lastTs) / 60;
    const pSafe = weibullCondSurv(elapsed, duration, k, lambda);
    const maxGap = recentGaps.length > 0 ? Math.max(...recentGaps) : 1;
    const decay = elapsed <= maxGap ? 1 : maxGap / elapsed;
    const risk = (1 - pSafe) * decay;
    const gapStats = recentGaps.length > 0 ? {
        mean: recentGaps.reduce((a, b) => a + b, 0) / recentGaps.length,
        median: [...recentGaps].sort((a, b) => a - b)[Math.floor(recentGaps.length / 2)],
        min: Math.min(...recentGaps)
    } : { mean: 0, median: 0, min: 0 };
    return {
        risk,
        minutesSinceLastAlert: elapsed,
        lastAlertTime: lastTs,
        lastAlertLocations: Array.from(salvos[salvos.length - 1].locations),
        salvoCount: salvos.length,
        gapStats,
        expectedNextAlert: computeExpectedNextAlert(recentGaps, elapsed, k, lambda),
        modelInfo: { k, lambda }
    };
}

function getLevel(risk) {
    if (risk > 0.4) return 'RED';
    if (risk >= 0.25) return 'YELLOW';
    return 'GREEN';
}

app.use(express.static(path.join(__dirname, 'public')));

function computeTrend(gaps) {
    if (gaps.length < 4) return 'stable';
    const half = Math.floor(gaps.length / 2);
    const older = gaps.slice(0, half);
    const recent = gaps.slice(half);
    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const oldAvg = avg(older);
    const recentAvg = avg(recent);
    if (oldAvg === 0) return 'stable';
    const ratio = recentAvg / oldAvg;
    if (ratio < 0.7) return 'increasing';
    if (ratio > 1.3) return 'decreasing';
    return 'stable';
}

function emptyResponse(isActive = false) {
    return {
        risk: 0, level: 'GREEN', minutesSinceLastAlert: null,
        lastAlertTime: null, lastAlertLocations: [], salvoCount: 0,
        gapStats: { mean: 0, median: 0, min: 0 }, trend: 'stable',
        expectedNextAlert: null, isActive
    };
}

app.get('/api/predict', (req, res) => {
    const parsed = parsedCache || buildSalvos(allAlerts);
    if (parsed.salvos.length === 0) return res.json(emptyResponse());

    const allActive = getActiveSalvos(parsed.salvos);
    const locationParam = req.query.location;
    const locations = locationParam ? locationParam.split('|').map(l => l.trim()).filter(Boolean) : [];
    const duration = Math.max(1, parseInt(req.query.duration, 10) || 15);
    const now = Math.floor(Date.now() / 1000);

    if (locations.length === 0) {
        if (allActive.length === 0) return res.json(emptyResponse());
        if (allActive.length < 2) {
            const last = allActive[0];
            return res.json({
                risk: 0.5, level: 'YELLOW',
                minutesSinceLastAlert: (now - last.timestamp) / 60,
                lastAlertTime: last.timestamp,
                lastAlertLocations: Array.from(last.locations || []),
                salvoCount: allActive.length,
                gapStats: { mean: 0, median: 0, min: 0 }, trend: 'stable',
                expectedNextAlert: null,
                isActive: (now - last.timestamp) < 86400
            });
        }
        const pred = computePrediction(allActive, duration, now);
        const gaps = [];
        for (let i = 1; i < allActive.length; i++) gaps.push((allActive[i].timestamp - allActive[i - 1].timestamp) / 60);
        return res.json({
            risk: pred.risk, level: getLevel(pred.risk),
            minutesSinceLastAlert: pred.minutesSinceLastAlert,
            lastAlertTime: pred.lastAlertTime,
            lastAlertLocations: pred.lastAlertLocations,
            salvoCount: pred.salvoCount, gapStats: pred.gapStats,
            trend: computeTrend(gaps.slice(-20)),
            expectedNextAlert: pred.expectedNextAlert,
            isActive: (now - allActive[allActive.length - 1].timestamp) < 86400
        });
    }

    let worstRisk = -1;
    let worstResult = null;
    for (const loc of locations) {
        const filtered = allActive.filter(s => s.locations && s.locations.has(loc));
        if (filtered.length < 2) continue;
        const pred = computePrediction(filtered, duration, now);
        if (pred.risk > worstRisk) {
            worstRisk = pred.risk;
            const gaps = [];
            for (let i = 1; i < filtered.length; i++) gaps.push((filtered[i].timestamp - filtered[i - 1].timestamp) / 60);
            worstResult = {
                risk: pred.risk, level: getLevel(pred.risk),
                minutesSinceLastAlert: pred.minutesSinceLastAlert,
                lastAlertTime: pred.lastAlertTime,
                lastAlertLocations: pred.lastAlertLocations,
                salvoCount: pred.salvoCount, gapStats: pred.gapStats,
                trend: computeTrend(gaps.slice(-20)),
                expectedNextAlert: pred.expectedNextAlert,
                isActive: (now - filtered[filtered.length - 1].timestamp) < 86400
            };
        }
    }
    res.json(worstResult || emptyResponse());
});

app.get('/api/locations', (req, res) => {
    const parsed = parsedCache || buildSalvos(allAlerts);
    res.json(parsed.locations);
});

app.get('/api/status', (req, res) => {
    const parsed = parsedCache || buildSalvos(allAlerts);
    const latestAlert = parsed.salvos.length > 0
        ? parsed.salvos[parsed.salvos.length - 1].timestamp
        : null;
    res.json({
        lastFetch,
        alertCount: allAlerts.length,
        salvoCount: parsed.salvos.length,
        latestAlert
    });
});

fetchHistorical()
    .then(() => setInterval(() => fetchRecent().catch(() => {}), FETCH_INTERVAL))
    .catch(e => {
        console.error('Historical fetch failed:', e.message);
        setInterval(() => fetchRecent().catch(() => {}), FETCH_INTERVAL);
    });

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
