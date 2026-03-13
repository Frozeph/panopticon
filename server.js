'use strict';
/**
 * ARGUS v7 — Intelligence Backend
 * Fixes: ships (WS + fallback), flights (adsb.lol), satellites (celestrak proper groups)
 * New: GDELT intel feed (100+ languages, auto-translated), AI natural-language query
 */

const express   = require('express');
const https     = require('https');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');
const WebSocket = require('ws');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── HTTP FETCH HELPER ────────────────────────────────────────────────────────
function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'ARGUS-Intelligence/7.0 (self-hosted)', 'Accept': '*/*', ...opts.headers },
      timeout: opts.timeout || 15000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── DATABASE ────────────────────────────────────────────────────────────────
let db = null;
try {
  const Database = require('better-sqlite3');
  db = new Database(path.join(DATA_DIR, 'argus.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -32000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL, layer TEXT NOT NULL, data TEXT NOT NULL, cnt INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_snap ON snapshots(layer, ts);
    CREATE TABLE IF NOT EXISTS shodan_cache (key TEXT PRIMARY KEY, ts INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  console.log('[DB] SQLite ready');
  setInterval(() => {
    db.prepare('DELETE FROM snapshots WHERE ts < ?').run(Date.now() - 7*86400000);
    db.prepare('DELETE FROM shodan_cache WHERE ts < ?').run(Date.now() - 3600000);
  }, 300000);
} catch(e) { console.warn('[DB] SQLite unavailable:', e.message); }

// ─── FLIGHTS ──────────────────────────────────────────────────────────────────
let adsbCache = { data: null, ts: 0 };

app.get('/api/flights/opensky', async (req, res) => {
  const lat  = parseFloat(req.query.lat)  || 51.5;
  const lon  = parseFloat(req.query.lon)  || -0.1;
  const dist = Math.min(parseInt(req.query.dist) || 250, 250);

  if (adsbCache.data && Date.now() - adsbCache.ts < 8000) return res.json(adsbCache.data);

  try {
    const r = await fetchUrl(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (r.status === 200) {
      const d  = JSON.parse(r.data);
      const ac = d.ac || d.aircraft || [];
      const states = ac.map(a => [
        (a.hex||a.icao||'').toLowerCase(),
        (a.flight||a.callsign||'').trim(),
        a.r||'',
        Math.floor(Date.now()/1000), Math.floor(Date.now()/1000),
        a.lon ?? a.lng ?? null,
        a.lat ?? null,
        a.alt_baro != null ? (a.alt_baro === 'ground' ? 0 : Math.round(a.alt_baro * 0.3048)) : null,
        a.alt_baro === 'ground' || false,
        a.gs != null ? Math.round(a.gs * 0.514444) : null,
        a.track ?? null, null, null,
        a.alt_geom != null ? Math.round(a.alt_geom * 0.3048) : null,
        a.squawk||null, false, 0, a.category||a.t||null, a.military||false,
      ]).filter(s => s[5] != null && s[6] != null);
      const payload = { states, _src: 'adsblol', _count: states.length, time: Math.floor(Date.now()/1000) };
      adsbCache = { data: payload, ts: Date.now() };
      return res.json(payload);
    }
    console.warn(`[Flights] adsb.lol ${r.status}`);
  } catch(e) { console.warn('[Flights] adsb.lol:', e.message); }

  // OpenSky fallback
  try {
    const r = await fetchUrl('https://opensky-network.org/api/states/all');
    if (r.status === 200) return res.json({ ...JSON.parse(r.data), _src: 'opensky' });
  } catch(e) { console.warn('[Flights] OpenSky:', e.message); }

  res.status(503).json({ states: [], error: 'All flight sources unavailable' });
});

app.get('/api/flights/military', async (req, res) => {
  try {
    const r = await fetchUrl('https://api.adsb.lol/v2/mil', { headers: { 'Accept': 'application/json' } });
    if (r.status === 200) {
      const d = JSON.parse(r.data);
      const states = (d.ac||d.aircraft||[]).map(a => [
        (a.hex||'').toLowerCase(), (a.flight||'').trim(), a.r||'',
        Math.floor(Date.now()/1000), Math.floor(Date.now()/1000),
        a.lon??a.lng??null, a.lat??null,
        a.alt_baro != null ? (a.alt_baro === 'ground' ? 0 : Math.round(a.alt_baro*0.3048)) : null,
        false, a.gs!=null?Math.round(a.gs*0.514444):null, a.track??null,
        null, null, null, null, false, 0, a.t||null, true,
      ]).filter(s => s[5]!=null && s[6]!=null);
      return res.json({ states, _src:'adsblol_mil', _count:states.length });
    }
  } catch(e) { console.warn('[MilFlights]:', e.message); }
  res.json({ states: [], _count: 0 });
});

// ─── SHIPS ────────────────────────────────────────────────────────────────────
const shipPositions    = new Map();
let   wsConnection     = null;
let   wsReconnTimer    = null;
let   shipFallback     = { data: null, ts: 0 };

function startAISStream() {
  const key = process.env.AISSTREAM_KEY || '';
  if (!key) { console.log('[Ships] No AISSTREAM_KEY — VesselFinder fallback active'); return; }
  clearTimeout(wsReconnTimer);
  try {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    ws.on('open', () => {
      console.log('[AISStream] connected');
      ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [[[-90,-180],[90,180]]], FilterMessageTypes: ['PositionReport','StandardClassBPositionReport'] }));
    });
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        const meta = msg.MetaData||{};
        const pos  = msg.Message?.PositionReport || msg.Message?.StandardClassBPositionReport;
        if (!pos) return;
        const mmsi = String(meta.MMSI || pos.UserID || '');
        if (!mmsi) return;
        shipPositions.set(mmsi, { mmsi, lat:meta.latitude||pos.Latitude, lon:meta.longitude||pos.Longitude, name:(meta.ShipName||'').trim(), speed:pos.Sog||0, course:pos.Cog||0, heading:pos.TrueHeading||511, status:pos.NavigationalStatus||0, type:meta.ShipType||0, ts:Date.now() });
      } catch {}
    });
    ws.on('close', () => { wsConnection = null; wsReconnTimer = setTimeout(startAISStream, 30000); });
    ws.on('error', e => { console.warn('[AISStream] WS error:', e.message); ws.terminate(); });
    wsConnection = ws;
  } catch(e) { wsReconnTimer = setTimeout(startAISStream, 60000); }
}
setInterval(() => { const cut=Date.now()-15*60*1000; for(const[k,v] of shipPositions) if(v.ts<cut) shipPositions.delete(k); }, 30000);
startAISStream();

