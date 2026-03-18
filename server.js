'use strict';
/**
 * NEXUS v7 — Intelligence Backend
 * Ships: fixed Digitraffic MMSI parsing (mmsi now at feature level), added
 *        MyShipTracking + MarineTraffic tile fallbacks
 * OSINT: expanded RSS (conflict/Telegram sources), geo-filtering by bbox,
 *        country geo-tagging, event classification
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
// Use a real browser UA — many public APIs block bot-identified clients
// NOTE: do NOT send Accept-Encoding — Node http.get doesn't auto-decompress,
// so compressed responses would be garbled binary
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0';

function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent':      BROWSER_UA,
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...opts.headers,
      },
      timeout: opts.timeout || 15000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString(), headers: res.headers }));
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

  // Priority 1: live AISStream WebSocket cache
  if (shipPositions.size > 0) {
    let ships = [...shipPositions.values()];
    if (hasBbox) ships = ships.filter(s => s.lat>=minLat && s.lat<=maxLat && s.lon>=minLon && s.lon<=maxLon);
    return res.json({ ships: ships.slice(0,5000), _src:'aisstream', _count:ships.length });
  }

  // Priority 2: fresh fallback cache (5 min)
  if (shipFallback.data && Date.now()-shipFallback.ts < 5*60*1000) {
    let ships = shipFallback.data;
    if (hasBbox) ships = ships.filter(s=>s.lat>=minLat&&s.lat<=maxLat&&s.lon>=minLon&&s.lon<=maxLon);
    return res.json({ ships:ships.slice(0,2000), _src:'cached', _count:ships.length });
  }

  const log = (src, msg) => console.log(`[Ships/${src}] ${msg}`);

  // ── Source A: Digitraffic (Finnish Transport Agency) — genuinely free public API
  // Provides global AIS from receiver network, open data licence, no auth needed
  try {
    const r = await fetchUrl('https://meri.digitraffic.fi/api/ais/v1/locations', {
      headers: { 'Digitraffic-User': 'NEXUS/7.0 github.com/Frozeph/panopticon', 'Accept': 'application/json' },
      timeout: 20000,
    });
    log('digitraffic', `HTTP ${r.status}, ${r.data.length} bytes`);
    if (r.status === 200) {
      const d = JSON.parse(r.data);
      const features = d.features || (Array.isArray(d) ? d : []);
      // IMPORTANT: In the Digitraffic FeatureCollection, mmsi is at the feature
      // level (f.mmsi), NOT inside f.properties. Properties has sog/cog/heading.
      const ships = features.slice(0, 5000).map(f => {
        const p = f.properties || {};
        const g = f.geometry?.coordinates;
        return {
          mmsi:    String(f.mmsi || p.mmsi || ''),   // mmsi at feature level!
          name:    '',
          lat:     g ? parseFloat(g[1]) : parseFloat(p.lat || 0),
          lon:     g ? parseFloat(g[0]) : parseFloat(p.lon || 0),
          speed:   parseFloat(p.sog || 0),
          course:  parseFloat(p.cog || 0),
          heading: parseFloat(p.heading || 511),
          type:    parseInt(p.shipType || 0),
          ts:      Date.now(),
        };
      }).filter(s => s.lat != null && s.lon != null && !isNaN(s.lat) && !isNaN(s.lon) && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180 && s.mmsi);

      // Fetch vessel names separately
      if (ships.length > 0) {
        try {
          const vr = await fetchUrl('https://meri.digitraffic.fi/api/ais/v1/vessels', {
            headers: { 'Digitraffic-User': 'NEXUS/7.0 github.com/Frozeph/panopticon' }, timeout: 15000,
          });
          if (vr.status === 200) {
            const vd = JSON.parse(vr.data);
            const vesselMap = new Map();
            // vessel list: mmsi also at feature level
            (vd.features || (Array.isArray(vd) ? vd : [])).forEach(v => {
              const p = v.properties || v;
              const m = String(v.mmsi || p.mmsi || p.MMSI || '');
              const name = (p.name || p.shipName || p.NAME || '').trim();
              if (m && name) vesselMap.set(m, name);
            });
            ships.forEach(s => { if (vesselMap.has(s.mmsi)) s.name = vesselMap.get(s.mmsi); });
          }
        } catch(e) { log('digitraffic', `vessels fetch: ${e.message}`); }
        shipFallback = { data: ships, ts: Date.now() };
        let out = hasBbox ? ships.filter(s=>s.lat>=minLat&&s.lat<=maxLat&&s.lon>=minLon&&s.lon<=maxLon) : ships;
        log('digitraffic', `returning ${out.length} ships`);
        return res.json({ ships: out.slice(0, 3000), _src: 'digitraffic', _count: out.length });
      }
    }
  } catch(e) { log('digitraffic', `error: ${e.message}`); }

  // ── Source B: Kystverket (Norwegian Coastal Admin)
  try {
    const r = await fetchUrl('https://kystdatahuset.no/ws/api/ais/positions/all', {
      headers: { 'Referer': 'https://kystdatahuset.no/', 'Accept': 'application/json' },
      timeout: 12000,
    });
    log('kystverket', `HTTP ${r.status}`);
    if (r.status === 200 && r.data.length > 100) {
      const parsed = JSON.parse(r.data);
      const arr = Array.isArray(parsed) ? parsed : (parsed.features || parsed.data || []);
      const ships = arr.slice(0, 3000).map(s => {
        const p = s.properties || s;
        const g = s.geometry?.coordinates;
        return {
          mmsi:   String(p.mmsi || p.MMSI || ''),
          name:   (p.name || p.shipName || '').trim(),
          lat:    g ? parseFloat(g[1]) : parseFloat(p.lat || p.latitude || 0),
          lon:    g ? parseFloat(g[0]) : parseFloat(p.lon || p.longitude || 0),
          speed:  parseFloat(p.sog || p.speed || 0),
          course: parseFloat(p.cog || p.course || 0),
          type:   parseInt(p.shipType || 0),
          ts:     Date.now(),
        };
      }).filter(s => s.lat && s.lon && Math.abs(s.lat) <= 90 && s.mmsi);
      if (ships.length > 0) {
        shipFallback = { data: ships, ts: Date.now() };
        let out = hasBbox ? ships.filter(s=>s.lat>=minLat&&s.lat<=maxLat&&s.lon>=minLon&&s.lon<=maxLon) : ships;
        return res.json({ ships: out.slice(0, 2000), _src: 'kystverket', _count: out.length });
      }
    }
  } catch(e) { log('kystverket', `error: ${e.message}`); }

  // ── Source C: VesselFinder
  try {
    const vfLat1 = hasBbox ? minLat : -70, vfLat2 = hasBbox ? maxLat : 70;
    const vfLon1 = hasBbox ? minLon : -180, vfLon2 = hasBbox ? maxLon : 180;
    const url = `https://www.vesselfinder.com/api/pub/vesselsonmap/area?minlat=${vfLat1}&minlon=${vfLon1}&maxlat=${vfLat2}&maxlon=${vfLon2}&z=3`;
    const r = await fetchUrl(url, {
      headers: { 'Referer': 'https://www.vesselfinder.com/', 'Accept': 'application/json' },
      timeout: 15000,
    });
    log('vesselfinder', `HTTP ${r.status}, ${r.data.length} bytes`);
    if (r.status === 200 && r.data.length > 10) {
      const raw = JSON.parse(r.data);
      const arr = Array.isArray(raw) ? raw : (raw.vessels || raw.data || []);
      const ships = arr.slice(0, 3000).map(s => ({
        mmsi:   String(s[0] || s.mmsi || ''),
        name:   (s[1] || s.name || '').trim(),
        lat:    parseFloat(s[2] ?? s.lat ?? 0),
        lon:    parseFloat(s[3] ?? s.lon ?? 0),
        speed:  parseFloat(s[4] || 0) / 10,
        course: parseFloat(s[5] || 0),
        type:   parseInt(s[7] || 0),
        ts:     Date.now(),
      })).filter(s => s.lat && s.lon && Math.abs(s.lat) <= 90);
      if (ships.length > 0) {
        shipFallback = { data: ships, ts: Date.now() };
        let out = hasBbox ? ships.filter(s=>s.lat>=vfLat1&&s.lat<=vfLat2&&s.lon>=vfLon1&&s.lon<=vfLon2) : ships;
        return res.json({ ships: out.slice(0, 2000), _src: 'vesselfinder', _count: out.length });
      }
    }
  } catch(e) { log('vesselfinder', `error: ${e.message}`); }

  // ── Source D: MyShipTracking (public map JSON endpoint)
  try {
    const mstLat1 = hasBbox ? minLat : -70, mstLat2 = hasBbox ? maxLat : 70;
    const mstLon1 = hasBbox ? minLon : -180, mstLon2 = hasBbox ? maxLon : 180;
    const url = `https://www.myshiptracking.com/requests/vesselsonmap?type=json&minlat=${mstLat1}&minlng=${mstLon1}&maxlat=${mstLat2}&maxlng=${mstLon2}&zoom=3`;
    const r = await fetchUrl(url, {
      headers: { 'Referer': 'https://www.myshiptracking.com/', 'Accept': 'application/json' },
      timeout: 12000,
    });
    log('myshiptracking', `HTTP ${r.status}, ${r.data.length} bytes`);
    if (r.status === 200 && r.data.length > 20) {
      const raw = JSON.parse(r.data);
      const arr = Array.isArray(raw) ? raw : (raw.vessels || raw.data || []);
      const ships = arr.slice(0, 3000).map(s => ({
        mmsi:   String(s.mmsi || s.MMSI || ''),
        name:   (s.name || s.SHIPNAME || '').trim(),
        lat:    parseFloat(s.lat || s.LAT || 0),
        lon:    parseFloat(s.lng || s.LON || 0),
        speed:  parseFloat(s.speed || s.SOG || 0),
        course: parseFloat(s.course || s.COG || 0),
        type:   parseInt(s.type || s.SHIPTYPE || 0),
        ts:     Date.now(),
      })).filter(s => s.lat && s.lon && Math.abs(s.lat) <= 90);
      if (ships.length > 0) {
        shipFallback = { data: ships, ts: Date.now() };
        let out = hasBbox ? ships.filter(s=>s.lat>=mstLat1&&s.lat<=mstLat2&&s.lon>=mstLon1&&s.lon<=mstLon2) : ships;
        return res.json({ ships: out.slice(0, 2000), _src: 'myshiptracking', _count: out.length });
      }
    }
  } catch(e) { log('myshiptracking', `error: ${e.message}`); }

  // ── Source E: AISHub public API (limited, no key, returns ~100 ships per area)
  try {
    const aLat = hasBbox ? (minLat + maxLat) / 2 : 51;
    const aLon = hasBbox ? (minLon + maxLon) / 2 : 0;
    const r = await fetchUrl(
      `https://data.aishub.net/ws.php?username=ZZ0&format=1&latmin=${aLat-10}&latmax=${aLat+10}&lonmin=${aLon-15}&lonmax=${aLon+15}&output=json`,
      { timeout: 10000 }
    );
    log('aishub', `HTTP ${r.status}`);
    if (r.status === 200 && r.data.includes('MMSI')) {
      const raw = JSON.parse(r.data);
      const arr = Array.isArray(raw) ? raw.slice(1) : [];  // first element is metadata
      const ships = arr.map(s => ({
        mmsi:   String(s.MMSI || ''),
        name:   (s.NAME || '').trim(),
        lat:    parseFloat(s.LATITUDE || 0),
        lon:    parseFloat(s.LONGITUDE || 0),
        speed:  parseFloat(s.SOG || 0),
        course: parseFloat(s.COG || 0),
        heading: parseFloat(s.HEADING || 511),
        type:   parseInt(s.SHIPTYPE || 0),
        ts:     Date.now(),
      })).filter(s => s.lat && s.lon && Math.abs(s.lat) <= 90 && s.mmsi);
      if (ships.length > 0) {
        shipFallback = { data: ships, ts: Date.now() };
        return res.json({ ships: ships.slice(0, 1000), _src: 'aishub', _count: ships.length });
      }
    }
  } catch(e) { log('aishub', `error: ${e.message}`); }

  // Always serve stale over empty
  if (shipFallback.data) {
    let ships = shipFallback.data;
    if (hasBbox) ships = ships.filter(s=>s.lat>=minLat&&s.lat<=maxLat&&s.lon>=minLon&&s.lon<=maxLon);
    return res.json({ ships: ships.slice(0, 2000), _src: 'stale_cache', _count: ships.length });
  }

  res.json({ ships: [], _src: 'none', _count: 0,
    hint: 'All AIS sources failed — check server logs. Get a free AISSTREAM_KEY at aisstream.io for reliable live data.' });
});


// ─── TLE / SATELLITES ─────────────────────────────────────────────────────────
// 'recon' maps to CelesTrak 'military' group — publicly tracked military
// payloads including USA (NRO), Yaogan (China), Persona (Russia), Helios
// (France), Ofek (Israel), COSMO-SkyMed (Italy), SAR-Lupe (Germany).
const TLE_GROUPS = {
  'stations':'space-stations','space-stations':'space-stations',
  'visual':'visual','starlink':'starlink','weather':'weather',
  'gps':'gps-ops','gps-ops':'gps-ops','geo':'geo',
  'iridium':'iridium-next','active':'active',
  // Reconnaissance / intelligence satellites (publicly tracked)
  'recon':'military','spy':'military','military':'military',
  'radar':'radar',       // SAR + radar-cal sats (often dual-use recon)
  'analyst':'analyst',   // Space-Track analyst catalog (gray/unclassified objects)
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
// GDELT monitors 100+ languages, auto-translates to English, updates every 15min
// Free, no API key — rate limit: roughly 1 req/sec, handle 503 gracefully
const gdeltCache = new Map();
let   gdeltInFlight = new Map(); // prevent duplicate in-flight requests

async function fetchGdelt(url, cacheKey, maxAge) {
  const cached  = gdeltCache.get(cacheKey);
  const isFresh = cached && (Date.now() - cached.ts < maxAge);
  if (isFresh) return { data: cached.data, stale: false };

  if (gdeltInFlight.has(cacheKey)) {
    try { return { data: await gdeltInFlight.get(cacheKey), stale: false }; }
    catch { return { data: cached?.data, stale: true }; }
  }

  const doFetch = async () => {
    // GDELT needs browser-like headers and referer — blocks API-looking clients
    const gdeltHeaders = {
      'User-Agent':   BROWSER_UA,
      'Referer':      'https://www.gdeltproject.org/',
      'Accept':       'application/json, */*',
      'Origin':       'https://www.gdeltproject.org',
      'Cache-Control':'no-cache',
    };
    const r = await fetchUrl(url, { headers: gdeltHeaders, timeout: 25000 });
    if (r.status === 429 || r.status === 503) {
      if (cached) { console.warn(`[GDELT] ${r.status} — serving stale cache`); return cached.data; }
      throw new Error(`GDELT ${r.status} — rate limited, no cache yet`);
    }
    if (r.status !== 200) throw new Error(`GDELT HTTP ${r.status}`);
    const data = JSON.parse(r.data);
    gdeltCache.set(cacheKey, { data, ts: Date.now() });
    return data;
  };

  const promise = doFetch();
  gdeltInFlight.set(cacheKey, promise);
  try {
    const data = await promise;
    gdeltInFlight.delete(cacheKey);
    return { data, stale: false };
  } catch(e) {
    gdeltInFlight.delete(cacheKey);
    if (cached) { console.warn('[GDELT] error, serving stale:', e.message); return { data: cached.data, stale: true }; }
    throw e;
  }
}

