import { describe, it, expect } from 'vitest';
import { computeRisk, DEFAULT_PARAMS } from '../shared.js';
import {
    clamp01,
    getLevel,
    computeTrend,
    getIsraelClock,
    avg24hSalvosIgnoringQuietDays,
    applyReasoningEnsemble,
    formatResult,
} from '../server/services/riskEngine.js';

const BASE_TS = 1772265600; // 2026-02-28 10:00:00 Israel time (Saturday)
const MIN = 60;
const HOUR = 3600;

function makeSalvos(count, startTs, gapSec = 90 * MIN) {
    return Array.from({ length: count }, (_, i) => ({
        timestamp: startTs + i * gapSec,
        locations: new Set(['TestCity']),
    }));
}

describe('clamp01', () => {
    it('clamps values below 0 to 0', () => expect(clamp01(-1)).toBe(0));
    it('clamps values above 0.99 to 0.99', () => expect(clamp01(1.5)).toBe(0.99));
    it('passes through values in range', () => expect(clamp01(0.5)).toBe(0.5));
});

describe('getLevel', () => {
    it('returns GREEN for risk < 0.25', () => expect(getLevel(0.1)).toBe('GREEN'));
    it('returns YELLOW for risk in [0.25, 0.5)', () => expect(getLevel(0.3)).toBe('YELLOW'));
    it('returns RED for risk >= 0.5', () => expect(getLevel(0.6)).toBe('RED'));
    it('returns YELLOW at exactly 0.25', () => expect(getLevel(0.25)).toBe('YELLOW'));
    it('returns RED at exactly 0.5', () => expect(getLevel(0.5)).toBe('RED'));
});

describe('computeTrend', () => {
    it('returns stable for fewer than 4 gaps', () => expect(computeTrend([10, 20])).toBe('stable'));
    it('returns increasing when recent gaps are much shorter', () => {
        expect(computeTrend([100, 100, 30, 30])).toBe('increasing');
    });
    it('returns decreasing when recent gaps are much longer', () => {
        expect(computeTrend([30, 30, 100, 100])).toBe('decreasing');
    });
    it('returns stable when gaps are similar', () => {
        expect(computeTrend([50, 50, 55, 55])).toBe('stable');
    });
});

describe('getIsraelClock', () => {
    it('returns correct hour and minute for a known timestamp', () => {
        // BASE_TS = 2026-02-28 10:00:00 Israel time (Saturday)
        const clock = getIsraelClock(BASE_TS);
        expect(clock.hour).toBe(10);
        expect(clock.minute).toBe(0);
        expect(clock.minutesSinceMidnight).toBe(600);
    });

    it('returns isWeekend=true for Friday', () => {
        // 2026-02-27 is a Friday in Israel — BASE_TS - 24h = same time previous day
        const fridayTs = BASE_TS - HOUR * 24; // 2026-02-27 10:00 Israel
        const clock = getIsraelClock(fridayTs);
        expect(clock.weekday).toBe('Fri');
        expect(clock.isWeekend).toBe(true);
    });

    it('returns isWeekend=true for Saturday', () => {
        // BASE_TS is Saturday 2026-02-28
        const clock = getIsraelClock(BASE_TS);
        expect(clock.weekday).toBe('Sat');
        expect(clock.isWeekend).toBe(true);
    });
});

describe('avg24hSalvosIgnoringQuietDays', () => {
    it('returns null for empty salvos', () => {
        expect(avg24hSalvosIgnoringQuietDays([])).toBeNull();
    });

    it('computes average salvos per active day', () => {
        // 6 salvos on day 1, 4 salvos on day 2 → avg = 5
        const DAY = 86400;
        const day1Start = Math.floor(BASE_TS / DAY) * DAY;
        const salvos = [
            ...Array.from({ length: 6 }, (_, i) => ({ timestamp: day1Start + i * HOUR, locations: new Set() })),
            ...Array.from({ length: 4 }, (_, i) => ({ timestamp: day1Start + DAY + i * HOUR, locations: new Set() })),
        ];
        const avg = avg24hSalvosIgnoringQuietDays(salvos);
        expect(avg).toBeCloseTo(5, 5);
    });

    it('ignores days with zero salvos in the average', () => {
        const DAY = 86400;
        const day1Start = Math.floor(BASE_TS / DAY) * DAY;
        // Day 1: 4 salvos, Day 2: 0 salvos, Day 3: 6 salvos → avg = (4+6)/2 = 5
        const salvos = [
            ...Array.from({ length: 4 }, (_, i) => ({ timestamp: day1Start + i * HOUR, locations: new Set() })),
            ...Array.from({ length: 6 }, (_, i) => ({ timestamp: day1Start + 2 * DAY + i * HOUR, locations: new Set() })),
        ];
        const avg = avg24hSalvosIgnoringQuietDays(salvos);
        expect(avg).toBeCloseTo(5, 5);
    });
});

