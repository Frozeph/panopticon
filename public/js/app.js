/* ══ NEXUS v7 ══════════════════════════════════════════════════════════════════
 * Geospatial Intelligence Dashboard
 * (Also known as: SENTINEL, OVERSEER, VANTAGE, MERIDIAN, ORACLE, PARALLAX)
 * - satellite.js SGP4 propagation (accurate orbital mechanics)
 * - Viewport-frustum culling: only fetch what's in view
 * - GDELT intel feed: 100+ languages, corroboration scoring
 * - AI natural-language queries via Claude
 * - GPS jamming hex grid (H3 resolution 4, gpsjam.org data)
 * - Entity track trails on click, OSINT geo-filtering, LiveUAMap-style feed
 * - 3D terrain: ESRI WorldElevation3D (free, no token) + NASA GIBS live sat
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CFG = {
  // Token injected from Docker env via /api/config.js → window.CESIUM_ION_TOKEN
  cesiumToken: (typeof window !== 'undefined' && window.CESIUM_ION_TOKEN) ? window.CESIUM_ION_TOKEN : '',
  refreshFlights:   10000,  // 10s — ADS-B positions
  refreshMilitary: 20000,  // 20s — military ADS-B (slower moving)
  refreshShips:    30000,  // 30s — AIS ships (move slowly)
  refreshQuakes:  120000,  // 2 min
  refreshSats:     30000,  // 30s — re-propagate TLE positions (was 5s — too aggressive)
  refreshIntel:   300000,  // 5 min
  maxSats:           300,  // render limit (was 2000 — too many entities)
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const S = {
  viewer:      null,
  tleData:     [],
  satDs:       null,   // satellite DataSource
  flightDs:    null,
  militaryDs:  null,
  shipDs:      null,
  quakeDs:     null,
  cctvDs:      null,
  fireDs:      null,
  meshDs:      null,
  shodanDs:    null,
  intelDs:     null,   // GDELT event pins on map
  trackDs:     null,   // entity trail polyline
  osintMarkerDs: null, // OSINT geo-tagged map pins
  intervals:   {},
  // All layers start OFF for performance — enable individually
  layers: {
    satellites: false, flights: false, military: false, ships: false,
    quakes: false, cctv: false, wildfires: false, jamming: false,
    mesh: false, intel: false, osint: false, maven: false,
  },
  osintGeoBound: false, // whether OSINT is filtered to viewport
  activeSatGroups: new Set(['recon']),
  showFootprints:  false,
  intelArticles:  [],
  intelFilter:    '',
  intelQuery:     '',
  selectedEntity: null,
  trackedEntity:  null,
  playbackMode:   false,
  cameraAlt:      10e6,   // metres above ground
};

// ─── LOG SYSTEM ───────────────────────────────────────────────────────────────
// In requestRenderMode:true the scene only draws when explicitly told to.
// Call this after any entity/datasource change to keep display current.
function scheduleRender() {
  try { S.viewer?.scene?.requestRender(); } catch {}
}

function log(msg, level='info') {
  const ts = new Date().toISOString().substring(11,19) + 'Z';
  const wrap = document.getElementById('log-body');
  if (!wrap) return;
  const div = document.createElement('div');
  div.className = 'log-line';
  div.innerHTML = `<span class="log-ts">${ts}</span><span class="log-msg ${level==='warn'?'warn':level==='error'?'err':'ok'}">${msg}</span>`;
  wrap.prepend(div);
  if (wrap.children.length > 80) wrap.lastChild?.remove();
}

function toggleLog() {
  document.getElementById('log-wrap').classList.toggle('expanded');
}

// ─── TOASTS ───────────────────────────────────────────────────────────────────
function toast(msg, type='info', duration=4000) {
  const c = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// ─── CLOCK ────────────────────────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toUTCString().split(' ')[4] + 'Z';
}
setInterval(updateClock, 1000);
updateClock();

// ─── CESIUM INIT ─────────────────────────────────────────────────────────────
// NOTE: Cesium 1.107 removed imageryProvider + terrainProvider from the Viewer
// constructor. Use baseLayer:false to suppress Ion/Bing default, then add
// imagery and terrain manually after init.
Cesium.Ion.defaultAccessToken = CFG.cesiumToken;

S.viewer = new Cesium.Viewer('cesiumContainer', {
  baseLayer:              false,   // suppress default Ion Bing imagery (token-gated)
  timeline:               false,
  animation:              false,
  homeButton:             false,
  geocoder:               false,
  navigationHelpButton:   false,
  sceneModePicker:        false,
  baseLayerPicker:        false,
  fullscreenButton:       false,
  infoBox:                false,
  selectionIndicator:     false,
  skyBox:                 false,
  requestRenderMode:      true,   // only render when data changes — saves GPU
  maximumRenderTimeChange: 2000,  // fallback: re-render at most every 2s regardless
  scene3DOnly:            false,
});

// Add CARTO dark basemap (no token required)
S.viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
  url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  subdomains: 'abcd', minimumLevel: 0, maximumLevel: 19,
  credit: '© CARTO © OpenStreetMap contributors',
}));

// Load ESRI WorldElevation3D terrain asynchronously
// (ArcGISTiledElevationTerrainProvider became async in Cesium 1.104+)
Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'
).then(tp => {
  S.viewer.terrainProvider = tp;
  S._esriTerrainProvider = tp;
  log('3D terrain loaded (ESRI WorldElevation3D)', 'ok');
}).catch(e => {
  console.warn('ESRI terrain unavailable, using ellipsoid:', e.message);
});

// Dark void background
S.viewer.scene.backgroundColor = new Cesium.Color(0.04, 0.04, 0.06, 1);
S.viewer.scene.globe.show = true;

// ─── REQUEST RENDER HOOKS ─────────────────────────────────────────────────────
// requestRenderMode:true stops continuous 60fps GPU rendering.
// Cesium renders automatically on camera change; we trigger after data updates.
S.viewer.dataSources.dataSourceAdded.addEventListener(scheduleRender);
S.viewer.dataSources.dataSourceRemoved.addEventListener(scheduleRender);
// Heartbeat: ensure the scene never goes completely stale (covers edge cases)
setInterval(scheduleRender, 2000);

// 3D Buildings — Cesium OSM Buildings (Ion asset 96188, free tier)
// Requires a valid Cesium Ion token at cesium.com/ion (free account).
// Fails silently if the token in CFG.cesiumToken is expired/invalid.
Cesium.createOsmBuildingsAsync().then(tileset => {
  S.osmBuildingsTileset = S.viewer.scene.primitives.add(tileset);
  // Slight style: dim buildings slightly so they don't overpower the dark basemap
  tileset.style = new Cesium.Cesium3DTileStyle({
    color: 'color("rgb(60,65,80)", 1.0)',
  });
  log('OSM Buildings loaded', 'ok');
}).catch(() => {
  // Silently skip — token likely expired. User can update CFG.cesiumToken
  // with a free token from https://cesium.com/ion/tokens
  console.info('[Buildings] OSM Buildings unavailable — update CFG.cesiumToken with a free Ion token');
});

// ─── BASEMAP ──────────────────────────────────────────────────────────────────
// No Ion dependency — use free tile providers so it works without a Cesium token
async function applyBasemap(mode) {
  try { S.viewer.imageryLayers.removeAll(); } catch(e) { console.warn('Layer clear:', String(e)); }
  const gibsBadge = document.getElementById('gibs-date-badge');

  // Keep terrain provider intact — only swap imagery
  const layers = S.viewer.imageryLayers;

  // Terrain exaggeration based on mode
  // scene.verticalExaggeration replaces deprecated globe.terrainExaggeration (Cesium 1.113+)
  try { S.viewer.scene.verticalExaggeration = (mode === 'terrain') ? 2.5 : 1.0; } catch {
    try { S.viewer.scene.globe.terrainExaggeration = (mode === 'terrain') ? 2.5 : 1.0; } catch {}
  }

  try {
    if (mode === 'dark') {
      layers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        subdomains: 'abcd', minimumLevel: 0, maximumLevel: 19,
        credit: '© CARTO © OpenStreetMap contributors',
      }));
      if (gibsBadge) gibsBadge.style.display = 'none';

    } else if (mode === 'satellite') {
      layers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        minimumLevel: 0, maximumLevel: 19,
        credit: '© Esri, Maxar, Earthstar Geographics',
      }));
      if (gibsBadge) gibsBadge.style.display = 'none';

    } else if (mode === 'terrain') {
      layers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        minimumLevel: 0, maximumLevel: 18, credit: '© Esri, Maxar',
      }));
      if (gibsBadge) gibsBadge.style.display = 'none';

    } else if (mode === 'gibs_modis') {
      // NASA GIBS MODIS Terra TrueColor — near-real-time, ~1-3 day lag
      const yesterday = new Date(Date.now() - 86400000 * 2).toISOString().substring(0, 10);
      layers.addImageryProvider(new Cesium.WebMapTileServiceImageryProvider({
        url: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/' + yesterday + '/250m/{TileMatrix}/{TileRow}/{TileCol}.jpg',
        layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
        style: 'default', format: 'image/jpeg',
        tileMatrixSetID: '250m',
        maximumLevel: 8,
        tilingScheme: new Cesium.GeographicTilingScheme(),
        credit: '© NASA/GSFC EOSDIS — MODIS Terra (' + yesterday + ')',
      }));
      if (gibsBadge) { gibsBadge.textContent = '🛰 MODIS Terra · ' + yesterday; gibsBadge.style.display = 'block'; }
      log(`GIBS MODIS basemap: ${yesterday}`);

    } else if (mode === 'gibs_viirs') {
      // NASA GIBS VIIRS SNPP DayNightBand — shows city lights at night
      const yesterday = new Date(Date.now() - 86400000 * 2).toISOString().substring(0, 10);
      layers.addImageryProvider(new Cesium.WebMapTileServiceImageryProvider({
        url: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/VIIRS_SNPP_DayNightBand_AtSensor_Radiance/default/' + yesterday + '/500m/{TileMatrix}/{TileRow}/{TileCol}.tif',
        layer: 'VIIRS_SNPP_DayNightBand_AtSensor_Radiance',
        style: 'default', format: 'image/tiff',
        tileMatrixSetID: '500m',
        maximumLevel: 7,
        tilingScheme: new Cesium.GeographicTilingScheme(),
        credit: '© NASA/GSFC EOSDIS — VIIRS Night (' + yesterday + ')',
      }));
      if (gibsBadge) { gibsBadge.textContent = '🌃 VIIRS Night · ' + yesterday; gibsBadge.style.display = 'block'; }
    }
  } catch(e) {
    console.warn('Basemap error, falling back to dark tiles:', String(e));
    try {
      layers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        subdomains: 'abcd', minimumLevel: 0, maximumLevel: 19, credit: '© CARTO',
      }));
    } catch {}
  }
}

document.getElementById('basemap-sel').addEventListener('change', e => applyBasemap(e.target.value));

// ─── VIEW MODES ───────────────────────────────────────────────────────────────
document.getElementById('btn-3d').addEventListener('click', () => {
  S.viewer.scene.morphTo3D(0.5);
  document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('btn-3d').classList.add('active');
});
document.getElementById('btn-2d').addEventListener('click', () => {
  S.viewer.scene.morphTo2D(0.5);
  document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('btn-2d').classList.add('active');
});
document.getElementById('btn-cv').addEventListener('click', () => {
  S.viewer.scene.morphToColumbusView(0.5);
  document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('btn-cv').classList.add('active');
});

// ─── CAMERA HELPERS ───────────────────────────────────────────────────────────
function getCameraInfo() {
  const cam = S.viewer.camera;
  const carto = Cesium.Ellipsoid.WGS84.cartesianToCartographic(cam.positionWC);
  const lat = Cesium.Math.toDegrees(carto?.latitude || 0);
  const lon = Cesium.Math.toDegrees(carto?.longitude || 0);
  const altM = carto?.height || 10e6;
  S.cameraAlt = altM;
  return { lat, lon, altKm: altM / 1000 };
}

function getViewportBbox() {
  // Compute approximate bounding box of current viewport
  // Returns {minLat, maxLat, minLon, maxLon} or null if can't compute
  try {
    const rect = S.viewer.camera.computeViewRectangle(S.viewer.scene.globe.ellipsoid);
    if (!rect) return null;
    return {
      minLat: Cesium.Math.toDegrees(rect.south),
      maxLat: Cesium.Math.toDegrees(rect.north),
      minLon: Cesium.Math.toDegrees(rect.west),
      maxLon: Cesium.Math.toDegrees(rect.east),
    };
  } catch { return null; }
}

// Camera position display
S.viewer.scene.postRender.addEventListener(() => {
  const { lat, lon, altKm } = getCameraInfo();
  const el = document.getElementById('loc-display');
  if (el) el.textContent = `${lat.toFixed(2)}°${lat>=0?'N':'S'} ${Math.abs(lon).toFixed(2)}°${lon>=0?'E':'W'} ALT:${altKm.toFixed(0)}km`;
});

// ─── LAYER TOGGLE BUTTONS ─────────────────────────────────────────────────────
// Explicit map: layer name → state property name for the DataSource
const LAYER_DS_KEY = {
  satellites: 'satDs',
  flights:    'flightDs',
  military:   'militaryDs',
  ships:      'shipDs',
  quakes:     'quakeDs',
  cctv:       'cctvDs',
  wildfires:  'fireDs',
  jamming:    'jammingDs',
  mesh:       'meshDs',
  intel:      'intelDs',
};

document.querySelectorAll('.lbtn').forEach(btn => {
  const layer = btn.dataset.layer;
  btn.addEventListener('click', () => {
    const on = !btn.classList.contains('on');
    btn.classList.toggle('on', on);
    S.layers[layer] = on;

    if (layer === 'intel') {
      document.getElementById('intel-panel').style.display = on ? 'flex' : 'none';
      document.getElementById('cesiumContainer').style.right = on ? 'var(--intel-w)' : '0';
      if (on) {
        // Close competing panels
        document.getElementById('osint-panel').style.display = 'none';
        document.getElementById('maven-panel').style.display = 'none';
        document.querySelector('[data-layer="osint"]')?.classList.remove('on');
        document.querySelector('[data-layer="maven"]')?.classList.remove('on');
        S.layers.osint = false; S.layers.maven = false;
      }
      return;
    }
    // Skip osint/maven — handled by their own listeners below
    if (layer === 'osint' || layer === 'maven') return;

    if (!on) {
      const dsKey = LAYER_DS_KEY[layer];
      if (dsKey && S[dsKey]) {
        S.viewer.dataSources.remove(S[dsKey], true);
        S[dsKey] = null;
      }
      if (layer === 'satellites') {
        clearInterval(S.intervals.sat);
        if (satFootprintDs) { S.viewer.dataSources.remove(satFootprintDs, true); satFootprintDs = null; }
      }
    } else {
      switch(layer) {
        case 'satellites': loadSatellites(); break;
        case 'flights':    fetchFlights();   break;
        case 'military':   fetchMilitary();  break;
        case 'ships':      fetchShips();     break;
        case 'quakes':     fetchQuakes();    break;
        case 'cctv':       fetchCCTV();      break;
        case 'wildfires':  fetchFires();     break;
        case 'jamming':    fetchJamming();   break;
        case 'mesh':       fetchMesh();      break;
      }
    }
  });
});

// ─── SATELLITES ───────────────────────────────────────────────────────────────
// Uses satellite.js (SGP4) for accurate positions
async function loadSatellites() {
  clearInterval(S.intervals.sat);
  log('Fetching TLE data…');
  S.tleData = [];

  const groups = [...S.activeSatGroups];
  const seen = new Set();

  for (const grp of groups) {
    try {
      const r = await fetch(`/api/tle/${encodeURIComponent(grp)}`);
      if (!r.ok) { log(`TLE ${grp}: HTTP ${r.status}`, 'warn'); continue; }
      const txt = await r.text();
      if (!txt.includes('\n1 ')) { log(`TLE ${grp}: no valid data`, 'warn'); continue; }
      const parsed = parseTLE(txt);
      let added = 0;
      for (const s of parsed) {
        if (!seen.has(s.name)) { seen.add(s.name); S.tleData.push(s); added++; }
      }
      log(`TLE ${grp}: ${added} satellites loaded`);
    } catch(e) { log(`TLE ${grp}: ${e.message}`, 'error'); }
  }

  document.getElementById('cnt-sat').textContent = S.tleData.length;
  if (!S.tleData.length) { toast('No satellite TLE data', 'warn'); return; }

  renderSatellites();
  S.intervals.sat = setInterval(renderSatellites, CFG.refreshSats);
  toast(`${S.tleData.length} satellites tracked`, 'ok', 3000);
}

function parseTLE(txt) {
  const lines = txt.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length - 2; i += 3) {
    if (lines[i+1]?.startsWith('1 ') && lines[i+2]?.startsWith('2 ')) {
      const name = lines[i].replace(/^0 /, '').trim();
      out.push({ name, tle1: lines[i+1], tle2: lines[i+2] });
    }
  }
  return out;
}

let satFootprintDs = null;

function renderSatellites() {
  if (!S.layers.satellites || !S.viewer) return;
  if (S.satDs) S.viewer.dataSources.remove(S.satDs, true);

  const ds = new Cesium.CustomDataSource('satellites');
  const now = new Date();
  const altKm = S.cameraAlt / 1000;
  const showLabels = altKm < 5000;
  const limit = Math.min(S.tleData.length, CFG.maxSats);

  let rendered = 0;
  for (let i = 0; i < limit; i++) {
    const sat = S.tleData[i];
    try {
      const pos = sgp4Position(sat.tle1, sat.tle2, now);
      if (!pos) continue;
      rendered++;

      const isStation = sat.name.match(/ISS|TIANGONG|CSS|NAUKA/i);
      const isStarlink = sat.name.includes('STARLINK');
      const reconInfo = classifyReconSat(sat.name, pos.alt);
      // Use recon type colour if it's a known recon type; green fallback otherwise
      const color = isStation ? '#ff6600' : isStarlink ? '#4488ff' : reconInfo.type !== 'generic' ? reconInfo.color : '#00ffaa';

      ds.entities.add({
        id: `sat_${i}`,
        name: sat.name,
        position: Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, pos.alt * 1000),
        point: {
          pixelSize: isStation ? 5 : 2.5,
          color: Cesium.Color.fromCssColorString(color).withAlpha(isStation ? 1.0 : 0.85),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: isStation ? 2 : 0,
          scaleByDistance: new Cesium.NearFarScalar(1.5e6, 2, 2e8, 0.5),
        },
        label: showLabels ? {
          text: sat.name.length > 12 ? sat.name.substring(0, 12) + '…' : sat.name,
          font: '10px JetBrains Mono',
          fillColor: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
          outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(8, 0),
          translucencyByDistance: new Cesium.NearFarScalar(1e7, 1, 1e8, 0),
        } : undefined,
        properties: { type: 'satellite', name: sat.name, alt: pos.alt, lat: pos.lat, lon: pos.lng, tleIdx: i },
      });
    } catch {}
  }

  S.viewer.dataSources.add(ds);
  S.satDs = ds;

  // Render footprints if enabled
  if (S.showFootprints) renderSatFootprints(now);
}

// ─── SATELLITE FOOTPRINTS ─────────────────────────────────────────────────────
// Coverage model based on publicly available orbital and sensor parameters.
//
// Each satellite is classified into a sensor type by name matching:
//
//  OPTICAL-HI  (KH-11/Crystal class, USA-NRO, Ofek, Helios, Pleiades Neo)
//    Altitude:  ~300–500 km (from publicly published TLE apogee/perigee)
//    Swath:     ~15 km (estimated from published resolution + aperture)
//    Off-nadir: ±30° max agile pointing → access radius = h × tan(30°)
//    Colour:    amber
//
//  SAR-RECON  (Lacrosse/Onyx, Yaogan SAR, COSMO-SkyMed, SAR-Lupe, Sentinel-1)
//    Altitude:  ~500–800 km
//    Swath:     ~30–80 km (stripmap mode — publicly documented for Sentinel-1)
//    Off-nadir: typically ±20–30°; access radius = h × tan(25°)
//    Colour:    purple
//
//  ELINT/SIGINT (USA-XXX high-altitude SIGINT, POPPY, Trumpet, Mercury)
//    Altitude:  ~1000 km+
//    No optical swath — broad electronic collection area modelled as wide cone
//    Off-nadir: ±60° (SIGINT has wider effective collection)
//    Colour:    red
//
//  SPACE-STATION (ISS, Tiangong) — special case, wide swath crew photography
//    Colour: orange
//
//  GENERIC MILITARY — fallback for unclassified military payloads
//    Uses altitude-derived estimate (off-nadir ±20° access, 5° sensor)
//    Colour: amber (dim)

function classifyReconSat(name, altKm) {
  const n = name.toUpperCase();

  // Space stations
  if (/ISS|ZARYA|TIANGONG|CSS|NAUKA/.test(n))
    return { type: 'station', swathKm: 20, accessDeg: 51, color: '#ff6600', label: 'ISS/Station' };

  // SAR satellites — publicly documented
  if (/LACROSSE|ONYX/.test(n))
    return { type: 'sar', swathKm: 50, accessDeg: 28, color: '#a855f7', label: 'SAR (Lacrosse/Onyx)' };
  if (/COSMO.?SKY|COSMOSKY/.test(n))
    return { type: 'sar', swathKm: 40, accessDeg: 30, color: '#a855f7', label: 'SAR (COSMO-SkyMed)' };
  if (/SAR.?LUPE/.test(n))
    return { type: 'sar', swathKm: 35, accessDeg: 30, color: '#a855f7', label: 'SAR (SAR-Lupe)' };
  if (/SENTINEL.?1/.test(n))
    return { type: 'sar', swathKm: 80, accessDeg: 35, color: '#a855f7', label: 'SAR (Sentinel-1)' };
  if (/YAOGAN/.test(n) && altKm > 450)
    return { type: 'sar', swathKm: 45, accessDeg: 27, color: '#a855f7', label: 'SAR (Yaogan)' };
  if (/KONDOR/.test(n))
    return { type: 'sar', swathKm: 30, accessDeg: 25, color: '#a855f7', label: 'SAR (Kondor)' };
  if (/PAZ|SAOCOM/.test(n))
    return { type: 'sar', swathKm: 40, accessDeg: 30, color: '#a855f7', label: 'SAR (PAZ/SAOCOM)' };

  // Optical reconnaissance — high resolution
  if (/OFEK/.test(n))
    return { type: 'optical', swathKm: 12, accessDeg: 30, color: '#f59e0b', label: 'Optical (Ofek)' };
  if (/HELIOS/.test(n))
    return { type: 'optical', swathKm: 18, accessDeg: 28, color: '#f59e0b', label: 'Optical (Helios)' };
  if (/PLEIAD|PLEIADES/.test(n))
    return { type: 'optical', swathKm: 20, accessDeg: 30, color: '#f59e0b', label: 'Optical (Pléiades)' };
  if (/SPOT/.test(n))
    return { type: 'optical', swathKm: 60, accessDeg: 27, color: '#f59e0b', label: 'Optical (SPOT)' };
  if (/YAOGAN/.test(n) && altKm <= 450)
    return { type: 'optical', swathKm: 15, accessDeg: 30, color: '#f59e0b', label: 'Optical (Yaogan)' };
  if (/ELECTRO.?L|KANOPUS/.test(n))
    return { type: 'optical', swathKm: 60, accessDeg: 25, color: '#f59e0b', label: 'Optical (Electro/Kanopus)' };
  if (/BARS.?M/.test(n))
    return { type: 'optical', swathKm: 20, accessDeg: 30, color: '#f59e0b', label: 'Optical (Bars-M)' };
  if (/RESURS/.test(n))
    return { type: 'optical', swathKm: 30, accessDeg: 25, color: '#f59e0b', label: 'Optical (Resurs)' };
  if (/SENTINEL.?2/.test(n))
    return { type: 'optical', swathKm: 290, accessDeg: 20, color: '#f59e0b', label: 'Optical (Sentinel-2)' };
  if (/WORLDVIEW|GEOEYE|MAXAR/.test(n))
    return { type: 'optical', swathKm: 13, accessDeg: 45, color: '#f59e0b', label: 'Optical (WorldView)' };
  if (/SKYSAT|SKYSATC/.test(n))
    return { type: 'optical', swathKm: 6, accessDeg: 45, color: '#f59e0b', label: 'Optical (SkySat)' };
  // USA-NRO satellites (KH-11 Crystal/Kennan class): publicly tracked NORAD objects
  // These are at low perigee (~290–400 km) with high eccentricity or SSO orbits
  if (/^USA-/.test(n) && altKm < 600)
    return { type: 'optical', swathKm: 15, accessDeg: 32, color: '#f59e0b', label: 'Optical (NRO USA-class)' };
  if (/^USA-/.test(n) && altKm >= 600)
    return { type: 'elint', swathKm: 0, accessDeg: 55, color: '#ef4444', label: 'SIGINT/ELINT (NRO)' };

  // SIGINT / ELINT
  if (/TRUMPET|MERCURY|MENTOR|ADVANCED ORION|JUMPSEAT|AQUACADE/.test(n))
    return { type: 'elint', swathKm: 0, accessDeg: 60, color: '#ef4444', label: 'SIGINT' };
  if (/TRUMPET/.test(n))
    return { type: 'elint', swathKm: 0, accessDeg: 60, color: '#ef4444', label: 'SIGINT (Trumpet)' };

  // Generic military — unknown payload
  return { type: 'generic', swathKm: altKm * Math.tan(5 * Math.PI / 180), accessDeg: 20, color: '#94a3b8', label: 'Military (unknown)' };
}

function renderSatFootprints(now) {
  if (satFootprintDs) S.viewer.dataSources.remove(satFootprintDs, true);
  if (!S.tleData.length) return;

  const ds   = new Cesium.CustomDataSource('sat_footprints');
  const date = now || new Date();

  // Cap at 100 to keep entity count manageable (each sat creates 2–3 entities + track)
  const limit = Math.min(S.tleData.length, 100);

  for (let i = 0; i < limit; i++) {
    const sat = S.tleData[i];
    try {
      const pos = sgp4Position(sat.tle1, sat.tle2, date);
      if (!pos) continue;
      const h = pos.alt;  // km above ellipsoid
      if (h < 100 || h > 42000) continue;

      const isGEO = h > 35000;
      const info  = classifyReconSat(sat.name, h);
      const cesColor = Cesium.Color.fromCssColorString(info.color);
      // Guard against NaN positions (failed SGP4 propagation) — NaN Cartesian3
      // causes wgs84To2DModelMatrix to crash with "can't access property longitude"
      if (!isFinite(pos.lng) || !isFinite(pos.lat)) continue;
      const groundPos = Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, 0);

      // ── ACCESS AREA — maximum off-nadir pointing circle
      // Radius = h × tan(accessDeg) in km → metres
      const accessRadM = h * Math.tan(info.accessDeg * Math.PI / 180) * 1000;

      if (!isGEO && accessRadM > 0) {
        ds.entities.add({
          position: groundPos,
          ellipse: {
            semiMinorAxis: accessRadM,
            semiMajorAxis: accessRadM,
            material:      cesColor.withAlpha(0.10),
            outline:       true,
            outlineColor:  cesColor.withAlpha(0.60),
            outlineWidth:  1.5,
            height:        0,  // ground level; no heightReference — avoids wgs84To2DModelMatrix crash
          },
        });
      }

      // ── SENSOR SWATH / INSTANTANEOUS FOOTPRINT
      if (info.type !== 'elint' && info.swathKm > 0) {
        const swathRadM = (info.swathKm / 2) * 1000;
        ds.entities.add({
          position: groundPos,
          ellipse: {
            semiMinorAxis: isGEO ? 2500000 : swathRadM,
            semiMajorAxis: isGEO ? 2500000 : swathRadM,
            material:      cesColor.withAlpha(info.type === 'station' ? 0.25 : 0.18),
            outline:       true,
            outlineColor:  cesColor.withAlpha(info.type === 'station' ? 0.95 : 0.85),
            outlineWidth:  info.type === 'station' ? 2.5 : 1.5,
            height:        0,  // ground level; no heightReference — avoids wgs84To2DModelMatrix crash
          },
        });
      }

      // ── SUB-SATELLITE POINT (nadir marker)
      ds.entities.add({
        position: groundPos,
        point: {
          pixelSize: info.type === 'station' ? 5 : 2,
          color: cesColor.withAlpha(0.8),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });

      // ── GROUND TRACK ±20 min (LEO only)
      if (!isGEO) {
        const trackPositions = [];
        const spanMs = 20 * 60 * 1000;
        for (let s = 0; s <= 40; s++) {
          const t = new Date(date.getTime() - spanMs / 2 + (spanMs * s / 40));
          try {
            const tp = sgp4Position(sat.tle1, sat.tle2, t);
            if (tp && isFinite(tp.lng) && isFinite(tp.lat)) trackPositions.push(Cesium.Cartesian3.fromDegrees(tp.lng, tp.lat, 0));
          } catch {}
        }
        if (trackPositions.length > 2) {
          ds.entities.add({
            polyline: {
              positions:  trackPositions,
              width:      info.type === 'station' ? 1.5 : 0.7,
              material:   new Cesium.ColorMaterialProperty(cesColor.withAlpha(0.28)),
              clampToGround: true,
            },
          });
        }
      }
    } catch {}
  }

  S.viewer.dataSources.add(ds);
  satFootprintDs = ds;
}

// SGP4 propagation using satellite.js (accurate)
function sgp4Position(tle1, tle2, date) {
  try {
    const satrec = satellite.twoline2satrec(tle1, tle2);
    const posVel  = satellite.propagate(satrec, date);
    if (!posVel?.position || posVel.position === false) return null;

    const gmst = satellite.gstime(date);
    const geo  = satellite.eciToGeodetic(posVel.position, gmst);

    const lat = Cesium.Math.toDegrees(geo.latitude);
    const lng = Cesium.Math.toDegrees(geo.longitude);
    const alt = geo.height;  // km above ellipsoid

    if (isNaN(lat) || isNaN(lng) || isNaN(alt)) return null;
    if (lat < -90 || lat > 90) return null;

    return { lat, lng, alt };
  } catch { return null; }
}

// Satellite group checkboxes
document.querySelectorAll('[data-satgrp]').forEach(cb => {
  cb.addEventListener('change', () => {
    const grp = cb.dataset.satgrp;
    if (cb.checked) S.activeSatGroups.add(grp);
    else S.activeSatGroups.delete(grp);
  });
});
document.getElementById('reload-sats').addEventListener('click', () => {
  if (S.layers.satellites) loadSatellites();
});
document.getElementById('toggle-footprints').addEventListener('change', (e) => {
  S.showFootprints = e.target.checked;
  if (!e.target.checked && satFootprintDs) {
    S.viewer.dataSources.remove(satFootprintDs, true);
    satFootprintDs = null;
  } else if (e.target.checked && S.tleData.length) {
    renderSatFootprints(new Date());
  }
});

// ─── FLIGHTS ──────────────────────────────────────────────────────────────────
const ALT_COLORS = [
  [15,     '#999999'],  // ground
  [300,    '#ff7f00'],  // <1000ft
  [1524,   '#ff9900'],  // <5000ft
  [3048,   '#ffcc00'],  // <10000ft
  [5486,   '#aaee22'],  // <18000ft
  [7620,   '#00ee88'],  // <25000ft
  [10058,  '#00ccff'],  // <33000ft
  [12192,  '#2299ff'],  // <40000ft
  [13716,  '#9955ff'],  // <45000ft
  [Infinity,'#ff44aa'], // 45000ft+
];

function altColor(altM) {
  if (altM == null || altM <= 15) return ALT_COLORS[0][1];
  for (const [thresh, color] of ALT_COLORS) {
    if (altM <= thresh) return color;
  }
  return '#ff44aa';
}

function planeIcon(color, rotDeg, size=16) {
  // SVG aircraft silhouette pointing up, rotated by heading
  const r = (rotDeg || 0);
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16"><g transform="rotate(${r},8,8)"><path d="M8 1 L10 8 L14 9 L10 11 L10 13 L8 12 L6 13 L6 11 L2 9 L6 8 Z" fill="${color}" stroke="#000" stroke-width="0.5"/></g></svg>`)}`;
}

function milIcon(color) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><polygon points="7,1 13,13 1,13" fill="${color}" stroke="#000" stroke-width="0.5"/></svg>`)}`;
}

async function fetchFlights() {
  if (!S.layers.flights) return;
  const { lat, lon } = getCameraInfo();

  // ── LOD tiers based on approximate viewport width ──────────────────────────
  // viewWidthNm ≈ cameraAlt_m * 1.15 / 1852  (60° FOV approximation)
  // Tier 1 — global (> ~1500km alt / ~930nm view): multi-region endpoint
  // Tier 2 — regional (100–930nm view): radius-based with up to 250nm
  // Tier 3 — local (< 100nm view): tight 50nm radius for maximum detail

  if (S.cameraAlt > 1500000) {
    // Global view — use pre-aggregated multi-region data
    try {
      const r = await fetch('/api/flights/global');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const states = (data.states || []).filter(s => s[5] != null && s[6] != null);
      renderFlights(states, false);
      document.getElementById('cnt-air').textContent = states.length;
      if (data._src) log(`Flights (global): ${states.length} from ${data._src}`);
      return;
    } catch(e) { log(`GlobalFlights: ${e.message}`, 'warn'); }
  }

  // Compute viewport width in NM and choose dist accordingly
  const viewWidthNm = S.cameraAlt * 1.15 / 1852;
  let distNm;
  if (viewWidthNm < 100) {
    // High LOD — tight local area, full aircraft density
    distNm = Math.max(Math.round(viewWidthNm / 2), 25);
  } else if (viewWidthNm < 500) {
    // Medium LOD — regional view
    distNm = Math.min(Math.round(viewWidthNm / 2), 200);
  } else {
    // Wide regional — cap at 250nm (ADSBExchange max)
    distNm = 250;
  }

  try {
    const r = await fetch(`/api/flights/opensky?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&dist=${distNm}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    renderFlights(data.states || [], false);
    document.getElementById('cnt-air').textContent = (data.states || []).length;
    if (data._src) log(`Flights: ${(data.states||[]).length} ac (${data._src}, ${distNm}nm radius)`);
  } catch(e) { log(`Flights: ${e.message}`, 'warn'); }
}

async function fetchMilitary() {
  if (!S.layers.military) return;
  try {
    const r = await fetch('/api/flights/military');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    renderFlights(data.states || [], true);
    document.getElementById('cnt-mil').textContent = (data.states || []).length;
  } catch(e) { log(`Military: ${e.message}`, 'warn'); }
}

function renderFlights(states, isMilitary) {
  const dsKey = isMilitary ? 'militaryDs' : 'flightDs';
  if (S[dsKey]) S.viewer.dataSources.remove(S[dsKey], true);
  if (!S.layers[isMilitary ? 'military' : 'flights']) return;

  const ds = new Cesium.CustomDataSource(isMilitary ? 'military' : 'flights');
  const bbox = getViewportBbox();

  for (const s of states) {
    const icao = s[0], callsign = (s[1]||'').trim(), lon = s[5], lat = s[6];
    const altM = s[7] ?? s[13] ?? 0;
    const speed = s[9] ?? 0;
    const track = s[10] ?? 0;
    const onGround = s[8];

    if (lon == null || lat == null || isNaN(lon) || isNaN(lat)) continue;
    // Viewport cull for civil flights only (military data is always global)
    if (!isMilitary && bbox && S.cameraAlt < 3000000 &&
        (lat < bbox.minLat || lat > bbox.maxLat || lon < bbox.minLon || lon > bbox.maxLon)) {
      continue;
    }

    const color = isMilitary ? '#ff3333' : altColor(altM);
    const altFt = Math.round((altM || 0) * 3.28084);
    const spdKt = Math.round((speed || 0) * 1.944);

    const cesColor = Cesium.Color.fromCssColorString(color);
    const displayAlt = Math.max(altM || 0, 10); // keep at least 10m so entity shows above terrain
    ds.entities.add({
      id: `${isMilitary?'mil':'ac'}_${icao}`,
      name: callsign || icao || 'Unknown',
      position: Cesium.Cartesian3.fromDegrees(lon, lat, displayAlt),
      // Use point + label — more reliable than SVG billboard in Cesium 1.107+
      point: {
        pixelSize: isMilitary ? 7 : 5,
        color: cesColor.withAlpha(0.95),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: isMilitary ? 2 : 1,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.8, 8e6, 0.5),
        heightReference: (altM || 0) < 50 ? Cesium.HeightReference.CLAMP_TO_GROUND : Cesium.HeightReference.NONE,
      },
      label: {
        text: `${callsign||icao}\n${altFt ? altFt.toLocaleString()+'ft' : 'GND'} ${spdKt}kt`,
        font: '10px JetBrains Mono, monospace',
        fillColor: cesColor.withAlpha(0.95),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        translucencyByDistance: new Cesium.NearFarScalar(5e5, 1, 3e6, 0),
        backgroundColor: new Cesium.Color(0,0,0,0.45),
        showBackground: true,
      },
      properties: {
        type: isMilitary ? 'military' : 'flight',
        icao, callsign, lat, lon, altM, altFt, speed, spdKt, track,
        onGround, country: s[2],
      },
    });
  }

  S.viewer.dataSources.add(ds);
  S[dsKey] = ds;
}

// ─── SHIPS ────────────────────────────────────────────────────────────────────
const SHIP_COLORS = {
  0: '#999999',   // unknown
  1: '#aaaaaa',   // reserved
  2: '#ff4444',   // WIG craft
  3: '#ff6600',   // vessel
  6: '#2299ff',   // passenger
  7: '#22cc88',   // cargo
  8: '#ff9900',   // tanker
  9: '#cc44ff',   // other
};

function shipColor(type) {
  const t = Math.floor((type||0)/10);
  return SHIP_COLORS[t] || '#4488cc';
}

function shipIcon(color, heading, type) {
  const h = heading >= 0 && heading <= 360 ? heading : 0;
  const isTanker = (type >= 80 && type <= 89);
  const isPassenger = (type >= 60 && type <= 69);
  const w = isTanker ? 18 : isPassenger ? 16 : 14;
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}" viewBox="0 0 16 16"><g transform="rotate(${h},8,8)"><path d="M8 1 L11 12 L8 10 L5 12 Z" fill="${color}" stroke="#000" stroke-width="0.5"/></g></svg>`)}`;
}

// ─── AISSTREAM.IO CLIENT-SIDE WEBSOCKET ───────────────────────────────────────
// Connects the browser directly to AISStream, bypassing the Cloudflare tunnel
// IP issue that blocks server-side requests. Position data stored in S.aisCache.
// Key injected server-side via /api/config.js → window.AISSTREAM_KEY.
S.aisCache      = new Map(); // mmsi → ship object
S.aisWs         = null;
S.aisConnected  = false;
S.aisReconnTimer = null;

function initAISStream() {
  const key = (typeof window !== 'undefined' && window.AISSTREAM_KEY) ? window.AISSTREAM_KEY : '';
  if (!key) return; // no key — will use server REST fallback

  clearTimeout(S.aisReconnTimer);
  if (S.aisWs && S.aisWs.readyState <= 1) return; // already connecting or connected

  try {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    S.aisWs = ws;

    ws.onopen = () => {
      S.aisConnected = true;
      // Subscribe to all position reports — filter by viewport on render
      ws.send(JSON.stringify({
        APIKey: key,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport'],
      }));
      log('AISStream connected (live ship feed)', 'ok');
    };

    ws.onmessage = (evt) => {
      try {
        const msg  = JSON.parse(evt.data);
        const meta = msg.MetaData || {};
        const pos  = msg.Message?.PositionReport || msg.Message?.StandardClassBPositionReport;
        if (!pos) return;
        const mmsi = String(meta.MMSI || pos.UserID || '');
        if (!mmsi) return;
        const lat = parseFloat(meta.latitude  ?? pos.Latitude  ?? NaN);
        const lon = parseFloat(meta.longitude ?? pos.Longitude ?? NaN);
        if (!isFinite(lat) || !isFinite(lon)) return;
        S.aisCache.set(mmsi, {
          mmsi, lat, lon,
          name:    (meta.ShipName || '').trim(),
          speed:   pos.Sog || 0,
          course:  pos.Cog || 0,
          heading: pos.TrueHeading || 511,
          status:  pos.NavigationalStatus || 0,
          type:    meta.ShipType || 0,
          ts:      Date.now(),
        });
      } catch {}
    };

    ws.onclose = () => {
      S.aisConnected = false;
      S.aisWs = null;
      // Reconnect after 30s
      S.aisReconnTimer = setTimeout(initAISStream, 30000);
    };

    ws.onerror = () => { ws.close(); };
  } catch(e) {
    console.warn('[AISStream]', e.message);
    S.aisReconnTimer = setTimeout(initAISStream, 60000);
  }
}

// Prune stale AIS entries (>15 min old)
setInterval(() => {
  const cut = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of S.aisCache) if (v.ts < cut) S.aisCache.delete(k);
}, 30000);

async function fetchShips() {
  if (!S.layers.ships) return;

  // ── Priority 1: live AISStream WebSocket cache (browser-direct connection)
  if (S.aisConnected && S.aisCache.size > 0) {
    const bbox = getViewportBbox();
    let ships = [...S.aisCache.values()];
    if (bbox && S.cameraAlt < 5000000) {
      const pad = 2;
      ships = ships.filter(s =>
        s.lat >= bbox.minLat - pad && s.lat <= bbox.maxLat + pad &&
        s.lon >= bbox.minLon - pad && s.lon <= bbox.maxLon + pad
      );
    }
    renderShips(ships);
    document.getElementById('cnt-ais').textContent = ships.length;
    return;
  }

  // ── Priority 2: server REST endpoint (falls back through Digitraffic etc.)
  const bbox = getViewportBbox();
  let url = '/api/ships';
  if (bbox && S.cameraAlt < 5000000) {
    const pad = 5;
    url += `?minLat=${(bbox.minLat-pad).toFixed(2)}&maxLat=${(bbox.maxLat+pad).toFixed(2)}&minLon=${(bbox.minLon-pad).toFixed(2)}&maxLon=${(bbox.maxLon+pad).toFixed(2)}`;
  }
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    renderShips(data.ships || []);
    document.getElementById('cnt-ais').textContent = (data.ships||[]).length;
    if (data._src) log(`Ships: ${data._count} from ${data._src}`);
  } catch(e) { log(`Ships: ${e.message}`, 'warn'); }
}

function renderShips(ships) {
  if (S.shipDs) S.viewer.dataSources.remove(S.shipDs, true);
  if (!S.layers.ships) return;

  const ds = new Cesium.CustomDataSource('ships');

  for (const s of ships) {
    // Guard: lat/lon must be present and finite — != null catches both null and undefined
    // Do NOT use !s.lat || !s.lon as that incorrectly rejects ships at lat=0 or lon=0
    if (s.lat == null || s.lon == null || isNaN(s.lat) || isNaN(s.lon)) continue;
    if (Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180) continue;

    const color = shipColor(s.type || 0);
    const cesColor = Cesium.Color.fromCssColorString(color);
    const name  = s.name || s.mmsi || 'UNKNOWN';
    const isTanker    = s.type >= 80 && s.type <= 89;
    const isPassenger = s.type >= 60 && s.type <= 69;
    const isCargo     = s.type >= 70 && s.type <= 79;
    const dotSize = isTanker ? 8 : isPassenger ? 7 : isCargo ? 6 : 5;

    ds.entities.add({
      id: `ship_${s.mmsi || Math.random()}`,
      name,
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 5),
      point: {
        pixelSize: dotSize,
        color: cesColor.withAlpha(0.92),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1.5,
        scaleByDistance: new Cesium.NearFarScalar(1e4, 2, 3e6, 0.5),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      label: {
        text: name.length > 10 ? name.substring(0, 10) + '…' : name,
        font: '10px JetBrains Mono, monospace',
        fillColor: cesColor.withAlpha(0.95),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -14),
        translucencyByDistance: new Cesium.NearFarScalar(5e4, 1, 8e5, 0),
        backgroundColor: new Cesium.Color(0,0,0,0.4),
        showBackground: true,
      },
      properties: { type: 'ship', ...s },
    });
  }

  S.viewer.dataSources.add(ds);
  S.shipDs = ds;
  log(`Ships: ${ds.entities.values.length} rendered`);
}

// ─── EARTHQUAKES ──────────────────────────────────────────────────────────────
async function fetchQuakes() {
  if (!S.layers.quakes) return;
  try {
    const r = await fetch('/api/quakes');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    renderQuakes(data.features || []);
    document.getElementById('cnt-quake').textContent = (data.features||[]).length;
    log(`Seismic: ${(data.features||[]).length} events`);
  } catch(e) { log(`Quakes: ${e.message}`, 'warn'); }
}

function renderQuakes(features) {
  if (S.quakeDs) S.viewer.dataSources.remove(S.quakeDs, true);
  if (!S.layers.quakes) return;

  const ds = new Cesium.CustomDataSource('quakes');
  for (const f of features) {
    const [lon, lat] = f.geometry.coordinates;
    const mag = f.properties.mag || 0;
    const depth = f.geometry.coordinates[2] || 0;
    const r = Math.max(2, Math.min(16, mag * 3));
    const alpha = Math.min(1, 0.4 + mag * 0.12);
    const color = mag >= 6 ? '#ff2222' : mag >= 5 ? '#ff7700' : mag >= 4 ? '#ffaa00' : '#ffdd44';

    ds.entities.add({
      id: `quake_${f.id}`,
      name: f.properties.place || `M${mag}`,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
      point: {
        pixelSize: r,
        color: Cesium.Color.fromCssColorString(color).withAlpha(alpha),
        outlineColor: Cesium.Color.fromCssColorString(color).withAlpha(0.3),
        outlineWidth: 4,
      },
      properties: { type: 'quake', mag, depth, place: f.properties.place, time: f.properties.time, lat, lon },
    });
  }

  S.viewer.dataSources.add(ds);
  S.quakeDs = ds;
}

// ─── CCTV ─────────────────────────────────────────────────────────────────────
async function fetchCCTV() {
  if (!S.layers.cctv) return;
  const { lat, lon } = getCameraInfo();
  if (S.cameraAlt > 500000) { log('CCTV: zoom in for camera data', 'warn'); return; }
  try {
    const r = await fetch(`/api/cctv?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radius=4000`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const cams = await r.json();
    renderCCTV(cams);
    document.getElementById('cnt-cctv').textContent = cams.length;
  } catch(e) { log(`CCTV: ${e.message}`, 'warn'); }
}

function renderCCTV(cams) {
  if (S.cctvDs) S.viewer.dataSources.remove(S.cctvDs, true);
  if (!S.layers.cctv) return;
  const ds = new Cesium.CustomDataSource('cctv');
  for (const c of cams) {
    ds.entities.add({
      id: `cctv_${c.id}`,
      name: c.operator || 'CCTV Camera',
      position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 5),
      point: {
        pixelSize: 5,
        color: Cesium.Color.fromCssColorString('#ff3300').withAlpha(0.9),
        outlineColor: Cesium.Color.RED.withAlpha(0.3), outlineWidth: 4,
      },
      properties: { type: 'cctv', ...c },
    });
  }
  S.viewer.dataSources.add(ds);
  S.cctvDs = ds;
}

// ─── WILDFIRES ────────────────────────────────────────────────────────────────
async function fetchFires() {
  if (!S.layers.wildfires) return;
  const bbox = getViewportBbox();
  let url = '/api/wildfires';
  if (bbox) url += `?minLat=${bbox.minLat.toFixed(2)}&maxLat=${bbox.maxLat.toFixed(2)}&minLon=${bbox.minLon.toFixed(2)}&maxLon=${bbox.maxLon.toFixed(2)}`;
  try {
    const r = await fetch(url);
    const fires = await r.json();
    renderFires(fires);
    document.getElementById('cnt-fire').textContent = fires.length;
  } catch(e) { log(`Fires: ${e.message}`, 'warn'); }
}

function renderFires(fires) {
  if (S.fireDs) S.viewer.dataSources.remove(S.fireDs, true);
  if (!S.layers.wildfires) return;
  const ds = new Cesium.CustomDataSource('fires');
  for (const f of fires) {
    const intensity = Math.min(1, (f.frp || 0) / 500);
    ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 0),
      point: {
        pixelSize: Math.max(3, 4 + intensity * 6),
        color: Cesium.Color.fromHsl(0.05 - intensity * 0.05, 1, 0.5, 0.8),
        outlineColor: Cesium.Color.ORANGE.withAlpha(0.3), outlineWidth: 3,
      },
      properties: { type: 'fire', ...f },
    });
  }
  S.viewer.dataSources.add(ds);
  S.fireDs = ds;
}

// ─── GPS JAMMING ──────────────────────────────────────────────────────────────
// Fetch directly from the browser (residential IP) to avoid WAF blocking that
// hits server-side proxies going through Cloudflare tunnel / datacenter IPs.
// gpsjam.org serves CSV files with CORS headers (their own Cesium app uses them).
async function fetchJamming() {
  if (!S.layers.jamming) return;

  // Try today, yesterday, 2 days ago — gpsjam.org publishes with a lag
  const dates = [0, 1, 2].map(n => {
    const d = new Date(Date.now() - n * 86400000);
    return d.toISOString().substring(0, 10);
  });

  // --- Attempt 1: direct browser fetch (bypasses server-side WAF) ---
  for (const date of dates) {
    try {
      const r = await fetch(`https://gpsjam.org/data/jamming-${date}.csv`, { mode: 'cors' });
      if (!r.ok) continue;
      const text = await r.text();
      if (!text || text.length < 50) continue;
      const hexes = text.trim().split('\n')
        .filter(l => l && !l.startsWith('#') && l.includes(','))
        .map(l => { const p = l.split(','); return { h: p[0]?.trim(), p: Math.round(parseFloat(p[1])) }; })
        .filter(h => h.h && !isNaN(h.p) && h.p >= 2);
      if (hexes.length > 0) {
        renderJamming(hexes, date);
        log(`GPS Jam: ${hexes.length} cells (direct) for ${date}`);
        return;
      }
    } catch(_) { /* CORS blocked or network error — fall through to server proxy */ break; }
  }

  // --- Attempt 2: server proxy (works when direct fetch is CORS-blocked) ---
  try {
    const r = await fetch('/api/jamming');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if ((data.hexes || []).length > 0) {
      renderJamming(data.hexes, data.date);
      log(`GPS Jam: ${data.count} cells (proxy) for ${data.date}`);
    } else {
      log(`GPS Jam: no data — ${data.error || 'empty response'}. gpsjam.org may be blocking server IP.`, 'warn');
    }
  } catch(e) { log(`Jamming fetch failed: ${e.message}`, 'warn'); }
}

