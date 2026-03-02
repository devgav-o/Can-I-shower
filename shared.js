const SALVO_WINDOW_SEC = 120;
const DAY_SEC = 86400;

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
    return { salvos, locations: Array.from(locations).sort() };
}

// ==================== Two-state hunger model ====================
//
// Two state variables:
//   hunger âˆˆ [0, 1]    - tension / need for next attack. Grows over time.
//   satiation âˆˆ [0, âˆž) - post-salvo fullness. Spikes on salvo, decays to 0.
//
// Between events (dt minutes):
//   satiation *= exp(-satiation_decay * dt)          -- fullness fades
//   effective_growth = growth_rate * (1 - hunger)     -- logistic toward 1
//   suppression = 1 / (1 + satiation)                 -- satiation suppresses growth
//   hunger += effective_growth * suppression * dt
//
// On salvo:
//   satiation += satiation_boost                      -- just ate â†’ fullness spikes
//   hunger *= (1 - drop_per_salvo)                    -- immediate partial drop
//
// Behavior:
//   Right after salvo: satiation is high â†’ growth suppressed â†’ hunger stays low
//   Minutes later: satiation decays â†’ growth resumes
//   Hours/days later: satiation â‰ˆ 0 â†’ hunger grows freely toward 1

const DEFAULT_PARAMS = {
    growth_rate: 0.003,
    drop_per_salvo: 0.3,
    satiation_boost: 2.0,
    satiation_decay: 0.05,
    base_duration: 15,
    barrage_halflife: 10,
};

const SIM_STEP_MIN = 10;

function advanceState(hunger, satiation, dtMinutes, growth_rate, satiation_decay) {
    const steps = Math.max(1, Math.ceil(dtMinutes / SIM_STEP_MIN));
    const stepDt = dtMinutes / steps;
    for (let i = 0; i < steps; i++) {
        satiation *= Math.exp(-satiation_decay * stepDt);
        const suppression = 1 / (1 + satiation);
        hunger += growth_rate * (1 - hunger) * suppression * stepDt;
    }
    return { hunger: Math.min(1, hunger), satiation };
}

function simulateHungerState(salvos, nowSec, params) {
    const { growth_rate, drop_per_salvo, satiation_boost, satiation_decay } = params;
    let hunger = 0;
    let satiation = 0;
    let prevSec = salvos.length > 0 ? salvos[0].timestamp : nowSec;

    for (const salvo of salvos) {
        if (salvo.timestamp > nowSec) break;
        const dt = (salvo.timestamp - prevSec) / 60;
        if (dt > 0) {
            const state = advanceState(hunger, satiation, dt, growth_rate, satiation_decay);
            hunger = state.hunger;
            satiation = state.satiation;
        }
        satiation += satiation_boost;
        hunger *= (1 - drop_per_salvo);
        prevSec = salvo.timestamp;
    }

    const dtNow = (nowSec - prevSec) / 60;
    if (dtNow > 0) {
        const state = advanceState(hunger, satiation, dtNow, growth_rate, satiation_decay);
        hunger = state.hunger;
        satiation = state.satiation;
    }

    return { hunger: Math.max(0, Math.min(1, hunger)), satiation };
}

function simulateHunger(salvos, nowSec, params) {
    return simulateHungerState(salvos, nowSec, params).hunger;
}

function estimateExpectedWait(salvos, nowSec, windowMin, params) {
    const RISK_THRESHOLD = 0.5;
    const MAX_HORIZON_MIN = 48 * 60;
    const STEP_MIN = 5;

    const { hunger, satiation } = simulateHungerState(salvos, nowSec, params);
    if (hungerToRisk(hunger, windowMin, params) >= RISK_THRESHOLD) return 0;

    let h = hunger;
    let s = satiation;
    let elapsed = 0;
    while (elapsed < MAX_HORIZON_MIN) {
        const state = advanceState(h, s, STEP_MIN, params.growth_rate, params.satiation_decay);
        h = state.hunger;
        s = state.satiation;
        elapsed += STEP_MIN;
        if (hungerToRisk(h, windowMin, params) >= RISK_THRESHOLD) return elapsed;
    }
    return null;
}

function hungerToRisk(hunger, durationMin, params) {
    const base = Math.max(1, params.base_duration);
    return Math.max(0, Math.min(0.99, 1 - Math.pow(1 - hunger, durationMin / base)));
}

// ==================== Main prediction ====================

function computeBarrageRisk(gaps, elapsed, durationMin) {
    if (gaps.length < 2) return 0;
    const recentGaps = gaps.slice(-20);
    const medianGap = [...recentGaps].sort((a, b) => a - b)[Math.floor(recentGaps.length / 2)];
    const rate = 1 / Math.max(1, medianGap);
    const surviving = recentGaps.filter(g => g > elapsed);
    if (surviving.length === 0) return Math.max(0, durationMin / (elapsed + durationMin) * 0.3);
    const failing = surviving.filter(g => g <= elapsed + durationMin);
    return failing.length / surviving.length;
}

