/**
 * ARGUS // GLOBAL INTELLIGENCE SYSTEM v3
 * All-seeing adaptive geospatial surveillance dashboard
 * Zoom-adaptive LOD: global → regional → city → street
 */
'use strict';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// ─── LOD ZONES (camera altitude in metres) ────────────────────────────────
// GLOBAL  > 5,000km : flights worldwide, satellites, quakes, GPS jam
// REGIONAL 500-5,000km : + ships (bbox), weather grid, wildfires
// CITY     50-500km  : + CCTV, roads, local weather stations, radio towers
// STREET   < 50km    : + OSM full detail, individual weather points
const LOD = {
  GLOBAL:   5_000_000,
  REGIONAL:   500_000,
  CITY:        50_000,
};

const CONFIG = {
  satelliteUpdateInterval:  5_000,
  flightUpdateInterval:     8_000,
  militaryUpdateInterval:  12_000,
  shipUpdateInterval:      10_000,
  quakeUpdateInterval:     60_000,
  gpsjamUpdateInterval:   300_000,
  weatherUpdateInterval:   60_000,
  fireUpdateInterval:     120_000,
  lodDebounce:              2_000,   // ms to wait after camera stops before re-fetching
};

// Current LOD level (updated on camera move)
let currentLOD = 'GLOBAL';
let lodDebounceTimer = null;
let lastViewBbox = null;   // {minLat,maxLat,minLon,maxLon}

const PRESETS = {
  global:  { lon:0,       lat:20,       alt:18000000, pitch:-90 },
  london:  { lon:-0.1278, lat:51.5074,  alt:800000,   pitch:-45 },
  nyc:     { lon:-74.006, lat:40.7128,  alt:600000,   pitch:-40 },
  dc:      { lon:-77.036, lat:38.9072,  alt:400000,   pitch:-40 },
  moscow:  { lon:37.617,  lat:55.755,   alt:600000,   pitch:-40 },
  beijing: { lon:116.407, lat:39.904,   alt:600000,   pitch:-40 },
  dubai:   { lon:55.296,  lat:25.2048,  alt:500000,   pitch:-40 },
  sydney:  { lon:151.209, lat:-33.868,  alt:500000,   pitch:-40 },
};

// ─── STATE ───────────────────────────────────────────────────────────────────
// ── SVG ICON FACTORIES ──────────────────────────────────────────────────────
function planeIconSvg(color, isMil) {
  const body = isMil
    ? `<polygon points="12,2 15,10 22,10 17,15 19,22 12,17 5,22 7,15 2,10 9,10" fill="${color}"/>` // star-ish military
    : `<path d="M12 2 L14 8 L22 11 L14 14 L12 22 L10 14 L2 11 L10 8 Z" fill="${color}"/>`;      // commercial diamond
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">${body}<circle cx="12" cy="11" r="2" fill="white" opacity="0.8"/></svg>`)}`;
}

function shipIconSvg(color) {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"><polygon points="12,2 20,18 12,14 4,18" fill="${color}" stroke="white" stroke-width="1"/></svg>`)}`;
}

function cctvIconSvg() {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="10" fill="#ff6600" opacity="0.85"/><circle cx="12" cy="12" r="5" fill="white" opacity="0.5"/><circle cx="12" cy="12" r="2" fill="#ff6600"/></svg>`)}`;
}

function jamIconSvg(level) {
  const c = level >= 3 ? '#ff0000' : level >= 2 ? '#ff8800' : '#ffff00';
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="${c}" opacity="0.35"/><text x="12" y="17" text-anchor="middle" font-size="12" fill="${c}">⚡</text></svg>`)}`;
}

const S = {
  viewer: null,
  layers: {
    satellites: { on: true,  ds: null },
    flights:    { on: false, ds: null },
    military:   { on: false, ds: null },
    ships:      { on: false, ds: null },
    traffic:    { on: false, ds: null, polylines: null, interval: null },
    quakes:     { on: false, ds: null },
    gpsjam:     { on: false, ds: null },
    cctv:       { on: false, ds: null },
    weather:    { on: false, ds: null },
    wildfires:  { on: false, ds: null },
    shodan:     { on: false, ds: null, results: [] },
  },
  tleData: [],
  tracking: null,
  detMode: 'sparse',
  visionMode: 'normal',
  intervals: {},
  logHistory: [],
  // Filters
  filters: {
    flights: { minAlt: 0, maxAlt: 45000, minSpd: 0, maxSpd: 1200, country: '', callsign: '', showCommercial: true, showUnknown: true },
  },
  // Playback
  playback: {
    active: false,
    currentTs: null,
    speed: 1,
    playing: false,
    playInterval: null,
    range: { earliest: null, latest: null },
  },
  // Shodan
  shodan: {
    key: '',
    lastResults: [],
    creditStats: null,
  },
  // Airlines cache
  airlineMap: {},
  // Raw flight data for filtering
  rawFlights: [],
  rawMilitary: [],
};

// ─── INIT ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setupTokenModal();
  setupUI();
  startClock();
  loadShodanPresets();
  refreshStorageStats();
  refreshShodanCredits();
});

// ─── CESIUM INIT ─────────────────────────────────────────────────────────────
function setupTokenModal() {
  const modal = document.getElementById('token-modal');
  const input = document.getElementById('cesium-token-input');
  const saved = localStorage.getItem('cesium_token');
  if (saved) { modal.classList.add('hidden'); initCesium(saved); return; }
  document.getElementById('token-submit-btn').addEventListener('click', () => {
    const t = input.value.trim();
    if (!t) return;
    localStorage.setItem('cesium_token', t);
    modal.classList.add('hidden');
    initCesium(t);
  });
  document.getElementById('token-skip-btn').addEventListener('click', () => {
    modal.classList.add('hidden');
    initCesium('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlYWE1OWUxNy1mMWZiLTQzYjYtYTQ0OS1kMWFjYmFkNTc5YzMiLCJpZCI6NTc3MzMsImlhdCI6MTYyNzg0NTE4Mn0.XcKpgANiY19MC4bdFd3AJblJKnSqyDBCSSnaliD7kCY');
  });
  input.addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('token-submit-btn').click(); });
}

async function initCesium(token) {
  Cesium.Ion.defaultAccessToken = token;

  // createWorldTerrainAsync replaces createWorldTerrain (removed in 1.107)
  const terrainProvider = await Cesium.createWorldTerrainAsync().catch(() => undefined);

  S.viewer = new Cesium.Viewer('cesiumContainer', {
    terrainProvider,
    imageryProvider: false, baseLayerPicker: false,
    geocoder: false, homeButton: false, sceneModePicker: false,
    navigationHelpButton: false, animation: false, timeline: false,
    fullscreenButton: false, infoBox: false, selectionIndicator: false,
    shadows: false, creditContainer: document.createElement('div'),
  });
  const scene = S.viewer.scene;
  scene.globe.enableLighting = true;
  scene.globe.atmosphereLightIntensity = 10.0;

  // Try Google Photorealistic 3D Tiles
  try {
    const ts = await Cesium.Cesium3DTileset.fromIonAssetId(2275207, {
      maximumScreenSpaceError: 16,
    });
    S.viewer.scene.primitives.add(ts);
    addLog('GOOGLE 3D TILES ONLINE');
  } catch { loadFallback(); }

  S.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(0, 20, 18000000),
    orientation: { heading:0, pitch: Cesium.Math.toRadians(-90), roll:0 } });
  S.viewer.screenSpaceEventHandler.setInputAction(onGlobeClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  S.viewer.camera.changed.addEventListener(updateCoords);
  updateCoords();
  addLog('SYSTEM ONLINE');
  loadSatellites();
}

async function loadFallback() {
  // IonImageryProvider.fromAssetId replaces constructor (removed in 1.104)
  try {
    const provider = await Cesium.IonImageryProvider.fromAssetId(3);
    S.viewer.imageryLayers.addImageryProvider(provider);
  } catch {}
  // createOsmBuildingsAsync replaces createOsmBuildings (removed in 1.107)
  try {
    const osm = await Cesium.createOsmBuildingsAsync();
    S.viewer.scene.primitives.add(osm);
    addLog('OSM BUILDINGS LOADED');
  } catch {}
  addLog('CESIUM WORLD IMAGERY');
}

// ─── SATELLITE LAYER ─────────────────────────────────────────────────────────
async function loadSatellites() {
  addLog('FETCHING TLE DATA...');
  let all = [];
  for (const g of ['stations', 'visual']) {
    try {
      const r = await fetch(`/api/tle/${g}`);
      if (r.ok) { const t = await r.text(); all = all.concat(parseTLE(t)); }
    } catch {}
  }
  if (!all.length) all = demoTLE();
  S.tleData = all;
  document.getElementById('sat-count').textContent = all.length;
  addLog(`${all.length} SATELLITES ACQUIRED`);
  renderSatellites();
  S.intervals.sat = setInterval(renderSatellites, CONFIG.satelliteUpdateInterval);
}

