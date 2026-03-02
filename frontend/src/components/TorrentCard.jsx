import React, { memo, useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import HealthBadge from './HealthBadge.jsx'
import styles from './TorrentCard.module.css'

function formatBytes(bytes) {
  if (!bytes) return 'Unknown'
  const gb = bytes / 1e9
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  return `${(bytes / 1e6).toFixed(0)} MB`
}

function getPosterUrl(title) {
  const clean = title
    .replace(/\b(1080p|720p|480p|2160p|4K|BluRay|BrRip|WEBRip|WEB-DL|HDTV|x264|x265|HEVC|AAC|DDP|DTS|HDR|SDR|YIFY|PROPER|REPACK|EXTENDED)\b.*/gi, '')
    .replace(/\((\d{4})\).*/, '($1)')
    .trim()
  return `https://img.omdbapi.com/?t=${encodeURIComponent(clean)}&apikey=trilogy&h=200`
}

const TorrentCard = memo(function TorrentCard({ torrent }) {
  const navigate = useNavigate()
  const [imgError, setImgError] = useState(false)

  const handleClick = useCallback(() => {
    const isInfoHash = torrent.id && !torrent.id.includes('-')
    if (isInfoHash && torrent.magnet_link) {
      navigate(`/stream/magnet?magnet=${encodeURIComponent(torrent.magnet_link)}&title=${encodeURIComponent(torrent.title)}`)
    } else {
      navigate(`/stream/${torrent.id}`)
    }
  }, [torrent, navigate])

  return (
    <article
      className={styles.card}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && handleClick()}
      aria-label={`Stream ${torrent.title}`}
    >
      {/* Poster */}
      <div className={styles.posterWrap}>
        {!imgError ? (
          <img
            src={getPosterUrl(torrent.title)}
            alt=""
            className={styles.poster}
            onError={() => setImgError(true)}
            loading="lazy"
          />
        ) : (
          <div className={styles.posterFallback}>
            <span>▶</span>
          </div>
        )}
        <div className={styles.posterOverlay}>
          <span className={styles.playIcon}>▶</span>
        </div>
        <div className={styles.badgeRow}>
          <HealthBadge seeders={torrent.seeders} />
          {torrent.source && <span className={styles.source}>{torrent.source}</span>}
        </div>
      </div>

      <div className={styles.body}>
        {torrent.category && <span className={styles.category}>{torrent.category}</span>}
        <h3 className={styles.title} title={torrent.title}>{torrent.title}</h3>
        <div className={styles.meta}>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>Size</span>
            {formatBytes(torrent.size_bytes)}
          </span>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>Seeds</span>
            <span style={{ color: torrent.seeders > 10 ? 'var(--green)' : torrent.seeders > 0 ? 'var(--yellow)' : 'var(--red)' }}>
              {torrent.seeders}
            </span>
          </span>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>Peers</span>
            {torrent.leechers}
          </span>
        </div>
      </div>
    </article>
  )
})

export default TorrentCard
