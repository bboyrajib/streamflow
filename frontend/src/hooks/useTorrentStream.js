import { useState, useEffect, useRef, useCallback } from 'react'

const PLAYABLE_EXTS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v']
const SEED_DELAY_MS = 5 * 60 * 1000
const NO_PEERS_TIMEOUT_MS = 60_000

// Only trackers confirmed working in browsers (wss:// only — UDP/HTTP don't work in browsers)
const WSS_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
]

const WEBTORRENT_CONFIG = {
  tracker: {
    announce: WSS_TRACKERS,
    rtcConfig: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
      ],
    },
  },
}

function isPlayable(name) {
  return ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v']
    .some(ext => name.toLowerCase().endsWith(ext))
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function formatSpeed(bps) { return formatBytes(bps) + '/s' }

function formatETA(seconds) {
  if (!seconds || !isFinite(seconds)) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}

function enrichMagnet(magnet) {
  let m = magnet
  // Strip any dead/broken trackers and inject only working wss:// ones
  for (const tr of WSS_TRACKERS) {
    if (!m.includes(encodeURIComponent(tr))) {
      m += `&tr=${encodeURIComponent(tr)}`
    }
  }
  return m
}

export function useTorrentStream(magnetLink, videoRef) {
  const clientRef = useRef(null)
  const torrentRef = useRef(null)
  const seedTimerRef = useRef(null)
  const noPeersTimerRef = useRef(null)

  const [status, setStatus] = useState({
    state: 'idle',
    progress: 0,
    peers: -1,
    eta: null,
    name: '',
    error: null,
    downloadSpeedStr: '0 B/s',
    uploadSpeedStr: '0 B/s',
  })

  const update = useCallback(patch =>
    setStatus(prev => ({ ...prev, ...patch })), [])

  const cleanup = useCallback(() => {
    clearTimeout(seedTimerRef.current)
    clearTimeout(noPeersTimerRef.current)
    if (torrentRef.current) {
      try { torrentRef.current.destroy() } catch (_) {}
      torrentRef.current = null
    }
    if (clientRef.current) {
      try { clientRef.current.destroy() } catch (_) {}
      clientRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!magnetLink) return
    let destroyed = false

    function start() {
      update({ state: 'connecting', peers: -1, error: null, progress: 0 })

      const WT = window.WebTorrent
      if (!WT) {
        update({ state: 'error', error: 'WebTorrent not loaded — reload the page.' })
        return
      }

      const client = new WT(WEBTORRENT_CONFIG)
      clientRef.current = client

      client.on('error', err => {
        if (destroyed) return
        // Ignore tracker connection errors — they're non-fatal
        const msg = err?.message || String(err)
        if (msg.includes('WebSocket') || msg.includes('tracker')) return
        update({ state: 'error', error: msg })
      })

      const enriched = enrichMagnet(magnetLink)
      const torrent = client.add(enriched, {
        strategy: 'sequential',
        announce: WSS_TRACKERS,
      })
      torrentRef.current = torrent

      noPeersTimerRef.current = setTimeout(() => {
        if (!destroyed && torrentRef.current?.numPeers === 0) {
          update({
            state: 'error',
            error: 'No peers found after 60s. This torrent has no active seeders right now — try a different result with more seeds.',
          })
        }
      }, NO_PEERS_TIMEOUT_MS)

      torrent.on('error', err => {
        if (destroyed) return
        const msg = typeof err === 'string' ? err : err.message || 'Torrent error'
        if (msg.includes('WebSocket') || msg.includes('tracker')) return
        update({ state: 'error', error: msg })
      })

      torrent.on('metadata', () => {
        if (destroyed) return
        update({ name: torrent.name, state: 'loading' })
      })

      const ticker = setInterval(() => {
        if (destroyed || !torrent) return
        const peers = torrent.numPeers
        if (peers > 0) clearTimeout(noPeersTimerRef.current)
        update({
          progress: Math.round(torrent.progress * 10000) / 100,
          peers,
          eta: formatETA(torrent.timeRemaining / 1000),
          downloadSpeedStr: formatSpeed(torrent.downloadSpeed),
          uploadSpeedStr: formatSpeed(torrent.uploadSpeed),
        })
      }, 1000)

      torrent.on('destroy', () => clearInterval(ticker))

      torrent.on('ready', () => {
        if (destroyed) return
        clearTimeout(noPeersTimerRef.current)
        update({ name: torrent.name, state: 'loading' })

        const file = torrent.files.find(f => isPlayable(f.name))
        if (!file) {
          const names = torrent.files.map(f => f.name).join(', ')
          update({ state: 'error', error: `No playable video file found. Files: ${names || 'none'}` })
          return
        }

        file.renderTo(videoRef.current, (err) => {
          if (destroyed) return
          if (err) { update({ state: 'error', error: 'Render error: ' + err.message }); return }
          update({ state: 'ready' })
        })

        const saved = localStorage.getItem('pos:' + torrent.infoHash)
        if (saved && videoRef.current) videoRef.current.currentTime = parseFloat(saved)

        const saveInterval = setInterval(() => {
          if (videoRef.current && !videoRef.current.paused)
            localStorage.setItem('pos:' + torrent.infoHash, videoRef.current.currentTime)
        }, 5000)

        torrent.on('destroy', () => clearInterval(saveInterval))

        if (videoRef.current) {
          videoRef.current.addEventListener('ended', () => {
            seedTimerRef.current = setTimeout(() => {}, SEED_DELAY_MS)
          }, { once: true })
        }
      })
    }

    try { start() } catch (err) {
      if (!destroyed) update({ state: 'error', error: err.message })
    }

    return () => { destroyed = true; cleanup() }
  }, [magnetLink]) // eslint-disable-line react-hooks/exhaustive-deps

  return { status, cleanup }
}
