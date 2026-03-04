import { describe, it, expect, vi, beforeEach } from 'vitest';

const BASE_TS = 1772265600; // 2026-02-28 10:00:00 Israel time (Saturday)
const HOUR = 3600;
const MIN = 60;

function makeSalvos(count, startTs, gapSec = 30 * MIN) {
    return Array.from({ length: count }, (_, i) => ({
        timestamp: startTs + i * gapSec,
        locations: new Set(['TestCity']),
    }));
}

function parseDebugNow(val) {
    if (val == null || val === '') return null;
    const n = Number(val);
    if (!Number.isNaN(n) && n > 0) return Math.floor(n < 1e12 ? n : n / 1000);
    return null;
}

describe('parseDebugNow (debug time bug fix)', () => {
    it('returns null for empty string', () => {
        expect(parseDebugNow('')).toBeNull();
        expect(parseDebugNow(null)).toBeNull();
    });

    it('accepts epoch in seconds', () => {
        expect(parseDebugNow(BASE_TS)).toBe(BASE_TS);
        expect(parseDebugNow(String(BASE_TS))).toBe(BASE_TS);
    });

    it('accepts epoch in milliseconds and converts to seconds', () => {
        const ms = BASE_TS * 1000;
        expect(parseDebugNow(ms)).toBe(BASE_TS);
        expect(parseDebugNow(String(ms))).toBe(BASE_TS);
    });

    it('does NOT accept datetime-local strings (timezone-ambiguous)', () => {
        expect(parseDebugNow('2026-02-28T10:00')).toBeNull();
        expect(parseDebugNow('2026-02-28 10:00:00')).toBeNull();
    });

    it('epoch-based debug time is timezone-independent', () => {
        const epoch = BASE_TS;
        const result1 = parseDebugNow(epoch);
        const result2 = parseDebugNow(epoch);
        expect(result1).toBe(result2);
        expect(result1).toBe(BASE_TS);
    });
});

describe('/api/daily-risk', () => {
    it('returns 97 points for a 24h window (15-min intervals, inclusive)', async () => {
        vi.resetModules();
        vi.mock('../server/services/alertFetcher.js', () => ({
            getParsedCache: () => ({
                salvos: makeSalvos(20, BASE_TS - 10 * HOUR),
                locations: ['TestCity'],
            }),
        }));

        const { handleDailyRisk } = await import('../server/routes/predict.js');
        const params = new URLSearchParams({ duration: '15', debugNow: String(BASE_TS) });
        const res = handleDailyRisk(params);

        expect(res.points).toHaveLength(97);
    });

    it('each point has required fields', async () => {
        vi.resetModules();
        vi.mock('../server/services/alertFetcher.js', () => ({
            getParsedCache: () => ({
                salvos: makeSalvos(20, BASE_TS - 10 * HOUR),
                locations: ['TestCity'],
            }),
        }));

        const { handleDailyRisk } = await import('../server/routes/predict.js');
        const params = new URLSearchParams({ duration: '15', debugNow: String(BASE_TS) });
        const res = handleDailyRisk(params);

        for (const point of res.points) {
            expect(point).toHaveProperty('time');
            expect(point).toHaveProperty('minuteOfDay');
            expect(point).toHaveProperty('risk');
            expect(point).toHaveProperty('level');
            expect(point.risk).toBeGreaterThanOrEqual(0);
            expect(point.risk).toBeLessThanOrEqual(1);
            expect(['GREEN', 'YELLOW', 'RED']).toContain(point.level);
        }
    });

    it('points are in 15-minute increments centered on now', async () => {
        vi.resetModules();
        vi.mock('../server/services/alertFetcher.js', () => ({
            getParsedCache: () => ({
                salvos: makeSalvos(20, BASE_TS - 10 * HOUR),
                locations: ['TestCity'],
            }),
        }));

        const { handleDailyRisk } = await import('../server/routes/predict.js');
        const params = new URLSearchParams({ duration: '15', debugNow: String(BASE_TS) });
        const res = handleDailyRisk(params);

        for (let i = 1; i < res.points.length; i++) {
            expect(res.points[i].minuteOfDay - res.points[i - 1].minuteOfDay).toBe(15);
        }
        const first = res.points[0].minuteOfDay;
        const last = res.points[res.points.length - 1].minuteOfDay;
        expect(last - first).toBe(1440);
    });

    it('returns today date in the response', async () => {
        vi.resetModules();
        vi.mock('../server/services/alertFetcher.js', () => ({
            getParsedCache: () => ({
                salvos: makeSalvos(20, BASE_TS - 10 * HOUR),
                locations: ['TestCity'],
            }),
        }));

        const { handleDailyRisk } = await import('../server/routes/predict.js');
        const params = new URLSearchParams({ duration: '15', debugNow: String(BASE_TS) });
        const res = handleDailyRisk(params);

        expect(res.date).toBe('2026-02-28');
        expect(res.duration).toBe(15);
    });

    it('level matches risk for each point', async () => {
        vi.resetModules();
        vi.mock('../server/services/alertFetcher.js', () => ({
            getParsedCache: () => ({
                salvos: makeSalvos(20, BASE_TS - 10 * HOUR),
                locations: ['TestCity'],
            }),
        }));

        const { handleDailyRisk } = await import('../server/routes/predict.js');
        const params = new URLSearchParams({ duration: '15', debugNow: String(BASE_TS) });
        const res = handleDailyRisk(params);

        for (const point of res.points) {
            if (point.risk >= 0.5) expect(point.level).toBe('RED');
            else if (point.risk >= 0.25) expect(point.level).toBe('YELLOW');
            else expect(point.level).toBe('GREEN');
        }
    });

    it('works with no salvos (returns all GREEN)', async () => {
        vi.resetModules();
        vi.mock('../server/services/alertFetcher.js', () => ({
            getParsedCache: () => ({ salvos: [], locations: [] }),
        }));

        const { handleDailyRisk } = await import('../server/routes/predict.js');
        const params = new URLSearchParams({ duration: '15', debugNow: String(BASE_TS) });
        const res = handleDailyRisk(params);

        expect(res.points).toHaveLength(97);
        for (const point of res.points) {
            expect(point.risk).toBe(0);
            expect(point.level).toBe('GREEN');
        }
    });
});