function parseTLE(txt) {
  const lines = txt.trim().split('\n').map(l=>l.trim()).filter(Boolean);
  const out = [];
  for (let i=0; i<lines.length-2; i+=3) {
    if (lines[i+1]?.startsWith('1 ') && lines[i+2]?.startsWith('2 '))
      out.push({ name: lines[i].replace(/^0 /,''), tle1: lines[i+1], tle2: lines[i+2] });
  }
  return out;
}

function demoTLE() {
  return [{ name:'ISS (ZARYA)', tle1:'1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9993', tle2:'2 25544  51.6400 208.9163 0006317  86.9006  73.1692 15.49560026430115' }];
}

function renderSatellites() {
  if (!S.layers.satellites.on || !S.viewer) return;
  if (S.layers.satellites.ds) S.viewer.dataSources.remove(S.layers.satellites.ds, true);
  const ds = new Cesium.CustomDataSource('satellites');
  const full = S.detMode === 'full';
  const limit = Math.min(S.tleData.length, full ? 200 : 400);
  const now = new Date();
  for (let i=0; i<limit; i++) {
    const sat = S.tleData[i];
    try {
      const pos = propagate(sat.tle1, sat.tle2, now);
      if (!pos) continue;
      ds.entities.add({
        id: `sat_${i}`, name: sat.name,
        position: Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, pos.alt*1000),
        point: { pixelSize:3, color: Cesium.Color.fromCssColorString('#00ff41').withAlpha(0.85),
          outlineColor: Cesium.Color.BLACK, outlineWidth:1,
          scaleByDistance: new Cesium.NearFarScalar(1.5e6,1.5,1.5e8,0.6) },
        label: full ? {
          text: sat.name.substring(0,12), font:'9px Share Tech Mono',
          fillColor: Cesium.Color.fromCssColorString('#00ff41').withAlpha(0.8),
          outlineColor: Cesium.Color.BLACK, outlineWidth:2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(8,0),
          translucencyByDistance: new Cesium.NearFarScalar(1.5e7,1,1e8,0),
        } : undefined,
        properties: { type:'satellite', data:sat, pos },
      });
    } catch {}
  }
  S.viewer.dataSources.add(ds);
  S.layers.satellites.ds = ds;
}

// SGP4-lite propagation
function propagate(tle1, tle2, date) {
  try {
    const ey = parseInt(tle1.substring(18,20)), ed = parseFloat(tle1.substring(20,32));
    const fy = ey < 57 ? 2000+ey : 1900+ey;
    const ep = new Date(fy,0,1); ep.setTime(ep.getTime()+(ed-1)*86400000);
    const inc  = parseFloat(tle2.substring(8,16))*Math.PI/180;
    const raan = parseFloat(tle2.substring(17,25))*Math.PI/180;
    const ecc  = parseFloat('0.'+tle2.substring(26,33));
    const argp = parseFloat(tle2.substring(34,42))*Math.PI/180;
    const mm   = parseFloat(tle2.substring(52,63));
    const n = mm*2*Math.PI/86400, a = Math.pow(398600.4418/(n*n),1/3);
    const dt = (date-ep)/1000;
    let M = (parseFloat(tle2.substring(43,51))*Math.PI/180)+n*dt;
    M = M%(2*Math.PI);
    let E=M; for(let j=0;j<6;j++) E=M+ecc*Math.sin(E);
    const nu = 2*Math.atan2(Math.sqrt(1+ecc)*Math.sin(E/2),Math.sqrt(1-ecc)*Math.cos(E/2));
    const r = a*(1-ecc*Math.cos(E));
    const xo=r*Math.cos(nu), yo=r*Math.sin(nu);
    const cR=Math.cos(raan),sR=Math.sin(raan),cI=Math.cos(inc),sI=Math.sin(inc),cA=Math.cos(argp),sA=Math.sin(argp);
    const x=(cR*cA-sR*sA*cI)*xo+(-cR*sA-sR*cA*cI)*yo;
    const y=(sR*cA+cR*sA*cI)*xo+(-sR*sA+cR*cA*cI)*yo;
    const z=(sA*sI)*xo+(cA*sI)*yo;
    const gmst=(()=>{const jd=date.getTime()/86400000+2440587.5,T=(jd-2451545)/36525;return((280.46061837+360.98564736629*(jd-2451545)+T*T*(0.000387933-T/38710000))%360)*Math.PI/180;})();
    const lng=Math.atan2(y,x)-gmst, lat=Math.atan2(z,Math.sqrt(x*x+y*y));
    return { lat:lat*180/Math.PI, lng:((lng*180/Math.PI)%360+540)%360-180, alt:Math.max(r-6371,100) };
  } catch { return null; }
}

// ─── FLIGHTS ─────────────────────────────────────────────────────────────────
async function loadFlights(mil=false) {
  const key = mil ? 'military' : 'flights';
  addLog(`FETCHING ${mil?'MILITARY':'COMMERCIAL'} FLIGHTS...`);
  try {
    const r = await fetch(mil ? '/api/flights/military' : '/api/flights/opensky');
    if (!r.ok) throw new Error();
    const data = await r.json();
    const states = data.states || [];
    if (mil) S.rawMilitary = states; else S.rawFlights = states;

    // Enrich with airline data
    if (!mil && states.length) {
      const callsigns = [...new Set(states.map(s=>(s[1]||'').trim()).filter(Boolean))];
      const known = callsigns.filter(c => !S.airlineMap[c]);
      if (known.length) {
        try {
          const ar = await fetch('/api/flights/airlines', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ callsigns: known.slice(0,500) })
          });
          if (ar.ok) {
            const am = await ar.json();
            Object.assign(S.airlineMap, am);
          }
        } catch {}
      }
    }

    applyFlightFilters(mil);
  } catch {
    addLog(`${mil?'MIL ':''} FEED UNAVAILABLE`);
    if (mil) S.rawMilitary = []; else S.rawFlights = [];
    applyFlightFilters(mil);
  }
}

function applyFlightFilters(mil=false) {
  const key  = mil ? 'military' : 'flights';
  const raw  = mil ? S.rawMilitary : S.rawFlights;
  const f    = S.filters.flights;

  const filtered = raw.filter(s => {
    if (!s || s[5]==null || s[6]==null) return false;
    const alt = +(s[13]||s[7]||0);
    const spd = +(s[9]||0);
    const cs  = (s[1]||'').trim();
    const cty = (s[2]||'');
    if (alt < f.minAlt || alt > f.maxAlt) return false;
    if (spd < f.minSpd || spd > f.maxSpd) return false;
    if (f.country && !cty.toLowerCase().includes(f.country.toLowerCase())) return false;
    if (f.callsign && !cs.toLowerCase().includes(f.callsign.toLowerCase())) return false;
    if (!f.showUnknown && !cs) return false;
    return true;
  });

  renderFlights(filtered, mil);
}

function renderFlights(states, mil=false) {
  if (!S.viewer) return;
  const key = mil ? 'military' : 'flights';
  if (S.layers[key].ds) S.viewer.dataSources.remove(S.layers[key].ds, true);
  const ds = new Cesium.CustomDataSource(key);
  const full = S.detMode === 'full';

  for (const s of states) {
    if (!s || s[5]==null || s[6]==null) continue;
    const lon = +s[5], lat = +s[6], alt = +(s[13]||s[7]||1000)+500;
    if (isNaN(lon)||isNaN(lat)) continue;
    const cs = (s[1]||s[0]||'UNKN').trim()||'UNKN';
    const airline = S.airlineMap[cs];

    // Color: airline brand color > mil orange > commercial blue
    let hexColor = mil ? '#ff8c00' : (airline?.color || '#00aaff');
    const color = Cesium.Color.fromCssColorString(hexColor).withAlpha(0.9);

    ds.entities.add({
      id: `${key}_${s[0]}`, name: cs,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
      point: {
        pixelSize: mil ? 5 : 3.5, color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.5), outlineWidth:1,
        scaleByDistance: new Cesium.NearFarScalar(1e5,2,1e7,0.8),
      },
      label: full ? {
        text: cs.substring(0,8)+(airline ? `\n${airline.name.substring(0,12)}` : ''),
        font:'9px Share Tech Mono',
        fillColor: color,
        outlineColor: Cesium.Color.BLACK, outlineWidth:2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(8,0),
        translucencyByDistance: new Cesium.NearFarScalar(5e5,1,5e6,0),
      } : undefined,
      properties: { type: mil?'military':'flight', data:s, airline },
    });
  }

  S.viewer.dataSources.add(ds);
  S.layers[key].ds = ds;
  document.getElementById(mil?'mil-count':'flight-count').textContent = states.length;
  addLog(`${states.length} ${mil?'MILITARY':'COMMERCIAL'} FLIGHTS RENDERED`);

  updateFilterStats(states, mil);
}

