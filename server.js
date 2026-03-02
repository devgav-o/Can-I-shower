// server.js
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const {
    buildSalvos, getActiveCluster, computeRisk
} = require('./shared');

const app = express();
const PORT = 3000;
const API_BASE = 'https://agg.rocketalert.live/api/v1/alerts/details';
const FETCH_INTERVAL = 5 * 60 * 1000;
const HISTORY_DAYS = 90;
const HTTP_TIMEOUT_MS = 25000;

let parsedCache = null;
let lastFetch = null;
let allAlerts = [];

function isoDate(d) { return d.toISOString().slice(0, 10); }

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

function fetchRealtimeCached() {
    const url = new URL('https://agg.rocketalert.live/api/v2/alerts/real-time/cached');
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: url.hostname, path: url.pathname, method: 'GET',
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
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        const t = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, HTTP_TIMEOUT_MS);
        req.on('close', () => clearTimeout(t));
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

function getLevel(risk) {
    if (risk >= 0.5) return 'RED';
    if (risk >= 0.25) return 'YELLOW';
    return 'GREEN';
}

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

function parseDebugNow(val) {
    if (val == null || val === '') return null;
    const n = Number(val);
    if (!Number.isNaN(n)) return Math.floor(n < 1e12 ? n : n / 1000);
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

function emptyResponse(isActive = false) {
    return {
        risk: 0, level: 'GREEN', minutesSinceLastAlert: null,
        lastAlertTime: null, lastAlertLocations: [], salvoCount: 0,
        gapStats: null, trend: 'stable',
        expectedNextAlert: null, isActive
    };
}

function formatResult(pred, allActive, now) {
    const gaps = [];
    for (let i = 1; i < allActive.length; i++) {
        gaps.push((allActive[i].timestamp - allActive[i - 1].timestamp) / 60);
    }
    return {
        risk: pred.risk,
        level: getLevel(pred.risk),
        minutesSinceLastAlert: pred.minutesSinceLastAlert,
        lastAlertTime: pred.lastAlertTime,
        lastAlertLocations: pred.lastAlertLocations,
        salvoCount: pred.salvoCount,
        gapStats: pred.gapStats,
        trend: computeTrend(gaps.slice(-20)),
        expectedNextAlert: pred.expectedWait,
        isActive: pred.lastAlertTime ? (now - pred.lastAlertTime) < 86400 : false,
        modelType: 'poisson_rate',
        rateInfo: pred.rateInfo
    };
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/predict', (req, res) => {
    const parsed = parsedCache || buildSalvos(allAlerts);
    if (parsed.salvos.length === 0) return res.json(emptyResponse());

    const locationParam = req.query.location;
    const locations = locationParam ? locationParam.split('|').map(l => l.trim()).filter(Boolean) : [];
    const duration = Math.max(1, parseInt(req.query.duration, 10) || 15);
    const debugNow = parseDebugNow(req.query.debugNow);
    const now = debugNow != null ? debugNow : Math.floor(Date.now() / 1000);

    const activeInfo = getActiveCluster(parsed.salvos, now);
    const allActive = activeInfo.salvos;

    if (locations.length === 0) {
        if (allActive.length === 0) return res.json(emptyResponse());
        const pred = computeRisk(allActive, duration, now);
        return res.json(formatResult(pred, allActive, now));
    }

    let worstRisk = -1;
    let worstResult = null;

    for (const loc of locations) {
        const filtered = allActive.filter(s => s.locations && s.locations.has(loc));
        if (filtered.length < 2) continue;
        const pred = computeRisk(filtered, duration, now);
        if (pred.risk > worstRisk) {
            worstRisk = pred.risk;
            worstResult = formatResult(pred, filtered, now);
        }
    }
    if (worstResult) return res.json(worstResult);

    const locationSet = new Set(locations);
    const matchingSalvos = allActive.filter(s => s.locations && [...s.locations].some(l => locationSet.has(l)));
    const lastMatch = matchingSalvos.length > 0 ? matchingSalvos[matchingSalvos.length - 1] : null;
    if (lastMatch) {
        return res.json({
            risk: 0.5, level: 'YELLOW',
            minutesSinceLastAlert: (now - lastMatch.timestamp) / 60,
            lastAlertTime: lastMatch.timestamp,
            lastAlertLocations: Array.from(lastMatch.locations || []),
            salvoCount: 1,
            gapStats: null, trend: 'stable',
            expectedNextAlert: null,
            isActive: (now - lastMatch.timestamp) < 86400,
            noData: true
        });
    }
    res.json({ ...emptyResponse(), noData: true });
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
        latestAlert,
        modelType: 'poisson_rate'
    });
});

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

app.listen(PORT, () => {
    console.log(`Server starting on port ${PORT}...`);
    fetchHistorical().then(() => {
        console.log('Ready — Poisson rate model');
        setInterval(() => fetchRecent().catch(() => {}), FETCH_INTERVAL);
    }).catch(e => {
        console.error('Boot failed:', e.message);
        setInterval(() => fetchRecent().catch(() => {}), FETCH_INTERVAL);
    });
});