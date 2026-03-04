const { extractRoundGaps } = require('../../shared');

function clamp01(x) {
    return Math.max(0, Math.min(0.99, x));
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
    const ratio = avg(recent) / avg(older);
    if (ratio < 0.7) return 'increasing';
    if (ratio > 1.3) return 'decreasing';
    return 'stable';
}

/**
 * Get the UTC offset in seconds for Asia/Jerusalem at a given unix timestamp.
 * We call Intl once and parse the result to derive the offset.
 */
let _cachedOffsetTs = 0;
let _cachedOffsetSec = 0;
const _offsetCacheTTL = 3600; // recalc every hour (covers DST transitions)

function getIsraelOffsetSec(nowSec) {
    // Cache: offset only changes at DST boundaries (~2x/year), so 1h cache is safe
    if (Math.abs(nowSec - _cachedOffsetTs) < _offsetCacheTTL) {
        return _cachedOffsetSec;
    }
    const date = new Date(nowSec * 1000);
    const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jerusalem',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
    const parts = fmt.formatToParts(date);
    const get = type => parseInt(parts.find(p => p.type === type).value, 10);
    const ilYear = get('year');
    const ilMonth = get('month');
    const ilDay = get('day');
    const ilHour = get('hour');
    const ilMinute = get('minute');
    // Reconstruct what UTC timestamp would correspond to that wall-clock reading if it were UTC
    const ilAsUtc = Date.UTC(ilYear, ilMonth - 1, ilDay, ilHour, ilMinute, 0, 0) / 1000;
    // The offset is the difference
    const offsetSec = Math.round(ilAsUtc - nowSec);
    // Round to nearest 15min to avoid sub-minute jitter from formatting
    _cachedOffsetSec = Math.round(offsetSec / 900) * 900;
    _cachedOffsetTs = nowSec;
    return _cachedOffsetSec;
}

/**
 * Fast Israel hour extraction using cached offset — no Intl calls per salvo.
 */
function fastIsraelHour(tsSec, offsetSec) {
    const localSec = tsSec + offsetSec;
    // seconds since midnight in local time
    const secOfDay = ((localSec % 86400) + 86400) % 86400;
    return Math.floor(secOfDay / 3600);
}

/**
 * Fast Israel day key (YYYY-MM-DD) using cached offset.
 */
function fastIsraelDayIndex(tsSec, offsetSec) {
    // Day index: integer number of days since epoch in local time
    return Math.floor((tsSec + offsetSec) / 86400);
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
    const get = type => parts.find(p => p.type === type);
    const hour = parseInt(get('hour').value, 10);
    const minute = parseInt(get('minute').value, 10);
    const weekday = get('weekday').value;
    const month = parseInt(get('month').value, 10);
    const day = parseInt(get('day').value, 10);
    return {
        hour,
        minute,
        minutesSinceMidnight: hour * 60 + minute,
        weekday,
        isWeekend: weekday === 'Fri' || weekday === 'Sat',
        month,
        day,
    };
}

function getIsraelDayKey(ts) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jerusalem',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date(ts * 1000));
}

function avg24hSalvosIgnoringQuietDays(salvos) {
    if (!salvos.length) return null;
    const DAY_SEC = 86400;
    const dayCounts = new Map();
    for (const s of salvos) {
        const dayKey = Math.floor(s.timestamp / DAY_SEC);
        dayCounts.set(dayKey, (dayCounts.get(dayKey) || 0) + 1);
    }
    if (!dayCounts.size) return null;
    let total = 0;
    for (const count of dayCounts.values()) total += count;
    return total / dayCounts.size;
}

const DEFAULT_WEIGHTS = {
    core_hunger_model: 0.35,
    activity_24h_vs_baseline: 0.15,
    avg_gap_proximity: 0.15,
    weibull_hazard: 0.1,
    muslim_prayer_times: 0.08,
    darkness_visibility: 0.08,
    time_in_day: 0.09,
};

