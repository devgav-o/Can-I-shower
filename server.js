const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = 3000;

const FETCH_URL = 'https://www.tzevaadom.co.il/static/historical/all.json';
const FETCH_INTERVAL = 5 * 60 * 1000;
const FETCH_HEADERS = {
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  'pragma': 'no-cache',
  'referer': 'https://www.tzevaadom.co.il/en/historical/?mode=3',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
};

let cachedData = [];
let parsedCache = null;
let lastFetch = null;

function fetchData() {
  return new Promise((resolve, reject) => {
    const url = new URL(FETCH_URL);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'GET',
      headers: FETCH_HEADERS
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          cachedData = parsed;
          parsedCache = parseData(parsed);
          lastFetch = Date.now();
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function parseData(raw) {
  if (!Array.isArray(raw)) return { salvos: [], locations: [] };
  const salvoMap = new Map();
  const locationSet = new Set();
  const salvoLocations = new Map();
  for (const entry of raw) {
    const [salvoId, type, locations, timestamp] = entry;
    if (type !== 0 && type !== 5) continue;
    if (!Array.isArray(locations)) continue;
    for (const loc of locations) {
      if (loc && typeof loc === 'string') locationSet.add(loc);
    }
    if (!salvoMap.has(salvoId) || salvoMap.get(salvoId) > timestamp) {
      salvoMap.set(salvoId, timestamp);
    }
    if (!salvoLocations.has(salvoId)) {
      salvoLocations.set(salvoId, new Set());
    }
    for (const loc of locations) {
      if (loc && typeof loc === 'string') salvoLocations.get(salvoId).add(loc);
    }
  }
  const salvos = Array.from(salvoMap.entries())
    .map(([id, ts]) => ({ id, timestamp: ts, locations: salvoLocations.get(id) }))
    .sort((a, b) => a.timestamp - b.timestamp);
  return { salvos, locations: Array.from(locationSet).sort() };
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
  const parsed = parsedCache || parseData(cachedData);
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
  const parsed = parsedCache || parseData(cachedData);
  res.json(parsed.locations);
});

app.get('/api/status', (req, res) => {
  const parsed = parsedCache || parseData(cachedData);
  const latestAlert = parsed.salvos.length > 0
    ? parsed.salvos[parsed.salvos.length - 1].timestamp
    : null;
  const alertCount = cachedData.length;
  res.json({
    lastFetch,
    alertCount,
    salvoCount: parsed.salvos.length,
    latestAlert
  });
});

function startFetch() {
  fetchData().catch(console.log);
}

startFetch();
setInterval(startFetch, FETCH_INTERVAL);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