app.get('/api/ships', async (req, res) => {
  const minLat = parseFloat(req.query.minLat)||-90, maxLat = parseFloat(req.query.maxLat)||90;
  const minLon = parseFloat(req.query.minLon)||-180, maxLon = parseFloat(req.query.maxLon)||180;
  const hasBbox = req.query.minLat != null;

  if (shipPositions.size > 0) {
    let ships = [...shipPositions.values()];
    if (hasBbox) ships = ships.filter(s => s.lat>=minLat && s.lat<=maxLat && s.lon>=minLon && s.lon<=maxLon);
    return res.json({ ships: ships.slice(0,5000), _src:'aisstream', _count:ships.length });
  }

  if (shipFallback.data && Date.now()-shipFallback.ts < 30000) {
    let ships = shipFallback.data;
    if (hasBbox) ships = ships.filter(s=>s.lat>=minLat&&s.lat<=maxLat&&s.lon>=minLon&&s.lon<=maxLon);
    return res.json({ ships:ships.slice(0,2000), _src:'vf_cache', _count:ships.length });
  }

  try {
    const url = hasBbox
      ? `https://www.vesselfinder.com/api/pub/vesselsonmap/area?minlat=${minLat}&minlon=${minLon}&maxlat=${maxLat}&maxlon=${maxLon}&z=5`
      : `https://www.vesselfinder.com/api/pub/vesselsonmap/area?minlat=-70&minlon=-180&maxlat=70&maxlon=180&z=2`;
    const r = await fetchUrl(url, { headers:{'User-Agent':'Mozilla/5.0','Referer':'https://www.vesselfinder.com/','Accept':'application/json'} });
    if (r.status === 200) {
      const raw = JSON.parse(r.data);
      const arr = Array.isArray(raw)?raw:(raw.vessels||raw.data||[]);
      const ships = arr.slice(0,3000).map(s=>({ mmsi:String(s[0]||s.mmsi||''), name:s[1]||s.name||'', lat:s[2]||s.lat, lon:s[3]||s.lon, speed:s[4]||0, course:s[5]||0, type:s[7]||0, ts:Date.now() })).filter(s=>s.lat&&s.lon);
      shipFallback = { data: ships, ts: Date.now() };
      return res.json({ ships, _src:'vesselfinder', _count:ships.length });
    }
  } catch(e) { console.warn('[Ships] VF error:', e.message); }

  res.json({ ships: [], _src:'none', _count:0, info:'Set AISSTREAM_KEY for full AIS data' });
});

