// server.js
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const {
    buildSalvos, computeRisk, extractGaps, parseIsraelTimestamp, DEFAULT_PARAMS
} = require('./shared');

const app = express();
const PORT = 3000;
const API_BASE = 'https://agg.rocketalert.live/api/v1/alerts/details';
const FETCH_INTERVAL = 30 * 1000;
const HISTORY_DAYS = 90;
const HTTP_TIMEOUT_MS = 25000;

// Optional geo index for "nearest location" lookup
let locationCoords = null;
function loadLocationCoords() {
    if (locationCoords) return locationCoords;
    try {
        const raw = fs.readFileSync(path.join(__dirname, 'locations-latlong.json'), 'utf8');
        const obj = JSON.parse(raw);
        locationCoords = Object.entries(obj).map(([name, v]) => {
            const lat = Number(v && v.lat);
            const lng = Number(v && v.lng);
            return Number.isFinite(lat) && Number.isFinite(lng) ? { name, lat, lng } : null;
        }).filter(Boolean);
    } catch (e) {
        console.error('Failed to load locations-latlong.json:', e.message);
        locationCoords = [];
    }
    return locationCoords;
}

function findNearestLocation(lat, lng) {
    const locs = loadLocationCoords();
    if (!locs.length) return null;
    let best = null;
    let bestDist2 = Infinity;
    for (const loc of locs) {
        const dLat = lat - loc.lat;
        const dLng = lng - loc.lng;
        const dist2 = dLat * dLat + dLng * dLng;
        if (dist2 < bestDist2) {
            bestDist2 = dist2;
            best = loc;
        }
    }
    return best;
}

let parsedCache = null;
let lastFetch = null;
let allAlerts = [];

// In-memory viewer analytics: simple "who's watching now" counter
const VIEWER_TTL_MS = 60 * 1000;
const viewers = new Map(); // id -> lastSeenMs

function getActiveViewerCount(now = Date.now()) {
    const cutoff = now - VIEWER_TTL_MS;
    for (const [id, ts] of viewers) {
        if (ts < cutoff) viewers.delete(id);
    }
    return viewers.size;
}

function loadModelParams() {
    try {
        const model = JSON.parse(fs.readFileSync(path.join(__dirname, 'model.json'), 'utf8'));
        return model.params || DEFAULT_PARAMS;
    } catch (_) {
        return DEFAULT_PARAMS;
    }
}

let trainedParams = loadModelParams();

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
                                timestamp: parseIsraelTimestamp(a.timeStamp),
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
                                timestamp: parseIsraelTimestamp(a.timeStamp),
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
    const normalized = val.includes(':') && val.split(':').length === 2 ? val + ':00' : val;
    return parseIsraelTimestamp(normalized.replace('T', ' '));
}

function emptyResponse() {
    return {
        risk: 0, level: 'GREEN', minutesSinceLastAlert: null,
        lastAlertTime: null, lastAlertLocations: [], salvoCount: 0,
        gapStats: null, trend: 'stable',
        expectedNextAlert: null,
        avgGapLast10Minutes: null,
        modelType: 'hunger+heuristics',
        hungerInfo: null,
        reasonings: []
    };
}

function clamp01(x) {
    return Math.max(0, Math.min(0.99, x));
}

// Average salvos per 24h over the history of these salvos, ignoring days with zero (ceasefire days).
// Used for location-aware 24h activity reasoning (salvos may be location-filtered).
function avg24hSalvosIgnoringQuietDays(salvos) {
    if (!salvos.length) return null;
    const DAY_SEC = 86400;
    const sorted = [...salvos].sort((a, b) => a.timestamp - b.timestamp);
    const firstDayStart = Math.floor(sorted[0].timestamp / DAY_SEC) * DAY_SEC;
    const lastDayEnd = (Math.floor(sorted[sorted.length - 1].timestamp / DAY_SEC) + 1) * DAY_SEC;
    const dayCounts = [];
    for (let dayStart = firstDayStart; dayStart < lastDayEnd; dayStart += DAY_SEC) {
        const dayEnd = dayStart + DAY_SEC;
        let count = 0;
        for (const s of sorted) {
            if (s.timestamp >= dayStart && s.timestamp < dayEnd) count++;
        }
        if (count > 0) dayCounts.push(count);
    }
    if (!dayCounts.length) return null;
    return dayCounts.reduce((a, b) => a + b, 0) / dayCounts.length;
}


