# PANOPTICON // Global Intelligence Dashboard

> Palantir-style real-time geospatial dashboard built with CesiumJS.
> Google Photorealistic 3D Tiles · Live Satellites · Flights · Seismic · Traffic

---

## Quick Start (Docker)

```bash
# Clone / copy this folder, then:
docker compose up --build

# Open in browser:
http://localhost:3000
```

On first load, enter your **Cesium Ion Access Token** (free at [ion.cesium.com](https://ion.cesium.com)).
The token is stored in your browser's `localStorage` so you only enter it once.

---

## Getting Your Free Cesium Ion Token

1. Go to [ion.cesium.com](https://ion.cesium.com) and create a free account
2. Click **Access Tokens** in the left sidebar
3. Create a new token (default scopes are fine)
4. Paste it into the dashboard on first launch

The **Community (free) plan** includes:
- Google Photorealistic 3D Tiles
- Cesium World Terrain
- OSM Buildings
- Unlimited apps and end users

---

## Data Layers

| Layer | Source | Update Rate |
|-------|--------|-------------|
| Satellites | CelesTrak TLE | Every 5s (calculated) |
| Commercial Flights | OpenSky Network | Every 15s |
| Military Flights | OpenSky (filtered) | Every 15s |
| Street Traffic | OpenStreetMap / Overpass | On load |
| Seismic Activity | USGS GeoJSON Feed | Every 60s |

**Note**: OpenSky anonymous API has rate limits. If flights don't load, wait 60s and toggle the layer off/on.

---

## Controls

| Input | Action |
|-------|--------|
| Keys `1–5` | Switch vision mode (Standard/CRT/NVG/FLIR/Radar) |
| Click entity | Show detail panel |
| Detail panel → Lock Track | Track entity with camera |
| `Escape` | Clear selection / tracking |
| Left panel toggles | Enable/disable data layers |
| Right panel sliders | Adjust post-processing effects |
| Camera presets | Fly to city landmarks |

---

## Architecture

```
panopticon/
├── Dockerfile
├── docker-compose.yml
├── server.js          # Express proxy server (avoids CORS)
├── package.json
└── public/
    ├── index.html     # Main app
    ├── css/style.css  # Classified UI aesthetic
    └── js/app.js      # CesiumJS globe + all data layers
```

The **Express server** acts as a proxy for all external APIs — this is necessary because browser CORS restrictions block direct calls to CelesTrak, OpenSky, USGS, and Overpass.

---

## Configuration

Edit `public/js/app.js` top section:

```js
const CONFIG = {
  satelliteUpdateInterval: 5000,   // ms between satellite position recalculation
  flightUpdateInterval: 15000,     // ms between flight data fetch
  trafficParticleCount: 600,       // number of traffic particles
  maxDetectionLabels: 80,          // labels shown in FULL detection mode
};
```

---

## Extending

**Add more satellite groups** — edit `server.js` and call:
```
/api/tle/starlink    → Starlink constellation
/api/tle/gps-ops    → GPS satellites
/api/tle/weather    → Weather satellites
```

**Add more cities** — edit `CAMERA_PRESETS` in `app.js`.

---

## Legal Notes

- **CelesTrak**: Free for non-commercial use. Attribution: celestrak.org
- **OpenSky Network**: CC BY 4.0. Attribution required.
- **USGS**: Public domain US government data
- **OpenStreetMap**: ODbL license. © OpenStreetMap contributors
- **Cesium Ion / Google 3D Tiles**: Free Community tier, attribution displayed on map

All data is fetched live from public APIs. No data is stored or cached server-side.
