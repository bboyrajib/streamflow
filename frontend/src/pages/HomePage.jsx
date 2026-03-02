
import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import HeroCarousel from '../components/HeroCarousel.jsx'
import Carousel from '../components/Carousel.jsx'
// import SearchOverlay from '../components/SearchOverlay.jsx'
import { getHomepage, getTmdbDetails, searchTorrents } from '../api/torrents.js'
import styles from './HomePage.module.css'

export default function HomePage() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [heroItems, setHeroItems] = useState([])
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const q = searchParams.get('q')

  // If there's a search query, redirect to search page
  useEffect(() => {
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`, { replace: true })
  }, [q, navigate])

  useEffect(() => {
    setLoading(true)
    getHomepage()
      .then(d => {
        setData(d)
        // Use trending items for hero - enrich top 10 with full TMDB data
        const heroSource = (d.trending || []).filter(i => i.backdrop).slice(0, 8)
        setHeroItems(heroSource)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const handlePlay = useCallback((item) => {
    const title = item.title || item.name || ''
    navigate(`/search?q=${encodeURIComponent(title)}&autoplay=1`)
  }, [navigate])

  return (
    <div className={styles.page}>
      {/* Hero */}
      {loading ? (
        <div className={styles.heroSkeleton}>
          <div className={`skeleton ${styles.heroSkBg}`} />
        </div>
      ) : (
        <HeroCarousel items={heroItems} onPlay={handlePlay} />
      )}

      {/* Carousels */}
      <div className={styles.carousels}>
        <Carousel
          title="🔥 Trending This Week"
          items={data?.trending || []}
          onPlay={handlePlay}
          loading={loading}
        />
        <Carousel
          title="🎬 Popular Movies"
          items={data?.popularMovies || []}
          onPlay={handlePlay}
          loading={loading}
        />
        <Carousel
          title="📺 Popular TV Shows"
          items={data?.popularTV || []}
          onPlay={handlePlay}
          loading={loading}
        />
        <Carousel
          title="⭐ Top Rated Movies"
          subtitle="Critically acclaimed and audience favorites"
          items={data?.topRatedMovies || []}
          onPlay={handlePlay}
          loading={loading}
        />
        <Carousel
          title="🏆 Top Rated TV"
          items={data?.topRatedTV || []}
          onPlay={handlePlay}
          loading={loading}
        />
        <Carousel
          title="🎟 Coming Soon"
          subtitle="Upcoming theatrical releases"
          items={data?.upcoming || []}
          onPlay={handlePlay}
          loading={loading}
        />
      </div>
    </div>
  )
}
