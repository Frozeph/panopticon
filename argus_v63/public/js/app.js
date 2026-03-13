/**
 * ARGUS // GLOBAL INTELLIGENCE SYSTEM v5
 * Fixed: satellites (all groups), flights, ships, CCTV, GPS jam, Meshtastic, seismic stations
 */
'use strict';

const LOD = { GLOBAL:5_000_000, REGIONAL:500_000, CITY:50_000 };
const CONFIG = {
  satelliteUpdateInterval:  5_000,
  flightUpdateInterval:     8_000,
  militaryUpdateInterval:  12_000,
  shipUpdateInterval:      10_000,
  quakeUpdateInterval:     60_000,
  gpsjamUpdateInterval:   300_000,
  weatherUpdateInterval:   60_000,
  fireUpdateInterval:     120_000,
  meshtasticUpdateInterval:120_000,
  lodDebounce:              2_000,
  cctvRadius:               5_000,
};

let currentLOD='GLOBAL', lodDebounceTimer=null, lastViewBbox=null;

const PRESETS = {
  global:  {lon:0,      lat:20,      alt:18000000,pitch:-90},
  london:  {lon:-0.1278,lat:51.5074, alt:800000,  pitch:-45},
  nyc:     {lon:-74.006,lat:40.7128, alt:600000,  pitch:-40},
  dc:      {lon:-77.036,lat:38.9072, alt:400000,  pitch:-40},
  moscow:  {lon:37.617, lat:55.755,  alt:600000,  pitch:-40},
  beijing: {lon:116.407,lat:39.904,  alt:600000,  pitch:-40},
  dubai:   {lon:55.296, lat:25.2048, alt:500000,  pitch:-40},
  sydney:  {lon:151.209,lat:-33.868, alt:500000,  pitch:-40},
};

// ── ICONS ─────────────────────────────────────────────────────────────────────
const svg = (w,h,body) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`)}`;

function planeIcon(color, cat, size) {
  const s = size || 22;
  let shape;
  if (cat === 'heli') {
    shape = `<ellipse cx="${s/2}" cy="${s*0.55}" rx="${s*0.2}" ry="${s*0.12}" fill="${color}"/>
      <line x1="${s*0.05}" y1="${s*0.42}" x2="${s*0.95}" y2="${s*0.42}" stroke="${color}" stroke-width="${s*0.1}" stroke-linecap="round"/>
      <line x1="${s/2}" y1="${s*0.42}" x2="${s/2}" y2="${s*0.88}" stroke="${color}" stroke-width="${s*0.09}"/>`;
  } else if (cat === 'mil') {
    shape = `<path d="M${s/2},${s*0.06} L${s*0.62},${s*0.38} L${s*0.92},${s*0.44} L${s*0.72},${s*0.62} L${s*0.78},${s*0.9} L${s/2},${s*0.76} L${s*0.22},${s*0.9} L${s*0.28},${s*0.62} L${s*0.08},${s*0.44} L${s*0.38},${s*0.38}Z" fill="${color}"/>`;
  } else if (cat === 'prop') {
    shape = `<path d="M${s/2},${s*0.06} L${s*0.57},${s*0.45} L${s*0.88},${s*0.52} L${s*0.88},${s*0.6} L${s*0.57},${s*0.56} L${s*0.55},${s*0.78} L${s*0.65},${s*0.82} L${s*0.65},${s*0.88} L${s/2},${s*0.84} L${s*0.35},${s*0.88} L${s*0.35},${s*0.82} L${s*0.45},${s*0.78} L${s*0.43},${s*0.56} L${s*0.12},${s*0.6} L${s*0.12},${s*0.52} L${s*0.43},${s*0.45}Z" fill="${color}"/>`;
  } else {
    // jet / default — widebody airliner silhouette
    shape = `<path d="M${s/2},${s*0.04} L${s*0.58},${s*0.4} L${s*0.92},${s*0.5} L${s*0.92},${s*0.58} L${s*0.58},${s*0.52} L${s*0.56},${s*0.74} L${s*0.68},${s*0.78} L${s*0.68},${s*0.85} L${s/2},${s*0.8} L${s*0.32},${s*0.85} L${s*0.32},${s*0.78} L${s*0.44},${s*0.74} L${s*0.42},${s*0.52} L${s*0.08},${s*0.58} L${s*0.08},${s*0.5} L${s*0.42},${s*0.4}Z" fill="${color}"/>`;
  }
  return svg(s, s, shape);
}

// ADSBexchange-style altitude colour gradient
function altitudeColor(altM, onGround) {
  if (onGround || altM < 15)    return '#888888';
  const altFt = altM * 3.28084;
  if (altFt <  1000) return '#ff7f00';
  if (altFt <  5000) return '#ff9900';
  if (altFt < 10000) return '#ffcc00';
  if (altFt < 18000) return '#aaee22';
  if (altFt < 25000) return '#00ee88';
  if (altFt < 33000) return '#00ccff';
  if (altFt < 40000) return '#2299ff';
  if (altFt < 45000) return '#9955ff';
  return '#ff44aa';
}

// Determine aircraft silhouette category
function getAircraftCategory(cs, mil, typeCode) {
  if (mil) return 'mil';
  if (typeCode) {
    const t = typeCode.toUpperCase();
    if (/^(R|EC|AS|BO|BK|H[0-9]|S[0-9]|UH|AH|CH|SH|HH|MH|A[0-9]{3}H)/.test(t)) return 'heli';
    if (/^(AT[0-9]|DH|DO|E[0-9]{3}|SF|PC|TB|PA|CE|P[0-9])/.test(t)) return 'prop';
    if (/^(F[0-9]|SU|MIG|EF|GR|TO|A10|B1|B2|B52|C17|C130|KC)/.test(t)) return 'mil';
  }
  if (/^(LIFE|HEMS|ROTO|G-|N[0-9]{1,4}[A-Z]|LN-)/.test(cs)) return 'heli';
  return 'jet';
}
function shipIcon(color)  { return svg(20,20,`<polygon points="10,2 18,17 10,13 2,17" fill="${color}" stroke="white" stroke-width="1.2"/>`); }
function cctvIcon()       { return svg(16,16,`<circle cx="8" cy="8" r="7" fill="#ff6600" opacity="0.9"/><circle cx="8" cy="8" r="3" fill="white" opacity="0.5"/><circle cx="8" cy="8" r="1.5" fill="#ff6600"/>`); }
function meshIcon(online) { const c=online?'#00ff88':'#888'; return svg(18,18,`<circle cx="9" cy="9" r="8" fill="none" stroke="${c}" stroke-width="1.5" opacity="0.8"/><circle cx="9" cy="9" r="3" fill="${c}" opacity="0.9"/><line x1="9" y1="1" x2="9" y2="4" stroke="${c}" stroke-width="1.5"/><line x1="15.2" y1="4.8" x2="12.9" y2="7.1" stroke="${c}" stroke-width="1.5"/>`); }
function stationIcon()    { return svg(16,16,`<rect x="3" y="8" width="10" height="6" fill="none" stroke="#00ddff" stroke-width="1.2"/><line x1="8" y1="2" x2="8" y2="8" stroke="#00ddff" stroke-width="1.5"/><circle cx="8" cy="2" r="1.5" fill="#00ddff"/>`); }

// ── STATE ─────────────────────────────────────────────────────────────────────
let serverStatus = { shodan: false, aisstream: false };

async function checkServerStatus() {
  try {
    const r = await fetch('/api/status');
    if (r.ok) serverStatus = await r.json();
    console.log('[ARGUS] Server status:', serverStatus);
    if (serverStatus.shodan) {
      addLog('SHODAN: KEY CONFIGURED (SERVER)');
      const prompt = document.getElementById('shodan-key-prompt');
      if (prompt) prompt.style.display = 'none';
    }
  } catch (e) { console.warn('[ARGUS] status check failed:', e.message); }
}

const S = {
  viewer:null,
  layers:{
    satellites:{on:true, ds:null},
    flights:   {on:false,ds:null},
    military:  {on:false,ds:null},
    ships:     {on:false,ds:null},
    traffic:   {on:false,ds:null,polylines:null},
    quakes:    {on:false,ds:null},
    sensors:   {on:false,ds:null},
    gpsjam:    {on:false,ds:null},
    cctv:      {on:false,ds:null},
    weather:   {on:false,ds:null},
    wildfires: {on:false,ds:null},
    shodan:    {on:false,ds:null},
    meshtastic:{on:false,ds:null},
  },
  tleData:[], tracking:null, detMode:'sparse',
  intervals:{}, logHistory:[],
  filters:{flights:{minAlt:0,maxAlt:45000,minSpd:0,maxSpd:1200,country:'',callsign:'',showUnknown:true}},
  playback:{active:false,currentTs:null,speed:1,playing:false,playInterval:null,range:{earliest:null,latest:null}},
  shodan:{key:'',lastResults:[],creditStats:null},
  airlineMap:{}, rawFlights:[], rawMilitary:[],
  meshtastic:{nodes:[], messages:[]},
};

// ── BOOT ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded',()=>{
  checkServerStatus();
  setupTokenModal(); setupUI(); startClock();
  loadShodanPresets(); refreshStorageStats(); refreshShodanCredits();
});

// ── CESIUM ────────────────────────────────────────────────────────────────────
function setupTokenModal() {
  const modal=document.getElementById('token-modal');
  const input=document.getElementById('cesium-token-input');
  const saved=localStorage.getItem('cesium_token');
  if (saved) { modal.classList.add('hidden'); initCesium(saved); return; }
  document.getElementById('token-submit-btn').addEventListener('click',()=>{
    const t=input.value.trim(); if(!t) return;
    localStorage.setItem('cesium_token',t);
    modal.classList.add('hidden'); initCesium(t);
  });
  document.getElementById('token-skip-btn').addEventListener('click',()=>{
    modal.classList.add('hidden');
    initCesium('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlYWE1OWUxNy1mMWZiLTQzYjYtYTQ0OS1kMWFjYmFkNTc5YzMiLCJpZCI6NTc3MzMsImlhdCI6MTYyNzg0NTE4Mn0.XcKpgANiY19MC4bdFd3AJblJKnSqyDBCSSnaliD7kCY');
  });
  input.addEventListener('keydown',e=>{if(e.key==='Enter') document.getElementById('token-submit-btn').click();});
}