app.get('/api/intel/feed', async (req, res) => {
  const keyword  = (req.query.q || '').replace(/[^\w\s"'()|&-]/g, '').trim();
  const timespan = ['1h','6h','12h','24h','7d'].includes(req.query.timespan) ? req.query.timespan : '24h';
  const maxrecs  = Math.min(parseInt(req.query.limit) || 50, 250);
  const query    = keyword || 'war OR attack OR military OR protest OR disaster';
  const cacheKey = `feed_${query}_${timespan}`;

  // Try v2 DOC API first
  let articles = null;
  try {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=${maxrecs}&timespan=${timespan}&sort=DateDesc&format=json`;
    const { data, stale } = await fetchGdelt(url, cacheKey, 5*60*1000);
    articles = data.articles || [];
    if (stale) res.set('X-Cache','stale');
  } catch(e) {
    console.warn('[GDELT v2] failed:', e.message, '— trying v1');
  }

  // Fallback: GDELT v1 full-text search (different endpoint, often works when v2 is down)
  if (!articles) {
    try {
      const v1Key = `v1_${query}_${timespan}`;
      const v1url = `https://api.gdeltproject.org/api/v1/search_ftxtsearch/search?q=${encodeURIComponent(query)}&output=artlist&maxrecords=${maxrecs}&format=json`;
      const { data } = await fetchGdelt(v1url, v1Key, 5*60*1000);
      // v1 uses same article list format
      articles = data.articles || data.artlist || [];
    } catch(e) {
      console.warn('[GDELT v1] also failed:', e.message);
    }
  }

  if (!articles) {
    return res.status(503).json({ articles: [], error: 'GDELT unavailable on both v1 and v2 endpoints', query });
  }

  const mapped = articles.map((a, i) => ({
    id:            i,
    url:           a.url,
    title:         a.title || '(no title)',
    source:        a.domain,
    language:      a.language || 'English',
    country:       a.sourcecountry || '',
    date:          a.seendate,
    tone:          a.tone != null ? parseFloat(a.tone) : null,
  }));

  // Corroboration score
  const titleMap = new Map();
  for (const art of mapped) {
    const key = art.title.toLowerCase().replace(/[^a-z0-9 ]/g,'').split(' ').slice(0,5).join(' ');
    titleMap.set(key, (titleMap.get(key) || 0) + 1);
  }
  for (const art of mapped) {
    const key = art.title.toLowerCase().replace(/[^a-z0-9 ]/g,'').split(' ').slice(0,5).join(' ');
    art.corroboration = titleMap.get(key) || 1;
  }
  mapped.sort((a, b) => b.corroboration - a.corroboration);

  res.set('Cache-Control','max-age=300').json({ articles: mapped, count: mapped.length, query, timespan, ts: Date.now() });
});

// GDELT geographic events — for map pins
app.get('/api/intel/events', async (req, res) => {
  const keyword  = (req.query.q || 'attack protest military').replace(/[^\w\s"'()|&-]/g,'').trim().substring(0, 100);
  const timespan = ['1h','6h','12h','24h','7d'].includes(req.query.timespan) ? req.query.timespan : '24h';
  const cacheKey = `geo_${keyword}_${timespan}`;
  const cacheAge = 15 * 60 * 1000;

  try {
    const url = `https://api.gdeltproject.org/api/v2/geo/geo?query=${encodeURIComponent(keyword)}&mode=pointdata&timespan=${timespan}&format=json&maxrecords=500`;
    const { data } = await fetchGdelt(url, cacheKey, cacheAge);
    const features = (data.features||[]).map(f=>({
      lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0],
      name: f.properties?.name||'', count: f.properties?.count||1,
    })).filter(f=>f.lat&&f.lon);
    const payload = { features, count: features.length, query: keyword, ts: Date.now() };
    res.set('Cache-Control','max-age=900').json(payload);
  } catch(e) { res.status(503).json({ features: [], error: e.message }); }
});

// ─── AI INTELLIGENCE QUERY (Anthropic Claude proxy) ───────────────────────────
app.post('/api/ai/query', async (req, res) => {
  const { query, context } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  const system = `You are NEXUS, an embedded geospatial intelligence analyst. The operator is viewing a live surveillance dashboard with: ADS-B flights, AIS ships, satellite TLE tracks, seismic events, wildfires, GPS jamming data, Meshtastic mesh network nodes, CCTV cameras, and GDELT global news intelligence.
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

// ─── FIRE CAUSE CONTEXT ───────────────────────────────────────────────────────
// Given a fire location, pull GDELT news + RSS to surface likely cause
const fireCauseCache = new Map();
const FIRE_CAUSE_PATTERNS = [
  { cause: 'Lightning Strike',   re: /lightning|thunderstorm|electrical storm/i },
  { cause: 'Agricultural Burn',  re: /agricultural|crop burn|stubble|field burn|controlled burn|prescribed burn|slash.and.burn/i },
  { cause: 'Arson / Deliberate', re: /arson|deliberately set|suspected arson|incendiary|intentional/i },
  { cause: 'Power Line / Infrastructure', re: /power line|utility|electricity|transformer|sparks?|downed wire/i },
  { cause: 'Industrial / Factory', re: /factory|industrial|plant|refinery|warehouse|explosion/i },
  { cause: 'Drought / Climate',  re: /drought|heat wave|heatwave|climate|dry condition|record heat|hot.dry/i },
  { cause: 'Military / Conflict',re: /conflict|war|attack|shelling|airstrike|bombing|military operation/i },
  { cause: 'Campfire / Human',   re: /campfire|campsite|human|accidental|negligence|cigarette/i },
];

function classifyFireCause(text) {
  for (const pat of FIRE_CAUSE_PATTERNS) {
    if (pat.re.test(text)) return pat.cause;
  }
  return 'Unknown / Under Investigation';
}

app.get('/api/fire/context', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const frp = parseFloat(req.query.frp) || 0;
  if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'lat/lon required' });

  const cacheKey = `fire_${lat.toFixed(1)}_${lon.toFixed(1)}`;
  const cached = fireCauseCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return res.json(cached.data);

  // Approximate country/region from GDELT query
  // GDELT V2 DOC API — search for fire news near this location in past 7 days
  const results = { articles: [], cause: 'Unknown / Under Investigation', frpClass: '', weather: null };

  // FRP classification
  if (frp > 1000) results.frpClass = 'Extreme (>1000 MW) — major wildfire';
  else if (frp > 300) results.frpClass = 'High (300–1000 MW) — large fire';
  else if (frp > 50) results.frpClass = 'Moderate (50–300 MW)';
  else results.frpClass = 'Low (<50 MW) — small fire or agricultural burn';

  try {
    // GDELT V2: search within 1 degree of the fire location
    const latMin = (lat - 1).toFixed(2), latMax = (lat + 1).toFixed(2);
    const lonMin = (lon - 1).toFixed(2), lonMax = (lon + 1).toFixed(2);
    const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=fire+OR+wildfire+OR+blaze&mode=artlist&maxrecords=10&timespan=7d&format=json&geoloc=${lat.toFixed(2)},${lon.toFixed(2)},100`;
    const r = await fetchUrl(gdeltUrl, { timeout: 10000 });
    if (r.status === 200) {
      const d = JSON.parse(r.data);
      const arts = d.articles || [];
      const combined = arts.map(a => `${a.title} ${a.seendescription || ''}`).join(' ');
      results.cause = classifyFireCause(combined) !== 'Unknown / Under Investigation'
        ? classifyFireCause(combined)
        : results.cause;
      results.articles = arts.slice(0, 5).map(a => ({
        title: (a.title || '').substring(0, 120),
        url: a.url,
        source: a.domain,
        date: a.seendate,
        cause: classifyFireCause(`${a.title} ${a.seendescription || ''}`),
      }));
    }
  } catch(e) { console.warn('[FireContext] GDELT:', e.message); }

  // Also search our RSS cache for nearby fire news
  try {
    for (const [, cache] of osintCache) {
      if (!cache || !cache.posts) continue;
      for (const p of cache.posts.slice(0, 50)) {
        const txt = `${p.title} ${p.description || ''}`;
        if (/fire|wildfire|blaze|burn/i.test(txt)) {
          const cause = classifyFireCause(txt);
          if (cause !== 'Unknown / Under Investigation' && results.cause === 'Unknown / Under Investigation') {
            results.cause = cause;
          }
        }
      }
    }
  } catch {}

  fireCauseCache.set(cacheKey, { data: results, ts: Date.now() });
  setTimeout(() => fireCauseCache.delete(cacheKey), 30 * 60 * 1000);
  res.json(results);
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
  // Try today, then yesterday, then two days ago — gpsjam.org publishes with a lag
  const datesToTry = [d,
    new Date(Date.now()-86400000).toISOString().substring(0,10),
    new Date(Date.now()-172800000).toISOString().substring(0,10),
  ];
  let lastErr = 'no data';
  for (const tryDate of datesToTry) {
    try {
      const r = await fetchUrl(`https://gpsjam.org/data/jamming-${tryDate}.csv`, {
        headers: {
          'Referer': 'https://gpsjam.org/',
          'Origin':  'https://gpsjam.org',
          'Accept':  'text/csv,text/plain,*/*',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
        },
      });
      if (r.status !== 200) { lastErr = `HTTP ${r.status} for ${tryDate}`; continue; }
      if (!r.data || r.data.length < 50) { lastErr = `empty response for ${tryDate}`; continue; }
      const hexes = r.data.trim().split('\n')
        .filter(l => l && !l.startsWith('#') && l.includes(','))
        .map(l => { const p = l.split(','); return { h: p[0]?.trim(), p: Math.round(parseFloat(p[1])) }; })
        .filter(h => h.h && !isNaN(h.p) && h.p >= 2);
      if (hexes.length === 0) { lastErr = `0 hexes parsed for ${tryDate}`; continue; }
      jammingCache = { data: { date: tryDate, count: hexes.length, hexes }, ts: Date.now(), date: tryDate };
      console.log(`[Jamming] ${hexes.length} hexes for ${tryDate}`);
      return res.set('Cache-Control','max-age=3600').json(jammingCache.data);
    } catch(e) { lastErr = e.message; }
  }
  res.status(503).json({ error: lastErr, hexes: [], hint: 'gpsjam.org may be blocking server-side requests — try from a residential IP' });
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
app.get('/api/status', (req,res) => res.json({ name:'NEXUS', shodan:!!(process.env.SHODAN_API_KEY), aisstream:!!(process.env.AISSTREAM_KEY), ws_connected:wsConnection?.readyState===1, ship_count:shipPositions.size, version:'7.0' }));
app.get('/api/health', (req,res) => res.json({ status:'ok', ts:new Date().toISOString(), version:'7.0' }));

app.get('/api/debug/sources', async (req,res) => {
  const out = { ts:Date.now(), version:'7.0', sources:{} };
  try { const r=await fetchUrl('https://api.adsb.lol/v2/lat/51.5/lon/-0.1/dist/50',{timeout:8000}); const d=r.status===200?JSON.parse(r.data):{}; out.sources.adsblol={ok:r.status===200,status:r.status,count:(d.ac||[]).length}; } catch(e) { out.sources.adsblol={ok:false,error:e.message}; }
  try { const r=await fetchUrl('https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle',{timeout:10000}); out.sources.celestrak={ok:r.status===200,status:r.status,lines:r.status===200?r.data.split('\n').length:0}; } catch(e) { out.sources.celestrak={ok:false,error:e.message}; }
  try { const r=await fetchUrl('https://api.gdeltproject.org/api/v2/doc/doc?query=conflict&mode=artlist&maxrecords=3&timespan=1h&format=json',{timeout:10000}); const d=r.status===200?JSON.parse(r.data):{}; out.sources.gdelt={ok:r.status===200,count:(d.articles||[]).length}; } catch(e) { out.sources.gdelt={ok:false,error:e.message}; }
  out.sources.ships={aisstream_key:!!(process.env.AISSTREAM_KEY),ws_connected:wsConnection?.readyState===1,cached:shipPositions.size};
  res.json(out);
});

// ─── ENTITY ENRICHMENT ────────────────────────────────────────────────────────
// Auto-pull all available public info for any tracked entity
const enrichCache = new Map();
function getCached(key, maxAgeMs=300000) {
  const c = enrichCache.get(key);
  return (c && Date.now()-c.ts < maxAgeMs) ? c.data : null;
}
function setCache(key, data) { enrichCache.set(key, { data, ts:Date.now() }); return data; }

// Aircraft enrichment: ADSBDB (free, no key) + OpenSky metadata
app.get('/api/enrich/aircraft/:hex', async (req, res) => {
  const hex = req.params.hex.toLowerCase().replace(/[^a-f0-9]/g,'');
  if (!hex) return res.status(400).json({error:'bad hex'});
  const ck = `ac_${hex}`;
  const cached = getCached(ck, 3600000); // 1hr cache - registration rarely changes
  if (cached) return res.json(cached);

  const result = { hex, sources:[] };

  // 1 — ADSBDB (free aircraft registration database, no key needed)
  try {
    const r = await fetchUrl(`https://api.adsbdb.com/v0/aircraft/${hex}`, { timeout:8000 });
    if (r.status === 200) {
      const d = JSON.parse(r.data);
      const ac = d.response?.aircraft;
      if (ac) {
        result.registration     = ac.registration || null;
        result.type_code        = ac.type || null;
        result.type_full        = ac.type_longname || null;
        result.manufacturer     = ac.manufacturer || null;
        result.operator         = ac.registered_owner || null;
        result.operator_code    = ac.registered_owner_operator_flag_code || null;
        result.country          = ac.registered_owner_country_name || null;
        result.country_iso      = ac.registered_owner_country_iso_name || null;
        result.photo_url        = ac.url_photo_thumbnail || null;
        result.photo_full       = ac.url_photo || null;
        result.sources.push('adsbdb');
      }
    }
  } catch(e) { console.warn('[Enrich AC]', e.message); }

  // 2 — OpenSky metadata (aircraft type & operator confirmation)
  try {
    const r = await fetchUrl(`https://opensky-network.org/api/metadata/aircraft/icao/${hex}`, { timeout:8000 });
    if (r.status === 200) {
      const d = JSON.parse(r.data);
      if (d.icao24) {
        result.registration    = result.registration || d.registration;
        result.type_code       = result.type_code || d.typecode;
        result.operator        = result.operator || d.operatorcallsign;
        result.operator_iata   = d.operatoriata || null;
        result.operator_icao   = d.operatoricao || null;
        result.owner           = d.owner || null;
        result.built_year      = d.built ? new Date(d.built).getFullYear() : null;
        result.engines         = d.engines || null;
        result.sources.push('opensky');
      }
    }
  } catch(e) {}

  res.json(setCache(ck, result));
});

// Callsign enrichment: route data (origin → destination)
app.get('/api/enrich/callsign/:callsign', async (req, res) => {
  const cs = req.params.callsign.toUpperCase().replace(/[^A-Z0-9]/g,'');
  if (!cs) return res.status(400).json({error:'bad callsign'});
  const ck = `cs_${cs}`;
  const cached = getCached(ck, 1800000); // 30min
  if (cached) return res.json(cached);
  try {
    const r = await fetchUrl(`https://api.adsbdb.com/v0/callsign/${cs}`, { timeout:8000 });
    if (r.status !== 200) return res.json({});
    const d = JSON.parse(r.data);
    const fl = d.response?.flightroute;
    if (!fl) return res.json({});
    const result = {
      callsign: cs,
      origin: fl.origin ? { iata:fl.origin.iata_code, icao:fl.origin.icao_code, name:fl.origin.name, country:fl.origin.country?.name, lat:fl.origin.latitude, lon:fl.origin.longitude } : null,
      destination: fl.destination ? { iata:fl.destination.iata_code, icao:fl.destination.icao_code, name:fl.destination.name, country:fl.destination.country?.name, lat:fl.destination.latitude, lon:fl.destination.longitude } : null,
      operator: fl.airline?.name || null,
    };
    res.json(setCache(ck, result));
  } catch(e) { res.json({}); }
});

// Ship enrichment: decode MMSI structure + fetch public vessel data
const MID_COUNTRY = {
  '201':'Albania','202':'Andorra','203':'Austria','204':'Portugal (Azores)','205':'Belgium','206':'Belarus','207':'Bulgaria','208':'Vatican','209':'Cyprus','210':'Cyprus','212':'Cyprus','215':'Malta','218':'Germany','219':'Denmark','220':'Denmark','224':'Spain','225':'Spain','226':'France','227':'France','228':'France','229':'Malta','230':'Finland','231':'Faroe Islands','232':'United Kingdom','233':'United Kingdom','234':'United Kingdom','235':'United Kingdom','236':'Gibraltar','237':'Greece','238':'Croatia','239':'Greece','240':'Greece','241':'Greece','242':'Morocco','243':'Hungary','244':'Netherlands','245':'Netherlands','246':'Netherlands','247':'Italy','248':'Malta','249':'Malta','250':'Ireland','251':'Iceland','252':'Liechtenstein','253':'Luxembourg','254':'Monaco','255':'Portugal (Madeira)','256':'Malta','257':'Norway','258':'Norway','259':'Norway','261':'Poland','262':'Montenegro','263':'Portugal','264':'Romania','265':'Sweden','266':'Sweden','267':'Slovakia','268':'San Marino','269':'Switzerland','270':'Czech Republic','271':'Turkey','272':'Ukraine','273':'Russia','274':'North Macedonia','275':'Latvia','276':'Estonia','277':'Lithuania','278':'Slovenia','279':'Serbia','301':'Anguilla','303':'USA (Alaska)','304':'Antigua and Barbuda','305':'Antigua and Barbuda','306':'Curaçao / St Maarten','307':'Aruba','308':'Bahamas','309':'Bahamas','310':'Bermuda','311':'Bahamas','312':'Belize','314':'Barbados','316':'Canada','319':'Cayman Islands','321':'Costa Rica','323':'Cuba','325':'Dominica','327':'Dominican Republic','329':'Guadeloupe','330':'Grenada','331':'Greenland','332':'Guatemala','334':'Honduras','336':'Haiti','338':'United States','339':'United States','341':'Jamaica','343':'Saint Kitts and Nevis','345':'Saint Lucia','347':'Mexico','348':'Martinique','350':'Nicaragua','351':'Panama','352':'Panama','353':'Panama','354':'Panama','355':'Panama','356':'Panama','357':'Panama','358':'Puerto Rico','359':'El Salvador','361':'Saint Pierre and Miquelon','362':'Trinidad and Tobago','364':'Turks and Caicos','366':'United States','367':'United States','368':'United States','369':'United States','370':'Panama','371':'Panama','372':'Panama','373':'Panama','374':'Panama','375':'Saint Vincent','376':'Virgin Islands (BVI)','377':'Virgin Islands (US)','378':'Barbados','379':'Saint Kitts and Nevis','401':'Afghanistan','403':'Saudi Arabia','405':'Bangladesh','408':'Bahrain','410':'Bhutan','412':'China','413':'China','414':'China','416':'Taiwan','419':'Sri Lanka','422':'Iran','423':'Azerbaijan','425':'Iraq','428':'Israel','431':'Japan','432':'Japan','434':'Turkmenistan','436':'Kazakhstan','437':'Uzbekistan','438':'Jordan','440':'South Korea','441':'South Korea','443':'Palestine','445':'North Korea','447':'Kuwait','450':'Lebanon','451':'Kyrgyzstan','453':'Macao','455':'Maldives','457':'Mongolia','459':'Nepal','461':'Oman','463':'Pakistan','466':'Qatar','468':'Syria','470':'United Arab Emirates','472':'Tajikistan','473':'Yemen','477':'Hong Kong','478':'Bosnia and Herzegovina','501':'Antarctica','503':'Australia','506':'Myanmar','508':'Brunei','510':'Micronesia','511':'Palau','512':'New Zealand','514':'Cambodia','515':'Cambodia','516':'Christmas Island','518':'Cook Islands','520':'Fiji','523':'Cocos Islands','525':'Indonesia','529':'Kiribati','531':'Laos','533':'Malaysia','536':'Northern Mariana Islands','538':'Marshall Islands','540':'New Caledonia','542':'Niue','544':'Nauru','546':'French Polynesia','548':'Philippines','550':'East Timor','553':'Papua New Guinea','555':'Pitcairn Islands','557':'Solomon Islands','559':'American Samoa','561':'Samoa','563':'Singapore','564':'Singapore','565':'Singapore','566':'Singapore','567':'Thailand','570':'Tonga','572':'Tuvalu','574':'Vietnam','576':'Vanuatu','577':'Wallis and Futuna','578':'Tuvalu','601':'South Africa','603':'Angola','605':'Algeria','607':'Saint Paul Island','608':'Burundi','609':'Benin','610':'Botswana','611':'Comoros','612':'Cameroon','613':'Cape Verde','615':'Congo','616':'Comoros','617':'Djibouti','618':'Kerguelen','619':'Ivory Coast','620':'Madagascar','621':'Mali','622':'Mozambique','624':'Zambia','625':'Tanzania','626':'Nigeria','627':'Namibia','629':'Senegal','630':'Somalia','631':'Togo','632':'Mauritania','633':'Morocco','634':'Egypt','635':'Tunisia','636':'Liberia','637':'Liberia','638':'Libya','642':'Ethiopia','644':'Gambia','645':'Ghana','647':'Reunion','649':'Kenya','650':'Eritrea','654':'Malawi','655':'Mauritius','656':'Chad','657':'Tanzania','659':'Rwanda','660':'Sierra Leone','661':'Somalia','663':'Sudan','664':'Seychelles','665':'Swaziland','666':'South Sudan','667':'Saint Helena','668':'Uganda','669':'Zimbabwe','670':'Sudan','671':'Guinea','672':'Zimbabwe','674':'Democratic Republic of Congo','675':'Equatorial Guinea','676':'Gabon','677':'Burkina Faso','678':'Central African Republic','679':'Guinea-Bissau','701':'Argentina','710':'Brazil','720':'Bolivia','725':'Chile','730':'Colombia','735':'Ecuador','740':'Falkland Islands','745':'French Guiana','750':'Guyana','755':'Paraguay','760':'Peru','765':'Suriname','770':'Uruguay','775':'Venezuela',
};

function decodeMmsi(mmsi) {
  const s = String(mmsi).padStart(9,'0');
  const mid = s.substring(0,3);
  let type = 'Ship', special = null;
  if (s.startsWith('00'))      { type='Coast Station'; }
  else if (s.startsWith('0'))  { type='Group Call'; }
  else if (s.startsWith('111')){ type='SAR Aircraft'; }
  else if (s.startsWith('970')){ type='SAR Device'; }
  else if (s.startsWith('972')){ type='Man Overboard'; }
  else if (s.startsWith('974')){ type='EPIRB'; }
  else if (s.startsWith('99')) { type='AtoN Buoy/Beacon'; }
  else if (s.startsWith('98')) { type='Craft w/ Parent Ship'; }
  const mid3 = s.startsWith('111') ? s.substring(3,6) : mid;
  const country = MID_COUNTRY[mid3] || MID_COUNTRY[mid] || 'Unknown';
  return { type, country, mid: mid3, mmsi: s };
}

app.get('/api/enrich/ship/:mmsi', async (req, res) => {
  const mmsi = req.params.mmsi.replace(/\D/g,'');
  if (!mmsi || mmsi.length < 7) return res.status(400).json({error:'bad mmsi'});
  const ck = `ship_${mmsi}`;
  const cached = getCached(ck, 600000); // 10 min
  if (cached) return res.json(cached);

  const result = { mmsi, ...decodeMmsi(mmsi), sources:['mmsi_decode'] };

  // Try VesselFinder vessel detail (public HTML endpoint)
  try {
    const r = await fetchUrl(`https://www.vesselfinder.com/vessels/details/${mmsi}`, {
      headers: { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0', 'Accept':'text/html,application/xhtml+xml', 'Referer':'https://www.vesselfinder.com/' },
      timeout: 10000,
    });
    if (r.status === 200 && r.data.includes('IMO')) {
      const html = r.data;
      const extract = (re) => { const m = html.match(re); return m ? m[1].trim() : null; };
      result.imo       = extract(/IMO[:\s]+(\d{7})/i);
      result.flag      = extract(/[Ff]lag[:\s"]+([A-Za-z\s]+)["<]/);
      result.built     = extract(/[Bb]uilt[:\s"]+(\d{4})/);
      result.length    = extract(/[Ll]ength[:\s"]+(\d+)/);
      result.beam      = extract(/[Bb]eam[:\s"]+(\d+)/);
      result.dwt       = extract(/DWT[:\s"]+([0-9,]+)/);
      result.gt        = extract(/GT[:\s"]+([0-9,]+)/);
      result.type_desc = extract(/class="[^"]*type[^"]*"[^>]*>([^<]+)/i);
      const hasData = result.imo || result.flag || result.built;
      if (hasData) result.sources.push('vesselfinder');
    }
  } catch(e) {}

  // Try MarineTraffic vessel page
  try {
    const r = await fetchUrl(`https://www.marinetraffic.com/en/ais/details/ships/mmsi:${mmsi}`, {
      headers: { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0', 'Accept':'text/html', 'Referer':'https://www.marinetraffic.com/' },
      timeout: 10000,
    });
    if (r.status === 200) {
      const m = r.data.match(/<title>([^<]+)<\/title>/i);
      if (m && !result.name) result.name = m[1].replace(/- MarineTraffic.*/i,'').trim();
      const dest = r.data.match(/[Dd]estination[:\s"]+([A-Z\s]+)["<]/);
      if (dest) result.destination = dest[1].trim();
      result.sources.push('marinetraffic');
    }
  } catch(e) {}

  res.json(setCache(ck, result));
});

// Satellite enrichment: CelesTrak SATCAT + compute orbital elements from TLE
app.get('/api/enrich/satellite/:norad', async (req, res) => {
  const norad = req.params.norad.replace(/\D/g,'');
  if (!norad) return res.status(400).json({error:'bad norad'});
  const ck = `sat_${norad}`;
  const cached = getCached(ck, 3600000); // 1hr
  if (cached) return res.json(cached);

  const result = { norad_id: norad, sources:[] };

  // CelesTrak SATCAT — public, no key needed
  try {
    const r = await fetchUrl(`https://celestrak.org/satcat/query.php?CATNR=${norad}&FORMAT=json`, { timeout:10000 });
    if (r.status === 200) {
      const d = JSON.parse(r.data);
      const s = Array.isArray(d) ? d[0] : d;
      if (s) {
        result.name         = s.OBJECT_NAME;
        result.int_designator = s.OBJECT_ID;
        result.norad_id     = s.NORAD_CAT_ID || norad;
        result.object_type  = s.OBJECT_TYPE;
        result.rcs_size     = s.RCS_SIZE;
        result.country      = s.COUNTRY_CODE;
        result.launch_date  = s.LAUNCH_DATE;
        result.launch_site  = s.SITE;
        result.decay_date   = s.DECAY_DATE || null;
        result.period_min   = s.PERIOD ? parseFloat(s.PERIOD).toFixed(2) : null;
        result.apoapsis_km  = s.APOAPSIS ? parseFloat(s.APOAPSIS).toFixed(0) : null;
        result.periapsis_km = s.PERIAPSIS ? parseFloat(s.PERIAPSIS).toFixed(0) : null;
        result.inclination  = s.INCLINATION ? parseFloat(s.INCLINATION).toFixed(2) : null;
        result.eccentricity = s.ECCENTRICITY ? parseFloat(s.ECCENTRICITY).toFixed(6) : null;
        result.classification = s.CLASSIFICATION_TYPE;
        result.sources.push('celestrak_satcat');
      }
    }
  } catch(e) { console.warn('[Enrich Sat]', e.message); }

  // Derive orbital info if we have period
  if (result.period_min) {
    const p = parseFloat(result.period_min);
    const meanAlt = result.apoapsis_km && result.periapsis_km
      ? ((parseFloat(result.apoapsis_km) + parseFloat(result.periapsis_km)) / 2).toFixed(0)
      : null;
    result.mean_altitude_km = meanAlt;
    result.orbits_per_day   = (1440 / p).toFixed(2);
    result.orbital_regime   = p < 128 ? 'LEO' : p < 600 ? 'MEO' : p < 1500 ? 'HEO' : 'GEO';
    // Semi-major axis from period (Kepler's 3rd law): a = (μ * T²/4π²)^(1/3)
    const mu = 398600.4418; // km³/s²
    const T_sec = p * 60;
    const a = Math.pow((mu * T_sec * T_sec) / (4 * Math.PI * Math.PI), 1/3);
    result.semi_major_axis_km = a.toFixed(0);
    // Velocity at mean altitude (circular orbit approximation): v = sqrt(μ/a)
    result.orbital_velocity_kms = Math.sqrt(mu / a).toFixed(3);
  }

  res.json(setCache(ck, result));
});

app.get('/api/debug/ships', async (req, res) => {
  const results = {};
  const test = async (name, url, hdrs={}) => {
    try {
      const r = await fetchUrl(url, { headers: hdrs, timeout: 10000 });
      results[name] = { status: r.status, bytes: r.data.length, preview: r.data.substring(0,100) };
    } catch(e) { results[name] = { error: e.message }; }
  };
  await test('digitraffic_locations', 'https://meri.digitraffic.fi/api/ais/v1/locations', { 'Digitraffic-User': 'NEXUS/7.0' });
  await test('kystverket',  'https://kystdatahuset.no/ws/api/ais/positions/all', { 'Referer':'https://kystdatahuset.no/' });
  await test('vesselfinder','https://www.vesselfinder.com/api/pub/vesselsonmap/area?minlat=50&minlon=-5&maxlat=60&maxlon=10&z=5', { 'Referer':'https://www.vesselfinder.com/' });
  await test('gdelt_v2', 'https://api.gdeltproject.org/api/v2/doc/doc?query=war&mode=artlist&maxrecords=2&timespan=1h&format=json', { 'Referer':'https://www.gdeltproject.org/' });
  res.json({ ts: new Date().toISOString(), shipCache: shipPositions.size, fallbackAge: shipFallback.ts ? Date.now()-shipFallback.ts : null, results });
});

// ─── GLOBAL FLIGHTS (multi-region parallel fetch) ────────────────────────────
let globalFlightCache = { data: null, ts: 0 };

app.get('/api/flights/global', async (req, res) => {
  if (globalFlightCache.data && Date.now() - globalFlightCache.ts < 10000)
    return res.json(globalFlightCache.data);

  // Try OpenSky global first (no geo filter, returns all states)
  try {
    const r = await fetchUrl('https://opensky-network.org/api/states/all', { timeout: 18000 });
    if (r.status === 200) {
      const data = JSON.parse(r.data);
      if ((data.states || []).length > 0) {
        const payload = { states: data.states, _src: 'opensky_global', _count: data.states.length, time: data.time || Math.floor(Date.now()/1000) };
        globalFlightCache = { data: payload, ts: Date.now() };
        console.log(`[GlobalFlights] OpenSky: ${data.states.length} aircraft`);
        return res.json(payload);
      }
    }
  } catch(e) { console.warn('[GlobalFlights] OpenSky failed:', e.message); }

  // Fallback: parallel adsb.lol calls at 10 strategic world regions
  const REGIONS = [
    [40, -95], [51, 10], [35, 100], [20, 77], [-10, 140],
    [-10, 25], [-20, -60], [60, 50], [25, 55], [35, -10],
  ];
  const allStates = new Map();
  await Promise.allSettled(REGIONS.map(async ([lat, lon]) => {
    try {
      const r = await fetchUrl(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/250`, { timeout: 10000 });
      if (r.status === 200) {
        const d = JSON.parse(r.data);
        for (const ac of (d.ac || [])) {
          const icao = (ac.hex || '').toLowerCase();
          if (!icao || allStates.has(icao)) continue;
          allStates.set(icao, [
            icao, (ac.flight||'').trim(), ac.r||'',
            Math.floor(Date.now()/1000), Math.floor(Date.now()/1000),
            ac.lon??null, ac.lat??null,
            ac.alt_baro != null ? (ac.alt_baro==='ground' ? 0 : Math.round(ac.alt_baro*0.3048)) : null,
            ac.alt_baro==='ground'||false,
            ac.gs!=null ? Math.round(ac.gs*0.514444) : null,
            ac.track??null, null, null,
            ac.alt_geom!=null ? Math.round(ac.alt_geom*0.3048) : null,
            ac.squawk||null, false, 0, ac.category||ac.t||null, false,
          ]);
        }
      }
    } catch {}
  }));
  const states = [...allStates.values()].filter(s => s[5]!=null && s[6]!=null);
  const payload = { states, _src: 'adsblol_multiregion', _count: states.length, time: Math.floor(Date.now()/1000) };
  globalFlightCache = { data: payload, ts: Date.now() };
  console.log(`[GlobalFlights] multi-region: ${states.length} aircraft`);
  res.json(payload);
});

// ─── OSINT SOCIAL FEED ────────────────────────────────────────────────────────
const osintCache = new Map();

// Simple RSS/Atom parser
function parseRSS(xml) {
  const items = [];
  const getTag = (str, tag) => {
    const m = str.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() : '';
  };
  const getLink = (str) => {
    const m = str.match(/<link[^>]*href="([^"]+)"|<link[^>]*>([^<]+)<\/link>/i);
    return m ? (m[1]||m[2]||'').trim() : '';
  };
  const getDate = (str) => {
    const m = str.match(/<pubDate[^>]*>([^<]+)<\/pubDate>|<published[^>]*>([^<]+)<\/published>|<updated[^>]*>([^<]+)<\/updated>/i);
    try { return m ? new Date(m[1]||m[2]||m[3]).getTime() : Date.now(); } catch { return Date.now(); }
  };
  const itemRe = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g;
  let match;
  while ((match = itemRe.exec(xml)) !== null) {
    const it = match[1];
    const title = getTag(it, 'title');
    if (!title) continue;
    items.push({ title, link: getLink(it), date: getDate(it), description: (getTag(it,'description')||getTag(it,'summary')).substring(0,200) });
  }
  return items;
}

const RSS_FEEDS = [
  // Major international outlets
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',           name: 'BBC World',       lang: 'en' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml',             name: 'Al Jazeera',      lang: 'en' },
  { url: 'https://feeds.skynews.com/feeds/rss/world.xml',         name: 'Sky News',        lang: 'en' },
  { url: 'https://www.theguardian.com/world/rss',                 name: 'The Guardian',    lang: 'en' },
  { url: 'https://rss.dw.com/rdf/rss-en-world',                   name: 'DW World',        lang: 'en' },
  { url: 'https://feeds.npr.org/1004/rss.xml',                    name: 'NPR News',        lang: 'en' },
  { url: 'https://www.france24.com/en/rss',                       name: 'France 24',       lang: 'en' },
  { url: 'https://rss.rferl.org/en/rss',                          name: 'RFE/RL',          lang: 'en' },
  { url: 'https://feeds.reuters.com/reuters/worldnews',           name: 'Reuters World',   lang: 'en' },
  { url: 'https://apnews.com/rss',                                name: 'AP News',         lang: 'en' },
  // Conflict & military monitoring
  { url: 'https://www.bellingcat.com/feed/',                      name: 'Bellingcat',      lang: 'en' },
  { url: 'https://www.understandingwar.org/feeds/rss-news',       name: 'ISW',             lang: 'en' },
  { url: 'https://liveuamap.com/rss',                             name: 'LiveUAMap',       lang: 'en' },
  { url: 'https://ukranews.com/en/rss/all',                       name: 'UkraNews',        lang: 'en' },
  { url: 'https://euromaidan.rssing.com/chan-14928654/index.rss', name: 'Euromaidan',      lang: 'en' },
  { url: 'https://www.timesofisrael.com/feed/',                   name: 'Times of Israel', lang: 'en' },
  { url: 'https://www.haaretz.com/cmlink/1.628765',               name: 'Haaretz',         lang: 'en' },
  { url: 'https://english.alarabiya.net/tools/rss',               name: 'Al Arabiya',      lang: 'en' },
  { url: 'https://www.middleeasteye.net/rss',                     name: 'Middle East Eye', lang: 'en' },
  // Regional
  { url: 'https://www.kyivindependent.com/rss',                   name: 'Kyiv Independent','lang': 'en' },
  { url: 'https://www.themoscowtimes.com/rss/news',               name: 'Moscow Times',    lang: 'en' },
  { url: 'https://www.dawn.com/feeds/home',                       name: 'Dawn (Pakistan)', lang: 'en' },
  { url: 'https://www.globaltimes.cn/rss/outbrain.xml',           name: 'Global Times',    lang: 'en' },
];

// Country name → approximate centroid [lat, lon] for geo-tagging posts
// Used to place post markers on the globe
const COUNTRY_CENTROIDS = {
  'ukraine': [49.0, 32.0], 'russia': [60.0, 100.0], 'kyiv': [50.45, 30.52],
  'moscow': [55.75, 37.62], 'kharkiv': [49.99, 36.25], 'kherson': [46.63, 32.62],
  'zaporizhzhia': [47.83, 35.14], 'bakhmut': [48.60, 38.0], 'mariupol': [47.10, 37.55],
  'odesa': [46.48, 30.73], 'crimea': [45.3, 34.0], 'donbas': [48.5, 38.5],
  'israel': [31.5, 34.75], 'gaza': [31.35, 34.30], 'tel aviv': [32.08, 34.78],
  'jerusalem': [31.77, 35.22], 'west bank': [31.9, 35.2], 'lebanon': [33.88, 35.50],
  'beirut': [33.89, 35.5], 'syria': [35.0, 38.0], 'damascus': [33.51, 36.29],
  'iran': [32.5, 53.7], 'tehran': [35.69, 51.39], 'iraq': [33.0, 44.0],
  'baghdad': [33.34, 44.40], 'saudi arabia': [24.0, 45.0], 'riyadh': [24.69, 46.72],
  'yemen': [15.5, 47.5], 'sanaa': [15.35, 44.21], 'houthi': [15.0, 44.0],
  'turkey': [39.0, 35.0], 'ankara': [39.93, 32.86], 'istanbul': [41.01, 28.96],
  'china': [35.0, 105.0], 'beijing': [39.91, 116.39], 'taiwan': [23.7, 121.0],
  'north korea': [40.0, 127.0], 'pyongyang': [39.03, 125.75],
  'south korea': [37.0, 128.0], 'japan': [36.0, 138.0], 'tokyo': [35.68, 139.69],
  'india': [20.0, 77.0], 'new delhi': [28.61, 77.21], 'pakistan': [30.0, 70.0],
  'afghanistan': [33.0, 65.0], 'kabul': [34.52, 69.18],
  'united states': [38.0, -97.0], 'washington': [38.91, -77.01],
  'france': [46.0, 2.0], 'paris': [48.85, 2.35], 'germany': [51.0, 10.0],
  'berlin': [52.52, 13.41], 'uk': [55.0, -3.0], 'london': [51.51, -0.13],
  'poland': [52.0, 20.0], 'warsaw': [52.23, 21.01], 'finland': [64.0, 26.0],
  'nato': [50.0, 15.0], 'eu': [50.0, 10.0], 'un': [40.75, -73.97],
  'ethiopia': [9.0, 40.0], 'somalia': [6.0, 46.0], 'sudan': [15.0, 30.0],
  'libya': [27.0, 17.0], 'tripoli': [32.9, 13.18], 'egypt': [27.0, 30.0],
  'cairo': [30.06, 31.25], 'venezuela': [8.0, -66.0], 'colombia': [4.0, -72.0],
  'myanmar': [17.0, 96.0], 'rangoon': [16.87, 96.15],
};

// Simple geo-tagger: scan title for country/city names
function geoTagPost(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  for (const [term, coords] of Object.entries(COUNTRY_CENTROIDS)) {
    if (t.includes(term)) return { country: term.charAt(0).toUpperCase() + term.slice(1), lat: coords[0], lon: coords[1] };
  }
  return null;
}

const REDDIT_SUBS = ['worldnews','geopolitics','news','ukraine','europe','MiddleEast','worldpolitics','NATOpress'];

// Simple language detection
function detectLang(text) {
  if (!text) return 'en';
  if (/[\u0400-\u04FF]/.test(text)) return 'ru';
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
  if (/[\u0590-\u05FF]/.test(text)) return 'he';
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  if (/[\u0E00-\u0E7F]/.test(text)) return 'th';
  return 'en';
}

const STOPWORDS = new Set(['about','after','again','against','all','also','although','among','another','around','because','before','being','between','could','during','every','first','following','from','have','here','just','like','more','most','much','next','only','other','over','same','since','some','such','than','that','their','them','then','there','these','they','this','those','through','under','until','very','want','when','where','which','while','will','with','within','without','would','says','said','have','been','were','what','into','from','over','back','year','would','there','their','news','report','new','shows']);

function computeCorroboration(posts) {
  const kwSets = posts.map(p => {
    const words = (p.title||'').toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(w => w.length > 4 && !STOPWORDS.has(w));
    const bigrams = [];
    for (let i = 0; i < words.length-1; i++) bigrams.push(`${words[i]}_${words[i+1]}`);
    return new Set([...words, ...bigrams]);
  });
  return posts.map((p, i) => {
    let corr = 1;
    for (let j = 0; j < posts.length; j++) {
      if (i===j) continue;
      let overlap = 0;
      for (const kw of kwSets[i]) { if (kwSets[j].has(kw)) overlap++; }
      if (overlap >= 2) corr++;
    }
    return { ...p, corroboration: corr };
  });
}

app.get('/api/osint/feed', async (req, res) => {
  const keyword = (req.query.q || '').toLowerCase().replace(/[^\w\s-]/g, '').trim();

  // Geo bbox filtering (from viewport)
  const minLat = parseFloat(req.query.minLat);
  const maxLat = parseFloat(req.query.maxLat);
  const minLon = parseFloat(req.query.minLon);
  const maxLon = parseFloat(req.query.maxLon);
  const hasBbox = !isNaN(minLat) && !isNaN(maxLat) && !isNaN(minLon) && !isNaN(maxLon);
  const bboxKey = hasBbox ? `${minLat.toFixed(1)}_${maxLat.toFixed(1)}_${minLon.toFixed(1)}_${maxLon.toFixed(1)}` : 'global';

  const bucket = Math.floor(Date.now() / 120000); // 2-min cache buckets
  const cacheKey = `osint_${keyword}_${bboxKey}_${bucket}`;
  const cached = osintCache.get(cacheKey);
  if (cached) return res.json(cached);

  const allPosts = [];

  // Parallel Reddit fetches
  const redditTasks = REDDIT_SUBS.map(sub => fetchUrl(
    `https://www.reddit.com/r/${sub}/new.json?limit=30&t=day`,
    { headers: { 'Accept': 'application/json', 'User-Agent': 'NEXUS/7.0 (geospatial intelligence dashboard)' }, timeout: 10000 }
  ).then(r => {
    if (r.status !== 200) return;
    const data = JSON.parse(r.data);
    for (const c of (data.data?.children || [])) {
      const d = c.data;
      const geo = geoTagPost(d.title + ' ' + (d.selftext || ''));
      allPosts.push({
        id: `reddit_${d.id}`, title: d.title,
        url: d.url, permalink: `https://reddit.com${d.permalink}`,
        source: `r/${d.subreddit}`, type: 'social', platform: 'reddit',
        score: d.score || 0, comments: d.num_comments || 0,
        date: (d.created_utc || 0) * 1000,
        lang: 'en', flair: d.link_flair_text || '',
        text: d.selftext ? d.selftext.substring(0, 150) : '',
        geoLat: geo ? geo.lat : null,
        geoLon: geo ? geo.lon : null,
        geoCountry: geo ? geo.country : null,
      });
    }
  }).catch(() => {}));

  // Parallel RSS fetches
  const rssTasks = RSS_FEEDS.map(feed => fetchUrl(feed.url, {
    timeout: 10000, headers: { 'Accept': 'application/rss+xml,application/xml,text/xml,*/*' }
  }).then(r => {
    if (r.status !== 200) return;
    const items = parseRSS(r.data);
    for (const item of items) {
      if (!item.title) continue;
      const geo = geoTagPost(item.title + ' ' + (item.description || ''));
      allPosts.push({
        id: `rss_${feed.name}_${item.link}`,
        title: item.title, url: item.link,
        source: feed.name, type: 'news', platform: 'rss',
        date: item.date || Date.now(), lang: detectLang(item.title),
        description: item.description || '', score: 0, comments: 0,
        geoLat: geo ? geo.lat : null,
        geoLon: geo ? geo.lon : null,
        geoCountry: geo ? geo.country : null,
      });
    }
  }).catch(() => {}));

  await Promise.allSettled([...redditTasks, ...rssTasks]);

  // Keyword filter
  let filtered = keyword
    ? allPosts.filter(p => (p.title||'').toLowerCase().includes(keyword) || (p.description||'').toLowerCase().includes(keyword) || (p.flair||'').toLowerCase().includes(keyword) || (p.text||'').toLowerCase().includes(keyword))
    : allPosts;

  // Geo bbox filter — keep posts that either match the viewport or have no geo tag
  // Posts WITH a matching geo tag are boosted; posts without geo tag are included but ranked lower
  let geoFiltered = false;
  if (hasBbox) {
    geoFiltered = true;
    const inBbox = filtered.filter(p => {
      if (p.geoLat == null || p.geoLon == null) return false;
      return p.geoLat >= minLat && p.geoLat <= maxLat && p.geoLon >= minLon && p.geoLon <= maxLon;
    });
    // If bbox returns less than 10 posts, fall back to global (viewport may be small or ocean)
    if (inBbox.length >= 5) {
      filtered = inBbox;
    } else {
      // Score boost for in-bbox; still show all but geo-matched float to top
      filtered.forEach(p => {
        if (p.geoLat != null && p.geoLat >= minLat && p.geoLat <= maxLat &&
            p.geoLon != null && p.geoLon >= minLon && p.geoLon <= maxLon) {
          p._geoBoost = 1000;
        } else {
          p._geoBoost = 0;
        }
      });
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = filtered.filter(p => { if (!p.url || seen.has(p.url)) return false; seen.add(p.url); return true; });

  // Sort by date (newest first), keep 300
  deduped.sort((a, b) => (b.date||0) - (a.date||0));
  const recent = deduped.slice(0, 300);

  // Compute corroboration
  const withCorr = computeCorroboration(recent);

  // Re-sort: geo-boosted first, then high-corroboration, then by date
  withCorr.sort((a, b) => {
    const geoA = a._geoBoost || 0;
    const geoB = b._geoBoost || 0;
    if (geoB !== geoA) return geoB - geoA;
    if (b.corroboration !== a.corroboration) return b.corroboration - a.corroboration;
    return (b.date||0) - (a.date||0);
  });

  const result = {
    posts: withCorr.slice(0, 150),
    count: withCorr.length,
    keyword,
    geoFiltered,
    bbox: hasBbox ? { minLat, maxLat, minLon, maxLon } : null,
    ts: Date.now(),
  };
  osintCache.set(cacheKey, result);
  setTimeout(() => osintCache.delete(cacheKey), 3 * 60 * 1000);

  console.log(`[OSINT] ${result.count} posts (q="${keyword}", geo=${geoFiltered ? bboxKey : 'global'})`);
  res.json(result);
});

// Translation via MyMemory free API
const transCache = new Map();
app.get('/api/translate', async (req, res) => {
  const text = (req.query.text || '').substring(0, 300);
  const from = req.query.from || 'auto';
  const to   = req.query.to || 'en';
  if (!text || text.length < 3) return res.json({ translated: text, cached: true });
  const detectedLang = detectLang(text);
  if ((from === 'en' || from === 'auto') && detectedLang === 'en') return res.json({ translated: text, from: 'en', to: 'en', cached: true });

  const cacheKey = `${from}_${to}_${text.substring(0,80)}`;
  const c = transCache.get(cacheKey);
  if (c) return res.json(c);

  try {
    const lp = from === 'auto' ? `${detectedLang}|${to}` : `${from}|${to}`;
    const r = await fetchUrl(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${lp}`, { timeout: 8000 });
    if (r.status === 200) {
      const d = JSON.parse(r.data);
      const result = { translated: d.responseData?.translatedText || text, from: lp.split('|')[0], to, quality: d.responseData?.match || 0 };
      transCache.set(cacheKey, result);
      if (transCache.size > 1000) transCache.clear();
      return res.json(result);
    }
  } catch(e) { console.warn('[Translate]', e.message); }
  res.json({ translated: text, from, to, error: 'translation_failed' });
});

// ─── TRIPWIRE / ALERT SYSTEM (Maven-style) ───────────────────────────────────
const tripwires = new Map();
let twIdCtr = 1;

app.get('/api/tripwires', (req, res) => res.json({ tripwires: [...tripwires.values()], count: tripwires.size }));

app.post('/api/tripwires', (req, res) => {
  const { name, type, value, bbox, threshold } = req.body || {};
  if (!name || !type) return res.status(400).json({ error: 'name and type required' });
  const tw = { id: twIdCtr++, name, type: type.toLowerCase(), value: value || '', bbox: bbox || null, threshold: parseInt(threshold)||1, active: true, hits: 0, lastHit: null, created: Date.now() };
  tripwires.set(tw.id, tw);
  console.log(`[Tripwire] Created: "${name}" (${type})`);
  res.json(tw);
});

app.patch('/api/tripwires/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const tw = tripwires.get(id);
  if (!tw) return res.status(404).json({ error: 'not found' });
  Object.assign(tw, { active: req.body.active ?? tw.active });
  res.json(tw);
});

app.delete('/api/tripwires/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!tripwires.has(id)) return res.status(404).json({ error: 'not found' });
  tripwires.delete(id);
  res.json({ deleted: true });
});

// Client posts live entity lists; server checks against tripwires and returns alerts
app.post('/api/tripwires/check', (req, res) => {
  const { flights = [], military = [], ships = [] } = req.body || {};
  const alerts = [];
  const now = Date.now();

  const vehicles = [
    ...flights.map(s  => ({ vtype:'flight',   callsign:(s[1]||'').trim(), country:(s[2]||''), alt:(s[7]||0)*3.28084, lat:s[6], lon:s[5] })),
    ...military.map(s => ({ vtype:'military',  callsign:(s[1]||'').trim(), country:(s[2]||''), alt:(s[7]||0)*3.28084, lat:s[6], lon:s[5] })),
    ...ships.map(s    => ({ vtype:'ship',      name:(s.name||''),          mmsi:s.mmsi,         lat:s.lat,             lon:s.lon })),
  ];

  for (const tw of tripwires.values()) {
    if (!tw.active) continue;
    const matches = [];

    for (const v of vehicles) {
      let hit = false;
      if (tw.type === 'callsign' && tw.value) {
        const pattern = new RegExp('^' + tw.value.replace(/\*/g,'.*').replace(/\?/g,'.') + '$', 'i');
        if (pattern.test(v.callsign || v.name || '')) hit = true;
      } else if (tw.type === 'country' && tw.value) {
        if ((v.country||'').toLowerCase().includes(tw.value.toLowerCase())) hit = true;
      } else if (tw.type === 'keyword' && tw.value) {
        const haystack = `${v.callsign||''} ${v.name||''} ${v.country||''}`.toLowerCase();
        if (haystack.includes(tw.value.toLowerCase())) hit = true;
      } else if (tw.type === 'bbox' && tw.bbox) {
        const { minLat, maxLat, minLon, maxLon } = tw.bbox;
        if (v.lat>=minLat && v.lat<=maxLat && v.lon>=minLon && v.lon<=maxLon) hit = true;
      } else if (tw.type === 'altitude' && tw.value) {
        const parts = String(tw.value).split('-').map(Number);
        if (parts.length === 2 && v.alt >= parts[0] && v.alt <= parts[1]) hit = true;
      }
      if (hit) matches.push(v);
    }

    if (matches.length >= tw.threshold && (!tw.lastHit || now - tw.lastHit > 60000)) {
      tw.hits += matches.length;
      tw.lastHit = now;
      alerts.push({ tripwire: { id: tw.id, name: tw.name, type: tw.type }, matches: matches.slice(0,5), count: matches.length, ts: now });
    }
  }
  res.json({ alerts, checked: tripwires.size });
});

// ─── PLAYBACK RANGE ───────────────────────────────────────────────────────────
app.get('/api/playback/range', (req, res) => {
  if (!db) return res.json({ available: false });
  try {
    const row = db.prepare('SELECT MIN(ts) as earliest, MAX(ts) as latest, COUNT(*) as total FROM snapshots').get();
    res.json({ available: !!(row && row.total > 0), earliest: row?.earliest, latest: row?.latest, total: row?.total });
  } catch { res.json({ available: false }); }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║  NEXUS v7.0 — GEOSPATIAL INTELLIGENCE SYSTEM       ║
║  http://localhost:${PORT}                                 ║
║  Intel: GDELT (100+ languages) · AI Query · Ships  ║
╚════════════════════════════════════════════════════╝`);
});
