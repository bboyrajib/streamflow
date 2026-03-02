import express from 'express'
import cors from 'cors'
import WebTorrent from 'webtorrent'
import https from 'https'
import http from 'http'
import fetch from 'node-fetch'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT || '9090')
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',')
const TORRENT_TTL = 30 * 60 * 1000
const MAX_TORRENTS = 5

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HLS TRANSCODING
//
// SEEKING FIX — what was broken and why:
//
//   OLD (broken):
//     -hls_flags append_list+delete_segments
//
//   PROBLEMS:
//     1. `delete_segments` — FFmpeg deletes old .ts files after ~5 segments.
//        Seeking backwards tries to fetch a segment that no longer exists → 404.
//     2. `append_list` — tells FFmpeg to keep writing to the playlist without
//        ever writing #EXT-X-ENDLIST. hls.js sees this as a LIVE stream.
//        Live streams auto-seek to the "live edge" and disable the seek bar.
//
//   NEW (fixed):
//     -hls_flags independent_segments
//
//     `independent_segments` — each .ts can be decoded independently (good for
//     random access). No `delete_segments` means all .ts files stay on disk.
//     No `append_list` means once FFmpeg finishes, it writes #EXT-X-ENDLIST
//     and hls.js switches the stream from LIVE → VOD with full seek support.
//
//   DISK USAGE NOTE:
//     Without delete_segments, disk usage grows with file size.
//     A 2-hour 1080p MKV at 4s segments ≈ 1800 segments × ~3MB = ~5.4GB peak.
//     The HLS_TTL (10 min inactivity) still cleans up the entire session dir.
//     For storage-constrained environments, consider a smaller HLS_SEG_TIME
//     or re-enabling delete_segments and accepting that backward seeks > ~20s
//     will stall until segments re-download (they won't, they're gone).
//
// FFMPEG FLAGS EXPLAINED:
//   -c:v copy                       → passthrough video (no CPU cost)
//   -c:a aac                        → transcode audio to AAC (fixes AC3/DTS)
//   -b:a 192k                       → audio bitrate
//   -ac 2                           → downmix to stereo
//   -hls_time 4                     → 4-second segments
//   -hls_list_size 0                → keep ALL segments listed in playlist
//   -hls_flags independent_segments → each .ts is self-contained (no delete!)
//   -hls_segment_type mpegts        → .ts container
//   -start_number 0                 → segments start at seg00000.ts
//
// REQUIREMENTS:
//   ffmpeg must be installed and in PATH.
//   Windows: choco install ffmpeg  |  macOS: brew install ffmpeg  |  Linux: apt install ffmpeg
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { spawn } from 'child_process'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const HLS_BASE_DIR  = join(tmpdir(), 'torrent-hls')
const HLS_TTL       = 10 * 60 * 1000  // clean up session after 10 min inactivity
const HLS_SEG_TIME  = 4               // seconds per segment

// Active HLS sessions: key = `${infoHash}:${fileIndex}`
const hlsSessions = new Map()

mkdirSync(HLS_BASE_DIR, { recursive: true })

function hlsSessionKey(infoHash, fileIndex) {
  return `${infoHash}:${fileIndex}`
}

function hlsDir(infoHash, fileIndex) {
  return join(HLS_BASE_DIR, `${infoHash}_${fileIndex}`)
}

function resetHlsTTL(key) {
  const session = hlsSessions.get(key)
  if (!session) return
  clearTimeout(session.timer)
  session.timer = setTimeout(() => destroyHlsSession(key), HLS_TTL)
}

function destroyHlsSession(key) {
  const session = hlsSessions.get(key)
  if (!session) return
  console.log(`[hls] destroying session ${key}`)
  try { session.ffmpeg?.kill('SIGKILL') } catch (_) {}
  try { if (existsSync(session.dir)) rmSync(session.dir, { recursive: true, force: true }) } catch (_) {}
  clearTimeout(session.timer)
  hlsSessions.delete(key)
}

async function getOrStartHlsSession(infoHash, fileIndex) {
  const key = hlsSessionKey(infoHash, fileIndex)

  if (hlsSessions.has(key)) {
    resetHlsTTL(key)
    const session = hlsSessions.get(key)
    if (!session.ready && !session.error) {
      await new Promise((resolve, reject) => {
        session.readyCallbacks.push({ resolve, reject })
      })
    }
    if (session.error) throw new Error(session.error)
    return session
  }

  const torrent = getClient().torrents.find(t => t.infoHash === infoHash)
    || torrents.get(infoHash)?.torrent
  if (!torrent) throw new Error('Torrent not loaded — open /api/info first')

  const file = torrent.files[parseInt(fileIndex)]
  if (!file) throw new Error(`File index ${fileIndex} not found`)

  const dir = hlsDir(infoHash, fileIndex)
  mkdirSync(dir, { recursive: true })

  const session = {
    dir,
    ffmpeg: null,
    timer: null,
    ready: false,
    error: null,
    readyCallbacks: [],
    playlistPath: join(dir, 'stream.m3u8'),
  }
  hlsSessions.set(key, session)

  const ffmpegArgs = [
    '-loglevel', 'warning',
    '-i', 'pipe:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2',
    '-hls_time', String(HLS_SEG_TIME),
    '-hls_list_size', '0',
    // ── SEEKING FIX ──────────────────────────────────────────────────────────
    // `independent_segments` only — no delete_segments (would remove .ts files
    // needed for backward seeks) and no append_list (would make hls.js think
    // this is a live stream and auto-seek to the live edge / hide seek bar).
    // Once FFmpeg finishes, it writes #EXT-X-ENDLIST → hls.js treats as VOD.
    // ─────────────────────────────────────────────────────────────────────────
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', join(dir, 'seg%05d.ts'),
    '-start_number', '0',
    join(dir, 'stream.m3u8'),
  ]

  console.log(`[hls] starting session ${key} for "${file.name}"`)
  const ff = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] })
  session.ffmpeg = ff

  const torrentStream = file.createReadStream()
  torrentStream.pipe(ff.stdin)
  torrentStream.on('error', err => { console.error('[hls] torrent stream error:', err.message); ff.stdin.end() })
  ff.stdin.on('error', () => {})

  let stderrBuf = ''
  ff.stderr.on('data', chunk => {
    stderrBuf += chunk.toString()
    if (!session.ready && existsSync(session.playlistPath)) {
      session.ready = true
      session.readyCallbacks.forEach(cb => cb.resolve())
      session.readyCallbacks = []
      console.log(`[hls] session ${key} ready`)
    }
    if (stderrBuf.includes('Error') || stderrBuf.includes('Invalid')) {
      console.warn('[ffmpeg stderr]', stderrBuf.slice(-300))
      stderrBuf = ''
    }
  })

  ff.on('error', err => {
    const msg = err.code === 'ENOENT'
      ? 'FFmpeg not found — install it and add to PATH'
      : err.message
    console.error('[hls]', msg)
    session.error = msg
    session.readyCallbacks.forEach(cb => cb.reject(new Error(msg)))
    session.readyCallbacks = []
  })

  ff.on('close', code => {
    if (code !== 0 && code !== null) console.log(`[hls] ffmpeg exited ${code} for ${key}`)
    if (!session.ready && existsSync(session.playlistPath)) {
      session.ready = true
      session.readyCallbacks.forEach(cb => cb.resolve())
      session.readyCallbacks = []
    }
    // FFmpeg done → #EXT-X-ENDLIST is written → hls.js promotes stream to VOD
    console.log(`[hls] transcoding complete for ${key} — stream is now full VOD`)
  })

  await new Promise((resolve, reject) => {
    session.readyCallbacks.push({ resolve, reject })
    let attempts = 0
    const poll = setInterval(() => {
      if (session.error) { clearInterval(poll); return }
      if (existsSync(session.playlistPath)) {
        if (!session.ready) {
          session.ready = true
          session.readyCallbacks.forEach(cb => cb.resolve())
          session.readyCallbacks = []
        }
        clearInterval(poll)
      }
      if (++attempts > 60) {
        clearInterval(poll)
        const msg = 'FFmpeg took too long to produce first segment'
        session.error = msg
        session.readyCallbacks.forEach(cb => cb.reject(new Error(msg)))
        session.readyCallbacks = []
      }
    }, 500)
  })

  if (session.error) { destroyHlsSession(key); throw new Error(session.error) }

  resetHlsTTL(key)
  return session
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// IN-MEMORY TTL CACHE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class TTLCache {
  constructor() { this._store = new Map() }
  get(key) {
    const e = this._store.get(key)
    if (!e) return undefined
    if (Date.now() > e.exp) { this._store.delete(key); return undefined }
    return e.val
  }
  set(key, val, ttlMs) { this._store.set(key, { val, exp: Date.now() + ttlMs }) }
  has(key) { return this.get(key) !== undefined }
  del(key) { this._store.delete(key) }
  flush() { this._store.clear() }
  stats() { return { keys: this._store.size } }
}