describe('applyReasoningEnsemble', () => {
    const salvos = makeSalvos(10, BASE_TS - 15 * HOUR);
    const pred = computeRisk(salvos, 15, BASE_TS, DEFAULT_PARAMS);

    it('returns 6 reasonings', () => {
        const { reasonings } = applyReasoningEnsemble(pred, salvos, 15, BASE_TS);
        expect(reasonings).toHaveLength(6);
    });

    it('includes all 6 required reasoning IDs', () => {
        const { reasonings } = applyReasoningEnsemble(pred, salvos, 15, BASE_TS);
        const ids = reasonings.map(r => r.id);
        expect(ids).toContain('core_hunger_model');
        expect(ids).toContain('activity_24h_vs_baseline');
        expect(ids).toContain('avg_gap_proximity');
        expect(ids).toContain('weibull_hazard');
        expect(ids).toContain('muslim_prayer_times');
        expect(ids).toContain('darkness_visibility');
    });

    it('weights normalize to 1.0', () => {
        const { reasonings } = applyReasoningEnsemble(pred, salvos, 15, BASE_TS);
        const totalWeight = reasonings.reduce((s, r) => s + r.weight, 0);
        expect(totalWeight).toBeCloseTo(1.0, 5);
    });

    it('each reasoning has risk in [0, 0.99]', () => {
        const { reasonings } = applyReasoningEnsemble(pred, salvos, 15, BASE_TS);
        for (const r of reasonings) {
            expect(r.risk).toBeGreaterThanOrEqual(0);
            expect(r.risk).toBeLessThanOrEqual(0.99);
        }
    });

    it('combined risk is in [0, 0.99]', () => {
        const { risk } = applyReasoningEnsemble(pred, salvos, 15, BASE_TS);
        expect(risk).toBeGreaterThanOrEqual(0);
        expect(risk).toBeLessThanOrEqual(0.99);
    });

    it('combined risk equals sum of contributions', () => {
        const { risk, reasonings } = applyReasoningEnsemble(pred, salvos, 15, BASE_TS);
        const sumContrib = reasonings.reduce((s, r) => s + r.contribution, 0);
        expect(risk).toBeCloseTo(sumContrib, 5);
    });

    it('prayer time reasoning has lower risk near a prayer window than far from one', () => {
        // Near Dhuhr (12:30): BASE_TS + 2.5h = 12:30 Israel → minDist = 0 → risk = 0
        const nearPrayerTs = BASE_TS + 2 * HOUR + 30 * MIN; // 12:30 Israel
        // At 10:00 Israel: minDist = 150 min from nearest prayer → risk = 1 (far)
        const farTs = BASE_TS; // 10:00

        const { reasonings: prayerR } = applyReasoningEnsemble(pred, salvos, 15, nearPrayerTs);
        const { reasonings: farR } = applyReasoningEnsemble(pred, salvos, 15, farTs);

        const prayerRisk = prayerR.find(r => r.id === 'muslim_prayer_times').risk;
        const farRisk = farR.find(r => r.id === 'muslim_prayer_times').risk;
        expect(prayerRisk).toBeLessThan(farRisk);
    });

    it('darkness reasoning has higher risk at pre-dawn (02:00-05:00)', () => {
        // 02:00 Israel = BASE_TS - 8*HOUR
        const preDawnTs = BASE_TS - 8 * HOUR;
        const { reasonings: preDawnR } = applyReasoningEnsemble(pred, salvos, 15, preDawnTs);
        const { reasonings: daytimeR } = applyReasoningEnsemble(pred, salvos, 15, BASE_TS);

        const preDawnDark = preDawnR.find(r => r.id === 'darkness_visibility').risk;
        const daytimeDark = daytimeR.find(r => r.id === 'darkness_visibility').risk;
        expect(preDawnDark).toBeGreaterThan(daytimeDark);
    });

    it('produces same risk for same inputs (deterministic)', () => {
        const { risk: r1 } = applyReasoningEnsemble(pred, salvos, 15, BASE_TS);
        const { risk: r2 } = applyReasoningEnsemble(pred, salvos, 15, BASE_TS);
        expect(r1).toBe(r2);
    });

    it('avg_gap_proximity risk increases as elapsed approaches the average gap', () => {
        const earlySalvos = makeSalvos(10, BASE_TS - 15 * HOUR, 90 * MIN);
        const earlyNow = earlySalvos[earlySalvos.length - 1].timestamp + 15 * MIN;
        const lateNow = earlySalvos[earlySalvos.length - 1].timestamp + 80 * MIN;
        const earlyPred = computeRisk(earlySalvos, 15, earlyNow, DEFAULT_PARAMS);
        const latePred = computeRisk(earlySalvos, 15, lateNow, DEFAULT_PARAMS);
        const { reasonings: earlyR } = applyReasoningEnsemble(earlyPred, earlySalvos, 15, earlyNow);
        const { reasonings: lateR } = applyReasoningEnsemble(latePred, earlySalvos, 15, lateNow);
        const earlyGapRisk = earlyR.find(r => r.id === 'avg_gap_proximity').risk;
        const lateGapRisk = lateR.find(r => r.id === 'avg_gap_proximity').risk;
        expect(lateGapRisk).toBeGreaterThan(earlyGapRisk);
    });

    it('weibull_hazard has higher risk shortly after alert than in mid-period', () => {
        const btSalvos = makeSalvos(10, BASE_TS - 15 * HOUR, 90 * MIN);
        const lastTs = btSalvos[btSalvos.length - 1].timestamp;
        const veryShortAfter = lastTs + 30;
        const midPeriod = lastTs + 45 * MIN;
        const shortPred = computeRisk(btSalvos, 15, veryShortAfter, DEFAULT_PARAMS);
        const midPred = computeRisk(btSalvos, 15, midPeriod, DEFAULT_PARAMS);
        const { reasonings: shortR } = applyReasoningEnsemble(shortPred, btSalvos, 15, veryShortAfter);
        const { reasonings: midR } = applyReasoningEnsemble(midPred, btSalvos, 15, midPeriod);
        const shortRisk = shortR.find(r => r.id === 'weibull_hazard').risk;
        const midRisk = midR.find(r => r.id === 'weibull_hazard').risk;
        expect(shortRisk).toBeGreaterThan(midRisk);
    });

    it('weibull_hazard has higher risk well past median than in mid-period', () => {
        const btSalvos = makeSalvos(10, BASE_TS - 15 * HOUR, 90 * MIN);
        const lastTs = btSalvos[btSalvos.length - 1].timestamp;
        const midPeriod = lastTs + 45 * MIN;
        const latePeriod = lastTs + 120 * MIN;
        const midPred = computeRisk(btSalvos, 15, midPeriod, DEFAULT_PARAMS);
        const latePred = computeRisk(btSalvos, 15, latePeriod, DEFAULT_PARAMS);
        const { reasonings: midR } = applyReasoningEnsemble(midPred, btSalvos, 15, midPeriod);
        const { reasonings: lateR } = applyReasoningEnsemble(latePred, btSalvos, 15, latePeriod);
        const midRisk = midR.find(r => r.id === 'weibull_hazard').risk;
        const lateRisk = lateR.find(r => r.id === 'weibull_hazard').risk;
        expect(lateRisk).toBeGreaterThan(midRisk);
    });

    it('uses nowSec for time-based reasonings (debug time consistency)', () => {
        // Different nowSec values should produce different prayer/darkness risks
        const ts1 = BASE_TS; // 10:00 Israel
        const ts2 = BASE_TS - 8 * HOUR; // 02:00 Israel (pre-dawn)
        const { reasonings: r1 } = applyReasoningEnsemble(pred, salvos, 15, ts1);
        const { reasonings: r2 } = applyReasoningEnsemble(pred, salvos, 15, ts2);
        const dark1 = r1.find(r => r.id === 'darkness_visibility').risk;
        const dark2 = r2.find(r => r.id === 'darkness_visibility').risk;
        expect(dark1).not.toBe(dark2);
    });
});

