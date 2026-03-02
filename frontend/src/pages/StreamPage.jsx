import React, { useRef, useEffect, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { getTorrentInfo, getStreamUrl, getTorrentStats } from '../api/torrents.js'
import HealthBadge from '../components/HealthBadge.jsx'
import ErrorMessage from '../components/ErrorMessage.jsx'
import styles from './StreamPage.module.css'

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

function StatBox({ label, value, highlight }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${highlight ? styles.highlight : ''}`}>{value}</span>
    </div>
  )
}

// ── File picker modal ─────────────────────────────────────────────────────────
function FilePicker({ files, onSelect }) {
  const playable = files.filter(f => f.playable).sort((a, b) => b.length - a.length)
  return (
    <div className={styles.pickerBackdrop}>
      <div className={styles.picker}>
        <h2 className={styles.pickerTitle}>Choose a file to play</h2>
        <p className={styles.pickerHint}>This torrent has {playable.length} playable files</p>
        <div className={styles.pickerList}>
          {playable.map(f => (
            <button key={f.index} className={styles.pickerItem} onClick={() => onSelect(f.index)}>
              <span className={styles.pickerPlay}>▶</span>
              <span className={styles.pickerName}>{f.name}</span>
              <span className={styles.pickerSize}>{fmt(f.length)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function StreamPage() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const videoRef = useRef(null)
  const statsIntervalRef = useRef(null)

  // Route state
  const [magnet, setMagnet] = useState(null)
  const [title, setTitle] = useState('')
  const [routeError, setRouteError] = useState(null)

  // Torrent info from server
  const [torrentInfo, setTorrentInfo] = useState(null)
  const [infoLoading, setInfoLoading] = useState(false)
  const [infoError, setInfoError] = useState(null)
  const [statusMsg, setStatusMsg] = useState('Connecting…')

  // File selection
  const [showPicker, setShowPicker] = useState(false)
  const [selectedFile, setSelectedFile] = useState(null) // null = not yet chosen

  // Live stats
  const [stats, setStats] = useState(null)

  // Step 1: extract magnet from URL
  useEffect(() => {
    const m = id === 'magnet'
      ? searchParams.get('magnet')
      : null  // could extend for saved torrents

    if (!m) { setRouteError('No magnet link provided'); return }
    setMagnet(m)
    setTitle(searchParams.get('title') || 'Loading…')
  }, [id, searchParams])

  // Step 2: fetch torrent info via SSE once magnet is known
  useEffect(() => {
    if (!magnet) return
    setInfoLoading(true)
    setInfoError(null)
    setStatusMsg('Connecting…')
    setTorrentInfo(null)
    setSelectedFile(null)
    setShowPicker(false)

    getTorrentInfo(magnet, msg => setStatusMsg(msg))
      .then(info => {
        setTorrentInfo(info)
        if (info.name) setTitle(info.name)

        const playableFiles = info.files.filter(f => f.playable).sort((a, b) => b.length - a.length)
        if (playableFiles.length === 0) {
          setInfoError('No playable video or audio files found in this torrent')
        } else if (playableFiles.length === 1) {
          // Only one choice — start immediately
          setSelectedFile(playableFiles[0].index)
        } else {
          // Multiple playable files — show picker
          setShowPicker(true)
        }
      })
      .catch(e => setInfoError(e.message))
      .finally(() => setInfoLoading(false))
  }, [magnet])

  // Step 3: once file is selected, wire up video src and start stats polling
  useEffect(() => {
    if (selectedFile === null || !torrentInfo) return

    const url = getStreamUrl(torrentInfo.infoHash, selectedFile)
    if (videoRef.current) {
      videoRef.current.src = url
      videoRef.current.load()
      videoRef.current.play().catch(() => {})
    }

    clearInterval(statsIntervalRef.current)
    statsIntervalRef.current = setInterval(async () => {
      const s = await getTorrentStats(torrentInfo.infoHash)
      if (s) setStats(s)
    }, 2000)

    return () => clearInterval(statsIntervalRef.current)
  }, [selectedFile, torrentInfo])

  const handlePickFile = (index) => {
    setShowPicker(false)
    setSelectedFile(index)
  }

  const peers = stats?.peers ?? torrentInfo?.peers ?? -1
  const progress = stats ? Math.round(stats.progress * 10000) / 100 : 0

  const currentFileName = selectedFile !== null && torrentInfo
    ? torrentInfo.files[selectedFile]?.name
    : null

  return (
    <div className={styles.page}>
      <button className={styles.back} onClick={() => navigate(-1)}>← Back</button>

      {routeError && <ErrorMessage message={routeError} />}

      {!routeError && (
        <>
          <header className={styles.header}>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>{title}</h1>
              <HealthBadge seeders={peers} showLabel />
            </div>
            {currentFileName && (
              <p className={styles.fileName}>
                {currentFileName}
                {torrentInfo && torrentInfo.files.filter(f => f.playable).length > 1 && (
                  <button className={styles.switchBtn} onClick={() => setShowPicker(true)}>
                    Switch file
                  </button>
                )}
              </p>
            )}
          </header>

          {/* File picker modal */}
          {showPicker && torrentInfo && (
            <FilePicker files={torrentInfo.files} onSelect={handlePickFile} />
          )}

          <div className={styles.playerWrapper}>
            {/* Loading overlay */}
            {(infoLoading || (selectedFile === null && !infoError && !showPicker)) && (
              <div className={styles.overlay}>
                <div className={styles.spinner} />
                <p className={styles.overlayText}>{statusMsg}</p>
                <p className={styles.overlayHint}>Finding peers on BitTorrent network…</p>
              </div>
            )}

            {/* Error overlay */}
            {infoError && (
              <div className={styles.overlay}>
                <ErrorMessage message={infoError} />
              </div>
            )}

            {/* Waiting for file selection overlay */}
            {showPicker && !infoLoading && (
              <div className={styles.overlay}>
                <p className={styles.overlayText}>Select a file to begin</p>
              </div>
            )}

            <video
              ref={videoRef}
              className={styles.video}
              controls
              playsInline
              style={{ display: selectedFile !== null && !infoError ? 'block' : 'none' }}
            />
          </div>

          {/* Stats bar */}
          {selectedFile !== null && torrentInfo && (
            <div className={styles.stats}>
              <StatBox label="Progress" value={`${progress}%`} />
              <StatBox label="Download" value={stats ? fmtSpeed(stats.downloadSpeed) : '—'} highlight />
              <StatBox label="Upload" value={stats ? fmtSpeed(stats.uploadSpeed) : '—'} />
              <StatBox label="Peers" value={peers >= 0 ? peers : '…'} />
              <StatBox label="ETA" value={stats ? fmtETA(stats.timeRemaining) : '—'} />
              <div className={styles.progressBarWrapper}>
                <div className={styles.progressBar} style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {magnet && (
            <div className={styles.magnetSection}>
              <p className={styles.magnetLabel}>Magnet Link</p>
              <p className={styles.magnetValue}>{magnet.slice(0, 90)}…</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