function getIsraelClock(nowSec) {
    const date = new Date(nowSec * 1000);
    const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jerusalem',
        hour12: false,
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
        day: 'numeric',
        month: 'numeric'
    });
    const parts = fmt.formatToParts(date);
    const hourPart = parts.find(p => p.type === 'hour');
    const minutePart = parts.find(p => p.type === 'minute');
    const weekdayPart = parts.find(p => p.type === 'weekday');
    const monthPart = parts.find(p => p.type === 'month');
    const dayPart = parts.find(p => p.type === 'day');
    const hour = hourPart ? parseInt(hourPart.value, 10) : 0;
    const minute = minutePart ? parseInt(minutePart.value, 10) : 0;
    const weekday = weekdayPart ? weekdayPart.value : 'Mon';
    const month = monthPart ? parseInt(monthPart.value, 10) : (date.getUTCMonth() + 1);
    const day = dayPart ? parseInt(dayPart.value, 10) : date.getUTCDate();
    const minutesSinceMidnight = hour * 60 + minute;
    const isWeekend = weekday === 'Fri' || weekday === 'Sat';
    return { hour, minute, minutesSinceMidnight, weekday, isWeekend, month, day };
}

function applyReasoningEnsemble(pred, salvos, durationMin, nowSec) {
    const baseRisk = clamp01(pred.risk || 0);
    const gaps = extractGaps(salvos);
    const clock = getIsraelClock(nowSec);
    const elapsed = pred.minutesSinceLastAlert;

    const reasonings = [];

    const stats = pred.gapStats || (gaps.length ? (() => {
        const sorted = [...gaps].sort((a, b) => a - b);
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        return {
            mean,
            median: sorted[Math.floor(sorted.length / 2)],
            min: sorted[0],
            max: sorted[sorted.length - 1],
            count: gaps.length
        };
    })() : null);

    const recentSalvoCounts = (() => {
        const cutoff24 = nowSec - 24 * 3600;
        const cutoff6 = nowSec - 6 * 3600;
        let c24 = 0, c6 = 0;
        for (const s of salvos) {
            if (s.timestamp >= cutoff24 && s.timestamp <= nowSec) c24++;
            if (s.timestamp >= cutoff6 && s.timestamp <= nowSec) c6++;
        }
        return { last24h: c24, last6h: c6 };
    })();

    function addReason(id, label, weight, risk, explanation) {
        const r = clamp01(risk);
        reasonings.push({
            id,
            label,
            weight,
            risk: r,
            contribution: weight * r,
            explanation
        });
    }

    // 1) Core hunger model (existing model)
    addReason(
        'core_hunger_model',
        'Core statistical model',
        0.5,
        baseRisk,
        'Main two-state "hunger" model combining long-term tension build-up with recent barrage intensity.'
    );

    // 2) 24-hour activity vs baseline for this (possibly location-filtered) history; ignore zero-salvo days
    (function () {
        const baseline = avg24hSalvosIgnoringQuietDays(salvos);
        const count24 = recentSalvoCounts.last24h;
        if (baseline && baseline > 0) {
            let standaloneRisk;
            let qualifier;
            let extraWeight = 0
            if (count24 === 0) {
                standaloneRisk = 0.2;
                qualifier = 'no alerts in the last 24 hours, quieter than the typical active day';
            } else {
                const ratio = count24 / baseline;
                standaloneRisk = Math.max(0, 1 - ratio);

                if (ratio < 0.5) {
                    qualifier = `about ${(ratio * 100).toFixed(0)}% of the typical 24h salvo rate for this location`;
                } else if (ratio < 1.1) {
                    qualifier = 'roughly in line with the typical 24h number of alerts for this location';
                } else {
                    extraWeight = 0.1
                    qualifier = `well above the typical 24h rate (≈${(ratio * 100).toFixed(0)}%)`;
                }
            }
            addReason(
                'activity_24h_vs_baseline',
                '24h activity vs typical',
                0.3 + extraWeight,
                standaloneRisk,
                `There were ${count24} alerts in the last 24 hours; the average is about ${baseline.toFixed(1)}. Current activity is ${qualifier}.`
            );
        }
    })();

    // 3) Muslim prayer time heuristic (user-requested, external knowledge)
    (function () {
        const centers = [
            5 * 60,       // Fajr
            12 * 60 + 30, // Dhuhr
            15 * 60 + 45, // Asr
            18 * 60 + 15, // Maghrib
            20 * 60       // Isha
        ];
        let extraWeight = 0;
        const m = clock.minutesSinceMidnight;
        let minDist = Infinity;
        for (const c of centers) {
            const d = Math.abs(m - c);
            if (d < minDist) minDist = d;
        }
        let standaloneRisk;
        let detail;
        if (minDist <= 20) {
            standaloneRisk = minDist/100;
            extraWeight = 0.2
            detail = 'inside a typical Muslim prayer window';
        } else if (minDist <= 45) {
            standaloneRisk = minDist/100;
            extraWeight = 0.1
            detail = 'near a typical Muslim prayer window';
        } else {
            standaloneRisk = 1;
            detail = 'far from common prayer windows';
        }
        const direction = standaloneRisk < 0.5 ? 'slightly lowers' : standaloneRisk > 0.5 ? 'slightly nudges up' : 'does not change';
        addReason(
            'muslim_prayer_times',
            'Prayer time bias',
            0.05 +extraWeight,
            standaloneRisk,
            `Local time in Israel is around ${clock.hour.toString().padStart(2, '0')}:${clock.minute.toString().padStart(2, '0')}, ${detail}, so this heuristic ${direction} the risk when considered on its own.`
        );
    })();

    (function () {
        const h = clock.hour;
        // Dawn/dusk are operationally significant — transitions in visibility
        // Late night / pre-dawn launches are common (harder to intercept visually,
        // element of surprise, people in shelters are sleeping)
        let standaloneRisk;
        let desc;
        if (h >= 2 && h < 5) {
            standaloneRisk = 0.7;
            desc = 'Pre-dawn hours (02:00–05:00) are historically favored for rocket launches — darkness provides cover for launch crews and sleeping civilians have slower shelter response.';
        } else if ((h >= 5 && h < 7) || (h >= 18 && h < 20)) {
            standaloneRisk = 0.55;
            desc = 'Dawn and dusk transitions create operational windows — shifting light complicates aerial surveillance and interception.';
        } else if (h >= 20 || h < 2) {
            standaloneRisk = 0.45;
            desc = 'Nighttime sees moderate launch activity — darkness helps but sustained operations are harder to coordinate.';
        } else {
            standaloneRisk = 0.25;
            desc = 'Full daylight exposes launch crews to aerial surveillance, slightly reducing launch likelihood.';
        }
        addReason(
            'darkness_visibility',
            'Darkness & operational cover',
            0.05,
            standaloneRisk,
            desc
        );
    })();

    // Normalize weights so they sum to 1.0 (100%) for display,
    // and recompute contributions accordingly.
    let totalWeight = reasonings.reduce((s, r) => s + r.weight, 0);
    if (totalWeight <= 0) {
        // Fallback: distribute uniformly if something went wrong.
        const equal = 1 / (reasonings.length || 1);
        reasonings.forEach(r => {
            r.weight = equal;
            r.contribution = equal * r.risk;
        });
        totalWeight = 1;
    } else {
        reasonings.forEach(r => {
            r.weight = r.weight / totalWeight;
            r.contribution = r.weight * r.risk;
        });
        totalWeight = 1;
    }

    const combinedRisk = clamp01(
        reasonings.reduce((s, r) => s + r.contribution, 0)
    );

    return { risk: combinedRisk, reasonings };
}

