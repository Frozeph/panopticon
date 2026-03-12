/**
 * PANOPTICON // Backend Proxy Server v2
 * - Shodan API proxy with credit tracking
 * - SQLite time-series storage for 7-day playback
 * - Flight data with airline enrichment
 * - All external API proxies (CORS bypass)
 */

'use strict';

const express = require('express');
const https   = require('https');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── DATABASE ─────────────────────────────────────────────────────────────────
let db = null;
try {
  const Database = require('better-sqlite3');
  db = new Database(path.join(DATA_DIR, 'panopticon.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -32000');
  db.pragma('temp_store = MEMORY');
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     INTEGER NOT NULL,
      layer  TEXT NOT NULL,
      data   TEXT NOT NULL,
      cnt    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_snap ON snapshots(layer, ts);

    CREATE TABLE IF NOT EXISTS shodan_log (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,
      query    TEXT NOT NULL,
      results  INTEGER NOT NULL DEFAULT 0,
      credits  INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS shodan_cache (
      key  TEXT PRIMARY KEY,
      ts   INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  console.log('[DB] SQLite ready');

  // Prune old data every 5 minutes
  setInterval(() => {
    const cutoff = Date.now() - 7 * 86400000;
    const r = db.prepare('DELETE FROM snapshots WHERE ts < ?').run(cutoff);
    if (r.changes) console.log(`[DB] Pruned ${r.changes} old snapshots`);
    db.prepare('DELETE FROM shodan_cache WHERE ts < ?').run(Date.now() - 3600000);
  }, 300000);

} catch (e) {
  console.warn('[DB] SQLite unavailable:', e.message);
}

// ─── HTTP FETCH HELPER ────────────────────────────────────────────────────────
function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'PanopticonDashboard/2.0', 'Accept': '*/*', ...opts.headers },
      timeout: 15000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── SNAPSHOT STORAGE ────────────────────────────────────────────────────────
// Compact representation: only essential fields, integers where possible
function saveSnapshot(layer, rawData) {
  if (!db) return;
  try {
    let rows;
    if (layer === 'flights' || layer === 'military') {
      // [icao,callsign,lat*1e4,lon*1e4,alt,spd,trk,country]
      rows = (rawData.states || [])
        .filter(s => s && s[5] != null && s[6] != null)
        .map(s => [
          (s[0] || '').slice(0, 6),
          (s[1] || '').trim().slice(0, 8),
          Math.round(+s[6] * 1e4),
          Math.round(+s[5] * 1e4),
          Math.round(+(s[13] || s[7] || 0)),
          Math.round(+(s[9] || 0)),
          Math.round(+(s[10] || 0)),
          (s[2] || '').slice(0, 2),
        ]);
    } else if (layer === 'quakes') {
      rows = (rawData.features || []).map(f => [
        f.id, f.properties.mag || 0,
        Math.round(f.geometry.coordinates[0] * 1e4),
        Math.round(f.geometry.coordinates[1] * 1e4),
        f.properties.place || '', f.properties.time || 0,
      ]);
    } else return;

    db.prepare('INSERT INTO snapshots(ts,layer,data,cnt) VALUES(?,?,?,?)')
      .run(Date.now(), layer, JSON.stringify(rows), rows.length);
  } catch (e) { console.error('[DB] saveSnapshot:', e.message); }
}

// ─── PLAYBACK API ─────────────────────────────────────────────────────────────
app.get('/api/playback/range', (req, res) => {
  if (!db) return res.json({ available: false });
  const r = db.prepare('SELECT MIN(ts) as a, MAX(ts) as b, GROUP_CONCAT(DISTINCT layer) as layers FROM snapshots').get();
  res.json({ available: true, earliest: r.a, latest: r.b, layers: r.layers ? r.layers.split(',') : [] });
});

app.get('/api/playback/timeline', (req, res) => {
  if (!db) return res.json({ timestamps: [] });
  const layer = req.query.layer || 'flights';
  const from  = parseInt(req.query.from) || (Date.now() - 7*86400000);
  const to    = parseInt(req.query.to)   || Date.now();
  const rows = db.prepare('SELECT ts, cnt FROM snapshots WHERE layer=? AND ts BETWEEN ? AND ? ORDER BY ts ASC').all(layer, from, to);
  // Downsample to ≤1000 points
  const step = Math.max(1, Math.floor(rows.length / 1000));
  res.json({ layer, points: rows.filter((_,i) => i%step===0).map(r => [r.ts, r.cnt]) });
});

app.get('/api/playback/frame', (req, res) => {
  if (!db) return res.json({ data: [] });
  const { layer, ts } = req.query;
  if (!layer || !ts) return res.status(400).json({ error: 'layer and ts required' });
  const row = db.prepare('SELECT ts,data,cnt FROM snapshots WHERE layer=? ORDER BY ABS(ts-?) LIMIT 1').get(layer, parseInt(ts));
  if (!row) return res.json({ ts: +ts, layer, data: [], cnt: 0 });

  // Re-expand compact format back to a structure the frontend understands
  let data = JSON.parse(row.data);
  if (layer === 'flights' || layer === 'military') {
    // Expand back to OpenSky-like states array
    data = data.map(r => [
      r[0], r[1] + '  ', 'XX', row.ts/1000, row.ts/1000,
      r[3]/1e4, r[2]/1e4, r[4], false, r[5], r[6], null, null, r[4], null, false, 0, null
    ]);
    data = { states: data };
  } else if (layer === 'quakes') {
    data = { features: data.map(r => ({
      id: r[0], properties: { mag: r[1], place: r[4], time: r[5] },
      geometry: { coordinates: [r[2]/1e4, r[3]/1e4, 0] }
    }))};
  }
  res.json({ ts: row.ts, layer, data, cnt: row.cnt });
});

app.get('/api/storage/stats', (req, res) => {
  if (!db) return res.json({ available: false });
  const layers = db.prepare('SELECT layer, COUNT(*) as frames, MIN(ts) as earliest, MAX(ts) as latest, SUM(LENGTH(data)) as bytes FROM snapshots GROUP BY layer').all();
  const dbFile = path.join(DATA_DIR, 'panopticon.db');
  res.json({ available: true, layers, db_bytes: fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0 });
});

// ─── SHODAN ───────────────────────────────────────────────────────────────────
const SHODAN_PRESETS = [
  { label: 'IP Cameras',          query: 'has_screenshot:true product:webcam' },
  { label: 'Industrial Control',  query: 'tag:ics country:GB' },
  { label: 'Open MongoDB',        query: 'product:MongoDB port:27017' },
  { label: 'Exposed RDP',         query: 'port:3389 os:Windows' },
  { label: 'VNC No Auth',         query: 'authentication disabled port:5900' },
  { label: 'SCADA / S7',          query: 'port:102 product:S7' },
  { label: 'Solar Inverters',     query: 'SolarEdge tag:iot' },
  { label: 'Aviation ADS-B',      query: 'port:30003 "dump1090"' },
  { label: 'Traffic Cameras',     query: '"Network Camera" port:8080' },
  { label: 'Open Elasticsearch',  query: 'product:Elastic port:9200' },
];

app.get('/api/shodan/presets', (req, res) => res.json({ presets: SHODAN_PRESETS }));

app.get('/api/shodan/credits', async (req, res) => {
  const key = req.headers['x-shodan-key'] || process.env.SHODAN_API_KEY || '';
  const out = { configured: !!key };

  if (db) {
    out.local = {
      last_24h: db.prepare('SELECT COUNT(*) as q, SUM(credits) as c FROM shodan_log WHERE ts > ?').get(Date.now()-86400000),
      last_7d:  db.prepare('SELECT COUNT(*) as q, SUM(credits) as c FROM shodan_log WHERE ts > ?').get(Date.now()-7*86400000),
      history:  db.prepare('SELECT ts,query,results,credits FROM shodan_log ORDER BY ts DESC LIMIT 20').all(),
    };
  }

  if (key) {
    try {
      const r = await fetchUrl(`https://api.shodan.io/api-info?key=${key}`);
      if (r.status === 200) out.account = JSON.parse(r.data);
    } catch {}
  }
  res.json(out);
});

app.post('/api/shodan/search', async (req, res) => {
  const key = req.headers['x-shodan-key'] || process.env.SHODAN_API_KEY || '';
  if (!key) return res.status(401).json({ error: 'No Shodan API key. Set SHODAN_API_KEY env var or pass x-shodan-key header.' });

  const { query, page = 1 } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  // Cache check
  const cacheKey = `${query}:${page}`;
  if (db) {
    const c = db.prepare('SELECT data FROM shodan_cache WHERE key=? AND ts>?').get(cacheKey, Date.now()-3600000);
    if (c) return res.json({ ...JSON.parse(c.data), cached: true, cache_age_s: Math.round((Date.now() - c.ts)/1000) });
  }

  try {
    const url = `https://api.shodan.io/shodan/host/search?key=${key}&query=${encodeURIComponent(query)}&page=${page}&minify=true`;
    const r = await fetchUrl(url);
    if (r.status === 401) return res.status(401).json({ error: 'Invalid Shodan API key' });
    if (r.status === 402) return res.status(402).json({ error: 'Query credits exhausted' });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);

    const raw = JSON.parse(r.data);

    // Map to display format
    const devices = (raw.matches || [])
      .filter(d => d.location?.latitude && d.location?.longitude)
      .map(d => ({
        ip: d.ip_str,
        port: d.port,
        transport: d.transport || 'tcp',
        lat: d.location.latitude,
        lon: d.location.longitude,
        country: d.location.country_code || '',
        city: d.location.city || '',
        org: d.org || d.isp || '',
        product: d.product || '',
        version: d.version || '',
        os: d.os || '',
        tags: d.tags || [],
        vulns: d.vulns ? Object.keys(d.vulns) : [],
        ts: d.timestamp,
        link: `https://www.shodan.io/host/${d.ip_str}`,
        snippet: (d.data || '').substring(0, 150).replace(/\n/g, ' '),
        hostnames: (d.hostnames || []).slice(0, 3),
      }));

    const payload = { total: raw.total, page: +page, results: devices, query, cached: false };

    if (db) {
      db.prepare('INSERT INTO shodan_log(ts,query,results,credits) VALUES(?,?,?,1)').run(Date.now(), query, raw.total || 0);
      db.prepare('INSERT OR REPLACE INTO shodan_cache(key,ts,data) VALUES(?,?,?)').run(cacheKey, Date.now(), JSON.stringify(payload));
    }

    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/shodan/host/:ip', async (req, res) => {
  const key = req.headers['x-shodan-key'] || process.env.SHODAN_API_KEY || '';
  if (!key) return res.status(401).json({ error: 'No API key' });
  try {
    const r = await fetchUrl(`https://api.shodan.io/shodan/host/${req.params.ip}?key=${key}`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    res.json(JSON.parse(r.data));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FLIGHTS ─────────────────────────────────────────────────────────────────
let flightCache = { data: null, ts: 0 };

app.get('/api/flights/opensky', async (req, res) => {
  if (flightCache.data && Date.now() - flightCache.ts < 15000) return res.json(flightCache.data);
  try {
    const r = await fetchUrl('https://opensky-network.org/api/states/all');
    if (r.status !== 200) throw new Error();
    const data = JSON.parse(r.data);
    flightCache = { data, ts: Date.now() };
    saveSnapshot('flights', data);
    res.set('Cache-Control', 'max-age=15');
    res.json(data);
  } catch {
    res.status(503).json({ states: [] });
  }
});

app.get('/api/flights/military', async (req, res) => {
  try {
    const r = await fetchUrl('https://opensky-network.org/api/states/all?extended=1');
    if (r.status !== 200) throw new Error();
    const data = JSON.parse(r.data);
    const mil = /^(USAF|NAVY|RCH|REACH|SAM|PAT|DUKE|TUSK|HUNT|ROCKY|VALOR|GHOST|BLADE|ATLAS|IRON|HAWK|EAGLE|RAVEN|COBRA|VIPER|TIGER|SHARK)/i;
    const states = (data.states||[]).filter(s => s && mil.test((s[1]||'').trim())).slice(0,100);
    saveSnapshot('military', { states });
    res.json({ states });
  } catch {
    res.json({ states: [] });
  }
});

// Airline lookup
const AIRLINES = {
  BAW:{name:'British Airways',color:'#1B1464'},UAL:{name:'United Airlines',color:'#005DAA'},
  AAL:{name:'American Airlines',color:'#CC0000'},DAL:{name:'Delta Air Lines',color:'#E01933'},
  SWA:{name:'Southwest',color:'#304CB2'},DLH:{name:'Lufthansa',color:'#05164D'},
  AFR:{name:'Air France',color:'#002157'},KLM:{name:'KLM',color:'#00A1DE'},
  EZY:{name:'easyJet',color:'#FF6600'},RYR:{name:'Ryanair',color:'#073590'},
  UAE:{name:'Emirates',color:'#C60C30'},SIA:{name:'Singapore Air',color:'#003366'},
  CPA:{name:'Cathay Pacific',color:'#006564'},QFA:{name:'Qantas',color:'#E40000'},
  JAL:{name:'Japan Airlines',color:'#CC0000'},ANA:{name:'ANA',color:'#003087'},
  CSN:{name:'China Southern',color:'#005BAC'},CCA:{name:'Air China',color:'#CC0000'},
  THY:{name:'Turkish Airlines',color:'#CC0000'},VIR:{name:'Virgin Atlantic',color:'#CC0000'},
  EIN:{name:'Aer Lingus',color:'#00B140'},IBE:{name:'Iberia',color:'#CC0000'},
  AZA:{name:'Alitalia',color:'#009246'},TAP:{name:'TAP Air Portugal',color:'#007A33'},
};

app.post('/api/flights/airlines', (req, res) => {
  const result = {};
  for (const cs of (req.body.callsigns || []).slice(0, 500)) {
    const p = cs.trim().toUpperCase().slice(0, 3);
    result[cs] = AIRLINES[p] || null;
  }
  res.json(result);
});

// ─── EARTHQUAKES ─────────────────────────────────────────────────────────────
app.get('/api/quakes', async (req, res) => {
  try {
    const r = await fetchUrl('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson');
    if (r.status !== 200) throw new Error();
    const data = JSON.parse(r.data);
    saveSnapshot('quakes', data);
    res.set('Cache-Control', 'max-age=300');
    res.json(data);
  } catch { res.status(503).json({ features: [] }); }
});

// ─── OSM ─────────────────────────────────────────────────────────────────────
app.get('/api/osm/roads', async (req, res) => {
  const lat = parseFloat(req.query.lat)||51.5, lon = parseFloat(req.query.lon)||-0.12;
  const radius = Math.min(parseInt(req.query.radius)||3000, 8000);
  const q = `[out:json][timeout:25];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential)$"](around:${radius},${lat},${lon}););out geom qt;`;
  try {
    const r = await fetchUrl(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`);
    if (r.status !== 200) throw new Error();
    res.set('Cache-Control', 'max-age=600');
    res.send(r.data);
  } catch { res.status(503).json({ elements: [] }); }
});

// ─── TLE ─────────────────────────────────────────────────────────────────────
app.get('/api/tle/:group', async (req, res) => {
  const group = req.params.group.replace(/[^a-z0-9-]/gi, '');
  try {
    const r = await fetchUrl(`https://celestrak.org/TLE/query.php?GROUP=${group}&FORMAT=tle`);
    res.set('Content-Type', 'text/plain').set('Cache-Control', 'max-age=120');
    res.send(r.status === 200 ? r.data : '');
  } catch { res.status(503).send(''); }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  let dbInfo = { ok: false };
  if (db) try { dbInfo = { ok: true, snapshots: db.prepare('SELECT COUNT(*) as n FROM snapshots').get().n }; } catch {}
  res.json({ status: 'ok', ts: new Date().toISOString(), db: dbInfo, shodan_configured: !!(process.env.SHODAN_API_KEY) });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════╗
║  PANOPTICON // INTELLIGENCE SYSTEM v2        ║
║  http://localhost:${PORT}                        ║
║  DB:     ${db ? 'SQLite (WAL)               ' : 'disabled                     '}║
║  Shodan: ${process.env.SHODAN_API_KEY ? 'CONFIGURED                  ' : 'set SHODAN_API_KEY env var   '}║
╚══════════════════════════════════════════════╝`);
});