// ─── TLE / SATELLITES ─────────────────────────────────────────────────────────
// ONLY 'visual' group by default (~150 sats) — fast, reliable
// 'active' has 9000+ sats; only load if explicitly requested
const TLE_GROUPS = {
  'stations':'space-stations','space-stations':'space-stations',
  'visual':'visual','starlink':'starlink','weather':'weather',
  'gps':'gps-ops','gps-ops':'gps-ops','geo':'geo',
  'iridium':'iridium-next','active':'active',
};
const tleCache = new Map();

app.get('/api/tle/:group', async (req, res) => {
  const raw   = req.params.group.replace(/[^a-z0-9-]/gi,'').toLowerCase();
  const group = TLE_GROUPS[raw] || raw;
  const cached = tleCache.get(group);
  if (cached && Date.now()-cached.ts < 300000) return res.set('Content-Type','text/plain').set('Cache-Control','max-age=300').send(cached.data);

  for (const url of [
    `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`,
    `https://celestrak.com/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`,
  ]) {
    try {
      const r = await fetchUrl(url, { headers:{'Accept':'text/plain'}, timeout:20000 });
      if (r.status===200 && r.data?.includes('\n1 ')) {
        const cnt = Math.floor(r.data.trim().split('\n').filter(l=>l.trim()).length/3);
        console.log(`[TLE] ${group}: ${cnt} sats`);
        tleCache.set(group, { data:r.data, ts:Date.now() });
        return res.set('Content-Type','text/plain').set('Cache-Control','max-age=300').send(r.data);
      }
      console.warn(`[TLE] ${group}: HTTP ${r.status}`);
    } catch(e) { console.warn(`[TLE] ${group}: ${e.message}`); }
  }

  // Fallback: 8 well-known satellites so UI always shows something
  const FALLBACK = `ISS (ZARYA)\n1 25544U 98067A   25072.50000000  .00016717  00000-0  10270-3 0  9993\n2 25544  51.6400 208.9163 0006317  86.9006  73.1692 15.49560026430115\nTIANGONG\n1 48274U 21035A   25072.50000000  .00009778  00000-0  11434-3 0  9995\n2 48274  41.4700 358.2990 0005830 348.3338  11.7450 15.60545848152812\nHUBBLE\n1 20580U 90037B   25072.50000000  .00000882  00000-0  39093-4 0  9990\n2 20580  28.4700 203.7698 0002778 189.9948 170.1099 15.09745998392518\nNOAA 19\n1 33591U 09005A   25072.50000000  .00000063  00000-0  63918-4 0  9998\n2 33591  99.1930  45.1250 0013693 303.5636  56.4163 14.12235842769176\nTERRA\n1 25994U 99068A   25072.50000000  .00000037  00000-0  26163-4 0  9991\n2 25994  98.2120  12.6374 0001180  93.8198 266.3133 14.57124601278140\nSENTINEL-2A\n1 40697U 15028A   25072.50000000  .00000080  00000-0  41710-4 0  9993\n2 40697  98.5690  31.2650 0001040  89.2890 270.8360 14.30820697448714\nSENTINEL-2B\n1 42063U 17013A   25072.50000000  .00000070  00000-0  37010-4 0  9991\n2 42063  98.5680 211.2580 0001230 104.6890 255.4410 14.30818700368947\nAQUA\n1 27424U 02022A   25072.50000000  .00000087  00000-0  43193-4 0  9994\n2 27424  98.2110 359.9888 0001736  96.0215 264.1101 14.57144202155691`;
  res.set('Content-Type','text/plain').set('Cache-Control','max-age=60').send(FALLBACK);
});

