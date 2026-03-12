/**
 * PANOPTICON // GLOBAL INTELLIGENCE SYSTEM v2
 * Real-time geospatial dashboard
 */
'use strict';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  satelliteUpdateInterval: 5000,
  flightUpdateInterval: 15000,
  quakeUpdateInterval: 60000,
  trafficParticleCount: 500,
};

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
const S = {
  viewer: null,
  layers: {
    satellites: { on: true,  ds: null },
    flights:    { on: false, ds: null },
    military:   { on: false, ds: null },
    traffic:    { on: false, ds: null, particles: [], interval: null },
    quakes:     { on: false, ds: null },
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

function initCesium(token) {
  Cesium.Ion.defaultAccessToken = token;
  S.viewer = new Cesium.Viewer('cesiumContainer', {
    terrainProvider: Cesium.createWorldTerrain(),
    imageryProvider: false, baseLayerPicker: false,
    geocoder: false, homeButton: false, sceneModePicker: false,
    navigationHelpButton: false, animation: false, timeline: false,
    fullscreenButton: false, infoBox: false, selectionIndicator: false,
    shadows: false, creditContainer: document.createElement('div'),
  });
  const scene = S.viewer.scene;
  scene.globe.enableLighting = true;
  scene.globe.atmosphereLightIntensity = 10.0;

  // Try Google 3D tiles
  try {
    const ts = S.viewer.scene.primitives.add(new Cesium.Cesium3DTileset({
      url: Cesium.IonResource.fromAssetId(2275207),
      maximumScreenSpaceError: 16,
    }));
    ts.readyPromise.then(() => addLog('GOOGLE 3D TILES ONLINE')).catch(() => loadFallback());
  } catch { loadFallback(); }

  S.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(0, 20, 18000000),
    orientation: { heading:0, pitch: Cesium.Math.toRadians(-90), roll:0 } });
  S.viewer.screenSpaceEventHandler.setInputAction(onGlobeClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  S.viewer.camera.changed.addEventListener(updateCoords);
  updateCoords();
  addLog('SYSTEM ONLINE');
  loadSatellites();
}

function loadFallback() {
  S.viewer.imageryLayers.addImageryProvider(new Cesium.IonImageryProvider({ assetId: 3 }));
  Cesium.createOsmBuildings().then(t => { S.viewer.scene.primitives.add(t); addLog('OSM BUILDINGS LOADED'); }).catch(()=>{});
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
async function loadTraffic() {
  clearTraffic();
  const cam = S.viewer.camera.positionCartographic;
  const lat = Cesium.Math.toDegrees(cam.latitude);
  const lon = Cesium.Math.toDegrees(cam.longitude);
  try {
    const r = await fetch(`/api/osm/roads?lat=${lat}&lon=${lon}&radius=4000`);
    if (!r.ok) throw new Error();
    const data = await r.json();
    spawnParticles(data.elements||[], lat, lon);
  } catch { spawnDemoParticles(lat, lon); }
}

function spawnParticles(roads, clat, clon) {
  const segs = [];
  for (const el of roads) {
    if (el.type!=='way'||!el.geometry) continue;
    for (let i=0;i<el.geometry.length-1;i++) segs.push([el.geometry[i],el.geometry[i+1]]);
  }
  if (!segs.length) { spawnDemoParticles(clat,clon); return; }
  _buildParticles(segs);
}

function spawnDemoParticles(clat, clon) {
  const segs=[];
  for(let i=-6;i<=6;i++){
    segs.push([{lat:clat+i*0.003,lon:clon-0.025},{lat:clat+i*0.003,lon:clon+0.025}]);
    segs.push([{lat:clat-0.025,lon:clon+i*0.003},{lat:clat+0.025,lon:clon+i*0.003}]);
  }
  _buildParticles(segs);
}

function _buildParticles(segs) {
  const ds = new Cesium.CustomDataSource('traffic');
  const count = Math.min(CONFIG.trafficParticleCount, segs.length*2);
  for(let i=0;i<count;i++){
    const seg=segs[Math.floor(Math.random()*segs.length)];
    const t=Math.random();
    const e=ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(
        seg[0].lon+(seg[1].lon-seg[0].lon)*t,
        seg[0].lat+(seg[1].lat-seg[0].lat)*t, 5),
      point:{pixelSize:2, color:Cesium.Color.fromCssColorString('#ffff00').withAlpha(0.8),
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND},
      properties:{seg,t,spd:0.00015+Math.random()*0.0003,dir:Math.random()>0.5?1:-1},
    });
    S.layers.traffic.particles.push(e);
  }
  S.viewer.dataSources.add(ds);
  S.layers.traffic.ds = ds;
  document.getElementById('traffic-count').textContent = count;
  addLog(`${count} TRAFFIC PARTICLES ACTIVE`);
  S.layers.traffic.interval = setInterval(()=>_animParticles(segs), 100);
}

function _animParticles(segs) {
  for(const e of S.layers.traffic.particles){
    const p=e.properties;
    let t=p.t._value+p.spd._value*p.dir._value;
    if(t>1||t<0){p.dir._value*=-1;t=Math.max(0,Math.min(1,t));}
    p.t._value=t;
    const seg=p.seg._value;
    e.position=Cesium.Cartesian3.fromDegrees(
      seg[0].lon+(seg[1].lon-seg[0].lon)*t,
      seg[0].lat+(seg[1].lat-seg[0].lat)*t, 5);
  }
}

function clearTraffic() {
  if (S.layers.traffic.ds) S.viewer?.dataSources.remove(S.layers.traffic.ds,true);
  if (S.layers.traffic.interval) clearInterval(S.layers.traffic.interval);
  S.layers.traffic.particles=[];
  S.layers.traffic.ds=null;
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
function updateCoords() {
  if (!S.viewer) return;
  const c = S.viewer.camera.positionCartographic;
  document.getElementById('lat-display').textContent = Cesium.Math.toDegrees(c.latitude).toFixed(3)+'°';
  document.getElementById('lon-display').textContent = Cesium.Math.toDegrees(c.longitude).toFixed(3)+'°';
  const alt = c.height/1000;
  document.getElementById('alt-display').textContent = alt>1000?(alt/1000).toFixed(1)+'M':Math.round(alt).toString();
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