async function initCesium(token) {
  Cesium.Ion.defaultAccessToken = token;
  // Show token status in topbar
  const tokenIndicator = document.getElementById('token-status');
  const isDefault = token.startsWith('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlYWE1');
  if (tokenIndicator) {
    tokenIndicator.textContent = isDefault ? '⚠ DEFAULT TOKEN' : '✓ CESIUM TOKEN';
    tokenIndicator.style.color = isDefault ? 'var(--amber)' : 'var(--green)';
    tokenIndicator.title = isDefault ? 'Using limited default token. Enter your own at ion.cesium.com for full features.' : 'Custom Cesium Ion token active';
  }
  const terrainProvider = await Cesium.createWorldTerrainAsync().catch(()=>undefined);
  S.viewer = new Cesium.Viewer('cesiumContainer',{
    terrainProvider, imageryProvider:false, baseLayerPicker:false,
    geocoder:false, homeButton:false, sceneModePicker:false,
    navigationHelpButton:false, animation:false, timeline:false,
    fullscreenButton:false, infoBox:false, selectionIndicator:false,
    shadows:false, creditContainer:document.createElement('div'),
  });
  const scene=S.viewer.scene;
  scene.globe.enableLighting=true;
  scene.globe.atmosphereLightIntensity=10.0;
  try {
    const ts=await Cesium.Cesium3DTileset.fromIonAssetId(2275207,{maximumScreenSpaceError:16});
    scene.primitives.add(ts);
    addLog('GOOGLE 3D TILES ONLINE');
  } catch { await loadFallback(); }
  S.viewer.camera.setView({
    destination:Cesium.Cartesian3.fromDegrees(0,20,18000000),
    orientation:{heading:0,pitch:Cesium.Math.toRadians(-90),roll:0},
  });
  S.viewer.screenSpaceEventHandler.setInputAction(onGlobeClick,Cesium.ScreenSpaceEventType.LEFT_CLICK);
  S.viewer.screenSpaceEventHandler.setInputAction(e=>{
    const p=S.viewer.scene.pick(e.position);
    if(p?.id?.properties) lockTrack(p.id);
  },Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  S.viewer.camera.changed.addEventListener(updateCoords);
  updateCoords();
  addLog('ARGUS v6.3 ONLINE');
  loadSatellites();
}

async function loadFallback() {
  try { const p=await Cesium.IonImageryProvider.fromAssetId(3); S.viewer.imageryLayers.addImageryProvider(p); } catch{}
  try { const o=await Cesium.createOsmBuildingsAsync(); S.viewer.scene.primitives.add(o); } catch{}
}

// ── SATELLITES ────────────────────────────────────────────────────────────────
async function loadSatellites() {
  addLog('FETCHING TLE DATA...');
  let all=[];
  for (const g of ['space-stations','visual','active','starlink']) {
    try {
      const r=await fetch(`/api/tle/${encodeURIComponent(g)}`);
      if(r.ok){ const t=await r.text(); all=all.concat(parseTLE(t)); }
    } catch{}
  }
  if(!all.length) {
    showToast('TLE: No satellite data received', 'warn');
    return;
  }
  const seen=new Set();
  S.tleData=all.filter(s=>{if(seen.has(s.name))return false;seen.add(s.name);return true;});
  document.getElementById('sat-count').textContent=S.tleData.length;
  addLog(`${S.tleData.length} SATELLITES ACQUIRED`);
  renderSatellites();
  S.intervals.sat=setInterval(renderSatellites,CONFIG.satelliteUpdateInterval);
}

function parseTLE(txt) {
  const lines=txt.trim().split('\n').map(l=>l.trim()).filter(Boolean);
  const out=[];
  for(let i=0;i<lines.length-2;i+=3)
    if(lines[i+1]?.startsWith('1 ')&&lines[i+2]?.startsWith('2 '))
      out.push({name:lines[i].replace(/^0 /,''),tle1:lines[i+1],tle2:lines[i+2]});
  return out;
}



function renderSatellites() {
  if(!S.layers.satellites.on||!S.viewer) return;
  if(S.layers.satellites.ds) S.viewer.dataSources.remove(S.layers.satellites.ds,true);
  const ds=new Cesium.CustomDataSource('satellites');
  const full=S.detMode==='full';
  const now=new Date();
  const limit=Math.min(S.tleData.length,2000);
  for(let i=0;i<limit;i++){
    const sat=S.tleData[i];
    try{
      const pos=propagate(sat.tle1,sat.tle2,now);
      if(!pos) continue;
      ds.entities.add({
        id:`sat_${i}`,name:sat.name,
        position:Cesium.Cartesian3.fromDegrees(pos.lng,pos.lat,pos.alt*1000),
        point:{pixelSize:2.5,color:Cesium.Color.fromCssColorString('#00ff88').withAlpha(0.9),
          outlineColor:Cesium.Color.BLACK,outlineWidth:1,
          scaleByDistance:new Cesium.NearFarScalar(1.5e6,1.5,1.5e8,0.6)},
        label:full?{text:sat.name.substring(0,14),font:'9px Share Tech Mono',
          fillColor:Cesium.Color.fromCssColorString('#00ff88').withAlpha(0.8),
          outlineColor:Cesium.Color.BLACK,outlineWidth:2,style:Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:new Cesium.Cartesian2(8,0),translucencyByDistance:new Cesium.NearFarScalar(1.5e7,1,1e8,0)
        }:undefined,
        properties:{type:'satellite',data:sat,pos},
      });
    } catch{}
  }
  S.viewer.dataSources.add(ds);
  S.layers.satellites.ds=ds;
}

function propagate(tle1,tle2,date) {
  try{
    const ey=parseInt(tle1.substring(18,20)),ed=parseFloat(tle1.substring(20,32));
    const fy=ey<57?2000+ey:1900+ey;
    const ep=new Date(fy,0,1); ep.setTime(ep.getTime()+(ed-1)*86400000);
    const inc=parseFloat(tle2.substring(8,16))*Math.PI/180;
    const raan=parseFloat(tle2.substring(17,25))*Math.PI/180;
    const ecc=parseFloat('0.'+tle2.substring(26,33));
    const argp=parseFloat(tle2.substring(34,42))*Math.PI/180;
    const mm=parseFloat(tle2.substring(52,63));
    const n=mm*2*Math.PI/86400,a=Math.pow(398600.4418/(n*n),1/3);
    const dt=(date-ep)/1000;
    let M=(parseFloat(tle2.substring(43,51))*Math.PI/180)+n*dt; M=M%(2*Math.PI);
    let E=M; for(let j=0;j<6;j++) E=M+ecc*Math.sin(E);
    const nu=2*Math.atan2(Math.sqrt(1+ecc)*Math.sin(E/2),Math.sqrt(1-ecc)*Math.cos(E/2));
    const r=a*(1-ecc*Math.cos(E));
    const xo=r*Math.cos(nu),yo=r*Math.sin(nu);
    const cR=Math.cos(raan),sR=Math.sin(raan),cI=Math.cos(inc),sI=Math.sin(inc),cA=Math.cos(argp),sA=Math.sin(argp);
    const x=(cR*cA-sR*sA*cI)*xo+(-cR*sA-sR*cA*cI)*yo;
    const y=(sR*cA+cR*sA*cI)*xo+(-sR*sA+cR*cA*cI)*yo;
    const z=(sA*sI)*xo+(cA*sI)*yo;
    const gmst=(()=>{const jd=date.getTime()/86400000+2440587.5,T=(jd-2451545)/36525;return((280.46061837+360.98564736629*(jd-2451545)+T*T*(0.000387933-T/38710000))%360)*Math.PI/180;})();
    const lng=Math.atan2(y,x)-gmst,lat=Math.atan2(z,Math.sqrt(x*x+y*y));
    return{lat:lat*180/Math.PI,lng:((lng*180/Math.PI)%360+540)%360-180,alt:Math.max(r-6371,100)};
  } catch{return null;}
}

// ── FLIGHTS ───────────────────────────────────────────────────────────────────
async function loadFlights(mil=false) {
  const key=mil?'military':'flights';
  addLog(`FETCHING ${mil?'MILITARY':'COMMERCIAL'} FLIGHTS...`);
  try{
    // Pass camera position to server so adsb.lol can do a lat/lon/dist query
    let flightUrl = mil ? '/api/flights/military' : '/api/flights/opensky';
    if (!mil && S.viewer) {
      try {
        const cam = S.viewer.camera.positionCartographic;
        const lat = Cesium.Math.toDegrees(cam.latitude).toFixed(2);
        const lon = Cesium.Math.toDegrees(cam.longitude).toFixed(2);
        const altKm = cam.height / 1000;
        // dist in NM: scale with altitude, capped at 250nm
        const dist = Math.min(250, Math.max(50, Math.round(altKm * 0.05)));
        flightUrl = `/api/flights/opensky?lat=${lat}&lon=${lon}&dist=${dist}`;
      } catch {}
    }
    const r=await fetch(flightUrl);
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const data=await r.json();
    const states=data.states||[];
    if(mil) S.rawMilitary=states; else S.rawFlights=states;
    if(!mil&&states.length){
      const callsigns=[...new Set(states.map(s=>(s[1]||'').trim()).filter(Boolean))];
      const unknown=callsigns.filter(c=>!(c in S.airlineMap));
      if(unknown.length){
        try{
          const ar=await fetch('/api/flights/airlines',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callsigns:unknown.slice(0,500)})});
          if(ar.ok) Object.assign(S.airlineMap,await ar.json());
        } catch{}
      }
    }
    applyFlightFilters(mil);
  } catch(e){
    const msg = e.message||'unknown error';
    console.warn(`[ARGUS] ${mil?'Military':'Flights'} fetch failed:`, msg);
    addLog(`${mil?'MIL':'CIVIL'}: ${msg.substring(0,28)}`);
    showToast(`${mil?'Military':'Flights'}: ${msg.substring(0,40)}`, 'warn');
    if(mil) S.rawMilitary=[]; else S.rawFlights=[];
    applyFlightFilters(mil);
  }
}

function refreshFlightsBbox(bbox,lod,mil=false){ loadFlights(mil); }

function applyFlightFilters(mil=false){
  const raw=mil?S.rawMilitary:S.rawFlights;
  const f=S.filters.flights;
  const filtered=raw.filter(s=>{
    if(!s||s[5]==null||s[6]==null) return false;
    const alt=+(s[13]||s[7]||0),spd=+(s[9]||0),cs=(s[1]||'').trim(),cty=(s[2]||'');
    if(alt<f.minAlt||alt>f.maxAlt) return false;
    if(spd<f.minSpd||spd>f.maxSpd) return false;
    if(f.country&&!cty.toLowerCase().includes(f.country.toLowerCase())) return false;
    if(f.callsign&&!cs.toLowerCase().includes(f.callsign.toLowerCase())) return false;
    if(!f.showUnknown&&!cs) return false;
    return true;
  });
  renderFlights(filtered,mil);
}

