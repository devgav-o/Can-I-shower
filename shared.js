// shared.js
const SALVO_WINDOW_SEC = 120;
const DAY_SEC = 86400;
const CLUSTER_GAP_SEC = 7 * DAY_SEC;

// ==================== Salvo building ====================
function buildSalvos(alerts) {
    if (!alerts.length) return { salvos: [], locations: [] };
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
    const locations = new Set();
    for (const a of sorted) locations.add(a.location);
    return {
        salvos,
        locations: Array.from(locations).sort()
    };
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

// ==================== Rate estimation ====================
//
// THE KEY INSIGHT:
//
// There are TWO different rates that matter:
//
// 1. CONFLICT RATE: How many salvos per hour is this conflict producing?
//    This is measured over DAYS, not minutes. It doesn't change just because
//    there's been a 6-hour lull. The war is still happening.
//    This answers: "Over my shower window, what's the chance of at least one alert?"
//
// 2. BURST RATE: Am I in the middle of a barrage RIGHT NOW?
//    This is measured over minutes. If the last alert was 30 seconds ago,
//    the next one is probably seconds away.
//    This answers: "Should I wait 5 more minutes before leaving the shelter?"
//
// The user's risk = max(conflict-based risk, burst-based risk)
//
// Burst risk is HIGH right after an alert, drops to baseline within ~30 min
// Conflict risk is the FLOOR — it's always there during active conflict
//
// This gives the bathtub:
//   elapsed=0:    burst HIGH + conflict HIGH  = very high
//   elapsed=30m:  burst fading + conflict HIGH = moderate-high
//   elapsed=6h:   burst gone + conflict HIGH   = still meaningful
//   elapsed=24h+: burst gone + conflict maybe  = depends on whether conflict continues

function computeRisk(salvos, windowMin, nowSec) {
    if (salvos.length < 2) {
        const last = salvos.length === 1 ? salvos[0] : null;
        return {
            risk: last ? 0.5 : 0,
            expectedWait: null,
            minutesSinceLastAlert: last ? (nowSec - last.timestamp) / 60 : null,
            lastAlertTime: last ? last.timestamp : null,
            lastAlertLocations: last ? Array.from(last.locations) : [],
            salvoCount: salvos.length,
            gapStats: null,
            rateInfo: null
        };
    }

    // Build gaps
    const gaps = [];
    for (let i = 1; i < salvos.length; i++) {
        const g = (salvos[i].timestamp - salvos[i - 1].timestamp) / 60;
        if (g > 0) gaps.push(g);
    }

    const lastTs = salvos[salvos.length - 1].timestamp;
    const elapsed = (nowSec - lastTs) / 60; // minutes since last alert

    // ============ CONFLICT RATE ============
    // Overall rate of this conflict, measured over longer windows
    // This is the BASELINE — it doesn't drop just because of a current lull

    // Use multiple windows, take the highest rate that has enough data
    // This captures: "yesterday had 30 salvos" even if today has been quiet so far
    const conflictWindows = [
        { hours: 4,  minSalvos: 2 },
        { hours: 12, minSalvos: 3 },
        { hours: 24, minSalvos: 3 },
        { hours: 72, minSalvos: 5 },
    ];

    let conflictRate = 0; // salvos per minute
    let bestConflictWindow = null;

    for (const cw of conflictWindows) {
        const cutoff = nowSec - cw.hours * 3600;
        let count = 0;
        for (const s of salvos) {
            if (s.timestamp > cutoff && s.timestamp <= nowSec) count++;
        }
        if (count >= cw.minSalvos) {
            const rate = count / (cw.hours * 60); // salvos per minute
            if (rate > conflictRate) {
                conflictRate = rate;
                bestConflictWindow = { hours: cw.hours, count, rate };
            }
        }
    }

    // Fallback: use entire cluster
    if (conflictRate === 0 && salvos.length >= 2) {
        const clusterSpanMin = (nowSec - salvos[0].timestamp) / 60;
        if (clusterSpanMin > 0) {
            conflictRate = salvos.length / clusterSpanMin;
            bestConflictWindow = { hours: clusterSpanMin / 60, count: salvos.length, rate: conflictRate };
        }
    }

    // Conflict-based probability: P = 1 - e^(-rate * window)
    const conflictLambda = conflictRate * windowMin;
    const conflictProb = 1 - Math.exp(-conflictLambda);

    // ============ BURST RATE ============
    // Are we in the middle of rapid fire? Look at very recent activity.
    // This captures the "alert 30 seconds ago → next one imminent" pattern

    const BURST_WINDOW_MIN = 30; // look at last 30 minutes
    const burstCutoff = nowSec - BURST_WINDOW_MIN * 60;
    let burstCount = 0;
    for (const s of salvos) {
        if (s.timestamp > burstCutoff && s.timestamp <= nowSec) burstCount++;
    }

    const burstRate = burstCount / BURST_WINDOW_MIN; // salvos per minute in recent window

    // Burst fades with elapsed time since last alert
    // If last alert was just now → full burst rate
    // If last alert was 30 min ago → burst has faded to baseline
    // Decay: exponential with half-life based on recent gap pattern

    const recentGaps = gaps.slice(-10);
    const medianGap = recentGaps.length > 0
        ? [...recentGaps].sort((a, b) => a - b)[Math.floor(recentGaps.length / 2)]
        : 10;

    // Half-life = median gap (if gaps are 3 min apart, burst fades in ~3 min)
    const halfLife = Math.max(2, medianGap);
    const burstDecay = Math.exp(-elapsed * Math.LN2 / halfLife);
    const adjustedBurstRate = burstRate * burstDecay;

    // Burst probability
    const burstLambda = adjustedBurstRate * windowMin;
    const burstProb = 1 - Math.exp(-burstLambda);

    // ============ COMBINED RISK ============
    // The risk is: what's the chance of at least one alert?
    // P(at least one) = 1 - P(none from conflict) * P(none from burst)
    // But since burst is a SUBSET of conflict activity, we use max instead
    // to avoid double-counting

    // Actually the right way: the effective rate is max(conflict, burst)
    // at each moment, but integrated over the window.
    // Simpler and correct enough: take the higher probability
    const risk = Math.max(conflictProb, burstProb);

    // ============ EXPECTED WAIT ============
    // Use the higher rate for expected wait
    const effectiveRate = Math.max(conflictRate, adjustedBurstRate);
    const expectedWait = effectiveRate > 0.0001 ? 1 / effectiveRate : null;

    // Gap stats
    const sorted = [...gaps].sort((a, b) => a - b);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;

    return {
        risk: Math.max(0, Math.min(0.99, risk)),
        expectedWait,
        minutesSinceLastAlert: elapsed,
        lastAlertTime: lastTs,
        lastAlertLocations: Array.from(salvos[salvos.length - 1].locations),
        salvoCount: salvos.length,
        gapStats: {
            mean,
            median: sorted[Math.floor(sorted.length / 2)],
            min: sorted[0],
            max: sorted[sorted.length - 1],
            count: gaps.length
        },
        rateInfo: {
            conflictRate,
            conflictProb,
            conflictWindow: bestConflictWindow,
            burstRate,
            burstDecay,
            adjustedBurstRate,
            burstProb,
            effectiveRate,
            elapsed
        }
    };
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

module.exports = {
    SALVO_WINDOW_SEC, DAY_SEC, CLUSTER_GAP_SEC,
    buildSalvos,
    getActiveCluster,
    computeRisk,
    bsearch, hasAlertInWindow
};