function formatResult(pred, salvos, durationMin, nowSec) {
    const gaps = extractGaps(salvos);
    const ensemble = applyReasoningEnsemble(pred, salvos, durationMin, nowSec);
    const risk = ensemble.risk;
    return {
        risk,
        level: getLevel(risk),
        minutesSinceLastAlert: pred.minutesSinceLastAlert,
        lastAlertTime: pred.lastAlertTime,
        lastAlertLocations: pred.lastAlertLocations,
        salvoCount: pred.salvoCount,
        gapStats: pred.gapStats,
        trend: computeTrend(gaps.slice(-20)),
        expectedNextAlert: pred.expectedWait,
        avgGapLast10Minutes: pred.avgGapLast10Minutes,
        modelType: 'hunger+heuristics',
        hungerInfo: pred.hungerInfo,
        reasonings: ensemble.reasonings
    };
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/analytics/ping', (req, res) => {
    const rawId = typeof req.query.id === 'string' ? req.query.id : '';
    const id = rawId.slice(0, 64);
    if (id) {
        viewers.set(id, Date.now());
    }
    const count = getActiveViewerCount();
    res.json({ viewers: count });
});

app.get('/api/predict', (req, res) => {
    const parsed = parsedCache || buildSalvos(allAlerts);
    const allSalvos = parsed.salvos;
    if (allSalvos.length === 0) return res.json(emptyResponse());

    const locationParam = req.query.location;
    const locations = locationParam ? locationParam.split('|').map(l => l.trim()).filter(Boolean) : [];
    const duration = Math.max(1, parseInt(req.query.duration, 10) || 15);
    const debugNow = parseDebugNow(req.query.debugNow);
    const now = debugNow != null ? debugNow : Math.floor(Date.now() / 1000);

    const pastSalvos = allSalvos.filter(s => s.timestamp <= now);
    if (pastSalvos.length === 0) return res.json(emptyResponse());

    if (locations.length === 0) {
        const pred = computeRisk(pastSalvos, duration, now, trainedParams);
        return res.json(formatResult(pred, pastSalvos, duration, now));
    }

    let worstRisk = -1;
    let worstResult = null;

    for (const loc of locations) {
        const filtered = pastSalvos.filter(s => s.locations && s.locations.has(loc));
        if (filtered.length < 2) continue;
        const pred = computeRisk(filtered, duration, now, trainedParams);
        if (pred.risk > worstRisk) {
            worstRisk = pred.risk;
            worstResult = formatResult(pred, filtered, duration, now);
        }
    }
    if (worstResult) return res.json(worstResult);

    const pred = computeRisk(pastSalvos, duration, now, trainedParams);
    return res.json(formatResult(pred, pastSalvos, duration, now));
});

app.get('/api/locations', (req, res) => {
    const parsed = parsedCache || buildSalvos(allAlerts);
    res.json(parsed.locations);
});

app.get('/api/nearest-location', (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: 'invalid_coordinates' });
    }
    const nearest = findNearestLocation(lat, lng);
    if (!nearest) {
        return res.status(500).json({ error: 'location_index_unavailable' });
    }
    res.json({ name: nearest.name, lat: nearest.lat, lng: nearest.lng });
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
        modelType: 'hunger+heuristics',
        trainedParams
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
        console.log('Ready â€” hunger model');
        setInterval(() => fetchRecent().catch(() => {}), FETCH_INTERVAL);
    }).catch(e => {
        console.error('Boot failed:', e.message);
        setInterval(() => fetchRecent().catch(() => {}), FETCH_INTERVAL);
    });
});