function renderFlights(states, mil=false) {
  if (!S.viewer) return;
  const key = mil ? 'military' : 'flights';
  if (S.layers[key].ds) S.viewer.dataSources.remove(S.layers[key].ds, true);
  const ds = new Cesium.CustomDataSource(key);
  const full = S.detMode === 'full';

  for (const s of states) {
    if (!s || s[5] == null || s[6] == null) continue;
    const lon = +s[5], lat = +s[6];
    const altM = +(s[13] || s[7] || 0);
    if (isNaN(lon) || isNaN(lat)) continue;
    const icao = s[0] || '';
    const cs   = (s[1] || icao || 'UNKN').trim() || 'UNKN';
    const onGround  = s[8] === true || altM < 50;
    const trackDeg  = +(s[10] || 0);
    const spdKt     = Math.round(+(s[9] || 0) * 1.944);
    const altFt     = Math.round(altM * 3.28084);
    const color     = altitudeColor(altM, onGround);
    const cat       = getAircraftCategory(cs, mil, s[17]);
    const iconSize  = cat === 'heli' ? 20 : mil ? 22 : 20;
    const cesColor  = Cesium.Color.fromCssColorString(color);
    const airline   = S.airlineMap[cs];
    const renderAlt = onGround ? 10 : Math.max(altM, 100);

    // Trail
    if (!S._flightTrails) S._flightTrails = new Map();
    if (!S._flightTrails.has(icao)) S._flightTrails.set(icao, []);
    const trail = S._flightTrails.get(icao);
    trail.push([lon, lat, renderAlt]);
    if (trail.length > 8) trail.shift();

    if (trail.length >= 2) {
      ds.entities.add({
        id: `${key}_trail_${icao}`,
        polyline: {
          positions: trail.map(p => Cesium.Cartesian3.fromDegrees(p[0], p[1], p[2])),
          width: 1.5,
          material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.05, color: cesColor.withAlpha(0.45) }),
          arcType: Cesium.ArcType.NONE,
          clampToGround: onGround,
        },
      });
    }

    const labelText = full
      ? [cs, airline ? airline.name.substring(0,16) : '', `${altFt.toLocaleString()}ft  ${spdKt}kt`].filter(Boolean).join('\n')
      : cs + '\n' + (onGround ? 'GND' : Math.round(altFt/100)*100 + 'ft');

    ds.entities.add({
      id: `${key}_${icao}`,
      name: cs,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, renderAlt),
      billboard: {
        image: planeIcon(color, cat, iconSize),
        width: iconSize, height: iconSize,
        rotation: Cesium.Math.toRadians(-trackDeg),
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        scaleByDistance:        new Cesium.NearFarScalar(5e3, 1.6, 8e6, 0.5),
        translucencyByDistance: new Cesium.NearFarScalar(5e5, 1, 1e7, 0.1),
        disableDepthTestDistance: onGround ? 0 : Number.POSITIVE_INFINITY,
      },
      label: {
        text: labelText,
        font: '9px Share Tech Mono',
        fillColor: cesColor,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(iconSize/2 + 4, 0),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        translucencyByDistance: new Cesium.NearFarScalar(full ? 2e5 : 5e4, 1, full ? 8e6 : 3e6, 0),
        showBackground: true,
        backgroundColor: Cesium.Color.fromBytes(0, 0, 0, 160),
        backgroundPadding: new Cesium.Cartesian2(4, 3),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: { type: mil ? 'military' : 'flight', data: s, airline },
    });
  }
  S.viewer.dataSources.add(ds);
  S.layers[key].ds = ds;
  document.getElementById(mil ? 'mil-count' : 'flight-count').textContent = states.length;
  addLog(`${states.length} ${mil ? 'MIL' : 'CIVIL'} FLIGHTS`);
  if (!mil) updateFilterStats(states);
}

function updateFilterStats(states){
  const c=[...new Set(states.map(s=>(s[2]||'').trim()).filter(Boolean))];
  const a=[...new Set(states.map(s=>S.airlineMap[(s[1]||'').trim()]?.name).filter(Boolean))];
  const el=document.getElementById('filter-stats');
  if(el) el.textContent=`${states.length} ac · ${c.length} countries · ${a.length} airlines`;
}

// ── QUAKES ────────────────────────────────────────────────────────────────────
async function loadQuakes(){
  try{
    const r=await fetch('/api/quakes'); if(!r.ok) throw new Error();
    renderQuakes((await r.json()).features||[]);
  } catch{renderQuakes([]);}
}

function renderQuakes(features){
  if(!S.viewer) return;
  if(S.layers.quakes.ds) S.viewer.dataSources.remove(S.layers.quakes.ds,true);
  const ds=new Cesium.CustomDataSource('quakes'); let cnt=0;
  for(const f of features){
    const [lon,lat]=f.geometry.coordinates,mag=f.properties.mag||0;
    if(mag<1) continue;
    const col=mag>=6?'#ff2222':mag>=4?'#ff8800':'#ffdd00';
    const sz=Math.max(4,mag*4);
    ds.entities.add({
      id:`quake_${f.id}`,name:`M${mag.toFixed(1)} — ${f.properties.place||''}`,
      position:Cesium.Cartesian3.fromDegrees(lon,lat,0),
      point:{pixelSize:sz,color:Cesium.Color.fromCssColorString(col).withAlpha(0.8),
        outlineColor:Cesium.Color.fromCssColorString(col).withAlpha(0.3),outlineWidth:sz*0.6,
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance:Number.POSITIVE_INFINITY},
      label:S.detMode==='full'?{text:`M${mag.toFixed(1)}`,font:'9px Share Tech Mono',
        fillColor:Cesium.Color.fromCssColorString(col),
        outlineColor:Cesium.Color.BLACK,outlineWidth:2,style:Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset:new Cesium.Cartesian2(0,-sz-4),
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND}:undefined,
      properties:{type:'quake',data:f.properties},
    }); cnt++;
  }
  S.viewer.dataSources.add(ds); S.layers.quakes.ds=ds;
  document.getElementById('quake-count').textContent=cnt;
  addLog(`${cnt} SEISMIC EVENTS`);
}

// ── SEISMIC STATIONS ──────────────────────────────────────────────────────────
async function loadSeismicStations(){
  addLog('FETCHING SEISMIC STATIONS...');
  try{
    const r=await fetch('/api/seismic/stations'); if(!r.ok) throw new Error();
    const data=await r.json();
    renderSeismicStations(data.stations||[]);
  } catch{ addLog('SEISMIC STATIONS: UNAVAILABLE'); showToast('Seismic stations feed unavailable', 'warn'); }
}

function renderSeismicStations(stations){
  if(!S.viewer) return;
  if(S.layers.sensors.ds) S.viewer.dataSources.remove(S.layers.sensors.ds,true);
  const ds=new Cesium.CustomDataSource('sensors');
  for(const st of stations){
    if(!st.lat||!st.lon) continue;
    ds.entities.add({
      id:`sensor_${st.id}`,name:`${st.network}.${st.code} — ${st.name}`,
      position:Cesium.Cartesian3.fromDegrees(st.lon,st.lat,st.elev||0),
      billboard:{
        image:stationIcon(),width:16,height:16,
        scaleByDistance:new Cesium.NearFarScalar(1e4,1.5,1e7,0.7),
        translucencyByDistance:new Cesium.NearFarScalar(5e5,1,5e6,0.1),
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance:Number.POSITIVE_INFINITY,
      },
      label:S.detMode==='full'?{
        text:`${st.network}.${st.code}`,font:'8px Share Tech Mono',
        fillColor:Cesium.Color.fromCssColorString('#00ddff'),
        outlineColor:Cesium.Color.BLACK,outlineWidth:2,style:Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset:new Cesium.Cartesian2(10,0),
        translucencyByDistance:new Cesium.NearFarScalar(5e5,1,5e6,0),
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
      }:undefined,
      properties:{type:'sensor',data:st},
    });
  }
  S.viewer.dataSources.add(ds); S.layers.sensors.ds=ds;
  document.getElementById('sensor-count').textContent=stations.length;
  addLog(`${stations.length} SEISMIC STATIONS`);
}

// ── GPS JAMMING ───────────────────────────────────────────────────────────────
async function loadGpsJam(){
  addLog('FETCHING GPS JAMMING...');
  try{
    const r=await fetch('/api/gpsjam'); if(!r.ok) throw new Error(`HTTP ${r.status}`);
    renderGpsJam(await r.json());
  } catch(e){ addLog(`GPSJAM: ${e.message.substring(0,25)}`); showToast(`GPS Jamming feed unavailable`, 'warn'); }
}

function renderGpsJam(geojson){
  if(!S.viewer) return;
  if(S.layers.gpsjam.ds) S.viewer.dataSources.remove(S.layers.gpsjam.ds,true);
  const ds=new Cesium.CustomDataSource('gpsjam');
  const features=geojson.features||[]; let cnt=0;
  for(const f of features){
    const coords=f.geometry?.coordinates;
    if(!coords||!isFinite(coords[0])||!isFinite(coords[1])) continue;
    const [lon,lat]=coords;
    const level=f.properties?.level||1;
    if(level<1) continue;
    const label=f.properties?.label||f.properties?.name||`Zone ${cnt+1}`;
    const hex=level>=3?'#ff2222':level>=2?'#ff8800':'#ffdd00';
    const color=Cesium.Color.fromCssColorString(hex);
    ds.entities.add({
      id:`jam_${cnt}`,name:`GPS JAM L${level}: ${label}`,
      position:Cesium.Cartesian3.fromDegrees(lon,lat,500),
      ellipse:{
        semiMajorAxis:level*90000,semiMinorAxis:level*90000,
        material:color.withAlpha(0.12),outline:true,
        outlineColor:color.withAlpha(0.7),outlineWidth:1,
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
      },
      point:{pixelSize:level>=3?8:level>=2?6:4,color:color.withAlpha(0.95),
        outlineColor:Cesium.Color.BLACK,outlineWidth:1,
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance:Number.POSITIVE_INFINITY,
        scaleByDistance:new Cesium.NearFarScalar(1e4,2,1e7,1)},
      label:{text:`⚡L${level} ${label.substring(0,14)}`,font:'9px Share Tech Mono',
        fillColor:color,outlineColor:Cesium.Color.BLACK,outlineWidth:2,
        style:Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset:new Cesium.Cartesian2(0,-16),
        horizontalOrigin:Cesium.HorizontalOrigin.CENTER,
        verticalOrigin:Cesium.VerticalOrigin.BOTTOM,
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
        translucencyByDistance:new Cesium.NearFarScalar(5e4,1,8e6,0.1),
        showBackground:true,backgroundColor:Cesium.Color.BLACK.withAlpha(0.65),
        backgroundPadding:new Cesium.Cartesian2(4,3),
        disableDepthTestDistance:Number.POSITIVE_INFINITY},
      properties:{type:'gpsjam',level,label},
    }); cnt++;
  }
  S.viewer.dataSources.add(ds); S.layers.gpsjam.ds=ds;
  document.getElementById('jam-count').textContent=cnt;
  addLog(`${cnt} GPS JAM ZONES`);
}

// ── SHIPS ─────────────────────────────────────────────────────────────────────
async function loadShips(){
  addLog('FETCHING AIS DATA...');
  try{
    const r=await fetch('/api/ships'); if(!r.ok) throw new Error(`HTTP ${r.status}`);
    renderShips(await r.json());
  } catch(e){
    console.warn('[ARGUS] Ships fetch failed:', e.message);
    addLog(`AIS: ${e.message.substring(0,25)}`);
    showToast(`AIS vessels: ${e.message.substring(0,40)}`, 'warn');
    renderShips([]);
  }
}

