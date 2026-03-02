const https = require('https');

const API_BASE = 'https://agg.rocketalert.live/api/v1/alerts/details';
const SALVO_WINDOW_SEC = 120;
const DAY_SEC = 86400;
const CLUSTER_GAP_SEC = 7 * DAY_SEC;
const HTTP_TIMEOUT_MS = 25000;
const RECENT_GAPS_COUNT = 20;
const BOOTSTRAP_ITERS = 60;

function isoDate(d) { return d.toISOString().slice(0, 10); }
function fmtDur(min) {
    if (min < 60) return `${min.toFixed(0)}m`;
    if (min < 1440) return `${(min / 60).toFixed(1)}h`;
    return `${(min / 1440).toFixed(1)}d`;
}
function pct(v) { return (v * 100).toFixed(1) + '%'; }

// ==================== Data fetching ====================

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

// ==================== Salvo building ====================

function buildSalvos(alerts) {
    if (!alerts.length) return { salvos: [], clusterDurationModel: emptyModel() };
    const sorted = [...alerts].sort((a, b) => a.timestamp - b.timestamp);
    const salvos = [];
    let cur = { timestamp: sorted[0].timestamp, locations: new Set([sorted[0].location]) };
    for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i];
        if (a.timestamp - cur.timestamp <= SALVO_WINDOW_SEC) {
            cur.locations.add(a.location);
        } else {
            salvos.push(cur);
            cur = { timestamp: a.timestamp, locations: new Set([a.location]) };
        }
    }
    salvos.push(cur);
    return { salvos, clusterDurationModel: computeClusterDurationModel(salvos) };
}

function emptyModel() { return { durations: [], meanDurationSec: DAY_SEC, maxDurationSec: DAY_SEC, synthetic: true }; }

function computeClusterDurationModel(salvos) {
    if (!salvos || salvos.length < 2) return emptyModel();
    const durations = [];
    let start = 0;
    for (let i = 1; i < salvos.length; i++) {
        if (salvos[i].timestamp - salvos[i - 1].timestamp > CLUSTER_GAP_SEC) {
            if (i - start >= 2) durations.push(salvos[i - 1].timestamp - salvos[start].timestamp);
            start = i;
        }
    }
    // If no completed clusters, build synthetic model from current cluster span
    if (!durations.length) {
        const span = salvos[salvos.length - 1].timestamp - salvos[0].timestamp;
        // Use current span as estimate — P(active) will decay after this duration
        const estDuration = Math.max(span, 4 * 3600); // at least 4 hours
        return {
            durations: [],
            meanDurationSec: estDuration,
            maxDurationSec: estDuration,
            synthetic: true
        };
    }
    durations.sort((a, b) => a - b);
    return {
        durations,
        meanDurationSec: durations.reduce((a, b) => a + b, 0) / durations.length,
        maxDurationSec: durations[durations.length - 1],
        synthetic: false
    };
}

function clusterSurvival(tSec, model) {
    if (!model) return 1;
    if (tSec <= 0) return 1;

    if (model.synthetic || !model.durations.length) {
        // Exponential decay centered on estimated duration
        // P(active) = 1 for t < mean, then decays with half-life = mean
        const mean = model.meanDurationSec || DAY_SEC;
        if (tSec <= mean) return 1;
        return Math.max(0.01, Math.exp(-(tSec - mean) / mean));
    }

    const { durations, maxDurationSec, meanDurationSec } = model;
    const N = durations.length;
    if (tSec <= maxDurationSec) {
        let active = 0;
        for (const d of durations) if (d >= tSec) active++;
        return Math.max(0.01, active / N);
    }
    let atMax = 0;
    for (const d of durations) if (d >= maxDurationSec) atMax++;
    const base = atMax / N;
    if (base <= 0 || meanDurationSec <= 0) return 0.01;
    return Math.max(0.01, base * Math.exp(-(tSec - maxDurationSec) / meanDurationSec));
}

// ==================== Statistical helpers ====================

function normCDF(x) {
    if (x < -8) return 0; if (x > 8) return 1;
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const t = 1 / (1 + p * Math.abs(x));
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
    return 0.5 * (1 + sign * y);
}

function fitLogNormal(gaps) {
    const lg = gaps.filter(g => g > 0).map(g => Math.log(g));
    if (!lg.length) return { mu: 0, sigma: 1 };
    const mu = lg.reduce((a, b) => a + b, 0) / lg.length;
    const v = lg.reduce((s, x) => s + (x - mu) ** 2, 0) / lg.length;
    return { mu, sigma: Math.max(0.1, Math.sqrt(v)) };
}

function logNormalCDF(x, mu, sigma) {
    if (x <= 0) return 0;
    return normCDF((Math.log(x) - mu) / sigma);
}

function logNormalCondRisk(elapsed, shower, mu, sigma) {
    const survE = 1 - logNormalCDF(elapsed, mu, sigma);
    if (survE < 1e-12) {
        // Past all observed data — decay based on overshoot
        return Math.max(0, shower / (elapsed + shower) * 0.3);
    }
    const survEnd = 1 - logNormalCDF(elapsed + shower, mu, sigma);
    return 1 - survEnd / survE;
}

function logNormalExpResidual(elapsed, mu, sigma) {
    const survE = 1 - logNormalCDF(elapsed, mu, sigma);
    if (survE < 1e-12) return elapsed; // already way past — just return elapsed as "unknown"
    let integral = 0;
    const dt = 0.5;
    const maxT = Math.max(Math.exp(mu + 3 * sigma), elapsed + 500);
    for (let t = elapsed; t < maxT; t += dt) {
        integral += ((1 - logNormalCDF(t, mu, sigma)) / survE) * dt;
    }
    return Math.max(1, integral);
}

