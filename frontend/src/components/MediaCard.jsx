
import React, { memo, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './MediaCard.module.css'

function StarRating({ rating }) {
  const stars = Math.round(rating / 2)
  return (
    <span className={styles.stars}>
      {[1,2,3,4,5].map(i => (
        <span key={i} className={i <= stars ? styles.starFilled : styles.starEmpty}>★</span>
      ))}
    </span>
  )
}

const MediaCard = memo(function MediaCard({ item, onPlay, variant = 'default' }) {
  const navigate = useNavigate()
  const [imgErr, setImgErr] = useState(false)
  const [hovered, setHovered] = useState(false)

  const poster = item.poster || item.posterThumb
  const title = item.title || item.name || 'Unknown'
  const year = item.year || ''
  const rating = item.tmdbRating
  const genres = item.genres || []
  const overview = item.overview || ''
  const mediaType = item.mediaType || 'movie'

  const handleClick = useCallback(() => {
    if (item.tmdbId) {
      navigate(`/title/${mediaType}/${item.tmdbId}`)
    } else if (onPlay) {
      onPlay(item)
    }
  }, [item, navigate, onPlay, mediaType])

  const handlePlay = useCallback((e) => {
    e.stopPropagation()
    if (onPlay) onPlay(item)
  }, [item, onPlay])

  if (variant === 'wide') {
    return (
      <article
        className={`${styles.cardWide} ${hovered ? styles.hovered : ''}`}
        onClick={handleClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        role="button" tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && handleClick()}
      >
        <div className={styles.wideThumb}>
          {!imgErr && poster ? (
            <img src={poster} alt="" className={styles.wideImg} onError={() => setImgErr(true)} loading="lazy" />
          ) : (
            <div className={styles.imgFallback}><span>▶</span></div>
          )}
          <div className={styles.wideOverlay} />
        </div>
        <div className={styles.wideBody}>
          <div className={styles.wideMeta}>
            <span className={styles.badge}>{mediaType === 'tv' ? 'TV' : 'Movie'}</span>
            {year && <span className={styles.year}>{year}</span>}
          </div>
          <h3 className={styles.wideTitle}>{title}</h3>
          {rating && <div className={styles.ratingRow}><StarRating rating={rating} /><span className={styles.ratingNum}>{rating}</span></div>}
          {overview && <p className={styles.wideOverview}>{overview.slice(0, 100)}…</p>}
          {/* {onPlay && (
            <button className={styles.playBtnWide} onClick={handlePlay}>
              <span>▶</span> Stream
            </button>
          )} */}
        </div>
      </article>
    )
  }

  return (
    <article
      className={`${styles.card} ${hovered ? styles.hovered : ''}`}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button" tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && handleClick()}
      aria-label={title}
    >
      <div className={styles.posterWrap}>
        {!imgErr && poster ? (
          <img src={poster} alt="" className={styles.poster} onError={() => setImgErr(true)} loading="lazy" />
        ) : (
          <div className={styles.imgFallback}><span>🎬</span></div>
        )}

        {/* Gradient overlay */}
        <div className={styles.posterGrad} />

        {/* Hover overlay */}
        <div className={styles.hoverOverlay}>
          <div className={styles.hoverContent}>
            {overview && <p className={styles.hoverOverview}>{overview.slice(0, 120)}…</p>}
            <div className={styles.hoverActions}>
              {/* <button className={styles.playCircle} onClick={handlePlay} title="Stream">
                <span>▶</span>
              </button> */}
              {/* <button className={styles.infoCircle} onClick={(e) => { e.stopPropagation(); handleClick() }} title="Details">
                <span>ⓘ</span>
              </button> */}
            </div>
          </div>
        </div>

        {/* Badges */}
        <div className={styles.topBadges}>
          {rating && (
            <span className={styles.ratingBadge}>
              <span className={styles.star}>★</span>
              {rating}
            </span>
          )}
          <span className={styles.typeBadge}>{mediaType === 'tv' ? 'TV' : '🎬'}</span>
        </div>

        {/* Bottom info always visible */}
        <div className={styles.bottomInfo}>
          {genres.slice(0,2).map(g => <span key={g} className={styles.genreTag}>{g}</span>)}
        </div>
      </div>

      <div className={styles.cardBody}>
        <h3 className={styles.cardTitle}>{title}</h3>
        <div className={styles.cardMeta}>
          {year && <span className={styles.cardYear}>{year}</span>}
          {/* {rating && <span className={styles.cardRating}><span className={styles.goldStar}>★</span>{rating}</span>} */}
        </div>
      </div>
    </article>
  )
})

export default MediaCard