// ─── GDELT INTEL FEED ─────────────────────────────────────────────────────────
// GDELT monitors 100+ languages, auto-translates everything to English, updates every 15min
// Free, no API key, near-realtime, global coverage including local/regional media
const gdeltCache = new Map();

app.get('/api/intel/feed', async (req, res) => {
  const keyword  = (req.query.q || '').replace(/[^\w\s"()-]/g, '').trim();
  const timespan = ['1h','6h','12h','24h','7d'].includes(req.query.timespan) ? req.query.timespan : '24h';
  const maxrecs  = Math.min(parseInt(req.query.limit) || 50, 250);
  const sortMode = req.query.sort === 'tone' ? 'ToneAsc' : 'DateDesc';

  // Default query covers conflict/security themes that have most local corroboration
  const query = keyword || 'conflict OR attack OR protest OR explosion OR military OR strike OR "breaking news"';
  const cacheKey = `feed_${query}_${timespan}_${maxrecs}`;
  const cached   = gdeltCache.get(cacheKey);
  if (cached && Date.now()-cached.ts < 5*60*1000) return res.set('Cache-Control','max-age=300').json(cached.data);

  try {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=${maxrecs}&timespan=${timespan}&sort=${sortMode}&format=json`;
    const r   = await fetchUrl(url, { timeout: 25000 });
    if (r.status !== 200) throw new Error(`GDELT returned ${r.status}`);

    const data     = JSON.parse(r.data);
    const articles = (data.articles || []).map((a, i) => ({
      id:       i,
      url:      a.url,
      title:    a.title || '(no title)',
      source:   a.domain,
      language: a.language || 'English',
      country:  a.sourcecountry || '',
      image:    a.socialimage || null,
      date:     a.seendate,
      // GDELT tone: negative = conflict/negative reporting; positive = good news
      // We use abs(tone) as "intensity" — heavily negative articles = high conflict signal
      tone:     a.tone != null ? parseFloat(a.tone) : null,
    }));

    // Group by title similarity to find corroborated stories
    // Simple approach: count how many sources report similar keywords
    const titleMap = new Map();
    for (const art of articles) {
      const key = art.title.toLowerCase().replace(/[^a-z0-9\s]/g,'').split(' ').slice(0,5).join(' ');
      if (!titleMap.has(key)) titleMap.set(key, []);
      titleMap.get(key).push(art);
    }
    // Add corroboration count to each article
    for (const art of articles) {
      const key = art.title.toLowerCase().replace(/[^a-z0-9\s]/g,'').split(' ').slice(0,5).join(' ');
      art.corroboration = titleMap.get(key)?.length || 1;
    }
    // Sort by corroboration (most sources first), then by date
    articles.sort((a, b) => (b.corroboration - a.corroboration) || new Date(b.date) - new Date(a.date));

    const payload = { articles, count: articles.length, query, timespan, ts: Date.now() };
    gdeltCache.set(cacheKey, { data: payload, ts: Date.now() });
    res.set('Cache-Control', 'max-age=300').json(payload);
  } catch(e) {
    console.warn('[GDELT] feed error:', e.message);
    res.status(503).json({ articles: [], error: e.message, query });
  }
});

// GDELT geographic events — for map pins
app.get('/api/intel/events', async (req, res) => {
  const keyword  = (req.query.q || 'attack military protest').replace(/[^\w\s"()-]/g,'').trim();
  const timespan = req.query.timespan || '24h';
  const cacheKey = `geo_${keyword}_${timespan}`;
  const cached   = gdeltCache.get(cacheKey);
  if (cached && Date.now()-cached.ts < 15*60*1000) return res.json(cached.data);

  try {
    const url = `https://api.gdeltproject.org/api/v2/geo/geo?query=${encodeURIComponent(keyword)}&mode=pointdata&timespan=${timespan}&format=json&maxrecords=500`;
    const r   = await fetchUrl(url, { timeout: 25000 });
    if (r.status !== 200) throw new Error(`GDELT GEO ${r.status}`);
    const data = JSON.parse(r.data);
    const features = (data.features||[]).map(f=>({
      lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0],
      name: f.properties?.name||'',  count: f.properties?.count||1,
      articles: (f.properties?.articles||[]).slice(0,3).map(a=>({ title:a.title, url:a.url, domain:a.domain })),
    })).filter(f=>f.lat&&f.lon);
    const payload = { features, count: features.length, query: keyword, ts: Date.now() };
    gdeltCache.set(cacheKey, { data: payload, ts: Date.now() });
    res.set('Cache-Control','max-age=900').json(payload);
  } catch(e) { res.status(503).json({ features: [], error: e.message }); }
});

// ─── AI INTELLIGENCE QUERY (Anthropic Claude proxy) ───────────────────────────
app.post('/api/ai/query', async (req, res) => {
  const { query, context } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  const system = `You are ARGUS, an embedded geospatial intelligence analyst. The operator is viewing a live surveillance dashboard with: ADS-B flights, AIS ships, satellite TLE tracks, seismic events, wildfires, GPS jamming data, Meshtastic mesh network nodes, CCTV cameras, and GDELT global news intelligence.
Provide concise, precise, intelligence-format briefings. Use direct language. Keep responses under 200 words. Never fabricate specific data — reference what the live feeds would show.
Current dashboard context: ${JSON.stringify(context||{})}`;

  try {
    const body = JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:300, system, messages:[{role:'user',content:query}] });
    const apiRes = await new Promise((resolve, reject) => {
      const r = https.request({ hostname:'api.anthropic.com', path:'/v1/messages', method:'POST', headers:{ 'Content-Type':'application/json','anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(body) } }, res2 => {
        const chunks = [];
        res2.on('data', c=>chunks.push(c));
        res2.on('end', ()=>resolve({ status:res2.statusCode, data:Buffer.concat(chunks).toString() }));
      });
      r.on('error', reject);
      r.write(body); r.end();
    });
    if (apiRes.status === 200) {
      const d = JSON.parse(apiRes.data);
      return res.json({ response: d.content?.find(c=>c.type==='text')?.text||'No response', model:d.model });
    }
    res.status(apiRes.status).json({ error: 'AI service returned ' + apiRes.status });
  } catch(e) { res.status(503).json({ error: e.message }); }
});