function resample(arr) {
    const r = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) r[i] = arr[Math.floor(Math.random() * arr.length)];
    return r;
}

// ==================== Mixture gap model ====================

function classifyGaps(gaps) {
    // Find natural split point using Otsu's method on log-gaps
    const sorted = [...gaps].sort((a, b) => a - b);
    if (sorted.length < 4) return { threshold: sorted[Math.floor(sorted.length / 2)], shortGaps: sorted, longGaps: [] };

    let bestThresh = sorted[Math.floor(sorted.length / 2)];
    let bestVariance = Infinity;

    for (let i = 2; i < sorted.length - 1; i++) {
        const thresh = sorted[i];
        const short = sorted.slice(0, i);
        const long = sorted.slice(i);
        const wS = short.length / sorted.length;
        const wL = long.length / sorted.length;
        const meanS = short.reduce((a, b) => a + b, 0) / short.length;
        const meanL = long.reduce((a, b) => a + b, 0) / long.length;
        const varS = short.reduce((s, x) => s + (x - meanS) ** 2, 0) / short.length;
        const varL = long.reduce((s, x) => s + (x - meanL) ** 2, 0) / long.length;
        const withinVar = wS * varS + wL * varL;
        if (withinVar < bestVariance) {
            bestVariance = withinVar;
            bestThresh = thresh;
        }
    }

    return {
        threshold: bestThresh,
        shortGaps: sorted.filter(g => g <= bestThresh),
        longGaps: sorted.filter(g => g > bestThresh)
    };
}

// ==================== Mixture model ====================

function mixtureCondRisk(elapsed, shower, gaps) {
    const { threshold, shortGaps, longGaps } = classifyGaps(gaps);
    if (shortGaps.length === 0 && longGaps.length === 0) return 0.5;

    const pShort = shortGaps.length / gaps.length;
    const pLong = longGaps.length / gaps.length;

    // Probability of being "in burst" vs "between bursts" depends on elapsed
    // If elapsed < threshold, more likely in burst; if > threshold, between bursts or done
    const burstProb = elapsed < threshold
        ? pShort * Math.exp(-elapsed / Math.max(1, threshold))
        : pShort * Math.exp(-elapsed / Math.max(1, threshold)) * 0.3;
    const pauseProb = 1 - burstProb;

    // Risk from short-gap component
    let shortRisk = 0;
    if (shortGaps.length >= 2) {
        const { mu, sigma } = fitLogNormal(shortGaps);
        shortRisk = logNormalCondRisk(elapsed, shower, mu, sigma);
    } else if (shortGaps.length === 1) {
        shortRisk = elapsed < shortGaps[0] ? shower / (shortGaps[0] + shower) : 0.1;
    }

    // Risk from long-gap component
    let longRisk = 0;
    if (longGaps.length >= 2) {
        const { mu, sigma } = fitLogNormal(longGaps);
        longRisk = logNormalCondRisk(elapsed, shower, mu, sigma);
    } else if (longGaps.length === 1) {
        longRisk = elapsed < longGaps[0] ? shower / (longGaps[0] + shower) : 0.1;
    }

    // Beyond all observed data — decay
    const maxGap = Math.max(...gaps);
    if (elapsed > maxGap) {
        const overshoot = elapsed - maxGap;
        return Math.max(0, shower / (overshoot + shower) * 0.5);
    }

    return burstProb * shortRisk + pauseProb * longRisk;
}

function mixtureExpResidual(elapsed, gaps) {
    const { shortGaps, longGaps } = classifyGaps(gaps);
    const surviving = gaps.filter(g => g > elapsed);
    if (surviving.length === 0) return Math.max(1, elapsed * 0.5);
    return surviving.reduce((s, g) => s + (g - elapsed), 0) / surviving.length;
}

// ==================== Empirical model (fixed) ====================

function empiricalCondRisk(elapsed, shower, gaps) {
    const surviving = gaps.filter(g => g > elapsed);
    if (surviving.length === 0) {
        // Decay past max gap
        const maxGap = gaps.length > 0 ? Math.max(...gaps) : 1;
        const overshoot = elapsed - maxGap;
        return Math.max(0, shower / (overshoot + shower) * 0.5);
    }
    const failing = surviving.filter(g => g <= elapsed + shower);
    return failing.length / surviving.length;
}

function empiricalExpResidual(elapsed, gaps) {
    const surviving = gaps.filter(g => g > elapsed);
    if (surviving.length === 0) return Math.max(1, elapsed * 0.5);
    return surviving.reduce((s, g) => s + (g - elapsed), 0) / surviving.length;
}

// ==================== Random Forest ====================

class DecisionTree {
    constructor(maxDepth = 6, minSamples = 5) {
        this.maxDepth = maxDepth;
        this.minSamples = minSamples;
        this.tree = null;
    }

    fit(X, y) {
        this.tree = this._buildTree(X, y, 0);
    }

    predict(x) {
        return this._traverse(this.tree, x);
    }

