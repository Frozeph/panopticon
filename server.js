/**
 * ARGUS // Backend Proxy Server v2
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
  db = new Database(path.join(DATA_DIR, 'argus.db'));
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
  const dbFile = path.join(DATA_DIR, 'argus.db');
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
  if (flightCache.data && Date.now() - flightCache.ts < 8000) return res.json(flightCache.data);
  try {
    const r = await fetchUrl('https://opensky-network.org/api/states/all');
    if (r.status !== 200) throw new Error();
    const data = JSON.parse(r.data);
    flightCache = { data, ts: Date.now() };
    saveSnapshot('flights', data);
    res.set('Cache-Control', 'max-age=8');
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

// ─── NEW ROUTES INJECTED ──

// ─── GPS JAMMING: gpsjam.org ──────────────────────────────────────────────────
let gpsjamCache = { data: null, ts: 0 };
app.get('/api/gpsjam', async (req, res) => {
  if (gpsjamCache.data && Date.now() - gpsjamCache.ts < 300000) return res.json(gpsjamCache.data);
  // gpsjam.org provides daily CSV data of GPS interference reports
  const date = new Date(); date.setDate(date.getDate() - 1); // yesterday (today may not be ready)
  const dateStr = date.toISOString().slice(0,10);
  try {
    const r = await fetchUrl(`https://gpsjam.org/geo.json?z=2&lat=30&lon=0&date=${dateStr}`, {
      headers: { 'Accept': 'application/json', 'Referer': 'https://gpsjam.org/' }
    });
    if (r.status === 200 && r.data) {
      const data = JSON.parse(r.data);
      gpsjamCache = { data, ts: Date.now() };
      res.set('Cache-Control', 'max-age=300');
      return res.json(data);
    }
    throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    // Fallback: return known jamming hotspots as GeoJSON
    const fallback = {
      type: 'FeatureCollection',
      properties: { source: 'fallback', note: 'gpsjam.org unavailable' },
      features: [
        { type:'Feature', geometry:{type:'Point',coordinates:[35.5,33.9]},  properties:{level:3, label:'Eastern Mediterranean'} },
        { type:'Feature', geometry:{type:'Point',coordinates:[37.6,55.7]},  properties:{level:2, label:'Moscow Region'} },
        { type:'Feature', geometry:{type:'Point',coordinates:[44.4,33.3]},  properties:{level:3, label:'Iraq/Syria'} },
        { type:'Feature', geometry:{type:'Point',coordinates:[35.2,31.8]},  properties:{level:3, label:'Israel/Gaza'} },
        { type:'Feature', geometry:{type:'Point',coordinates:[28.9,41.0]},  properties:{level:2, label:'Istanbul'} },
        { type:'Feature', geometry:{type:'Point',coordinates:[30.5,50.4]},  properties:{level:2, label:'Ukraine'} },
        { type:'Feature', geometry:{type:'Point',coordinates:[22.9,41.3]},  properties:{level:1, label:'Balkans'} },
      ]
    };
    res.set('Cache-Control', 'max-age=60');
    res.json(fallback);
  }
});

// ─── AIS SHIPS: proxy to aisstream.io (requires free API key) ─────────────────
// Ships are fetched via HTTP snapshot from MarineTraffic-compatible sources
let shipCache = { data: null, ts: 0 };
app.get('/api/ships', async (req, res) => {
  if (shipCache.data && Date.now() - shipCache.ts < 10000) return res.json(shipCache.data);
  const aisKey = process.env.AISSTREAM_KEY || '';

  // Try aisstream.io REST-style snapshot (free tier)
  if (aisKey) {
    try {
      const r = await fetchUrl('https://api.aisstream.io/v0/latest-positions', {
        headers: { 'Authorization': `Bearer ${aisKey}`, 'Accept': 'application/json' }
      });
      if (r.status === 200) {
        const data = JSON.parse(r.data);
        const ships = (data.positions || data || []).slice(0, 2000).map(s => ({
          mmsi:    s.MMSI || s.mmsi,
          name:    (s.ShipName || s.name || 'UNKNOWN').trim(),
          lat:     s.Latitude  || s.lat,
          lon:     s.Longitude || s.lon,
          sog:     s.Sog  || s.speed || 0,   // speed over ground (knots)
          cog:     s.Cog  || s.course || 0,  // course over ground
          type:    s.ShipType || s.type || 0,
          flag:    s.Flag || '',
          dest:    (s.Destination || '').trim(),
          draught: s.Draught || 0,
          length:  s.Length || 0,
        }));
        shipCache = { data: ships, ts: Date.now() };
        return res.json(ships);
      }
    } catch {}
  }

  // Fallback: VesselFinder public feed (no key needed, limited)
  try {
    const r = await fetchUrl('https://www.vesselfinder.com/api/pub/vesselsonmap/area?minlat=-70&minlon=-180&maxlat=70&maxlon=180&z=2', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)', 'Referer': 'https://www.vesselfinder.com/' }
    });
    if (r.status === 200) {
      const raw = JSON.parse(r.data);
      const ships = (Array.isArray(raw) ? raw : raw.vessels || []).slice(0, 1000).map(s => ({
        mmsi: s[0] || s.mmsi,
        name: (s[2] || s.name || 'UNKNOWN').trim(),
        lat:  s[4] || s.lat,
        lon:  s[5] || s.lon,
        sog:  s[6] || 0,
        cog:  s[7] || 0,
        type: s[8] || 0,
        flag: s[13] || '',
        dest: '',
      }));
      shipCache = { data: ships, ts: Date.now() };
      return res.json(ships);
    }
  } catch {}

  res.status(503).json([]);
});

// ─── CCTV CAMERAS: OpenStreetMap surveillance nodes ───────────────────────────
app.get('/api/cctv', async (req, res) => {
  const lat    = parseFloat(req.query.lat) || 51.5;
  const lon    = parseFloat(req.query.lon) || -0.12;
  const radius = Math.min(parseInt(req.query.radius) || 5000, 15000);

  const q = `[out:json][timeout:25];
(
  node["man_made"="surveillance"](around:${radius},${lat},${lon});
  node["surveillance"](around:${radius},${lat},${lon});
  node["camera:type"](around:${radius},${lat},${lon});
);
out body qt;`;

  try {
    const r = await fetchUrl(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`);
    if (r.status !== 200) throw new Error();
    const raw = JSON.parse(r.data);
    const cameras = (raw.elements || []).map(n => ({
      id:       n.id,
      lat:      n.lat,
      lon:      n.lon,
      type:     n.tags?.surveillance || n.tags?.['camera:type'] || 'fixed',
      mount:    n.tags?.['camera:mount'] || 'pole',
      operator: n.tags?.operator || '',
      note:     n.tags?.note || n.tags?.description || '',
    }));
    res.set('Cache-Control', 'max-age=3600');
    res.json(cameras);
  } catch { res.status(503).json([]); }
});

// ─── OSM TRAFFIC SPEEDS (for Google Maps-style coloring) ─────────────────────
app.get('/api/osm/roads', async (req, res) => {
  const lat    = parseFloat(req.query.lat)||51.5;
  const lon    = parseFloat(req.query.lon)||-0.12;
  const radius = Math.min(parseInt(req.query.radius)||4000, 10000);
  const q = `[out:json][timeout:25];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$"](around:${radius},${lat},${lon});
);
out geom qt tags;`;
  try {
    const r = await fetchUrl(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`);
    if (r.status !== 200) throw new Error();
    res.set('Cache-Control', 'max-age=600');
    res.send(r.data);
  } catch { res.status(503).json({ elements: [] }); }
});

// (duplicate route removed)

// ─── TLE ─────────────────────────────────────────────────────────────────────
// Map friendly group names to CelesTrak group IDs
const TLE_GROUP_MAP = {
  'stations': 'space-stations',
  'visual':   'visual',
  'starlink': 'starlink',
  'weather':  'weather',
  'gps':      'gps-ops',
};

app.get('/api/tle/:group', async (req, res) => {
  const raw   = req.params.group.replace(/[^a-z0-9-]/gi, '');
  const group = TLE_GROUP_MAP[raw] || raw;

  // Try multiple CelesTrak endpoints in order
  const urls = [
    `https://celestrak.org/SOCRATES/query.php?GROUP=${group}&FORMAT=tle`,
    `https://celestrak.org/TLE/query.php?GROUP=${group}&FORMAT=tle`,
    `https://celestrak.org/pub/TLE/catalog.txt`,          // full catalog fallback
  ];

  for (const url of urls) {
    try {
      const r = await fetchUrl(url, {
        headers: { 'User-Agent': 'PanopticonDashboard/2.0 (self-hosted; non-commercial)' }
      });
      if (r.status === 200 && r.data && r.data.includes('1 ')) {
        res.set('Content-Type', 'text/plain').set('Cache-Control', 'max-age=120');
        return res.send(r.data);
      }
    } catch {}
  }

  // Hard-coded fallback: ISS + a handful of well-known satellites
  // so the UI always shows something even if CelesTrak is down
  const FALLBACK_TLE = `ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9993
2 25544  51.6400 208.9163 0006317  86.9006  73.1692 15.49560026430115
HUBBLE SPACE TELESCOPE
1 20580U 90037B   24001.50000000  .00000882  00000-0  39093-4 0  9990
2 20580  28.4700 203.7698 0002778 189.9948 170.1099 15.09745998392518
TIANGONG
1 48274U 21035A   24001.50000000  .00009778  00000-0  11434-3 0  9995
2 48274  41.4700 358.2990 0005830 348.3338  11.7450 15.60545848152812
NOAA 19
1 33591U 09005A   24001.50000000  .00000063  00000-0  63918-4 0  9998
2 33591  99.1930  45.1250 0013693 303.5636  56.4163 14.12235842769176
TERRA
1 25994U 99068A   24001.50000000  .00000037  00000-0  26163-4 0  9991
2 25994  98.2120  12.6374 0001180  93.8198 266.3133 14.57124601278140
AQUA
1 27424U 02022A   24001.50000000  .00000087  00000-0  43193-4 0  9994
2 27424  98.2110 359.9888 0001736  96.0215 264.1101 14.57144202155691
SENTINEL-2A
1 40697U 15028A   24001.50000000  .00000080  00000-0  41710-4 0  9993
2 40697  98.5690  31.2650 0001040  89.2890 270.8360 14.30820697448714
SENTINEL-2B
1 42063U 17013A   24001.50000000  .00000070  00000-0  37010-4 0  9991
2 42063  98.5680 211.2580 0001230 104.6890 255.4410 14.30818700368947`;

  res.set('Content-Type', 'text/plain').set('Cache-Control', 'max-age=60');
  res.send(FALLBACK_TLE);
});


// ─── GPS JAMMING: GPSJam.org ──────────────────────────────────────────────────
// Fetches daily CSV of H3 hex cells with GPS interference data
// CSV format: hex_id, percent_bad (0-100)
// Source: gpsjam.org — derived from ADS-B Exchange aircraft GPS accuracy reports

let jammingCache = { data: null, ts: 0, date: '' };

app.get('/api/jamming', async (req, res) => {
  // Default to yesterday UTC (today's data isn't available until ~midnight UTC)
  const targetDate = req.query.date || (() => {
    const d = new Date(Date.now() - 86400000);
    return d.toISOString().substring(0, 10);
  })();

  // Cache per date for 1 hour
  if (jammingCache.data && jammingCache.date === targetDate &&
      Date.now() - jammingCache.ts < 3600000) {
    res.set('Cache-Control', 'max-age=3600');
    return res.json(jammingCache.data);
  }

  try {
    const url = `https://gpsjam.org/data/jamming-${targetDate}.csv`;
    const r = await fetchUrl(url, {
      headers: { 'User-Agent': 'PanopticonDashboard/2.0 (non-commercial self-hosted)' }
    });

    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);

    // Parse CSV: each line is "hex_id,pct_bad" e.g. "841234567ffffff,15.3"
    const lines = r.data.trim().split('\n').filter(l => l && !l.startsWith('#'));
    const hexes = [];

    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 2) continue;
      const hexId  = parts[0].trim();
      const pctBad = parseFloat(parts[1]);
      if (!hexId || isNaN(pctBad) || pctBad < 2) continue; // skip green (< 2%)
      hexes.push({ h: hexId, p: Math.round(pctBad) });
    }

    const payload = { date: targetDate, count: hexes.length, hexes };
    jammingCache = { data: payload, ts: Date.now(), date: targetDate };
    res.set('Cache-Control', 'max-age=3600');
    res.json(payload);
  } catch (e) {
    console.error('[GPS Jamming] fetch error:', e.message);
    res.status(503).json({ error: e.message, date: targetDate, hexes: [] });
  }
});

// Available dates (last 7 days)
app.get('/api/jamming/dates', (req, res) => {
  const dates = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(Date.now() - i * 86400000);
    dates.push(d.toISOString().substring(0, 10));
  }
  res.json({ dates });
});

// ─── MESHTASTIC (liamcottle.net public API) ───────────────────────────────────
let meshtasticCache = { nodes: null, messages: null, ts: 0 };

app.get('/api/meshtastic/nodes', async (req, res) => {
  const maxAge = 120_000; // 2 min cache
  if (meshtasticCache.nodes && Date.now() - meshtasticCache.ts < maxAge) {
    return res.json(meshtasticCache.nodes);
  }
  try {
    // Liam Cottle's Meshtastic map API — public, no key
    const r = await fetchUrl('https://meshtastic.liamcottle.net/api/nodes', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'ARGUS-Intelligence/5.0' }
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const data = JSON.parse(r.data);
    const nodes = (data.nodes || data || []).filter(n => n.latitude && n.longitude).map(n => ({
      id:        n.id || n.node_id || String(n.nodeNum),
      name:      n.short_name || n.long_name || n.id || 'Unknown',
      long_name: n.long_name || '',
      lat:       n.latitude,
      lon:       n.longitude,
      altitude:  n.altitude || 0,
      snr:       n.snr || 0,
      battery:   n.battery_level || n.batteryLevel || null,
      last_heard:n.last_heard || n.lastHeard || null,
      hw_model:  n.hw_model || n.hwModel || '',
      firmware:  n.firmware_version || '',
    }));
    meshtasticCache.nodes = { nodes, total: nodes.length, ts: Date.now() };
    meshtasticCache.ts    = Date.now();
    res.set('Cache-Control', 'max-age=120');
    res.json(meshtasticCache.nodes);
  } catch (e) {
    // Fallback: return empty but valid response
    res.json({ nodes: [], total: 0, ts: Date.now(), error: e.message });
  }
});

app.get('/api/meshtastic/messages', async (req, res) => {
  const nodeId = req.query.node || '';
  try {
    const url = nodeId
      ? `https://meshtastic.liamcottle.net/api/messages?node_id=${encodeURIComponent(nodeId)}`
      : 'https://meshtastic.liamcottle.net/api/messages?limit=50';
    const r = await fetchUrl(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'ARGUS-Intelligence/5.0' }
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const data = JSON.parse(r.data);
    const messages = (data.messages || data || []).map(m => ({
      id:        m.id,
      from:      m.from_node || m.from || 'Unknown',
      from_name: m.from_short_name || m.from_name || '',
      to:        m.to_node || m.to || 'broadcast',
      text:      m.text || m.message || '',
      ts:        m.created_at || m.timestamp || m.ts,
      channel:   m.channel || 0,
    }));
    res.set('Cache-Control', 'max-age=30');
    res.json({ messages });
  } catch (e) {
    res.json({ messages: [], error: e.message });
  }
});

// ─── SEISMIC STATIONS (USGS FDSN) ────────────────────────────────────────────
let stationCache = { data: null, ts: 0 };

app.get('/api/seismic/stations', async (req, res) => {
  const maxAge = 3_600_000; // 1hr cache — stations don't change often
  if (stationCache.data && Date.now() - stationCache.ts < maxAge) {
    return res.json(stationCache.data);
  }
  try {
    // USGS FDSN station web service — returns real seismic network stations
    const url = 'https://earthquake.usgs.gov/fdsnws/station/1/query?format=geojson&network=IU,II,IC,G,MX&level=station&includeavailability=false';
    const r = await fetchUrl(url, { headers: { 'User-Agent': 'ARGUS-Intelligence/5.0' } });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const raw  = JSON.parse(r.data);
    const features = (raw.features || []).map(f => ({
      id:       f.id || f.properties?.code,
      name:     f.properties?.name || f.properties?.station || 'Station',
      network:  f.properties?.network || '',
      code:     f.properties?.code || '',
      lat:      f.geometry?.coordinates?.[1],
      lon:      f.geometry?.coordinates?.[0],
      elev:     f.geometry?.coordinates?.[2] || 0,
      start:    f.properties?.starttime || '',
    })).filter(f => f.lat && f.lon);
    stationCache.data = { stations: features, total: features.length };
    stationCache.ts   = Date.now();
    res.set('Cache-Control', 'max-age=3600');
    res.json(stationCache.data);
  } catch (e) {
    // Fallback: well-known IRIS/USGS global stations
    const fallback = [
      { id:'IU.ANMO', name:'Albuquerque NM', network:'IU', code:'ANMO', lat:34.946, lon:-106.457, elev:1740 },
      { id:'IU.COLA', name:'College AK',     network:'IU', code:'COLA', lat:64.874, lon:-147.861, elev:84 },
      { id:'IU.MAJO', name:'Matsushiro Japan',network:'IU', code:'MAJO', lat:36.541, lon:138.207, elev:418 },
      { id:'IU.TATO', name:'Taipei Taiwan',  network:'IU', code:'TATO', lat:24.975, lon:121.497, elev:74 },
      { id:'II.BFO',  name:'Black Forest Germany',network:'II', code:'BFO', lat:48.330, lon:8.330, elev:589 },
      { id:'II.MSVF', name:'Monasavu Fiji',  network:'II', code:'MSVF', lat:-17.747, lon:178.053, elev:620 },
      { id:'G.ECH',   name:'Echery France',  network:'G',  code:'ECH',  lat:48.216, lon:7.159, elev:580 },
      { id:'IC.BJT',  name:'Beijing China',  network:'IC', code:'BJT',  lat:40.018, lon:116.168, elev:120 },
    ];
    res.json({ stations: fallback, total: fallback.length, fallback: true });
  }
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
║  ARGUS // INTELLIGENCE SYSTEM v2        ║
║  http://localhost:${PORT}                        ║
║  DB:     ${db ? 'SQLite (WAL)               ' : 'disabled                     '}║
║  Shodan: ${process.env.SHODAN_API_KEY ? 'CONFIGURED                  ' : 'set SHODAN_API_KEY env var   '}║
╚══════════════════════════════════════════════╝`);
});

// ─── WEATHER (Open-Meteo, no key required) ────────────────────────────────────
const weatherCache = new Map(); // key → {data, ts}

app.get('/api/weather', async (req, res) => {
  const lat  = parseFloat(req.query.lat);
  const lon  = parseFloat(req.query.lon);
  const vars = (req.query.vars || 'temperature_2m,weather_code,wind_speed_10m').replace(/[^a-z0-9_,]/gi,'');
  if (isNaN(lat)||isNaN(lon)) return res.status(400).json({error:'Bad coords'});

  const cacheKey = `${lat.toFixed(1)}_${lon.toFixed(1)}_${vars}`;
  const cached   = weatherCache.get(cacheKey);
  if (cached && Date.now()-cached.ts < 300_000) return res.json(cached.data);

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=${vars}&timezone=auto&forecast_days=1`;
    const r   = await fetchUrl(url, { headers: { 'Accept': 'application/json' } });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const data = JSON.parse(r.data);
    weatherCache.set(cacheKey, { data, ts: Date.now() });
    res.set('Cache-Control','max-age=300');
    res.json(data);
  } catch(e) {
    res.status(503).json({ error: e.message });
  }
});

// ─── WILDFIRES (NASA FIRMS public CSV, no key for basic layer) ────────────────
let firmsCache = { data: null, ts: 0 };

app.get('/api/wildfires', async (req, res) => {
  const minLat = parseFloat(req.query.minLat)||-90;
  const maxLat = parseFloat(req.query.maxLat)||90;
  const minLon = parseFloat(req.query.minLon)||-180;
  const maxLon = parseFloat(req.query.maxLon)||180;

  // FIRMS public CSV (MODIS NRT, updated daily, no key for public layer)
  if (!firmsCache.data || Date.now()-firmsCache.ts > 3_600_000) {
    try {
      // Try world CSV (MODIS, last 24h)
      const r = await fetchUrl('https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv', {
        headers: { 'User-Agent': 'ARGUS-Intelligence/3.0' }
      });
      if (r.status === 200 && r.data.includes('latitude')) {
        const lines = r.data.trim().split('\n').slice(1); // skip header
        firmsCache.data = lines.map(l => {
          const p = l.split(',');
          return { lat:+p[0], lon:+p[1], brightness:+p[2], frp:+p[12]||+p[8]||0, acq_date:p[5]||'', confidence:p[8]||'' };
        }).filter(f => f.lat && f.lon && !isNaN(f.lat));
        firmsCache.ts = Date.now();
      }
    } catch {}
  }

  const all = firmsCache.data || [];
  const filtered = all.filter(f =>
    f.lat >= minLat && f.lat <= maxLat && f.lon >= minLon && f.lon <= maxLon
  ).slice(0, 2000);

  res.set('Cache-Control','max-age=900');
  res.json(filtered);
});