function updateFilterStats(states, mil) {
  if (mil) return;
  const countries = [...new Set(states.map(s=>(s[2]||'?').trim()).filter(Boolean))];
  const airlines  = [...new Set(states.map(s=>(s[1]||'').trim()).filter(Boolean).map(cs=>S.airlineMap[cs]?.name).filter(Boolean))];
  document.getElementById('filter-stats').textContent =
    `${states.length} aircraft · ${countries.length} countries · ${airlines.length} airlines`;
}

// ─── EARTHQUAKES ─────────────────────────────────────────────────────────────
async function loadQuakes() {
  try {
    const r = await fetch('/api/quakes');
    if (!r.ok) throw new Error();
    const data = await r.json();
    renderQuakes(data.features||[]);
  } catch { renderQuakes([]); }
}

function renderQuakes(features) {
  if (!S.viewer) return;
  if (S.layers.quakes.ds) S.viewer.dataSources.remove(S.layers.quakes.ds, true);
  const ds = new Cesium.CustomDataSource('quakes');
  let cnt = 0;
  for (const f of features) {
    const [lon,lat] = f.geometry.coordinates, mag = f.properties.mag||0;
    if (mag < 1) continue;
    const col = mag>=6 ? '#ff2222' : mag>=4 ? '#ff8800' : '#ffff00';
    const sz  = Math.max(4, mag*4);
    ds.entities.add({
      id:`quake_${f.id}`, name:`M${mag} — ${f.properties.place||''}`,
      position: Cesium.Cartesian3.fromDegrees(lon,lat,0),
      point: {
        pixelSize:sz, color: Cesium.Color.fromCssColorString(col).withAlpha(0.7),
        outlineColor: Cesium.Color.fromCssColorString(col).withAlpha(0.3), outlineWidth:sz*0.5,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      label: S.detMode==='full' ? {
        text:`M${mag.toFixed(1)}`, font:'9px Share Tech Mono',
        fillColor: Cesium.Color.fromCssColorString(col),
        outlineColor: Cesium.Color.BLACK, outlineWidth:2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0,-sz-4),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      } : undefined,
      properties: { type:'quake', data:f.properties },
    });
    cnt++;
  }
  S.viewer.dataSources.add(ds);
  S.layers.quakes.ds = ds;
  document.getElementById('quake-count').textContent = cnt;
  addLog(`${cnt} SEISMIC EVENTS`);
}

// ─── STREET TRAFFIC ───────────────────────────────────────────────────────────
// Road type → Google Maps style color + width
const ROAD_STYLE = {
  motorway:     { color: '#ff6666', width: 4.5 },
  trunk:        { color: '#ff9933', width: 4.0 },
  primary:      { color: '#ffcc00', width: 3.5 },
  secondary:    { color: '#99cc33', width: 3.0 },
  tertiary:     { color: '#aaaaaa', width: 2.0 },
  residential:  { color: '#888888', width: 1.5 },
  unclassified: { color: '#777777', width: 1.2 },
};

async function loadTraffic() {
  clearTraffic();
  const cam = S.viewer.camera.positionCartographic;
  const lat = Cesium.Math.toDegrees(cam.latitude);
  const lon = Cesium.Math.toDegrees(cam.longitude);
  addLog('LOADING ROAD NETWORK...');
  try {
    const r = await fetch(`/api/osm/roads?lat=${lat}&lon=${lon}&radius=4000`);
    if (!r.ok) throw new Error();
    const data = await r.json();
    renderTrafficPolylines(data.elements||[], lat, lon);
  } catch { renderTrafficPolylines([], lat, lon); }
}

function renderTrafficPolylines(elements, clat, clon) {
  if (!S.viewer) return;
  if (S.layers.traffic.polylines) S.viewer.scene.primitives.remove(S.layers.traffic.polylines);

  // Use PolylineCollection for performance (thousands of road segments)
  const collection = new Cesium.PolylineCollection();
  let segCount = 0;

  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const highway = el.tags?.highway || 'residential';
    const style   = ROAD_STYLE[highway] || ROAD_STYLE.residential;
    const color   = Cesium.Color.fromCssColorString(style.color).withAlpha(0.85);

    // Build positions array
    const positions = el.geometry.map(n => Cesium.Cartesian3.fromDegrees(n.lon, n.lat, 2));

    collection.add({
      positions,
      width: style.width,
      material: Cesium.Material.fromType('Color', { color }),
      followSurface: true,
      clampToGround: false,
    });
    segCount++;
  }

  // Fallback grid if no OSM data
  if (segCount === 0) {
    for (let i = -5; i <= 5; i++) {
      const style = i % 3 === 0 ? ROAD_STYLE.primary : ROAD_STYLE.residential;
      const color = Cesium.Color.fromCssColorString(style.color).withAlpha(0.7);
      collection.add({ positions: [
        Cesium.Cartesian3.fromDegrees(clon - 0.03, clat + i*0.003, 2),
        Cesium.Cartesian3.fromDegrees(clon + 0.03, clat + i*0.003, 2),
      ], width: style.width, material: Cesium.Material.fromType('Color', { color }), followSurface: true });
      collection.add({ positions: [
        Cesium.Cartesian3.fromDegrees(clon + i*0.003, clat - 0.03, 2),
        Cesium.Cartesian3.fromDegrees(clon + i*0.003, clat + 0.03, 2),
      ], width: style.width, material: Cesium.Material.fromType('Color', { color }), followSurface: true });
    }
    segCount = 20;
  }

  S.viewer.scene.primitives.add(collection);
  S.layers.traffic.polylines = collection;
  document.getElementById('traffic-count').textContent = segCount;
  addLog(`${segCount} ROAD SEGMENTS RENDERED`);
}

function clearTraffic() {
  if (S.layers.traffic.polylines) S.viewer?.scene.primitives.remove(S.layers.traffic.polylines);
  if (S.layers.traffic.ds) S.viewer?.dataSources.remove(S.layers.traffic.ds, true);
  if (S.layers.traffic.interval) clearInterval(S.layers.traffic.interval);
  S.layers.traffic.polylines = null;
  S.layers.traffic.ds = null;
}

// ─── NASA GIBS SATELLITE IMAGERY ──────────────────────────────────────────────
const GIBS_LAYERS = {
  'MODIS Terra (True Color)': {
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{Time}/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.jpg',
    tileMatrixSetID: 'GoogleMapsCompatible', format: 'image/jpeg', maximumLevel: 9,
  },
  'VIIRS Nighttime Lights': {
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.jpg',
    tileMatrixSetID: 'GoogleMapsCompatible', format: 'image/jpeg', maximumLevel: 8,
  },
  'MODIS Sea Surface Temp': {
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_Land_Surface_Temp_Day/default/{Time}/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.png',
    tileMatrixSetID: 'GoogleMapsCompatible', format: 'image/png', maximumLevel: 7,
  },
  'Suomi VIIRS (True Color)': {
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/{Time}/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.jpg',
    tileMatrixSetID: 'GoogleMapsCompatible', format: 'image/jpeg', maximumLevel: 9,
  },
};

let gibsLayer = null;

async function setGibsLayer(name) {
  if (!S.viewer) return;
  // Remove existing GIBS layer
  if (gibsLayer) {
    S.viewer.imageryLayers.remove(gibsLayer, true);
    gibsLayer = null;
  }
  if (!name || name === 'none') { addLog('SAT IMAGERY: OFF'); return; }
  const def = GIBS_LAYERS[name];
  if (!def) return;

  const today = new Date().toISOString().slice(0,10);
  const url   = def.url.replace('{Time}', today);

  try {
    const provider = await Cesium.WebMapTileServiceImageryProvider.fromUrl(url, {
      layer:          name,
      style:          'default',
      tileMatrixSetID: def.tileMatrixSetID,
      format:         def.format,
      maximumLevel:   def.maximumLevel,
      credit:         new Cesium.Credit('NASA GIBS / Earthdata'),
    });
    gibsLayer = S.viewer.imageryLayers.addImageryProvider(provider);
    gibsLayer.alpha = 0.85;
    addLog(`SAT IMAGERY: ${name.toUpperCase()}`);
  } catch(e) {
    addLog(`GIBS ERROR: ${e.message.substring(0,30)}`);
  }
}