function renderJamming(hexes, date) {
  if (S.jammingDs) S.viewer.dataSources.remove(S.jammingDs, true);
  if (!S.layers.jamming) return;

  const ds = new Cesium.CustomDataSource('jamming');
  const h3lib = window.h3; // loaded from h3-js CDN

  if (!h3lib) {
    log('H3 library not loaded — jamming layer unavailable', 'warn');
    S.viewer.dataSources.add(ds); S.jammingDs = ds; return;
  }

  // Cap for performance — sort by probability desc, take top 600
  const cappedHexes = hexes.length > 600
    ? [...hexes].sort((a, b) => b.p - a.p).slice(0, 600)
    : hexes;

  let rendered = 0;
  for (const h of cappedHexes) {
    try {
      // h3-js v4: cellToBoundary returns [[lat, lng], [lat, lng], ...]
      const boundary = h3lib.cellToBoundary(h.h);
      if (!boundary || boundary.length < 3) continue;
      // Validate all coords are finite — NaN causes wgs84To2DModelMatrix crash
      if (boundary.some(([lat, lng]) => !isFinite(lat) || !isFinite(lng))) continue;

      const pct  = Math.min(100, Math.max(0, h.p));
      const alpha = 0.15 + (pct / 100) * 0.65;
      const color = pct > 70 ? '#ff2222' : pct > 40 ? '#ff6600' : '#ffcc00';
      const cesColor = Cesium.Color.fromCssColorString(color);

      // Build degreesArray [lng, lat, lng, lat, ...] for PolygonHierarchy
      const degArr = boundary.flatMap(([lat, lng]) => [lng, lat]);

      ds.entities.add({
        id: `jam_${h.h}`,
        name: `GPS Jamming ${pct}%`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(degArr)
          ),
          material:           cesColor.withAlpha(alpha * 0.6),
          // NOTE: outline:true is INCOMPATIBLE with classificationType:TERRAIN — omit outline entirely.
          // classificationType drapes the polygon over terrain correctly (no height needed).
          classificationType: Cesium.ClassificationType.TERRAIN,
        },
        properties: { type: 'jamming', probability: pct, hexId: h.h },
      });
      rendered++;
    } catch {}
  }

  S.viewer.dataSources.add(ds);
  S.jammingDs = ds;
  log(`GPS Jamming: ${rendered} rendered (top ${cappedHexes.length} of ${hexes.length} total) — ${date}`);
}

