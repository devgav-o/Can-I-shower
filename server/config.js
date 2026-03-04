const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const API_BASE = 'https://agg.rocketalert.live/api/v1/alerts/details';
const REALTIME_URL = 'https://agg.rocketalert.live/api/v2/alerts/real-time/cached';
const FETCH_INTERVAL_MS = 30 * 1000;
const HISTORY_DAYS = 90;
const HTTP_TIMEOUT_MS = 25000;
const VIEWER_TTL_MS = 60 * 1000;
const GIT_ALERTS_REPO = 'https://github.com/dleshem/israel-alerts-data.git';
const GIT_ALERTS_DIR = '/tmp/israel-alerts-data';
const GIT_ALERTS_CSV = '/tmp/israel-alerts-data/israel-alerts.csv';

module.exports = { PORT, API_BASE, REALTIME_URL, FETCH_INTERVAL_MS, HISTORY_DAYS, HTTP_TIMEOUT_MS, VIEWER_TTL_MS, GIT_ALERTS_REPO, GIT_ALERTS_DIR, GIT_ALERTS_CSV };
