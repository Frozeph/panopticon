# Installing PANOPTICON on ZimaBoard 2 / ZimaOS
## Zero host changes — everything through the ZimaOS UI

The ZimaOS dashboard's custom app importer only accepts `image:` references
(not `build:` contexts), so the approach is:

1. Push your code to GitHub → Actions auto-builds the image → pushes to GHCR
2. Paste the compose file into ZimaOS dashboard → it pulls the image and installs

No SSH. No sudo. No host modifications.

---

## Step 1 — Create a GitHub repository

If you haven't already:

1. Go to [github.com](https://github.com) → **New repository**
2. Name it `panopticon` (or anything you like)
3. Set it to **Public** (GHCR images from public repos are free to pull without auth)
4. Push the project folder to it:

```bash
# On your local machine (not the ZimaBoard):
cd panopticon-dashboard/
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/panopticon.git
git push -u origin main
```

---

## Step 2 — GitHub Actions builds the image automatically

The `.github/workflows/build-and-push.yml` file included in the project runs
automatically on every push to `main`. It:

- Builds the Docker image (including compiling the native SQLite module)
- Pushes it to `ghcr.io/YOUR_USERNAME/panopticon:latest`
- Uses layer caching so subsequent builds take ~30 seconds instead of 3 minutes

**To watch it run:**
Go to your GitHub repo → **Actions** tab → click the running workflow

**First build takes about 2-3 minutes.** Wait for the green checkmark before continuing.

> **Make the image public** (so ZimaOS can pull it without credentials):
> GitHub → your repo → **Packages** (right sidebar) → panopticon →
> Package settings → Change visibility → **Public**

---

## Step 3 — Install via ZimaOS Dashboard

1. Open your ZimaOS web dashboard (`http://<zimaboard-ip>` or via Zima client app)
2. Click **[+]** in the top-right corner of the app grid
3. Choose **"Install a customized app"**
4. Click **"Import"** → select the **"Docker Compose"** tab
5. Open `docker-compose.zimaos.yml`, **replace `YOUR_GITHUB_USERNAME`** with your actual GitHub username, then paste the whole file
6. Click **Submit** → **OK**
7. In the settings screen:
   - **Image**: should show `ghcr.io/yourusername/panopticon:latest`
   - **Volume**: `/DATA/AppData/panopticon/data` to `/app/data` (ZimaOS creates this dir)
   - **Port**: `3000` (change to `3001` etc. if 3000 is already taken)
   - **SHODAN_API_KEY**: paste yours if you have one, or leave blank
8. Click **Install**

ZimaOS pulls the image (~80MB) and starts the container.
A PANOPTICON tile appears on your dashboard.

---

## Step 4 — First run

Click the PANOPTICON tile. On first load you'll see the initialisation screen:

1. **Cesium Ion token** — get a free one at [ion.cesium.com](https://ion.cesium.com) → Access Tokens → Create token → paste it in → Initialise System
2. The 3D globe loads. Enable layers from the left panel.
3. For Shodan: click the **SHODAN** tab in the left panel → enter your API key there (saves to browser localStorage)

---

## Updating the app

When you push changes to GitHub, Actions rebuilds the image automatically.

To apply the update on ZimaOS:
1. Dashboard → PANOPTICON tile → three-dot menu → **Update** (or Delete + re-import)
2. ZimaOS pulls the new `latest` tag
3. Your database and history in `/DATA/AppData/panopticon/data` is preserved

---

## If your GHCR image is private

If you left the package visibility as private, ZimaOS needs credentials to pull it.
The easiest fix is to make it public (Step 2 above).

---

## Checking it's running

From any browser on your local network:
```
http://<zimaboard-ip>:3000/api/health
```
Expected response: `{"status":"ok","db":{"ok":true},...}`

---

## File reference

| File | Purpose |
|---|---|
| `docker-compose.zimaos.yml` | **Paste this into ZimaOS UI** |
| `.github/workflows/build-and-push.yml` | Auto-builds image on every GitHub push |
| `docker-compose.yml` | Dev compose for your local machine |

---

## Troubleshooting

**"Unable to pull image" in ZimaOS:**
The GHCR package is still private. GitHub → Packages → panopticon → Package settings → Make public.

**Actions build failed:**
Check the Actions tab on GitHub. The workflow file must be at `.github/workflows/build-and-push.yml` in the repo root.

**Port 3000 conflict:**
Change `published: "3000"` to `"3001"` in the compose, and update `port_map: "3001"` in the `x-casaos` block.

**3D tiles not loading:**
Your Cesium Ion token is wrong or expired. In browser: F12 → Application → Local Storage → delete `cesium_token` → reload → enter a fresh token.

**Shodan scan returns "No API key":**
Enter your key in the SHODAN tab in the left panel — it saves to browser localStorage without needing a reinstall.
