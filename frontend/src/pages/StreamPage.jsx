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

function SeedHealth({ seeders }) {
  const style = seeders < 0
    ? { background: 'var(--muted)' }
    : seeders > 10
      ? { background: 'var(--green)', boxShadow: '0 0 6px var(--green)' }
      : seeders > 0
        ? { background: 'var(--yellow)' }
        : { background: 'var(--red)' }
  const label = seeders < 0 ? 'Connecting…' : `${seeders} seeders`
  return <span className={styles.healthDot} style={style} title={label} />
}

// Convert SRT/ASS text to VTT blob URL
function toVttBlobUrl(content, ext) {
  let vtt = content
  if (!content.startsWith('WEBVTT')) {
    vtt = 'WEBVTT\n\n' + content.replace(/(\d+:\d+:\d+),(\d+)/g, '$1.$2')
  }
  return URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }))
}

// ── File Explorer ─────────────────────────────────────────────────────────────
function FileExplorer({ files, selectedFile, onSelect, infoHash }) {
  const [filter, setFilter] = useState('')
  const filtered = files.filter(f => !filter || f.name.toLowerCase().includes(filter.toLowerCase()))
  const videoFiles = filtered.filter(f => f.playable)
  const subtitleFiles = filtered.filter(f => f.subtitle)
  const otherFiles = filtered.filter(f => !f.playable && !f.subtitle)

  const FileItem = ({ f, icon }) => (
    <div
      className={`${styles.fileItem} ${f.index === selectedFile ? styles.fileItemActive : ''} ${f.playable || f.subtitle ? '' : styles.fileItemDim}`}
      title={f.name}
    >
      <button
        className={styles.fileItemMain}
        onClick={() => (f.playable || f.subtitle) && onSelect(f.index)}
      >
        <span className={styles.fileIcon}>{icon}</span>
        <span className={styles.fileName}>{f.name}</span>
        <span className={styles.fileSize}>{fmt(f.length)}</span>
      </button>
      {infoHash && (
        <a
          className={styles.fileDownloadBtn}
          href={`/api/stream?infoHash=${infoHash}&file=${f.index}`}
          download={f.name}
          title={`Download ${f.name}`}
          onClick={e => e.stopPropagation()}
        >↓</a>
      )}
    </div>
  )

  return (
    <div className={styles.explorer}>
      <div className={styles.explorerHeader}>
        <span className={styles.explorerTitle}>Files</span>
        <span className={styles.explorerCount}>{files.length}</span>
      </div>
      <div className={styles.explorerSearch}>
        <input
          className={styles.explorerInput}
          placeholder="Filter files…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
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
        {otherFiles.length > 0 && (
          <div className={styles.explorerGroup}>
            <span className={styles.groupLabel}>Other ({otherFiles.length})</span>
            {otherFiles.map(f => <FileItem key={f.index} f={f} icon="📄" />)}
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

  const videoRef      = useRef(null)
  const hlsRef        = useRef(null)
  const statsRef      = useRef(null)
  const blobUrlsRef   = useRef([])
  const currentHlsKey = useRef(null)

  // ── Route state ───────────────────────────────────────────────────────────
  const [magnet, setMagnet]           = useState(null)
  const [title, setTitle]             = useState('')
  const [routeError, setRouteError]   = useState(null)

  // ── Torrent state ─────────────────────────────────────────────────────────
  const [torrentInfo, setTorrentInfo] = useState(null)
  const [infoLoading, setInfoLoading] = useState(false)
  const [infoError, setInfoError]     = useState(null)
  const [statusMsg, setStatusMsg]     = useState('Connecting…')
  const [selectedFile, setSelectedFile] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [stats, setStats]             = useState(null)

  // ── Mode: 'hls' | 'direct' ───────────────────────────────────────────────
  // HLS = FFmpeg transcoding → segments (best compatibility, AC3/DTS → AAC)
  // Direct = raw HTTP range stream (native browser codecs, instant start)
  const [streamMode, setStreamMode]   = useState('hls')

  // ── HLS state ─────────────────────────────────────────────────────────────
  const [hlsReady, setHlsReady]       = useState(false)
  const [hlsError, setHlsError]       = useState(null)
  const [hlsLoading, setHlsLoading]   = useState(false)

  // ── Direct stream state ───────────────────────────────────────────────────
  const [directReady, setDirectReady] = useState(false)

  // ── Subtitle state ────────────────────────────────────────────────────────
  const [subtitleFiles, setSubtitleFiles]   = useState([])   // from torrent
  const [extSubs, setExtSubs]               = useState([])   // from OpenSubtitles
  const [extSubsLoading, setExtSubsLoading] = useState(false)
  const [extSubsError, setExtSubsError]     = useState(null)
  const [selectedSubIdx, setSelectedSubIdx] = useState(null) // torrent file index
  const [selectedExtSub, setSelectedExtSub] = useState(null) // { file_id, file_name, language_name }
  const [subEnabled, setSubEnabled]         = useState(false)
  const [customSubtitle, setCustomSubtitle] = useState(null)

  // ── Audio state ───────────────────────────────────────────────────────────
  const [hlsAudioTracks, setHlsAudioTracks]   = useState([])
  const [selectedAudio, setSelectedAudio]     = useState(0)

  // ── Cleanup ───────────────────────────────────────────────────────────────
  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }
    if (currentHlsKey.current) {
      const [hash, idx] = currentHlsKey.current.split(':')
      fetch(`/api/hls/${hash}/${idx}`, { method: 'DELETE' }).catch(() => {})
      currentHlsKey.current = null
    }
    blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u))
    blobUrlsRef.current = []
  }, [])

  useEffect(() => {
    return () => {
      destroyHls()
      clearInterval(statsRef.current)
    }
  }, [destroyHls])

  // ── Parse route ───────────────────────────────────────────────────────────
  // Media context params written by DetailPage — used for subtitle lookup.
  // All are optional; StreamPage falls back to torrent-name parsing if absent.
  const mediaMeta = {
    tmdbId:    searchParams.get('tmdbId')    || null,
    imdbId:    searchParams.get('imdbId')    || null,
    mediaType: searchParams.get('mediaType') || null,  // 'movie' | 'tv'
    season:    searchParams.get('season')    ? parseInt(searchParams.get('season'))  : null,
    episode:   searchParams.get('episode')   ? parseInt(searchParams.get('episode')) : null,
  }

  useEffect(() => {
    const m = id === 'magnet' ? searchParams.get('magnet') : null
    if (!m) { setRouteError('No magnet link provided'); return }
    setMagnet(m)
    setTitle(searchParams.get('title') || 'Loading…')
  }, [id, searchParams])

  // ── Load torrent info via SSE ─────────────────────────────────────────────
  useEffect(() => {
    if (!magnet) return
    setInfoLoading(true)
    setInfoError(null)
    setStatusMsg('Connecting…')
    setTorrentInfo(null)
    setSelectedFile(null)
    setSubtitleFiles([])
    setExtSubs([])
    setExtSubsLoading(false)
    setExtSubsError(null)
    setSelectedSubIdx(null)
    setSelectedExtSub(null)
    setSubEnabled(false)
    setCustomSubtitle(null)
    setHlsReady(false)
    setHlsError(null)
    setDirectReady(false)
    destroyHls()

    getTorrentInfo(magnet, msg => setStatusMsg(msg))
      .then(info => {
        setTorrentInfo(info)
        if (info.name) setTitle(info.name)

        const playable = info.files.filter(f => f.playable).sort((a, b) => b.length - a.length)
        if (playable.length === 0) {
          setInfoError('No playable video or audio files found in this torrent')
          return
        }
        setSelectedFile(playable[0].index)
        if (info.files.length > 1) setSidebarOpen(true)

        const subs = info.files
          .filter(f => f.subtitle)
          .map(f => ({ index: f.index, name: f.name, ext: f.name.split('.').pop().toLowerCase() }))
        setSubtitleFiles(subs)
        if (subs.length > 0) {
          setSelectedSubIdx(subs[0].index)
          setSubEnabled(true)
        }
      })
      .catch(e => setInfoError(e.message))
      .finally(() => setInfoLoading(false))
  }, [magnet])

  // ── Fetch external subtitles from OpenSubtitles ───────────────────────────
  // Uses media context passed via URL params from DetailPage (tmdbId, imdbId,
  // season, episode) for accurate results.  Falls back to parsing the torrent
  // name only when those params are absent (e.g. direct magnet paste).
  useEffect(() => {
    if (!torrentInfo) return

    setExtSubsLoading(true)
    setExtSubsError(null)

    // ── Build the best possible search params ─────────────────────────────
    const params = new URLSearchParams()

    if (mediaMeta.tmdbId) {
      // Best case: we have the TMDB ID from the detail page.
      // OpenSubtitles matches on this exactly — no title ambiguity at all.
      params.set('tmdb_id', mediaMeta.tmdbId)
      if (mediaMeta.mediaType === 'tv' && mediaMeta.season)  params.set('season',  String(mediaMeta.season))
      if (mediaMeta.mediaType === 'tv' && mediaMeta.episode) params.set('episode', String(mediaMeta.episode))
      // Still send languages; OS requires at least one lookup param alongside IDs
      params.set('languages', 'en,fr,de,es,pt,it,nl,pl,ru,ja,ko,zh')
    } else if (mediaMeta.imdbId) {
      // Good fallback: IMDb ID is unambiguous
      params.set('imdb_id', mediaMeta.imdbId)
      if (mediaMeta.season)  params.set('season',  String(mediaMeta.season))
      if (mediaMeta.episode) params.set('episode', String(mediaMeta.episode))
      params.set('languages', 'en,fr,de,es,pt,it,nl,pl,ru,ja,ko,zh')
    } else {
      // Last resort: parse the torrent name.
      // This path only runs when the user pastes a magnet directly (no detail page).
      const name = torrentInfo.name || ''
      const seMatch = name.match(/[Ss](\d{1,2})[Ee](\d{1,2})/)
      const season  = seMatch ? parseInt(seMatch[1]) : null
      const episode = seMatch ? parseInt(seMatch[2]) : null

      const cleanTitle = name
        .replace(/[Ss]\d{2}[Ee]\d{2}.*/i, '')
        .replace(/\b(720p|1080p|2160p|4k|uhd|bluray|brrip|webrip|web[-.]dl|hdtv|dvdrip|xvid|x264|x265|hevc|aac|ac3|dts|mkv|mp4|avi)\b.*/i, '')
        .replace(/[._-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      if (!cleanTitle) { setExtSubsLoading(false); return }

      params.set('query', cleanTitle)
      params.set('languages', 'en')
      if (season)  params.set('season',  String(season))
      if (episode) params.set('episode', String(episode))
    }

    fetch(`/api/subtitles/search?${params}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          if (data.error.includes('not configured')) {
            console.log('[ext subs] OpenSubtitles API key not set — skipping')
          } else {
            setExtSubsError(data.error)
          }
          return
        }

        const results = data.results || []
        setExtSubs(results)

        // Auto-select best English sub if the torrent has no embedded subs
        if (subtitleFiles.length === 0 && results.length > 0) {
          const enSub = results.find(s => s.language === 'en' && s.file_id)
                     || results.find(s => s.file_id)
          if (enSub) {
            setSelectedExtSub(enSub)
            setSubEnabled(true)
          }
        }
      })
      .catch(e => console.warn('[ext subs]', e.message))
      .finally(() => setExtSubsLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [torrentInfo])
  // When user toggles HLS ↔ Direct, tear down whatever is running and restart
  const handleModeSwitch = useCallback((newMode) => {
    const video = videoRef.current
    if (video) {
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
    destroyHls()
    setHlsReady(false)
    setHlsError(null)
    setHlsLoading(false)
    setDirectReady(false)
    setHlsAudioTracks([])
    setSelectedAudio(0)
    setStreamMode(newMode)
  }, [destroyHls])

  // ── Start stream when file or mode changes ────────────────────────────────
  useEffect(() => {
    if (selectedFile === null || !torrentInfo) return

    const infoHash  = torrentInfo.infoHash
    const fileIndex = selectedFile
    const video     = videoRef.current

    // Tear down previous player state
    destroyHls()
    setHlsReady(false)
    setHlsError(null)
    setHlsLoading(false)
    setDirectReady(false)
    setHlsAudioTracks([])
    setSelectedAudio(0)

    if (!video) return

    // ── DIRECT MODE ───────────────────────────────────────────────────────
    // Bypass FFmpeg entirely. Feed the raw torrent byte-stream directly to
    // the browser via HTTP range requests. Instant start, no CPU cost.
    // Works great for MP4/WebM. MKV + AC3 audio will likely fail in Chrome
    // (no AC3 decoder). Firefox handles more codecs natively.
    if (streamMode === 'direct') {
      const src = `/api/stream?infoHash=${infoHash}&file=${fileIndex}`
      video.src = src
      video.addEventListener('canplay', () => setDirectReady(true), { once: true })
      video.addEventListener('error', () => {
        setHlsError(
          `Browser can't decode this file directly. ` +
          `Try switching to HLS mode (the toggle in the controls bar) ` +
          `which transcodes audio to AAC for universal compatibility.`
        )
      }, { once: true })
      video.load()
      video.play().catch(() => {})

      // Stats polling
      clearInterval(statsRef.current)
      statsRef.current = setInterval(async () => {
        const s = await getTorrentStats(infoHash)
        if (s) setStats(s)
      }, 2000)
      return
    }

    // ── HLS MODE ──────────────────────────────────────────────────────────
    // Server transcodes via FFmpeg: video copy + audio → AAC.
    // hls.js loads the growing .m3u8 playlist.
    //
    // SEEKING FIX (client side):
    //   After MANIFEST_PARSED, check if the playlist is live or VOD.
    //   - While FFmpeg is still running → live (seeking limited to buffered range)
    //   - After FFmpeg finishes & writes #EXT-X-ENDLIST → VOD (full seek works)
    //   We set liveSyncDurationCount=Infinity during live phase to prevent
    //   hls.js from auto-jumping to the "live edge" which caused random seeks.
    //
    currentHlsKey.current = `${infoHash}:${fileIndex}`
    const masterUrl = `/api/hls/${infoHash}/${fileIndex}/master.m3u8`

    setHlsLoading(true)

    fetch(masterUrl)
      .then(r => {
        if (!r.ok) return r.json().then(d => { throw new Error(d.error || 'HLS start failed') })
        return r.text()
      })
      .then(() => {
        setHlsLoading(false)

        if (Hls.isSupported()) {
          const hls = new Hls({
            startPosition: 0,
            // ── SEEKING FIX (live auto-seek prevention) ──────────────────
            // During transcoding the playlist looks like a live stream to hls.js.
            // liveSyncDurationCount controls how far behind the "live edge" hls.js
            // tries to keep the playhead. Setting it very high prevents auto-seeks.
            // Once the playlist gets #EXT-X-ENDLIST, hls.js promotes it to VOD
            // and these settings are ignored — full seek bar is enabled.
            liveSyncDurationCount: 999,       // don't chase live edge during transcode
            liveMaxLatencyDurationCount: 9999, // don't force-seek to live edge
            // ─────────────────────────────────────────────────────────────
            manifestLoadingMaxRetry: 10,
            manifestLoadingRetryDelay: 800,
            levelLoadingMaxRetry: 8,
            levelLoadingRetryDelay: 500,
            fragLoadingMaxRetry: 6,
          })

          hlsRef.current = hls
          hls.loadSource(masterUrl)
          hls.attachMedia(video)

          hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
            setHlsReady(true)
            video.play().catch(() => {})

            if (hls.audioTracks && hls.audioTracks.length > 1) {
              setHlsAudioTracks(hls.audioTracks.map((t, i) => ({
                id: t.id,
                name: t.name || t.lang || `Track ${i + 1}`,
                lang: t.lang,
              })))
            }
          })

          // When the playlist transitions from live → VOD (FFmpeg finishes),
          // hls.js fires LEVEL_UPDATED. We can detect this to inform the user.
          hls.on(Hls.Events.LEVEL_UPDATED, (_, data) => {
            if (data.details && !data.details.live) {
              console.log('[hls.js] playlist promoted to VOD — full seek enabled')
            }
          })

          hls.on(Hls.Events.ERROR, (_, data) => {
            if (data.fatal) {
              switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  console.warn('[hls.js] network error, recovering…', data.details)
                  hls.startLoad()
                  break
                case Hls.ErrorTypes.MEDIA_ERROR:
                  console.warn('[hls.js] media error, recovering…', data.details)
                  hls.recoverMediaError()
                  break
                default:
                  console.error('[hls.js] fatal error', data)
                  setHlsError(`Playback error: ${data.details}`)
                  hls.destroy()
                  break
              }
            }
          })

        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // Native HLS (Safari)
          video.src = masterUrl
          video.addEventListener('loadedmetadata', () => {
            setHlsReady(true)
            video.play().catch(() => {})
          }, { once: true })
        } else {
          setHlsError('Your browser does not support HLS playback')
        }
      })
      .catch(err => {
        setHlsLoading(false)
        setHlsError(err.message)
      })

    // Stats polling
    clearInterval(statsRef.current)
    statsRef.current = setInterval(async () => {
      const s = await getTorrentStats(infoHash)
      if (s) setStats(s)
    }, 2000)

    return () => { clearInterval(statsRef.current) }
  }, [selectedFile, torrentInfo, streamMode])

  // ── Audio track switch ────────────────────────────────────────────────────
  const handleAudioTrackChange = useCallback((index) => {
    if (hlsRef.current) hlsRef.current.audioTrack = index
    setSelectedAudio(index)
  }, [])

  // ── Subtitle management ───────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    video.querySelectorAll('track[data-dynamic]').forEach(t => t.remove())
    blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u))
    blobUrlsRef.current = []

    if (!subEnabled) return

    const injectTrack = (src, label) => {
      const track = document.createElement('track')
      track.kind    = 'subtitles'
      track.label   = label
      track.src     = src
      track.default = true
      track.setAttribute('data-dynamic', '1')
      track.addEventListener('load', () => {
        for (let i = 0; i < video.textTracks.length; i++) {
          video.textTracks[i].mode = video.textTracks[i].label === label ? 'showing' : 'hidden'
        }
      })
      video.appendChild(track)
    }

    // Priority: custom file > torrent sub > external (OpenSubtitles)
    if (customSubtitle) {
      const reader = new FileReader()
      reader.onload = e => {
        const ext = customSubtitle.name.split('.').pop().toLowerCase()
        const url = toVttBlobUrl(e.target.result, ext)
        blobUrlsRef.current.push(url)
        injectTrack(url, 'Custom')
      }
      reader.readAsText(customSubtitle)
      return
    }

    if (selectedSubIdx !== null && torrentInfo) {
      // Torrent subtitle file
      const f = torrentInfo.files[selectedSubIdx]
      if (!f) return
      const ext    = f.name.split('.').pop().toLowerCase()
      const apiUrl = `/api/subtitle?infoHash=${torrentInfo.infoHash}&file=${selectedSubIdx}`

      if (ext === 'vtt') {
        injectTrack(apiUrl, f.name)
      } else {
        fetch(apiUrl)
          .then(r => r.text())
          .then(content => {
            const url = toVttBlobUrl(content, ext)
            blobUrlsRef.current.push(url)
            injectTrack(url, f.name)
          })
          .catch(() => {})
      }
      return
    }

    if (selectedExtSub?.file_id) {
      // External subtitle from OpenSubtitles — fetch via our proxy endpoint
      // which handles the two-step OS API flow and converts SRT→VTT server-side
      const label = `${selectedExtSub.language_name || selectedExtSub.language} — ${selectedExtSub.release || selectedExtSub.file_name || 'OpenSubtitles'}`
      const proxyUrl = `/api/subtitles/download?file_id=${selectedExtSub.file_id}&format=vtt`
      injectTrack(proxyUrl, label)
    }
  }, [subEnabled, selectedSubIdx, selectedExtSub, customSubtitle, torrentInfo])

  // ── Subtitle handlers ─────────────────────────────────────────────────────
  const handleSubFile = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      setCustomSubtitle(file)
      setSelectedSubIdx(null)
      setSelectedExtSub(null)
      setSubEnabled(true)
    }
    e.target.value = ''
  }

  const handleSubSelect = (e) => {
    const val = e.target.value
    if (val === '__off__') {
      setSubEnabled(false)
      setSelectedSubIdx(null)
      setSelectedExtSub(null)
      setCustomSubtitle(null)
      return
    }
    if (val === '__custom__') return

    if (val.startsWith('ext:')) {
      // External subtitle from OpenSubtitles — val = "ext:{file_id}"
      const fileId = parseInt(val.slice(4))
      const sub = extSubs.find(s => s.file_id === fileId)
      if (sub) {
        setSelectedExtSub(sub)
        setSelectedSubIdx(null)
        setCustomSubtitle(null)
        setSubEnabled(true)
      }
      return
    }

    // Torrent subtitle file
    setSelectedSubIdx(parseInt(val))
    setSelectedExtSub(null)
    setCustomSubtitle(null)
    setSubEnabled(true)
  }

  // Group external subs by language for the <optgroup> selector
  const extSubsByLang = extSubs.reduce((acc, sub) => {
    const lang = sub.language_name || sub.language
    if (!acc[lang]) acc[lang] = []
    acc[lang].push(sub)
    return acc
  }, {})

  // ── Derived values ────────────────────────────────────────────────────────
  const peers           = stats?.peers ?? torrentInfo?.peers ?? -1
  const progress        = stats ? Math.round(stats.progress * 10000) / 100 : 0
  const currentFileName = selectedFile !== null && torrentInfo
    ? torrentInfo.files[selectedFile]?.name : null

  const isReady         = streamMode === 'hls' ? hlsReady : directReady
  const showLoadingOverlay = infoLoading || (selectedFile === null && !infoError && !hlsError)
  const showHlsLoading     = !infoLoading && selectedFile !== null && streamMode === 'hls' && hlsLoading && !hlsError
  const showError          = !!(infoError || hlsError)
  const errorMsg           = infoError || hlsError

  if (routeError) {
    return (
      <div className={styles.errorPage}>
        <button className={styles.backBtn} onClick={() => navigate(-1)}>← Back</button>
        <div className={styles.errorBox}><span>⚠</span><p>{routeError}</p></div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      {/* Top bar */}
      <div className={styles.topBar}>
        <button className={styles.backBtn} onClick={() => navigate(-1)}>← Back</button>
        <div className={styles.topTitle}>
          <SeedHealth seeders={peers} />
          <h1 className={styles.titleText}>{title}</h1>
          {currentFileName && currentFileName !== title && (
            <span className={styles.fileNameTag}>{currentFileName}</span>
          )}
        </div>
        <button
          className={`${styles.explorerToggle} ${sidebarOpen ? styles.explorerToggleActive : ''}`}
          onClick={() => setSidebarOpen(o => !o)}
          title="Toggle file explorer"
        >
          <span>⊞</span>
          <span className={styles.explorerToggleLabel}>Files</span>
          {torrentInfo && <span className={styles.fileCountBadge}>{torrentInfo.files.length}</span>}
        </button>
      </div>

      {/* Main layout */}
      <div className={`${styles.mainLayout} ${sidebarOpen ? styles.withSidebar : ''}`}>
        <div className={styles.playerArea}>

          {/* Torrent loading overlay */}
          {showLoadingOverlay && (
            <div className={styles.playerOverlay}>
              <div className={styles.overlaySpinner} />
              <p className={styles.overlayMsg}>{statusMsg}</p>
              <p className={styles.overlayHint}>Connecting to BitTorrent network…</p>
              <div className={styles.loadingDots}><span /><span /><span /></div>
            </div>
          )}

          {/* HLS transcoding overlay */}
          {showHlsLoading && (
            <div className={styles.playerOverlay}>
              <div className={styles.overlaySpinner} />
              <p className={styles.overlayMsg}>Starting transcoder…</p>
              <p className={styles.overlayHint}>FFmpeg is preparing your stream. This takes 2–5 seconds.</p>
              <div className={styles.loadingDots}><span /><span /><span /></div>
            </div>
          )}

          {/* Error overlay */}
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
              {/* If HLS failed, offer a quick escape to Direct mode */}
              {streamMode === 'hls' && !infoError && (
                <button
                  className={styles.retryBtn}
                  style={{ marginTop: '0.5rem' }}
                  onClick={() => handleModeSwitch('direct')}
                >
                  Try Direct mode instead
                </button>
              )}
              <button className={styles.retryBtn} onClick={() => window.location.reload()}>Reload page</button>
            </div>
          )}

          {/* Video player */}
          <div
            className={styles.playerBox}
            style={{ opacity: isReady && !showError ? 1 : 0 }}
          >
            <video
              ref={videoRef}
              className={styles.video}
              controls
              playsInline
              crossOrigin="anonymous"
            >
              Your browser does not support HTML5 video.
            </video>
          </div>

          {/* Stats + controls bar */}
          {selectedFile !== null && torrentInfo && (
            <div className={styles.statsBar}>
              <div className={styles.progressTrack}>
                <div className={styles.progressFill} style={{ width: `${progress}%` }} />
              </div>
              <div className={styles.statsRow}>
                {/* Stats */}
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Buffer</span>
                  <span className={styles.statVal}>{progress}%</span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>↓ Speed</span>
                  <span className={`${styles.statVal} ${styles.highlight}`}>
                    {stats ? fmtSpeed(stats.downloadSpeed) : '—'}
                  </span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Peers</span>
                  <span className={styles.statVal}>{peers >= 0 ? peers : '…'}</span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>ETA</span>
                  <span className={styles.statVal}>{stats ? fmtETA(stats.timeRemaining) : '—'}</span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>↑ Upload</span>
                  <span className={styles.statVal}>{stats ? fmtSpeed(stats.uploadSpeed) : '—'}</span>
                </div>

                {/* ── Stream mode toggle ─────────────────────────────────── */}
                {/*
                  HLS  = FFmpeg transcodes → .ts segments via hls.js
                         ✓ AC3/DTS/EAC3 audio remuxed to AAC (universal)
                         ✓ Seeking works after transcoding completes
                         ✗ 2–5s startup delay (FFmpeg spin-up)
                         ✗ Disk usage grows while transcoding
                  Direct = raw HTTP range stream, no transcoding
                         ✓ Instant start
                         ✓ Zero CPU overhead
                         ✗ Browser must support the codec (AC3 fails in Chrome)
                */}
                <div className={styles.modeToggle} title="Switch between HLS transcoding and direct streaming">
                  <button
                    className={`${styles.modeBtn} ${streamMode === 'hls' ? styles.modeBtnActive : ''}`}
                    onClick={() => streamMode !== 'hls' && handleModeSwitch('hls')}
                    title="HLS — FFmpeg transcode, universal audio support, full seek after buffer"
                  >
                    HLS
                  </button>
                  <button
                    className={`${styles.modeBtn} ${streamMode === 'direct' ? styles.modeBtnActive : ''}`}
                    onClick={() => streamMode !== 'direct' && handleModeSwitch('direct')}
                    title="Direct — raw stream, instant start, browser-native codecs only"
                  >
                    Direct
                  </button>
                </div>

                {/* ── Subtitle controls ─────────────────────────────────── */}
                <div className={styles.subControls}>
                  <button
                    className={`${styles.subToggleBtn} ${subEnabled ? styles.subActive : ''}`}
                    onClick={() => {
                      setSubEnabled(p => !p)
                      if (subEnabled) { setSelectedSubIdx(null); setSelectedExtSub(null); setCustomSubtitle(null) }
                    }}
                    title={subEnabled ? 'Subtitles on — click to disable' : 'Subtitles off — click to enable'}
                  >
                    {extSubsLoading ? '…' : 'CC'}
                  </button>

                  {/* Show selector when: subs are enabled, or there are options available */}
                  {(subEnabled || subtitleFiles.length > 0 || extSubs.length > 0 || customSubtitle) && (
                    <select
                      className={styles.subSelect}
                      value={
                        customSubtitle      ? '__custom__'
                        : selectedExtSub    ? `ext:${selectedExtSub.file_id}`
                        : selectedSubIdx !== null ? String(selectedSubIdx)
                        : '__off__'
                      }
                      onChange={handleSubSelect}
                    >
                      <option value="__off__">Off</option>

                      {/* Torrent subtitle files */}
                      {subtitleFiles.length > 0 && (
                        <optgroup label="— In Torrent —">
                          {subtitleFiles.map(f => (
                            <option key={f.index} value={String(f.index)}>{f.name}</option>
                          ))}
                        </optgroup>
                      )}

                      {/* External subs from OpenSubtitles, grouped by language */}
                      {Object.keys(extSubsByLang).length > 0 && (
                        Object.entries(extSubsByLang).map(([langName, subs]) => (
                          <optgroup key={langName} label={`— ${langName} (OpenSubtitles) —`}>
                            {subs.slice(0, 5).map(sub => (
                              <option key={sub.file_id} value={`ext:${sub.file_id}`}>
                                {sub.release || sub.file_name || sub.subtitle_id}
                                {sub.hearing_impaired ? ' [HI]' : ''}
                                {sub.from_trusted ? ' ✓' : ''}
                              </option>
                            ))}
                          </optgroup>
                        ))
                      )}

                      {/* Custom uploaded file */}
                      {customSubtitle && (
                        <option value="__custom__">📎 {customSubtitle.name}</option>
                      )}
                    </select>
                  )}

                  {extSubsError && (
                    <span className={styles.extSubsError} title={extSubsError}>⚠</span>
                  )}

                  <label className={styles.subUploadBtn} title="Upload .srt / .vtt / .ass">
                    <span>+</span>
                    <input type="file" accept=".srt,.vtt,.ass,.ssa" onChange={handleSubFile} style={{ display: 'none' }} />
                  </label>
                </div>

                {/* ── Audio track selector (HLS only) ──────────────────── */}
                {streamMode === 'hls' && hlsAudioTracks.length > 1 && (
                  <div className={styles.audioTrackWrap}>
                    <span className={styles.audioLabel}>🔊</span>
                    <select
                      className={styles.audioSelect}
                      value={selectedAudio}
                      onChange={e => handleAudioTrackChange(parseInt(e.target.value))}
                    >
                      {hlsAudioTracks.map((t, i) => (
                        <option key={t.id ?? i} value={i}>
                          {t.name || t.lang || `Track ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

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

      {/* Magnet info */}
      {magnet && (
        <div className={styles.magnetInfo}>
          <span className={styles.magnetLabel}>Magnet</span>
          <span className={styles.magnetVal}>{magnet.slice(0, 80)}…</span>
        </div>
      )}
    </div>
  )
}