// ─── OTHER DATA SOURCES ────────────────────────────────────────────────────────
app.get('/api/quakes', async (req, res) => {
  try {
    const r = await fetchUrl('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson');
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    res.set('Cache-Control','max-age=300').json(JSON.parse(r.data));
  } catch(e) { res.status(503).json({features:[],error:e.message}); }
});

let stationCache = { data:null, ts:0 };
app.get('/api/seismic/stations', async (req, res) => {
  if (stationCache.data && Date.now()-stationCache.ts < 3600000) return res.json(stationCache.data);
  try {
    const r = await fetchUrl('https://earthquake.usgs.gov/fdsnws/station/1/query?format=geojson&network=IU,II,IC,G,MX&level=station');
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const raw = JSON.parse(r.data);
    const stations = (raw.features||[]).map(f=>({ id:f.id, name:f.properties?.name||'Station', network:f.properties?.network||'', lat:f.geometry?.coordinates?.[1], lon:f.geometry?.coordinates?.[0] })).filter(s=>s.lat&&s.lon);
    stationCache = { data:{stations,total:stations.length}, ts:Date.now() };
    res.set('Cache-Control','max-age=3600').json(stationCache.data);
  } catch(e) { res.status(503).json({stations:[],error:e.message}); }
});

let firmsCache = { data:null, ts:0 };
app.get('/api/wildfires', async (req, res) => {
  const minLat=parseFloat(req.query.minLat)||-90, maxLat=parseFloat(req.query.maxLat)||90;
  const minLon=parseFloat(req.query.minLon)||-180, maxLon=parseFloat(req.query.maxLon)||180;
  if (!firmsCache.data || Date.now()-firmsCache.ts > 3600000) {
    try {
      const r = await fetchUrl('https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv');
      if (r.status===200 && r.data.includes('latitude')) { firmsCache.data=r.data.trim().split('\n').slice(1).map(l=>{const p=l.split(',');return{lat:+p[0],lon:+p[1],brightness:+p[2],frp:+p[12]||0};}).filter(f=>f.lat&&f.lon&&!isNaN(f.lat)); firmsCache.ts=Date.now(); }
    } catch {}
  }
  res.set('Cache-Control','max-age=900').json((firmsCache.data||[]).filter(f=>f.lat>=minLat&&f.lat<=maxLat&&f.lon>=minLon&&f.lon<=maxLon).slice(0,2000));
});