function applyReasoningEnsemble(pred, salvos, durationMin, nowSec, weights, precomputedRoundGaps) {
    const baseRisk = clamp01(pred.risk || 0);
    const clock = getIsraelClock(nowSec);
    const w = weights || DEFAULT_WEIGHTS;
    const gaps = precomputedRoundGaps || extractRoundGaps(salvos);
    const reasonings = [];

    const recentSalvoCounts = (() => {
        const cutoff24 = nowSec - 24 * 3600;
        let c24 = 0;
        for (const s of salvos) {
            if (s.timestamp >= cutoff24 && s.timestamp <= nowSec) c24++;
        }
        return { last24h: c24 };
    })();

    function addReason(id, label, risk, explanation) {
        const weight = w[id] ?? (1 / Object.keys(w).length);
        reasonings.push({ id, label, weight, risk: clamp01(risk), contribution: weight * clamp01(risk), explanation });
    }

    // ── core_hunger_model ──
    addReason(
        'core_hunger_model',
        { en: 'Core statistical model', he: 'מודל סטטיסטי מרכזי' },
        baseRisk,
        { en: 'Main two-state "hunger" model combining long-term tension build-up with recent barrage intensity.', he: 'מודל "רעב" דו-מצבי המשלב הצטברות מתח ארוכת טווח עם עוצמת מטחים אחרונה.' },
    );

    // ── activity_24h_vs_baseline ──
    (function () {
        const baseline = avg24hSalvosIgnoringQuietDays(salvos);
        const count24 = recentSalvoCounts.last24h;
        if (baseline && baseline > 0) {
            let standaloneRisk;
            let qualifierEn, qualifierHe;
            if (count24 === 0) {
                standaloneRisk = 0.2;
                qualifierEn = 'no alerts in the last 24 hours, quieter than the typical active day';
                qualifierHe = 'ללא התרעות ב-24 השעות האחרונות, שקט מהיום הפעיל הממוצע';
            } else {
                const ratio = count24 / baseline;
                const pct = (ratio * 100).toFixed(0);
                standaloneRisk = Math.max(0, 1 - ratio);
                if (ratio < 0.5) {
                    qualifierEn = `about ${pct}% of the typical 24h salvo rate for this location`;
                    qualifierHe = `כ-${pct}% מקצב המטחים הרגיל ב-24 שעות עבור מיקום זה`;
                } else if (ratio < 1.1) {
                    qualifierEn = 'roughly in line with the typical 24h number of alerts for this location';
                    qualifierHe = 'בקירוב תואם את מספר ההתרעות הרגיל ב-24 שעות עבור מיקום זה';
                } else {
                    qualifierEn = `well above the typical 24h rate (≈${pct}%)`;
                    qualifierHe = `מעל הקצב הרגיל ב-24 שעות באופן משמעותי (≈${pct}%)`;
                }
            }
            const avgStr = baseline.toFixed(1);
            addReason(
                'activity_24h_vs_baseline',
                { en: '24h activity vs typical', he: 'פעילות 24ש\' מול ממוצע' },
                standaloneRisk,
                {
                    en: `There were ${count24} alerts in the last 24 hours; the average is about ${avgStr}. Current activity is ${qualifierEn}.`,
                    he: `היו ${count24} התרעות ב-24 השעות האחרונות; הממוצע הוא כ-${avgStr}. הפעילות הנוכחית ${qualifierHe}.`,
                },
            );
        }
    })();

    // ── muslim_prayer_times ──
    (function () {
        const centers = [5 * 60, 12 * 60 + 30, 15 * 60 + 45, 18 * 60 + 15, 20 * 60];
        const m = clock.minutesSinceMidnight;
        let minDist = Infinity;
        for (const c of centers) {
            const d = Math.abs(m - c);
            if (d < minDist) minDist = d;
        }
        let standaloneRisk;
        let detailEn, detailHe;
        if (minDist <= 20) {
            standaloneRisk = minDist / 100;
            detailEn = 'inside a typical Muslim prayer window';
            detailHe = 'בתוך חלון תפילה מוסלמי טיפוסי';
        } else if (minDist <= 45) {
            standaloneRisk = minDist / 100;
            detailEn = 'near a typical Muslim prayer window';
            detailHe = 'קרוב לחלון תפילה מוסלמי טיפוסי';
        } else {
            standaloneRisk = 1;
            detailEn = 'far from common prayer windows';
            detailHe = 'רחוק מחלונות תפילה נפוצים';
        }
        const directionEn = standaloneRisk < 0.5 ? 'slightly lowers' : standaloneRisk > 0.5 ? 'slightly nudges up' : 'does not change';
        const directionHe = standaloneRisk < 0.5 ? 'מוריד מעט את' : standaloneRisk > 0.5 ? 'מעלה מעט את' : 'לא משנה את';
        const timeStr = `${clock.hour.toString().padStart(2, '0')}:${clock.minute.toString().padStart(2, '0')}`;
        addReason(
            'muslim_prayer_times',
            { en: 'Prayer time bias', he: 'הטיית זמני תפילה' },
            standaloneRisk,
            {
                en: `Local time in Israel is around ${timeStr}, ${detailEn}, so this heuristic ${directionEn} the risk when considered on its own.`,
                he: `השעה המקומית בישראל היא בסביבות ${timeStr}, ${detailHe}, כך שהיוריסטיקה הזו ${directionHe} הסיכון כשנבחנת בפני עצמה.`,
            },
        );
    })();

    // ── darkness_visibility ──
    (function () {
        const h = clock.hour;
        let standaloneRisk;
        let descEn, descHe;
        if (h >= 2 && h < 5) {
            standaloneRisk = 0.7;
            descEn = 'Pre-dawn hours (02:00–05:00) are historically favored for rocket launches — darkness provides cover for launch crews and sleeping civilians have slower shelter response.';
            descHe = 'שעות לפני עלות השחר (02:00–05:00) מועדפות היסטורית לשיגור רקטות — החושך מספק כיסוי לצוותי השיגור ואזרחים ישנים מגיבים לאט יותר למקלט.';
        } else if ((h >= 5 && h < 7) || (h >= 18 && h < 20)) {
            standaloneRisk = 0.55;
            descEn = 'Dawn and dusk transitions create operational windows — shifting light complicates aerial surveillance and interception.';
            descHe = 'מעברי שחר ודמדומים יוצרים חלונות מבצעיים — שינויי תאורה מקשים על מעקב אווירי ויירוט.';
        } else if (h >= 20 || h < 2) {
            standaloneRisk = 0.45;
            descEn = 'Nighttime sees moderate launch activity — darkness helps but sustained operations are harder to coordinate.';
            descHe = 'בלילה יש פעילות שיגור מתונה — החושך עוזר אך קשה יותר לתאם פעולות מתמשכות.';
        } else {
            standaloneRisk = 0.25;
            descEn = 'Full daylight exposes launch crews to aerial surveillance, slightly reducing launch likelihood.';
            descHe = 'אור יום מלא חושף צוותי שיגור למעקב אווירי, ומפחית מעט את הסיכוי לשיגור.';
        }
        addReason(
            'darkness_visibility',
            { en: 'Darkness & operational cover', he: 'חושך וכיסוי מבצעי' },
            standaloneRisk,
            { en: descEn, he: descHe },
        );
    })();

    // ── time_in_day ──
    // Fast: uses arithmetic offset instead of Intl per-salvo.
    // Builds a 24-slot hourly histogram of all salvos on active days in the lookback,
    // compares the current hour's historical share to the overall average share,
    // and also checks whether today's activity in this hour is above/below that hour's baseline.
    (function () {
        const LOOKBACK_DAYS = 14;
        const cutoffSec = nowSec - LOOKBACK_DAYS * 86400;
        const offsetSec = getIsraelOffsetSec(nowSec);
        const currentHour = fastIsraelHour(nowSec, offsetSec);
        const todayDayIdx = fastIsraelDayIndex(nowSec, offsetSec);

        // Hourly counts: index 0-23.  Also track per-day to count active days.
        const hourlyCounts = new Float64Array(24);    // total salvos in each hour across lookback
        const hourlyActiveDays = new Float64Array(24); // how many distinct days had ≥1 salvo in that hour
        // We need to track which days contributed to each hour
        // Use a Set per hour — but 24 sets is fine, the expensive part was Intl calls
        const daysSeen = Array.from({ length: 24 }, () => new Set());
        let todayThisHourCount = 0;

        for (let i = salvos.length - 1; i >= 0; i--) {
            const ts = salvos[i].timestamp;
            if (ts > nowSec) continue;
            if (ts < cutoffSec) break; // salvos assumed sorted ascending; once we pass cutoff, done
            const h = fastIsraelHour(ts, offsetSec);
            const dayIdx = fastIsraelDayIndex(ts, offsetSec);
            hourlyCounts[h]++;
            daysSeen[h].add(dayIdx);
            if (dayIdx === todayDayIdx && h === currentHour) {
                todayThisHourCount++;
            }
        }

        // If salvos aren't sorted descending (they're ascending), we need to iterate forward from cutoff.
        // Let's handle both: if we got 0 results going backward, scan forward.
        // Actually, salvos are typically sorted ascending, so the break above would fire immediately.
        // Let's just scan forward instead:
        if (hourlyCounts.reduce((a, b) => a + b, 0) === 0) {
            todayThisHourCount = 0;
            for (let i = 0; i < salvos.length; i++) {
                const ts = salvos[i].timestamp;
                if (ts > nowSec) break;
                if (ts < cutoffSec) continue;
                const h = fastIsraelHour(ts, offsetSec);
                const dayIdx = fastIsraelDayIndex(ts, offsetSec);
                hourlyCounts[h]++;
                daysSeen[h].add(dayIdx);
                if (dayIdx === todayDayIdx && h === currentHour) {
                    todayThisHourCount++;
                }
            }
        }

        for (let h = 0; h < 24; h++) {
            hourlyActiveDays[h] = daysSeen[h].size;
        }

        // Total salvos across all hours in the lookback
        let totalSalvos = 0;
        let totalActiveDays = 0;
        const allActiveDays = new Set();
        for (let h = 0; h < 24; h++) {
            totalSalvos += hourlyCounts[h];
            for (const d of daysSeen[h]) allActiveDays.add(d);
        }
        totalActiveDays = allActiveDays.size;

        if (totalSalvos === 0 && todayThisHourCount === 0) return;

        // Average salvos per active day per hour: hourlyCounts[h] / totalActiveDays
        // Overall average per hour across all 24 hours: totalSalvos / (totalActiveDays * 24)
        const activeDays = Math.max(totalActiveDays, 1);

        // How many salvos does this hour get on an average active day?
        const thisHourAvgPerDay = hourlyCounts[currentHour] / activeDays;
        // What's the overall average per hour per active day?
        const overallAvgPerHourPerDay = totalSalvos / (activeDays * 24);

        // Historical hotness: how much busier is this hour than the average hour?
        // ratio > 1 means this hour is historically busier than average
        const baselinePerHour = Math.max(overallAvgPerHourPerDay, 0.01);
        const historicalRatio = thisHourAvgPerDay / baselinePerHour;

        // Current activity: how does today's count in this hour compare to this hour's daily average?
        const thisHourBaseline = Math.max(thisHourAvgPerDay, 0.1);
        const todayRatio = todayThisHourCount / thisHourBaseline;

        // Combine: historical hotness (is this hour generally dangerous?) + today's pace in this hour
        // historicalRatio ~1 means average hour, >1 means hot hour, <1 means quiet hour
        // todayRatio ~1 means on pace, >1 means busier, <1 means quieter
        //
        // Map to risk:
        //   - If this hour is historically quiet AND today is quiet in it: low risk
        //   - If this hour is historically hot AND today is on/above pace: high risk
        //   - Mixed signals: moderate
        //
        // historicalComponent: sigmoid-ish mapping of historicalRatio
        const historicalComponent = clamp01(1 - 1 / (1 + historicalRatio * 0.8));
        // todayComponent:
        const todayComponent = clamp01(1 - 1 / (1 + todayRatio * 0.6));

        // Blend: historical pattern matters more (60%) since today might just be starting
        const standaloneRisk = clamp01(historicalComponent * 0.6 + todayComponent * 0.4);

        // Build explanation
        const hourStr = `${currentHour.toString().padStart(2, '0')}:00`;
        const thisHourAvgStr = thisHourAvgPerDay.toFixed(1);
        const overallAvgStr = overallAvgPerHourPerDay.toFixed(1);
        const historicalPct = (historicalRatio * 100).toFixed(0);

        let qualifierEn, qualifierHe;
        if (historicalRatio > 1.5) {
            if (todayRatio >= 1.0) {
                qualifierEn = `The ${hourStr} hour is historically one of the busier windows (${historicalPct}% of the hourly average), and today's activity in this hour (${todayThisHourCount}) is at or above the typical rate (${thisHourAvgStr}/day).`;
                qualifierHe = `השעה ${hourStr} היא היסטורית מהחלונות העמוסים יותר (${historicalPct}% מהממוצע השעתי), והפעילות היום בשעה זו (${todayThisHourCount}) בקצב הטיפוסי או מעליו (${thisHourAvgStr}/יום).`;
            } else {
                qualifierEn = `The ${hourStr} hour is historically busy (${historicalPct}% of the hourly average, ~${thisHourAvgStr}/day), but today is quieter so far (${todayThisHourCount}).`;
                qualifierHe = `השעה ${hourStr} היסטורית עמוסה (${historicalPct}% מהממוצע השעתי, ~${thisHourAvgStr}/יום), אך היום שקט יותר עד כה (${todayThisHourCount}).`;
            }
        } else if (historicalRatio < 0.5) {
            qualifierEn = `The ${hourStr} hour is historically one of the quieter windows (${historicalPct}% of the hourly average, ~${thisHourAvgStr}/day). Today: ${todayThisHourCount} so far.`;
            qualifierHe = `השעה ${hourStr} היא היסטורית מהחלונות השקטים יותר (${historicalPct}% מהממוצע השעתי, ~${thisHourAvgStr}/יום). היום: ${todayThisHourCount} עד כה.`;
        } else {
            qualifierEn = `The ${hourStr} hour has roughly average historical activity (${historicalPct}% of the hourly average, ~${thisHourAvgStr}/day). Today: ${todayThisHourCount} in this hour.`;
            qualifierHe = `לשעה ${hourStr} פעילות היסטורית ממוצעת בערך (${historicalPct}% מהממוצע השעתי, ~${thisHourAvgStr}/יום). היום: ${todayThisHourCount} בשעה זו.`;
        }

        addReason(
            'time_in_day',
            { en: 'Time-of-day vs history', he: 'שעה ביום מול היסטוריה' },
            standaloneRisk,
            {
                en: `${qualifierEn} Overall hourly average across active days: ~${overallAvgStr}/hour.`,
                he: `${qualifierHe} ממוצע שעתי כללי בימים פעילים: ~${overallAvgStr}/שעה.`,
            },
        );
    })();

    // ── avg_gap_proximity ──
    (function () {
        if (gaps.length < 2) return;
        const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const lastTs = salvos[salvos.length - 1].timestamp;
        const elapsed = (nowSec - lastTs) / 60;
        const ratio = elapsed / avgGap;
        const standaloneRisk = clamp01(ratio * 0.5);
        const pct = (ratio * 100).toFixed(0);
        const avgStr = avgGap.toFixed(0);
        const elapsedStr = elapsed.toFixed(0);
        let qualifierEn, qualifierHe;
        if (ratio < 0.5) {
            qualifierEn = 'well below the average gap — still early in the typical cycle';
            qualifierHe = 'הרבה מתחת למרווח הממוצע — עדיין מוקדם במחזור הטיפוסי';
        } else if (ratio < 0.9) {
            qualifierEn = 'approaching the average gap';
            qualifierHe = 'מתקרב למרווח הממוצע';
        } else if (ratio < 1.2) {
            qualifierEn = 'around the average gap — historically this is when the next alert tends to arrive';
            qualifierHe = 'בסביבת המרווח הממוצע — היסטורית זה הזמן שבו ההתרעה הבאה נוטה להגיע';
        } else {
            qualifierEn = 'past the average gap — overdue compared to historical pattern';
            qualifierHe = 'מעבר למרווח הממוצע — באיחור בהשוואה לתבנית ההיסטורית';
        }
        addReason(
            'avg_gap_proximity',
            { en: 'Alert gap proximity', he: 'קרבה למרווח התרעות' },
            standaloneRisk,
            {
                en: `${elapsedStr} minutes elapsed since the last alert; the average gap is ${avgStr} minutes (${pct}% through). ${qualifierEn}.`,
                he: `${elapsedStr} דקות חלפו מאז ההתרעה האחרונה; המרווח הממוצע הוא ${avgStr} דקות (${pct}% מהמחזור). ${qualifierHe}.`,
            },
        );
    })();

    // ── weibull_hazard ──
    (function () {
        if (gaps.length < 3) return;
        const lastTs = salvos[salvos.length - 1].timestamp;
        const elapsed = Math.max(0.1, (nowSec - lastTs) / 60);
        const sorted = [...gaps].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const earlyShape = 0.4;
        const earlyScale = median * 0.1;
        const lateShape = 3.0;
        const lateScale = median * 1.1;
        const weibullHazard = (t, k, lam) => (k / lam) * Math.pow(t / lam, k - 1);
        const earlyH = weibullHazard(elapsed, earlyShape, earlyScale);
        const lateH = weibullHazard(elapsed, lateShape, lateScale);
        const combinedH = earlyH + lateH;
        const standaloneRisk = clamp01(1 - Math.exp(-combinedH * 0.3));
        let descEn, descHe;
        if (elapsed < median * 0.2) {
            descEn = 'Very shortly after last alert — rapid follow-up salvos are common, elevating short-term hazard.';
            descHe = 'זמן קצר מאוד אחרי ההתרעה האחרונה — מטחים עוקבים מהירים נפוצים, מה שמעלה את הסכנה לטווח קצר.';
        } else if (elapsed < median * 0.7) {
            descEn = 'In the calm mid-period between salvos — historically the lowest-risk phase of the cycle.';
            descHe = 'בתקופת השקט שבין מטחים — היסטורית זהו השלב בעל הסיכון הנמוך ביותר במחזור.';
        } else if (elapsed < median * 1.2) {
            descEn = 'Approaching the typical inter-salvo interval — hazard is climbing as the next event becomes statistically due.';
            descHe = 'מתקרב למרווח הטיפוסי בין מטחים — הסכנה עולה ככל שהאירוע הבא הופך סטטיסטית צפוי.';
        } else {
            descEn = 'Well past the typical interval — extended quiet increases the statistical likelihood of an imminent salvo.';
            descHe = 'הרבה מעבר למרווח הטיפוסי — שקט ממושך מגדיל את ההסתברות הסטטיסטית למטח קרוב.';
        }
        addReason(
            'weibull_hazard',
            { en: 'Failure-rate hazard model', he: 'מודל קצב כשל סטטיסטי' },
            standaloneRisk,
            { en: descEn, he: descHe },
        );
    })();

    // ── normalize & combine ──
    let totalWeight = reasonings.reduce((s, r) => s + r.weight, 0);
    if (totalWeight <= 0) {
        const equal = 1 / (reasonings.length || 1);
        reasonings.forEach(r => { r.weight = equal; r.contribution = equal * r.risk; });
    } else {
        reasonings.forEach(r => { r.weight = r.weight / totalWeight; r.contribution = r.weight * r.risk; });
    }
    const combinedRisk = clamp01(reasonings.reduce((s, r) => s + r.contribution, 0));
    return { risk: combinedRisk, reasonings };
}

function formatResult(pred, salvos, durationMin, nowSec) {
    const roundGaps = extractRoundGaps(salvos);
    const ensemble = applyReasoningEnsemble(pred, salvos, durationMin, nowSec, undefined, roundGaps);
    return {
        risk: ensemble.risk,
        level: getLevel(ensemble.risk),
        minutesSinceLastAlert: pred.minutesSinceLastAlert,
        lastAlertTime: pred.lastAlertTime,
        lastAlertLocations: pred.lastAlertLocations,
        salvoCount: pred.salvoCount,
        gapStats: pred.gapStats,
        trend: computeTrend(roundGaps.slice(-20)),
        expectedNextAlert: pred.expectedWait,
        avgGapLast10Minutes: pred.avgGapLast10Minutes,
        modelType: 'hunger+heuristics',
        hungerInfo: pred.hungerInfo,
        reasonings: ensemble.reasonings,
    };
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

module.exports = {
    DEFAULT_WEIGHTS,
    clamp01, getLevel, computeTrend, getIsraelClock, getIsraelDayKey,
    avg24hSalvosIgnoringQuietDays, applyReasoningEnsemble,
    formatResult, emptyResponse,
};