// ─── WEATHER (Open-Meteo, no key) ────────────────────────────────────────────
async function refreshWeather(bbox, lod) {
  if (!S.viewer || !bbox) return;
  if (S.layers.weather.ds) S.viewer.dataSources.remove(S.layers.weather.ds, true);
  const ds = new Cesium.CustomDataSource('weather');

  // At GLOBAL/REGIONAL: sample a grid. At CITY/STREET: single point with full detail.
  const points = [];
  if (lod === 'GLOBAL') {
    // Wide 5° grid
    for (let lat = Math.max(-80, Math.round(bbox.minLat/5)*5); lat <= Math.min(80, bbox.maxLat); lat += 5)
      for (let lon = Math.round(bbox.minLon/5)*5; lon <= bbox.maxLon; lon += 5)
        points.push({ lat, lon });
  } else if (lod === 'REGIONAL') {
    // 2° grid
    for (let lat = Math.round(bbox.minLat/2)*2; lat <= bbox.maxLat; lat += 2)
      for (let lon = Math.round(bbox.minLon/2)*2; lon <= bbox.maxLon; lon += 2)
        points.push({ lat, lon });
  } else {
    // Single point: camera centre, maximum detail
    points.push({ lat: bbox.centerLat, lon: bbox.centerLon, detail: true });
  }

  const limited = points.slice(0, 25); // cap API calls
  let cnt = 0;

  await Promise.all(limited.map(async ({ lat, lon, detail }) => {
    const vars = detail
      ? 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m,weather_code,visibility,surface_pressure,uv_index,cloud_cover'
      : 'temperature_2m,weather_code,wind_speed_10m';
    try {
      const r = await fetch(
        `/api/weather?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&vars=${vars}`
      );
      if (!r.ok) return;
      const d = await r.json();
      if (!d.current) return;

      const cur    = d.current;
      const temp   = cur.temperature_2m ?? '?';
      const wcode  = cur.weather_code ?? 0;
      const wind   = cur.wind_speed_10m ?? 0;
      const wdir   = cur.wind_direction_10m ?? 0;
      const emoji  = weatherEmoji(wcode);
      const color  = tempColor(temp);

      let label = detail
        ? `${emoji} ${temp}°C  💨${wind}km/h
` +
          `💧${cur.relative_humidity_2m ?? '?'}%  ☁${cur.cloud_cover ?? '?'}%
` +
          `👁${((cur.visibility??10000)/1000).toFixed(1)}km  UV:${cur.uv_index??'?'}
` +
          `🌡${cur.surface_pressure??'?'}hPa`
        : `${emoji}${Math.round(temp)}°`;

      ds.entities.add({
        id: `wx_${lat.toFixed(1)}_${lon.toFixed(1)}`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat, 500),
        label: {
          text: label,
          font: detail ? '10px Share Tech Mono' : '9px Share Tech Mono',
          fillColor: Cesium.Color.fromCssColorString(color),
          outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.6),
          backgroundPadding: new Cesium.Cartesian2(4, 3),
          translucencyByDistance: new Cesium.NearFarScalar(1e5, 1, 8e6, 0.3),
          scaleByDistance: new Cesium.NearFarScalar(1e4, 1.2, 5e6, 0.6),
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { type: 'weather', data: cur, lat, lon },
      });
      cnt++;
    } catch {}
  }));

  S.viewer.dataSources.add(ds);
  S.layers.weather.ds = ds;
  document.getElementById('weather-count').textContent = cnt;
  addLog(`WEATHER: ${cnt} NODES (${lod})`);
}

function weatherEmoji(code) {
  if (code === 0) return '☀️';
  if (code <= 3)  return '⛅';
  if (code <= 48) return '🌫️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌦️';
  if (code <= 99) return '⛈️';
  return '🌡️';
}

function tempColor(c) {
  if (c < -20) return '#88aaff';
  if (c < 0)   return '#aaccff';
  if (c < 10)  return '#88ffee';
  if (c < 20)  return '#aaffaa';
  if (c < 30)  return '#ffee44';
  if (c < 40)  return '#ff8800';
  return '#ff2222';
}

// ─── WILDFIRES (NASA FIRMS, no key for basic access) ─────────────────────────
async function refreshWildfires(bbox) {
  if (!S.viewer || !bbox) return;
  if (S.layers.wildfires.ds) S.viewer.dataSources.remove(S.layers.wildfires.ds, true);

  try {
    const r = await fetch(
      `/api/wildfires?minLat=${bbox.minLat.toFixed(2)}&maxLat=${bbox.maxLat.toFixed(2)}&minLon=${bbox.minLon.toFixed(2)}&maxLon=${bbox.maxLon.toFixed(2)}`
    );
    if (!r.ok) throw new Error();
    const fires = await r.json();
    renderWildfires(fires);
  } catch { addLog('FIRMS: UNAVAILABLE'); }
}

function renderWildfires(fires) {
  if (!S.viewer) return;
  const ds = new Cesium.CustomDataSource('wildfires');

  for (const f of fires) {
    const frp = f.frp || 0; // fire radiative power (MW)
    const size = Math.min(12, 4 + frp / 20);
    const color = frp > 500 ? '#ff0000' : frp > 100 ? '#ff5500' : '#ff9900';

    ds.entities.add({
      id: `fire_${f.lat}_${f.lon}`,
      position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 100),
      point: {
        pixelSize: size,
        color: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
        outlineColor: Cesium.Color.YELLOW.withAlpha(0.5),
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        scaleByDistance: new Cesium.NearFarScalar(1e3, 2, 5e6, 0.5),
      },
      label: {
        text: `🔥 ${Math.round(frp)}MW\n${f.acq_date||''}`,
        font: '8px Share Tech Mono',
        fillColor: Cesium.Color.fromCssColorString(color),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        translucencyByDistance: new Cesium.NearFarScalar(5e3, 1, 1e6, 0),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.6),
        backgroundPadding: new Cesium.Cartesian2(3, 2),
        pixelOffset: new Cesium.Cartesian2(14, 0),
      },
      properties: { type: 'wildfire', data: f },
    });
  }

  S.viewer.dataSources.add(ds);
  S.layers.wildfires.ds = ds;
  document.getElementById('fire-count').textContent = fires.length;
  addLog(`FIRMS: ${fires.length} FIRE DETECTIONS`);
}

// ─── SHIPS with bbox ──────────────────────────────────────────────────────────
async function refreshShipsBbox(bbox) {
  if (!bbox) { loadShips(); return; }
  try {
    const pad = 2;
    const r = await fetch(
      `/api/ships?minLat=${(bbox.minLat-pad).toFixed(2)}&maxLat=${(bbox.maxLat+pad).toFixed(2)}&minLon=${(bbox.minLon-pad).toFixed(2)}&maxLon=${(bbox.maxLon+pad).toFixed(2)}`
    );
    if (!r.ok) throw new Error();
    const ships = await r.json();
    renderShips(ships);
  } catch { loadShips(); }
}

// ─── SHIPS ────────────────────────────────────────────────────────────────────
async function loadShips() {
  addLog('FETCHING AIS SHIP DATA...');
  try {
    const r = await fetch('/api/ships');
    if (!r.ok) throw new Error();
    const ships = await r.json();
    renderShips(ships);
  } catch { addLog('AIS: FEED UNAVAILABLE'); renderShips([]); }
}

