import React, { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import SearchBar from '../components/SearchBar.jsx'
import TorrentCard from '../components/TorrentCard.jsx'
import TorrentRow from '../components/TorrentRow.jsx'
import SkeletonCard from '../components/SkeletonCard.jsx'
import ErrorMessage from '../components/ErrorMessage.jsx'
import { useSearch } from '../hooks/useSearch.js'
import styles from './SearchPage.module.css'

const SKELETONS = Array.from({ length: 12 }, (_, i) => i)

export default function SearchPage() {
  const navigate = useNavigate()
  const { results, total, loading, error, query, search, resolveMagnetLink } = useSearch()
  const [magnet, setMagnet] = useState('')
  const [magnetError, setMagnetError] = useState(null)
  const [magnetLoading, setMagnetLoading] = useState(false)
  const [view, setView] = useState('grid') // 'grid' | 'list'

  const handleMagnetStream = useCallback(async (e) => {
    e.preventDefault()
    const m = magnet.trim()
    if (!m) return
    if (!m.startsWith('magnet:?')) {
      setMagnetError('Must start with magnet:?')
      return
    }
    setMagnetError(null)
    setMagnetLoading(true)
    const data = await resolveMagnetLink(m)
    setMagnetLoading(false)
    if (data) {
      navigate(`/stream/magnet?magnet=${encodeURIComponent(m)}&title=${encodeURIComponent(data.title)}`)
    }
  }, [magnet, resolveMagnetLink, navigate])

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        <h1 className={styles.heading}>
          Stream anything.<br />
          <span className={styles.accent}>Instantly.</span>
        </h1>
        <p className={styles.sub}>Search public sources or paste a magnet link to stream directly.</p>
        <SearchBar onSearch={q => search(q)} loading={loading} />
      </div>

      {/* Magnet input */}
      <div className={styles.magnetBox}>
        <div className={styles.magnetDivider}><span>or stream with a magnet link</span></div>
        <form className={styles.magnetForm} onSubmit={handleMagnetStream}>
          <div className={styles.magnetInputWrap}>
            <span className={styles.magnetIcon}>🧲</span>
            <input
              className={styles.magnetInput}
              type="text"
              placeholder="Paste magnet:?xt=urn:btih:… here"
              value={magnet}
              onChange={e => { setMagnet(e.target.value); setMagnetError(null) }}
              spellCheck={false}
            />
          </div>
          <button className={styles.magnetBtn} type="submit" disabled={magnetLoading || !magnet.trim()}>
            {magnetLoading ? <span className={styles.btnSpinner} /> : '▶ Stream'}
          </button>
        </form>
        {magnetError && <p className={styles.magnetErr}>⚠ {magnetError}</p>}
      </div>

      {error && (
        <ErrorMessage message={error} onRetry={() => query && search(query)} />
      )}

      {(results.length > 0 || loading) && (
        <section className={styles.results}>
          <div className={styles.resultsHeader}>
            <h2 className={styles.resultsTitle}>
              {query ? `Results for "${query}"` : 'Results'}
              {!loading && <span className={styles.count}>{total}</span>}
            </h2>
            <div className={styles.viewToggle}>
              <button
                className={`${styles.viewBtn} ${view === 'grid' ? styles.viewActive : ''}`}
                onClick={() => setView('grid')}
                title="Grid view"
              >⊞</button>
              <button
                className={`${styles.viewBtn} ${view === 'list' ? styles.viewActive : ''}`}
                onClick={() => setView('list')}
                title="List view"
              >☰</button>
            </div>
          </div>

          {view === 'grid' ? (
            <div className={styles.grid}>
              {results.map(t => <TorrentCard key={t.id} torrent={t} />)}
              {loading && SKELETONS.map(i => <SkeletonCard key={`sk-${i}`} />)}
            </div>
          ) : (
            <div className={styles.list}>
              {results.map(t => <TorrentRow key={t.id} torrent={t} />)}
              {loading && SKELETONS.slice(0, 6).map(i => (
                <div key={`sk-${i}`} className={styles.skeletonRow}>
                  <div className={`skeleton ${styles.skRowThumb}`} />
                  <div className={styles.skRowContent}>
                    <div className={`skeleton ${styles.skRowTitle}`} />
                    <div className={`skeleton ${styles.skRowMeta}`} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {!loading && !error && results.length === 0 && query && (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>⊘</span>
          <p>No results for <strong>"{query}"</strong></p>
          <p className={styles.emptyHint}>Try different keywords or paste a magnet link above.</p>
        </div>
      )}
    </div>
  )
}
