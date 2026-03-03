
import React, { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import MediaCard from '../components/MediaCard.jsx'
import { getPopular, getTopRated, getTrending, getDiscover, getGenres } from '../api/torrents.js'
import styles from './BrowsePage.module.css'

const TABS = [
  { id: 'popular', label: 'Popular' },
  { id: 'trending', label: 'Trending' },
  { id: 'toprated', label: 'Top Rated' },
  { id: 'discover', label: 'Discover' },
]

const SORT_OPTIONS = [
  { value: 'popularity.desc', label: 'Most Popular' },
  { value: 'vote_average.desc', label: 'Highest Rated' },
  { value: 'release_date.desc', label: 'Newest' },
  { value: 'revenue.desc', label: 'Highest Revenue' },
]

export default function BrowsePage() {
  const { type } = useParams() // 'movie' | 'tv'
  const navigate = useNavigate()
  const [tab, setTab] = useState('popular')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [genres, setGenres] = useState([])
  const [genreFilter, setGenreFilter] = useState('')
  const [sort, setSort] = useState('popularity.desc')
  const [ratingMin, setRatingMin] = useState('')

  useEffect(() => {
    getGenres().then(d => setGenres(d[type] || [])).catch(() => {})
  }, [type])

  const load = useCallback(() => {
    setLoading(true)
    let promise

    if (tab === 'popular') promise = getPopular(type, page)
    else if (tab === 'trending') promise = getTrending(type, 'week', page)
    else if (tab === 'toprated') promise = getTopRated(type, page)
    else {
      const params = { page, sort }
      if (genreFilter) params.genre = genreFilter
      if (ratingMin) params.ratingMin = ratingMin
      params.voteMin = 100
      promise = getDiscover(type, params)
    }

    promise
      .then(d => {
        const incoming = d.results || []
        setItems(prev => page === 1 ? incoming : [...prev, ...incoming])
        setTotalPages(d.total_pages || 1)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [tab, type, page, genreFilter, sort, ratingMin])

  useEffect(() => {
    setItems([])
    setPage(1)
  }, [tab, type, genreFilter, sort, ratingMin])

  useEffect(() => { load() }, [load])

  const handlePlay = (item) => {
    const title = item.title || item.name || ''
    navigate(`/search?q=${encodeURIComponent(title)}`)
  }

  const handleCardClick = (item) => {
    navigate(`/title/${type}/${item.tmdbId}`)
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageTop}>
        {/* <div className={styles.typeSwitch}>
          <button
            className={`${styles.typeBtn} ${type === 'movie' ? styles.typeActive : ''}`}
            onClick={() => navigate('/browse/movie')}
          >🎬 Movies</button>
          <button
            className={`${styles.typeBtn} ${type === 'tv' ? styles.typeActive : ''}`}
            onClick={() => navigate('/browse/tv')}
          >📺 TV Shows</button>
        </div> */}
        <h1 className={styles.pageTitle}>{type === 'tv' ? 'TV Shows' : 'Movies'}</h1>
      </div>

      {/* Tabs */}
      <div className={styles.tabs}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => setTab(t.id)}
          >{t.label}</button>
        ))}
      </div>

      {/* Discover filters */}
      {tab === 'discover' && (
        <div className={styles.discoverFilters}>
          <div className={styles.fGroup}>
            <label className={styles.fLabel}>Genre</label>
            <select className={styles.fSelect} value={genreFilter} onChange={e => setGenreFilter(e.target.value)}>
              <option value="">All Genres</option>
              {genres.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className={styles.fGroup}>
            <label className={styles.fLabel}>Sort By</label>
            <select className={styles.fSelect} value={sort} onChange={e => setSort(e.target.value)}>
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className={styles.fGroup}>
            <label className={styles.fLabel}>Min Rating</label>
            <select className={styles.fSelect} value={ratingMin} onChange={e => setRatingMin(e.target.value)}>
              <option value="">Any</option>
              {[5,6,7,7.5,8,8.5,9].map(r => <option key={r} value={r}>≥ {r}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Grid */}
      {loading && items.length === 0 ? (
        <div className={styles.grid}>
          {Array.from({ length: 20 }).map((_, i) => (
            <div key={i} className={styles.skCard}>
              <div className={`skeleton ${styles.skPoster}`} />
              <div className={styles.skBody}>
                <div className={`skeleton ${styles.skT}`} />
                <div className={`skeleton ${styles.skM}`} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.grid}>
          {items.map((item, i) => (
            <div key={item.tmdbId || i} style={{ animationDelay: `${(i % 20) * 20}ms` }} className="fade-in">
              <MediaCard item={item} onPlay={handlePlay} />
            </div>
          ))}
        </div>
      )}

      {/* Load more */}
      {page < totalPages && !loading && (
        <button className={styles.loadMore} onClick={() => setPage(p => p + 1)}>
          Load More
        </button>
      )}
      {loading && items.length > 0 && (
        <div className={styles.loadingMore}><div className={styles.spinner} /></div>
      )}
    </div>
  )
}