const torrentSearchCache = new TTLCache()
const tmdbSearchCache    = new TTLCache()
const tmdbDetailCache    = new TTLCache()
const tmdbBrowseCache    = new TTLCache()

const TORRENT_CACHE_TTL = 10 * 60 * 1000
const TMDB_SEARCH_TTL   = 30 * 60 * 1000
const TMDB_DETAIL_TTL   = 6 * 60 * 60 * 1000
const TMDB_BROWSE_TTL   = 60 * 60 * 1000

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REQUEST COALESCING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const inFlight = new Map()
function coalesce(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key)
  const p = fn().finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HEALTH SCORE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function healthScore(seeders, leechers) {
  const s = Math.max(0, parseInt(seeders) || 0)
  const l = Math.max(0, parseInt(leechers) || 0)
  if (s === 0) return 0
  const seederScore = Math.min(Math.log10(s + 1) / 3, 1)
  const ratio = l === 0 ? 1.0 : Math.min(s / l, 2) / 2
  const raw = seederScore * 0.75 + ratio * 0.25
  return Math.min(Math.round(raw * 100), 100)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TRACKERS / MAGNET HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const EXTRA_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.stealth.si:80/announce',
  'https://tracker.tamersunion.org:443/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
]

function buildMagnet(infoHash, name = '') {
  let m = `magnet:?xt=urn:btih:${infoHash}`
  if (name) m += `&dn=${encodeURIComponent(name)}`
  for (const tr of EXTRA_TRACKERS) m += `&tr=${encodeURIComponent(tr)}`
  return m
}

function extractInfoHash(magnet) {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i)
  return m ? m[1].toLowerCase() : null
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXPRESS + WEBTORRENT SETUP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const app = express()
app.use(cors({
  origin: ALLOWED_ORIGINS,
  exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
}))
app.use(express.json())

const frontendDist = path.join(__dirname, 'public')
app.use(express.static(frontendDist))

function createClient() {
  const c = new WebTorrent({
    dht: {
      bootstrap: [
        'router.bittorrent.com:6881',
        'router.utorrent.com:6881',
        'dht.transmissionbt.com:6881',
        'dht.libtorrent.org:25401',
      ],
    },
  })
  c.on('error', err => console.error('[wt]', err.message))
  return c
}

let client = createClient()
function getClient() {
  if (client.destroyed) { console.log('[wt] recreating'); client = createClient() }
  return client
}

const torrents = new Map()

function resetTTL(h) {
  const e = torrents.get(h)
  if (!e) return
  clearTimeout(e.timer)
  e.timer = setTimeout(() => {
    console.log(`[evict] ${h}`)
    try { e.torrent.destroy() } catch (_) {}
    torrents.delete(h)
  }, TORRENT_TTL)
}

