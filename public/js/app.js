/* ══ ARGUS v7 ══════════════════════════════════════════════════════════════════
 * Geospatial Intelligence Dashboard
 * - satellite.js SGP4 propagation (accurate orbital mechanics)
 * - Viewport-frustum culling: only fetch what's in view
 * - GDELT intel feed: 100+ languages, corroboration scoring
 * - AI natural-language queries via Claude
 * - Fixed: flights (adsb.lol), ships (AIS/VF), satellites (visual group)
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CFG = {
  cesiumToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI1NGFiZGQxMy0zZDJjLTQ2OGYtYjFmNi02ZTQwMzM4NjNjN2EiLCJpZCI6Mjk0MjEsImlhdCI6MTU5MzI0OTM5Mn0.yAfCt9LQFf0j-bPJnBiVaAGVknQF1eFjPh1WNt_LCWY',
  refreshFlights:   8000,
  refreshMilitary: 12000,
  refreshShips:    10000,
  refreshQuakes:  120000,
  refreshSats:      5000,   // re-propagate positions (no new TLE fetch)
  refreshIntel:   300000,   // 5 min
  maxSats:          2000,   // render limit
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
  intervals:   {},
  layers: {
    satellites: true, flights: true, military: true, ships: true,
    quakes: true, cctv: false, wildfires: false, jamming: false,
    mesh: false, intel: true,
  },
  activeSatGroups: new Set(['visual']),
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
Cesium.Ion.defaultAccessToken = CFG.cesiumToken;

S.viewer = new Cesium.Viewer('cesiumContainer', {
  imageryProvider:        false,
  terrainProvider:        new Cesium.EllipsoidTerrainProvider(),
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
  skyAtmosphere:          new Cesium.SkyAtmosphere(),
  requestRenderMode:      false,   // continuous render needed for moving sats
  scene3DOnly:            false,
});

// Set dark void background
S.viewer.scene.backgroundColor = new Cesium.Color(0.04, 0.04, 0.06, 1);
S.viewer.scene.globe.show = true;

// Apply initial dark basemap
applyBasemap('dark');

// ─── BASEMAP ──────────────────────────────────────────────────────────────────
// CesiumJS 1.114: IonImageryProvider is now async — must use fromAssetId()
async function applyBasemap(mode) {
  S.viewer.imageryLayers.removeAll();
  // Reset to flat ellipsoid terrain first
  S.viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();

  const layers = S.viewer.imageryLayers;

  try {
    if (mode === 'dark') {
      layers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        subdomains: 'abcd', minimumLevel: 0, maximumLevel: 19,
        credit: '© CARTO © OpenStreetMap',
      }));
    } else if (mode === 'satellite') {
      // Async Ion provider — CesiumJS 1.109+
      const provider = await Cesium.IonImageryProvider.fromAssetId(3);
      layers.addImageryProvider(provider);
    } else if (mode === 'terrain') {
      // Satellite imagery base
      const imgProvider = await Cesium.IonImageryProvider.fromAssetId(3);
      layers.addImageryProvider(imgProvider);
      // World terrain with async API
      try {
        S.viewer.terrainProvider = await Cesium.CesiumTerrainProvider.fromIon(1);
      } catch {
        // Fallback: terrain without Ion if token missing
        S.viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
      }
    }
  } catch(e) {
    console.warn('Basemap load failed, falling back to dark tiles:', e.message);
    try {
      layers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
        url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        subdomains: 'abcd', minimumLevel: 0, maximumLevel: 19,
        credit: '© CARTO © OpenStreetMap',
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
      return;
    }

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

      const isStation = sat.name.match(/ISS|TIANGONG|CSS/i);
      const isStarlink = sat.name.includes('STARLINK');
      const color = isStation ? '#ff6600' : isStarlink ? '#4488ff' : '#00ffaa';

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
// Visualises sensor coverage for the visual (brightest) satellite group
// Inner amber ring  = nadir sensor swath (~5° half-angle: high-res imaging zone)
// Outer cyan ring   = wide-area coverage (~25° half-angle: off-nadir observable)
// Ground track line = predicted orbit path ±20 minutes
function renderSatFootprints(now) {
  if (satFootprintDs) S.viewer.dataSources.remove(satFootprintDs, true);
  if (!S.tleData.length) return;

  const ds   = new Cesium.CustomDataSource('sat_footprints');
  const date = now || new Date();
  const R    = 6371;  // Earth radius km

  // Only render footprints for the first 200 sats (visual group + stations)
  const limit = Math.min(S.tleData.length, 200);

  for (let i = 0; i < limit; i++) {
    const sat = S.tleData[i];
    try {
      const pos = sgp4Position(sat.tle1, sat.tle2, date);
      if (!pos) continue;
      const h   = pos.alt;          // km above ellipsoid
      if (h < 100 || h > 40000) continue; // skip if out of range

      const isGEO     = h > 35000;
      const isStation = sat.name.match(/ISS|TIANGONG|CSS/i);

      // ── Inner sensor swath (nadir, ~5° half-angle)
      const sensorRad  = h * Math.tan(5  * Math.PI / 180) * 1000; // metres
      // ── Outer coverage (~25° off-nadir)
      const coverageRad= h * Math.tan(25 * Math.PI / 180) * 1000;

      const groundPos = Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, 0);

      // Outer coverage zone — dim cyan ring
      if (!isGEO) {
        ds.entities.add({
          position: groundPos,
          ellipse: {
            semiMinorAxis: coverageRad,
            semiMajorAxis: coverageRad,
            material:      Cesium.Color.fromCssColorString('#06b6d4').withAlpha(0.04),
            outline:       true,
            outlineColor:  Cesium.Color.fromCssColorString('#06b6d4').withAlpha(0.25),
            outlineWidth:  1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
        });
      }

      // Inner sensor footprint — amber
      const innerAlpha = isStation ? 0.15 : 0.08;
      ds.entities.add({
        position: groundPos,
        ellipse: {
          semiMinorAxis: isGEO ? 2000000 : sensorRad,  // GEO gets fixed large footprint
          semiMajorAxis: isGEO ? 2000000 : sensorRad,
          material:      Cesium.Color.fromCssColorString('#f59e0b').withAlpha(innerAlpha),
          outline:       true,
          outlineColor:  Cesium.Color.fromCssColorString('#f59e0b').withAlpha(isStation ? 0.8 : 0.45),
          outlineWidth:  isStation ? 2 : 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });

      // Sub-satellite crosshair point (brighter dot at nadir)
      ds.entities.add({
        position: groundPos,
        point: {
          pixelSize: isStation ? 5 : 2,
          color: Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.7),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });

      // Ground track line (projected orbit ±20 min) — only for LEO
      if (!isGEO) {
        const trackPositions = [];
        const steps = 40;
        const spanMs = 20 * 60 * 1000;
        for (let s = 0; s <= steps; s++) {
          const t = new Date(date.getTime() - spanMs/2 + (spanMs * s / steps));
          try {
            const tp = sgp4Position(sat.tle1, sat.tle2, t);
            if (tp) trackPositions.push(Cesium.Cartesian3.fromDegrees(tp.lng, tp.lat, 0));
          } catch {}
        }
        if (trackPositions.length > 2) {
          ds.entities.add({
            polyline: {
              positions:      trackPositions,
              width:          isStation ? 1.5 : 0.8,
              material:       new Cesium.ColorMaterialProperty(
                Cesium.Color.fromCssColorString(isStation ? '#ff6600' : '#f59e0b').withAlpha(0.3)
              ),
              clampToGround:  true,
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
  const dist = Math.min(Math.max(S.cameraAlt / 1000 * 0.5, 100), 250);

  try {
    const r = await fetch(`/api/flights/opensky?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&dist=${Math.round(dist)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    renderFlights(data.states || [], false);
    document.getElementById('cnt-air').textContent = (data.states || []).length;
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
    if (bbox && (lat < bbox.minLat || lat > bbox.maxLat || lon < bbox.minLon || lon > bbox.maxLon)) {
      // Skip entities outside viewport when zoomed in enough
      if (S.cameraAlt < 3000000) continue;
    }

    const color = isMilitary ? '#ff3333' : altColor(altM);
    const altFt = Math.round((altM || 0) * 3.28084);
    const spdKt = Math.round((speed || 0) * 1.944);

    ds.entities.add({
      id: `${isMilitary?'mil':'ac'}_${icao}`,
      name: callsign || icao || 'Unknown',
      position: Cesium.Cartesian3.fromDegrees(lon, lat, altM || 0),
      billboard: {
        image: isMilitary ? milIcon(color) : planeIcon(color, track),
        width: isMilitary ? 14 : 16, height: isMilitary ? 14 : 16,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.5, 5e6, 0.6),
      },
      label: {
        text: `${callsign||icao}\n${altFt ? altFt.toLocaleString()+'ft' : 'GND'} ${spdKt}kt`,
        font: '10px JetBrains Mono, monospace',
        fillColor: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -20),
        translucencyByDistance: new Cesium.NearFarScalar(5e5, 1, 3e6, 0),
        backgroundColor: new Cesium.Color(0,0,0,0.4),
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

async function fetchShips() {
  if (!S.layers.ships) return;
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
    if (!s.lat || !s.lon || isNaN(s.lat) || isNaN(s.lon)) continue;
    const color = shipColor(s.type || 0);
    const name  = s.name || s.mmsi || 'UNKNOWN';

    ds.entities.add({
      id: `ship_${s.mmsi || Math.random()}`,
      name,
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 10),
      billboard: {
        image: shipIcon(color, s.heading || s.course || 0, s.type || 0),
        width: 14, height: 14,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        scaleByDistance: new Cesium.NearFarScalar(1e4, 2, 2e6, 0.6),
      },
      label: {
        text: name.substring(0, 10),
        font: '10px JetBrains Mono, monospace',
        fillColor: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
        outlineColor: Cesium.Color.BLACK, outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -16),
        translucencyByDistance: new Cesium.NearFarScalar(1e5, 1, 1e6, 0),
      },
      properties: { type: 'ship', ...s },
    });
  }

  S.viewer.dataSources.add(ds);
  S.shipDs = ds;
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
async function fetchJamming() {
  if (!S.layers.jamming) return;
  try {
    const r = await fetch('/api/jamming');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    renderJamming(data.hexes || [], data.date);
    log(`GPS Jam: ${data.count} affected cells on ${data.date}`);
  } catch(e) { log(`Jamming: ${e.message}`, 'warn'); }
}

function renderJamming(hexes, date) {
  if (S.jammingDs) S.viewer.dataSources.remove(S.jammingDs, true);
  if (!S.layers.jamming) return;
  // H3 hexagon approximate rendering as points
  const ds = new Cesium.CustomDataSource('jamming');
  for (const h of hexes) {
    // Simple visual: place a point (real H3 decoding would require h3-js)
    const alpha = Math.min(0.9, h.p / 100);
    const color = h.p > 50 ? '#ff0000' : h.p > 25 ? '#ff6600' : '#ffaa00';
    // We'd need H3 JS to get lat/lon from hex ID — skip if h3 unavailable
    // Placeholder: can't render without h3-js properly
  }
  S.viewer.dataSources.add(ds);
  S.jammingDs = ds;
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
  }

  rows.push(`<div id="enrich-data" class="enrich-section"><div class="enrich-loading"><span class="loading-spinner" style="width:12px;height:12px;border-width:1.5px"></span><span class="dim tiny" style="margin-left:6px">QUERYING DATABASES…</span></div></div>`);
  body.innerHTML = rows.join('');
  box.classList.remove('hidden');

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
});
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
document.getElementById('info-shodan').addEventListener('click', () => {
  if (!S.selectedEntity) return;
  const props = S.selectedEntity.properties;
  const country = props?.country?.getValue?.() || props?.country || '';
  if (country) {
    document.getElementById('shodan-preset').value = '';
    document.getElementById('shodan-key').focus();
    toast(`Set Shodan key then search for country:${country}`, 'info', 4000);
  }
});

// ─── SHODAN ───────────────────────────────────────────────────────────────────
document.getElementById('shodan-go').addEventListener('click', async () => {
  const key   = document.getElementById('shodan-key').value.trim();
  const query = document.getElementById('shodan-preset').value;
  if (!query) { toast('Select a Shodan preset', 'warn'); return; }
  if (!key)   { toast('Enter Shodan API key', 'warn'); return; }

  if (S.shodanDs) { S.viewer.dataSources.remove(S.shodanDs, true); S.shodanDs = null; }
  toast('Searching Shodan…', 'info', 3000);

  try {
    const r = await fetch(`/api/shodan/search?q=${encodeURIComponent(query)}`, {
      headers: { 'x-shodan-key': key }
    });
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
    toast(`Shodan: ${matches.length} results`, 'ok', 4000);
    log(`Shodan: ${matches.length} matches for "${query}"`);
  } catch(e) { toast(`Shodan: ${e.message}`, 'error'); }
});

// ─── STATUS CHECK ─────────────────────────────────────────────────────────────
async function checkStatus() {
  try {
    const r = await fetch('/api/status');
    const data = await r.json();
    const aisPill   = document.getElementById('pill-aisstream');
    const shodanPill= document.getElementById('pill-shodan');

    if (aisPill) {
      const dot = aisPill.querySelector('.dot');
      if (data.ws_connected) { dot.className='dot green'; if(data.ship_count) aisPill.title=`AISStream: ${data.ship_count} ships`; }
      else if (data.aisstream) { dot.className='dot amber'; }
      else { dot.className='dot red'; }
    }
    if (shodanPill) {
      const dot = shodanPill.querySelector('.dot');
      dot.className = data.shodan ? 'dot green' : 'dot red';
    }
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
function startPolling() {
  fetchFlights();
  fetchMilitary();
  fetchShips();
  fetchQuakes();

  S.intervals.flights  = setInterval(fetchFlights,  CFG.refreshFlights);
  S.intervals.military = setInterval(fetchMilitary, CFG.refreshMilitary);
  S.intervals.ships    = setInterval(fetchShips,    CFG.refreshShips);
  S.intervals.quakes   = setInterval(fetchQuakes,   CFG.refreshQuakes);
  S.intervals.status   = setInterval(checkStatus,   30000);
  S.intervals.intel    = setInterval(() => { if (S.layers.intel) fetchIntel(); }, CFG.refreshIntel);
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
  log('ARGUS v7.0 initialising…');

  // Load initial data
  await loadSatellites();
  startPolling();
  checkStatus();
  fetchIntel();
  initPlayback();

  // Fly to reasonable starting position
  S.viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(10, 48, 12000000),
    duration: 2,
  });

  log('All systems nominal', 'ok');
  toast('ARGUS v7.0 online', 'ok', 3000);
}

// Wait for satellite.js to be ready
if (typeof satellite !== 'undefined') {
  init();
} else {
  window.addEventListener('load', init);
}
