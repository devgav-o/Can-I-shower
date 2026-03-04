import { ref, computed } from 'vue';

const translations = {
    he: {
        title: 'אפשר להתקלח?',
        subtitle: 'הערכת סיכון בזמן אמת',
        connected: 'מחובר',
        disconnected: 'לא מחובר',
        duration: 'משך המקלחת',
        min: 'דק׳',
        custom: 'אחר',
        locations: 'יישובים',
        locPlaceholder: 'חפשו יישוב...',
        timeSince: 'זמן מהאזעקה האחרונה',
        avgGapLast10: 'ממוצע רווח התרעות האחרונות',
        alertCount: 'מספר אזעקות',
        trend: 'מגמה',
        trendUp: 'עולה',
        trendDown: 'יורדת',
        trendStable: 'יציבה',
        riskLow: 'סיכון נמוך',
        riskMed: 'סיכון בינוני',
        riskHigh: 'סיכון גבוה',
        recLow: 'יחסית בטוח — תתקלחו מהר',
        recMed: 'סיכון בינוני — היו מוכנים לעצור',
        recHigh: 'סיכון גבוה — לא מומלץ כרגע',
        disclaimer: 'המידע מבוסס על ניתוח סטטיסטי של נתוני אזעקות היסטוריים. אין לראות במידע זה תחליף להנחיות פיקוד העורף.',
        source: 'מקור נתונים: ',
        lastUpdate: 'עודכן לאחרונה',
        loading: 'טוען...',
        noData: 'אין מספיק נתונים להערכת סיכון',
        now: 'עכשיו',
        lessThanMin: 'פחות מדקה',
        minutes: 'דקות',
        hours: 'שעות',
        and: 'ו-',
        days: 'ימים',
        viewersYouAndOne: 'אתם ועוד מישהו אחד מתלבטים אם להירטב.',
        viewersYouAndFew: 'אתם ועוד {n} אנשים על הגדר בין מגבת למים.',
        viewersYouAndMany: '{n} אנשים נוספים מנסים לתפוס מקלחת בזמן הנכון.',
        locCta: 'שפרו את הדיוק על ידי בחירת יישוב',
        howCalc: 'איך זה מחושב?',
        weightLabel: 'משקל התנאי:',
        localRiskLabel: 'הערכת מודול:',
        resultedLabel: 'תרומה לסיכון:',
        crowdHint: 'התאימו את המשקלים לפי ההעדפה שלכם',
        dailyGraphTitle: 'מתי הכי בטוח להתקלח היום?',
        dailyGraphSubtitle: 'סיכון לפי שעה ביום',
        bestTimeLabel: 'הזמן הטוב ביותר',
        currentTimeLabel: 'עכשיו',
    },
    en: {
        title: 'Can I Shower?',
        subtitle: 'Real-time risk assessment',
        connected: 'Connected',
        disconnected: 'Disconnected',
        duration: 'Shower duration',
        min: 'min',
        custom: 'Other',
        locations: 'Locations',
        locPlaceholder: 'Search location...',
        timeSince: 'Time since last alert',
        avgGapLast10: 'Recent alerts average gap',
        alertCount: 'Alert count',
        trend: 'Trend',
        trendUp: 'Increasing',
        trendDown: 'Decreasing',
        trendStable: 'Stable',
        riskLow: 'Low risk',
        riskMed: 'Moderate risk',
        riskHigh: 'High risk',
        recLow: 'Relatively safe — shower quickly',
        recMed: 'Moderate risk — be ready to stop',
        recHigh: 'High risk — not recommended right now',
        disclaimer: 'This information is based on statistical analysis of historical alert data. It is not a substitute for official Home Front Command guidelines.',
        source: 'Data source: ',
        lastUpdate: 'Last updated',
        loading: 'Loading...',
        noData: 'Insufficient data for risk estimate',
        now: 'Now',
        lessThanMin: 'Less than a minute',
        minutes: 'minutes',
        hours: 'hours',
        and: 'and ',
        days: 'days',
        viewersYouAndOne: "It's you and one more person wondering if now is shower o'clock.",
        viewersYouAndFew: 'You and {n} others are hovering between towel and hot water.',
        viewersYouAndMany: '{n} more people are trying to catch the perfect shower window.',
        locCta: 'Improve accuracy by choosing your location',
        howCalc: "How it's calculated",
        weightLabel: 'Condition Weight:',
        localRiskLabel: 'Module risk:',
        resultedLabel: 'Resulted Contrib:',
        crowdHint: 'Adjust weights to your preference',
        dailyGraphTitle: "When is the safest time to shower today?",
        dailyGraphSubtitle: 'Risk by time of day',
        bestTimeLabel: 'Best time',
        currentTimeLabel: 'Now',
    },
};

const lang = ref(localStorage.getItem('lang') || 'he');
document.documentElement.lang = lang.value;
document.documentElement.dir = lang.value === 'he' ? 'rtl' : 'ltr';
document.title = translations[lang.value].title;

export function useTranslations() {
    const t = computed(() => translations[lang.value]);

    function setLang(l) {
        lang.value = l;
        document.documentElement.lang = l;
        document.documentElement.dir = l === 'he' ? 'rtl' : 'ltr';
        document.title = translations[l].title;
        localStorage.setItem('lang', l);
    }

    return { lang, t, setLang };
}
