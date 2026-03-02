
import React, { useRef, useState } from 'react'
import MediaCard from './MediaCard.jsx'
import styles from './Carousel.module.css'

export default function Carousel({ title, items = [], onPlay, loading = false, subtitle }) {
  const rowRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(true)

  const scroll = (dir) => {
    const el = rowRef.current
    if (!el) return
    const amount = el.clientWidth * 0.8
    el.scrollBy({ left: dir * amount, behavior: 'smooth' })
  }

  const onScroll = () => {
    const el = rowRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 10)
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 10)
  }

  const SKELETON_COUNT = 6

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>{title}</h2>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        <div className={styles.controls}>
          <button
            className={`${styles.scrollBtn} ${!canScrollLeft ? styles.hidden : ''}`}
            onClick={() => scroll(-1)}
          >‹</button>
          <button
            className={`${styles.scrollBtn} ${!canScrollRight ? styles.hidden : ''}`}
            onClick={() => scroll(1)}
          >›</button>
        </div>
      </div>

      <div className={styles.rowWrap}>
        {canScrollLeft && <div className={styles.fadeLeft} />}
        <div className={styles.row} ref={rowRef} onScroll={onScroll}>
          {loading ? (
            Array.from({ length: SKELETON_COUNT }).map((_, i) => (
              <div key={i} className={styles.skeletonCard}>
                <div className={`skeleton ${styles.skPoster}`} />
                <div className={styles.skBody}>
                  <div className={`skeleton ${styles.skTitle}`} />
                  <div className={`skeleton ${styles.skMeta}`} />
                </div>
              </div>
            ))
          ) : (
            items.map((item, i) => (
              <div key={item.tmdbId || item.id || i} className={styles.cardWrap} style={{ animationDelay: `${i * 30}ms` }}>
                <MediaCard item={item} onPlay={onPlay} />
              </div>
            ))
          )}
        </div>
        {canScrollRight && items.length > 4 && <div className={styles.fadeRight} />}
      </div>
    </section>
  )
}