// ─── MESHTASTIC ───────────────────────────────────────────────────────────────
async function fetchMesh() {
  if (!S.layers.mesh) return;
  try {
    const r = await fetch('/api/meshtastic/nodes');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    renderMesh(data.nodes || []);
    document.getElementById('cnt-mesh').textContent = (data.nodes||[]).length;
  } catch(e) { log(`Mesh: ${e.message}`, 'warn'); }
}

function renderMesh(nodes) {
  if (S.meshDs) S.viewer.dataSources.remove(S.meshDs, true);
  if (!S.layers.mesh) return;
  const ds = new Cesium.CustomDataSource('mesh');
  for (const n of nodes) {
    ds.entities.add({
      id: `mesh_${n.id}`,
      name: n.name || n.id,
      position: Cesium.Cartesian3.fromDegrees(n.lon, n.lat, 0),
      point: {
        pixelSize: 6,
        color: Cesium.Color.fromCssColorString('#a855f7').withAlpha(0.9),
        outlineColor: Cesium.Color.fromCssColorString('#a855f7').withAlpha(0.3), outlineWidth: 4,
      },
      properties: { type: 'mesh', ...n },
    });
  }
  S.viewer.dataSources.add(ds);
  S.meshDs = ds;
}

// ─── INTEL FEED (GDELT) ───────────────────────────────────────────────────────
let intelLoading = false;