function evictOldest() {
  if (torrents.size < MAX_TORRENTS) return
  let oldest = null, t = Infinity
  for (const [h, e] of torrents) { if (e.addedAt < t) { t = e.addedAt; oldest = h } }
  if (oldest) { try { torrents.get(oldest).torrent.destroy() } catch (_) {} torrents.delete(oldest) }
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchBuffer(res.headers.location).then(resolve).catch(reject)
      if (res.statusCode !== 200) { res.destroy(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function fetchTorrentBuffer(infoHash, sendStatus) {
  const sources = [
    `https://itorrents.org/torrent/${infoHash.toUpperCase()}.torrent`,
    `https://thetorrent.org/${infoHash.toUpperCase()}.torrent`,
    `https://torrage.info/torrent.php?h=${infoHash}`,
  ]
  for (const url of sources) {
    try {
      sendStatus(`Fetching metadata from ${new URL(url).hostname}…`)
      const buf = await fetchBuffer(url)
      if (buf && buf.length > 200) { console.log(`[meta] ${buf.length}b from ${url}`); return buf }
    } catch (e) { console.log(`[meta] ${new URL(url).hostname}: ${e.message}`) }
  }
  return null
}

function waitReady(torrent) {
  return new Promise((resolve, reject) => {
    if (torrent.ready) return resolve(torrent)
    const t = setTimeout(() => reject(new Error('Torrent ready timeout')), 60_000)
    torrent.once('ready', () => { clearTimeout(t); resolve(torrent) })
    torrent.once('error', err => { clearTimeout(t); reject(err) })
  })
}

function waitForPeers(torrent, timeoutMs, onProgress) {
  return new Promise((resolve, reject) => {
    if (torrent.numPeers > 0) return resolve(torrent.numPeers)
    const iv = setInterval(() => {
      const p = torrent.numPeers
      onProgress?.(`Waiting for peers… ${p} connected`)
      if (p > 0) { clearInterval(iv); clearTimeout(to); resolve(p) }
    }, 2000)
    const to = setTimeout(() => { clearInterval(iv); reject(new Error(`No peers after ${timeoutMs / 1000}s`)) }, timeoutMs)
  })
}

async function getOrAdd(hashOrMagnet, sendStatus, torrentUrl = null) {
  const infoHash = hashOrMagnet.startsWith('magnet:')
    ? extractInfoHash(hashOrMagnet)
    : hashOrMagnet.toLowerCase().startsWith('http')
      ? null
      : hashOrMagnet.toLowerCase()

  if (infoHash && torrents.has(infoHash)) { resetTTL(infoHash); return waitReady(torrents.get(infoHash).torrent) }
  const ex = infoHash && getClient().torrents.find(t => t.infoHash === infoHash)
  if (ex) { torrents.set(infoHash, { torrent: ex, timer: null, addedAt: Date.now() }); resetTTL(infoHash); return waitReady(ex) }

  evictOldest()
  let buf = null

  if (torrentUrl) {
    try {
      sendStatus(`Fetching .torrent from ${new URL(torrentUrl).hostname}…`)
      const b = await fetchBuffer(torrentUrl)
      if (b && b.length > 200) buf = b
    } catch (e) { console.log('[torrent_url]', e.message) }
  }

  if (!buf && infoHash) buf = await fetchTorrentBuffer(infoHash, sendStatus)

  sendStatus('Connecting to BitTorrent swarm…')
  const input = buf
    || (hashOrMagnet.startsWith('magnet:') ? hashOrMagnet
    : infoHash ? `magnet:?xt=urn:btih:${infoHash}`
    : null)

  if (!input) throw new Error('No magnet, infoHash, or .torrent available')

  const torrent = getClient().add(input, { strategy: 'sequential' })
  const hb = buf ? null : setInterval(() => sendStatus(`Fetching metadata… ${torrent.numPeers} peers`), 4000)
  try {
    await waitReady(torrent)
    if (hb) clearInterval(hb)
  } catch (e) {
    if (hb) clearInterval(hb)
    try { torrent.destroy() } catch (_) {}
    throw e
  }

  const h = torrent.infoHash
  console.log(`[ready] "${torrent.name}" peers=${torrent.numPeers}`)
  console.log(`[files] ${torrent.files.map((f, i) => `[${i}] ${f.name} (${(f.length / 1e6).toFixed(1)}MB)`).join(' | ')}`)
  torrents.set(h, { torrent, timer: null, addedAt: Date.now() })
  resetTTL(h)
  return torrent
}

const isPlayable = name => ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.mp3', '.flac', '.aac', '.ogg', '.wav'].some(ext => name.toLowerCase().endsWith(ext))
const isSubtitle = name => ['.srt', '.vtt', '.ass', '.ssa', '.sub'].some(ext => name.toLowerCase().endsWith(ext))
const MIME = {
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
  avi: 'video/x-msvideo', mov: 'video/quicktime', m4v: 'video/mp4',
  mp3: 'audio/mpeg', flac: 'audio/flac', aac: 'audio/aac', ogg: 'audio/ogg', wav: 'audio/wav',
  srt: 'text/plain', vtt: 'text/vtt', ass: 'text/plain', ssa: 'text/plain',
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TMDB HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TMDB_KEY  = process.env.TMDB_API_KEY || '863132acc2bd530a41f149bc37736902'
const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_IMG  = 'https://image.tmdb.org/t/p'

const MOVIE_GENRES = {
  28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',
  99:'Documentary',18:'Drama',10751:'Family',14:'Fantasy',36:'History',
  27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Sci-Fi',
  10770:'TV Movie',53:'Thriller',10752:'War',37:'Western',
}
const TV_GENRES = {
  10759:'Action & Adventure',16:'Animation',35:'Comedy',80:'Crime',
  99:'Documentary',18:'Drama',10751:'Family',10762:'Kids',9648:'Mystery',
  10763:'News',10764:'Reality',10765:'Sci-Fi & Fantasy',10766:'Soap',
  10767:'Talk',10768:'War & Politics',37:'Western',
}

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
}

async function tmdbFetch(endpoint, params = {}, cache = tmdbBrowseCache, ttl = TMDB_BROWSE_TTL) {
  const cacheKey = `tmdb:${endpoint}:${JSON.stringify(params)}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached

  return coalesce(cacheKey, async () => {
    const url = new URL(`${TMDB_BASE}${endpoint}`)
    url.searchParams.set('api_key', TMDB_KEY)
    url.searchParams.set('language', 'en-US')
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    try {
      const r = await fetch(url.toString(), {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) { console.log(`[tmdb] ${endpoint} → HTTP ${r.status}`); return null }
      const data = await r.json()
      cache.set(cacheKey, data, ttl)
      return data
    } catch (e) {
      console.log(`[tmdb] ${endpoint}: ${e.message}`)
      return null
    }
  })
}

function imgUrl(filePath, size = 'w500') {
  return filePath ? `${TMDB_IMG}/${size}${filePath}` : null
}

function formatTMDBCard(item) {
  const isMovie = item.media_type ? item.media_type === 'movie' : !!item.title
  return {
    tmdbId:      item.id,
    mediaType:   isMovie ? 'movie' : 'tv',
    title:       item.title || item.name,
    overview:    item.overview || null,
    year:        (item.release_date || item.first_air_date || '').slice(0, 4) || null,
    tmdbRating:  item.vote_average ? Math.round(item.vote_average * 10) / 10 : null,
    tmdbVotes:   item.vote_count || null,
    popularity:  item.popularity || null,
    poster:      imgUrl(item.poster_path, 'w500'),
    posterThumb: imgUrl(item.poster_path, 'w185'),
    backdrop:    imgUrl(item.backdrop_path, 'w1280'),
    genreIds:    item.genre_ids || [],
    language:    item.original_language || null,
  }
}

async function enrichTMDBItem(item) {
  const isMovie   = item.media_type ? item.media_type === 'movie' : !!item.title
  const mediaType = isMovie ? 'movie' : 'tv'
  const id        = item.id

  try {
    const [details, credits, videos, releaseDates] = await Promise.all([
      tmdbFetch(`/${mediaType}/${id}`, { append_to_response: 'external_ids' }, tmdbDetailCache, TMDB_DETAIL_TTL),
      tmdbFetch(`/${mediaType}/${id}/credits`, {}, tmdbDetailCache, TMDB_DETAIL_TTL),
      tmdbFetch(`/${mediaType}/${id}/videos`, {}, tmdbDetailCache, TMDB_DETAIL_TTL),
      isMovie
        ? tmdbFetch(`/movie/${id}/release_dates`, {}, tmdbDetailCache, TMDB_DETAIL_TTL)
        : tmdbFetch(`/tv/${id}/content_ratings`, {}, tmdbDetailCache, TMDB_DETAIL_TTL),
    ])

    if (!details) return formatTMDBCard(item)

    const genreMap = isMovie ? MOVIE_GENRES : TV_GENRES
    const genres   = (details.genres || []).map(g => g.name || genreMap[g.id]).filter(Boolean)
    const cast     = (credits?.cast || []).slice(0, 8).map(p => ({
      name:      p.name,
      character: p.character,
      photo:     imgUrl(p.profile_path, 'w185'),
      tmdbId:    p.id,
    }))
    const crew     = credits?.crew || []
    const director = isMovie
      ? crew.find(p => p.job === 'Director')?.name || null
      : (details.created_by || [])[0]?.name || null

    let certification = null
    if (isMovie) {
      const us = (releaseDates?.results || []).find(r => r.iso_3166_1 === 'US')
      certification = us?.release_dates?.find(d => d.certification)?.certification || null
    } else {
      const us = (releaseDates?.results || []).find(r => r.iso_3166_1 === 'US')
      certification = us?.rating || null
    }

    const trailer = (videos?.results || [])
      .filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
      .sort((a, b) => (a.type === 'Trailer' ? -1 : 1))[0]

    const base = {
      tmdbId:        details.id,
      mediaType,
      title:         details.title || details.name,
      originalTitle: details.original_title || details.original_name || null,
      overview:      details.overview || null,
      tagline:       details.tagline || null,
      year:          (details.release_date || details.first_air_date || '').slice(0, 4) || null,
      releaseDate:   details.release_date || details.first_air_date || null,
      genres,
      genreIds:      (details.genres || []).map(g => g.id),
      cast,
      director,
      certification,
      tmdbRating:    details.vote_average ? Math.round(details.vote_average * 10) / 10 : null,
      tmdbVotes:     details.vote_count || null,
      popularity:    details.popularity || null,
      imdbId:        details.external_ids?.imdb_id || null,
      runtime:       details.runtime || (details.episode_run_time || [])[0] || null,
      status:        details.status || null,
      language:      details.original_language || null,
      poster:        imgUrl(details.poster_path, 'w500'),
      posterThumb:   imgUrl(details.poster_path, 'w185'),
      backdrop:      imgUrl(details.backdrop_path, 'w1280'),
      backdropFull:  imgUrl(details.backdrop_path, 'original'),
      trailer:       trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
      trailerKey:    trailer?.key || null,
    }

    if (isMovie) {
      return {
        ...base,
        budget:  details.budget || null,
        revenue: details.revenue || null,
        collection: details.belongs_to_collection ? {
          id:     details.belongs_to_collection.id,
          name:   details.belongs_to_collection.name,
          poster: imgUrl(details.belongs_to_collection.poster_path, 'w342'),
        } : null,
      }
    }

    const seasonCount   = details.number_of_seasons || 0
    const seasonNumbers = Array.from({ length: seasonCount }, (_, i) => i + 1)
    const seasons = []
    for (let i = 0; i < seasonNumbers.length; i += 5) {
      const batch = await Promise.all(
        seasonNumbers.slice(i, i + 5).map(sn =>
          tmdbFetch(`/tv/${id}/season/${sn}`, {}, tmdbDetailCache, TMDB_DETAIL_TTL)
        )
      )
      for (const s of batch) {
        if (!s) continue
        seasons.push({
          seasonNumber: s.season_number,
          name:         s.name,
          overview:     s.overview || null,
          airDate:      s.air_date || null,
          episodeCount: s.episodes?.length || 0,
          poster:       imgUrl(s.poster_path, 'w342'),
          episodes: (s.episodes || []).map(ep => ({
            episodeNumber: ep.episode_number,
            name:          ep.name,
            overview:      ep.overview || null,
            airDate:       ep.air_date || null,
            runtime:       ep.runtime || null,
            stillPath:     imgUrl(ep.still_path, 'w300'),
            tmdbRating:    ep.vote_average ? Math.round(ep.vote_average * 10) / 10 : null,
          })),
        })
      }
    }

    return {
      ...base,
      totalSeasons:   seasonCount,
      totalEpisodes:  details.number_of_episodes || null,
      networks: (details.networks || []).map(n => ({
        id:   n.id,
        name: n.name,
        logo: imgUrl(n.logo_path, 'w92'),
      })),
      lastAirDate:     details.last_air_date || null,
      nextEpisodeDate: details.next_episode_to_air?.air_date || null,
      inProduction:    details.in_production || false,
      seasonData:      seasons,
    }
  } catch (e) {
    console.log(`[enrich ${id}]`, e.message)
    return formatTMDBCard(item)
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TORRENT SEARCH PROVIDERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function safeJSON(response, source) {
  const ct = response.headers.get('content-type') || ''
  if (!response.ok) { console.log(`[${source}] HTTP ${response.status}`); return null }
  if (!ct.includes('json') && !ct.includes('text/plain')) {
    console.log(`[${source}] Non-JSON (${ct.split(';')[0]})`)
    return null
  }
  try { return await response.json() } catch { return null }
}

function parseSize(str) {
  if (!str) return null
  const m = String(str).match(/([\d.]+)\s*(TB|TiB|GB|GiB|MB|MiB|KB|KiB)/i)
  if (!m) return null
  const n = parseFloat(m[1])
  const u = m[2].toUpperCase()
  if (u.startsWith('T')) return Math.round(n * 1e12)
  if (u.startsWith('G')) return Math.round(n * 1e9)
  if (u.startsWith('M')) return Math.round(n * 1e6)
  if (u.startsWith('K')) return Math.round(n * 1e3)
  return null
}

function torrentItem(overrides) {
  const s = Math.max(0, parseInt(overrides.seeders) || 0)
  const l = Math.max(0, parseInt(overrides.leechers) || 0)
  return {
    id:           null,
    title:        'Unknown',
    magnet_link:  null,
    torrent_url:  null,
    size_bytes:   null,
    seeders:      s,
    leechers:     l,
    category:     null,
    source:       'unknown',
    providers:    [],
    health_score: healthScore(s, l),
    poster:       null,
    ...overrides,
    seeders:      s,
    leechers:     l,
    health_score: healthScore(s, l),
  }
}

async function searchKnaben(query, limit) {
  try {
    const r = await fetch('https://api.knaben.org/v1', {
      method: 'POST',
      headers: { ...FETCH_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        search_type: '100%', search_field: 'title', query,
        from: 0, size: limit, order_by: 'seeders', order_direction: 'desc',
        hide_unsafe: false, hide_xxx: true,
      }),
      signal: AbortSignal.timeout(12000),
    })
    const json = await safeJSON(r, 'knaben')
    if (!json) return []
    return (json.hits || []).flatMap(item => {
      if (!item.hash) return []
      const hash = item.hash.toLowerCase()
      return [torrentItem({
        id: hash, title: item.title || 'Unknown',
        magnet_link: item.magnetUrl || buildMagnet(hash, item.title),
        size_bytes: item.bytes || null, seeders: item.seeders, leechers: item.peers,
        category: item.category || null, source: 'knaben', providers: ['knaben'],
      })]
    })
  } catch (e) { console.log('[knaben]', e.message); return [] }
}

async function searchPirateBay(query, limit) {
  try {
    const r = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`, {
      headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000),
    })
    const json = await safeJSON(r, 'piratebay')
    if (!json) return []
    const catMap = { '201':'Movie','202':'Movie','205':'TV','100':'Audio','200':'Video','300':'Apps','400':'Games' }
    return json.slice(0, limit).flatMap(item => {
      if (!item.info_hash || item.name === 'No results returned') return []
      return [torrentItem({
        id: item.info_hash.toLowerCase(), title: item.name,
        magnet_link: buildMagnet(item.info_hash, item.name),
        size_bytes: parseInt(item.size) || null, seeders: item.seeders, leechers: item.leechers,
        category: catMap[item.category] || null, source: 'piratebay', providers: ['piratebay'],
      })]
    })
  } catch (e) { console.log('[piratebay]', e.message); return [] }
}

