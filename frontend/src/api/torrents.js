// All requests go to /api/* — proxied to Node server in dev, served directly in prod

export async function searchTorrents(q, limit = 24) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`)
  if (!res.ok) throw new Error((await res.json()).error || 'Search failed')
  return res.json()
}

export async function resolveMagnet(magnet) {
  const res = await fetch(`/api/resolve?magnet=${encodeURIComponent(magnet)}`)
  if (!res.ok) throw new Error((await res.json()).error || 'Invalid magnet')
  return res.json()
}

/**
 * Fetch torrent info via SSE.
 * Server waits for peers before firing 'ready', so this can take 10-60s.
 * onStatus(msg) called with progress updates.
 */
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