function renderShips(ships) {
  if (!S.viewer) return;
  if (S.layers.ships.ds) S.viewer.dataSources.remove(S.layers.ships.ds, true);
  const ds = new Cesium.CustomDataSource('ships');

  for (const s of ships) {
    if (!s.lat || !s.lon) continue;
    const sog     = +(s.sog || 0);
    const cog     = +(s.cog || 0);
    const name    = (s.name || s.mmsi || 'UNKNOWN').substring(0, 16);
    // Color by ship type: tanker=red, cargo=blue, passenger=green, other=cyan
    const t = +(s.type || 0);
    const hexColor = t >= 80 ? '#ff4444' : t >= 70 ? '#4488ff' : t >= 60 ? '#44ff88' : '#00ffff';

    ds.entities.add({
      id: `ship_${s.mmsi}`, name,
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 10),
      billboard: {
        image: shipIconSvg(hexColor),
        width: 16, height: 16,
        rotation: Cesium.Math.toRadians(-cog),
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        scaleByDistance: new Cesium.NearFarScalar(1e3, 2, 5e6, 0.6),
        translucencyByDistance: new Cesium.NearFarScalar(5e5, 1, 5e6, 0.2),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      label: {
        text: `${name}\n${sog.toFixed(1)}kt`,
        font: '8px Share Tech Mono',
        fillColor: Cesium.Color.fromCssColorString(hexColor),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(12, 0),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        translucencyByDistance: new Cesium.NearFarScalar(5e4, 1, 1e6, 0),
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
        backgroundPadding: new Cesium.Cartesian2(3, 2),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      properties: { type: 'ship', data: s },
    });
  }

  S.viewer.dataSources.add(ds);
  S.layers.ships.ds = ds;
  document.getElementById('ship-count').textContent = ships.length;
  addLog(`${ships.length} VESSELS TRACKED`);
}

// ─── GPS JAMMING ──────────────────────────────────────────────────────────────
async function loadGpsJam() {
  addLog('FETCHING GPS JAMMING DATA...');
  try {
    const r = await fetch('/api/gpsjam');
    if (!r.ok) throw new Error();
    const data = await r.json();
    renderGpsJam(data);
  } catch { addLog('GPSJAM: UNAVAILABLE'); }
}

function renderGpsJam(geojson) {
  if (!S.viewer) return;
  if (S.layers.gpsjam.ds) S.viewer.dataSources.remove(S.layers.gpsjam.ds, true);
  const ds = new Cesium.CustomDataSource('gpsjam');
  const features = geojson.features || [];
  let cnt = 0;

  for (const f of features) {
    const [lon, lat] = f.geometry?.coordinates || [];
    if (!lon || !lat) continue;
    const level = f.properties?.level || f.properties?.interference_level || 1;
    const label = f.properties?.label || f.properties?.name || '';
    if (level < 1) continue;

    const hexColor = level >= 3 ? '#ff0000' : level >= 2 ? '#ff8800' : '#ffff00';
    const radius   = (level * 60000); // km radius visualisation

    ds.entities.add({
      id: `jam_${cnt}`, name: `GPS JAM: ${label || `Level ${level}`}`,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 1000),
      ellipse: {
        semiMajorAxis: radius, semiMinorAxis: radius,
        material: Cesium.Color.fromCssColorString(hexColor).withAlpha(0.12),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString(hexColor).withAlpha(0.6),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      label: {
        text: `⚡ JAM L${level}\n${label.substring(0,16)}`,
        font: '9px Share Tech Mono',
        fillColor: Cesium.Color.fromCssColorString(hexColor),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        translucencyByDistance: new Cesium.NearFarScalar(1e5, 1, 5e6, 0),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      properties: { type: 'gpsjam', level, label },
    });
    cnt++;
  }

  S.viewer.dataSources.add(ds);
  S.layers.gpsjam.ds = ds;
  document.getElementById('jam-count').textContent = cnt;
  addLog(`${cnt} GPS JAM ZONES`);
}

// ─── CCTV ────────────────────────────────────────────────────────────────────
async function loadCctv() {
  const cam = S.viewer.camera.positionCartographic;
  const lat = Cesium.Math.toDegrees(cam.latitude);
  const lon = Cesium.Math.toDegrees(cam.longitude);
  addLog('FETCHING CCTV NODES...');
  try {
    const r = await fetch(`/api/cctv?lat=${lat}&lon=${lon}&radius=${CONFIG.cctvRadius}`);
    if (!r.ok) throw new Error();
    const cameras = await r.json();
    renderCctv(cameras);
  } catch { addLog('CCTV: UNAVAILABLE'); }
}

function renderCctv(cameras) {
  if (!S.viewer) return;
  if (S.layers.cctv.ds) S.viewer.dataSources.remove(S.layers.cctv.ds, true);
  const ds = new Cesium.CustomDataSource('cctv');

  for (const c of cameras) {
    ds.entities.add({
      id: `cctv_${c.id}`, name: `CCTV #${c.id}`,
      position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 5),
      billboard: {
        image: cctvIconSvg(),
        width: 14, height: 14,
        scaleByDistance: new Cesium.NearFarScalar(100, 2, 5e4, 0.8),
        translucencyByDistance: new Cesium.NearFarScalar(1e4, 1, 5e4, 0),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      label: {
        text: `📷 ${c.type||'CCTV'}\n${c.operator.substring(0,12)}`,
        font: '8px Share Tech Mono',
        fillColor: Cesium.Color.fromCssColorString('#ff6600'),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(10, 0),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        translucencyByDistance: new Cesium.NearFarScalar(500, 1, 5000, 0),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
        backgroundPadding: new Cesium.Cartesian2(3, 2),
      },
      properties: { type: 'cctv', data: c },
    });
  }

  S.viewer.dataSources.add(ds);
  S.layers.cctv.ds = ds;
  document.getElementById('cctv-count').textContent = cameras.length;
  addLog(`${cameras.length} CCTV NODES MAPPED`);
}



// ─── SHODAN LAYER ─────────────────────────────────────────────────────────────
async function loadShodanPresets() {
  try {
    const r = await fetch('/api/shodan/presets');
    const d = await r.json();
    const sel = document.getElementById('shodan-preset-select');
    if (sel) d.presets.forEach(p => {
      const o = document.createElement('option');
      o.value = p.query; o.textContent = p.label;
      sel.appendChild(o);
    });
    sel?.addEventListener('change', () => {
      const qi = document.getElementById('shodan-query-input');
      if (qi && sel.value) qi.value = sel.value;
    });
  } catch {}
}

async function executeShodanSearch() {
  const key   = S.shodan.key || localStorage.getItem('shodan_key') || '';
  const query = document.getElementById('shodan-query-input')?.value?.trim();
  if (!query) { addLog('SHODAN: NO QUERY ENTERED'); return; }
  if (!key)   { addLog('SHODAN: NO API KEY SET'); showShodanKeyPrompt(); return; }

  const btn = document.getElementById('shodan-search-btn');
  if (btn) { btn.disabled=true; btn.textContent='SCANNING...'; }
  addLog(`SHODAN SCAN: ${query.substring(0,30)}`);

  try {
    const r = await fetch('/api/shodan/search', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-shodan-key': key },
      body: JSON.stringify({ query })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    S.shodan.lastResults = data.results || [];
    renderShodanLayer(data.results);
    document.getElementById('shodan-result-count').textContent =
      `${data.results.length} / ${data.total?.toLocaleString() || '?'} results`;
    addLog(`SHODAN: ${data.results.length} DEVICES MAPPED (${data.cached?'CACHED':'LIVE'})`);
    refreshShodanCredits();
  } catch(e) {
    addLog(`SHODAN ERROR: ${e.message.substring(0,40)}`);
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='▶ EXECUTE SCAN'; }
  }
}

function showShodanKeyPrompt() {
  const panel = document.getElementById('shodan-key-prompt');
  if (panel) panel.style.display = 'block';
}

function renderShodanLayer(devices) {
  if (!S.viewer) return;
  if (S.layers.shodan.ds) S.viewer.dataSources.remove(S.layers.shodan.ds, true);
  const ds = new Cesium.CustomDataSource('shodan');

  for (const d of devices) {
    if (!d.lat || !d.lon) continue;
    const hasVulns = d.vulns?.length > 0;
    const color = hasVulns
      ? Cesium.Color.fromCssColorString('#ff2222').withAlpha(0.9)
      : Cesium.Color.fromCssColorString('#ff00ff').withAlpha(0.85);

    ds.entities.add({
      id: `shodan_${d.ip}`, name: d.ip,
      position: Cesium.Cartesian3.fromDegrees(d.lon, d.lat, 100),
      point: {
        pixelSize: hasVulns ? 7 : 5, color,
        outlineColor: color.withAlpha(0.3), outlineWidth: hasVulns ? 4 : 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        scaleByDistance: new Cesium.NearFarScalar(1e3, 2, 5e5, 1),
      },
      label: S.detMode==='full' ? {
        text: `${d.ip}\n${d.product||d.port}`,
        font: '8px Share Tech Mono',
        fillColor: color,
        outlineColor: Cesium.Color.BLACK, outlineWidth:2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(8,0),
        translucencyByDistance: new Cesium.NearFarScalar(1e4,1,5e5,0),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      } : undefined,
      properties: { type:'shodan', data:d },
    });
  }

  S.viewer.dataSources.add(ds);
  S.layers.shodan.ds = ds;
  S.layers.shodan.on = true;
  document.getElementById('toggle-shodan')?.setAttribute('checked', '');
  document.getElementById('shodan-count').textContent = devices.length;
}

function clearShodanLayer() {
  if (S.layers.shodan.ds) S.viewer?.dataSources.remove(S.layers.shodan.ds, true);
  S.layers.shodan.ds = null;
  S.layers.shodan.on = false;
  document.getElementById('shodan-count').textContent = '0';
}

async function refreshShodanCredits() {
  const key = S.shodan.key || localStorage.getItem('shodan_key') || '';
  try {
    const r = await fetch('/api/shodan/credits', {
      headers: key ? {'x-shodan-key': key} : {}
    });
    const d = await r.json();
    S.shodan.creditStats = d;
    updateCreditDisplay(d);
  } catch {}
}

function updateCreditDisplay(d) {
  const el = document.getElementById('shodan-credit-display');
  if (!el) return;
  if (!d.configured) {
    el.innerHTML = '<span style="color:var(--text-muted)">NO KEY CONFIGURED</span>';
    return;
  }
  const q24 = d.local?.last_24h?.q || 0;
  const c24 = d.local?.last_24h?.c || 0;
  const acct = d.account;
  el.innerHTML = `
    <div class="credit-row"><span>QUERIES 24H</span><span class="cv">${q24}</span></div>
    <div class="credit-row"><span>CREDITS USED 24H</span><span class="cv">${c24}</span></div>
    ${acct ? `
    <div class="credit-row"><span>PLAN</span><span class="cv">${acct.plan||'?'}</span></div>
    <div class="credit-row"><span>QUERY CREDITS</span><span class="cv ${acct.query_credits<10?'cv-warn':''}">${acct.query_credits??'?'}</span></div>
    <div class="credit-row"><span>SCAN CREDITS</span><span class="cv">${acct.scan_credits??'?'}</span></div>
    ` : '<div class="credit-row" style="color:var(--text-muted);font-size:9px">Offline — local stats only</div>'}
  `;
}

// ─── PLAYBACK ENGINE ──────────────────────────────────────────────────────────
async function initPlayback() {
  try {
    const r = await fetch('/api/playback/range');
    const d = await r.json();
    if (!d.available || !d.earliest) {
      addLog('PLAYBACK: NO DATA STORED YET');
      document.getElementById('playback-status').textContent = 'NO RECORDED DATA';
      return;
    }
    S.playback.range = { earliest: d.earliest, latest: d.latest };
    S.playback.currentTs = d.latest;
    document.getElementById('playback-status').textContent = 'READY';

    // Build timeline
    await buildTimeline(d.layers?.[0] || 'flights');
    updatePlaybackDisplay();
    addLog(`PLAYBACK: ${Math.round((d.latest-d.earliest)/3600000)}h OF DATA`);
  } catch (e) {
    addLog(`PLAYBACK ERROR: ${e.message}`);
  }
}

async function buildTimeline(layer) {
  try {
    const { earliest, latest } = S.playback.range;
    const r = await fetch(`/api/playback/timeline?layer=${layer}&from=${earliest}&to=${latest}`);
    const d = await r.json();
    renderTimeline(d.points || []);
  } catch {}
}

function renderTimeline(points) {
  const canvas = document.getElementById('timeline-canvas');
  if (!canvas || !points.length) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);

  const { earliest, latest } = S.playback.range;
  const span = latest - earliest || 1;
  const maxCnt = Math.max(...points.map(p=>p[1]), 1);

  // Background
  ctx.fillStyle = 'rgba(0,15,0,0.6)';
  ctx.fillRect(0,0,W,H);

  // Grid lines
  ctx.strokeStyle = 'rgba(0,255,65,0.1)';
  ctx.lineWidth = 1;
  for (let i=0;i<=4;i++) {
    const y = H - (i/4)*H;
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
  }

  // Fill area
  ctx.beginPath();
  ctx.moveTo(0,H);
  for (const [ts, cnt] of points) {
    const x = ((ts-earliest)/span)*W;
    const y = H - (cnt/maxCnt)*(H-4);
    ctx.lineTo(x,y);
  }
  ctx.lineTo(W,H);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,255,65,0.15)';
  ctx.fill();

  // Line
  ctx.beginPath();
  for (let i=0;i<points.length;i++) {
    const [ts,cnt]=points[i];
    const x=((ts-earliest)/span)*W, y=H-(cnt/maxCnt)*(H-4);
    i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  }
  ctx.strokeStyle = 'rgba(0,255,65,0.7)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Current position cursor
  drawTimelineCursor();
}