async function searchYTS(query, limit) {
  try {
    const r = await fetch(
      `https://yts.si/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=${Math.min(limit, 50)}&sort_by=seeds`,
      { headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000) }
    )
    const json = await safeJSON(r, 'yts')
    if (!json || json.data?.movie_count === 0) return []
    return (json.data?.movies || []).flatMap(movie =>
      (movie.torrents || []).map(t => {
        const title = `${movie.title} (${movie.year}) [${t.quality}] [${t.type}]`
        return torrentItem({
          id: t.hash.toLowerCase(), title,
          magnet_link: buildMagnet(t.hash, title),
          size_bytes: t.size_bytes || null, seeders: t.seeds, leechers: t.peers,
          category: 'Movie', source: 'yts', providers: ['yts'],
          poster: movie.medium_cover_image || null,
        })
      })
    ).slice(0, limit)
  } catch (e) { console.log('[yts]', e.message); return [] }
}

async function searchEZTV(query, limit) {
  try {
    const r = await fetch(
      `https://eztv.to/api/get-torrents?limit=${Math.min(limit * 3, 100)}&page=1`,
      { headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000) }
    )
    const json = await safeJSON(r, 'eztv')
    if (!json) return []
    const q = query.toLowerCase()
    return (json.torrents || [])
      .filter(t => t.title?.toLowerCase().includes(q) || t.filename?.toLowerCase().includes(q))
      .slice(0, limit)
      .map(t => torrentItem({
        id: t.hash.toLowerCase(), title: t.title || t.filename || 'Unknown',
        magnet_link: t.magnet_url || buildMagnet(t.hash, t.title),
        size_bytes: parseInt(t.size_bytes) || null, seeders: t.seeds, leechers: t.peers,
        category: 'TV', source: 'eztv', providers: ['eztv'],
      }))
  } catch (e) { console.log('[eztv]', e.message); return [] }
}

async function searchTorrentsCsv(query, limit) {
  try {
    const r = await fetch(
      `https://torrents-csv.com/service/search?q=${encodeURIComponent(query)}&size=${limit}&page=0`,
      { headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000) }
    )
    const json = await safeJSON(r, 'torrents-csv')
    if (!json) return []
    return (json.torrents || []).slice(0, limit).map(t => torrentItem({
      id: t.infohash.toLowerCase(), title: t.name || 'Unknown',
      magnet_link: buildMagnet(t.infohash, t.name),
      size_bytes: t.size_bytes || null, seeders: t.seeders, leechers: t.leechers,
      source: 'torrents-csv', providers: ['torrents-csv'],
    }))
  } catch (e) { console.log('[torrents-csv]', e.message); return [] }
}

const PROXY_PROVIDERS = ['rarbg', 'nyaasi', 'kickass', 'glodls', 'torrentfunk']

async function searchViaProxy(provider, query, limit) {
  try {
    const url = `https://torrent-search-api-murex.vercel.app/api/${provider}/${encodeURIComponent(query)}/1`
    const r = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(15000) })
    const json = await safeJSON(r, provider)
    if (!json || !Array.isArray(json)) return []
    return json.slice(0, limit).flatMap(item => {
      const magnet     = item.Magnet || item.magnet || ''
      const name       = item.Name || item.name || item.title || 'Unknown'
      const torrentUrl = item.TorrentUrl || item.torrent_url || item.Torrent || item.torrent || ''
      const infoHash   = magnet ? extractInfoHash(magnet) : null
      if (!infoHash && !magnet && !torrentUrl) return []
      return [torrentItem({
        id: infoHash || torrentUrl, title: name,
        magnet_link: magnet || null, torrent_url: torrentUrl || null,
        size_bytes: parseSize(item.Size || item.size || ''),
        seeders: item.Seeders || item.seeders || 0,
        leechers: item.Leechers || item.leechers || 0,
        category: item.Category || item.category || null,
        source: provider, providers: [provider],
        poster: item.Poster || item.poster || null,
      })]
    })
  } catch (e) { console.log(`[${provider}]`, e.message); return [] }
}

const BLOCKED_CATEGORIES = new Set(['software','games','game','apps','application','books','ebooks','xxx','adult','other'])
const BLOCKED_TITLE_RE   = /\.(exe|zip|rar|iso|apk|dmg|pkg|deb|rpm|msi|pdf|epub|mobi|azw)$|\b(crack|keygen|patch|activator|serial|license\.key)\b/i

function looksLikeMedia(item) {
  const cat = (item.category || '').toLowerCase()
  if ([...BLOCKED_CATEGORIES].some(b => cat.includes(b))) return false
  if (BLOCKED_TITLE_RE.test(item.title || '')) return false
  return true
}