function computeRisk(salvos, windowMin, nowSec, params) {
    const p = params || DEFAULT_PARAMS;

    if (salvos.length < 2) {
        const last = salvos.length === 1 ? salvos[0] : null;
        const elapsed = last ? (nowSec - last.timestamp) / 60 : null;
        let risk = last ? 0.5 : 0;

        if (elapsed != null && elapsed > 0) {
            const quietBlocks = Math.floor(elapsed / (12 * 60));
            if (quietBlocks > 0) {
                const quietFactor = Math.pow(0.6, quietBlocks);
                risk *= quietFactor;
            }
        }

        return {
            risk,
            expectedWait: null,
            minutesSinceLastAlert: elapsed,
            lastAlertTime: last ? last.timestamp : null,
            lastAlertLocations: last ? Array.from(last.locations) : [],
            salvoCount: salvos.length,
            gapStats: null,
            avgGapLast10Minutes: null,
            hungerInfo: null,
        };
    }

    const lastTs = salvos[salvos.length - 1].timestamp;
    const elapsed = (nowSec - lastTs) / 60;
    const hunger = simulateHunger(salvos, nowSec, p);
    const tensionRisk = hungerToRisk(hunger, windowMin, p);

    const gaps = extractGaps(salvos);
    const barrageRisk = computeBarrageRisk(gaps, elapsed, windowMin);

    const halflife = Math.max(1, p.barrage_halflife || 10);
    const barrageWeight = Math.exp(-0.693 * elapsed / halflife);
    let risk = Math.max(0, Math.min(0.99, barrageWeight * barrageRisk + (1 - barrageWeight) * tensionRisk));

    const sorted = [...gaps].sort((a, b) => a - b);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const last10Gaps = salvos.length >= 10 ? gaps.slice(-9) : gaps;
    const avgGapLast10Minutes = last10Gaps.length
        ? last10Gaps.reduce((a, b) => a + b, 0) / last10Gaps.length
        : null;
    let expectedWait = estimateExpectedWait(salvos, nowSec, windowMin, p);

    if (elapsed > 0) {
        const quietBlocks = Math.floor(elapsed / (12 * 60));
        if (quietBlocks > 0) {
            const quietFactor = Math.pow(0.6, quietBlocks);
            risk *= quietFactor;
            if (expectedWait != null) {
                expectedWait /= quietFactor;
            }
        }
    }

    // If the hunger-based model thinks we're already at \"high risk now\"
    // (expectedWait === 0) but the final decayed risk is still below 0.5,
    // suppress the \"High risk in Now\" indicator by treating it as unknown.
    if (expectedWait === 0 && risk < 0.5) {
        expectedWait = null;
    }

    return {
        risk,
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
            count: gaps.length,
        },
        avgGapLast10Minutes,
        hungerInfo: { hunger, barrageRisk, barrageWeight, tensionRisk, elapsed, params: p },
    };
}

// ==================== Helpers ====================

function extractGaps(salvos) {
    const gaps = [];
    for (let i = 1; i < salvos.length; i++) {
        const g = (salvos[i].timestamp - salvos[i - 1].timestamp) / 60;
        if (g > 0) gaps.push(g);
    }
    return gaps;
}

function bsearch(arr, target) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= target) lo = m + 1; else hi = m; }
    return lo;
}

function hasAlertInWindow(timestamps, start, end) {
    const i = bsearch(timestamps, start);
    return i < timestamps.length && timestamps[i] <= end;
}

function parseIsraelTimestamp(dateStr) {
    const normalized = dateStr.replace(' ', 'T');
    const utcPlus2 = new Date(normalized + '+02:00');
    const utcPlus3 = new Date(normalized + '+03:00');
    const fmt = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false });
    let localHour2 = parseInt(fmt.format(utcPlus2), 10);
    if (localHour2 === 24) localHour2 = 0;
    const parsedHour = parseInt(dateStr.split(/[\sT]/)[1].split(':')[0], 10);
    if (localHour2 === parsedHour) return Math.floor(utcPlus2.getTime() / 1000);
    return Math.floor(utcPlus3.getTime() / 1000);
}

module.exports = {
    SALVO_WINDOW_SEC, DAY_SEC,
    buildSalvos,
    computeRisk, extractGaps,
    simulateHunger, simulateHungerState, advanceState, hungerToRisk, estimateExpectedWait,
    DEFAULT_PARAMS,
    bsearch, hasAlertInWindow,
    parseIsraelTimestamp,
};