async function fetchIntel(query, timespan) {
  if (intelLoading) return;
  intelLoading = true;

  const q   = query   || S.intelQuery || '';
  const ts  = timespan || document.getElementById('intel-span').value || '24h';

  const list = document.getElementById('intel-items');
  list.innerHTML = `<div class="intel-loading"><div class="loading-spinner"></div><span>QUERYING GDELT GLOBAL MEDIA…</span></div>`;

  try {
    const params = new URLSearchParams({ timespan: ts, limit: 75 });
    if (q) params.set('q', q);
    const r = await fetch(`/api/intel/feed?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    S.intelArticles = data.articles || [];
    S.intelQuery    = q;

    renderIntel(S.intelArticles);
    document.getElementById('intel-count').textContent = `${S.intelArticles.length} ARTICLES`;
    document.getElementById('intel-last-update').textContent = new Date().toISOString().substring(11,16) + 'Z';

    // Also fetch geographic events for map pins
    if (S.layers.intel) fetchIntelEvents(q, ts);

    log(`Intel: ${data.count} articles (${data.query})`);
  } catch(e) {
    list.innerHTML = `<div class="intel-empty">⚠ ${e.message}<br><small>GDELT may be temporarily unavailable</small></div>`;
    log(`Intel feed: ${e.message}`, 'error');
  } finally { intelLoading = false; }
}

function renderIntel(articles) {
  const filter = S.intelFilter;
  const list   = document.getElementById('intel-items');

  const visible = filter
    ? articles.filter(a => a.title?.toLowerCase().includes(filter.toLowerCase()) ||
                           a.source?.toLowerCase().includes(filter.toLowerCase()))
    : articles;

  if (!visible.length) {
    list.innerHTML = `<div class="intel-empty">No articles found<br><small>Try a different search or timespan</small></div>`;
    return;
  }

  list.innerHTML = '';
  for (const art of visible) {
    const corrClass = art.corroboration >= 3 ? 'corroborated-high' : art.corroboration >= 2 ? 'corroborated-med' : '';
    const toneClass = (art.tone != null && art.tone < -5) ? 'tone-negative' : '';

    const dateStr = art.date ? art.date.substring(0,8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '';
    const lang = art.language && art.language !== 'English' ? `<span class="intel-lang">${art.language}</span>` : '';
    const country = art.country ? `<span class="intel-country">${art.country}</span>` : '';

    // Tone bar: map tone (-100 to +100) to a colour bar
    const toneVal = art.tone ?? 0;
    const toneWidth = Math.abs(toneVal);
    const toneColor = toneVal < 0 ? '#ef4444' : '#22c55e';

    const div = document.createElement('div');
    div.className = `intel-item ${corrClass} ${toneClass}`.trim();
    div.innerHTML = `
      ${art.corroboration > 1 ? `<span class="intel-corr">×${art.corroboration}</span>` : ''}
      <div class="intel-title">${escHtml(art.title)}</div>
      <div class="intel-meta">
        <span class="intel-source">${escHtml(art.source || '')}</span>
        ${lang}${country}
        <span class="intel-date">${dateStr}</span>
      </div>
      <div class="intel-tone-bar"><div class="intel-tone-fill" style="width:${toneWidth}%;background:${toneColor}"></div></div>`;
    div.addEventListener('click', () => window.open(art.url, '_blank'));
    list.appendChild(div);
  }
}

async function fetchIntelEvents(query, timespan) {
  try {
    const q = query || 'conflict attack protest';
    const r = await fetch(`/api/intel/events?q=${encodeURIComponent(q)}&timespan=${timespan||'24h'}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    renderIntelEvents(data.features || []);
  } catch {}
}

function renderIntelEvents(features) {
  if (S.intelDs) S.viewer.dataSources.remove(S.intelDs, true);
  const ds = new Cesium.CustomDataSource('intel_events');

  for (const f of features) {
    const intensity = Math.min(1, (f.count || 1) / 20);
    const size = Math.max(4, Math.min(14, 4 + intensity * 10));
    const alpha = 0.5 + intensity * 0.4;

    ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 0),
      point: {
        pixelSize: size,
        color: Cesium.Color.fromCssColorString('#06b6d4').withAlpha(alpha),
        outlineColor: Cesium.Color.fromCssColorString('#06b6d4').withAlpha(0.2),
        outlineWidth: 6,
      },
      properties: { type: 'intel_event', ...f },
    });
  }

  S.viewer.dataSources.add(ds);
  S.intelDs = ds;
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Intel search interaction
document.getElementById('intel-go').addEventListener('click', () => {
  fetchIntel(document.getElementById('intel-q').value, document.getElementById('intel-span').value);
});
document.getElementById('intel-q').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('intel-go').click();
});
document.getElementById('intel-refresh').addEventListener('click', () => fetchIntel());
document.getElementById('intel-close').addEventListener('click', () => {
  document.getElementById('intel-panel').style.display = 'none';
  document.getElementById('cesiumContainer').style.right = '0';
  document.querySelector('[data-layer="intel"]')?.classList.remove('on');
  S.layers.intel = false;
});