const weatherCache = new Map();
app.get('/api/weather', async (req, res) => {
  const lat=parseFloat(req.query.lat), lon=parseFloat(req.query.lon);
  if (isNaN(lat)||isNaN(lon)) return res.status(400).json({error:'Bad coords'});
  const key=`${lat.toFixed(1)}_${lon.toFixed(1)}`;
  const cached=weatherCache.get(key);
  if (cached&&Date.now()-cached.ts<300000) return res.json(cached.data);
  try {
    const r=await fetchUrl(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&timezone=auto&forecast_days=1`);
    if (r.status===200) { const d=JSON.parse(r.data); weatherCache.set(key,{data:d,ts:Date.now()}); res.set('Cache-Control','max-age=300').json(d); }
    else throw new Error(`HTTP ${r.status}`);
  } catch(e) { res.status(503).json({error:e.message}); }
});

let jammingCache={data:null,ts:0,date:''};
app.get('/api/jamming', async (req, res) => {
  const d=req.query.date||new Date(Date.now()-86400000).toISOString().substring(0,10);
  if (jammingCache.data&&jammingCache.date===d&&Date.now()-jammingCache.ts<3600000) return res.json(jammingCache.data);
  try {
    const r=await fetchUrl(`https://gpsjam.org/data/jamming-${d}.csv`);
    if (r.status!==200) throw new Error(`HTTP ${r.status}`);
    const hexes=r.data.trim().split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>{const p=l.split(',');return{h:p[0]?.trim(),p:Math.round(parseFloat(p[1]))};}).filter(h=>h.h&&h.p>=2);
    jammingCache={data:{date:d,count:hexes.length,hexes},ts:Date.now(),date:d};
    res.set('Cache-Control','max-age=3600').json(jammingCache.data);
  } catch(e) { res.status(503).json({error:e.message,hexes:[]}); }
});

