// All requests go to /api/* — proxied to Node server in dev, served directly in prod

// ── TMDB Search ────────────────────────────────────────────────────────────────
// Returns full metadata + seasonData[] for TV shows
export async function searchTMDB(q, { type = 'multi', page = 1, year = null } = {}) {
  const params = new URLSearchParams({ q, type, page })
  if (year) params.set('year', year)
  const res = await fetch(`/api/search/tmdb?${params}`)
  if (!res.ok) throw new Error((await res.json()).error || 'TMDB search failed')
  return res.json()
}

// ── Torrent Search ─────────────────────────────────────────────────────────────
// Returns raw torrents from all providers with provider tags — no TMDB enrichment
// query: intelligently constructed string (title + year + quality hints)
export async function searchTorrents(query, { limit = 50, perProvider = 20, sort = 'health', page = 1, imdbId = null } = {}) {
  const params = new URLSearchParams({ q: query, limit, per_provider: perProvider, sort, page })
  if (imdbId) params.set('imdb_id', imdbId)
  const res = await fetch(`/api/search/torrents?${params}`)
  if (!res.ok) throw new Error((await res.json()).error || 'Torrent search failed')
  return res.json()
}

// Build a smart torrent query from TMDB metadata
// Adds year for disambiguation, season/episode for TV
export function buildTorrentQuery(meta, { season = null, episode = null } = {}) {
  const title = meta.title || meta.name || ''
  const year = meta.year || ''

  if (meta.mediaType === 'tv' || meta.seasons) {
    if (season !== null && episode !== null) {
      const s = String(season).padStart(2, '0')
      const e = String(episode).padStart(2, '0')
      return `${title} S${s}E${e}`
    }
    if (season !== null) {
      const s = String(season).padStart(2, '0')
      return `${title} Season ${season}`
    }
    return `${title} ${year}`.trim()
  }

  // Movie — year is critical for disambiguation
  return `${title} ${year}`.trim()
}

// ── TMDB Browse ────────────────────────────────────────────────────────────────
export async function resolveMagnet(magnet) {
  const res = await fetch(`/api/resolve?magnet=${encodeURIComponent(magnet)}`)
  if (!res.ok) throw new Error((await res.json()).error || 'Invalid magnet')
  return res.json()
}

export async function getHomepage() {
  const res = await fetch('/api/homepage')
  if (!res.ok) throw new Error('Failed to load homepage')
  return res.json()
}

export async function getTrending(type = 'all', window = 'week', page = 1) {
  const res = await fetch(`/api/trending?type=${type}&window=${window}&page=${page}`)
  if (!res.ok) throw new Error('Failed to load trending')
  return res.json()
}

export async function getPopular(type = 'movie', page = 1) {
  const res = await fetch(`/api/popular?type=${type}&page=${page}`)
  if (!res.ok) throw new Error('Failed to load popular')
  return res.json()
}

export async function getTopRated(type = 'movie', page = 1) {
  const res = await fetch(`/api/toprated?type=${type}&page=${page}`)
  if (!res.ok) throw new Error('Failed to load top rated')
  return res.json()
}

export async function getUpcoming(page = 1) {
  const res = await fetch(`/api/upcoming?page=${page}`)
  if (!res.ok) throw new Error('Failed to load upcoming')
  return res.json()
}

export async function getDiscover(type = 'movie', params = {}) {
  const q = new URLSearchParams({ type, ...params })
  const res = await fetch(`/api/discover?${q}`)
  if (!res.ok) throw new Error('Failed to discover')
  return res.json()
}

export async function getTmdbDetails(type, id) {
  const res = await fetch(`/api/tmdb/${type}/${id}`)
  if (!res.ok) throw new Error('Not found')
  return res.json()
}

export async function getTmdbSeason(tvId, season) {
  const res = await fetch(`/api/tmdb/tv/${tvId}/season/${season}`)
  if (!res.ok) throw new Error('Season not found')
  return res.json()
}

export async function getGenres() {
  const res = await fetch('/api/genres')
  if (!res.ok) throw new Error('Failed to load genres')
  return res.json()
}

// ── Torrent streaming ──────────────────────────────────────────────────────────
export function getTorrentInfo(magnet, onStatus) {
  return new Promise((resolve, reject) => {
    const url = `/api/info?magnet=${encodeURIComponent(magnet)}`
    const es = new EventSource(url)
    es.addEventListener('status', e => {
      try { onStatus?.(JSON.parse(e.data).message) } catch (_) {}
    })
    es.addEventListener('ready', e => {
      es.close()
      try { resolve(JSON.parse(e.data)) } catch (err) { reject(err) }
    })
    es.addEventListener('error', e => {
      es.close()
      try { reject(new Error(JSON.parse(e.data).error)) } catch (_) {
        reject(new Error('Lost connection to server'))
      }
    })
    const t = setTimeout(() => { es.close(); reject(new Error('Timed out waiting for torrent')) }, 120_000)
    es.addEventListener('ready', () => clearTimeout(t))
    es.addEventListener('error', () => clearTimeout(t))
  })
}

export function getStreamUrl(infoHash, fileIndex = 0) {
  return `/api/stream?infoHash=${encodeURIComponent(infoHash)}&file=${fileIndex}`
}

export async function getTorrentStats(infoHash) {
  try {
    const res = await fetch(`/api/stats?infoHash=${encodeURIComponent(infoHash)}`)
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}
