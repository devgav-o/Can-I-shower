const path = require('path');
const { PORT, FETCH_INTERVAL_MS, HISTORY_DAYS } = require('./config');
const { fetchHistorical, fetchRecent } = require('./services/alertFetcher');
const { handlePredict, handleDailyRisk } = require('./routes/predict');
const { handleLocations, handleNearestLocation } = require('./routes/locations');
const { handleAnalyticsPing } = require('./routes/analytics');
const { handleWeightsGet, handleWeightsPost } = require('./routes/weights');
const { handleStatus } = require('./routes/status');

const PUBLIC_DIR = path.join(__dirname, '../public');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

async function serveStatic(pathname) {
    const filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) return new Response('Not Found', { status: 404 });
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
        const fallback = Bun.file(path.join(PUBLIC_DIR, 'index.html'));
        return (await fallback.exists()) ? new Response(fallback, { headers: CORS_HEADERS }) : new Response('Not Found', { status: 404 });
    }
    return new Response(file, { headers: CORS_HEADERS });
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

async function handleRequest(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    const url = new URL(req.url);
    const { pathname, searchParams } = url;

    if (pathname === '/api/predict' && req.method === 'GET') return json(handlePredict(searchParams));
    if (pathname === '/api/predict/daily-risk' && req.method === 'GET') return json(handleDailyRisk(searchParams));
    if (pathname === '/api/locations' && req.method === 'GET') return json(handleLocations());
    if ((pathname === '/api/locations/nearest' || pathname === '/api/nearest-location') && req.method === 'GET') {
        const result = handleNearestLocation(searchParams);
        return json(result.data, result.status);
    }
    if (pathname === '/api/analytics/ping' && req.method === 'GET') return json(handleAnalyticsPing(searchParams));
    if (pathname === '/api/weights' && req.method === 'GET') return json(handleWeightsGet());
    if (pathname === '/api/weights' && req.method === 'POST') {
        const body = await req.json().catch(() => null);
        const result = handleWeightsPost(body);
        return json(result.data, result.status);
    }
    if (pathname === '/api/status' && req.method === 'GET') return json(handleStatus());

    return serveStatic(pathname);
}

const server = Bun.serve({
    port: PORT,
    async fetch(req) {
        try {
            return await handleRequest(req);
        } catch (e) {
            console.error(`${req.method} ${new URL(req.url).pathname} error:`, e.message);
            return json({ error: 'internal_error' }, 500);
        }
    },
    error() {
        return new Response(JSON.stringify({ error: 'internal_error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    },
});

console.log(`Server starting on port ${server.port}...`);
fetchHistorical(HISTORY_DAYS).then(() => {
    console.log('Ready — hunger model');
    setInterval(() => fetchRecent().catch(() => {}), FETCH_INTERVAL_MS);
}).catch(e => {
    console.error('Boot failed:', e.message);
    setInterval(() => fetchRecent().catch(() => {}), FETCH_INTERVAL_MS);
});
