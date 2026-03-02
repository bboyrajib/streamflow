# Torrent Streamer

Stream torrents in your browser. No database. One Node.js server.

## Architecture

```
Browser
  ↓ /api/search    — searches Knaben + PirateBay + SolidTorrents
  ↓ /api/info      — SSE: fetches metadata, waits for peers, returns file list
  ↓ /api/stream    — HTTP range streaming (seekable video)
  ↓ /api/stats     — live peer/speed/progress stats

Node.js (streamer/server.js)
  ↓ WebTorrent → TCP/UDP → BitTorrent peers
```

---

## Quick Start

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

> If you want `.\start.ps1` to work directly without the flag every time, run this once:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy Unrestricted
> ```
> Then you can just run `.\start.ps1` directly.

### Linux / macOS

```bash
chmod +x start.sh
./start.sh
```

> `chmod +x` is only needed once — it marks the script as executable.
> On macOS you may also see a Gatekeeper warning the first time.
> If so, go to System Settings → Privacy & Security → allow it, then re-run.

---

## Options

| Flag | PowerShell | Bash | Default |
|---|---|---|---|
| Custom port | `.\start.ps1 -Port 8080` | `./start.sh --port 8080` | `9090` |
| Skip frontend rebuild | `.\start.ps1 -SkipBuild` | `./start.sh --skip-build` | off |

Use `--skip-build` / `-SkipBuild` on subsequent runs if you haven't changed the frontend — it skips the `npm install` + `npm run build` steps and starts the server immediately.

---

## What the scripts do

1. Check if Node.js is installed — if not, install it automatically:
   - **Windows**: tries `winget` → `choco` → downloads the official `.msi` installer
   - **Linux**: tries `apt` → `dnf` → `yum` → `pacman` → `zypper` → downloads binary directly
   - **macOS**: tries `brew` → installs Homebrew first if needed, then Node
2. `npm install` in `frontend/`
3. `npm run build` → produces `frontend/dist/`
4. Copy `frontend/dist/` → `streamer/public/`
5. `npm install --omit=dev` in `streamer/`
6. `node server.js` — serves everything at `http://localhost:9090`

---

## Dev (with HMR)

```bash
# Terminal 1 — API + streaming server
cd streamer && npm install && node server.js

# Terminal 2 — frontend dev server with hot reload
cd frontend && npm install && npm run dev
# Open http://localhost:5173
```

---

## Docker

```bash
docker compose up --build
# Dev frontend at http://localhost:5173
# API server at http://localhost:9090
```

---

## API

| Endpoint | Description |
|---|---|
| `GET /api/search?q=inception` | Search torrents (Knaben + PirateBay + SolidTorrents) |
| `GET /api/info?magnet=...` | SSE: torrent metadata + file list, waits for peers |
| `GET /api/stream?infoHash=...&file=0` | Stream video with HTTP range support |
| `GET /api/stats?infoHash=...` | Live peers, speed, progress |
| `GET /api/resolve?magnet=...` | Parse a magnet link into metadata |
| `GET /api/health` | Server health check |