// Filter tag buttons
document.querySelectorAll('.ftag').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ftag').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const q = btn.dataset.q;
    if (q) {
      document.getElementById('intel-q').value = q;
      fetchIntel(q, document.getElementById('intel-span').value);
    } else {
      document.getElementById('intel-q').value = '';
      fetchIntel('', document.getElementById('intel-span').value);
    }
  });
});

// ─── AI QUERY ─────────────────────────────────────────────────────────────────
document.getElementById('ai-send').addEventListener('click', sendAIQuery);
document.getElementById('ai-in').addEventListener('keydown', e => { if (e.key === 'Enter') sendAIQuery(); });
document.getElementById('ai-dismiss').addEventListener('click', () => {
  document.getElementById('ai-response').classList.add('hidden');
});

async function sendAIQuery() {
  const query = document.getElementById('ai-in').value.trim();
  if (!query) return;

  const { lat, lon, altKm } = getCameraInfo();
  const respDiv = document.getElementById('ai-response');
  const textDiv = document.getElementById('ai-text');

  respDiv.classList.remove('hidden');
  textDiv.textContent = 'Querying ARGUS intelligence…';

  const context = {
    view: { lat: lat.toFixed(2), lon: lon.toFixed(2), altKm: altKm.toFixed(0) },
    layers: S.layers,
    counts: {
      satellites: S.tleData.length,
      flights: document.getElementById('cnt-air').textContent,
      ships: document.getElementById('cnt-ais').textContent,
    },
    intelArticles: S.intelArticles.slice(0, 5).map(a => ({ title: a.title, source: a.source, country: a.country })),
  };

  try {
    const r = await fetch('/api/ai/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, context }),
    });
    const data = await r.json();
    textDiv.textContent = data.response || data.error || 'No response';
  } catch(e) {
    textDiv.textContent = 'AI query failed: ' + e.message;
  }
}

// ─── ENTITY CLICK / INFO PANEL ────────────────────────────────────────────────
const handler = new Cesium.ScreenSpaceEventHandler(S.viewer.canvas);
handler.setInputAction(click => {
  const picked = S.viewer.scene.pick(click.position);
  if (!Cesium.defined(picked) || !picked.id) {
    document.getElementById('info-box').classList.add('hidden');
    return;
  }
  const entity = picked.id;
  showInfoPanel(entity);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// Double-click to track/untrack
handler.setInputAction(click => {
  const picked = S.viewer.scene.pick(click.position);
  if (Cesium.defined(picked) && picked.id) {
    if (S.viewer.trackedEntity === picked.id) {
      S.viewer.trackedEntity = undefined;
      document.getElementById('info-track').textContent = '📍 TRACK';
      toast('Tracking stopped', 'info', 2000);
    } else {
      S.viewer.trackedEntity = picked.id;
      document.getElementById('info-track').textContent = '⏹ UNTRACK';
      toast(`Tracking: ${picked.id.name}`, 'info', 2000);
    }
  } else {
    S.viewer.trackedEntity = undefined;
    document.getElementById('info-track').textContent = '📍 TRACK';
  }
}, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

// ESC to untrack
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    S.viewer.trackedEntity = undefined;
    document.getElementById('info-track').textContent = '📍 TRACK';
    document.getElementById('info-box').classList.add('hidden');
    document.getElementById('ai-response').classList.add('hidden');
  }
});

function showInfoPanel(entity) {
  const props = entity.properties;
  if (!props) return;
  const type  = props.type?.getValue?.() || props.type || 'unknown';
  const name  = entity.name || entity.id;
  const box   = document.getElementById('info-box');

  S.selectedEntity = entity;

  const icons = { flight:'✈', military:'★', satellite:'◎', ship:'⚓', quake:'⚡', cctv:'📷', fire:'🔥', mesh:'📡', intel_event:'◈', shodan:'🔍' };
  document.getElementById('info-icon').textContent  = icons[type] || '●';
  document.getElementById('info-name').textContent  = name.substring(0, 28).toUpperCase();

  const body  = document.getElementById('info-body');
  const rows  = [];
  const R = (k, v) => { if (v != null && v !== '' && v !== undefined) rows.push(`<div class="info-row"><span class="info-key">${k}</span><span class="info-val">${escHtml(String(v))}</span></div>`); };

  if (type === 'flight' || type === 'military') {
    R('ICAO',    props.icao?.getValue?.() || props.icao);
    R('CALLSIGN',props.callsign?.getValue?.() || props.callsign);
    R('ALT',     `${((props.altFt?.getValue?.() || props.altFt || 0)).toLocaleString()} ft`);
    R('SPEED',   `${props.spdKt?.getValue?.() || props.spdKt || 0} kt`);
    R('TRACK',   `${Math.round(props.track?.getValue?.() || props.track || 0)}°`);
    R('COUNTRY', props.country?.getValue?.() || props.country);
    R('STATUS',  (props.onGround?.getValue?.() || props.onGround) ? 'ON GROUND' : 'AIRBORNE');
  } else if (type === 'ship') {
    R('MMSI',    props.mmsi?.getValue?.() || props.mmsi);
    R('SPEED',   `${props.speed?.getValue?.() || props.speed || 0} kt`);
    R('COURSE',  `${props.course?.getValue?.() || props.course || 0}°`);
    R('TYPE',    props.type_desc?.getValue?.() || props.type_desc || '');
  } else if (type === 'satellite') {
    R('ALT',     `${Math.round(props.alt?.getValue?.() || props.alt || 0)} km`);
    R('LAT',     `${(props.lat?.getValue?.() || props.lat || 0).toFixed(2)}°`);
    R('LON',     `${(props.lon?.getValue?.() || props.lon || 0).toFixed(2)}°`);
  } else if (type === 'quake') {
    R('MAG',     `M${props.mag?.getValue?.() || props.mag}`);
    R('DEPTH',   `${props.depth?.getValue?.() || props.depth || 0} km`);
    R('PLACE',   props.place?.getValue?.() || props.place);
    const time = props.time?.getValue?.() || props.time;
    if (time) R('TIME', new Date(time).toUTCString().substring(0,25));
  } else if (type === 'fire') {
    const frp = props.frp?.getValue?.() ?? props.frp;
    const brightness = props.brightness?.getValue?.() ?? props.brightness;
    const lat = props.lat?.getValue?.() ?? props.lat;
    const lon = props.lon?.getValue?.() ?? props.lon;
    if (frp)        R('POWER',     `${Math.round(frp)} MW (FRP)`);
    if (brightness) R('BRIGHTNESS',`${Math.round(brightness)} K`);
    if (lat != null) R('LAT',      `${Number(lat).toFixed(4)}°`);
    if (lon != null) R('LON',      `${Number(lon).toFixed(4)}°`);
    rows.push(`<div class="info-row dim tiny" style="flex-direction:column;align-items:flex-start;margin-top:4px"><span>Analysing cause via GDELT…</span></div>`);
  }

  rows.push(`<div id="enrich-data" class="enrich-section"><div class="enrich-loading"><span class="loading-spinner" style="width:12px;height:12px;border-width:1.5px"></span><span class="dim tiny" style="margin-left:6px">QUERYING DATABASES…</span></div></div>`);
  body.innerHTML = rows.join('');
  box.classList.remove('hidden');

  // Show trail button for flights and ships, auto-render trail
  const trailBtn = document.getElementById('info-show-trail');
  if (type === 'flight' || type === 'military' || type === 'ship') {
    trailBtn.style.display = '';
    showEntityTrack(entity);  // auto-draw trail
  } else {
    trailBtn.style.display = 'none';
    clearEntityTrack();
  }

  // Auto-enrich in background
  autoEnrich(entity, type, props);
}

async function autoEnrich(entity, type, props) {
  const enrichDiv = document.getElementById('enrich-data');
  if (!enrichDiv) return;

  let url = null;
  let callsignUrl = null;
  const icao     = props.icao?.getValue?.()     || props.icao;
  const callsign = props.callsign?.getValue?.() || props.callsign;
  const mmsi     = props.mmsi?.getValue?.()     || props.mmsi;
  const satName  = entity.name;

  if ((type === 'flight' || type === 'military') && icao) {
    url = `/api/enrich/aircraft/${icao}`;
    if (callsign) callsignUrl = `/api/enrich/callsign/${callsign}`;
  } else if (type === 'ship' && mmsi) {
    url = `/api/enrich/ship/${mmsi}`;
  } else if (type === 'satellite') {
    // Extract NORAD ID from TLE line 1 (cols 3-7)
    const tleEntry = S.tleData.find(t => t.name === satName);
    if (tleEntry) {
      const noradId = tleEntry.tle1.substring(2,7).trim();
      if (noradId) url = `/api/enrich/satellite/${noradId}`;
    }
  }

  // Fire: fetch GDELT cause-analysis context
  if (type === 'fire') {
    const lat = props.lat?.getValue?.() ?? props.lat;
    const lon = props.lon?.getValue?.() ?? props.lon;
    const frp = props.frp?.getValue?.() ?? props.frp ?? 0;
    if (lat != null && lon != null) {
      try {
        const r = await fetch(`/api/fire/context?lat=${lat}&lon=${lon}&frp=${frp}`);
        const ctx = await r.json();
        const rows = [];
        rows.push(`<div class="info-row"><span class="info-key">INTENSITY</span><span class="info-val">${escHtml(ctx.frpClass||'')}</span></div>`);
        rows.push(`<div class="info-row"><span class="info-key">LIKELY CAUSE</span><span class="info-val" style="color:#f59e0b;font-weight:600">${escHtml(ctx.cause||'Unknown')}</span></div>`);
        if (ctx.articles && ctx.articles.length) {
          rows.push(`<div class="enrich-section-hdr" style="margin-top:8px;font-size:9px;letter-spacing:.1em;color:#888">RELATED NEWS</div>`);
          for (const a of ctx.articles.slice(0, 4)) {
            const causeTag = a.cause && a.cause !== 'Unknown / Under Investigation'
              ? `<span class="osint-event-type et-conflict" style="font-size:8px">${escHtml(a.cause)}</span>` : '';
            rows.push(`<div class="info-row" style="flex-direction:column;align-items:flex-start;gap:2px">
              ${causeTag}
              <a href="${escHtml(a.url||'#')}" target="_blank" class="enrich-link" style="font-size:10px;white-space:normal;text-align:left">${escHtml((a.title||'').substring(0,90))}</a>
              <span class="dim tiny">${escHtml(a.source||'')} — ${escHtml(a.date||'').substring(0,10)}</span>
            </div>`);
          }
        } else {
          rows.push(`<div class="dim tiny" style="padding:4px 0">No news articles found nearby</div>`);
        }
        enrichDiv.innerHTML = rows.join('');
      } catch(e) {
        enrichDiv.innerHTML = `<div class="dim tiny">Context unavailable: ${escHtml(e.message)}</div>`;
      }
    } else {
      enrichDiv.innerHTML = '';
    }
    return;
  }

  if (!url) { enrichDiv.innerHTML = ''; return; }

  try {
    const [r1, r2] = await Promise.all([
      fetch(url).then(r => r.json()),
      callsignUrl ? fetch(callsignUrl).then(r => r.json()) : Promise.resolve(null),
    ]);

    const rows = [];
    const R = (k, v) => { if (v != null && v !== '' && v !== undefined && v !== 'null') rows.push(`<div class="info-row"><span class="info-key">${k}</span><span class="info-val">${escHtml(String(v))}</span></div>`); };

    if (type === 'flight' || type === 'military') {
      if (r1.registration)  R('REG',           r1.registration);
      if (r1.type_full)     R('AIRCRAFT',       r1.type_full);
      else if (r1.type_code) R('TYPE',          r1.type_code);
      if (r1.manufacturer)  R('MANUFACTURER',   r1.manufacturer);
      if (r1.operator)      R('OPERATOR',       r1.operator);
      if (r1.operator_iata) R('IATA',           r1.operator_iata);
      if (r1.country)       R('REGISTERED',     r1.country);
      if (r1.built_year)    R('BUILT',          r1.built_year);
      if (r1.engines)       R('ENGINES',        r1.engines);
      if (r2?.origin)       R('FROM', `${r2.origin.iata||r2.origin.icao} ${r2.origin.name}, ${r2.origin.country}`);
      if (r2?.destination)  R('TO',   `${r2.destination.iata||r2.destination.icao} ${r2.destination.name}, ${r2.destination.country}`);
      if (r2?.operator)     R('AIRLINE',        r2.operator);
      if (r1.photo_url) {
        rows.push(`<div class="enrich-photo"><img src="${escHtml(r1.photo_url)}" alt="Aircraft photo" onerror="this.parentNode.remove()"></div>`);
      }
    } else if (type === 'ship') {
      R('COUNTRY', r1.country);
      R('CLASS',   r1.type);
      R('IMO',     r1.imo);
      R('FLAG',    r1.flag);
      R('BUILT',   r1.built);
      R('LENGTH',  r1.length ? `${r1.length}m` : null);
      R('BEAM',    r1.beam   ? `${r1.beam}m`   : null);
      R('DWT',     r1.dwt);
      R('GT',      r1.gt);
      R('DEST',    r1.destination);
      if (r1.name) R('VESSEL', r1.name);
      rows.push(`<div class="enrich-links"><a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${r1.mmsi}" target="_blank" class="enrich-link">MarineTraffic ↗</a><a href="https://www.vesselfinder.com/vessels/${r1.mmsi}" target="_blank" class="enrich-link">VesselFinder ↗</a></div>`);
    } else if (type === 'satellite') {
      R('NAME',        r1.name || satName);
      R('NORAD',       r1.norad_id);
      R('INT DESIG',   r1.int_designator);
      R('COUNTRY',     r1.country);
      R('TYPE',        r1.object_type);
      R('RCS SIZE',    r1.rcs_size);
      R('LAUNCHED',    r1.launch_date);
      R('REGIME',      r1.orbital_regime);
      R('ALTITUDE',    r1.mean_altitude_km ? `${r1.mean_altitude_km} km` : null);
      R('APOGEE',      r1.apoapsis_km ? `${r1.apoapsis_km} km` : null);
      R('PERIGEE',     r1.periapsis_km ? `${r1.periapsis_km} km` : null);
      R('PERIOD',      r1.period_min ? `${r1.period_min} min` : null);
      R('ORBITS/DAY',  r1.orbits_per_day);
      R('INCLINATION', r1.inclination ? `${r1.inclination}°` : null);
      R('VELOCITY',    r1.orbital_velocity_kms ? `${r1.orbital_velocity_kms} km/s` : null);
      R('CLASS',       r1.classification === 'U' ? 'Unclassified' : r1.classification);
      if (r1.decay_date) R('DECAYED', r1.decay_date);
      rows.push(`<div class="enrich-links"><a href="https://celestrak.org/SOCRATES/" target="_blank" class="enrich-link">SOCRATES Conjunctions ↗</a><a href="https://heavens-above.com/" target="_blank" class="enrich-link">Heavens-Above ↗</a></div>`);
    }

    if (rows.length === 0) {
      enrichDiv.innerHTML = '<div class="dim tiny" style="padding:4px">No additional data found</div>';
    } else {
      const srcBadge = r1.sources?.length ? `<div class="enrich-src">SRC: ${r1.sources.join(' · ').toUpperCase()}</div>` : '';
      enrichDiv.innerHTML = `<div class="enrich-hdr">◈ ENRICHED INTELLIGENCE</div>${rows.join('')}${srcBadge}`;
    }
  } catch(e) {
    enrichDiv.innerHTML = `<div class="dim tiny" style="padding:4px">Enrichment failed: ${e.message}</div>`;
  }
}

