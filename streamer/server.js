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

const EXTRA_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.stealth.si:80/announce',
  'https://tracker.tamersunion.org:443/announce',
]

function buildMagnet(infoHash, name = '') {
  let m = `magnet:?xt=urn:btih:${infoHash}`
  if (name) m += `&dn=${encodeURIComponent(name)}`
  for (const tr of EXTRA_TRACKERS) m += `&tr=${encodeURIComponent(tr)}`
  return m
}

function healthScore(seeders, leechers) {
  if (!seeders) return 0
  const ratio = seeders / Math.max(leechers, 1)
  return Math.min(seeders * 0.7 + ratio * 0.3, 100)
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express()
app.use(cors({ origin: ALLOWED_ORIGINS, exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'] }))
app.use(express.json())

// Serve compiled frontend from /public
const frontendDist = path.join(__dirname, 'public')
app.use(express.static(frontendDist))

// ── WebTorrent ────────────────────────────────────────────────────────────────
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

function extractInfoHash(magnet) {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i)
  return m ? m[1].toLowerCase() : null
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) return fetchBuffer(res.headers.location).then(resolve).catch(reject)
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

async function getOrAdd(hashOrMagnet, sendStatus) {
  const infoHash = hashOrMagnet.startsWith('magnet:') ? extractInfoHash(hashOrMagnet) : hashOrMagnet.toLowerCase()

  if (infoHash && torrents.has(infoHash)) { resetTTL(infoHash); return waitReady(torrents.get(infoHash).torrent) }
  const ex = infoHash && getClient().torrents.find(t => t.infoHash === infoHash)
  if (ex) { torrents.set(infoHash, { torrent: ex, timer: null, addedAt: Date.now() }); resetTTL(infoHash); return waitReady(ex) }

  evictOldest()
  const buf = infoHash ? await fetchTorrentBuffer(infoHash, sendStatus) : null
  sendStatus('Connecting to BitTorrent swarm…')

  const input = buf || (hashOrMagnet.startsWith('magnet:') ? hashOrMagnet : `magnet:?xt=urn:btih:${infoHash}`)
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

const PLAYABLE_EXTS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.mp3', '.flac', '.aac', '.ogg', '.wav']
const isPlayable = name => PLAYABLE_EXTS.some(ext => name.toLowerCase().endsWith(ext))
const MIME = {
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
  avi: 'video/x-msvideo', mov: 'video/quicktime', m4v: 'video/mp4',
  mp3: 'audio/mpeg', flac: 'audio/flac', aac: 'audio/aac', ogg: 'audio/ogg', wav: 'audio/wav',
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SEARCH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TMDB ENRICHMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const TMDB_KEY = process.env.TMDB_API_KEY || '863132acc2bd530a41f149bc37736902'
const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_IMG = 'https://image.tmdb.org/t/p'

// In-memory cache: tmdbId -> enriched metadata (never changes so no TTL needed)
const tmdbCache = new Map()

// Genre ID maps (static — from TMDB's /genre/movie/list and /genre/tv/list)
const MOVIE_GENRES = {
  28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',
  99:'Documentary',18:'Drama',10751:'Family',14:'Fantasy',36:'History',
  27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Sci-Fi',
  10770:'TV Movie',53:'Thriller',10752:'War',37:'Western'
}
const TV_GENRES = {
  10759:'Action & Adventure',16:'Animation',35:'Comedy',80:'Crime',
  99:'Documentary',18:'Drama',10751:'Family',10762:'Kids',9648:'Mystery',
  10763:'News',10764:'Reality',10765:'Sci-Fi & Fantasy',10766:'Soap',
  10767:'Talk',10768:'War & Politics',37:'Western'
}

async function tmdbFetch(path, params = {}) {
  if (!TMDB_KEY) return null
  const url = new URL(`${TMDB_BASE}${path}`)
  url.searchParams.set('api_key', TMDB_KEY)
  url.searchParams.set('language', 'en-US')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  try {
    const r = await fetch(url.toString(), {
      headers: { ...SEARCH_HEADERS, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return null
    return r.json()
  } catch { return null }
}

// Search TMDB for a title — returns movie or tv result, or null
async function tmdbSearch(title, year = null) {
  // Clean title: strip resolution, codec, scene tags, etc.
  const clean = title
    .replace(/\b(19|20)\d{2}\b.*/, '')          // strip year and everything after
    .replace(/\b(1080p|720p|4k|bluray|webrip|hdtv|x264|x265|hevc|aac|dd5|h264|h265|proper|repack|extended|theatrical|directors\.cut)\b.*/i, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[._]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()

  if (!clean || clean.length < 2) return null

  // Extract year from original title if present
  const yearMatch = title.match(/\b(19|20)(\d{2})\b/)
  const searchYear = year || (yearMatch ? yearMatch[0] : null)

  const cacheKey = `${clean}:${searchYear}`
  if (tmdbCache.has(cacheKey)) return tmdbCache.get(cacheKey)

  const params = { query: clean, include_adult: false, page: 1 }
  if (searchYear) params.year = searchYear

  const json = await tmdbFetch('/search/multi', params)
  if (!json) { tmdbCache.set(cacheKey, null); return null }

  // Filter to only movie and tv — skip person results
  const results = (json.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv')
  if (!results.length) { tmdbCache.set(cacheKey, null); return null }

  // Pick best match: prefer exact title match, then highest popularity
  const best = results.sort((a, b) => {
    const aTitle = (a.title || a.name || '').toLowerCase()
    const bTitle = (b.title || b.name || '').toLowerCase()
    const cl = clean.toLowerCase()
    const aExact = aTitle === cl ? 1 : 0
    const bExact = bTitle === cl ? 1 : 0
    if (aExact !== bExact) return bExact - aExact
    return (b.popularity || 0) - (a.popularity || 0)
  })[0]

  // Fetch full details + credits + release dates in parallel
  const mediaType = best.media_type
  const id = best.id
  const [details, credits, releaseDates] = await Promise.all([
    tmdbFetch(`/${mediaType}/${id}`, { append_to_response: 'external_ids' }),
    tmdbFetch(`/${mediaType}/${id}/credits`),
    mediaType === 'movie'
      ? tmdbFetch(`/movie/${id}/release_dates`)
      : tmdbFetch(`/tv/${id}/content_ratings`),
  ])

  if (!details) { tmdbCache.set(cacheKey, null); return null }

  const genreMap = mediaType === 'movie' ? MOVIE_GENRES : TV_GENRES
  const genres = (details.genres || []).map(g => g.name || genreMap[g.id]).filter(Boolean)

  // Cast: top 5 actors
  const cast = (credits?.cast || []).slice(0, 5).map(p => p.name)

  // Director / creator
  const director = mediaType === 'movie'
    ? (credits?.crew || []).find(p => p.job === 'Director')?.name || null
    : (details.created_by || [])[0]?.name || null

  // Age rating (certification)
  let certification = null
  if (mediaType === 'movie') {
    const us = (releaseDates?.results || []).find(r => r.iso_3166_1 === 'US')
    certification = us?.release_dates?.find(d => d.certification)?.certification || null
  } else {
    const us = (releaseDates?.results || []).find(r => r.iso_3166_1 === 'US')
    certification = us?.rating || null
  }

  const meta = {
    tmdbId: id,
    mediaType,                                           // 'movie' | 'tv'
    title: details.title || details.name,
    originalTitle: details.original_title || details.original_name || null,
    overview: details.overview || null,
    year: (details.release_date || details.first_air_date || '').slice(0, 4) || null,
    genres,
    cast,
    director,
    certification,                                       // e.g. 'PG-13', 'TV-MA'
    tmdbRating: details.vote_average ? Math.round(details.vote_average * 10) / 10 : null,
    tmdbVotes: details.vote_count || null,
    imdbId: details.external_ids?.imdb_id || null,
    runtime: details.runtime || (details.episode_run_time || [])[0] || null,
    status: details.status || null,
    // TV specific
    seasons: details.number_of_seasons || null,
    episodes: details.number_of_episodes || null,
    network: (details.networks || [])[0]?.name || null,
    // Images
    poster: details.poster_path ? `${TMDB_IMG}/w342${details.poster_path}` : null,
    backdrop: details.backdrop_path ? `${TMDB_IMG}/w1280${details.backdrop_path}` : null,
    posterThumb: details.poster_path ? `${TMDB_IMG}/w92${details.poster_path}` : null,
  }

  tmdbCache.set(cacheKey, meta)
  return meta
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FILTERS — only keep movie/tv content, drop software/games/books/etc.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const BLOCKED_CATEGORIES = ['software', 'games', 'game', 'apps', 'application', 'books', 'ebooks', 'xxx', 'adult', 'other']
const BLOCKED_TITLE_PATTERNS = [
  /\.(exe|zip|rar|iso|apk|dmg|pkg|deb|rpm|msi|pdf|epub|mobi|azw)$/i,
  /\b(crack|keygen|patch|activator|serial|license\.key)\b/i,
  /\b(discography|album|ost|soundtrack)\b/i,  // music — re-enable when you add music support
]
// Patterns that suggest it IS a video
const VIDEO_EXTS = /\.(mp4|mkv|avi|mov|m4v|webm)$/i
const VIDEO_TAGS = /\b(1080p|720p|4k|uhd|bluray|blu-ray|webrip|hdtv|dvdrip|x264|x265|hevc|h264|h265|avc|remux|hdr|dolby)\b/i

function looksLikeMedia(item) {
  const cat = (item.category || '').toLowerCase()
  if (BLOCKED_CATEGORIES.some(b => cat.includes(b))) return false

  const title = item.title || ''
  if (BLOCKED_TITLE_PATTERNS.some(p => p.test(title))) return false

  // YTS and EZTV are always media — trust their source label
  if (item.source === 'yts' || item.source === 'eztv') return true

  // Title has video markers → likely media
  if (VIDEO_TAGS.test(title) || VIDEO_EXTS.test(title)) return true

  // Has TMDB metadata → confirmed media (will be set after enrichment)
  if (item.meta) return true

  return true // default pass — TMDB enrichment will be the real filter
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SEARCH PROVIDERS (with safeJSON guard)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SEARCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
}

async function safeJSON(response, source) {
  const ct = response.headers.get('content-type') || ''
  if (!response.ok) { console.log(`[${source}] HTTP ${response.status}`); return null }
  if (!ct.includes('application/json') && !ct.includes('text/json')) {
    console.log(`[${source}] Non-JSON response (${ct}) — likely blocked`)
    return null
  }
  return response.json()
}

async function searchKnaben(query, limit) {
  try {
    const r = await fetch('https://api.knaben.org/v1', {
      method: 'POST',
      headers: { ...SEARCH_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ search_type: 'and', search_field: 'title', query, from: 0, size: limit, orderBy: 'seeders', orderDirection: 'desc', hide_unsafe: false }),
      signal: AbortSignal.timeout(12000),
    })
    const json = await safeJSON(r, 'knaben')
    if (!json) return []
    return (json?.hits?.hits || []).flatMap(item => {
      const s = item._source || {}
      if (!s.hash) return []
      const seeders = parseInt(s.seeders) || 0
      const leechers = parseInt(s.leechers) || 0
      return [{ id: s.hash.toLowerCase(), title: s.title || 'Unknown', magnet_link: s.magnet || buildMagnet(s.hash, s.title), size_bytes: s.bytes || null, seeders, leechers, category: s.category || null, source: 'knaben', health_score: healthScore(seeders, leechers) }]
    })
  } catch (e) { console.log('[knaben]', e.message); return [] }
}

async function searchPirateBay(query, limit) {
  try {
    const r = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`, {
      headers: SEARCH_HEADERS, signal: AbortSignal.timeout(12000),
    })
    const json = await safeJSON(r, 'piratebay')
    if (!json) return []
    const catMap = { '201':'Movie','202':'Movie','205':'TV','100':'Audio','200':'Video','300':'Apps','400':'Games' }
    return json.slice(0, limit).flatMap(item => {
      if (!item.info_hash || item.name === 'No results returned') return []
      const seeders = parseInt(item.seeders) || 0
      const leechers = parseInt(item.leechers) || 0
      return [{ id: item.info_hash.toLowerCase(), title: item.name, magnet_link: buildMagnet(item.info_hash, item.name), size_bytes: parseInt(item.size) || null, seeders, leechers, category: catMap[item.category] || null, source: 'piratebay', health_score: healthScore(seeders, leechers) }]
    })
  } catch (e) { console.log('[piratebay]', e.message); return [] }
}

async function searchSolidTorrents(query, limit) {
  try {
    const r = await fetch(`https://solidtorrents.to/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`, {
      headers: SEARCH_HEADERS, signal: AbortSignal.timeout(20000),
    })
    const json = await safeJSON(r, 'solidtorrents')
    if (!json) return []
    return (json?.results?.slice(0, limit) || []).flatMap(item => {
      if (!item.infohash) return []
      const seeders = parseInt(item.swarm?.seeders) || 0
      const leechers = parseInt(item.swarm?.leechers) || 0
      return [{ id: item.infohash.toLowerCase(), title: item.title || 'Unknown', magnet_link: item.magnet || buildMagnet(item.infohash, item.title), size_bytes: item.size || null, seeders, leechers, category: item.category || null, source: 'solidtorrents', health_score: healthScore(seeders, leechers) }]
    })
  } catch (e) { console.log('[solidtorrents]', e.message); return [] }
}

async function searchYTS(query, limit) {
  try {
    const r = await fetch(
      `https://yts.pm/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=${Math.min(limit, 50)}&sort_by=seeds`,
      { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(12000) }
    )
    const json = await safeJSON(r, 'yts')
    if (!json || json.data?.movie_count === 0) return []
    return (json.data?.movies || []).flatMap(movie =>
      (movie.torrents || []).map(t => {
        const seeders = t.seeds || 0
        const leechers = t.peers || 0
        const title = `${movie.title} (${movie.year}) [${t.quality}] [${t.type}]`
        return { id: t.hash.toLowerCase(), title, magnet_link: buildMagnet(t.hash, title), size_bytes: t.size_bytes || null, seeders, leechers, category: 'Movie', source: 'yts', health_score: healthScore(seeders, leechers) }
      })
    ).slice(0, limit)
  } catch (e) { console.log('[yts]', e.message); return [] }
}

async function searchEZTV(query, limit) {
  try {
    const r = await fetch(
      `https://eztvx.to/api/get-torrents?limit=${Math.min(limit * 3, 100)}&page=1`,
      { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(12000) }
    )
    const json = await safeJSON(r, 'eztv')
    if (!json) return []
    const q = query.toLowerCase()
    return (json.torrents || [])
      .filter(t => t.title?.toLowerCase().includes(q) || t.filename?.toLowerCase().includes(q))
      .slice(0, limit)
      .map(t => {
        const seeders = t.seeds || 0
        const leechers = t.peers || 0
        return { id: t.hash.toLowerCase(), title: t.title || t.filename || 'Unknown', magnet_link: t.magnet_url || buildMagnet(t.hash, t.title), size_bytes: parseInt(t.size_bytes) || null, seeders, leechers, category: 'TV', source: 'eztv', health_score: healthScore(seeders, leechers) }
      })
  } catch (e) { console.log('[eztv]', e.message); return [] }
}

async function searchTorrentsCsv(query, limit) {
  try {
    const r = await fetch(
      `https://torrents-csv.com/service/search?q=${encodeURIComponent(query)}&size=${limit}&page=0`,
      { headers: SEARCH_HEADERS, signal: AbortSignal.timeout(12000) }
    )
    const json = await safeJSON(r, 'torrents-csv')
    if (!json) return []
    return (json.torrents || []).slice(0, limit).map(t => {
      const seeders = t.seeders || 0
      const leechers = t.leechers || 0
      return { id: t.infohash.toLowerCase(), title: t.name || 'Unknown', magnet_link: buildMagnet(t.infohash, t.name), size_bytes: t.size_bytes || null, seeders, leechers, category: null, source: 'torrents-csv', health_score: healthScore(seeders, leechers) }
    })
  } catch (e) { console.log('[torrents-csv]', e.message); return [] }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGGREGATE + ENRICH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function searchAll(query, limit) {
  const settled = await Promise.allSettled([
    searchKnaben(query, limit),
    searchPirateBay(query, limit),
    searchSolidTorrents(query, limit),
    searchYTS(query, limit),
    searchEZTV(query, limit),
    searchTorrentsCsv(query, limit),
  ])

  // Deduplicate by info hash, keeping highest seeder count
  const seen = new Map()
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue
    for (const item of r.value) {
      if (!seen.has(item.id) || item.seeders > seen.get(item.id).seeders) {
        seen.set(item.id, item)
      }
    }
  }

  // Pre-filter obvious non-media before spending TMDB quota
  let candidates = [...seen.values()].filter(looksLikeMedia)

  // Enrich with TMDB metadata (concurrency-limited to avoid hammering the API)
  if (TMDB_KEY) {
    const CONCURRENCY = 5
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      await Promise.all(
        candidates.slice(i, i + CONCURRENCY).map(async item => {
          item.meta = await tmdbSearch(item.title)
        })
      )
    }
    // After enrichment: drop anything TMDB couldn't match at all only if it also
    // came from a general source (knaben/piratebay/etc) — YTS/EZTV are trusted
    candidates = candidates.filter(item =>
      item.meta !== null ||
      item.source === 'yts' ||
      item.source === 'eztv'
    )
  }

  return candidates
    .sort((a, b) => b.health_score - a.health_score)
    .slice(0, limit)
}
// GET /api/search?q=...&limit=24&type=movie|tv
app.get('/api/search', async (req, res) => {
  const q = req.query.q?.trim()
  if (!q) return res.status(400).json({ error: 'q param required' })
  const limit = Math.min(parseInt(req.query.limit) || 24, 50)
  const typeFilter = req.query.type // 'movie' | 'tv' | undefined = all

  try {
    let results = await searchAll(q, limit)

    // Optional type filter
    if (typeFilter && TMDB_KEY) {
      results = results.filter(r => !r.meta || r.meta.mediaType === typeFilter)
    }

    res.json({ total: results.length, query: q, results })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/resolve?magnet=...
app.get('/api/resolve', (req, res) => {
  const { magnet } = req.query
  if (!magnet?.startsWith('magnet:?')) return res.status(400).json({ error: 'Invalid magnet link' })
  const infoHash = extractInfoHash(magnet)
  if (!infoHash) return res.status(400).json({ error: 'Missing info hash' })
  const dn = magnet.match(/[&?]dn=([^&]+)/)?.[1]
  const title = dn ? decodeURIComponent(dn.replace(/\+/g, ' ')) : 'Unknown Torrent'
  res.json({ id: infoHash, title, magnet_link: magnet, size_bytes: null, seeders: 0, leechers: 0, source: 'direct' })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STREAM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/info?magnet=...  SSE — sends status updates, then fires ready event with file list
app.get('/api/info', async (req, res) => {
  const { magnet } = req.query
  if (!magnet) return res.status(400).json({ error: 'magnet param required' })

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' })
  let closed = false
  req.on('close', () => { closed = true })
  const send = (ev, data) => { if (!closed && !res.writableEnded) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`) }
  const sendStatus = msg => { console.log(`[status] ${msg}`); send('status', { message: msg }) }

  try {
    const torrent = await getOrAdd(magnet, sendStatus)
    sendStatus(`Found ${torrent.numPeers} peers — waiting for data connection…`)
    await waitForPeers(torrent, 60_000, sendStatus)
    resetTTL(torrent.infoHash)

    const files = torrent.files.map((f, i) => ({ index: i, name: f.name, length: f.length, playable: isPlayable(f.name) }))
    // Pick largest playable file as the default (most likely to be the main video)
    const playableFiles = files.filter(f => f.playable).sort((a, b) => b.length - a.length)

    send('ready', {
      infoHash: torrent.infoHash,
      name: torrent.name,
      length: torrent.length,
      files,
      peers: torrent.numPeers,
      playableIndex: playableFiles[0]?.index ?? -1,
    })
  } catch (err) {
    console.error('[/api/info]', err.message)
    send('error', { error: err.message })
  }
  res.end()
})

// GET /api/stream?infoHash=...&file=0
app.get('/api/stream', async (req, res) => {
  const { magnet, infoHash: hashParam, file: fileIndexStr } = req.query
  if (!magnet && !hashParam) return res.status(400).json({ error: 'infoHash or magnet required' })

  try {
    const torrent = await getOrAdd(hashParam || magnet, () => {})
    resetTTL(torrent.infoHash)

    if (torrent.numPeers === 0) {
      try { await waitForPeers(torrent, 30_000, () => {}) } catch (_) {
        return res.status(503).json({ error: 'No peers available — try again shortly' })
      }
    }

    const fileIndex = parseInt(fileIndexStr ?? '0', 10)
    if (fileIndex < 0 || fileIndex >= torrent.files.length) {
      return res.status(404).json({ error: `File index ${fileIndex} out of range`, files: torrent.files.map((f, i) => `[${i}] ${f.name}`) })
    }

    const file = torrent.files[fileIndex]
    torrent.files.forEach((f, i) => i === fileIndex ? f.select() : f.deselect())

    const fileLength = file.length
    const ext = file.name.split('.').pop().toLowerCase()
    const mime = MIME[ext] || 'application/octet-stream'
    const range = req.headers.range
    console.log(`[stream] "${file.name}" peers=${torrent.numPeers} range=${range || 'none'}`)

    const makeStream = (opts) => {
      const s = file.createReadStream(opts)
      s.on('error', err => { if (!err.message.includes('Writable stream closed prematurely')) console.error('[stream err]', err.message) })
      return s
    }

    if (range) {
      const [s, e] = range.replace(/bytes=/, '').split('-')
      const start = parseInt(s, 10)
      const end = e ? parseInt(e, 10) : fileLength - 1
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileLength}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime })
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

// GET /api/stats?infoHash=...
app.get('/api/stats', (req, res) => {
  const h = req.query.infoHash?.toLowerCase()
  const torrent = torrents.get(h)?.torrent || getClient().torrents.find(t => t.infoHash === h)
  if (!torrent) return res.status(404).json({ error: 'Not found' })
  res.json({ peers: torrent.numPeers, downloadSpeed: torrent.downloadSpeed, uploadSpeed: torrent.uploadSpeed, progress: torrent.progress, timeRemaining: torrent.timeRemaining })
})

app.get('/api/health', (req, res) => res.json({ ok: true, torrents: getClient().torrents.length }))

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'), err => {
    if (err) res.json({ ok: true, message: 'Server running. Build frontend with: npm run build' })
  })
})

app.listen(PORT, () => {
  console.log(`[server] http://0.0.0.0:${PORT}`)
  console.log(`[server] /api/search  /api/info  /api/stream  /api/stats`)
})
process.on('SIGTERM', () => { try { client.destroy() } catch (_) {} process.exit(0) })