app.get('/api/cctv', async (req,res) => {
  const lat=parseFloat(req.query.lat)||51.5, lon=parseFloat(req.query.lon)||-0.1;
  const r2=Math.min(parseInt(req.query.radius)||3000,8000);
  const q=`[out:json][timeout:25];(node["man_made"="surveillance"](around:${r2},${lat},${lon}););out body;`;
  try {
    const r=await fetchUrl(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`);
    if (r.status!==200) throw new Error();
    const d=JSON.parse(r.data);
    res.set('Cache-Control','max-age=600').json(d.elements.filter(n=>n.lat&&n.lon).map(n=>({id:n.id,lat:n.lat,lon:n.lon,type:n.tags?.surveillance||'fixed',operator:n.tags?.operator||''})));
  } catch { res.json([]); }
});

let meshCache={nodes:null,ts:0};
app.get('/api/meshtastic/nodes', async (req,res) => {
  if (meshCache.nodes&&Date.now()-meshCache.ts<120000) return res.json(meshCache.nodes);
  try {
    const r=await fetchUrl('https://meshtastic.liamcottle.net/api/nodes',{headers:{'Accept':'application/json'}});
    if (r.status!==200) throw new Error(`HTTP ${r.status}`);
    const d=JSON.parse(r.data);
    const nodes=(d.nodes||d||[]).filter(n=>n.latitude&&n.longitude).map(n=>({id:n.id||String(n.nodeNum),name:n.short_name||n.id||'?',lat:n.latitude,lon:n.longitude,snr:n.snr||0,battery:n.battery_level||null,last_heard:n.last_heard||null}));
    meshCache={nodes:{nodes,total:nodes.length},ts:Date.now()};
    res.set('Cache-Control','max-age=120').json(meshCache.nodes);
  } catch(e) { res.json({nodes:[],total:0}); }
});

app.get('/api/shodan/search', async (req,res) => {
  const key=req.headers['x-shodan-key']||process.env.SHODAN_API_KEY||'';
  const query=req.query.q||'';
  if (!key) return res.status(401).json({error:'No Shodan API key'});
  if (!query) return res.status(400).json({error:'No query'});
  const ck=`${query}_${req.query.page||1}`;
  if (db) { const row=db.prepare('SELECT data FROM shodan_cache WHERE key=? AND ts>?').get(ck,Date.now()-3600000); if (row) return res.json(JSON.parse(row.data)); }
  try {
    const r=await fetchUrl(`https://api.shodan.io/shodan/host/search?key=${key}&query=${encodeURIComponent(query)}&page=${req.query.page||1}`);
    if (r.status!==200) return res.status(r.status).json({error:`Shodan ${r.status}`});
    const d=JSON.parse(r.data);
    if (db) db.prepare('INSERT OR REPLACE INTO shodan_cache(key,ts,data) VALUES(?,?,?)').run(ck,Date.now(),r.data);
    res.json(d);
  } catch(e) { res.status(503).json({error:e.message}); }
});

// ─── STATUS & DEBUG ───────────────────────────────────────────────────────────
app.get('/api/status', (req,res) => res.json({ shodan:!!(process.env.SHODAN_API_KEY), aisstream:!!(process.env.AISSTREAM_KEY), ws_connected:wsConnection?.readyState===1, ship_count:shipPositions.size, version:'7.0' }));
app.get('/api/health', (req,res) => res.json({ status:'ok', ts:new Date().toISOString(), version:'7.0' }));

app.get('/api/debug/sources', async (req,res) => {
  const out = { ts:Date.now(), version:'7.0', sources:{} };
  try { const r=await fetchUrl('https://api.adsb.lol/v2/lat/51.5/lon/-0.1/dist/50',{timeout:8000}); const d=r.status===200?JSON.parse(r.data):{}; out.sources.adsblol={ok:r.status===200,status:r.status,count:(d.ac||[]).length}; } catch(e) { out.sources.adsblol={ok:false,error:e.message}; }
  try { const r=await fetchUrl('https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle',{timeout:10000}); out.sources.celestrak={ok:r.status===200,status:r.status,lines:r.status===200?r.data.split('\n').length:0}; } catch(e) { out.sources.celestrak={ok:false,error:e.message}; }
  try { const r=await fetchUrl('https://api.gdeltproject.org/api/v2/doc/doc?query=conflict&mode=artlist&maxrecords=3&timespan=1h&format=json',{timeout:10000}); const d=r.status===200?JSON.parse(r.data):{}; out.sources.gdelt={ok:r.status===200,count:(d.articles||[]).length}; } catch(e) { out.sources.gdelt={ok:false,error:e.message}; }
  out.sources.ships={aisstream_key:!!(process.env.AISSTREAM_KEY),ws_connected:wsConnection?.readyState===1,cached:shipPositions.size};
  res.json(out);
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║  ARGUS v7.0 — GEOSPATIAL INTELLIGENCE SYSTEM       ║
║  http://localhost:${PORT}                                 ║
║  Intel: GDELT (100+ languages) · AI Query · Ships  ║
╚════════════════════════════════════════════════════╝`);
});