async function refreshShipsBbox(bbox){
  if(!bbox){loadShips();return;}
  try{
    const pad=2;
    const r=await fetch(`/api/ships?minLat=${(bbox.minLat-pad).toFixed(2)}&maxLat=${(bbox.maxLat+pad).toFixed(2)}&minLon=${(bbox.minLon-pad).toFixed(2)}&maxLon=${(bbox.maxLon+pad).toFixed(2)}`);
    if(!r.ok) throw new Error();
    renderShips(await r.json());
  } catch{loadShips();}
}

function renderShips(ships) {
  if (!S.viewer) return;
  if (S.layers.ships.ds) S.viewer.dataSources.remove(S.layers.ships.ds, true);
  const ds = new Cesium.CustomDataSource('ships');
  const full = S.detMode === 'full';

  for (const s of ships) {
    if (!s.lat || !s.lon) continue;
    const sog   = +(s.sog  || 0);
    const cog   = +(s.cog  || 0);
    const type  = +(s.type || 0);
    const name  = (s.name || String(s.mmsi) || 'UNKNOWN').substring(0, 20).trim();
    const mmsi  = String(s.mmsi || '');
    const color = shipTypeColor(type);
    const cesColor = Cesium.Color.fromCssColorString(color);

    if (!S._shipTrails) S._shipTrails = new Map();
    if (!S._shipTrails.has(mmsi)) S._shipTrails.set(mmsi, []);
    const trail = S._shipTrails.get(mmsi);
    trail.push([s.lon, s.lat]);
    if (trail.length > 6) trail.shift();

    if (trail.length >= 2) {
      ds.entities.add({
        id: `ship_trail_${mmsi}`,
        polyline: {
          positions: trail.map(p => Cesium.Cartesian3.fromDegrees(p[0], p[1], 5)),
          width: 1.2,
          material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.05, color: cesColor.withAlpha(0.4) }),
          clampToGround: true,
        },
      });
    }

    const typeLabel = type>=80?'TANKER':type>=70?'CARGO':type>=60?'PASS.':type>=50?'HSC':type>=30?'FISHING':'VESSEL';
    const labelText = full
      ? [name, `${typeLabel}  ${sog.toFixed(1)}kt`, s.dest||''].filter(Boolean).join('\n')
      : name + '\n' + sog.toFixed(1) + 'kt';

    ds.entities.add({
      id: `ship_${mmsi}`,
      name,
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 8),
      billboard: {
        image: shipIcon(color, type),
        width: 20, height: 22,
        rotation: Cesium.Math.toRadians(-cog),
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        scaleByDistance:        new Cesium.NearFarScalar(1e3, 2, 5e6, 0.55),
        translucencyByDistance: new Cesium.NearFarScalar(3e5, 1, 3e6, 0.1),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: labelText,
        font: '9px Share Tech Mono',
        fillColor: cesColor,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(14, 0),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        translucencyByDistance: new Cesium.NearFarScalar(3e4, 1, 8e5, 0),
        showBackground: true,
        backgroundColor: Cesium.Color.fromBytes(0, 0, 0, 155),
        backgroundPadding: new Cesium.Cartesian2(4, 3),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: { type: 'ship', data: s },
    });
  }
  S.viewer.dataSources.add(ds);
  S.layers.ships.ds = ds;
  document.getElementById('ship-count').textContent = ships.length;
  addLog(`${ships.length} VESSELS`);
}


// ── CCTV ──────────────────────────────────────────────────────────────────────
async function loadCctv(bbox){
  let lat,lon;
  if(bbox){lat=bbox.centerLat;lon=bbox.centerLon;}
  else{
    const cam=S.viewer.camera.positionCartographic;
    lat=Cesium.Math.toDegrees(cam.latitude);lon=Cesium.Math.toDegrees(cam.longitude);
  }
  addLog('FETCHING CCTV...');
  try{
    const r=await fetch(`/api/cctv?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radius=${CONFIG.cctvRadius}`);
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    renderCctv(await r.json());
  } catch(e){addLog(`CCTV: ${e.message.substring(0,25)}`);}
}

function renderCctv(cameras){
  if(!S.viewer) return;
  if(S.layers.cctv.ds) S.viewer.dataSources.remove(S.layers.cctv.ds,true);
  const ds=new Cesium.CustomDataSource('cctv');
  for(const c of cameras){
    ds.entities.add({
      id:`cctv_${c.id}`,name:`CCTV ${c.type||'Camera'}`,
      position:Cesium.Cartesian3.fromDegrees(c.lon,c.lat,5),
      billboard:{image:cctvIcon(),width:14,height:14,
        scaleByDistance:new Cesium.NearFarScalar(100,2,5e4,0.8),
        translucencyByDistance:new Cesium.NearFarScalar(1e4,1,5e4,0),
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND},
      label:{text:`📷 ${(c.operator||c.type||'CCTV').substring(0,12)}`,font:'8px Share Tech Mono',
        fillColor:Cesium.Color.fromCssColorString('#ff6600'),
        outlineColor:Cesium.Color.BLACK,outlineWidth:2,style:Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset:new Cesium.Cartesian2(10,0),horizontalOrigin:Cesium.HorizontalOrigin.LEFT,
        translucencyByDistance:new Cesium.NearFarScalar(500,1,5000,0),
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
        showBackground:true,backgroundColor:Cesium.Color.BLACK.withAlpha(0.55),
        backgroundPadding:new Cesium.Cartesian2(3,2)},
      properties:{type:'cctv',data:c},
    });
  }
  S.viewer.dataSources.add(ds); S.layers.cctv.ds=ds;
  document.getElementById('cctv-count').textContent=cameras.length;
  addLog(`${cameras.length} CCTV NODES`);
}

// ── MESHTASTIC ────────────────────────────────────────────────────────────────
async function loadMeshtastic(){
  addLog('FETCHING MESHTASTIC NODES...');
  try{
    const r=await fetch('/api/meshtastic/nodes'); if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const data=await r.json();
    S.meshtastic.nodes=data.nodes||[];
    renderMeshtastic(S.meshtastic.nodes);
    // Also load recent messages
    const mr=await fetch('/api/meshtastic/messages');
    if(mr.ok){ const md=await mr.json(); S.meshtastic.messages=md.messages||[]; }
    updateMeshPanel();
  } catch(e){ addLog(`MESHTASTIC: ${e.message.substring(0,28)}`); showToast(`Meshtastic: ${e.message.substring(0,40)}`, 'warn'); }
}

function renderMeshtastic(nodes){
  if(!S.viewer) return;
  if(S.layers.meshtastic.ds) S.viewer.dataSources.remove(S.layers.meshtastic.ds,true);
  const ds=new Cesium.CustomDataSource('meshtastic');
  const now=Date.now()/1000;
  for(const n of nodes){
    if(!n.lat||!n.lon) continue;
    const online=n.last_heard&&(now-n.last_heard)<3600;
    ds.entities.add({
      id:`mesh_${n.id}`,name:n.long_name||n.name||n.id,
      position:Cesium.Cartesian3.fromDegrees(n.lon,n.lat,n.altitude||10),
      billboard:{image:meshIcon(online),width:18,height:18,
        scaleByDistance:new Cesium.NearFarScalar(1e3,1.5,5e6,0.7),
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance:Number.POSITIVE_INFINITY},
      label:{text:`${n.name||n.id}${n.battery!=null?`\n🔋${n.battery}%`:''}`,font:'8px Share Tech Mono',
        fillColor:Cesium.Color.fromCssColorString(online?'#00ff88':'#888888'),
        outlineColor:Cesium.Color.BLACK,outlineWidth:2,style:Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset:new Cesium.Cartesian2(12,0),horizontalOrigin:Cesium.HorizontalOrigin.LEFT,
        translucencyByDistance:new Cesium.NearFarScalar(5e4,1,5e5,0),
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
        showBackground:true,backgroundColor:Cesium.Color.BLACK.withAlpha(0.6),
        backgroundPadding:new Cesium.Cartesian2(3,2)},
      properties:{type:'meshtastic',data:n,online},
    });
  }
  S.viewer.dataSources.add(ds); S.layers.meshtastic.ds=ds;
  const online=nodes.filter(n=>{const now=Date.now()/1000;return n.last_heard&&(now-n.last_heard)<3600;});
  document.getElementById('mesh-count').textContent=nodes.length;
  document.getElementById('mesh-online-count').textContent=`${online.length} / ${nodes.length}`;
  addLog(`${nodes.length} MESHTASTIC NODES`);
}

function updateMeshPanel(){
  const msgs=S.meshtastic.messages.slice(0,15);
  const el=document.getElementById('mesh-messages');
  if(!el) return;
  if(!msgs.length){el.innerHTML='<div class="muted-text" style="padding:4px 0">No recent messages</div>';return;}
  el.innerHTML=msgs.map(m=>`
    <div class="mesh-msg">
      <div class="mesh-msg-node">📡 ${m.from_name||m.from}</div>
      <div class="mesh-msg-text">${escHtml(m.text||'')}</div>
      <div class="mesh-msg-time">${m.ts?new Date(m.ts*1000).toLocaleTimeString('en-GB',{hour12:false}):''}</div>
    </div>`).join('');
}

function showMeshNodeDetail(node){
  document.getElementById('mesh-modal-name').textContent=node.long_name||node.name||node.id;
  const now=Date.now()/1000;
  const online=node.last_heard&&(now-node.last_heard)<3600;
  document.getElementById('mesh-modal-info').innerHTML=`
    ${dpRow('Node ID',node.id)}
    ${dpRow('Short Name',node.name||'—')}
    ${dpRow('Status',online?'<span style="color:#00ff88">ONLINE</span>':'<span style="color:#888">OFFLINE</span>')}
    ${dpRow('Last Heard',node.last_heard?new Date(node.last_heard*1000).toLocaleString('en-GB'):'—')}
    ${node.battery!=null?dpRow('Battery',`${node.battery}%`):''}
    ${node.hw_model?dpRow('Hardware',node.hw_model):''}
    ${dpRow('Position',`${node.lat?.toFixed(4)}°, ${node.lon?.toFixed(4)}°`)}
    ${node.altitude?dpRow('Altitude',`${node.altitude}m`):''}
    ${node.snr?dpRow('SNR',`${node.snr} dB`):''}
  `;
  // Fetch node messages
  fetch(`/api/meshtastic/messages?node=${encodeURIComponent(node.id)}`)
    .then(r=>r.json()).then(data=>{
      const msgs=data.messages||[];
      const el=document.getElementById('mesh-modal-messages');
      if(!msgs.length){el.innerHTML='<div class="muted-text">No messages for this node</div>';return;}
      el.innerHTML=msgs.map(m=>`
        <div class="mesh-msg">
          <div class="mesh-msg-node">→ ${m.to==='broadcast'?'Broadcast':m.to}</div>
          <div class="mesh-msg-text">${escHtml(m.text||'')}</div>
          <div class="mesh-msg-time">${m.ts?new Date(m.ts*1000).toLocaleString('en-GB'):'—'}</div>
        </div>`).join('');
    }).catch(()=>{});
  document.getElementById('mesh-modal').classList.remove('hidden');
}

function escHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── ROAD TRAFFIC ──────────────────────────────────────────────────────────────
const ROAD_STYLE={motorway:{color:'#ff6666',width:4.5},trunk:{color:'#ff9933',width:4},primary:{color:'#ffcc00',width:3.5},secondary:{color:'#99cc33',width:3},tertiary:{color:'#aaa',width:2},residential:{color:'#888',width:1.5},unclassified:{color:'#777',width:1.2}};

async function loadTraffic(){
  clearTraffic();
  const cam=S.viewer.camera.positionCartographic;
  const lat=Cesium.Math.toDegrees(cam.latitude),lon=Cesium.Math.toDegrees(cam.longitude);
  addLog('LOADING ROAD NETWORK...');
  try{
    const r=await fetch(`/api/osm/roads?lat=${lat}&lon=${lon}&radius=4000`);
    if(!r.ok) throw new Error();
    renderTrafficPolylines((await r.json()).elements||[],lat,lon);
  } catch{renderTrafficPolylines([],lat,lon);}
}

function renderTrafficPolylines(elements,clat,clon){
  if(!S.viewer) return;
  if(S.layers.traffic.polylines) S.viewer.scene.primitives.remove(S.layers.traffic.polylines);
  const coll=new Cesium.PolylineCollection(); let cnt=0;
  for(const el of elements){
    if(el.type!=='way'||!el.geometry||el.geometry.length<2) continue;
    const s=ROAD_STYLE[el.tags?.highway]||ROAD_STYLE.residential;
    coll.add({positions:el.geometry.map(n=>Cesium.Cartesian3.fromDegrees(n.lon,n.lat,2)),width:s.width,material:Cesium.Material.fromType('Color',{color:Cesium.Color.fromCssColorString(s.color).withAlpha(0.85)}),followSurface:true});
    cnt++;
  }
  if(!cnt){
    for(let i=-5;i<=5;i++){
      const s=i%3===0?ROAD_STYLE.primary:ROAD_STYLE.residential,c=Cesium.Color.fromCssColorString(s.color).withAlpha(0.7);
      coll.add({positions:[Cesium.Cartesian3.fromDegrees(clon-0.03,clat+i*0.003,2),Cesium.Cartesian3.fromDegrees(clon+0.03,clat+i*0.003,2)],width:s.width,material:Cesium.Material.fromType('Color',{color:c}),followSurface:true});
      coll.add({positions:[Cesium.Cartesian3.fromDegrees(clon+i*0.003,clat-0.03,2),Cesium.Cartesian3.fromDegrees(clon+i*0.003,clat+0.03,2)],width:s.width,material:Cesium.Material.fromType('Color',{color:c}),followSurface:true});
    } cnt=22;
  }
  S.viewer.scene.primitives.add(coll);
  S.layers.traffic.polylines=coll;
  document.getElementById('traffic-count').textContent=cnt;
  addLog(`${cnt} ROAD SEGMENTS`);
}

function clearTraffic(){
  if(S.layers.traffic.polylines) S.viewer?.scene.primitives.remove(S.layers.traffic.polylines);
  if(S.layers.traffic.ds) S.viewer?.dataSources.remove(S.layers.traffic.ds,true);
  S.layers.traffic.polylines=null; S.layers.traffic.ds=null;
}

// ── NASA GIBS ─────────────────────────────────────────────────────────────────
const GIBS={
  modis_true: {label:'MODIS Terra True Colour',url:'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{Time}/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.jpg',tileMatrixSetID:'GoogleMapsCompatible',format:'image/jpeg',maximumLevel:9},
  viirs_true: {label:'VIIRS True Colour',url:'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/{Time}/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.jpg',tileMatrixSetID:'GoogleMapsCompatible',format:'image/jpeg',maximumLevel:9},
  nightlights:{label:'VIIRS Night Lights',url:'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.jpg',tileMatrixSetID:'GoogleMapsCompatible',format:'image/jpeg',maximumLevel:8},
  sst:        {label:'Sea Surface Temp',url:'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GHRSST_L4_MUR_Sea_Surface_Temperature/default/{Time}/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.png',tileMatrixSetID:'GoogleMapsCompatible',format:'image/png',maximumLevel:7},
  land_temp:  {label:'Land Surface Temp',url:'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_Land_Surface_Temp_Day/default/{Time}/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.png',tileMatrixSetID:'GoogleMapsCompatible',format:'image/png',maximumLevel:7},
  rain_radar: {label:'GPM Rain Rate',url:'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GPM_3IMERGDE_06_precipitationCal/default/{Time}/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.png',tileMatrixSetID:'GoogleMapsCompatible',format:'image/png',maximumLevel:6},
};
let gibsLayer=null;

async function setGibsLayer(key){
  if(!S.viewer) return;
  if(gibsLayer){S.viewer.imageryLayers.remove(gibsLayer,true);gibsLayer=null;}
  if(!key||key==='none'){addLog('SAT IMAGERY OFF');return;}
  const def=GIBS[key]; if(!def) return;
  const d=new Date(); d.setDate(d.getDate()-1);
  const url=def.url.replace('{Time}',d.toISOString().slice(0,10));
  try{
    const p=await Cesium.WebMapTileServiceImageryProvider.fromUrl(url,{layer:key,style:'default',tileMatrixSetID:def.tileMatrixSetID,format:def.format,maximumLevel:def.maximumLevel,credit:new Cesium.Credit('NASA GIBS')});
    gibsLayer=S.viewer.imageryLayers.addImageryProvider(p);
    gibsLayer.alpha=0.82;
    addLog(`SAT: ${def.label}`);
  } catch(e){addLog(`GIBS ERR: ${e.message.substring(0,28)}`);}
}

// ── WEATHER ───────────────────────────────────────────────────────────────────
async function refreshWeather(bbox,lod){
  if(!S.viewer||!bbox) return;
  if(S.layers.weather.ds) S.viewer.dataSources.remove(S.layers.weather.ds,true);
  const ds=new Cesium.CustomDataSource('weather');
  const pts=[];
  if(lod==='GLOBAL'){
    for(let lat=Math.max(-80,Math.round(bbox.minLat/5)*5);lat<=Math.min(80,bbox.maxLat);lat+=5)
      for(let lon=Math.round(bbox.minLon/5)*5;lon<=bbox.maxLon;lon+=5) pts.push({lat,lon});
  } else if(lod==='REGIONAL'){
    for(let lat=Math.round(bbox.minLat/2)*2;lat<=bbox.maxLat;lat+=2)
      for(let lon=Math.round(bbox.minLon/2)*2;lon<=bbox.maxLon;lon+=2) pts.push({lat,lon});
  } else pts.push({lat:bbox.centerLat,lon:bbox.centerLon,detail:true});

  let cnt=0;
  await Promise.all(pts.slice(0,25).map(async({lat,lon,detail})=>{
    const vars=detail?'temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,visibility,uv_index,cloud_cover':'temperature_2m,weather_code,wind_speed_10m';
    try{
      const r=await fetch(`/api/weather?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&vars=${vars}`);
      if(!r.ok) return;
      const d=await r.json(); if(!d.current) return;
      const cur=d.current,temp=cur.temperature_2m??'?';
      const label=detail
        ?`${weatherEmoji(cur.weather_code??0)} ${temp}°C  💨${cur.wind_speed_10m??'?'}km/h\n💧${cur.relative_humidity_2m??'?'}%  ☁${cur.cloud_cover??'?'}%\n👁${((cur.visibility??10000)/1000).toFixed(1)}km  UV:${cur.uv_index??'?'}`
        :`${weatherEmoji(cur.weather_code??0)}${Math.round(temp)}°`;
      ds.entities.add({
        id:`wx_${lat.toFixed(1)}_${lon.toFixed(1)}`,
        position:Cesium.Cartesian3.fromDegrees(lon,lat,500),
        label:{text:label,font:detail?'10px Share Tech Mono':'9px Share Tech Mono',
          fillColor:Cesium.Color.fromCssColorString(tempColor(temp)),
          outlineColor:Cesium.Color.BLACK,outlineWidth:2,style:Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground:true,backgroundColor:Cesium.Color.BLACK.withAlpha(0.65),
          backgroundPadding:new Cesium.Cartesian2(4,3),
          translucencyByDistance:new Cesium.NearFarScalar(1e5,1,8e6,0.3),
          scaleByDistance:new Cesium.NearFarScalar(1e4,1.2,5e6,0.6),
          horizontalOrigin:Cesium.HorizontalOrigin.CENTER,verticalOrigin:Cesium.VerticalOrigin.BOTTOM,
          heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance:Number.POSITIVE_INFINITY},
        properties:{type:'weather',data:cur,lat,lon},
      }); cnt++;
    } catch{}
  }));
  S.viewer.dataSources.add(ds); S.layers.weather.ds=ds;
  document.getElementById('weather-count').textContent=cnt;
  addLog(`WEATHER: ${cnt} NODES`);
}

function weatherEmoji(c){if(c===0)return'☀️';if(c<=3)return'⛅';if(c<=48)return'🌫️';if(c<=67)return'🌧️';if(c<=77)return'❄️';if(c<=82)return'🌦️';return'⛈️';}
function tempColor(c){if(c<-20)return'#88aaff';if(c<0)return'#aaccff';if(c<10)return'#88ffee';if(c<20)return'#aaffaa';if(c<30)return'#ffee44';if(c<40)return'#ff8800';return'#ff2222';}

// ── WILDFIRES ─────────────────────────────────────────────────────────────────
async function refreshWildfires(bbox){
  if(!S.viewer||!bbox) return;
  if(S.layers.wildfires.ds) S.viewer.dataSources.remove(S.layers.wildfires.ds,true);
  try{
    const r=await fetch(`/api/wildfires?minLat=${bbox.minLat.toFixed(2)}&maxLat=${bbox.maxLat.toFixed(2)}&minLon=${bbox.minLon.toFixed(2)}&maxLon=${bbox.maxLon.toFixed(2)}`);
    if(!r.ok) throw new Error();
    renderWildfires(await r.json());
  } catch{ addLog('FIRMS: UNAVAILABLE'); showToast('Active fires: FIRMS feed unavailable', 'warn'); }
}

function renderWildfires(fires){
  if(!S.viewer) return;
  const ds=new Cesium.CustomDataSource('wildfires');
  for(const f of fires){
    const frp=f.frp||0,size=Math.min(12,4+frp/20);
    const col=frp>500?'#ff0000':frp>100?'#ff5500':'#ff9900';
    ds.entities.add({
      id:`fire_${f.lat}_${f.lon}`,name:`Active Fire — ${f.acq_date||''}`,
      position:Cesium.Cartesian3.fromDegrees(f.lon,f.lat,100),
      point:{pixelSize:size,color:Cesium.Color.fromCssColorString(col).withAlpha(0.9),
        outlineColor:Cesium.Color.YELLOW.withAlpha(0.5),outlineWidth:2,
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
        scaleByDistance:new Cesium.NearFarScalar(1e3,2,5e6,0.5)},
      label:{text:`🔥 ${Math.round(frp)}MW\n${f.acq_date||''}`,font:'8px Share Tech Mono',
        fillColor:Cesium.Color.fromCssColorString(col),
        outlineColor:Cesium.Color.BLACK,outlineWidth:2,style:Cesium.LabelStyle.FILL_AND_OUTLINE,
        translucencyByDistance:new Cesium.NearFarScalar(5e3,1,1e6,0),
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
        showBackground:true,backgroundColor:Cesium.Color.BLACK.withAlpha(0.65),
        backgroundPadding:new Cesium.Cartesian2(3,2),pixelOffset:new Cesium.Cartesian2(14,0)},
      properties:{type:'fire',data:f},
    });
  }
  S.viewer.dataSources.add(ds); S.layers.wildfires.ds=ds;
  document.getElementById('fire-count').textContent=fires.length;
  addLog(`FIRMS: ${fires.length} ACTIVE FIRES`);
}

