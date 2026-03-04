const fs = require('fs');
const { execSync } = require('child_process');
const { buildSalvos, parseIsraelTimestamp } = require('../../shared');
const { API_BASE, REALTIME_URL, HTTP_TIMEOUT_MS, GIT_ALERTS_REPO, GIT_ALERTS_DIR, GIT_ALERTS_CSV, HISTORY_DAYS } = require('../config');

function isoDate(d) { return d.toISOString().slice(0, 10); }

async function fetchAlerts(from, to) {
    const res = await fetch(`${API_BASE}?from=${from}&to=${to}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'API error');
    const alerts = [];
    for (const day of json.payload) {
        for (const a of day.alerts) {
            if (a.alertTypeId !== 1 && a.alertTypeId !== 2) continue;
            alerts.push({ location: a.name, timestamp: parseIsraelTimestamp(a.timeStamp), type: a.alertTypeId });
        }
    }
    return alerts;
}

async function fetchRealtimeCached() {
    const res = await fetch(REALTIME_URL, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'API error');
    const alerts = [];
    for (const group of json.payload) {
        for (const a of group.alerts) {
            if (a.alertTypeId !== 1 && a.alertTypeId !== 2) continue;
            alerts.push({ location: a.name, timestamp: parseIsraelTimestamp(a.timeStamp), type: a.alertTypeId });
        }
    }
    return alerts;
}

function gitSync() {
    try {
        if (fs.existsSync(GIT_ALERTS_DIR)) {
            execSync('git pull --ff-only', { cwd: GIT_ALERTS_DIR, timeout: 30000, stdio: 'pipe' });
        } else {
            execSync(`git clone --depth 1 ${GIT_ALERTS_REPO} ${GIT_ALERTS_DIR}`, { timeout: 60000, stdio: 'pipe' });
        }
        return true;
    } catch (e) {
        console.error('Git sync failed:', e.message);
        return false;
    }
}

function parseGitCsv(historyDays) {
    if (!fs.existsSync(GIT_ALERTS_CSV)) return [];
    const cutoffStr = new Date(Date.now() - historyDays * 86400000).toISOString().slice(0, 10);
    const content = fs.readFileSync(GIT_ALERTS_CSV, 'utf8');
    const lines = content.split('\n');
    const alerts = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const dateMatch = line.match(/,(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}),(\d+),/);
        if (!dateMatch) continue;
        const datePart = dateMatch[1];
        const timePart = dateMatch[2];
        const category = parseInt(dateMatch[3], 10);
        if (datePart < cutoffStr) continue;
        if (category !== 1 && category !== 2 && category !== 14) continue;
        const commaIdx = line.indexOf(',');
        if (commaIdx === -1) continue;
        const location = line.slice(0, commaIdx);
        if (location.startsWith('"')) continue;
        const timestamp = parseIsraelTimestamp(`${datePart} ${timePart}`);
        alerts.push({ location, timestamp, type: category });
    }
    return alerts;
}

async function fetchGitAlerts(historyDays) {
    gitSync();
    return parseGitCsv(historyDays);
}

const _seenAlertKeys = new Set();

function mergeAlerts(existing, incoming) {
    if (_seenAlertKeys.size === 0) {
        for (const a of existing) _seenAlertKeys.add(`${a.timestamp}:${a.location}`);
    }
    let added = 0;
    for (const a of incoming) {
        const key = `${a.timestamp}:${a.location}`;
        if (!_seenAlertKeys.has(key)) {
            existing.push(a);
            _seenAlertKeys.add(key);
            added++;
        }
    }
    if (added > 0) existing.sort((a, b) => a.timestamp - b.timestamp);
    return added;
}

const state = {
    allAlerts: [],
    parsedCache: null,
    lastFetch: null,
};

async function fetchHistorical(historyDays) {
    const now = new Date();
    const from = new Date(now.getTime() - historyDays * 86400000);
    const [historical, realtime, gitAlerts] = await Promise.all([
        fetchAlerts(isoDate(from), isoDate(now)).catch(() => []),
        fetchRealtimeCached().catch(() => []),
        fetchGitAlerts(historyDays).catch(() => []),
    ]);
    mergeAlerts(state.allAlerts, historical);
    mergeAlerts(state.allAlerts, realtime);
    const gitAdded = mergeAlerts(state.allAlerts, gitAlerts);
    state.parsedCache = buildSalvos(state.allAlerts);
    state.lastFetch = Date.now();
    console.log(`Historical fetch: ${state.allAlerts.length} alerts, ${state.parsedCache.salvos.length} salvos (git: +${gitAdded})`);
}

async function fetchRecent() {
    const now = new Date();
    const from = new Date(now.getTime() - 2 * 86400000);
    const [historical, realtime, gitAlerts] = await Promise.all([
        fetchAlerts(isoDate(from), isoDate(now)).catch(() => []),
        fetchRealtimeCached().catch(() => []),
        fetchGitAlerts(HISTORY_DAYS).catch(() => []),
    ]);
    const added = mergeAlerts(state.allAlerts, historical) + mergeAlerts(state.allAlerts, realtime) + mergeAlerts(state.allAlerts, gitAlerts);
    if (added > 0) state.parsedCache = buildSalvos(state.allAlerts);
    state.lastFetch = Date.now();
}

function getParsedCache() {
    return state.parsedCache || buildSalvos(state.allAlerts);
}

module.exports = { fetchHistorical, fetchRecent, getParsedCache, mergeAlerts, state };