    _buildTree(X, y, depth) {
        const mean = y.reduce((a, b) => a + b, 0) / y.length;
        if (depth >= this.maxDepth || y.length < this.minSamples) {
            return { leaf: true, value: mean };
        }

        // Check if all same
        const allSame = y.every(v => v === y[0]);
        if (allSame) return { leaf: true, value: mean };

        let bestFeature = -1, bestThreshold = 0, bestScore = Infinity;
        const nFeatures = X[0].length;

        for (let f = 0; f < nFeatures; f++) {
            // Get unique sorted values for thresholds
            const vals = [...new Set(X.map(x => x[f]))].sort((a, b) => a - b);
            // Try midpoints between consecutive values (subsample if too many)
            const step = Math.max(1, Math.floor(vals.length / 20));
            for (let i = 0; i < vals.length - 1; i += step) {
                const thresh = (vals[i] + vals[i + 1]) / 2;
                const leftY = [], rightY = [];
                for (let j = 0; j < X.length; j++) {
                    if (X[j][f] <= thresh) leftY.push(y[j]);
                    else rightY.push(y[j]);
                }
                if (leftY.length < 2 || rightY.length < 2) continue;

                // MSE split criterion
                const leftMean = leftY.reduce((a, b) => a + b, 0) / leftY.length;
                const rightMean = rightY.reduce((a, b) => a + b, 0) / rightY.length;
                const leftMSE = leftY.reduce((s, v) => s + (v - leftMean) ** 2, 0);
                const rightMSE = rightY.reduce((s, v) => s + (v - rightMean) ** 2, 0);
                const score = leftMSE + rightMSE;

                if (score < bestScore) {
                    bestScore = score;
                    bestFeature = f;
                    bestThreshold = thresh;
                }
            }
        }

        if (bestFeature === -1) return { leaf: true, value: mean };

        const leftX = [], leftY = [], rightX = [], rightY = [];
        for (let i = 0; i < X.length; i++) {
            if (X[i][bestFeature] <= bestThreshold) {
                leftX.push(X[i]); leftY.push(y[i]);
            } else {
                rightX.push(X[i]); rightY.push(y[i]);
            }
        }

        return {
            leaf: false,
            feature: bestFeature,
            threshold: bestThreshold,
            left: this._buildTree(leftX, leftY, depth + 1),
            right: this._buildTree(rightX, rightY, depth + 1)
        };
    }

    _traverse(node, x) {
        if (node.leaf) return node.value;
        return x[node.feature] <= node.threshold
            ? this._traverse(node.left, x)
            : this._traverse(node.right, x);
    }
}

class RandomForest {
    constructor(nTrees = 50, maxDepth = 6, minSamples = 5, sampleFrac = 0.8) {
        this.nTrees = nTrees;
        this.maxDepth = maxDepth;
        this.minSamples = minSamples;
        this.sampleFrac = sampleFrac;
        this.trees = [];
    }

    fit(X, y) {
        this.trees = [];
        const n = X.length;
        const sampleSize = Math.max(10, Math.floor(n * this.sampleFrac));

        for (let t = 0; t < this.nTrees; t++) {
            // Bootstrap sample
            const indices = [];
            for (let i = 0; i < sampleSize; i++) {
                indices.push(Math.floor(Math.random() * n));
            }
            const sX = indices.map(i => X[i]);
            const sY = indices.map(i => y[i]);

            const tree = new DecisionTree(this.maxDepth, this.minSamples);
            tree.fit(sX, sY);
            this.trees.push(tree);
        }
    }

    predict(x) {
        const preds = this.trees.map(t => t.predict(x));
        return preds.reduce((a, b) => a + b, 0) / preds.length;
    }
}

// Feature extraction for random forest
function extractFeatures(gaps, elapsed, shower) {
    if (gaps.length === 0) return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    const sorted = [...gaps].sort((a, b) => a - b);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    const std = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length);

    // Ratio features
    const elapsedOverMedian = median > 0 ? elapsed / median : 0;
    const elapsedOverMax = max > 0 ? elapsed / max : 0;
    const showerOverMedian = median > 0 ? shower / median : 0;

    // Recent trend: ratio of last 3 gaps mean to overall mean
    const recent3 = gaps.slice(-3);
    const recent3Mean = recent3.reduce((a, b) => a + b, 0) / recent3.length;
    const trendRatio = mean > 0 ? recent3Mean / mean : 1;

    // Count of gaps shorter than shower
    const shortCount = gaps.filter(g => g <= shower).length / gaps.length;

    // Count of gaps shorter than elapsed
    const passedCount = gaps.filter(g => g <= elapsed).length / gaps.length;

    // Coefficient of variation
    const cv = mean > 0 ? std / mean : 0;

    return [
        elapsed,              // 0: elapsed minutes since last alert
        shower,               // 1: shower duration
        mean,                 // 2: mean gap
        median,               // 3: median gap
        min,                  // 4: min gap
        max,                  // 5: max gap
        std,                  // 6: std of gaps
        elapsedOverMedian,    // 7: elapsed / median
        elapsedOverMax,       // 8: elapsed / max
        showerOverMedian,     // 9: shower / median
        trendRatio,           // 10: recent trend
        shortCount,           // 11: fraction of gaps < shower
        passedCount,          // 12: fraction of gaps < elapsed
        cv,                   // 13: coefficient of variation
        p25,                  // 14: 25th percentile
        p75,                  // 15: 75th percentile
        gaps.length           // 16: number of gaps available
    ];
}

const FEATURE_NAMES = [
    'elapsed', 'shower', 'mean', 'median', 'min', 'max', 'std',
    'elapsed/median', 'elapsed/max', 'shower/median', 'trend',
    'frac<shower', 'frac<elapsed', 'cv', 'p25', 'p75', 'nGaps'
];

// ==================== Model definitions ====================