// ── SHODAN ────────────────────────────────────────────────────────────────────
async function loadShodanPresets(){
  try{
    const r=await fetch('/api/shodan/presets');const d=await r.json();
    const sel=document.getElementById('shodan-preset-select');
    if(sel) d.presets.forEach(p=>{const o=document.createElement('option');o.value=p.query;o.textContent=p.label;sel.appendChild(o);});
    sel?.addEventListener('change',()=>{const qi=document.getElementById('shodan-query-input');if(qi&&sel.value)qi.value=sel.value;});
  } catch{}
}

async function executeShodanSearch(){
  const localKey=S.shodan.key||localStorage.getItem('shodan_key')||'';
  const serverHasKey = serverStatus.shodan;
  const query=document.getElementById('shodan-query-input')?.value?.trim();
  if(!query){addLog('SHODAN: NO QUERY');return;}
  if(!localKey && !serverHasKey){
    addLog('SHODAN: NO API KEY');
    document.getElementById('shodan-key-prompt').style.display='block';
    return;
  }
  const btn=document.getElementById('shodan-search-btn');
  if(btn){btn.disabled=true;btn.textContent='Scanning...';}
  addLog(`SHODAN: ${query.substring(0,28)}`);
  const headers={'Content-Type':'application/json'};
  if(localKey) headers['x-shodan-key']=localKey;  // only send if user provided one locally
  try{
    const r=await fetch('/api/shodan/search',{method:'POST',headers,body:JSON.stringify({query})});
    const data=await r.json(); if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
    renderShodanLayer(data.results);
    document.getElementById('shodan-result-count').textContent=`${data.results.length} / ${data.total?.toLocaleString()||'?'} results`;
    addLog(`SHODAN: ${data.results.length} DEVICES`);
    refreshShodanCredits();
  } catch(e){addLog(`SHODAN: ${e.message.substring(0,35)}`);}
  finally{if(btn){btn.disabled=false;btn.textContent='▶ Execute Scan';}}
}

function renderShodanLayer(devices){
  if(!S.viewer) return;
  if(S.layers.shodan.ds) S.viewer.dataSources.remove(S.layers.shodan.ds,true);
  const ds=new Cesium.CustomDataSource('shodan');
  for(const d of devices){
    if(!d.lat||!d.lon) continue;
    const hv=d.vulns?.length>0;
    const color=Cesium.Color.fromCssColorString(hv?'#ff2222':'#ff00ff').withAlpha(0.9);
    ds.entities.add({
      id:`shodan_${d.ip}`,name:d.ip,
      position:Cesium.Cartesian3.fromDegrees(d.lon,d.lat,100),
      point:{pixelSize:hv?7:5,color,outlineColor:color.withAlpha(0.3),outlineWidth:hv?4:2,
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
        scaleByDistance:new Cesium.NearFarScalar(1e3,2,5e5,1)},
      label:S.detMode==='full'?{text:`${d.ip}\n${d.product||d.port}`,font:'8px Share Tech Mono',
        fillColor:color,outlineColor:Cesium.Color.BLACK,outlineWidth:2,style:Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset:new Cesium.Cartesian2(8,0),
        translucencyByDistance:new Cesium.NearFarScalar(1e4,1,5e5,0),
        heightReference:Cesium.HeightReference.CLAMP_TO_GROUND}:undefined,
      properties:{type:'shodan',data:d},
    });
  }
  S.viewer.dataSources.add(ds); S.layers.shodan.ds=ds; S.layers.shodan.on=true;
  document.getElementById('shodan-count').textContent=devices.length;
}

function clearShodanLayer(){
  if(S.layers.shodan.ds) S.viewer?.dataSources.remove(S.layers.shodan.ds,true);
  S.layers.shodan.ds=null;S.layers.shodan.on=false;
  document.getElementById('shodan-count').textContent='0';
}

async function refreshShodanCredits(){
  const key=S.shodan.key||localStorage.getItem('shodan_key')||'';
  try{
    const headers=key?{'x-shodan-key':key}:{};
    const r=await fetch('/api/shodan/credits',{headers});
    const d=await r.json(); updateCreditDisplay(d);
  } catch{}
}

function updateCreditDisplay(d){
  const el=document.getElementById('shodan-credit-display'); if(!el) return;
  if(!d.configured){el.innerHTML='<span class="muted-text">No key configured</span>';return;}
  const q24=d.local?.last_24h?.q||0,c24=d.local?.last_24h?.c||0,acct=d.account;
  el.innerHTML=`
    <div class="credit-row"><span class="muted-text">Queries 24h</span><span class="cv">${q24}</span></div>
    <div class="credit-row"><span class="muted-text">Credits 24h</span><span class="cv">${c24}</span></div>
    ${acct?`<div class="credit-row"><span class="muted-text">Plan</span><span class="cv">${acct.plan||'?'}</span></div>
    <div class="credit-row"><span class="muted-text">Query credits</span><span class="cv ${acct.query_credits<10?'cv-warn':''}">${acct.query_credits??'?'}</span></div>`
    :'<div class="muted-text" style="font-size:8px">Offline — local stats only</div>'}`;
}

// ── PLAYBACK ──────────────────────────────────────────────────────────────────
async function initPlayback(){
  try{
    const r=await fetch('/api/playback/range');const d=await r.json();
    if(!d.available||!d.earliest){addLog('PLAYBACK: NO DATA');document.getElementById('playback-status').textContent='NO DATA';return;}
    S.playback.range={earliest:d.earliest,latest:d.latest};S.playback.currentTs=d.latest;
    document.getElementById('playback-status').textContent='READY';
    await buildTimeline(d.layers?.[0]||'flights');updatePlaybackDisplay();
    addLog(`PLAYBACK: ${Math.round((d.latest-d.earliest)/3600000)}h`);
  } catch(e){addLog(`PLAYBACK: ${e.message}`);}
}

async function buildTimeline(layer){
  try{
    const{earliest,latest}=S.playback.range;
    const r=await fetch(`/api/playback/timeline?layer=${layer}&from=${earliest}&to=${latest}`);
    renderTimeline((await r.json()).points||[]);
  } catch{}
}

