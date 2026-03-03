import React, { useRef, useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import Hls from 'hls.js'
import { getTorrentInfo, getTorrentStats } from '../api/torrents.js'
import styles from './StreamPage.module.css'

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmt(bytes) {
  if (!bytes) return '0 B'
  const k = 1024, s = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${s[i]}`
}
function fmtSpeed(bps) { return fmt(bps) + '/s' }
function fmtETA(ms) {
  if (!ms || !isFinite(ms) || ms <= 0) return '—'
  const s = ms / 1000
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}
function fmtTime(secs) {
  if (!secs || isNaN(secs)) return '0:00'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function SeedHealth({ seeders }) {
  const style = seeders < 0
    ? { background: 'var(--muted)' }
    : seeders > 10
      ? { background: 'var(--green)', boxShadow: '0 0 6px var(--green)' }
      : seeders > 0
        ? { background: 'var(--yellow)' }
        : { background: 'var(--red)' }
  return <span className={styles.healthDot} style={style} title={seeders < 0 ? 'Connecting…' : `${seeders} seeders`} />
}

// Convert SRT/ASS text to VTT blob URL
function toVttBlobUrl(content) {
  let vtt = content
  if (!content.startsWith('WEBVTT')) {
    vtt = 'WEBVTT\n\n' + content.replace(/(\d+:\d+:\d+),(\d+)/g, '$1.$2')
  }
  return URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }))
}

// Build a human-readable label for a probed ffprobe stream
function streamLabel(s) {
  const parts = []
  if (s.language) parts.push(s.language.toUpperCase())
  if (s.title)    parts.push(s.title)
  if (!s.title && !s.language) parts.push(`Track ${s.index}`)
  if (s.codec)    parts.push(s.codec)
  if (s.channels) parts.push(`${s.channels}ch`)
  if (s.default)  parts.push('default')
  if (s.forced)   parts.push('forced')
  return parts.join(' · ')
}

// ── File Explorer ─────────────────────────────────────────────────────────────
function FileExplorer({ files, selectedFile, onSelect, infoHash }) {
  const [filter, setFilter] = useState('')
  const filtered = files.filter(f => !filter || f.name.toLowerCase().includes(filter.toLowerCase()))
  const videoFiles    = filtered.filter(f => f.playable)
  const subtitleFiles = filtered.filter(f => f.subtitle)

  const FileItem = ({ f, icon }) => (
    <div className={`${styles.fileItem} ${f.index === selectedFile ? styles.fileItemActive : ''} ${f.playable || f.subtitle ? '' : styles.fileItemDim}`} title={f.name}>
      <button className={styles.fileItemMain} onClick={() => (f.playable || f.subtitle) && onSelect(f.index)}>
        <span className={styles.fileIcon}>{icon}</span>
        <span className={styles.fileName}>{f.name}</span>
        <span className={styles.fileSize}>{fmt(f.length)}</span>
      </button>
      {infoHash && (
        <a className={styles.fileDownloadBtn} href={`/api/stream?infoHash=${infoHash}&file=${f.index}`} download={f.name} title={`Download ${f.name}`} onClick={e => e.stopPropagation()}>↓</a>
      )}
    </div>
  )

  return (
    <div className={styles.explorer}>
      <div className={styles.explorerSearch}>
        <input className={styles.explorerInput} placeholder="Filter files…" value={filter} onChange={e => setFilter(e.target.value)} />
      </div>
      <div className={styles.explorerList}>
        {videoFiles.length > 0 && (
          <div className={styles.explorerGroup}>
            <span className={styles.groupLabel}>▶ Video ({videoFiles.length})</span>
            {videoFiles.map(f => <FileItem key={f.index} f={f} icon="🎬" />)}
          </div>
        )}
        {subtitleFiles.length > 0 && (
          <div className={styles.explorerGroup}>
            <span className={styles.groupLabel}>CC Subtitles ({subtitleFiles.length})</span>
            {subtitleFiles.map(f => <FileItem key={f.index} f={f} icon="💬" />)}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function StreamPage() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const videoRef         = useRef(null)
  const hlsRef           = useRef(null)
  const statsRef         = useRef(null)
  const blobUrlsRef      = useRef([])
  const currentHlsKey    = useRef(null)
  const scrubberRef      = useRef(null)
  const controlsTimer    = useRef(null)
  const subDropdownRef   = useRef(null)
  const audioDropdownRef = useRef(null)

  // Route state
  const [magnet, setMagnet]         = useState(null)
  const [title, setTitle]           = useState('')
  const [routeError, setRouteError] = useState(null)

  // Torrent state
  const [torrentInfo, setTorrentInfo]   = useState(null)
  const [infoLoading, setInfoLoading]   = useState(false)
  const [infoError, setInfoError]       = useState(null)
  const [statusMsg, setStatusMsg]       = useState('Connecting…')
  const [selectedFile, setSelectedFile] = useState(null)
  const [sidebarOpen, setSidebarOpen]   = useState(false)
  const [stats, setStats]               = useState(null)

  // Stream mode
  const [streamMode, setStreamMode]   = useState('hls')
  const [hlsReady, setHlsReady]       = useState(false)
  const [hlsError, setHlsError]       = useState(null)
  const [hlsLoading, setHlsLoading]   = useState(false)
  const [directReady, setDirectReady] = useState(false)

  // ── Probe state — embedded audio + subtitle streams from ffprobe ──────────
  const [embeddedAudioStreams, setEmbeddedAudioStreams] = useState([])
  const [embeddedSubStreams,   setEmbeddedSubStreams]   = useState([])
  const [probeLoading, setProbeLoading]                = useState(false)

  // ── Subtitle state ────────────────────────────────────────────────────────
  // activeSub shape:
  //   null
  //   | { type: 'torrent',  index: number }
  //   | { type: 'embedded', streamIndex: number, label: string }
  //   | { type: 'external', sub: OpenSubtitlesResult }
  //   | { type: 'custom',   file: File }
  const [subtitleFiles, setSubtitleFiles]   = useState([])
  const [extSubs, setExtSubs]               = useState([])
  const [extSubsLoading, setExtSubsLoading] = useState(false)
  const [extSubsError, setExtSubsError]     = useState(null)
  const [activeSub, setActiveSub]           = useState(null)
  const [subEnabled, setSubEnabled]         = useState(false)
  const [subOpen, setSubOpen]               = useState(false)

  // ── Audio state ───────────────────────────────────────────────────────────
  const [hlsAudioTracks,   setHlsAudioTracks]   = useState([])
  const [selectedHlsAudio, setSelectedHlsAudio] = useState(0)
  const [audioOpen, setAudioOpen]               = useState(false)

  // Player UI state
  const [playing, setPlaying]                     = useState(false)
  const [currentTime, setCurrentTime]             = useState(0)
  const [duration, setDuration]                   = useState(0)
  const [volume, setVolume]                       = useState(1)
  const [muted, setMuted]                         = useState(false)
  const [bufferedEnd, setBufferedEnd]             = useState(0)
  const [isFullscreen, setIsFullscreen]           = useState(false)
  const [controlsVisible, setControlsVisible]     = useState(true)
  const [scrubHover, setScrubHover]               = useState(null)

  // ── Cleanup ───────────────────────────────────────────────────────────────
  const destroyHls = useCallback(() => {
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
    if (currentHlsKey.current) {
      const [hash, idx] = currentHlsKey.current.split(':')
      fetch(`/api/hls/${hash}/${idx}`, { method: 'DELETE' }).catch(() => {})
      currentHlsKey.current = null
    }
    blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u))
    blobUrlsRef.current = []
  }, [])

  useEffect(() => () => {
    destroyHls()
    clearInterval(statsRef.current)
    clearTimeout(controlsTimer.current)
  }, [destroyHls])

  // ── Close dropdowns on outside click ─────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (!subDropdownRef.current?.contains(e.target))   setSubOpen(false)
      if (!audioDropdownRef.current?.contains(e.target)) setAudioOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ── Controls auto-hide ────────────────────────────────────────────────────
  const nudgeControls = useCallback(() => {
    setControlsVisible(true)
    clearTimeout(controlsTimer.current)
    controlsTimer.current = setTimeout(() => setControlsVisible(false), 3500)
  }, [])

  // ── Video event sync ──────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const sync = () => {
      setPlaying(!video.paused)
      setCurrentTime(video.currentTime)
      setDuration(isNaN(video.duration) ? 0 : video.duration)
      setVolume(video.volume)
      setMuted(video.muted)
      if (video.buffered.length > 0) setBufferedEnd(video.buffered.end(video.buffered.length - 1))
    }
    const onFS = () => setIsFullscreen(!!document.fullscreenElement)
    ;['play','pause','timeupdate','durationchange','volumechange','progress'].forEach(ev => video.addEventListener(ev, sync))
    document.addEventListener('fullscreenchange', onFS)
    return () => {
      ;['play','pause','timeupdate','durationchange','volumechange','progress'].forEach(ev => video.removeEventListener(ev, sync))
      document.removeEventListener('fullscreenchange', onFS)
    }
  }, [])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return
      const v = videoRef.current; if (!v) return
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); v.paused ? v.play() : v.pause() }
      if (e.key === 'ArrowRight') v.currentTime = Math.min(v.duration || 0, v.currentTime + 10)
      if (e.key === 'ArrowLeft')  v.currentTime = Math.max(0, v.currentTime - 10)
      if (e.key === 'ArrowUp')    v.volume = Math.min(1, v.volume + 0.1)
      if (e.key === 'ArrowDown')  v.volume = Math.max(0, v.volume - 0.1)
      if (e.key === 'm') v.muted = !v.muted
      if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Media meta from search params
  const mediaMeta = {
    tmdbId:    searchParams.get('tmdbId')    || null,
    imdbId:    searchParams.get('imdbId')    || null,
    mediaType: searchParams.get('mediaType') || null,
    season:    searchParams.get('season')    ? parseInt(searchParams.get('season'))  : null,
    episode:   searchParams.get('episode')   ? parseInt(searchParams.get('episode')) : null,
  }

  // ── Parse route ───────────────────────────────────────────────────────────
  useEffect(() => {
    const m = id === 'magnet' ? searchParams.get('magnet') : null
    if (!m) { setRouteError('No magnet link provided'); return }
    setMagnet(m)
    setTitle(searchParams.get('title') || 'Loading…')
  }, [id, searchParams])

  // ── Load torrent info ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!magnet) return
    setInfoLoading(true); setInfoError(null); setStatusMsg('Connecting…')
    setTorrentInfo(null); setSelectedFile(null); setSubtitleFiles([])
    setExtSubs([]); setExtSubsLoading(false); setExtSubsError(null)
    setActiveSub(null); setSubEnabled(false)
    setHlsReady(false); setHlsError(null); setDirectReady(false)
    setEmbeddedAudioStreams([]); setEmbeddedSubStreams([])
    destroyHls()

    getTorrentInfo(magnet, msg => setStatusMsg(msg))
      .then(info => {
        setTorrentInfo(info)
        if (info.name) setTitle(info.name)
        const playable = info.files.filter(f => f.playable).sort((a, b) => b.length - a.length)
        if (playable.length === 0) { setInfoError('No playable video or audio files found in this torrent'); return }
        setSelectedFile(playable[0].index)
        if (info.files.length > 1) setSidebarOpen(true)
        const subs = info.files.filter(f => f.subtitle).map(f => ({
          index: f.index, name: f.name, ext: f.name.split('.').pop().toLowerCase(),
        }))
        setSubtitleFiles(subs)
        if (subs.length > 0) { setActiveSub({ type: 'torrent', index: subs[0].index }); setSubEnabled(true) }
      })
      .catch(e => setInfoError(e.message))
      .finally(() => setInfoLoading(false))
  }, [magnet])

  // ── Probe for embedded streams once per (infoHash, fileIndex) ─────────────
  useEffect(() => {
    if (!torrentInfo || selectedFile === null) return
    const { infoHash } = torrentInfo
    setEmbeddedAudioStreams([])
    setEmbeddedSubStreams([])
    setProbeLoading(true)

    fetch(`/api/probe?infoHash=${infoHash}&file=${selectedFile}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { console.warn('[probe]', data.error); return }
        const audioStreams = data.audioStreams    || []
        const subStreams   = data.subtitleStreams || []
        setEmbeddedAudioStreams(audioStreams)
        setEmbeddedSubStreams(subStreams)

        // Auto-select first embedded sub only if no sidecar subs and nothing active yet
        if (subtitleFiles.length === 0 && !activeSub && subStreams.length > 0) {
          const first = subStreams[0]
          setActiveSub({ type: 'embedded', streamIndex: first.index, label: streamLabel(first) })
          setSubEnabled(true)
        }
      })
      .catch(e => console.warn('[probe]', e.message))
      .finally(() => setProbeLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [torrentInfo, selectedFile])

  // ── External subtitles ────────────────────────────────────────────────────
  useEffect(() => {
    if (!torrentInfo) return
    setExtSubsLoading(true); setExtSubsError(null)
    const params = new URLSearchParams()
    if (mediaMeta.tmdbId) {
      params.set('tmdb_id', mediaMeta.tmdbId)
      if (mediaMeta.mediaType === 'tv' && mediaMeta.season)  params.set('season', String(mediaMeta.season))
      if (mediaMeta.mediaType === 'tv' && mediaMeta.episode) params.set('episode', String(mediaMeta.episode))
      params.set('languages', 'en,fr,de,es,pt,it,nl,pl,ru,ja,ko,zh')
    } else if (mediaMeta.imdbId) {
      params.set('imdb_id', mediaMeta.imdbId)
      if (mediaMeta.season)  params.set('season', String(mediaMeta.season))
      if (mediaMeta.episode) params.set('episode', String(mediaMeta.episode))
      params.set('languages', 'en,fr,de,es,pt,it,nl,pl,ru,ja,ko,zh')
    } else {
      const name = torrentInfo.name || ''
      const seMatch = name.match(/[Ss](\d{1,2})[Ee](\d{1,2})/)
      const cleanTitle = name
        .replace(/[Ss]\d{2}[Ee]\d{2}.*/i, '')
        .replace(/\b(720p|1080p|2160p|4k|uhd|bluray|brrip|webrip|web[-.]dl|hdtv|dvdrip|xvid|x264|x265|hevc|aac|ac3|dts|mkv|mp4|avi)\b.*/i, '')
        .replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim()
      if (!cleanTitle) { setExtSubsLoading(false); return }
      params.set('query', cleanTitle); params.set('languages', 'en')
      if (seMatch) { params.set('season', seMatch[1]); params.set('episode', seMatch[2]) }
    }
    fetch(`/api/subtitles/search?${params}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { if (!data.error.includes('not configured')) setExtSubsError(data.error); return }
        const results = data.results || []
        setExtSubs(results)
        // Only auto-select if nothing else is set
        if (subtitleFiles.length === 0 && embeddedSubStreams.length === 0 && !activeSub && results.length > 0) {
          const enSub = results.find(s => s.language === 'en' && s.file_id) || results.find(s => s.file_id)
          if (enSub) { setActiveSub({ type: 'external', sub: enSub }); setSubEnabled(true) }
        }
      })
      .catch(e => console.warn('[ext subs]', e.message))
      .finally(() => setExtSubsLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [torrentInfo])

  // ── Mode switch ───────────────────────────────────────────────────────────
  const handleModeSwitch = useCallback((newMode) => {
    const video = videoRef.current
    if (video) { video.pause(); video.removeAttribute('src'); video.load() }
    destroyHls()
    setHlsReady(false); setHlsError(null); setHlsLoading(false)
    setDirectReady(false); setHlsAudioTracks([]); setSelectedHlsAudio(0)
    setStreamMode(newMode)
  }, [destroyHls])

  // ── Start stream ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (selectedFile === null || !torrentInfo) return
    const infoHash = torrentInfo.infoHash, fileIndex = selectedFile
    const video = videoRef.current
    destroyHls()
    setHlsReady(false); setHlsError(null); setHlsLoading(false)
    setDirectReady(false); setHlsAudioTracks([]); setSelectedHlsAudio(0)
    if (!video) return

    if (streamMode === 'direct') {
      video.src = `/api/stream?infoHash=${infoHash}&file=${fileIndex}`
      video.addEventListener('canplay', () => setDirectReady(true), { once: true })
      video.addEventListener('error', () => setHlsError(`Browser can't decode this file directly. Try switching to HLS mode.`), { once: true })
      video.load(); video.play().catch(() => {})
      clearInterval(statsRef.current)
      statsRef.current = setInterval(async () => { const s = await getTorrentStats(infoHash); if (s) setStats(s) }, 2000)
      return
    }

    currentHlsKey.current = `${infoHash}:${fileIndex}`
    const masterUrl = `/api/hls/${infoHash}/${fileIndex}/master.m3u8`
    setHlsLoading(true)

    fetch(masterUrl)
      .then(r => { if (!r.ok) return r.json().then(d => { throw new Error(d.error || 'HLS start failed') }); return r.text() })
      .then(() => {
        setHlsLoading(false)
        if (Hls.isSupported()) {
          const hls = new Hls({
            startPosition: 0, liveSyncDurationCount: 999, liveMaxLatencyDurationCount: 9999,
            manifestLoadingMaxRetry: 10, manifestLoadingRetryDelay: 800,
            levelLoadingMaxRetry: 8,    levelLoadingRetryDelay: 500,
            fragLoadingMaxRetry: 6,
          })
          hlsRef.current = hls
          hls.loadSource(masterUrl); hls.attachMedia(video)
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setHlsReady(true); video.play().catch(() => {})
            // console.log('[hls] audioTracks:', JSON.stringify(hls.audioTracks))
            // console.log('[hls] currentAudioTrack:', hls.audioTrack)
            if (hls.audioTracks?.length > 1)
              setHlsAudioTracks(hls.audioTracks.map((t, i) => ({ id: t.id, index: i, name: t.name || t.lang || `Track ${i + 1}`, lang: t.lang })))
          })
          hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_, data) => {
            // console.log('[hls] AUDIO_TRACKS_UPDATED:', JSON.stringify(data.audioTracks))
            if (data.audioTracks?.length > 1) setHlsAudioTracks(data.audioTracks.map((t, i) => ({ id: t.id, index: i, name: t.name || t.lang || `Track ${i + 1}`, lang: t.lang })))
          })
          hls.on(Hls.Events.AUDIO_TRACK_SWITCHING, (_, data) => {
            // console.log('[hls] AUDIO_TRACK_SWITCHING:', JSON.stringify(data))
          })
          hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => {
            // console.log('[hls] AUDIO_TRACK_SWITCHED:', JSON.stringify(data))
          })
          hls.on(Hls.Events.LEVEL_UPDATED, (_, data) => {
            if (data.details && !data.details.live) console.log('[hls.js] VOD — full seek enabled')
          })
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal) {
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
              else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
              else { setHlsError(`Playback error: ${data.details}`); hls.destroy() }
            }
          })
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = masterUrl
          video.addEventListener('loadedmetadata', () => { setHlsReady(true); video.play().catch(() => {}) }, { once: true })
        } else {
          setHlsError('Your browser does not support HLS playback')
        }
      })
      .catch(err => { setHlsLoading(false); setHlsError(err.message) })

    clearInterval(statsRef.current)
    statsRef.current = setInterval(async () => { const s = await getTorrentStats(infoHash); if (s) setStats(s) }, 2000)
    return () => clearInterval(statsRef.current)
  }, [selectedFile, torrentInfo, streamMode])

  // ── HLS audio track switch ────────────────────────────────────────────────
  const handleHlsAudioChange = useCallback((trackId, arrayIndex) => {
    if (hlsRef.current) hlsRef.current.audioTrack = trackId  // hls.js wants the track id
    setSelectedHlsAudio(arrayIndex)
  }, [])

  // ── Subtitle injection ────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.querySelectorAll('track[data-dynamic]').forEach(t => t.remove())
    blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u))
    blobUrlsRef.current = []
    if (!subEnabled || !activeSub) return

    const injectTrack = (src, label) => {
      const track = document.createElement('track')
      track.kind = 'subtitles'; track.label = label; track.src = src; track.default = true
      track.setAttribute('data-dynamic', '1')
      track.addEventListener('load', () => {
        for (let i = 0; i < video.textTracks.length; i++)
          video.textTracks[i].mode = video.textTracks[i].label === label ? 'showing' : 'hidden'
      })
      video.appendChild(track)
    }

    if (activeSub.type === 'custom') {
      const reader = new FileReader()
      reader.onload = e => {
        const url = toVttBlobUrl(e.target.result)
        blobUrlsRef.current.push(url)
        injectTrack(url, 'Custom')
      }
      reader.readAsText(activeSub.file)
      return
    }

    // Embedded subtitle stream — extracted on the fly via /api/extract/subtitle
    if (activeSub.type === 'embedded' && torrentInfo) {
      const url = `/api/extract/subtitle?infoHash=${torrentInfo.infoHash}&file=${selectedFile}&stream=${activeSub.streamIndex}&format=vtt`
      injectTrack(url, activeSub.label || `Embedded ${activeSub.streamIndex}`)
      return
    }

    if (activeSub.type === 'torrent' && torrentInfo) {
      const f = torrentInfo.files[activeSub.index]; if (!f) return
      const ext = f.name.split('.').pop().toLowerCase()
      const apiUrl = `/api/subtitle?infoHash=${torrentInfo.infoHash}&file=${activeSub.index}`
      if (ext === 'vtt') {
        injectTrack(apiUrl, f.name)
      } else {
        fetch(apiUrl).then(r => r.text()).then(content => {
          const url = toVttBlobUrl(content)
          blobUrlsRef.current.push(url)
          injectTrack(url, f.name)
        }).catch(() => {})
      }
      return
    }

    if (activeSub.type === 'external' && activeSub.sub?.file_id) {
      const s = activeSub.sub
      injectTrack(
        `/api/subtitles/download?file_id=${s.file_id}&format=vtt`,
        `${s.language_name || s.language} — ${s.release || s.file_name || 'OpenSubtitles'}`
      )
    }
  }, [subEnabled, activeSub, torrentInfo, selectedFile])

  // ── Subtitle upload handler ───────────────────────────────────────────────
  const handleSubFile = (e) => {
    const file = e.target.files?.[0]
    if (file) { setActiveSub({ type: 'custom', file }); setSubEnabled(true) }
    e.target.value = ''
  }

  // ── Scrubber handlers ─────────────────────────────────────────────────────
  const handleScrubMove = useCallback((e) => {
    if (!duration) return
    const rect = scrubberRef.current?.getBoundingClientRect()
    if (!rect) return
    const xEl = e.clientX - rect.left
    const pct = Math.max(0, Math.min(1, xEl / rect.width))
    setScrubHover({ xEl, pct, time: pct * duration, elWidth: rect.width })
  }, [duration])

  const handleScrubLeave = useCallback(() => setScrubHover(null), [])

  const handleScrubClick = useCallback((e) => {
    const rect = scrubberRef.current?.getBoundingClientRect()
    if (!rect || !duration || !videoRef.current) return
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    videoRef.current.currentTime = pct * duration
  }, [duration])

  // ── Derived ───────────────────────────────────────────────────────────────
  const peers    = stats?.peers ?? torrentInfo?.peers ?? -1
  const progress = stats ? Math.round(stats.progress * 10000) / 100 : 0
  const currentFileName = selectedFile !== null && torrentInfo ? torrentInfo.files[selectedFile]?.name : null
  const isReady  = streamMode === 'hls' ? hlsReady : directReady
  const showLoadingOverlay = infoLoading || (selectedFile === null && !infoError && !hlsError)
  const showHlsLoading     = !infoLoading && selectedFile !== null && streamMode === 'hls' && hlsLoading && !hlsError
  const showError = !!(infoError || hlsError)
  const errorMsg  = infoError || hlsError

  // Show audio dropdown when hls.js found multiple tracks OR ffprobe found embedded tracks
  const showAudioDropdown = (streamMode === 'hls' && hlsAudioTracks.length > 1)

  // Current audio label for the dropdown trigger
  function getAudioLabel() {
    if (streamMode === 'hls' && hlsAudioTracks.length > 1) {
      const t = hlsAudioTracks[selectedHlsAudio]
      return t ? (t.name || t.lang || `Track ${selectedHlsAudio + 1}`) : 'Audio'
    }
    if (embeddedAudioStreams.length > 0) return 'Audio'
    return 'Audio'
  }

  // Current subtitle label for the CC trigger
  function getSubLabel() {
    if (!activeSub) return 'Off'
    if (activeSub.type === 'torrent')  return subtitleFiles.find(f => f.index === activeSub.index)?.name || 'Subtitle'
    if (activeSub.type === 'embedded') return activeSub.label || 'Embedded'
    if (activeSub.type === 'external') return activeSub.sub?.release || activeSub.sub?.language_name || 'External'
    if (activeSub.type === 'custom')   return activeSub.file?.name || 'Custom'
    return 'Subtitle'
  }

  // Group OpenSubtitles results by language name
  const extSubsByLang = extSubs.reduce((acc, sub) => {
    const lang = sub.language_name || sub.language
    if (!acc[lang]) acc[lang] = []
    acc[lang].push(sub); return acc
  }, {})

  if (routeError) return (
    <div className={styles.errorPage}>
      <button className={styles.backBtn} onClick={() => navigate(-1)}>← Back</button>
      <div className={styles.errorBox}><span>⚠</span><p>{routeError}</p></div>
    </div>
  )

  return (
    <div className={styles.page} onMouseMove={nudgeControls}>

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div className={`${styles.topBar} ${isReady && !controlsVisible ? styles.topBarHidden : ''}`}>
        <button className={styles.backBtn} onClick={() => navigate(-1)}>← Back</button>

        <div className={styles.topTitle}>
          <SeedHealth seeders={peers} />
          <h1 className={styles.titleText}>{title}</h1>
          {currentFileName && currentFileName !== title && (
            <span className={styles.fileNameTag}>{currentFileName}</span>
          )}
        </div>

        {(stats || peers >= 0) && (
          <div className={styles.topStats}>
            {stats && (
              <>
                <span className={styles.topStat}><span className={styles.topStatIcon}>↓</span><span className={styles.topStatVal}>{fmtSpeed(stats.downloadSpeed)}</span></span>
                <span className={styles.topStatSep}>·</span>
                <span className={styles.topStat}><span className={styles.topStatIcon}>↑</span><span className={styles.topStatVal}>{fmtSpeed(stats.uploadSpeed)}</span></span>
                <span className={styles.topStatSep}>·</span>
                <span className={styles.topStat}><span className={styles.topStatLabel}>ETA</span><span className={styles.topStatVal}>{fmtETA(stats.timeRemaining)}</span></span>
                <span className={styles.topStatSep}>·</span>
              </>
            )}
            <span className={styles.topStat}><span className={styles.topStatLabel}>Peers</span><span className={styles.topStatVal}>{peers >= 0 ? peers : '…'}</span></span>
            {stats && (
              <>
                <span className={styles.topStatSep}>·</span>
                <span className={styles.topStat}><span className={styles.topStatLabel}>Buf</span><span className={`${styles.topStatVal} ${styles.topStatHighlight}`}>{progress}%</span></span>
              </>
            )}
          </div>
        )}

        <button className={`${styles.explorerToggle} ${sidebarOpen ? styles.explorerToggleActive : ''}`} onClick={() => setSidebarOpen(o => !o)} title="Toggle file explorer">
          <span>⊞</span>
          <span className={styles.explorerToggleLabel}>Files</span>
          {torrentInfo && <span className={styles.fileCountBadge}>{torrentInfo.files.length}</span>}
        </button>
      </div>

      {/* ── Main layout ──────────────────────────────────────────────────── */}
      <div className={`${styles.mainLayout} ${sidebarOpen ? styles.withSidebar : ''}`}>
        <div className={styles.playerArea}>

          {showLoadingOverlay && (
            <div className={styles.playerOverlay}>
              <div className={styles.overlaySpinner} />
              <p className={styles.overlayMsg}>{statusMsg}</p>
              <p className={styles.overlayHint}>Connecting to BitTorrent network…</p>
              <div className={styles.loadingDots}><span /><span /><span /></div>
            </div>
          )}

          {showHlsLoading && (
            <div className={styles.playerOverlay}>
              <div className={styles.overlaySpinner} />
              <p className={styles.overlayMsg}>Starting transcoder…</p>
              <p className={styles.overlayHint}>FFmpeg is preparing your stream. This takes 2–5 seconds.</p>
              <div className={styles.loadingDots}><span /><span /><span /></div>
            </div>
          )}

          {showError && (
            <div className={styles.playerOverlay}>
              <div className={styles.errorIcon}>⚠</div>
              <p className={styles.overlayMsg}>{errorMsg}</p>
              {hlsError?.includes('FFmpeg') && (
                <p className={styles.overlayHint}>
                  Install FFmpeg and make sure it's in your PATH.<br />
                  Windows: <code>choco install ffmpeg</code><br />
                  macOS: <code>brew install ffmpeg</code><br />
                  Linux: <code>apt install ffmpeg</code>
                </p>
              )}
              {streamMode === 'hls' && !infoError && (
                <button className={styles.retryBtn} style={{ marginTop: '0.5rem' }} onClick={() => handleModeSwitch('direct')}>Try Direct mode instead</button>
              )}
              <button className={styles.retryBtn} onClick={() => window.location.reload()}>Reload page</button>
            </div>
          )}

          <div className={styles.playerBox} style={{ opacity: isReady && !showError ? 1 : 0 }}>
            <video
              ref={videoRef}
              className={styles.video}
              controls={false}
              playsInline
              crossOrigin="anonymous"
              onClick={() => { const v = videoRef.current; v && (v.paused ? v.play() : v.pause()) }}
            >
              Your browser does not support HTML5 video.
            </video>
          </div>

          {/* ── Controls bar ─────────────────────────────────────────────── */}
          {selectedFile !== null && torrentInfo && (
            <div className={`${styles.statsBar} ${isReady && !controlsVisible ? styles.controlsHidden : ''}`}>

              {isReady && (
                <div
                  className={styles.scrubberWrap}
                  ref={scrubberRef}
                  onMouseMove={handleScrubMove}
                  onMouseLeave={handleScrubLeave}
                  onClick={handleScrubClick}
                >
                  {scrubHover && (
                    <div
                      className={styles.scrubTooltip}
                      style={{ left: Math.max(24, Math.min(scrubHover.xEl, (scrubHover.elWidth || 0) - 24)) }}
                    >
                      {fmtTime(scrubHover.time)}
                    </div>
                  )}
                  <div className={styles.scrubTrack}>
                    <div className={styles.scrubBuffered} style={{ width: duration ? `${(bufferedEnd / duration) * 100}%` : '0%' }} />
                    {scrubHover && <div className={styles.scrubGhost} style={{ width: `${scrubHover.pct * 100}%` }} />}
                    <div className={styles.scrubPlayed}   style={{ width: duration ? `${(currentTime / duration) * 100}%` : '0%' }} />
                    {duration > 0 && <div className={styles.scrubThumb} style={{ left: `${(currentTime / duration) * 100}%` }} />}
                  </div>
                </div>
              )}

              {!isReady && (
                <div className={styles.progressTrack}>
                  <div className={styles.progressFill} style={{ width: `${progress}%` }} />
                </div>
              )}

              <div className={styles.statsRow}>

                {/* Playback controls */}
                {isReady && (
                  <div className={styles.playbackControls}>
                    <button className={styles.playBtn} onClick={() => { const v = videoRef.current; v && (v.paused ? v.play() : v.pause()) }} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
                      {playing
                        ? <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                        : <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M8 5.14v14l11-7-11-7z"/></svg>
                      }
                    </button>
                    <button className={styles.skipBtn} onClick={() => { const v = videoRef.current; if (v) v.currentTime = Math.max(0, v.currentTime - 10) }} title="Back 10s (←)">
                      <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
                    </button>
                    <button className={styles.skipBtn} onClick={() => { const v = videoRef.current; if (v) v.currentTime = Math.min(v.duration || 0, v.currentTime + 10) }} title="Forward 10s (→)">
                      <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17"><path d="M6 18l8.5-6L6 6v12zm2.5-6 5.5 3.9V8.1L8.5 12zM16 6h2v12h-2z"/></svg>
                    </button>
                    <div className={styles.volumeGroup}>
                      <button className={styles.skipBtn} onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted }} title="Mute (M)">
                        {muted || volume === 0
                          ? <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17"><path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25A6.968 6.968 0 0112 19c-.34 0-.67-.03-1-.07v2.07c.33.03.66.06 1 .06 2.19 0 4.2-.72 5.81-1.91l1.92 1.92L21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/></svg>
                          : volume < 0.5
                          ? <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17"><path d="M18.5 12A4.5 4.5 0 0016 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>
                          : <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                        }
                      </button>
                      <input
                        type="range" min="0" max="1" step="0.02"
                        value={muted ? 0 : volume}
                        onChange={e => { const v2 = parseFloat(e.target.value); const v = videoRef.current; if (v) { v.volume = v2; v.muted = v2 === 0 } }}
                        className={styles.volumeSlider}
                        style={{ '--vol-pct': `${(muted ? 0 : volume) * 100}%` }}
                      />
                    </div>
                    {duration > 0 && (
                      <span className={styles.timeDisplay}>
                        {fmtTime(currentTime)} <span className={styles.timeSep}>/</span> {fmtTime(duration)}
                      </span>
                    )}
                  </div>
                )}

                {/* Stream mode toggle */}
                <div className={styles.modeToggle}>
                  <button className={`${styles.modeBtn} ${streamMode === 'hls'    ? styles.modeBtnActive : ''}`} onClick={() => streamMode !== 'hls'    && handleModeSwitch('hls')}    title="HLS — FFmpeg transcode">HLS</button>
                  <button className={`${styles.modeBtn} ${streamMode === 'direct' ? styles.modeBtnActive : ''}`} onClick={() => streamMode !== 'direct' && handleModeSwitch('direct')} title="Direct — raw stream">Direct</button>
                </div>

                {/* ── Audio dropdown ───────────────────────────────────────
                    HLS mode: shows hls.js tracks (switchable) + embedded info.
                    Direct mode: shows embedded streams from ffprobe (informational).
                ─────────────────────────────────────────────────────────── */}
                {showAudioDropdown && (
                  <div className={styles.trackDropdownWrap} ref={audioDropdownRef}>
                    <button
                      className={`${styles.trackTriggerBtn} ${audioOpen ? styles.trackTriggerOpen : ''}`}
                      onClick={() => setAudioOpen(o => !o)}
                      title="Audio track"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13" style={{ flexShrink: 0, opacity: 0.8 }}>
                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
                      </svg>
                      <span className={styles.trackTriggerLabel}>{getAudioLabel()}</span>
                      <span className={`${styles.dropArrow} ${audioOpen ? styles.dropArrowOpen : ''}`} />
                    </button>

                    {audioOpen && (
                      <div className={styles.trackDropdown}>

                        {/* HLS audio tracks (only in HLS mode with >1 track) */}
                        {streamMode === 'hls' && hlsAudioTracks.length > 1 && (
                          <>
                            <div className={styles.trackGroupLabel}>HLS Tracks</div>
                            {hlsAudioTracks.map((t, i) => (
                              <div
                                key={t.id ?? i}
                                className={`${styles.trackOption} ${i === selectedHlsAudio ? styles.trackOptionActive : ''}`}
                                onClick={() => { handleHlsAudioChange(t.id ?? i, i); setAudioOpen(false) }}
                              >
                                {i === selectedHlsAudio && <span className={styles.trackCheck}>✓</span>}
                                {t.name || t.lang || `Track ${i + 1}`}
                              </div>
                            ))}
                          </>
                        )}

                        {/* Embedded audio streams from ffprobe */}
                        {/* {embeddedAudioStreams.length > 0 && (
                          <>
                            <div className={styles.trackGroupLabel}>
                              {streamMode === 'hls' && hlsAudioTracks.length > 1 ? 'Embedded (info only)' : 'Embedded Tracks'}
                            </div>
                            {embeddedAudioStreams.map(s => (
                              <div
                                key={s.index}
                                className={styles.trackOption}
                                style={{ opacity: streamMode === 'hls' ? 0.45 : 1, cursor: 'default' }}
                                title={streamMode === 'hls' ? 'Switch to Direct mode to use embedded tracks directly' : undefined}
                              >
                                {streamLabel(s)}
                              </div>
                            ))}
                            {streamMode === 'hls' && (
                              <div className={styles.trackHint}>Use Direct mode to pick embedded tracks</div>
                            )}
                          </>
                        )} */}

                      </div>
                    )}
                  </div>
                )}

                {/* ── Subtitle / CC dropdown ───────────────────────────────
                    Groups (in order):
                      Off → Embedded (ffprobe) → In Torrent → OpenSubtitles → Custom
                ─────────────────────────────────────────────────────────── */}
                <div className={styles.subControls} ref={subDropdownRef}>

                  {/* CC toggle pill */}
                  <button
                    className={`${styles.subToggleBtn} ${subEnabled ? styles.subActive : ''}`}
                    onClick={() => {
                      if (subEnabled) { setSubEnabled(false); setActiveSub(null); setSubOpen(false) }
                      else { setSubEnabled(true); setSubOpen(true) }
                    }}
                    title={subEnabled ? 'Subtitles on — click to disable' : 'Subtitles off — click to enable'}
                  >
                    {(extSubsLoading || probeLoading) ? '…' : 'CC'}
                  </button>

                  {/* Dropdown trigger */}
                  <div className={styles.subDropdownWrapper}>
                    <button className={styles.subSelectTrigger} onClick={() => setSubOpen(v => !v)}>
                      <span className={styles.subTriggerLabel}>{getSubLabel()}</span>
                      <span className={`${styles.dropArrow} ${subOpen ? styles.dropArrowOpen : ''}`} />
                    </button>

                    {subOpen && (
                      <div className={styles.subDropdown}>

                        {/* Off */}
                        <div
                          className={`${styles.subOption} ${!activeSub ? styles.subOptionActive : ''}`}
                          onClick={() => { setSubEnabled(false); setActiveSub(null); setSubOpen(false) }}
                        >
                          {!activeSub && <span className={styles.trackCheck}>✓</span>}
                          Off
                        </div>

                        {/* Embedded subtitle streams from ffprobe */}
                        {embeddedSubStreams.length > 0 && (
                          <>
                            <div className={styles.subGroupLabel}>Embedded in File</div>
                            {embeddedSubStreams.map(s => {
                              const isActive = activeSub?.type === 'embedded' && activeSub.streamIndex === s.index
                              return (
                                <div
                                  key={s.index}
                                  className={`${styles.subOption} ${isActive ? styles.subOptionActive : ''}`}
                                  onClick={() => {
                                    setActiveSub({ type: 'embedded', streamIndex: s.index, label: streamLabel(s) })
                                    setSubEnabled(true)
                                    setSubOpen(false)
                                  }}
                                >
                                  {isActive && <span className={styles.trackCheck}>✓</span>}
                                  {streamLabel(s)}
                                </div>
                              )
                            })}
                          </>
                        )}

                        {/* Sidecar subtitle files in the torrent */}
                        {subtitleFiles.length > 0 && (
                          <>
                            <div className={styles.subGroupLabel}>In Torrent</div>
                            {subtitleFiles.map(f => {
                              const isActive = activeSub?.type === 'torrent' && activeSub.index === f.index
                              return (
                                <div
                                  key={f.index}
                                  className={`${styles.subOption} ${isActive ? styles.subOptionActive : ''}`}
                                  onClick={() => {
                                    setActiveSub({ type: 'torrent', index: f.index })
                                    setSubEnabled(true)
                                    setSubOpen(false)
                                  }}
                                >
                                  {isActive && <span className={styles.trackCheck}>✓</span>}
                                  {f.name}
                                </div>
                              )
                            })}
                          </>
                        )}

                        {/* OpenSubtitles results grouped by language */}
                        {Object.entries(extSubsByLang).map(([langName, subs]) => (
                          <div key={langName}>
                            <div className={styles.subGroupLabel}>{langName} — OpenSubtitles</div>
                            {subs.slice(0, 5).map(sub => {
                              const isActive = activeSub?.type === 'external' && activeSub.sub?.file_id === sub.file_id
                              return (
                                <div
                                  key={sub.file_id}
                                  className={`${styles.subOption} ${isActive ? styles.subOptionActive : ''}`}
                                  onClick={() => {
                                    setActiveSub({ type: 'external', sub })
                                    setSubEnabled(true)
                                    setSubOpen(false)
                                  }}
                                >
                                  {isActive && <span className={styles.trackCheck}>✓</span>}
                                  <span className={styles.subOptionText}>
                                    {sub.release || sub.file_name || sub.subtitle_id}
                                  </span>
                                  {sub.hearing_impaired && <span className={styles.subBadge}>HI</span>}
                                  {sub.from_trusted     && <span className={styles.subBadgeTrusted}>✓</span>}
                                </div>
                              )
                            })}
                          </div>
                        ))}

                        {/* Custom uploaded subtitle (shown if already active) */}
                        {activeSub?.type === 'custom' && (
                          <>
                            <div className={styles.subGroupLabel}>Custom</div>
                            <div className={`${styles.subOption} ${styles.subOptionActive}`}>
                              <span className={styles.trackCheck}>✓</span>
                              📎 {activeSub.file.name}
                            </div>
                          </>
                        )}

                        {/* Empty state */}
                        {embeddedSubStreams.length === 0 && subtitleFiles.length === 0 && extSubs.length === 0 && !activeSub && (
                          <div className={styles.subOptionDim}>
                            {probeLoading || extSubsLoading ? 'Loading…' : 'No subtitles found'}
                          </div>
                        )}

                      </div>
                    )}
                  </div>

                  {extSubsError && <span className={styles.extSubsError} title={extSubsError}>⚠</span>}

                  {/* Upload custom subtitle file */}
                  <label className={styles.subUploadBtn} title="Upload .srt / .vtt / .ass">
                    <span>+</span>
                    <input type="file" accept=".srt,.vtt,.ass,.ssa" onChange={handleSubFile} style={{ display: 'none' }} />
                  </label>
                </div>

                {/* Fullscreen */}
                {isReady && (
                  <button
                    className={styles.fsBtn}
                    onClick={() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()}
                    title="Fullscreen (F)"
                  >
                    {isFullscreen
                      ? <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
                      : <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
                    }
                  </button>
                )}

              </div>{/* /statsRow */}
            </div>
          )}
        </div>{/* /playerArea */}

        {/* Sidebar */}
        {sidebarOpen && torrentInfo && (
          <FileExplorer
            files={torrentInfo.files}
            selectedFile={selectedFile}
            onSelect={setSelectedFile}
            infoHash={torrentInfo.infoHash}
          />
        )}
      </div>

      {magnet && (
        <div className={styles.magnetInfo}>
          <span className={styles.magnetLabel}>Magnet</span>
          <span className={styles.magnetVal}>{magnet.slice(0, 80)}…</span>
        </div>
      )}
    </div>
  )
}