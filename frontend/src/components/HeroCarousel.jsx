
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './HeroCarousel.module.css'

export default function HeroCarousel({ items = [], onPlay }) {
  const [idx, setIdx] = useState(0)
  const [transitioning, setTransitioning] = useState(false)
  const timerRef = useRef(null)
  const navigate = useNavigate()

  const goTo = useCallback((i) => {
    if (transitioning || i === idx) return
    setTransitioning(true)
    setTimeout(() => {
      setIdx(i)
      setTransitioning(false)
    }, 300)
  }, [transitioning, idx])

  const next = useCallback(() => goTo((idx + 1) % items.length), [goTo, idx, items.length])
  const prev = useCallback(() => goTo((idx - 1 + items.length) % items.length), [goTo, idx, items.length])

  useEffect(() => {
    if (items.length < 2) return
    timerRef.current = setInterval(next, 7000)
    return () => clearInterval(timerRef.current)
  }, [next, items.length])

  if (!items.length) return null
  const item = items[idx]
  const backdrop = item.backdrop || item.backdropOriginal

  return (
    <div className={styles.hero}>
      {/* Background */}
      <div className={`${styles.bg} ${transitioning ? styles.bgFade : ''}`}>
        {backdrop && (
          <img src={backdrop} alt="" className={styles.bgImg} key={idx} />
        )}
        <div className={styles.bgGrad1} />
        <div className={styles.bgGrad2} />
        <div className={styles.bgGrad3} />
      </div>

      {/* Content */}
      <div className={`${styles.content} ${transitioning ? styles.contentFade : ''}`}>
        <div className={styles.inner}>
          {/* Metadata pill */}
          <div className={styles.metaPill}>
            {item.mediaType === 'tv' ? (
              <span className={styles.typeChip}>TV SERIES</span>
            ) : (
              <span className={styles.typeChip}>FILM</span>
            )}
            {item.year && <span className={styles.metaYear}>{item.year}</span>}
            {item.certification && <span className={styles.cert}>{item.certification}</span>}
            {item.tmdbRating && (
              <span className={styles.rating}>
                <span className={styles.ratingStar}>★</span>
                {item.tmdbRating}
              </span>
            )}
            {item.runtime && <span className={styles.metaYear}>{item.runtime}m</span>}
          </div>

          {/* Title */}
          <h1 className={styles.title}>{item.title || item.name}</h1>

          {/* Genres */}
          {item.genres?.length > 0 && (
            <div className={styles.genres}>
              {item.genres.slice(0,4).map(g => (
                <span key={g} className={styles.genre}>{g}</span>
              ))}
            </div>
          )}

          {/* Overview */}
          {item.overview && (
            <p className={styles.overview}>{item.overview.slice(0, 200)}{item.overview.length > 200 ? '…' : ''}</p>
          )}

          {/* Actions */}
          <div className={styles.actions}>
            <button
              className={styles.playBtn}
              onClick={() => navigate(`/title/${item.mediaType || 'movie'}/${item.tmdbId}`)}
            >
              <span className={styles.playIcon}>▶</span>
              Stream Now
            </button>
            {/* <button
              className={styles.infoBtn}
              onClick={() => navigate(`/title/${item.mediaType || 'movie'}/${item.tmdbId}`)}
            >
              <span>ⓘ</span>
              More Info
            </button> */}
            {item.trailer && (
              <a
                href={item.trailer}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.trailerBtn}
                onClick={e => e.stopPropagation()}
              >
                <span>▷</span>
                Trailer
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Navigation arrows */}
      {items.length > 1 && (
        <>
          <button className={`${styles.arrow} ${styles.arrowLeft}`} onClick={prev}>‹</button>
          <button className={`${styles.arrow} ${styles.arrowRight}`} onClick={next}>›</button>
        </>
      )}

      {/* Dots */}
      {items.length > 1 && (
        <div className={styles.dots}>
          {items.map((_, i) => (
            <button
              key={i}
              className={`${styles.dot} ${i === idx ? styles.dotActive : ''}`}
              onClick={() => goTo(i)}
            />
          ))}
        </div>
      )}

      {/* Progress bar */}
      {items.length > 1 && (
        <div className={styles.progressTrack}>
          <div className={styles.progressBar} key={idx} />
        </div>
      )}
    </div>
  )
}