function drawTimelineCursor() {
  const canvas = document.getElementById('timeline-canvas');
  if (!canvas || !S.playback.currentTs) return;
  const ctx = canvas.getContext('2d');
  const { earliest, latest } = S.playback.range;
  const x = ((S.playback.currentTs - earliest) / (latest - earliest || 1)) * canvas.width;
  ctx.strokeStyle = '#ff2222';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke();
}

async function seekPlayback(ts) {
  S.playback.currentTs = ts;
  updatePlaybackDisplay();

  // Load frame for each active layer
  const layers = ['flights','military','quakes'].filter(k => S.layers[k]?.on);
  for (const layer of layers) {
    try {
      const r = await fetch(`/api/playback/frame?layer=${layer}&ts=${ts}`);
      const d = await r.json();
      if (layer === 'flights' || layer === 'military') {
        renderFlights((d.data?.states||[]), layer==='military');
      } else if (layer === 'quakes') {
        renderQuakes(d.data?.features||[]);
      }
    } catch {}
  }
  drawTimelineCursor();
}

function updatePlaybackDisplay() {
  const ts = S.playback.currentTs;
  if (!ts) return;
  const d = new Date(ts);
  document.getElementById('playback-time').textContent =
    d.toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
}

function togglePlayback() {
  if (S.playback.playing) {
    clearInterval(S.playback.playInterval);
    S.playback.playing = false;
    document.getElementById('pb-play-btn').textContent = '▶ PLAY';
    addLog('PLAYBACK PAUSED');
  } else {
    S.playback.playing = true;
    document.getElementById('pb-play-btn').textContent = '⏸ PAUSE';
    addLog('PLAYBACK RUNNING');
    const step = 30000 * (S.playback.speed || 1); // 30s steps
    S.playback.playInterval = setInterval(async () => {
      const next = (S.playback.currentTs || S.playback.range.earliest) + step;
      if (next > S.playback.range.latest) {
        togglePlayback();
        return;
      }
      await seekPlayback(next);
      // Update scrubber
      const scrubber = document.getElementById('pb-scrubber');
      if (scrubber) {
        const pct = ((next - S.playback.range.earliest) / (S.playback.range.latest - S.playback.range.earliest)) * 100;
        scrubber.value = pct;
      }
    }, 500);
  }
}

// ─── STORAGE STATS ────────────────────────────────────────────────────────────
async function refreshStorageStats() {
  try {
    const r = await fetch('/api/storage/stats');
    const d = await r.json();
    const el = document.getElementById('storage-stats');
    if (!el) return;
    if (!d.available) { el.textContent = 'DB OFFLINE'; return; }
    const totalMB = (d.db_bytes / 1024 / 1024).toFixed(1);
    const lines = d.layers.map(l => {
      const span = l.latest - l.earliest;
      const hrs  = (span/3600000).toFixed(1);
      const kb   = (l.bytes/1024).toFixed(0);
      return `${l.layer.toUpperCase().padEnd(8)} ${l.frames}fr ${hrs}h ${kb}KB`;
    });
    el.innerHTML = `<div class="stat-row">DB SIZE: <span>${totalMB} MB</span></div>` +
      lines.map(l => `<div class="stat-row mono">${l}</div>`).join('');
  } catch {}
}

// ─── CLICK HANDLER ────────────────────────────────────────────────────────────
function onGlobeClick(movement) {
  const picked = S.viewer.scene.pick(movement.position);
  if (!picked?.id) { hideDetail(); return; }
  const ent = picked.id;
  if (!ent.properties) return;
  S._lastEnt = ent;
  const type = ent.properties.type?.getValue();
  const data = ent.properties.data?.getValue();
  const al   = ent.properties.airline?.getValue();
  showDetail(type, ent.name, data, al);
}

function showDetail(type, name, data, airline) {
  const panel = document.getElementById('detail-panel');
  document.getElementById('dp-type-badge').textContent = (type||'UNK').toUpperCase().slice(0,6);
  document.getElementById('dp-title').textContent = name;
  let html = '';

  if (type === 'satellite') {
    const pos = data?.pos||{};
    html = row('NAME',name)+row('LAT',(pos.lat||0).toFixed(3)+'°')+row('LON',(pos.lng||0).toFixed(3)+'°')+row('ALT',Math.round(pos.alt||0)+' km');
  } else if (type === 'flight' || type === 'military') {
    const s = data||[];
    const airlineHtml = airline ? `<div class="dp-airline" style="background:${airline.color}20;border-left:3px solid ${airline.color};padding:4px 8px;margin:4px 0;font-size:10px">${airline.name}</div>` : '';
    html = airlineHtml +
      row('CALLSIGN',(s[1]||'N/A').trim())+row('ICAO24',s[0]||'N/A')+
      row('ORIGIN',s[2]||'N/A')+row('ALT',Math.round(s[7]||0)+' m')+
      row('SPEED',Math.round(s[9]||0)+' m/s')+row('TRACK',Math.round(s[10]||0)+'°')+
      row('LON',(+s[5]||0).toFixed(3)+'°')+row('LAT',(+s[6]||0).toFixed(3)+'°');
  } else if (type === 'ship') {
    const d = data||[];
    const t = +(d.type||0);
    const shipType = t>=80?'TANKER':t>=70?'CARGO':t>=60?'PASSENGER':t>=50?'HIGH-SPEED':'OTHER';
    html = row('NAME',d.name||'UNKNOWN')+row('MMSI',d.mmsi||'N/A')+row('TYPE',shipType)+
      row('FLAG',d.flag||'N/A')+row('SPEED',`${(+(d.sog||0)).toFixed(1)} kt`)+
      row('COURSE',`${Math.round(d.cog||0)}°`)+
      row('DEST',(d.dest||'UNKNOWN').substring(0,20))+
      row('DRAUGHT',d.draught?`${d.draught}m`:'N/A')+
      row('LON',(+d.lon||0).toFixed(4)+'°')+row('LAT',(+d.lat||0).toFixed(4)+'°');
  } else if (type === 'gpsjam') {
    const d = ent.properties.data?.getValue()||{};
    html = row('TYPE','GPS INTERFERENCE')+row('LEVEL',`${data?.level||'?'}/3`)+
      row('AREA',data?.label||'Unknown')+row('SOURCE','gpsjam.org / ADS-B derived');
  } else if (type === 'cctv') {
    const d = data||{};
    html = row('TYPE',`${d.type||'fixed'} camera`)+row('MOUNT',d.mount||'pole')+
      row('OPERATOR',d.operator||'Unknown')+row('ID',d.id||'N/A')+
      row('LON',(+d.lon||0).toFixed(5)+'°')+row('LAT',(+d.lat||0).toFixed(5)+'°')+
      (d.note?row('NOTE',d.note.substring(0,40)):'');
  } else if (type === 'quake') {
    html = row('MAG','M'+(data?.mag||0).toFixed(1))+row('LOCATION',data?.place||'Unknown')+
      row('TIME',data?.time?new Date(data.time).toUTCString():'N/A');
  } else if (type === 'shodan') {
    const d = data||{};
    const vulnBadges = d.vulns?.length
      ? `<div style="margin:4px 0">${d.vulns.map(v=>`<span class="vuln-badge">${v}</span>`).join('')}</div>`
      : '';
    const linkHtml = `<a href="${d.link}" target="_blank" class="shodan-link">🔗 VIEW ON SHODAN</a>`;
    html = row('IP',d.ip)+row('PORT',`${d.port}/${d.transport||'tcp'}`)+
      row('ORG',d.org||'N/A')+row('PRODUCT',d.product||'N/A')+
      row('OS',d.os||'N/A')+row('CITY',`${d.city||''} ${d.country||''}`)+
      (d.tags?.length ? row('TAGS',d.tags.join(', ')) : '')+
      vulnBadges+
      (d.snippet ? `<div class="dp-banner">${d.snippet}</div>` : '')+
      linkHtml;
  }

  document.getElementById('dp-content').innerHTML = html;
  panel.classList.remove('hidden');
}