describe('formatResult', () => {
    const salvos = makeSalvos(10, BASE_TS - 15 * HOUR);
    const pred = computeRisk(salvos, 15, BASE_TS, DEFAULT_PARAMS);

    it('returns all required fields', () => {
        const result = formatResult(pred, salvos, 15, BASE_TS);
        expect(result).toHaveProperty('risk');
        expect(result).toHaveProperty('level');
        expect(result).toHaveProperty('minutesSinceLastAlert');
        expect(result).toHaveProperty('lastAlertTime');
        expect(result).toHaveProperty('lastAlertLocations');
        expect(result).toHaveProperty('salvoCount');
        expect(result).toHaveProperty('gapStats');
        expect(result).toHaveProperty('trend');
        expect(result).toHaveProperty('reasonings');
        expect(result).toHaveProperty('modelType');
    });

    it('level matches risk', () => {
        const result = formatResult(pred, salvos, 15, BASE_TS);
        if (result.risk >= 0.5) expect(result.level).toBe('RED');
        else if (result.risk >= 0.25) expect(result.level).toBe('YELLOW');
        else expect(result.level).toBe('GREEN');
    });

    it('reasonings are present and non-empty', () => {
        const result = formatResult(pred, salvos, 15, BASE_TS);
        expect(result.reasonings.length).toBeGreaterThan(0);
    });
});