function makeModels() {
    return [
        {
            name: 'LogNormal',
            risk: (gaps, elapsed, shower) => {
                if (gaps.length < 3) { const p = fitLogNormal(gaps); return logNormalCondRisk(elapsed, shower, p.mu, p.sigma); }
                let s = 0;
                for (let i = 0; i < BOOTSTRAP_ITERS; i++) { const p = fitLogNormal(resample(gaps)); s += logNormalCondRisk(elapsed, shower, p.mu, p.sigma); }
                return s / BOOTSTRAP_ITERS;
            },
            residual: (gaps, elapsed) => {
                if (gaps.length < 3) { const p = fitLogNormal(gaps); return logNormalExpResidual(elapsed, p.mu, p.sigma); }
                let s = 0;
                for (let i = 0; i < BOOTSTRAP_ITERS; i++) { const p = fitLogNormal(resample(gaps)); s += logNormalExpResidual(elapsed, p.mu, p.sigma); }
                return s / BOOTSTRAP_ITERS;
            }
        },
        {
            name: 'Mixture',
            risk: (gaps, elapsed, shower) => mixtureCondRisk(elapsed, shower, gaps),
            residual: (gaps, elapsed) => mixtureExpResidual(elapsed, gaps)
        },
        {
            name: 'Empirical',
            risk: (gaps, elapsed, shower) => empiricalCondRisk(elapsed, shower, gaps),
            residual: (gaps, elapsed) => empiricalExpResidual(elapsed, gaps)
        },
        {
            name: 'LN+Emp',
            risk: (gaps, elapsed, shower) => {
                const emp = empiricalCondRisk(elapsed, shower, gaps);
                if (gaps.length < 3) { const p = fitLogNormal(gaps); return 0.5 * logNormalCondRisk(elapsed, shower, p.mu, p.sigma) + 0.5 * emp; }
                let s = 0;
                for (let i = 0; i < BOOTSTRAP_ITERS; i++) { const p = fitLogNormal(resample(gaps)); s += logNormalCondRisk(elapsed, shower, p.mu, p.sigma); }
                return 0.5 * (s / BOOTSTRAP_ITERS) + 0.5 * emp;
            },
            residual: (gaps, elapsed) => {
                const emp = empiricalExpResidual(elapsed, gaps);
                if (gaps.length < 3) { const p = fitLogNormal(gaps); return 0.5 * logNormalExpResidual(elapsed, p.mu, p.sigma) + 0.5 * emp; }
                let s = 0;
                for (let i = 0; i < BOOTSTRAP_ITERS; i++) { const p = fitLogNormal(resample(gaps)); s += logNormalExpResidual(elapsed, p.mu, p.sigma); }
                return 0.5 * (s / BOOTSTRAP_ITERS) + 0.5 * emp;
            }
        }
    ];
}

// ==================== Prediction ====================

function computePrediction(modelRiskFn, salvos, duration, now, clusterStartTs, clusterDurationModel) {
    if (salvos.length < 2) return { risk: 0, expectedNextAlert: null, activeProb: 1 };
    const gaps = [];
    for (let i = 1; i < salvos.length; i++) {
        const g = (salvos[i].timestamp - salvos[i - 1].timestamp) / 60;
        if (g > 0) gaps.push(g);
    }
    if (!gaps.length) return { risk: 0, expectedNextAlert: null, activeProb: 1 };

    const recentGaps = gaps.slice(-RECENT_GAPS_COUNT);
    const lastTs = salvos[salvos.length - 1].timestamp;
    const elapsed = (now - lastTs) / 60;

    const modelRisk = typeof modelRiskFn === 'function'
        ? modelRiskFn(recentGaps, elapsed, duration)
        : 0;

    const tSinceStart = clusterStartTs != null ? (now - clusterStartTs) : (now - salvos[0].timestamp);
    const activeProb = clusterSurvival(tSinceStart, clusterDurationModel);

    const risk = Math.max(0, Math.min(1, modelRisk * activeProb));

    return { risk, elapsed, activeProb, recentGaps };
}

// ==================== Active cluster ====================

function getActiveCluster(salvos, nowSec) {
    if (!salvos.length) return { salvos: [], clusterStartTs: null };
    const past = salvos.filter(s => s.timestamp <= nowSec);
    if (!past.length) return { salvos: [], clusterStartTs: null };

    let clusterStart = 0;
    for (let i = past.length - 1; i > 0; i--) {
        if (past[i].timestamp - past[i - 1].timestamp > CLUSTER_GAP_SEC) {
            clusterStart = i;
            break;
        }
    }
    return { salvos: past.slice(clusterStart), clusterStartTs: past[clusterStart].timestamp };
}

// ==================== Helpers ====================

function bsearch(arr, target) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= target) lo = m + 1; else hi = m; }
    return lo;
}

function hasAlertInWindow(timestamps, start, end) {
    const i = bsearch(timestamps, start);
    return i < timestamps.length && timestamps[i] <= end;
}

// ==================== Data loading ====================

async function loadAlerts() {
    const from = new Date(Date.UTC(2026, 1, 1));
    const to = new Date(Date.UTC(2026, 2, 1));
    console.log(`Fetching alerts ${isoDate(from)} → ${isoDate(to)}...`);
    const alerts = await fetchAlerts(isoDate(from), isoDate(to));
    console.log(`Fetched ${alerts.length} raw alerts\n`);
    return alerts;
}

// ==================== Generate training data for RF ====================

function generateTrainingData(salvos, timestamps, showerDurations) {
    const X = [], y = [];
    const warmup = 2 * 3600;
    const extraAfter = 24 * 3600;
    const minNow = salvos[0].timestamp + warmup;
    const maxNow = salvos[salvos.length - 1].timestamp + extraAfter;

    // Sample at multiple time scales
    const steps = [60, 180, 600, 1800]; // 1m, 3m, 10m, 30m steps

    for (const stepSec of steps) {
        for (let nowSec = minNow; nowSec <= maxNow; nowSec += stepSec) {
            const { salvos: active, clusterStartTs } = getActiveCluster(salvos, nowSec);
            if (active.length < 3) continue;

            const gaps = [];
            for (let i = 1; i < active.length; i++) {
                const g = (active[i].timestamp - active[i - 1].timestamp) / 60;
                if (g > 0) gaps.push(g);
            }
            const recentGaps = gaps.slice(-RECENT_GAPS_COUNT);
            if (recentGaps.length < 3) continue;

            const lastTs = active[active.length - 1].timestamp;
            const elapsed = (nowSec - lastTs) / 60;

            for (const shower of showerDurations) {
                const features = extractFeatures(recentGaps, elapsed, shower);
                const occurred = hasAlertInWindow(timestamps, nowSec, nowSec + shower * 60) ? 1 : 0;
                X.push(features);
                y.push(occurred);
            }
        }
    }

    return { X, y };
}