function row(k,v) {
  return `<div class="dp-row"><span class="dp-key">${k}</span><span class="dp-val">${v}</span></div>`;
}

function hideDetail() {
  document.getElementById('detail-panel').classList.add('hidden');
}

// ─── TRACKING ────────────────────────────────────────────────────────────────
function lockTrack(ent) {
  S.tracking = ent;
  S.viewer.trackedEntity = ent;
  document.getElementById('tracking-info').innerHTML =
    `<div class="track-item"><span>TARGET: </span>${ent.name}</div><div class="track-item"><span>STATUS: </span>LOCKED</div>`;
  document.getElementById('clear-track-btn').style.display = 'block';
  addLog(`LOCKED: ${ent.name}`);
}

function clearTrack() {
  S.tracking = null;
  S.viewer.trackedEntity = undefined;
  document.getElementById('tracking-info').innerHTML = '<div class="no-track">NO TARGET LOCKED</div>';
  document.getElementById('clear-track-btn').style.display = 'none';
  addLog('TARGET RELEASED');
}

// ─── COORDS / CLOCK ──────────────────────────────────────────────────────────
function getViewBbox() {
  if (!S.viewer) return null;
  try {
    const rect = S.viewer.camera.computeViewRectangle();
    if (!rect) return null;
    return {
      minLat: Cesium.Math.toDegrees(rect.south),
      maxLat: Cesium.Math.toDegrees(rect.north),
      minLon: Cesium.Math.toDegrees(rect.west),
      maxLon: Cesium.Math.toDegrees(rect.east),
      centerLat: Cesium.Math.toDegrees((rect.south+rect.north)/2),
      centerLon: Cesium.Math.toDegrees((rect.west+rect.east)/2),
    };
  } catch { return null; }
}

function getCameraAltitude() {
  if (!S.viewer) return 1e9;
  return S.viewer.camera.positionCartographic.height;
}

function getLODLevel(altM) {
  if (altM > LOD.GLOBAL)   return 'GLOBAL';
  if (altM > LOD.REGIONAL) return 'REGIONAL';
  if (altM > LOD.CITY)     return 'CITY';
  return 'STREET';
}

function updateCoords() {
  if (!S.viewer) return;
  const c   = S.viewer.camera.positionCartographic;
  const alt = c.height;
  const km  = alt / 1000;

  document.getElementById('lat-display').textContent = Cesium.Math.toDegrees(c.latitude).toFixed(3)+'°';
  document.getElementById('lon-display').textContent = Cesium.Math.toDegrees(c.longitude).toFixed(3)+'°';
  document.getElementById('alt-display').textContent = km > 1000 ? (km/1000).toFixed(1)+'Mkm' : Math.round(km)+'km';

  // LOD level indicator
  const newLOD = getLODLevel(alt);
  if (newLOD !== currentLOD) {
    currentLOD = newLOD;
    const el = document.getElementById('lod-indicator');
    if (el) {
      el.textContent = `LOD: ${newLOD}`;
      el.className   = `lod-badge lod-${newLOD.toLowerCase()}`;
    }
    addLog(`LOD → ${newLOD}`);
  }

  // Debounced bbox-aware refresh when camera settles
  lastViewBbox = getViewBbox();
  clearTimeout(lodDebounceTimer);
  lodDebounceTimer = setTimeout(onCameraSettled, CONFIG.lodDebounce);
}

function onCameraSettled() {
  const bbox = lastViewBbox;
  if (!bbox) return;
  const alt  = getCameraAltitude();
  const lod  = getLODLevel(alt);

  // Re-fetch all active viewport-bounded layers
  if (S.layers.flights.on)  refreshFlightsBbox(bbox, lod);
  if (S.layers.military.on) refreshFlightsBbox(bbox, lod, true);
  if (S.layers.ships.on && lod !== 'GLOBAL')   refreshShipsBbox(bbox);
  if (S.layers.weather.on)  refreshWeather(bbox, lod);
  if (S.layers.wildfires.on && lod !== 'STREET') refreshWildfires(bbox);
  if (S.layers.cctv.on && (lod === 'CITY' || lod === 'STREET')) {
    clearTimeout(S._cctvRefreshTimer);
    S._cctvRefreshTimer = setTimeout(() => loadCctv(bbox), 500);
  }
  if (S.layers.traffic.on && (lod === 'CITY' || lod === 'STREET')) loadTraffic(bbox);
}

function startClock() {
  const tick = () => {
    const n = new Date();
    document.getElementById('clock').textContent = n.toLocaleTimeString('en-GB',{hour12:false});
    document.getElementById('utc-clock').textContent = n.toISOString().substring(11,19);
  };
  tick(); setInterval(tick, 1000);
}

function addLog(msg) {
  S.logHistory.unshift(msg);
  if (S.logHistory.length > 8) S.logHistory.pop();
  const el = document.getElementById('event-log');
  if (el) el.innerHTML = '<span class="log-label">EVT //</span>'+
    S.logHistory.slice(0,3).map(m=>`<span class="log-item">${m}</span>`).join('');
}

// ─── FLYTO ───────────────────────────────────────────────────────────────────
function flyTo(name) {
  const p = PRESETS[name]; if (!p||!S.viewer) return;
  S.viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(p.lon,p.lat,p.alt),
    orientation: { heading:0, pitch:Cesium.Math.toRadians(p.pitch||(-45)), roll:0 },
    duration:2,
  });
  addLog(`CAMERA → ${name.toUpperCase()}`);
}

// ─── VISION MODE ──────────────────────────────────────────────────────────────
function setVision(mode) {
  document.body.className = document.body.className.replace(/mode-\w+/g,'').trim();
  if (mode!=='normal') document.body.classList.add(`mode-${mode}`);
  document.getElementById('scanlines').style.opacity = {crt:'0.8',nvg:'0.5',flir:'0.4',radar:'0.3'}[mode]||'0.6';
  S.visionMode = mode;
  addLog(`VISION: ${mode.toUpperCase()}`);
}