async function aggregateTorrents(query, limitPerProvider = 20) {
  const directSearches = [
    searchKnaben(query, limitPerProvider),
    searchPirateBay(query, limitPerProvider),
    searchTorrentsCsv(query, limitPerProvider),
  ]
  const proxySearches = PROXY_PROVIDERS.map(p => searchViaProxy(p, query, limitPerProvider))
  const settled = await Promise.allSettled([...directSearches, ...proxySearches])

  const byHash = new Map()
  const byId   = new Map()

  for (const r of settled) {
    if (r.status !== 'fulfilled') continue
    for (const item of r.value) {
      if (!item.id) continue
      const key    = item.id.toLowerCase()
      const isHash = /^[a-f0-9]{40}$|^[a-z2-7]{32}$/i.test(key)
      const store  = isHash ? byHash : byId

      if (!store.has(key)) {
        store.set(key, { ...item, providers: [...(item.providers || [item.source])] })
      } else {
        const existing = store.get(key)
        for (const p of (item.providers || [item.source])) {
          if (!existing.providers.includes(p)) existing.providers.push(p)
        }
        if (item.seeders > existing.seeders) {
          existing.seeders      = item.seeders
          existing.leechers     = item.leechers
          existing.health_score = item.health_score
          existing.size_bytes   = item.size_bytes || existing.size_bytes
          existing.magnet_link  = item.magnet_link || existing.magnet_link
        }
      }
    }
  }
  return [...byHash.values(), ...byId.values()].filter(looksLikeMedia)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/search/torrents', async (req, res) => {
  const q = req.query.q?.trim()
  if (!q) return res.status(400).json({ error: 'q param required' })
  const limitPerProvider = Math.min(parseInt(req.query.per_provider) || 20, 50)
  const page    = Math.max(parseInt(req.query.page) || 1, 1)
  const perPage = Math.min(parseInt(req.query.limit) || 50, 200)
  const sortBy  = req.query.sort || 'health'
  const cacheKey = `torrents:${q}:${limitPerProvider}`
  let allResults = torrentSearchCache.get(cacheKey)
  const wasCached = allResults !== undefined
  if (!allResults) {
    try {
      allResults = await aggregateTorrents(q, limitPerProvider)
      torrentSearchCache.set(cacheKey, allResults, TORRENT_CACHE_TTL)
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }
  const sorted = sortBy === 'seeders'
    ? [...allResults].sort((a, b) => b.seeders - a.seeders)
    : [...allResults].sort((a, b) => b.health_score !== a.health_score ? b.health_score - a.health_score : b.seeders - a.seeders)
  const start = (page - 1) * perPage
  const paged = sorted.slice(start, start + perPage)
  res.json({
    query: q, total: sorted.length, page, per_page: perPage,
    total_pages: Math.ceil(sorted.length / perPage),
    providers_queried: ['knaben', 'piratebay', 'yts', 'eztv', 'torrents-csv', ...PROXY_PROVIDERS],
    cached: wasCached, results: paged,
  })
})