// ==================== Calibration evaluation ====================

function evaluateModel(name, predictions, actuals) {
    const numBins = 10;
    const bins = Array.from({ length: numBins }, () => ({ count: 0, sumPred: 0, sumOutcome: 0 }));
    let brierSum = 0;

    for (let i = 0; i < predictions.length; i++) {
        const r = Math.max(0, Math.min(1, predictions[i]));
        const o = actuals[i];
        brierSum += (r - o) ** 2;
        const bin = Math.min(numBins - 1, Math.floor(r * numBins));
        bins[bin].count++;
        bins[bin].sumPred += r;
        bins[bin].sumOutcome += o;
    }

    const brier = brierSum / predictions.length;
    const baseRate = actuals.reduce((a, b) => a + b, 0) / actuals.length;
    const brierBaseline = actuals.reduce((s, o) => s + (baseRate - o) ** 2, 0) / actuals.length;
    const brierSkill = 1 - brier / brierBaseline;

    console.log(`\n  ${name}: Brier=${brier.toFixed(4)}, Skill=${brierSkill.toFixed(3)}, BaseRate=${pct(baseRate)}, N=${predictions.length}`);
    console.log(`  ${'Bin'.padEnd(8)} ${'Count'.padStart(6)} ${'Pred'.padStart(7)} ${'Actual'.padStart(7)} ${'Delta'.padStart(7)}`);
    console.log(`  ${'─'.repeat(42)}`);

    for (let b = 0; b < numBins; b++) {
        const info = bins[b];
        if (!info.count) continue;
        const avgPred = info.sumPred / info.count;
        const empirical = info.sumOutcome / info.count;
        const delta = empirical - avgPred;
        console.log(
            `  ${(b * 10)}-${(b + 1) * 10}%`.padEnd(8) +
            `${String(info.count).padStart(6)} ` +
            `${pct(avgPred).padStart(7)} ` +
            `${pct(empirical).padStart(7)} ` +
            `${(delta >= 0 ? '+' : '') + pct(delta)}`.padStart(7)
        );
    }

    return { brier, brierSkill, baseRate };
}

// ==================== TESTS ====================

function testDataOverview(salvos) {
    console.log('═'.repeat(70));
    console.log('TEST 1: DATA OVERVIEW');
    console.log('═'.repeat(70));

    const gaps = [];
    for (let i = 1; i < salvos.length; i++) gaps.push((salvos[i].timestamp - salvos[i - 1].timestamp) / 60);
    gaps.sort((a, b) => a - b);

    console.log(`Salvos: ${salvos.length}`);
    console.log(`Span: ${new Date(salvos[0].timestamp * 1000).toISOString()} → ${new Date(salvos[salvos.length - 1].timestamp * 1000).toISOString()}`);
    console.log(`Duration: ${((salvos[salvos.length - 1].timestamp - salvos[0].timestamp) / 3600).toFixed(1)}h`);
    console.log(`\nGap stats (${gaps.length} gaps, minutes):`);
    const percentiles = [0, 10, 25, 50, 75, 90, 100];
    for (const p of percentiles) {
        const idx = Math.min(gaps.length - 1, Math.floor(gaps.length * p / 100));
        console.log(`  P${String(p).padStart(3)}: ${gaps[idx].toFixed(1)}m`);
    }
    console.log(`  Mean: ${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)}m`);

    const { threshold, shortGaps, longGaps } = classifyGaps(gaps);
    console.log(`\nMixture split (Otsu threshold=${threshold.toFixed(1)}m):`);
    console.log(`  Short: ${shortGaps.length} gaps, mean=${shortGaps.length ? (shortGaps.reduce((a, b) => a + b, 0) / shortGaps.length).toFixed(1) : 0}m`);
    console.log(`  Long:  ${longGaps.length} gaps, mean=${longGaps.length ? (longGaps.reduce((a, b) => a + b, 0) / longGaps.length).toFixed(1) : 0}m`);

    return gaps;
}

function testRiskCurves(gaps) {
    console.log('\n' + '═'.repeat(70));
    console.log('TEST 2: RAW RISK vs ELAPSED (shower=15m, no cluster decay)');
    console.log('═'.repeat(70));

    const shower = 15;
    const models = makeModels();
    const elapsedList = [0, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 360, 720, 1440, 4320];

    const header = 'Elapsed'.padEnd(8) + models.map(m => m.name.padStart(10)).join('') + '  Surv';
    console.log(header);
    console.log('─'.repeat(header.length + 8));

    for (const e of elapsedList) {
        const survCount = gaps.filter(g => g > e).length;
        const values = models.map(m => m.risk(gaps, e, shower));
        console.log(
            fmtDur(e).padEnd(8) +
            values.map(v => pct(v).padStart(10)).join('') +
            `  ${survCount}/${gaps.length}`
        );
    }
}

