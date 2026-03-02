import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import MediaCard from '../components/MediaCard.jsx'
import { searchTMDB, getGenres } from '../api/torrents.js'
import styles from './SearchPage.module.css'

const TYPE_OPTIONS = [
  { value: 'multi', label: 'All' },
  { value: 'movie', label: 'Movies' },
  { value: 'tv', label: 'TV Shows' },
]

export default function SearchPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const q = searchParams.get('q') || ''
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [totalResults, setTotalResults] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)

  const [type, setType] = useState('multi')
  const [year, setYear] = useState('')
  const [showMagnet, setShowMagnet] = useState(false)

  const doSearch = useCallback((pg = 1) => {
    if (!q.trim()) return
    setLoading(true)
    setError(null)
    if (pg === 1) setResults([])
    searchTMDB(q, { type, page: pg, year: year || null })
      .then(d => {
        setResults(prev => pg === 1 ? (d.results || []) : [...prev, ...(d.results || [])])
        setTotalResults(d.total_results || 0)
        setTotalPages(d.total_pages || 1)
        setPage(pg)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [q, type, year])

  useEffect(() => { if (q) doSearch(1) }, [q, type, year])

  const handleMagnetStream = (magnet) => {
    setShowMagnet(false)
    navigate(`/stream/magnet?magnet=${encodeURIComponent(magnet)}&title=${encodeURIComponent('Magnet Stream')}`)
  }

  const handleItemClick = (item) => {
    navigate(`/title/${item.mediaType || 'movie'}/${item.tmdbId}`)
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <div className={styles.headerLeft}>
          {q ? (
            <>
              <p className={styles.searchLabel}>Results for</p>
              <h1 className={styles.searchQuery}>"{q}"</h1>
              {!loading && <span className={styles.count}>{totalResults.toLocaleString()} title{totalResults !== 1 ? 's' : ''}</span>}
            </>
          ) : (
            <h1 className={styles.searchQuery}>Search</h1>
          )}
        </div>
        <button className={styles.magnetBtn} onClick={() => setShowMagnet(true)}>🧲 Magnet Link</button>
      </div>

      {/* Filters */}
      <div className={styles.filters}>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Type</label>
          <div className={styles.chips}>
            {TYPE_OPTIONS.map(o => (
              <button
                key={o.value}
                className={`${styles.chip} ${type === o.value ? styles.chipActive : ''}`}
                onClick={() => setType(o.value)}
              >{o.label}</button>
            ))}
          </div>
        </div>
        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Year</label>
          <input
            className={styles.yearInput}
            type="number"
            placeholder="e.g. 2024"
            min="1900" max="2030"
            value={year}
            onChange={e => setYear(e.target.value)}
          />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className={styles.error}>
          <span>⚠</span> {error}
          <button className={styles.retryBtn} onClick={() => doSearch(1)}>Retry</button>
        </div>
      )}

      {/* Loading */}
      {loading && results.length === 0 && (
        <div className={styles.loadingRow}>
          <div className={styles.spinner} />
          <span className={styles.loadingText}>Searching "{q}"…</span>
        </div>
      )}

      {/* Grid */}
      {results.length > 0 && (
        <div className={styles.grid}>
          {results.map((item, i) => (
            <div
              key={`${item.tmdbId}-${i}`}
              style={{ animationDelay: `${Math.min(i, 20) * 25}ms` }}
              className="fade-in"
              onClick={() => handleItemClick(item)}
            >
              <MediaCard item={item} onPlay={() => handleItemClick(item)} />
            </div>
          ))}
        </div>
      )}

      {/* Load more */}
      {!loading && results.length > 0 && page < totalPages && (
        <div className={styles.loadMore}>
          <button className={styles.loadMoreBtn} onClick={() => doSearch(page + 1)}>
            Load More
          </button>
        </div>
      )}

      {loading && results.length > 0 && (
        <div className={styles.loadingMore}>
          <div className={styles.spinner} />
        </div>
      )}

      {/* Empty */}
      {!loading && !error && results.length === 0 && q && (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>⊘</div>
          <h2 className={styles.emptyTitle}>No results for "{q}"</h2>
          <p className={styles.emptyHint}>Try different keywords, adjust filters, or paste a magnet link.</p>
        </div>
      )}

      {/* Magnet modal */}
      {showMagnet && <MagnetModal onStream={handleMagnetStream} onClose={() => setShowMagnet(false)} />}
    </div>
  )
}

function MagnetModal({ onStream, onClose }) {
  const [val, setVal] = useState('')
  const [err, setErr] = useState(null)
  const handleStream = () => {
    const m = val.trim()
    if (!m.startsWith('magnet:?')) { setErr('Must start with magnet:?'); return }
    onStream(m)
  }
  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>🧲 Stream via Magnet</h2>
          <button className={styles.modalClose} onClick={onClose}>✕</button>
        </div>
        <p className={styles.modalHint}>Paste any magnet link to stream it instantly</p>
        <textarea
          className={styles.magnetInput}
          placeholder="magnet:?xt=urn:btih:…"
          value={val}
          onChange={e => { setVal(e.target.value); setErr(null) }}
          rows={3}
          autoFocus
        />
        {err && <p className={styles.magnetErr}>⚠ {err}</p>}
        <button className={styles.magnetStreamBtn} disabled={!val.trim()} onClick={handleStream}>
          ▶ Stream Now
        </button>
      </div>
    </div>
  )
}