app.get('/api/search/tmdb', async (req, res) => {
  if (!TMDB_KEY) return res.status(503).json({ error: 'TMDB_API_KEY not configured' })
  const q = req.query.q?.trim()
  if (!q) return res.status(400).json({ error: 'q param required' })
  const type = ['movie','tv','multi'].includes(req.query.type) ? req.query.type : 'multi'
  const page = Math.max(parseInt(req.query.page) || 1, 1)
  const year = req.query.year || null
  const cacheKey = `tmdb-search:${q}:${type}:${page}:${year}`
  const cached = tmdbSearchCache.get(cacheKey)
  if (cached) return res.json({ ...cached, cached: true })
  try {
    const endpoint = type === 'multi' ? '/search/multi' : `/search/${type}`
    const params = { query: q, page, include_adult: false }
    if (year) params.year = year
    const json = await tmdbFetch(endpoint, params, tmdbSearchCache, TMDB_SEARCH_TTL)
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    const items = (json.results || []).filter(r =>
      type === 'multi' ? (r.media_type === 'movie' || r.media_type === 'tv') : true
    )
    const enriched = []
    for (let i = 0; i < items.length; i += 5) {
      const batch = await Promise.all(items.slice(i, i + 5).map(item => enrichTMDBItem(item)))
      enriched.push(...batch)
    }
    const payload = { query: q, type, page: json.page, total_pages: json.total_pages, total_results: json.total_results, results: enriched }
    tmdbSearchCache.set(cacheKey, payload, TMDB_SEARCH_TTL)
    res.json({ ...payload, cached: false })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/tmdb/:type/:id', async (req, res) => {
  if (!TMDB_KEY) return res.status(503).json({ error: 'TMDB_API_KEY not configured' })
  const { type, id } = req.params
  if (!['movie', 'tv'].includes(type)) return res.status(400).json({ error: 'type must be movie or tv' })
  const cacheKey = `tmdb-detail:${type}:${id}`
  const cached = tmdbDetailCache.get(cacheKey)
  if (cached) return res.json({ ...cached, cached: true })
  try {
    const result = await enrichTMDBItem({ id: parseInt(id), media_type: type })
    if (!result?.tmdbId) return res.status(404).json({ error: 'Not found on TMDB' })
    const similar = await tmdbFetch(`/${type}/${id}/similar`, { page: 1 }, tmdbDetailCache, TMDB_DETAIL_TTL)
    result.similar = (similar?.results || []).slice(0, 12).map(formatTMDBCard)
    tmdbDetailCache.set(cacheKey, result, TMDB_DETAIL_TTL)
    res.json({ ...result, cached: false })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/tmdb/tv/:id/season/:season', async (req, res) => {
  if (!TMDB_KEY) return res.status(503).json({ error: 'TMDB_API_KEY not configured' })
  const { id, season } = req.params
  try {
    const data = await tmdbFetch(`/tv/${id}/season/${season}`, {}, tmdbDetailCache, TMDB_DETAIL_TTL)
    if (!data) return res.status(404).json({ error: 'Season not found' })
    res.json({
      seasonNumber: data.season_number, name: data.name,
      overview: data.overview || null, airDate: data.air_date || null,
      poster: imgUrl(data.poster_path, 'w342'),
      episodes: (data.episodes || []).map(ep => ({
        episodeNumber: ep.episode_number, name: ep.name,
        overview: ep.overview || null, airDate: ep.air_date || null,
        runtime: ep.runtime || null, stillPath: imgUrl(ep.still_path, 'w300'),
        tmdbRating: ep.vote_average ? Math.round(ep.vote_average * 10) / 10 : null,
        guestStars: (ep.guest_stars || []).slice(0, 4).map(p => ({
          name: p.name, character: p.character, photo: imgUrl(p.profile_path, 'w185'),
        })),
      })),
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/trending', async (req, res) => {
  try {
    const json = await tmdbFetch(`/trending/${req.query.type || 'all'}/${req.query.window || 'week'}`, { page: parseInt(req.query.page) || 1 })
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    res.json({ page: json.page, total_pages: json.total_pages, total_results: json.total_results, results: (json.results || []).map(formatTMDBCard) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/popular', async (req, res) => {
  try {
    const json = await tmdbFetch(`/${req.query.type || 'movie'}/popular`, { page: parseInt(req.query.page) || 1 })
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    res.json({ page: json.page, total_pages: json.total_pages, total_results: json.total_results, results: (json.results || []).map(formatTMDBCard) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/toprated', async (req, res) => {
  try {
    const json = await tmdbFetch(`/${req.query.type || 'movie'}/top_rated`, { page: parseInt(req.query.page) || 1 })
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    res.json({ page: json.page, total_pages: json.total_pages, total_results: json.total_results, results: (json.results || []).map(formatTMDBCard) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/upcoming', async (req, res) => {
  try {
    const json = await tmdbFetch('/movie/upcoming', { page: parseInt(req.query.page) || 1 })
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    res.json({ page: json.page, total_pages: json.total_pages, results: (json.results || []).map(formatTMDBCard) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/nowplaying', async (req, res) => {
  try {
    const json = await tmdbFetch('/movie/now_playing', { page: parseInt(req.query.page) || 1 })
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    res.json({ page: json.page, total_pages: json.total_pages, results: (json.results || []).map(formatTMDBCard) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/discover', async (req, res) => {
  const type = req.query.type || 'movie'
  const page = parseInt(req.query.page) || 1
  const params = { page, sort_by: req.query.sort || 'popularity.desc' }
  if (req.query.genre)     params.with_genres = req.query.genre
  if (req.query.year)      params[type === 'movie' ? 'primary_release_year' : 'first_air_date_year'] = req.query.year
  if (req.query.yearMin)   params[type === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte'] = `${req.query.yearMin}-01-01`
  if (req.query.yearMax)   params[type === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte'] = `${req.query.yearMax}-12-31`
  if (req.query.ratingMin) params['vote_average.gte'] = req.query.ratingMin
  if (req.query.ratingMax) params['vote_average.lte'] = req.query.ratingMax
  if (req.query.language)  params.with_original_language = req.query.language
  if (req.query.voteMin)   params['vote_count.gte'] = req.query.voteMin || 100
  try {
    const json = await tmdbFetch(`/discover/${type}`, params)
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    res.json({ page: json.page, total_pages: json.total_pages, total_results: json.total_results, results: (json.results || []).map(formatTMDBCard) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/genres', (req, res) => {
  res.json({
    movie: Object.entries(MOVIE_GENRES).map(([id, name]) => ({ id: parseInt(id), name })),
    tv:    Object.entries(TV_GENRES).map(([id, name]) => ({ id: parseInt(id), name })),
  })
})

app.get('/api/homepage', async (req, res) => {
  if (!TMDB_KEY) return res.status(503).json({ error: 'TMDB_API_KEY not configured' })
  try {
    const [trending, popularMovies, popularTV, topRatedMovies, topRatedTV, upcoming] = await Promise.allSettled([
      tmdbFetch('/trending/all/week', { page: 1 }),
      tmdbFetch('/movie/popular', { page: 1 }),
      tmdbFetch('/tv/popular', { page: 1 }),
      tmdbFetch('/movie/top_rated', { page: 1 }),
      tmdbFetch('/tv/top_rated', { page: 1 }),
      tmdbFetch('/movie/upcoming', { page: 1 }),
    ])
    const extract = r => r.status === 'fulfilled' && r.value ? (r.value.results || []).map(formatTMDBCard) : []
    res.json({
      trending: extract(trending).slice(0, 20),
      popularMovies: extract(popularMovies).slice(0, 20),
      popularTV: extract(popularTV).slice(0, 20),
      topRatedMovies: extract(topRatedMovies).slice(0, 20),
      topRatedTV: extract(topRatedTV).slice(0, 20),
      upcoming: extract(upcoming).slice(0, 20),
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/resolve', (req, res) => {
  const { magnet } = req.query
  if (!magnet?.startsWith('magnet:?')) return res.status(400).json({ error: 'Invalid magnet link' })
  const infoHash = extractInfoHash(magnet)
  if (!infoHash) return res.status(400).json({ error: 'Missing info hash' })
  const dn = magnet.match(/[&?]dn=([^&]+)/)?.[1]
  const title = dn ? decodeURIComponent(dn.replace(/\+/g, ' ')) : 'Unknown Torrent'
  res.json(torrentItem({ id: infoHash, title, magnet_link: magnet, source: 'direct', providers: ['direct'] }))
})

app.get('/api/info', async (req, res) => {
  const { magnet, infoHash: hashParam, torrent_url } = req.query
  if (!magnet && !hashParam) return res.status(400).json({ error: 'magnet or infoHash param required' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  let closed = false
  req.on('close', () => { closed = true })
  const send = (ev, data) => { if (!closed && !res.writableEnded) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`) }
  const sendStatus = msg => { console.log(`[status] ${msg}`); send('status', { message: msg }) }

  try {
    const torrent = await getOrAdd(hashParam || magnet, sendStatus, torrent_url)
    sendStatus(`Found ${torrent.numPeers} peers — waiting for data connection…`)
    await waitForPeers(torrent, 60_000, sendStatus)
    resetTTL(torrent.infoHash)

    const files = torrent.files.map((f, i) => ({
      index: i, name: f.name, path: f.path, length: f.length,
      playable: isPlayable(f.name), subtitle: isSubtitle(f.name),
      ext: f.name.split('.').pop().toLowerCase(),
    }))
    const playableFiles = files.filter(f => f.playable).sort((a, b) => b.length - a.length)
    const subtitleFiles = files.filter(f => f.subtitle)

    send('ready', {
      infoHash: torrent.infoHash, name: torrent.name, length: torrent.length,
      files, peers: torrent.numPeers,
      playableIndex: playableFiles[0]?.index ?? -1,
      subtitles: subtitleFiles,
    })
  } catch (err) {
    console.error('[/api/info]', err.message)
    send('error', { error: err.message })
  }
  res.end()
})

app.get('/api/stream', async (req, res) => {
  const { magnet, infoHash: hashParam, torrent_url, file: fileIndexStr } = req.query
  if (!magnet && !hashParam) return res.status(400).json({ error: 'infoHash or magnet required' })

  try {
    const torrent = await getOrAdd(hashParam || magnet, () => {}, torrent_url)
    resetTTL(torrent.infoHash)

    if (torrent.numPeers === 0) {
      try { await waitForPeers(torrent, 30_000, () => {}) } catch (_) {
        return res.status(503).json({ error: 'No peers available — try again shortly' })
      }
    }

    const fileIndex = parseInt(fileIndexStr ?? '0', 10)
    if (fileIndex < 0 || fileIndex >= torrent.files.length)
      return res.status(404).json({ error: `File index ${fileIndex} out of range` })

    const file = torrent.files[fileIndex]
    torrent.files.forEach((f, i) => i === fileIndex ? f.select() : f.deselect())

    const fileLength = file.length
    const ext = file.name.split('.').pop().toLowerCase()
    const mime = MIME[ext] || 'application/octet-stream'
    const range = req.headers.range
    console.log(`[stream] "${file.name}" peers=${torrent.numPeers} range=${range || 'none'}`)

    const makeStream = opts => {
      const s = file.createReadStream(opts)
      s.on('error', err => {
        if (!err.message.includes('Writable stream closed prematurely'))
          console.error('[stream err]', err.message)
      })
      return s
    }

    if (range) {
      const [s, e] = range.replace(/bytes=/, '').split('-')
      const start = parseInt(s, 10)
      const end = e ? parseInt(e, 10) : fileLength - 1
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileLength}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime,
      })
      const stream = makeStream({ start, end })
      stream.pipe(res)
      req.on('close', () => stream.destroy())
    } else {
      res.writeHead(200, { 'Content-Length': fileLength, 'Content-Type': mime, 'Accept-Ranges': 'bytes' })
      const stream = makeStream()
      stream.pipe(res)
      req.on('close', () => stream.destroy())
    }
  } catch (err) {
    console.error('[/api/stream]', err.message)
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

app.get('/api/subtitle', async (req, res) => {
  const { infoHash, file: fileIndexStr } = req.query
  if (!infoHash) return res.status(400).json({ error: 'infoHash required' })
  try {
    const torrent = await getOrAdd(infoHash, () => {})
    const fileIndex = parseInt(fileIndexStr ?? '0', 10)
    if (fileIndex < 0 || fileIndex >= torrent.files.length)
      return res.status(404).json({ error: 'File not found' })
    const file = torrent.files[fileIndex]
    const ext = file.name.split('.').pop().toLowerCase()
    res.writeHead(200, {
      'Content-Type': ext === 'vtt' ? 'text/vtt' : 'text/plain',
      'Access-Control-Allow-Origin': '*',
    })
    file.createReadStream().pipe(res)
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OPENSUBTITLES INTEGRATION
//
// Source: OpenSubtitles.com REST API (api.opensubtitles.com)
// Auth:   Api-Key header only (no login needed for search+download)
//         Free tier: 5 downloads/day anonymous, 20/day with free account.
//         Set OPENSUBTITLES_API_KEY env var (get one free at opensubtitles.com)
//
// FLOW:
//   1. GET  /api/v1/subtitles?query=…&languages=en&tmdb_id=…  → list of results
//   2. POST /api/v1/download  { file_id }                      → temp download link
//   3. GET  {link}                                             → the .srt content
//
// ENDPOINTS ADDED:
//   GET  /api/subtitles/search   — search OpenSubtitles
//   GET  /api/subtitles/download — proxy subtitle content (avoids browser CORS)
//
// SEARCH PARAMS:
//   ?query=       movie/show title (required if no tmdb_id/imdb_id)
//   ?tmdb_id=     TMDB ID (most accurate)
//   ?imdb_id=     IMDb ID (e.g. tt1375666 or just 1375666)
//   ?season=      TV season number
//   ?episode=     TV episode number
//   ?languages=   comma-sep ISO 639-1 codes, default "en" (e.g. "en,fr,es")
//   ?type=        "movie" | "episode" | "all" (default: all)
//
// DOWNLOAD PARAMS:
//   ?file_id=     OpenSubtitles file_id from search results (required)
//   ?format=      "srt" | "vtt" (default: srt — server converts to VTT if needed)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const OS_API_KEY  = process.env.OPENSUBTITLES_API_KEY || 'vQLTlPHCpMzRzHOesjpbijBtjWa0P1Zi'
const OS_BASE     = 'https://api.opensubtitles.com/api/v1'
const OS_APP      = 'TorrentStreamServer v1.0'  // shown in OS developer dashboard

// In-memory caches
const osSearchCache   = new TTLCache()  // search results: 30 min
const osLinkCache     = new TTLCache()  // download links: 4 min (links expire ~10min)
const OS_SEARCH_TTL   = 30 * 60 * 1000
const OS_LINK_TTL     = 4 * 60 * 1000

// Build consistent OS request headers
function osHeaders(withAuth = false) {
  const h = {
    'Api-Key':      OS_API_KEY || 'undefined',
    'Content-Type': 'application/json',
    'Accept':       'application/json',
    'User-Agent':   OS_APP,
  }
  // If you have a user JWT token (from /login), add it here:
  // if (withAuth && OS_TOKEN) h['Authorization'] = `Bearer ${OS_TOKEN}`
  return h
}

// Search OpenSubtitles and return our normalised shape
async function searchOpenSubtitles({ query, tmdb_id, imdb_id, season, episode, languages = 'en', type }) {
  const cacheKey = `os:${query}:${tmdb_id}:${imdb_id}:${season}:${episode}:${languages}:${type}`
  const cached = osSearchCache.get(cacheKey)
  if (cached !== undefined) return cached

  return coalesce(cacheKey, async () => {
    const url = new URL(`${OS_BASE}/subtitles`)

    // Identifiers — prefer tmdb_id > imdb_id > query text
    if (tmdb_id)  url.searchParams.set('tmdb_id', String(tmdb_id))
    if (imdb_id) {
      // Strip leading 'tt' if present
      url.searchParams.set('imdb_id', String(imdb_id).replace(/^tt/i, ''))
    }
    if (query)    url.searchParams.set('query', query)

    // TV specifics
    if (season)   url.searchParams.set('season_number', String(season))
    if (episode)  url.searchParams.set('episode_number', String(episode))

    // Language filter — OS uses comma-separated ISO 639-1 (en,fr,es)
    url.searchParams.set('languages', languages)

    // Type filter
    if (type && type !== 'all') {
      url.searchParams.set('type', type)  // 'movie' or 'episode'
    }

    // Sort by download count so most-used subs appear first
    url.searchParams.set('order_by', 'download_count')
    url.searchParams.set('order_direction', 'desc')

    try {
      console.log(`[os] search: ${url.toString()}`)
      const r = await fetch(url.toString(), {
        headers: osHeaders(),
        signal: AbortSignal.timeout(10000),
      })

      if (r.status === 401) throw new Error('OpenSubtitles: invalid or missing API key')
      if (r.status === 429) throw new Error('OpenSubtitles: rate limit hit (5 downloads/day on free tier)')
      if (!r.ok) throw new Error(`OpenSubtitles: HTTP ${r.status}`)

      const json = await r.json()

      const results = (json.data || []).map(item => {
        const attr  = item.attributes || {}
        const files = attr.files || []
        const feat  = attr.feature_details || {}
        return {
          subtitle_id:      item.id,
          file_id:          files[0]?.file_id ?? null,    // required for /download
          file_name:        files[0]?.file_name ?? null,
          language:         attr.language,
          language_name:    LANG_NAMES[attr.language] || attr.language,
          download_count:   attr.download_count || 0,
          new_download_count: attr.new_download_count || 0,
          hearing_impaired: attr.hearing_impaired || false,
          hd:               attr.hd || false,
          fps:              attr.fps || null,
          ratings:          attr.ratings || null,
          votes:            attr.votes || 0,
          from_trusted:     attr.from_trusted || false,
          ai_translated:    attr.ai_translated || false,
          machine_translated: attr.machine_translated || false,
          release:          attr.release || null,
          upload_date:      attr.upload_date || null,
          uploader:         attr.uploader?.name || null,
          uploader_rank:    attr.uploader?.rank || null,
          feature_title:    feat.title || feat.movie_name || null,
          feature_year:     feat.year || null,
          feature_type:     feat.feature_type || null,    // 'Movie' | 'Episode' | 'Tvshow'
          season:           feat.season_number ?? null,
          episode:          feat.episode_number ?? null,
          imdb_id:          feat.imdb_id ? `tt${String(feat.imdb_id).padStart(7, '0')}` : null,
          tmdb_id:          feat.tmdb_id || null,
          url:              attr.url || null,
        }
      })

      osSearchCache.set(cacheKey, results, OS_SEARCH_TTL)
      return results
    } catch (e) {
      console.log(`[os] search failed: ${e.message}`)
      throw e
    }
  })
}

// Get a time-limited download URL from OpenSubtitles for a given file_id
// The link expires in ~10 minutes — we cache it for 4 min to allow retries
async function getOsDownloadLink(file_id) {
  const cacheKey = `os-link:${file_id}`
  const cached = osLinkCache.get(cacheKey)
  if (cached !== undefined) return cached

  console.log(`[os] requesting download link for file_id=${file_id}`)
  const r = await fetch(`${OS_BASE}/download`, {
    method: 'POST',
    headers: osHeaders(),
    body: JSON.stringify({ file_id: parseInt(file_id) }),
    signal: AbortSignal.timeout(10000),
  })

  if (r.status === 401) throw new Error('OpenSubtitles: invalid or missing API key')
  if (r.status === 406) throw new Error('OpenSubtitles: daily download quota reached (5/day free, 20/day with account)')
  if (r.status === 429) throw new Error('OpenSubtitles: rate limited — try again in a moment')
  if (!r.ok) throw new Error(`OpenSubtitles download link: HTTP ${r.status}`)

  const json = await r.json()
  if (!json.link) throw new Error('OpenSubtitles: no download link in response')

  const result = {
    link:       json.link,
    file_name:  json.file_name,
    remaining:  json.remaining,   // downloads left today
    reset_time: json.reset_time,  // UTC reset time
  }

  osLinkCache.set(cacheKey, result, OS_LINK_TTL)
  return result
}

// Convert SRT text → WebVTT text (server-side, so client gets VTT directly)
function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')  // timestamps: , → .
    .trim()
}

// Human-readable language names for common ISO 639-1 codes
const LANG_NAMES = {
  en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', zh: 'Chinese',
  ja: 'Japanese', ko: 'Korean', ar: 'Arabic', hi: 'Hindi', tr: 'Turkish',
  sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', cs: 'Czech',
  sk: 'Slovak', hu: 'Hungarian', ro: 'Romanian', bg: 'Bulgarian', uk: 'Ukrainian',
  he: 'Hebrew', fa: 'Persian', id: 'Indonesian', th: 'Thai', vi: 'Vietnamese',
  'pt-br': 'Portuguese (Brazil)', 'zh-cn': 'Chinese (Simplified)',
  'zh-tw': 'Chinese (Traditional)',
}

// ── ROUTE: Search OpenSubtitles ───────────────────────────────────────────────
//
// GET /api/subtitles/search
//   ?query=       text search (required if no tmdb_id/imdb_id)
//   ?tmdb_id=     TMDB ID (most accurate, use from TMDB search results)
//   ?imdb_id=     IMDb ID  (tt-prefixed or numeric)
//   ?season=      TV season number
//   ?episode=     TV episode number
//   ?languages=   comma-sep codes, default "en"
//   ?type=        "movie" | "episode" | "all"
//
// Response:
// {
//   query, total, cached,
//   results: [{
//     subtitle_id, file_id, file_name,
//     language, language_name,
//     download_count, hearing_impaired, hd,
//     from_trusted, ai_translated, machine_translated,
//     release, upload_date, uploader, uploader_rank,
//     feature_title, feature_year, feature_type,
//     season, episode, imdb_id, tmdb_id, url
//   }]
// }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/subtitles/search', async (req, res) => {
  const { query, tmdb_id, imdb_id, season, episode, type } = req.query
  const languages = req.query.languages || 'en'

  if (!query && !tmdb_id && !imdb_id) {
    return res.status(400).json({
      error: 'At least one of query, tmdb_id, or imdb_id is required',
    })
  }

  if (!OS_API_KEY) {
    return res.status(503).json({
      error: 'OpenSubtitles API key not configured. Set OPENSUBTITLES_API_KEY env var. Get a free key at https://www.opensubtitles.com/consumers',
    })
  }

  const cacheKey = `os-search-route:${query}:${tmdb_id}:${imdb_id}:${season}:${episode}:${languages}:${type}`
  const cached = osSearchCache.get(cacheKey)
  if (cached) return res.json({ ...cached, cached: true })

  try {
    const results = await searchOpenSubtitles({ query, tmdb_id, imdb_id, season, episode, languages, type })

    const payload = {
      query:     query || null,
      tmdb_id:   tmdb_id || null,
      imdb_id:   imdb_id || null,
      languages,
      total:     results.length,
      results,
    }
    osSearchCache.set(cacheKey, payload, OS_SEARCH_TTL)
    res.json({ ...payload, cached: false })
  } catch (err) {
    console.error('[subtitles/search]', err.message)
    res.status(502).json({ error: err.message })
  }
})

// ── ROUTE: Download / proxy a subtitle file ───────────────────────────────────
//
// GET /api/subtitles/download
//   ?file_id=   OpenSubtitles file_id (from search results)
//   ?format=    "srt" (default) or "vtt" (server converts)
//
// Returns the subtitle file content as text/plain or text/vtt.
// We proxy it server-side so the client avoids CORS issues with the
// time-limited OpenSubtitles CDN URLs.
//
// Rate limits (free tier): 5 downloads/day without account, 20/day with account.
// Set OPENSUBTITLES_API_KEY to use your account's quota.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/subtitles/download', async (req, res) => {
  const { file_id, format = 'srt' } = req.query
  if (!file_id) return res.status(400).json({ error: 'file_id required' })

  if (!OS_API_KEY) {
    return res.status(503).json({
      error: 'OpenSubtitles API key not configured. Set OPENSUBTITLES_API_KEY env var.',
    })
  }

  try {
    // Step 1: get time-limited download link
    const linkData = await getOsDownloadLink(file_id)

    // Step 2: fetch the actual subtitle content
    const r = await fetch(linkData.link, {
      headers: { 'User-Agent': OS_APP },
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) throw new Error(`Subtitle fetch failed: HTTP ${r.status}`)

    let content = await r.text()
    const asVtt = format === 'vtt'

    // Convert SRT → VTT if requested
    if (asVtt && !content.trimStart().startsWith('WEBVTT')) {
      content = srtToVtt(content)
    }

    res.setHeader('Content-Type', asVtt ? 'text/vtt' : 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('X-OS-Remaining', String(linkData.remaining ?? '?'))
    res.setHeader('X-OS-Reset-Time', linkData.reset_time || '')
    res.send(content)
  } catch (err) {
    console.error('[subtitles/download]', err.message)
    if (!res.headersSent) res.status(502).json({ error: err.message })
  }
})

// ── ROUTE: Subtitle quota status ─────────────────────────────────────────────
// GET /api/subtitles/quota
// Returns remaining daily downloads from the last /download call response.
// (We can't query OS for quota directly without login; this shows cached data.)
app.get('/api/subtitles/quota', (req, res) => {
  // Pull last known remaining value from any cached link
  // This is best-effort — only accurate after at least one download
  res.json({
    api_key_configured: !!OS_API_KEY,
    note: 'Free tier: 5 downloads/day without account, 20/day with free account. Check X-OS-Remaining header on /api/subtitles/download responses.',
    register_url: 'https://www.opensubtitles.com/consumers',
  })
})

app.get('/api/stats', (req, res) => {
  const h = req.query.infoHash?.toLowerCase()
  const torrent = torrents.get(h)?.torrent || getClient().torrents.find(t => t.infoHash === h)
  if (!torrent) return res.status(404).json({ error: 'Not found' })
  res.json({
    peers: torrent.numPeers,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    progress: torrent.progress,
    timeRemaining: torrent.timeRemaining,
    downloaded: torrent.downloaded,
    uploaded: torrent.uploaded,
  })
})

app.get('/api/health', (req, res) => res.json({
  ok: true, uptime: Math.round(process.uptime()),
  torrents: getClient().torrents.length, activeTorrents: torrents.size,
  hlsSessions: hlsSessions.size,
  opensubtitles: { api_key_configured: !!OS_API_KEY },
  cache: {
    torrentSearch: torrentSearchCache.stats(), tmdbSearch: tmdbSearchCache.stats(),
    tmdbDetail: tmdbDetailCache.stats(), tmdbBrowse: tmdbBrowseCache.stats(),
    osSearch: osSearchCache.stats(), osLinks: osLinkCache.stats(),
    inFlight: inFlight.size,
  },
}))

app.post('/api/cache/flush', (req, res) => {
  const target = req.query.target || 'all'
  if (target === 'torrents' || target === 'all') torrentSearchCache.flush()
  if (target === 'tmdb' || target === 'all') {
    tmdbSearchCache.flush(); tmdbDetailCache.flush(); tmdbBrowseCache.flush()
  }
  if (target === 'subtitles' || target === 'all') {
    osSearchCache.flush(); osLinkCache.flush()
  }
  res.json({ ok: true, flushed: target })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HLS ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/hls/:infoHash/:fileIndex/master.m3u8', async (req, res) => {
  const { infoHash, fileIndex } = req.params
  try {
    await getOrStartHlsSession(infoHash, parseInt(fileIndex))
    const master = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.42E01E,mp4a.40.2"`,
      `stream.m3u8`,
    ].join('\n')
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.send(master)
  } catch (err) {
    console.error('[hls master]', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/hls/:infoHash/:fileIndex/stream.m3u8', (req, res) => {
  const { infoHash, fileIndex } = req.params
  const key = hlsSessionKey(infoHash, fileIndex)
  resetHlsTTL(key)
  const session = hlsSessions.get(key)
  if (!session?.ready) return res.status(404).json({ error: 'Session not ready' })
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  res.setHeader('Cache-Control', 'no-cache, no-store')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.sendFile(session.playlistPath)
})

app.get('/api/hls/:infoHash/:fileIndex/:segment', (req, res) => {
  const { infoHash, fileIndex, segment } = req.params
  if (!segment.endsWith('.ts')) return res.status(400).end()
  const key = hlsSessionKey(infoHash, fileIndex)
  resetHlsTTL(key)
  const session = hlsSessions.get(key)
  if (!session) return res.status(404).end()
  const segPath = join(session.dir, segment)
  if (!existsSync(segPath)) return res.status(404).end()
  res.setHeader('Content-Type', 'video/mp2t')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.sendFile(segPath)
})

app.delete('/api/hls/:infoHash/:fileIndex', (req, res) => {
  destroyHlsSession(hlsSessionKey(req.params.infoHash, req.params.fileIndex))
  res.json({ ok: true })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SPA FALLBACK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'), err => {
    if (err) res.json({ ok: true, message: 'Server running. Build frontend with: npm run build' })
  })
})

app.listen(PORT, () => console.log(`\n[server] http://0.0.0.0:${PORT}\n`))

process.on('SIGTERM', () => { try { hlsSessions.forEach((_, k) => destroyHlsSession(k)); client.destroy() } catch (_) {} process.exit(0) })
process.on('SIGINT',  () => { try { client.destroy() } catch (_) {} process.exit(0) })