function testCalibration(salvos, clusterDurationModel) {
    console.log('\n' + '═'.repeat(70));
    console.log('TEST 3: BACKTESTING CALIBRATION (all models)');
    console.log('═'.repeat(70));

    const models = makeModels();
    const timestamps = salvos.map(s => s.timestamp);
    const showers = [10, 15, 20];

    const warmup = 2 * 3600;
    const extraAfter = 24 * 3600; // extend well past last alert
    const minNow = salvos[0].timestamp + warmup;
    const maxNow = salvos[salvos.length - 1].timestamp + extraAfter;

    // Multi-scale sampling: dense during active, sparse during quiet
    const evalPoints = new Set();
    // Dense: every 1 min during active period
    for (let t = minNow; t <= salvos[salvos.length - 1].timestamp + 3600; t += 60) evalPoints.add(t);
    // Medium: every 5 min for first 6h after
    for (let t = salvos[salvos.length - 1].timestamp + 3600; t <= salvos[salvos.length - 1].timestamp + 6 * 3600; t += 300) evalPoints.add(t);
    // Sparse: every 30 min beyond
    for (let t = salvos[salvos.length - 1].timestamp + 6 * 3600; t <= maxNow; t += 1800) evalPoints.add(t);
    const sortedEvalPoints = [...evalPoints].sort((a, b) => a - b);

    console.log(`Eval points: ${sortedEvalPoints.length} (${new Date(minNow * 1000).toISOString()} → ${new Date(maxNow * 1000).toISOString()})`);

    for (const shower of showers) {
        console.log(`\n--- Shower: ${shower}m ---`);

        for (const modelDef of models) {
            const predictions = [], actuals = [];

            for (const nowSec of sortedEvalPoints) {
                const { salvos: active, clusterStartTs } = getActiveCluster(salvos, nowSec);
                if (active.length < 3) continue;

                const pred = computePrediction(modelDef.risk, active, shower, nowSec, clusterStartTs, clusterDurationModel);
                if (pred.risk == null || Number.isNaN(pred.risk)) continue;

                const occurred = hasAlertInWindow(timestamps, nowSec, nowSec + shower * 60) ? 1 : 0;
                predictions.push(pred.risk);
                actuals.push(occurred);
            }

            evaluateModel(modelDef.name, predictions, actuals);
        }
    }
}

function testRandomForest(salvos, clusterDurationModel) {
    console.log('\n' + '═'.repeat(70));
    console.log('TEST 4: RANDOM FOREST');
    console.log('═'.repeat(70));

    const timestamps = salvos.map(s => s.timestamp);
    const showers = [10, 15, 20];

    // Generate training data with multi-scale sampling
    console.log('Generating training data...');
    const { X, y } = generateTrainingData(salvos, timestamps, showers);
    console.log(`Training samples: ${X.length} (positives: ${y.filter(v => v === 1).length}, negatives: ${y.filter(v => v === 0).length})`);

    if (X.length < 50) {
        console.log('Not enough training data for random forest');
        return null;
    }

    // Time-based train/test split: first 70% train, last 30% test
    const splitIdx = Math.floor(X.length * 0.7);
    const trainX = X.slice(0, splitIdx), trainY = y.slice(0, splitIdx);
    const testX = X.slice(splitIdx), testY = y.slice(splitIdx);

    console.log(`Train: ${trainX.length}, Test: ${testX.length}`);

    // Train random forest
    console.log('Training random forest (50 trees, depth 6)...');
    const rf = new RandomForest(50, 6, 5, 0.8);
    rf.fit(trainX, trainY);

    // Evaluate on test set
    const testPreds = testX.map(x => rf.predict(x));
    evaluateModel('RF (test set)', testPreds, testY);

    // Full dataset predictions for comparison
    const allPreds = X.map(x => rf.predict(x));
    evaluateModel('RF (full, overfit check)', allPreds, y);

    // Cross-validation: 5-fold
    console.log('\n  5-fold cross-validation:');
    const foldSize = Math.floor(X.length / 5);
    let cvBrierSum = 0, cvN = 0;

    for (let fold = 0; fold < 5; fold++) {
        const valStart = fold * foldSize;
        const valEnd = (fold + 1) * foldSize;
        const cvTrainX = [...X.slice(0, valStart), ...X.slice(valEnd)];
        const cvTrainY = [...y.slice(0, valStart), ...y.slice(valEnd)];
        const cvTestX = X.slice(valStart, valEnd);
        const cvTestY = y.slice(valStart, valEnd);

        const cvRF = new RandomForest(30, 6, 5, 0.8);
        cvRF.fit(cvTrainX, cvTrainY);
        const cvPreds = cvTestX.map(x => cvRF.predict(x));
        const cvBrier = cvPreds.reduce((s, p, i) => s + (p - cvTestY[i]) ** 2, 0) / cvPreds.length;
        cvBrierSum += cvBrier * cvPreds.length;
        cvN += cvPreds.length;
        console.log(`    Fold ${fold + 1}: Brier=${cvBrier.toFixed(4)} (n=${cvPreds.length})`);
    }
    console.log(`    Mean CV Brier: ${(cvBrierSum / cvN).toFixed(4)}`);

    // Feature importance (permutation importance on test set)
    console.log('\n  Feature importance (permutation, test set):');
    const baseBrier = testPreds.reduce((s, p, i) => s + (p - testY[i]) ** 2, 0) / testPreds.length;
    const importances = [];

    for (let f = 0; f < FEATURE_NAMES.length; f++) {
        // Shuffle feature f
        let permBrier = 0;
        const nPerm = 5;
        for (let p = 0; p < nPerm; p++) {
            const permX = testX.map(x => [...x]);
            const permVals = permX.map(x => x[f]);
            // Fisher-Yates shuffle
            for (let i = permVals.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [permVals[i], permVals[j]] = [permVals[j], permVals[i]];
            }
            for (let i = 0; i < permX.length; i++) permX[i][f] = permVals[i];
            const permPreds = permX.map(x => rf.predict(x));
            permBrier += permPreds.reduce((s, pr, i) => s + (pr - testY[i]) ** 2, 0) / permPreds.length;
        }
        permBrier /= nPerm;
        importances.push({ name: FEATURE_NAMES[f], importance: permBrier - baseBrier });
    }

    importances.sort((a, b) => b.importance - a.importance);
    for (const imp of importances) {
        const bar = imp.importance > 0 ? '█'.repeat(Math.min(40, Math.round(imp.importance * 500))) : '';
        console.log(`    ${imp.name.padEnd(16)} ${imp.importance.toFixed(4).padStart(7)} ${bar}`);
    }

    return rf;
}