document.getElementById('info-close').addEventListener('click', () => {
  document.getElementById('info-box').classList.add('hidden');
  clearEntityTrack();
});

document.getElementById('info-show-trail').addEventListener('click', () => {
  if (S.selectedEntity) showEntityTrack(S.selectedEntity);
});

// ─── ENTITY TRAIL (track history polyline) ────────────────────────────────
function clearEntityTrack() {
  if (S.trackDs) { S.viewer.dataSources.remove(S.trackDs, true); S.trackDs = null; }
  const badge = document.getElementById('trail-info');
  if (badge) badge.remove();
}

function showEntityTrack(entity) {
  clearEntityTrack();
  if (!entity) return;

  const hist = polHistory.get(entity.id) || [];
  if (hist.length < 2) {
    // Not enough history yet — show current position with a pulsing ring
    const props = entity.properties;
    const lat = props.lat?.getValue?.() ?? props.lat;
    const lon = props.lon?.getValue?.() ?? props.lon;
    if (lat == null || lon == null) return;
    toast('Track building — check back in a minute', 'info', 3000);
    return;
  }

  const ds = new Cesium.CustomDataSource('track_trail');
  const type  = entity.properties.type?.getValue?.() || entity.properties.type || '';
  const color = type === 'ship' ? '#2299ff' : type === 'military' ? '#ff3333' : '#22cc88';
  const cesColor = Cesium.Color.fromCssColorString(color);

  // Full-history polyline (fades from dim to bright at newest end)
  const positions = hist.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, (p.alt || 0) * 0.3048));
  ds.entities.add({
    polyline: {
      positions,
      width:    2.5,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower:  0.15,
        color:      cesColor.withAlpha(0.85),
        taperPower: 0.7,
      }),
      clampToGround: (type === 'ship'),
      arcType:       Cesium.ArcType.GEODESIC,
    },
  });

  // Waypoint dots along track
  for (let i = 0; i < hist.length; i++) {
    const p    = hist[i];
    const frac = i / (hist.length - 1);
    const alpha = 0.3 + frac * 0.65;
    ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, (p.alt || 0) * 0.3048),
      point: {
        pixelSize:  frac > 0.85 ? 5 : 3,
        color:      cesColor.withAlpha(alpha),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
        outlineWidth: 1,
        disableDepthTestDistance: 1e6,
      },
      properties: { ts: p.ts },
    });
  }

  S.viewer.dataSources.add(ds);
  S.trackDs = ds;

  // Trail info badge
  let badge = document.getElementById('trail-info');
  if (!badge) { badge = document.createElement('div'); badge.id = 'trail-info'; document.body.appendChild(badge); }
  const spanMin = Math.round((hist[hist.length-1].ts - hist[0].ts) / 60000);
  badge.textContent = `〰 TRAIL · ${entity.name} · ${hist.length} pts · ${spanMin}m`;
  log(`Trail: ${entity.name} — ${hist.length} positions over ${spanMin} min`);
}
document.getElementById('info-track').addEventListener('click', () => {
  if (S.selectedEntity) {
    if (S.viewer.trackedEntity === S.selectedEntity) {
      // Already tracking — untrack
      S.viewer.trackedEntity = undefined;
      document.getElementById('info-track').textContent = '📍 TRACK';
      toast('Tracking stopped', 'info', 2000);
    } else {
      S.viewer.trackedEntity = S.selectedEntity;
      document.getElementById('info-track').textContent = '⏹ UNTRACK';
      toast(`Tracking: ${S.selectedEntity.name}`, 'info', 2000);
    }
  }
});
// ─── SHODAN (UI removed — key configured via server env SHODAN_API_KEY) ────────
// info-shodan button repurposed: trigger a Shodan search via server-side key
(function() {
  const btn = document.getElementById('info-shodan');
  if (!btn) return; // element removed from UI
  btn.addEventListener('click', async () => {
    if (!S.selectedEntity) return;
    const props = S.selectedEntity.properties;
    const country = props?.country?.getValue?.() || props?.country || '';
    if (!country) { toast('No country associated with this entity', 'warn'); return; }
    if (S.shodanDs) { S.viewer.dataSources.remove(S.shodanDs, true); S.shodanDs = null; }
    toast(`Querying Shodan: country:${country}…`, 'info', 3000);
    try {
      const r = await fetch(`/api/shodan/search?q=${encodeURIComponent('country:' + country)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const matches = data.matches || [];
      const ds = new Cesium.CustomDataSource('shodan');
      for (const m of matches) {
        if (!m.location?.latitude || !m.location?.longitude) continue;
        ds.entities.add({
          id: `shodan_${m.ip_str}`,
          name: m.ip_str,
          position: Cesium.Cartesian3.fromDegrees(m.location.longitude, m.location.latitude, 0),
          point: {
            pixelSize: 7,
            color: Cesium.Color.fromCssColorString('#ff3300').withAlpha(0.9),
            outlineColor: Cesium.Color.fromCssColorString('#ff3300').withAlpha(0.3),
            outlineWidth: 5,
          },
          properties: { type: 'shodan', ip: m.ip_str, port: m.port, org: m.org, country: m.location?.country_name },
        });
      }
      S.viewer.dataSources.add(ds);
      S.shodanDs = ds;
      toast(`Shodan: ${matches.length} results for ${country}`, 'ok', 4000);
      log(`Shodan: ${matches.length} matches for country:${country}`);
    } catch(e) { toast(`Shodan: ${e.message}`, 'error'); }
  });
})();

// ─── STATUS CHECK ─────────────────────────────────────────────────────────────
async function checkStatus() {
  try {
    const r = await fetch('/api/status');
    const data = await r.json();
    const aisPill = document.getElementById('pill-aisstream');

    if (aisPill) {
      const dot = aisPill.querySelector('.dot');
      if (data.ws_connected) { dot.className='dot green'; if(data.ship_count) aisPill.title=`AISStream: ${data.ship_count} ships`; }
      else if (data.aisstream) { dot.className='dot amber'; }
      else { dot.className='dot red'; }
    }
    // Shodan pill removed from UI (key configured server-side via env)
  } catch {}
}

// ─── DEBUG SOURCES ────────────────────────────────────────────────────────────
document.getElementById('btn-debug').addEventListener('click', async () => {
  const out = document.getElementById('debug-out');
  out.textContent = 'Checking…';
  try {
    const r = await fetch('/api/debug/sources');
    const data = await r.json();
    const lines = [];
    for (const [name, s] of Object.entries(data.sources || {})) {
      const ok = s.ok === true || s.ws_connected;
      const sym = ok ? '✓' : '✗';
      const cls = ok ? 'debug-ok' : 'debug-fail';
      const detail = s.count != null ? ` (${s.count})` : s.lines ? ` (${s.lines}L)` : s.cached != null ? ` (${s.cached} cached)` : '';
      lines.push(`<span class="${cls}">${sym} ${name}${detail}</span>`);
    }
    out.innerHTML = lines.join('\n');
  } catch(e) { out.textContent = 'Error: ' + e.message; }
});

// ─── FULLSCREEN ───────────────────────────────────────────────────────────────
document.getElementById('btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
});

// ─── REFRESH INTERVALS ────────────────────────────────────────────────────────
// Polling intervals run regardless, but fetch functions short-circuit if layer is off
// AISStream connects immediately on startup — ships update in real-time when key present
initAISStream();

function startPolling() {
  S.intervals.flights  = setInterval(fetchFlights,  CFG.refreshFlights);
  S.intervals.military = setInterval(fetchMilitary, CFG.refreshMilitary);
  S.intervals.ships    = setInterval(fetchShips,    CFG.refreshShips);
  S.intervals.quakes   = setInterval(fetchQuakes,   CFG.refreshQuakes);
  S.intervals.status   = setInterval(checkStatus,   30000);
  S.intervals.intel    = setInterval(() => { if (S.layers.intel) fetchIntel(); }, CFG.refreshIntel);
  S.intervals.osint    = setInterval(() => { if (S.layers.osint) fetchOsint(); }, 5 * 60000);
}

// On camera move stop, refresh viewport-dependent layers
let cameraMoveTimer = null;
S.viewer.camera.moveEnd.addEventListener(() => {
  clearTimeout(cameraMoveTimer);
  cameraMoveTimer = setTimeout(() => {
    if (S.layers.flights)   fetchFlights();
    if (S.layers.ships)     fetchShips();
    if (S.layers.cctv)      fetchCCTV();
    if (S.layers.wildfires) fetchFires();
  }, 800);
});

// ─── PLAYBACK ─────────────────────────────────────────────────────────────────
async function initPlayback() {
  try {
    const r = await fetch('/api/playback/range');
    const data = await r.json();
    const pb = document.getElementById('pb-status');
    if (data.available && data.earliest) {
      const from = new Date(data.earliest).toISOString().substring(0,16);
      const to   = new Date(data.latest).toISOString().substring(0,16);
      pb.textContent = `${from} → ${to}`;
    } else {
      pb.textContent = 'No archive data';
    }
  } catch { document.getElementById('pb-status').textContent = 'Archive unavailable'; }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  log('NEXUS v7.0 initialising…');

  // Verify H3 library loaded
  if (window.h3) log(`H3 library ready (v${window.h3.UNITS||'?'})`);
  else log('H3 library not loaded — GPS jamming layer unavailable', 'warn');

  // Polling intervals (layers auto-short-circuit if disabled)
  startPolling();
  checkStatus();
  initPlayback();

  // Fly to starting position (Europe/Atlantic overview)
  S.viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(10, 48, 12000000),
    duration: 2,
  });

  log('All layers OFF — click layer buttons to enable individually', 'ok');
  toast('NEXUS v7.0 online — select layers to begin', 'ok', 4000);
}

// ─── OSINT SOCIAL FEED ────────────────────────────────────────────────────────
let osintLoading = false;
let osintPosts   = [];
let osintFilter  = '';   // type filter: '', 'social', 'news', 'high-corr'

// Layer toggle handlers for OSINT and MAVEN
// Note: generic .lbtn handler runs first (toggles .on class + sets S.layers)
// These handlers add panel-specific logic AFTER the generic one fires
document.querySelector('[data-layer="osint"]')?.addEventListener('click', () => {
  // Read final 'on' state (already toggled by generic handler)
  const on = document.querySelector('[data-layer="osint"]').classList.contains('on');
  const panel = document.getElementById('osint-panel');
  panel.style.display = on ? 'flex' : 'none';
  if (on) {
    // Mutually exclusive with intel and maven panels
    document.getElementById('intel-panel').style.display = 'none';
    document.getElementById('maven-panel').style.display = 'none';
    document.querySelector('[data-layer="intel"]')?.classList.remove('on');
    document.querySelector('[data-layer="maven"]')?.classList.remove('on');
    S.layers.intel = false; S.layers.maven = false;
    document.getElementById('cesiumContainer').style.right = 'var(--intel-w)';
    fetchOsint();
  } else {
    document.getElementById('cesiumContainer').style.right = '0';
  }
});

document.querySelector('[data-layer="maven"]')?.addEventListener('click', () => {
  const on = document.querySelector('[data-layer="maven"]').classList.contains('on');
  const panel = document.getElementById('maven-panel');
  panel.style.display = on ? 'flex' : 'none';
  if (on) {
    document.getElementById('intel-panel').style.display = 'none';
    document.getElementById('osint-panel').style.display = 'none';
    document.querySelector('[data-layer="intel"]')?.classList.remove('on');
    document.querySelector('[data-layer="osint"]')?.classList.remove('on');
    S.layers.intel = false; S.layers.osint = false;
    document.getElementById('cesiumContainer').style.right = 'var(--intel-w)';
    loadTripwires();
  } else {
    document.getElementById('cesiumContainer').style.right = '0';
  }
});

// Close buttons
document.getElementById('osint-close').addEventListener('click', () => {
  document.getElementById('osint-panel').style.display = 'none';
  document.getElementById('cesiumContainer').style.right = '0';
  document.querySelector('[data-layer="osint"]')?.classList.remove('on');
  S.layers.osint = false;
});
document.getElementById('maven-close').addEventListener('click', () => {
  document.getElementById('maven-panel').style.display = 'none';
  document.getElementById('cesiumContainer').style.right = '0';
  document.querySelector('[data-layer="maven"]')?.classList.remove('on');
  S.layers.maven = false;
});

async function fetchOsint(query) {
  if (osintLoading) return;
  osintLoading = true;
  const q = query !== undefined ? query : document.getElementById('osint-q').value.trim();
  const list = document.getElementById('osint-items');
  list.innerHTML = `<div class="intel-loading"><div class="loading-spinner"></div><span>AGGREGATING PUBLIC SOURCES…</span></div>`;

  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    // Include viewport bbox for geo-filtering when location lock is active
    if (S.osintGeoBound) {
      const bbox = getViewportBbox();
      if (bbox) {
        params.set('minLat', bbox.minLat.toFixed(2));
        params.set('maxLat', bbox.maxLat.toFixed(2));
        params.set('minLon', bbox.minLon.toFixed(2));
        params.set('maxLon', bbox.maxLon.toFixed(2));
      }
    }
    const r = await fetch(`/api/osint/feed?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    osintPosts = data.posts || [];
    document.getElementById('osint-count').textContent = `${data.count} POSTS`;
    document.getElementById('osint-last-update').textContent = new Date().toISOString().substring(11,16) + 'Z';
    document.getElementById('cnt-osint').textContent = data.count;
    renderOsint();
    renderOsintMarkers(osintPosts);
    const geoNote = data.geoFiltered ? ' 📍' : '';
    log(`OSINT: ${data.count} posts${geoNote} (${data.posts?.filter(p=>p.platform==='reddit').length||0} social, ${data.posts?.filter(p=>p.platform==='rss').length||0} news)`);
  } catch(e) {
    list.innerHTML = `<div class="intel-empty">⚠ ${e.message}<br><small>Check server connection</small></div>`;
    log(`OSINT: ${e.message}`, 'error');
  } finally { osintLoading = false; }
}

// Event type classification (LiveUAMap-style)
const OSINT_EVENT_PATTERNS = [
  { type: 'conflict',  label: '💥 CONFLICT',  css: 'et-conflict',  re: /\b(attack|struck|strike|airstrike|missile|bomb|rocket|explosion|blast|shelling|drone|killed|casualties|dead|wounded|fighting|battle|troops|offensive|assault|invasion|war|combat|fire|artillery|mortar|ambush|clash|ceasefire|frontline|advance|withdraw|evacuate)\b/i },
  { type: 'military',  label: '⚔ MILITARY',   css: 'et-military',  re: /\b(military|troops|soldiers|army|navy|air force|nato|forces|deployment|aircraft|carrier|tank|armored|navy|brigade|battalion|regiment|general|admiral|pentagon|defense|ministry of defense)\b/i },
  { type: 'protest',   label: '✊ PROTEST',   css: 'et-protest',   re: /\b(protest|riot|demonstration|march|unrest|uprising|revolution|coup|civil|resistance|rebel|opposition)\b/i },
  { type: 'disaster',  label: '⚠ DISASTER',   css: 'et-disaster',  re: /\b(earthquake|flood|tsunami|hurricane|typhoon|cyclone|tornado|wildfire|eruption|landslide|drought|famine|disaster|emergency|evacuation)\b/i },
  { type: 'cyber',     label: '💻 CYBER',     css: 'et-cyber',     re: /\b(cyber|hack|ransomware|malware|breach|ddos|espionage|leak|intelligence|surveillance|intercept)\b/i },
];

function classifyEventType(title) {
  for (const p of OSINT_EVENT_PATTERNS) {
    if (p.re.test(title)) return p;
  }
  return null;
}

function renderOsint() {
  const list = document.getElementById('osint-items');
  let visible = osintPosts;

  if (osintFilter === 'social')    visible = osintPosts.filter(p => p.platform === 'reddit');
  else if (osintFilter === 'news') visible = osintPosts.filter(p => p.platform === 'rss');
  else if (osintFilter === 'conflict') visible = osintPosts.filter(p => classifyEventType(p.title)?.type === 'conflict');
  else if (osintFilter === 'high-corr') visible = osintPosts.filter(p => (p.corroboration||1) >= 3);

  if (!visible.length) {
    list.innerHTML = `<div class="intel-empty">No posts found<br><small>Try a different filter or search term</small></div>`;
    return;
  }

  list.innerHTML = '';
  for (const post of visible.slice(0, 100)) {
    const corrClass = (post.corroboration||1) >= 4 ? 'corr-high' : (post.corroboration||1) >= 2 ? 'corr-med' : '';
    const platformClass = post.platform === 'reddit' ? 'platform-reddit' : '';
    const timeAgo = timeAgoStr(post.date);
    const isNonEnglish = post.lang && post.lang !== 'en';
    const langBadge = isNonEnglish ? `<span class="osint-lang-badge">${post.lang.toUpperCase()}</span>` : '';
    const platformIcon = post.platform === 'reddit' ? '🟠' : '📰';
    const platformBadge = `<span class="osint-platform">${platformIcon} ${post.source}</span>`;
    const scoreStr = post.platform === 'reddit' ? `<span class="osint-score">▲${(post.score||0).toLocaleString()} 💬${post.comments||0}</span>` : '';
    const evType = classifyEventType(post.title);
    const evBadge = evType ? `<span class="osint-event-type ${evType.css}">${evType.label}</span>` : '';
    const geoBadge = post.geoCountry ? `<span class="osint-platform">📍 ${post.geoCountry}</span>` : '';

    const div = document.createElement('div');
    div.className = `osint-item ${corrClass} ${platformClass}`.trim();
    div.innerHTML = `
      ${(post.corroboration||1) > 1 ? `<span class="osint-corr">×${post.corroboration}</span>` : ''}
      <div class="osint-title">${escHtml(post.title)}</div>
      ${post._translated ? `<div class="osint-translated">${escHtml(post._translated)}</div>` : ''}
      <div class="osint-meta">
        ${evBadge}${platformBadge}${geoBadge}${langBadge}${scoreStr}
        <span class="osint-date">${timeAgo}</span>
      </div>`;

    div.addEventListener('click', () => window.open(post.permalink || post.url, '_blank'));

    if (isNonEnglish && !post._translated) {
      const titleDiv = div.querySelector('.osint-title');
      translateText(post.title, post.lang).then(translated => {
        if (translated && translated !== post.title) {
          post._translated = translated;
          const transEl = div.querySelector('.osint-translated');
          if (transEl) { transEl.textContent = translated; }
          else {
            const t = document.createElement('div');
            t.className = 'osint-translated'; t.textContent = translated;
            titleDiv.insertAdjacentElement('afterend', t);
          }
        }
      });
    }

    list.appendChild(div);
  }
}

// ─── OSINT MAP MARKERS (geo-tagged posts plotted on globe) ────────────────
function renderOsintMarkers(posts) {
  if (S.osintMarkerDs) { S.viewer.dataSources.remove(S.osintMarkerDs, true); S.osintMarkerDs = null; }
  if (!S.layers.osint) return;

  const ds = new Cesium.CustomDataSource('osint_markers');
  let placed = 0;

  for (const post of posts) {
    if (!post.geoLat || !post.geoLon) continue;
    const evType = classifyEventType(post.title);
    const color = evType?.type === 'conflict' ? '#ef4444'
                : evType?.type === 'military' ? '#f59e0b'
                : evType?.type === 'protest'  ? '#a855f7'
                : evType?.type === 'disaster' ? '#f97316'
                : '#06b6d4';
    const corr = post.corroboration || 1;
    const size = Math.max(5, Math.min(14, 5 + corr * 2));

    ds.entities.add({
      id: `osint_${post.id}`,
      name: post.title.substring(0, 40),
      position: Cesium.Cartesian3.fromDegrees(post.geoLon, post.geoLat, 500),
      point: {
        pixelSize:   size,
        color:       Cesium.Color.fromCssColorString(color).withAlpha(0.85),
        outlineColor: Cesium.Color.fromCssColorString(color).withAlpha(0.3),
        outlineWidth: corr > 2 ? 5 : 3,
        disableDepthTestDistance: 1e6,
      },
      label: corr > 2 ? {
        text: (evType?.label || '●').substring(0, 12),
        font: '9px JetBrains Mono',
        fillColor: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -14),
        translucencyByDistance: new Cesium.NearFarScalar(5e5, 1, 2e6, 0),
      } : undefined,
      properties: { type: 'osint_event', ...post },
    });
    placed++;
  }

  S.viewer.dataSources.add(ds);
  S.osintMarkerDs = ds;
  if (placed) log(`OSINT markers: ${placed} geo-tagged posts on map`);
}

// Translation cache (client-side)
const clientTransCache = new Map();
async function translateText(text, fromLang) {
  if (!text || fromLang === 'en') return null;
  const key = `${fromLang}_${text.substring(0,40)}`;
  if (clientTransCache.has(key)) return clientTransCache.get(key);
  try {
    const r = await fetch(`/api/translate?text=${encodeURIComponent(text.substring(0,280))}&from=${fromLang}&to=en`);
    if (!r.ok) return null;
    const data = await r.json();
    const result = data.translated !== text ? data.translated : null;
    if (result) clientTransCache.set(key, result);
    return result;
  } catch { return null; }
}

function timeAgoStr(ts) {
  const diff = Date.now() - (ts || 0);
  if (diff < 60000)   return `${Math.floor(diff/1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000)return `${Math.floor(diff/3600000)}h ago`;
  return `${Math.floor(diff/86400000)}d ago`;
}

// OSINT search + filter interactions
document.getElementById('osint-go').addEventListener('click', () => fetchOsint(document.getElementById('osint-q').value));
document.getElementById('osint-q').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('osint-go').click(); });
document.getElementById('osint-refresh').addEventListener('click', () => fetchOsint());

document.querySelectorAll('.osftag').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.osftag').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    osintFilter = btn.dataset.type;
    renderOsint();
  });
});

// Geo-lock: filter OSINT to current map viewport
document.getElementById('osint-loc-btn')?.addEventListener('click', () => {
  S.osintGeoBound = !S.osintGeoBound;
  document.getElementById('osint-loc-btn').classList.toggle('active', S.osintGeoBound);
  document.getElementById('osint-geo-badge').style.display = S.osintGeoBound ? 'flex' : 'none';
  fetchOsint();
});
document.getElementById('osint-geo-clear')?.addEventListener('click', () => {
  S.osintGeoBound = false;
  document.getElementById('osint-loc-btn').classList.remove('active');
  document.getElementById('osint-geo-badge').style.display = 'none';
  fetchOsint();
});

// ─── MAVEN — TRIPWIRE / ALERT SYSTEM ─────────────────────────────────────────
let tripwireData = [];
let alertLog = [];
let mavenCheckInterval = null;

async function loadTripwires() {
  try {
    const r = await fetch('/api/tripwires');
    if (!r.ok) return;
    const data = await r.json();
    tripwireData = data.tripwires || [];
    renderTripwireList();
  } catch(e) { log(`Tripwires: ${e.message}`, 'warn'); }
}

function renderTripwireList() {
  const list = document.getElementById('tripwire-list');
  if (!tripwireData.length) {
    list.innerHTML = '<div class="maven-empty">No tripwires set. Click + NEW to create one.</div>';
    return;
  }
  list.innerHTML = '';
  for (const tw of tripwireData) {
    const item = document.createElement('div');
    item.className = `tripwire-item${tw.active ? '' : ' inactive'}`;
    item.innerHTML = `
      <div>
        <div class="tripwire-name">${escHtml(tw.name)}</div>
        <div class="tripwire-type">${tw.type.toUpperCase()} · ${escHtml(tw.value||'')} ${tw.hits ? `· <span class="tripwire-hits">${tw.hits} HITS</span>` : ''}</div>
      </div>
      <div class="tripwire-controls">
        <button class="tw-ctrl-btn" data-id="${tw.id}" data-action="toggle">${tw.active ? 'PAUSE' : 'RESUME'}</button>
        <button class="tw-ctrl-btn" data-id="${tw.id}" data-action="delete" style="border-color:rgba(239,68,68,0.4);color:#ef4444">✕</button>
      </div>`;
    list.appendChild(item);
  }

  list.querySelectorAll('.tw-ctrl-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      const action = btn.dataset.action;
      if (action === 'delete') {
        if (!confirm(`Delete tripwire?`)) return;
        await fetch(`/api/tripwires/${id}`, { method: 'DELETE' });
      } else if (action === 'toggle') {
        const tw = tripwireData.find(t => t.id === id);
        await fetch(`/api/tripwires/${id}`, { method: 'PATCH', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ active: !tw.active }) });
      }
      loadTripwires();
    });
  });
}

// Tripwire form
document.getElementById('btn-add-tripwire').addEventListener('click', () => {
  document.getElementById('tripwire-form').style.display = 'block';
  document.getElementById('btn-add-tripwire').style.display = 'none';
});
document.getElementById('tw-cancel').addEventListener('click', () => {
  document.getElementById('tripwire-form').style.display = 'none';
  document.getElementById('btn-add-tripwire').style.display = '';
});
document.getElementById('tw-save').addEventListener('click', async () => {
  const name = document.getElementById('tw-name').value.trim();
  const type = document.getElementById('tw-type').value;
  let value = document.getElementById('tw-value').value.trim();
  const threshold = parseInt(document.getElementById('tw-threshold').value) || 1;

  if (!name) { toast('Enter a tripwire name', 'warn'); return; }

  let bbox = null;
  if (type === 'bbox') {
    const b = getViewportBbox();
    if (b) { bbox = b; value = `${b.minLat.toFixed(1)},${b.minLon.toFixed(1)} → ${b.maxLat.toFixed(1)},${b.maxLon.toFixed(1)}`; }
    else { toast('Cannot determine bbox — zoom in first', 'warn'); return; }
  }

  try {
    const r = await fetch('/api/tripwires', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, value, bbox, threshold }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    document.getElementById('tw-name').value = '';
    document.getElementById('tw-value').value = '';
    document.getElementById('tripwire-form').style.display = 'none';
    document.getElementById('btn-add-tripwire').style.display = '';
    await loadTripwires();
    toast(`Tripwire "${name}" active`, 'ok');
  } catch(e) { toast(`Save failed: ${e.message}`, 'error'); }
});
document.getElementById('btn-clear-alerts').addEventListener('click', () => {
  alertLog = [];
  document.getElementById('maven-alert-log').innerHTML = '<div class="maven-empty">No alerts triggered.</div>';
});

function addAlert(alert) {
  alertLog.unshift(alert);
  if (alertLog.length > 50) alertLog.length = 50;
  const log_el = document.getElementById('maven-alert-log');
  const item = document.createElement('div');
  item.className = 'alert-item';
  const matchNames = alert.matches.map(m => m.callsign || m.name || m.mmsi || '').filter(Boolean).join(', ');
  item.innerHTML = `
    <div class="alert-name">⚡ ${escHtml(alert.tripwire.name)}</div>
    <div class="alert-detail">${alert.count} match${alert.count>1?'es':''}: ${escHtml(matchNames || '(unnamed)')}</div>
    <div class="alert-ts">${new Date(alert.ts).toISOString().substring(11,19)}Z · ${alert.tripwire.type.toUpperCase()}</div>`;
  log_el.prepend(item);

  // Also show as toast notification
  toast(`⚡ TRIPWIRE: ${alert.tripwire.name} — ${alert.count} match${alert.count>1?'es':''}`, 'warn', 8000);
  log(`TRIPWIRE ALERT: ${alert.tripwire.name} (${alert.count} matches)`, 'warn');
}

// Check tripwires every 30s against live data
async function checkTripwires() {
  if (!tripwireData.length) return;
  try {
    // Collect current entity arrays
    const flights  = S.flightDs   ? [...S.flightDs.entities.values].map(e => { const p = e.properties; return [p.icao?.getValue?.()||'', p.callsign?.getValue?.()||'', p.country?.getValue?.()||'', 0,0, p.lon?.getValue?.(),p.lat?.getValue?.(),p.altM?.getValue?.()]; }) : [];
    const military = S.militaryDs ? [...S.militaryDs.entities.values].map(e => { const p = e.properties; return [p.icao?.getValue?.()||'', p.callsign?.getValue?.()||'', p.country?.getValue?.()||'', 0,0, p.lon?.getValue?.(),p.lat?.getValue?.(),p.altM?.getValue?.()]; }) : [];
    const ships    = S.shipDs     ? [...S.shipDs.entities.values].map(e => { const p = e.properties; return { name: p.name?.getValue?.(), mmsi: p.mmsi?.getValue?.(), lat: p.lat?.getValue?.(), lon: p.lon?.getValue?.() }; }) : [];

    const r = await fetch('/api/tripwires/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flights, military, ships }),
    });
    if (!r.ok) return;
    const data = await r.json();
    for (const alert of (data.alerts || [])) addAlert(alert);
  } catch {}
}

// ─── ENTITY LINK GRAPH (Maven-style link analysis) ────────────────────────────
document.getElementById('btn-entity-graph').addEventListener('click', () => openEntityGraph());
document.getElementById('entity-graph-close').addEventListener('click', () => {
  document.getElementById('entity-graph-modal').style.display = 'none';
});

function openEntityGraph() {
  const modal = document.getElementById('entity-graph-modal');
  modal.style.display = 'flex';

  // Gather all visible entities
  const nodes = [], edges = [];
  const seen = new Set();

  const addNode = (id, label, type, color) => {
    if (!seen.has(id)) { seen.add(id); nodes.push({ id, label, type, color }); }
  };

  // Add entity node groups
  const countryMap = new Map(); // country → [entity ids]
  const operatorMap = new Map(); // operator → [entity ids]

  const processDS = (ds, entityType, color) => {
    if (!ds) return;
    let count = 0;
    for (const entity of ds.entities.values) {
      if (count++ > 60) break; // cap for performance
      const p = entity.properties;
      const id = entity.id;
      const callsign = p.callsign?.getValue?.() || p.name?.getValue?.() || entity.name || id;
      const country  = p.country?.getValue?.() || '';
      const operator = p.operator?.getValue?.() || '';
      addNode(id, callsign.substring(0,12), entityType, color);
      if (country) {
        if (!countryMap.has(country)) { countryMap.set(country, []); addNode(`country_${country}`, country, 'country', '#06b6d4'); }
        countryMap.get(country).push(id);
        edges.push({ from: id, to: `country_${country}` });
      }
    }
  };

  processDS(S.flightDs, 'flight', '#22cc88');
  processDS(S.militaryDs, 'military', '#ff3333');
  processDS(S.shipDs, 'ship', '#2299ff');
  processDS(S.satDs, 'satellite', '#00ffaa');

  drawEntityGraph(nodes, edges);
}

function drawEntityGraph(nodes, edges) {
  const canvas = document.getElementById('entity-graph-canvas');
  const info = document.getElementById('entity-graph-info');
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth, H = canvas.offsetHeight;
  canvas.width = W; canvas.height = H;

  if (!nodes.length) {
    ctx.fillStyle = '#6b7280';
    ctx.font = '14px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText('No entities loaded — enable SAT, AIR, MIL or AIS layers', W/2, H/2);
    info.textContent = 'No data available';
    return;
  }

  // Force-directed layout (simple spring simulation)
  const positions = nodes.map((_, i) => ({
    x: W/2 + Math.cos(2*Math.PI*i/nodes.length) * Math.min(W,H)*0.35,
    y: H/2 + Math.sin(2*Math.PI*i/nodes.length) * Math.min(W,H)*0.35,
    vx: 0, vy: 0,
  }));
  const nodeIdx = new Map(nodes.map((n,i) => [n.id, i]));

  // Run simulation steps
  for (let step = 0; step < 80; step++) {
    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i+1; j < nodes.length; j++) {
        const dx = positions[j].x - positions[i].x || 0.1;
        const dy = positions[j].y - positions[i].y || 0.1;
        const d = Math.sqrt(dx*dx+dy*dy) || 1;
        const f = 800 / (d*d);
        positions[i].vx -= f*dx/d; positions[i].vy -= f*dy/d;
        positions[j].vx += f*dx/d; positions[j].vy += f*dy/d;
      }
    }
    // Attraction along edges
    for (const e of edges) {
      const ai = nodeIdx.get(e.from), bi = nodeIdx.get(e.to);
      if (ai==null||bi==null) continue;
      const dx = positions[bi].x - positions[ai].x;
      const dy = positions[bi].y - positions[ai].y;
      const d = Math.sqrt(dx*dx+dy*dy) || 1;
      const f = (d - 80) * 0.05;
      positions[ai].vx += f*dx/d; positions[ai].vy += f*dy/d;
      positions[bi].vx -= f*dx/d; positions[bi].vy -= f*dy/d;
    }
    // Centre gravity
    for (const p of positions) {
      p.vx += (W/2 - p.x) * 0.01;
      p.vy += (H/2 - p.y) * 0.01;
      p.vx *= 0.85; p.vy *= 0.85;
      p.x = Math.max(30, Math.min(W-30, p.x + p.vx));
      p.y = Math.max(20, Math.min(H-20, p.y + p.vy));
    }
  }

  // Draw
  ctx.fillStyle = '#0a0b0d';
  ctx.fillRect(0, 0, W, H);

  // Edges
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (const e of edges) {
    const ai = nodeIdx.get(e.from), bi = nodeIdx.get(e.to);
    if (ai==null||bi==null) continue;
    ctx.beginPath();
    ctx.moveTo(positions[ai].x, positions[ai].y);
    ctx.lineTo(positions[bi].x, positions[bi].y);
    ctx.stroke();
  }

  // Nodes
  const typeColors = { flight:'#22cc88', military:'#ff3333', ship:'#2299ff', satellite:'#00ffaa', country:'#06b6d4' };
  ctx.font = '9px JetBrains Mono';
  ctx.textAlign = 'center';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const p = positions[i];
    const color = n.color || typeColors[n.type] || '#888';
    const r = n.type === 'country' ? 7 : 4;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI*2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();
    if (n.type === 'country' || nodes.length < 30) {
      ctx.fillStyle = color;
      ctx.fillText(n.label, p.x, p.y - r - 2);
    }
  }

  info.textContent = `${nodes.length} entities · ${edges.length} connections · ${nodes.filter(n=>n.type==='country').length} countries`;

  // Click to show node info
  canvas.onclick = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const mx = evt.clientX - rect.left, my = evt.clientY - rect.top;
    for (let i = 0; i < nodes.length; i++) {
      const p = positions[i];
      if (Math.abs(p.x-mx) < 12 && Math.abs(p.y-my) < 12) {
        const n = nodes[i];
        const edgeCount = edges.filter(e => e.from===n.id || e.to===n.id).length;
        info.textContent = `${n.type.toUpperCase()} · ${n.label} · ${edgeCount} connections`;
        return;
      }
    }
    info.textContent = `${nodes.length} entities · ${edges.length} connections`;
  };
}

// ─── PATTERN OF LIFE ─────────────────────────────────────────────────────────
// Client-side: record entity positions periodically, store last ~200 positions per entity
const polHistory = new Map(); // entityId → [{ts, lat, lon, alt, name}]
const POL_MAX = 200;

function snapshotEntityPositions() {
  const now = Date.now();
  const dataSources = [S.flightDs, S.militaryDs, S.shipDs].filter(Boolean);
  for (const ds of dataSources) {
    for (const entity of ds.entities.values) {
      const p = entity.properties;
      const type = p.type?.getValue?.() || '';
      if (!['flight','military','ship'].includes(type)) continue;
      const lat = p.lat?.getValue?.();
      const lon = p.lon?.getValue?.();
      if (lat==null||lon==null) continue;
      const id = entity.id;
      if (!polHistory.has(id)) polHistory.set(id, []);
      const hist = polHistory.get(id);
      // Only record if moved significantly or 5+ minutes since last record
      const last = hist[hist.length-1];
      if (last && now - last.ts < 60000) continue; // rate limit: 1 per minute
      hist.push({ ts: now, lat, lon, alt: p.altFt?.getValue?.()||0, name: entity.name });
      if (hist.length > POL_MAX) hist.shift();
    }
  }
  // Clean up old entries for entities no longer visible
  if (polHistory.size > 2000) {
    const cutoff = now - 2 * 3600000; // 2 hours
    for (const [id, hist] of polHistory) {
      if (!hist.length || hist[hist.length-1].ts < cutoff) polHistory.delete(id);
    }
  }
}
// Snapshot positions every 60 seconds
setInterval(snapshotEntityPositions, 60000);

document.getElementById('btn-pol').addEventListener('click', () => {
  if (S.selectedEntity) openPatternOfLife(S.selectedEntity);
  else toast('Click an entity on the map first', 'warn');
});

function openPatternOfLife(entity) {
  const modal = document.getElementById('pol-modal');
  const timeline = document.getElementById('pol-timeline');
  const stats = document.getElementById('pol-stats');
  document.getElementById('pol-entity-name').textContent = (entity.name || entity.id).substring(0, 24);

  const hist = polHistory.get(entity.id) || [];
  modal.style.display = 'flex';

  if (!hist.length) {
    timeline.innerHTML = '<div class="maven-empty">No history recorded for this entity yet. It will accumulate as data refreshes.</div>';
    stats.textContent = 'No data';
    return;
  }

  timeline.innerHTML = '';
  for (const entry of [...hist].reverse().slice(0, 100)) {
    const div = document.createElement('div');
    div.className = 'pol-entry';
    div.innerHTML = `
      <div class="pol-ts">${new Date(entry.ts).toISOString().substring(11,19)}Z</div>
      <div>
        <div class="pol-detail">${entry.alt ? Math.round(entry.alt/100)*100 + 'ft' : 'Surface'}</div>
        <div class="pol-coord">${entry.lat.toFixed(3)}°N ${entry.lon.toFixed(3)}°E</div>
      </div>`;
    timeline.appendChild(div);
  }

  const first = hist[0], last = hist[hist.length-1];
  const spanMin = Math.round((last.ts - first.ts) / 60000);
  const lats = hist.map(h => h.lat), lons = hist.map(h => h.lon);
  const bbox = `${Math.min(...lats).toFixed(2)}°–${Math.max(...lats).toFixed(2)}°N, ${Math.min(...lons).toFixed(2)}°–${Math.max(...lons).toFixed(2)}°E`;
  stats.textContent = `${hist.length} positions · ${spanMin}min track · Bounds: ${bbox}`;
}

document.getElementById('pol-close').addEventListener('click', () => {
  document.getElementById('pol-modal').style.display = 'none';
});

// ─── START MAVEN TRIPWIRE POLLING ────────────────────────────────────────────
setInterval(() => { if (tripwireData.length) checkTripwires(); }, 30000);

// Wait for satellite.js to be ready
if (typeof satellite !== 'undefined') {
  init();
} else {
  window.addEventListener('load', init);
}