// ─── UI SETUP ─────────────────────────────────────────────────────────────────
function setupUI() {
  // Layer toggles
  const toggleLayer = (id, key, onFn, offFn) => {
    document.getElementById(id)?.addEventListener('change', e => {
      S.layers[key].on = e.target.checked;
      if (e.target.checked) onFn(); else { offFn?.(); }
    });
  };

  toggleLayer('toggle-satellites','satellites',
    loadSatellites,
    () => { if(S.layers.satellites.ds) S.viewer?.dataSources.remove(S.layers.satellites.ds,true); clearInterval(S.intervals.sat); }
  );
  toggleLayer('toggle-flights','flights',
    () => { loadFlights(false); S.intervals.flights=setInterval(()=>loadFlights(false), CONFIG.flightUpdateInterval); },
    () => { if(S.layers.flights.ds) S.viewer?.dataSources.remove(S.layers.flights.ds,true); clearInterval(S.intervals.flights); }
  );
  toggleLayer('toggle-military','military',
    () => { loadFlights(true); S.intervals.mil=setInterval(()=>loadFlights(true), CONFIG.flightUpdateInterval); },
    () => { if(S.layers.military.ds) S.viewer?.dataSources.remove(S.layers.military.ds,true); clearInterval(S.intervals.mil); }
  );
  toggleLayer('toggle-traffic','traffic', loadTraffic, clearTraffic);
  toggleLayer('toggle-quakes','quakes',
    () => { loadQuakes(); S.intervals.quakes=setInterval(loadQuakes, CONFIG.quakeUpdateInterval); },
    () => { if(S.layers.quakes.ds) S.viewer?.dataSources.remove(S.layers.quakes.ds,true); clearInterval(S.intervals.quakes); }
  );
  document.getElementById('toggle-shodan')?.addEventListener('change', e => {
    if (!e.target.checked) clearShodanLayer();
  });

  toggleLayer('toggle-ships','ships',
    () => { loadShips(); S.intervals.ships = setInterval(loadShips, CONFIG.shipUpdateInterval); },
    () => { if(S.layers.ships.ds) S.viewer?.dataSources.remove(S.layers.ships.ds,true); clearInterval(S.intervals.ships); }
  );
  toggleLayer('toggle-gpsjam','gpsjam',
    () => { loadGpsJam(); S.intervals.gpsjam = setInterval(loadGpsJam, CONFIG.gpsjamUpdateInterval); },
    () => { if(S.layers.gpsjam.ds) S.viewer?.dataSources.remove(S.layers.gpsjam.ds,true); clearInterval(S.intervals.gpsjam); }
  );
  toggleLayer('toggle-cctv','cctv',
    () => loadCctv(lastViewBbox),
    () => { if(S.layers.cctv.ds) S.viewer?.dataSources.remove(S.layers.cctv.ds,true); }
  );

  toggleLayer('toggle-weather','weather',
    () => { refreshWeather(lastViewBbox||getViewBbox(), currentLOD); S.intervals.weather=setInterval(()=>refreshWeather(lastViewBbox||getViewBbox(), currentLOD), CONFIG.weatherUpdateInterval); },
    () => { if(S.layers.weather.ds) S.viewer?.dataSources.remove(S.layers.weather.ds,true); clearInterval(S.intervals.weather); document.getElementById('weather-count').textContent='0'; }
  );

  toggleLayer('toggle-wildfires','wildfires',
    () => { refreshWildfires(lastViewBbox||getViewBbox()); S.intervals.fires=setInterval(()=>refreshWildfires(lastViewBbox||getViewBbox()), CONFIG.fireUpdateInterval); },
    () => { if(S.layers.wildfires.ds) S.viewer?.dataSources.remove(S.layers.wildfires.ds,true); clearInterval(S.intervals.fires); document.getElementById('fire-count').textContent='0'; }
  );

  // NASA GIBS satellite imagery selector
  document.getElementById('gibs-select')?.addEventListener('change', e => {
    setGibsLayer(e.target.value === 'none' ? null : e.target.value);
  });

  // Detection mode
  document.querySelectorAll('.det-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.det-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); S.detMode = btn.dataset.mode;
    if (S.layers.satellites.on) renderSatellites();
    addLog(`DETECT: ${btn.dataset.mode.toUpperCase()}`);
  }));

  // Vision mode
  document.querySelectorAll('.vision-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.vision-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); setVision(btn.dataset.mode);
  }));

  // Camera presets
  document.querySelectorAll('.preset-btn').forEach(btn => btn.addEventListener('click', () => flyTo(btn.dataset.preset)));

  // Post-process sliders
  [['scanline-intensity','scanline-val','#scanlines','opacity',v=>v/100],
   ['vignette-intensity','vignette-val','#vignette','opacity',v=>v/100],
   ['noise-intensity','noise-val','#noise-overlay','opacity',v=>v/500],
   ['bloom-intensity','bloom-val',null,null,v=>v],
  ].forEach(([sid,vid,tgt,prop,scale]) => {
    const el = document.getElementById(sid); if (!el) return;
    el.addEventListener('input', () => {
      const v = parseInt(el.value);
      document.getElementById(vid).textContent = v;
      if (tgt && prop) { const t=document.querySelector(tgt); if(t) t.style[prop]=scale(v); }
    });
  });

  // Detail panel
  document.getElementById('dp-close')?.addEventListener('click', hideDetail);
  document.getElementById('dp-track-btn')?.addEventListener('click', () => { if(S._lastEnt) lockTrack(S._lastEnt); hideDetail(); });
  document.getElementById('clear-track-btn')?.addEventListener('click', clearTrack);

  // Flight filters
  setupFlightFilters();

  // Shodan panel
  document.getElementById('shodan-search-btn')?.addEventListener('click', executeShodanSearch);
  document.getElementById('shodan-query-input')?.addEventListener('keydown', e => { if(e.key==='Enter') executeShodanSearch(); });
  document.getElementById('shodan-save-key-btn')?.addEventListener('click', () => {
    const k = document.getElementById('shodan-key-input')?.value?.trim();
    if (!k) return;
    S.shodan.key = k;
    localStorage.setItem('shodan_key', k);
    document.getElementById('shodan-key-prompt').style.display = 'none';
    addLog('SHODAN KEY SAVED');
    refreshShodanCredits();
  });
  // Load saved key
  const savedKey = localStorage.getItem('shodan_key');
  if (savedKey) { S.shodan.key = savedKey; }

  document.getElementById('shodan-credit-refresh')?.addEventListener('click', refreshShodanCredits);

  // Playback
  document.getElementById('pb-init-btn')?.addEventListener('click', initPlayback);
  document.getElementById('pb-play-btn')?.addEventListener('click', togglePlayback);
  document.getElementById('pb-speed')?.addEventListener('change', e => { S.playback.speed = parseFloat(e.target.value)||1; });
  document.getElementById('pb-scrubber')?.addEventListener('input', e => {
    const pct = parseFloat(e.target.value)/100;
    const ts = S.playback.range.earliest + pct*(S.playback.range.latest-S.playback.range.earliest);
    seekPlayback(Math.round(ts));
  });
  document.getElementById('timeline-canvas')?.addEventListener('click', e => {
    const canvas = e.target;
    const pct = e.offsetX / canvas.width;
    const ts = S.playback.range.earliest + pct*(S.playback.range.latest-S.playback.range.earliest);
    if (ts) { seekPlayback(Math.round(ts)); const s=document.getElementById('pb-scrubber'); if(s)s.value=pct*100; }
  });

  // Storage stats refresh
  document.getElementById('storage-refresh-btn')?.addEventListener('click', refreshStorageStats);

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    const n = parseInt(e.key);
    if (n>=1&&n<=5) { const modes=['normal','crt','nvg','flir','radar']; document.querySelector(`.vision-btn[data-mode="${modes[n-1]}"]`)?.click(); }
    if (e.key==='Escape') { hideDetail(); clearTrack(); }
    if (e.key==='f'||e.key==='F') { document.getElementById('filter-panel')?.classList.toggle('hidden'); }
  });

  // Tab switching for left panel sections
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p=>p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${target}`)?.classList.remove('hidden');
  }));
}

function setupFlightFilters() {
  const applyFilters = () => {
    S.filters.flights.minAlt  = parseInt(document.getElementById('f-min-alt')?.value||0);
    S.filters.flights.maxAlt  = parseInt(document.getElementById('f-max-alt')?.value||45000);
    S.filters.flights.minSpd  = parseInt(document.getElementById('f-min-spd')?.value||0);
    S.filters.flights.maxSpd  = parseInt(document.getElementById('f-max-spd')?.value||1200);
    S.filters.flights.country = document.getElementById('f-country')?.value?.trim()||'';
    S.filters.flights.callsign= document.getElementById('f-callsign')?.value?.trim()||'';
    S.filters.flights.showUnknown = document.getElementById('f-show-unknown')?.checked ?? true;

    if (S.layers.flights.on) applyFlightFilters(false);
    if (S.layers.military.on) applyFlightFilters(true);
    addLog('FILTERS APPLIED');
  };

  const resetFilters = () => {
    document.getElementById('f-min-alt').value = 0;
    document.getElementById('f-max-alt').value = 45000;
    document.getElementById('f-min-spd').value = 0;
    document.getElementById('f-max-spd').value = 1200;
    document.getElementById('f-country').value = '';
    document.getElementById('f-callsign').value = '';
    document.getElementById('f-show-unknown').checked = true;
    applyFilters();
  };

  document.getElementById('filter-apply-btn')?.addEventListener('click', applyFilters);
  document.getElementById('filter-reset-btn')?.addEventListener('click', resetFilters);

  // Live update on Enter
  ['f-country','f-callsign'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => { if(e.key==='Enter') applyFilters(); });
  });
}