function testTrajectory(salvos, clusterDurationModel, rf) {
    console.log('\n' + '═'.repeat(70));
    console.log('TEST 5: RISK TRAJECTORY OVER TIME');
    console.log('═'.repeat(70));

    const models = makeModels();
    const shower = 15;
    const timestamps = salvos.map(s => s.timestamp);

    // Pick anchor point
    const midIdx = Math.floor(salvos.length * 0.7);
    const anchorTs = salvos[midIdx].timestamp;
    const elapsedMinutes = [0, 1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440, 2880, 7200];

    console.log(`Anchor: salvo #${midIdx} at ${new Date(anchorTs * 1000).toISOString()}, shower=${shower}m`);

    const rfLabel = rf ? 'RF' : '';
    const header = 'Elapsed'.padEnd(8) +
        models.map(m => m.name.padStart(10)).join('') +
        (rf ? '        RF'.padStart(10) : '') +
        '  P(act)  Actual';
    console.log(header);
    console.log('─'.repeat(header.length));

    for (const e of elapsedMinutes) {
        const nowSec = anchorTs + e * 60;
        const { salvos: active, clusterStartTs } = getActiveCluster(salvos, nowSec);
        if (active.length < 3) continue;

        const occurred = hasAlertInWindow(timestamps, nowSec, nowSec + shower * 60);
        const values = [];
        let ap = 1;

        for (const modelDef of models) {
            const pred = computePrediction(modelDef.risk, active, shower, nowSec, clusterStartTs, clusterDurationModel);
            values.push(pred.risk);
            ap = pred.activeProb;
        }

        let rfVal = null;
        if (rf) {
            const gaps = [];
            for (let i = 1; i < active.length; i++) {
                const g = (active[i].timestamp - active[i - 1].timestamp) / 60;
                if (g > 0) gaps.push(g);
            }
            const recentGaps = gaps.slice(-RECENT_GAPS_COUNT);
            const lastTs = active[active.length - 1].timestamp;
            const elapsedMin = (nowSec - lastTs) / 60;
            const features = extractFeatures(recentGaps, elapsedMin, shower);
            rfVal = rf.predict(features) * ap;
        }

        const occStr = occurred ? ' ← YES' : ' ← no';
        console.log(
            fmtDur(e).padEnd(8) +
            values.map(v => pct(v).padStart(10)).join('') +
            (rfVal !== null ? pct(rfVal).padStart(10) : '') +
            `  ${pct(ap).padStart(6)}` +
            occStr
        );
    }
}

function testQuietPeriod(salvos, clusterDurationModel, rf) {
    console.log('\n' + '═'.repeat(70));
    console.log('TEST 6: QUIET PERIOD DECAY');
    console.log('═'.repeat(70));

    const models = makeModels();
    const shower = 15;
    const lastSalvoTs = salvos[salvos.length - 1].timestamp;

    const hoursAfter = [0.5, 1, 2, 3, 4, 6, 8, 12, 18, 24, 48, 72, 168];

    const rfLabel = rf ? 'RF' : '';
    const header = 'After'.padEnd(8) +
        models.map(m => m.name.padStart(10)).join('') +
        (rf ? '        RF' : '') +
        '  P(active)';
    console.log(header);
    console.log('─'.repeat(header.length));

    for (const h of hoursAfter) {
        const nowSec = lastSalvoTs + h * 3600;
        const { salvos: active, clusterStartTs } = getActiveCluster(salvos, nowSec);
        if (active.length < 3) continue;

        const values = [];
        let ap = 1;
        for (const modelDef of models) {
            const pred = computePrediction(modelDef.risk, active, shower, nowSec, clusterStartTs, clusterDurationModel);
            values.push(pred.risk);
            ap = pred.activeProb;
        }

        let rfVal = null;
        if (rf) {
            const gaps = [];
            for (let i = 1; i < active.length; i++) {
                const g = (active[i].timestamp - active[i - 1].timestamp) / 60;
                if (g > 0) gaps.push(g);
            }
            const recentGaps = gaps.slice(-RECENT_GAPS_COUNT);
            const elapsed = (nowSec - active[active.length - 1].timestamp) / 60;
            const features = extractFeatures(recentGaps, elapsed, shower);
            rfVal = rf.predict(features) * ap;
        }

        console.log(
            fmtDur(h * 60).padEnd(8) +
            values.map(v => pct(v).padStart(10)).join('') +
            (rfVal !== null ? pct(rfVal).padStart(10) : '') +
            `  ${pct(ap)}`
        );
    }
}