function renderTimeline(points){
  const canvas=document.getElementById('timeline-canvas');if(!canvas||!points.length)return;
  const ctx=canvas.getContext('2d'),W=canvas.width,H=canvas.height;
  ctx.clearRect(0,0,W,H);
  const{earliest,latest}=S.playback.range,span=latest-earliest||1;
  const maxCnt=Math.max(...points.map(p=>p[1]),1);
  ctx.fillStyle='rgba(0,20,10,0.7)';ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='rgba(0,255,136,0.1)';ctx.lineWidth=1;
  for(let i=0;i<=4;i++){const y=H-(i/4)*H;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
  ctx.beginPath();ctx.moveTo(0,H);
  for(const[ts,cnt]of points){const x=((ts-earliest)/span)*W,y=H-(cnt/maxCnt)*(H-4);ctx.lineTo(x,y);}
  ctx.lineTo(W,H);ctx.closePath();ctx.fillStyle='rgba(0,255,136,0.12)';ctx.fill();
  ctx.beginPath();
  for(let i=0;i<points.length;i++){const[ts,cnt]=points[i];const x=((ts-earliest)/span)*W,y=H-(cnt/maxCnt)*(H-4);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}
  ctx.strokeStyle='rgba(0,255,136,0.7)';ctx.lineWidth=1.5;ctx.stroke();
  drawTimelineCursor();
}

function drawTimelineCursor(){
  const canvas=document.getElementById('timeline-canvas');if(!canvas||!S.playback.currentTs)return;
  const ctx=canvas.getContext('2d'),{earliest,latest}=S.playback.range;
  const x=((S.playback.currentTs-earliest)/(latest-earliest||1))*canvas.width;
  ctx.strokeStyle='#ff3344';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke();
}

async function seekPlayback(ts){
  S.playback.currentTs=ts;updatePlaybackDisplay();
  const layers=['flights','military','quakes'].filter(k=>S.layers[k]?.on);
  for(const layer of layers){
    try{
      const r=await fetch(`/api/playback/frame?layer=${layer}&ts=${ts}`);const d=await r.json();
      if(layer==='flights'||layer==='military') renderFlights(d.data?.states||[],layer==='military');
      else if(layer==='quakes') renderQuakes(d.data?.features||[]);
    } catch{}
  }
  drawTimelineCursor();
}

function updatePlaybackDisplay(){
  const ts=S.playback.currentTs;if(!ts)return;
  document.getElementById('playback-time').textContent=new Date(ts).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}

function togglePlayback(){
  if(S.playback.playing){
    clearInterval(S.playback.playInterval);S.playback.playing=false;
    document.getElementById('pb-play-btn').textContent='▶ Play';addLog('PLAYBACK PAUSED');
  } else {
    S.playback.playing=true;document.getElementById('pb-play-btn').textContent='⏸ Pause';addLog('PLAYBACK RUNNING');
    const step=30000*(S.playback.speed||1);
    S.playback.playInterval=setInterval(async()=>{
      const next=(S.playback.currentTs||S.playback.range.earliest)+step;
      if(next>S.playback.range.latest){togglePlayback();return;}
      await seekPlayback(next);
      const s=document.getElementById('pb-scrubber');
      if(s)s.value=((next-S.playback.range.earliest)/(S.playback.range.latest-S.playback.range.earliest))*100;
    },500);
  }
}

async function refreshStorageStats(){
  try{
    const r=await fetch('/api/storage/stats');const d=await r.json();
    const el=document.getElementById('storage-stats');if(!el)return;
    if(!d.available){el.textContent='DB OFFLINE';return;}
    const mb=(d.db_bytes/1024/1024).toFixed(1);
    const lines=d.layers.map(l=>`${l.layer.toUpperCase().padEnd(8)} ${l.frames}fr ${((l.latest-l.earliest)/3600000).toFixed(1)}h`);
    el.innerHTML=`<div class="stat-row"><span class="muted-text">DB size</span><span class="val-green">${mb} MB</span></div>${lines.map(l=>`<div style="font-size:9px;color:var(--text-muted);font-family:var(--font-mono)">${l}</div>`).join('')}`;
  } catch{}
}

// ── CLICK HANDLER ─────────────────────────────────────────────────────────────
function onGlobeClick(movement){
  const picked=S.viewer.scene.pick(movement.position);
  if(!picked?.id){hideDetail();return;}
  const ent=picked.id; if(!ent.properties) return;
  S._lastEnt=ent;
  const type=ent.properties.type?.getValue();
  const data=ent.properties.data?.getValue();
  if(type==='meshtastic'){showMeshNodeDetail(data);return;}
  showDetail(type,ent.name,data,ent.properties.airline?.getValue(),ent.properties.online?.getValue());
}

function showDetail(type,name,data,airline,online){
  document.getElementById('dp-type-badge').textContent=(type||'UNK').toUpperCase().slice(0,8);
  document.getElementById('dp-title').textContent=name||'Unknown';
  let html='';

  if(type==='satellite'){
    const pos=data?.pos||{};
    html=dpRow('Name',name)+dpRow('Lat',(pos.lat||0).toFixed(3)+'°')+dpRow('Lon',(pos.lng||0).toFixed(3)+'°')+dpRow('Altitude',Math.round(pos.alt||0)+' km');
  } else if(type==='flight'||type==='military'){
    const s=data||[];
    const al=airline?`<div class="dp-airline" style="background:${airline.color}15;border-left-color:${airline.color}">${airline.name}</div>`:'';
    html=al+dpRow('Callsign',(s[1]||'N/A').trim())+dpRow('ICAO24',s[0]||'N/A')+dpRow('Country',s[2]||'N/A')+dpRow('Altitude',Math.round(s[7]||0)+' m')+dpRow('Speed',Math.round(s[9]||0)+' m/s')+dpRow('Track',Math.round(s[10]||0)+'°')+dpRow('Position',`${(+s[6]||0).toFixed(3)}°, ${(+s[5]||0).toFixed(3)}°`);
  } else if(type==='ship'){
    const d=data||{},t=+(d.type||0);
    const st=t>=80?'Tanker':t>=70?'Cargo':t>=60?'Passenger':t>=50?'High Speed':'Other';
    html=dpRow('Name',d.name||'Unknown')+dpRow('MMSI',d.mmsi||'N/A')+dpRow('Type',st)+dpRow('Flag',d.flag||'N/A')+dpRow('Speed',`${(+(d.sog||0)).toFixed(1)} kt`)+dpRow('Course',`${Math.round(d.cog||0)}°`)+dpRow('Destination',(d.dest||'Unknown').substring(0,24));
  } else if(type==='gpsjam'){
    html=dpRow('Type','GPS Interference')+dpRow('Level',`${data?.level||'?'} / 3`)+dpRow('Area',data?.label||'Unknown')+dpRow('Source','gpsjam.org');
  } else if(type==='cctv'){
    const d=data||{};
    html=dpRow('Type',d.type||'Fixed camera')+dpRow('Operator',d.operator||'Unknown')+dpRow('Mount',d.mount||'pole')+dpRow('ID',d.id||'N/A');
  } else if(type==='quake'){
    const d=data||{};
    html=dpRow('Magnitude','M'+((d.mag||0).toFixed(1)))+dpRow('Location',d.place||'Unknown')+dpRow('Depth',(d.dmin||0)+' km')+dpRow('Time',d.time?new Date(d.time).toUTCString():'N/A');
  } else if(type==='sensor'){
    const d=data||{};
    html=dpRow('Network',d.network)+dpRow('Code',d.code)+dpRow('Name',d.name||'—')+dpRow('Elevation',`${d.elev||0}m`)+dpRow('Position',`${d.lat?.toFixed(3)}°, ${d.lon?.toFixed(3)}°`);
  } else if(type==='fire'){
    const d=data||{};
    html=dpRow('FRP',`${d.frp||0} MW`)+dpRow('Date',d.acq_date||'—')+dpRow('Confidence',d.confidence||'—')+dpRow('Brightness',d.brightness||'—');
  } else if(type==='shodan'){
    const d=data||{};
    const vb=d.vulns?.length?`<div style="margin:4px 0">${d.vulns.map(v=>`<span class="vuln-badge">${v}</span>`).join('')}</div>`:'';
    html=dpRow('IP',d.ip)+dpRow('Port',`${d.port}/${d.transport||'tcp'}`)+dpRow('Org',d.org||'N/A')+dpRow('Product',d.product||'N/A')+dpRow('Location',`${d.city||''} ${d.country||''}`)+vb+(d.link?`<a href="${d.link}" target="_blank" class="shodan-link">🔗 View on Shodan</a>`:'');
  } else if(type==='weather'){
    const d=data||{};
    html=dpRow('Temperature',`${d.temperature_2m??'?'}°C`)+dpRow('Wind',`${d.wind_speed_10m??'?'} km/h`)+dpRow('Humidity',`${d.relative_humidity_2m??'?'}%`)+dpRow('Cloud Cover',`${d.cloud_cover??'?'}%`);
  }

  document.getElementById('dp-content').innerHTML=html||'<div class="muted-text">No data</div>';
  document.getElementById('detail-panel').classList.remove('hidden');
}

function dpRow(k,v){ return `<div class="dp-row"><span class="dp-key">${k}</span><span class="dp-val">${v}</span></div>`; }
function hideDetail(){ document.getElementById('detail-panel').classList.add('hidden'); }

// ── TRACKING ──────────────────────────────────────────────────────────────────
function lockTrack(ent){
  S.tracking=ent; S.viewer.trackedEntity=ent;
  document.getElementById('tracking-info').innerHTML=`<div class="track-item"><span>Target: </span>${ent.name}</div><div class="track-item"><span>Status: </span>LOCKED</div>`;
  document.getElementById('clear-track-btn').style.display='block';
  addLog(`LOCKED: ${ent.name}`);
}
function clearTrack(){
  S.tracking=null;S.viewer.trackedEntity=undefined;
  document.getElementById('tracking-info').innerHTML='<div class="no-track">No target locked</div>';
  document.getElementById('clear-track-btn').style.display='none';
  addLog('TARGET RELEASED');
}

// ── COORDS / LOD ──────────────────────────────────────────────────────────────
function getViewBbox(){
  if(!S.viewer) return null;
  try{
    const rect=S.viewer.camera.computeViewRectangle(); if(!rect) return null;
    return{minLat:Cesium.Math.toDegrees(rect.south),maxLat:Cesium.Math.toDegrees(rect.north),minLon:Cesium.Math.toDegrees(rect.west),maxLon:Cesium.Math.toDegrees(rect.east),centerLat:Cesium.Math.toDegrees((rect.south+rect.north)/2),centerLon:Cesium.Math.toDegrees((rect.west+rect.east)/2)};
  } catch{return null;}
}
function getCameraAltitude(){ return S.viewer?.camera.positionCartographic.height??1e9; }
function getLODLevel(alt){ return alt>LOD.GLOBAL?'GLOBAL':alt>LOD.REGIONAL?'REGIONAL':alt>LOD.CITY?'CITY':'STREET'; }

function updateCoords(){
  if(!S.viewer) return;
  const c=S.viewer.camera.positionCartographic,alt=c.height,km=alt/1000;
  document.getElementById('lat-display').textContent=Cesium.Math.toDegrees(c.latitude).toFixed(3)+'°';
  document.getElementById('lon-display').textContent=Cesium.Math.toDegrees(c.longitude).toFixed(3)+'°';
  document.getElementById('alt-display').textContent=km>1000?(km/1000).toFixed(1)+'Mkm':Math.round(km)+'km';
  const newLOD=getLODLevel(alt);
  if(newLOD!==currentLOD){
    currentLOD=newLOD;
    const el=document.getElementById('lod-indicator');
    if(el){el.textContent=`LOD: ${newLOD}`;el.className=`lod-badge lod-${newLOD.toLowerCase()}`;}
    addLog(`LOD → ${newLOD}`);
  }
  lastViewBbox=getViewBbox();
  clearTimeout(lodDebounceTimer);
  lodDebounceTimer=setTimeout(onCameraSettled,CONFIG.lodDebounce);
}

function onCameraSettled(){
  const bbox=lastViewBbox; if(!bbox) return;
  const lod=getLODLevel(getCameraAltitude());
  if(S.layers.flights.on)  refreshFlightsBbox(bbox,lod,false);
  if(S.layers.military.on) refreshFlightsBbox(bbox,lod,true);
  if(S.layers.ships.on&&lod!=='GLOBAL') refreshShipsBbox(bbox);
  if(S.layers.weather.on)  refreshWeather(bbox,lod);
  if(S.layers.wildfires.on&&lod!=='STREET') refreshWildfires(bbox);
  if(S.layers.cctv.on&&(lod==='CITY'||lod==='STREET')){
    clearTimeout(S._cctvTimer);S._cctvTimer=setTimeout(()=>loadCctv(bbox),500);
  }
  if(S.layers.traffic.on&&(lod==='CITY'||lod==='STREET')) loadTraffic();
}

function startClock(){
  const tick=()=>{
    const n=new Date();
    document.getElementById('clock').textContent=n.toLocaleTimeString('en-GB',{hour12:false});
    document.getElementById('utc-clock').textContent=n.toISOString().substring(11,19);
  }; tick(); setInterval(tick,1000);
}

function addLog(msg){
  S.logHistory.unshift(msg);if(S.logHistory.length>8)S.logHistory.pop();
  const el=document.getElementById('event-log');
  if(el) el.innerHTML=`<span class="log-label">EVT</span><span class="log-sep">//</span>${S.logHistory.slice(0,3).map(m=>`<span class="log-item">${m}</span>`).join('')}`;
}

// Toast notification — unobtrusive failure/warning indicator
const _toastQ = [];
let _toastActive = false;
function showToast(msg, level='info') {
  _toastQ.push({msg, level});
  if (!_toastActive) processToastQ();
}
function processToastQ() {
  if (!_toastQ.length) { _toastActive = false; return; }
  _toastActive = true;
  const {msg, level} = _toastQ.shift();
  const colors = { info:'var(--green)', warn:'var(--amber)', error:'var(--red)' };
  const el = document.createElement('div');
  el.className = 'argus-toast';
  el.style.cssText = `position:fixed;bottom:38px;left:50%;transform:translateX(-50%) translateY(8px);z-index:500;
    background:rgba(4,14,10,0.95);border:1px solid ${colors[level]||colors.info};
    color:${colors[level]||colors.info};font-family:var(--font-mono);font-size:10px;
    letter-spacing:0.1em;padding:6px 16px;opacity:0;transition:all 0.25s ease;
    pointer-events:none;white-space:nowrap;border-radius:2px;
    box-shadow:0 0 12px rgba(0,0,0,0.6)`;
  document.body.appendChild(el);
  // Animate in
  requestAnimationFrame(()=>{
    el.style.opacity='0.92';
    el.style.transform='translateX(-50%) translateY(0)';
  });
  setTimeout(()=>{
    el.style.opacity='0';
    el.style.transform='translateX(-50%) translateY(8px)';
    setTimeout(()=>{ el.remove(); processToastQ(); }, 280);
  }, 2800);
}

function flyTo(name){
  const p=PRESETS[name];if(!p||!S.viewer)return;
  S.viewer.camera.flyTo({destination:Cesium.Cartesian3.fromDegrees(p.lon,p.lat,p.alt),orientation:{heading:0,pitch:Cesium.Math.toRadians(p.pitch||-45),roll:0},duration:2});
  addLog(`→ ${name.toUpperCase()}`);
}

// ── UI SETUP ──────────────────────────────────────────────────────────────────
function setupUI(){
  const tl=(id,key,onFn,offFn)=>{
    document.getElementById(id)?.addEventListener('change',e=>{
      S.layers[key].on=e.target.checked;
      if(e.target.checked)onFn();else offFn?.();
    });
  };

  tl('toggle-satellites','satellites',
    ()=>{loadSatellites();},
    ()=>{if(S.layers.satellites.ds)S.viewer?.dataSources.remove(S.layers.satellites.ds,true);clearInterval(S.intervals.sat);}
  );
  tl('toggle-flights','flights',
    ()=>{loadFlights(false);S.intervals.flights=setInterval(()=>loadFlights(false),CONFIG.flightUpdateInterval);},
    ()=>{if(S.layers.flights.ds)S.viewer?.dataSources.remove(S.layers.flights.ds,true);clearInterval(S.intervals.flights);document.getElementById('flight-count').textContent='0';}
  );
  tl('toggle-military','military',
    ()=>{loadFlights(true);S.intervals.mil=setInterval(()=>loadFlights(true),CONFIG.militaryUpdateInterval);},
    ()=>{if(S.layers.military.ds)S.viewer?.dataSources.remove(S.layers.military.ds,true);clearInterval(S.intervals.mil);document.getElementById('mil-count').textContent='0';}
  );
  tl('toggle-ships','ships',
    ()=>{loadShips();S.intervals.ships=setInterval(loadShips,CONFIG.shipUpdateInterval);},
    ()=>{if(S.layers.ships.ds)S.viewer?.dataSources.remove(S.layers.ships.ds,true);clearInterval(S.intervals.ships);document.getElementById('ship-count').textContent='0';}
  );
  tl('toggle-traffic','traffic',loadTraffic,clearTraffic);
  tl('toggle-cctv','cctv',
    ()=>loadCctv(lastViewBbox),
    ()=>{if(S.layers.cctv.ds)S.viewer?.dataSources.remove(S.layers.cctv.ds,true);document.getElementById('cctv-count').textContent='0';}
  );
  tl('toggle-meshtastic','meshtastic',
    ()=>{loadMeshtastic();S.intervals.mesh=setInterval(loadMeshtastic,CONFIG.meshtasticUpdateInterval);},
    ()=>{if(S.layers.meshtastic.ds)S.viewer?.dataSources.remove(S.layers.meshtastic.ds,true);clearInterval(S.intervals.mesh);document.getElementById('mesh-count').textContent='0';}
  );
  tl('toggle-quakes','quakes',
    ()=>{loadQuakes();S.intervals.quakes=setInterval(loadQuakes,CONFIG.quakeUpdateInterval);},
    ()=>{if(S.layers.quakes.ds)S.viewer?.dataSources.remove(S.layers.quakes.ds,true);clearInterval(S.intervals.quakes);document.getElementById('quake-count').textContent='0';}
  );
  tl('toggle-sensors','sensors',
    ()=>loadSeismicStations(),
    ()=>{if(S.layers.sensors.ds)S.viewer?.dataSources.remove(S.layers.sensors.ds,true);document.getElementById('sensor-count').textContent='0';}
  );
  tl('toggle-wildfires','wildfires',
    ()=>{refreshWildfires(lastViewBbox||getViewBbox());S.intervals.fires=setInterval(()=>refreshWildfires(lastViewBbox||getViewBbox()),CONFIG.fireUpdateInterval);},
    ()=>{if(S.layers.wildfires.ds)S.viewer?.dataSources.remove(S.layers.wildfires.ds,true);clearInterval(S.intervals.fires);document.getElementById('fire-count').textContent='0';}
  );
  tl('toggle-gpsjam','gpsjam',
    ()=>{loadGpsJam();S.intervals.gpsjam=setInterval(loadGpsJam,CONFIG.gpsjamUpdateInterval);},
    ()=>{if(S.layers.gpsjam.ds)S.viewer?.dataSources.remove(S.layers.gpsjam.ds,true);clearInterval(S.intervals.gpsjam);document.getElementById('jam-count').textContent='0';}
  );
  tl('toggle-weather','weather',
    ()=>{refreshWeather(lastViewBbox||getViewBbox(),currentLOD);S.intervals.weather=setInterval(()=>refreshWeather(lastViewBbox||getViewBbox(),currentLOD),CONFIG.weatherUpdateInterval);},
    ()=>{if(S.layers.weather.ds)S.viewer?.dataSources.remove(S.layers.weather.ds,true);clearInterval(S.intervals.weather);document.getElementById('weather-count').textContent='0';}
  );
  document.getElementById('toggle-shodan')?.addEventListener('change',e=>{if(!e.target.checked)clearShodanLayer();});

  // SAT imagery
  const sti=document.getElementById('toggle-sat-imagery');
  const sts=document.getElementById('sat-imagery-select');
  sti?.addEventListener('change',()=>{
    if(sti.checked){const k=sts?.value;if(k&&k!=='none')setGibsLayer(k);else{if(sts)sts.value='modis_true';setGibsLayer('modis_true');}}
    else setGibsLayer(null);
  });
  sts?.addEventListener('change',e=>{
    const k=e.target.value;
    if(k==='none'){if(sti)sti.checked=false;setGibsLayer(null);}
    else{if(sti)sti.checked=true;setGibsLayer(k);}
  });

  // Detection mode
  document.querySelectorAll('.det-btn').forEach(btn=>btn.addEventListener('click',()=>{
    document.querySelectorAll('.det-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');S.detMode=btn.dataset.mode;
    if(S.layers.satellites.on)renderSatellites();
    addLog(`DETAIL: ${btn.dataset.mode.toUpperCase()}`);
  }));

  // Vision mode
  document.querySelectorAll('.vision-btn').forEach(btn=>btn.addEventListener('click',()=>{
    document.querySelectorAll('.vision-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.body.className=document.body.className.replace(/mode-\w+/g,'').trim();
    const m=btn.dataset.mode;
    if(m!=='normal') document.body.classList.add(`mode-${m}`);
    document.getElementById('scanlines').style.opacity={crt:'0.85',nvg:'0.5',flir:'0.4'}[m]||'0.5';
    addLog(`DISPLAY: ${m.toUpperCase()}`);
  }));

  // Presets
  document.querySelectorAll('.preset-btn').forEach(btn=>btn.addEventListener('click',()=>flyTo(btn.dataset.preset)));

  // Detail panel
  document.getElementById('dp-close')?.addEventListener('click',hideDetail);
  document.getElementById('dp-track-btn')?.addEventListener('click',()=>{if(S._lastEnt)lockTrack(S._lastEnt);hideDetail();});
  document.getElementById('clear-track-btn')?.addEventListener('click',clearTrack);

  // Flight filters
  setupFlightFilters();

  // Shodan
  document.getElementById('shodan-search-btn')?.addEventListener('click',executeShodanSearch);
  document.getElementById('shodan-query-input')?.addEventListener('keydown',e=>{if(e.key==='Enter')executeShodanSearch();});
  document.getElementById('shodan-save-key-btn')?.addEventListener('click',()=>{
    const k=document.getElementById('shodan-key-input')?.value?.trim();if(!k)return;
    S.shodan.key=k;localStorage.setItem('shodan_key',k);
    document.getElementById('shodan-key-prompt').style.display='none';
    addLog('SHODAN KEY SAVED');refreshShodanCredits();
  });
  const saved=localStorage.getItem('shodan_key'); if(saved)S.shodan.key=saved;
  document.getElementById('shodan-credit-refresh')?.addEventListener('click',refreshShodanCredits);

  // Playback
  document.getElementById('pb-init-btn')?.addEventListener('click',initPlayback);
  document.getElementById('pb-play-btn')?.addEventListener('click',togglePlayback);
  document.getElementById('pb-speed')?.addEventListener('change',e=>{S.playback.speed=parseFloat(e.target.value)||1;});
  document.getElementById('pb-scrubber')?.addEventListener('input',e=>{
    const pct=parseFloat(e.target.value)/100;
    seekPlayback(Math.round(S.playback.range.earliest+pct*(S.playback.range.latest-S.playback.range.earliest)));
  });
  document.getElementById('timeline-canvas')?.addEventListener('click',e=>{
    const pct=e.offsetX/e.target.width;
    const ts=S.playback.range.earliest+pct*(S.playback.range.latest-S.playback.range.earliest);
    if(ts){seekPlayback(Math.round(ts));const s=document.getElementById('pb-scrubber');if(s)s.value=pct*100;}
  });
  document.getElementById('storage-refresh-btn')?.addEventListener('click',refreshStorageStats);

  // Keyboard
  document.addEventListener('keydown',e=>{
    if(e.target.tagName==='INPUT') return;
    if(e.key==='Escape'){hideDetail();clearTrack();}
    if(e.key==='f'||e.key==='F') document.getElementById('filter-panel')?.classList.toggle('hidden');
  });

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const t=btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p=>p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${t}`)?.classList.remove('hidden');
  }));
}

function setupFlightFilters(){
  const apply=()=>{
    S.filters.flights.minAlt  =parseInt(document.getElementById('f-min-alt')?.value||0);
    S.filters.flights.maxAlt  =parseInt(document.getElementById('f-max-alt')?.value||45000);
    S.filters.flights.minSpd  =parseInt(document.getElementById('f-min-spd')?.value||0);
    S.filters.flights.maxSpd  =parseInt(document.getElementById('f-max-spd')?.value||1200);
    S.filters.flights.country =document.getElementById('f-country')?.value?.trim()||'';
    S.filters.flights.callsign=document.getElementById('f-callsign')?.value?.trim()||'';
    S.filters.flights.showUnknown=document.getElementById('f-show-unknown')?.checked??true;
    if(S.layers.flights.on)applyFlightFilters(false);
    if(S.layers.military.on)applyFlightFilters(true);
    addLog('FILTERS APPLIED');
  };
  const reset=()=>{
    ['f-min-alt','f-max-alt','f-min-spd','f-max-spd'].forEach((id,i)=>{const el=document.getElementById(id);if(el)el.value=[0,45000,0,1200][i];});
    const fc=document.getElementById('f-country');if(fc)fc.value='';
    const fs=document.getElementById('f-callsign');if(fs)fs.value='';
    const fu=document.getElementById('f-show-unknown');if(fu)fu.checked=true;
    apply();
  };
  document.getElementById('filter-apply-btn')?.addEventListener('click',apply);
  document.getElementById('filter-reset-btn')?.addEventListener('click',reset);
  ['f-country','f-callsign'].forEach(id=>document.getElementById(id)?.addEventListener('keydown',e=>{if(e.key==='Enter')apply();}));
}