function testLOOCV(salvos) {
    console.log('\n' + '═'.repeat(70));
    console.log('TEST 7: LEAVE-ONE-OUT CROSS-VALIDATION');
    console.log('═'.repeat(70));

    const allGaps = [];
    for (let i = 1; i < salvos.length; i++) {
        const g = (salvos[i].timestamp - salvos[i - 1].timestamp) / 60;
        if (g > 0) allGaps.push(g);
    }
    if (allGaps.length < 5) { console.log('Not enough gaps'); return; }

    const models = makeModels();
    const shower = 15;

    console.log(`Gaps: ${allGaps.length}, Shower: ${shower}m`);

    for (const modelDef of models) {
        const predictions = [], actuals = [];

        for (let i = 0; i < allGaps.length; i++) {
            // Use only preceding gaps (causal)
            const train = allGaps.slice(Math.max(0, i - RECENT_GAPS_COUNT), i);
            if (train.length < 3) continue;

            const risk = modelDef.risk(train, 0, shower);
            const occurred = allGaps[i] <= shower ? 1 : 0;
            predictions.push(Math.max(0, Math.min(1, risk)));
            actuals.push(occurred);
        }

        evaluateModel(`${modelDef.name} (LOO)`, predictions, actuals);
    }
}

function testElapsedStratified(salvos, clusterDurationModel, rf) {
    console.log('\n' + '═'.repeat(70));
    console.log('TEST 8: CALIBRATION STRATIFIED BY ELAPSED TIME');
    console.log('═'.repeat(70));

    const timestamps = salvos.map(s => s.timestamp);
    const models = makeModels();
    const shower = 15;

    const warmup = 2 * 3600;
    const extraAfter = 24 * 3600;
    const minNow = salvos[0].timestamp + warmup;
    const maxNow = salvos[salvos.length - 1].timestamp + extraAfter;

    // Collect all eval points with elapsed time
    const evalPoints = [];
    for (let t = minNow; t <= maxNow; t += 60) evalPoints.push(t);

    const elapsedBins = [
        { label: '0-5m', lo: 0, hi: 5 },
        { label: '5-15m', lo: 5, hi: 15 },
        { label: '15-30m', lo: 15, hi: 30 },
        { label: '30-60m', lo: 30, hi: 60 },
        { label: '1-3h', lo: 60, hi: 180 },
        { label: '3-12h', lo: 180, hi: 720 },
        { label: '12h+', lo: 720, hi: Infinity }
    ];

    const allModelNames = [...models.map(m => m.name), ...(rf ? ['RF'] : [])];

    for (const eBin of elapsedBins) {
        const results = {};
        for (const name of allModelNames) results[name] = { preds: [], actuals: [] };

        for (const nowSec of evalPoints) {
            const { salvos: active, clusterStartTs } = getActiveCluster(salvos, nowSec);
            if (active.length < 3) continue;

            const lastTs = active[active.length - 1].timestamp;
            const elapsed = (nowSec - lastTs) / 60;
            if (elapsed < eBin.lo || elapsed >= eBin.hi) continue;

            const occurred = hasAlertInWindow(timestamps, nowSec, nowSec + shower * 60) ? 1 : 0;

            for (const modelDef of models) {
                const pred = computePrediction(modelDef.risk, active, shower, nowSec, clusterStartTs, clusterDurationModel);
                if (pred.risk != null && !Number.isNaN(pred.risk)) {
                    results[modelDef.name].preds.push(pred.risk);
                    results[modelDef.name].actuals.push(occurred);
                }
            }

            if (rf) {
                const gaps = [];
                for (let i = 1; i < active.length; i++) {
                    const g = (active[i].timestamp - active[i - 1].timestamp) / 60;
                    if (g > 0) gaps.push(g);
                }
                const recentGaps = gaps.slice(-RECENT_GAPS_COUNT);
                const features = extractFeatures(recentGaps, elapsed, shower);
                const tSinceStart = clusterStartTs != null ? (nowSec - clusterStartTs) : (nowSec - active[0].timestamp);
                const ap = clusterSurvival(tSinceStart, clusterDurationModel);
                const rfRisk = rf.predict(features) * ap;
                results['RF'].preds.push(rfRisk);
                results['RF'].actuals.push(occurred);
            }
        }

        const n = results[allModelNames[0]].preds.length;
        if (n === 0) continue;
        const actualRate = results[allModelNames[0]].actuals.reduce((a, b) => a + b, 0) / n;

        let line = `${eBin.label.padEnd(8)} n=${String(n).padStart(5)} actual=${pct(actualRate).padStart(6)} |`;
        for (const name of allModelNames) {
            const r = results[name];
            if (r.preds.length === 0) { line += ` ${name}=  N/A  |`; continue; }
            const avgPred = r.preds.reduce((a, b) => a + b, 0) / r.preds.length;
            const brier = r.preds.reduce((s, p, i) => s + (p - r.actuals[i]) ** 2, 0) / r.preds.length;
            line += ` ${name}=${pct(avgPred).padStart(6)} B=${brier.toFixed(3)} |`;
        }
        console.log(line);
    }
}

// ==================== MAIN ====================

async function main() {
    const alerts = await loadAlerts();
    const { salvos, clusterDurationModel } = buildSalvos(alerts);

    if (salvos.length < 5) {
        console.log('Not enough salvos to run tests.');
        return;
    }

    console.log(`Cluster model: ${clusterDurationModel.synthetic ? 'SYNTHETIC' : `${clusterDurationModel.durations.length} clusters`}`);
    console.log(`  Mean duration: ${(clusterDurationModel.meanDurationSec / 3600).toFixed(1)}h`);
    console.log('');

    const gaps = testDataOverview(salvos);
    testRiskCurves(gaps);
    testCalibration(salvos, clusterDurationModel);

    console.log('\n  Training Random Forest...');
    const rf = testRandomForest(salvos, clusterDurationModel);

    testTrajectory(salvos, clusterDurationModel, rf);
    testQuietPeriod(salvos, clusterDurationModel, rf);
    testLOOCV(salvos);
    testElapsedStratified(salvos, clusterDurationModel, rf);

    console.log('\n' + '═'.repeat(70));
    console.log('ALL TESTS COMPLETE');
    console.log('═'.repeat(70));
}

main().catch(e => { console.error('Failed:', e); process.exit(1); });