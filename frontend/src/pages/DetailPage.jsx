import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import MediaCard from '../components/MediaCard.jsx'
import { getTmdbDetails, searchTorrents, buildTorrentQuery } from '../api/torrents.js'
import styles from './DetailPage.module.css'

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmt(b) {
  if (!b) return '—'
  if (b > 1e9) return `${(b / 1e9).toFixed(1)} GB`
  if (b > 1e6) return `${(b / 1e6).toFixed(0)} MB`
  return `${(b / 1e3).toFixed(0)} KB`
}

function formatMoney(n) {
  return n ? `$${(n / 1e6).toFixed(0)}M` : null
}

// ── Trailer Modal ──────────────────────────────────────────────────────────────
function TrailerModal({ trailerKey, onClose }) {
  return (
    <div className={styles.trailerBackdrop} onClick={onClose}>
      <div className={styles.trailerModal} onClick={e => e.stopPropagation()}>
        <button className={styles.trailerClose} onClick={onClose}>✕</button>
        <div className={styles.trailerEmbed}>
          <iframe
            src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&rel=0`}
            title="Trailer"
            frameBorder="0"
            allow="autoplay; encrypted-media"
            allowFullScreen
          />
        </div>
      </div>
    </div>
  )
}

// ── Tabbed Torrent Picker Modal ────────────────────────────────────────────────
function TorrentPickerModal({ title, torrents, loading, onStream, onClose }) {
  const [activeTab, setActiveTab] = useState('best')

  const providers = ['best', ...Array.from(
    new Set(torrents.flatMap(t => t.providers || [t.source]).filter(Boolean))
  ).sort()]

  const tabTorrents = activeTab === 'best'
    ? [...torrents].sort((a, b) => b.health_score - a.health_score || b.seeders - a.seeders)
    : [...torrents]
        .filter(t => (t.providers || [t.source]).includes(activeTab))
        .sort((a, b) => b.seeders - a.seeders)

  const providerLabel = (p) => p === 'best' ? '⭐ Best' : p

  return (
    <div className={styles.trailerBackdrop} onClick={onClose}>
      <div className={styles.torrentModal} onClick={e => e.stopPropagation()}>
        <div className={styles.torrentModalHeader}>
          <div>
            <h2 className={styles.torrentModalTitle}>Choose a Source</h2>
            <p className={styles.torrentModalSub}>Streaming: <strong>{title}</strong></p>
          </div>
          <button className={styles.trailerClose} onClick={onClose}>✕</button>
        </div>

        {!loading && torrents.length > 0 && (
          <div className={styles.torrentTabs}>
            {providers.map(p => (
              <button
                key={p}
                className={`${styles.torrentTab} ${activeTab === p ? styles.torrentTabActive : ''}`}
                onClick={() => setActiveTab(p)}
              >
                {providerLabel(p)}
                <span className={styles.torrentTabCount}>
                  {p === 'best' ? torrents.length : torrents.filter(t => (t.providers || [t.source]).includes(p)).length}
                </span>
              </button>
            ))}
          </div>
        )}

        {loading && (
          <div className={styles.torrentLoading}>
            <div className={styles.torrentSpinner} />
            <span>Searching across providers…</span>
          </div>
        )}

        {!loading && torrents.length === 0 && (
          <p className={styles.torrentEmpty}>No torrents found for this title.</p>
        )}

        {!loading && tabTorrents.length > 0 && (
          <div className={styles.torrentList}>
            {tabTorrents.map((t, i) => (
              <div key={`${t.id || i}-${activeTab}`} className={styles.torrentRow}>
                <div className={styles.torrentInfo}>
                  <span className={styles.torrentName}>{t.title}</span>
                  <div className={styles.torrentMeta}>
                    <div className={styles.torrentProviders}>
                      {(t.providers || [t.source]).slice(0, 3).map(p => (
                        <span key={p} className={styles.torrentSource}>{p}</span>
                      ))}
                      {(t.providers || [t.source]).length > 3 && (
                        <span className={styles.torrentSource}>+{(t.providers || [t.source]).length - 3}</span>
                      )}
                    </div>
                    <span className={styles.torrentSize}>{fmt(t.size_bytes)}</span>
                    <span style={{
                      fontSize: '0.72rem', fontFamily: 'var(--font-mono)',
                      color: t.seeders > 10 ? 'var(--green)' : t.seeders > 0 ? 'var(--yellow)' : 'var(--red)'
                    }}>↑ {t.seeders || 0}</span>
                    <span style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>↓ {t.leechers || 0}</span>
                    {t.health_score > 0 && (
                      <span className={styles.healthBadge} style={{
                        background: t.health_score > 70 ? 'rgba(16,185,129,0.15)' : t.health_score > 35 ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)',
                        color: t.health_score > 70 ? 'var(--green)' : t.health_score > 35 ? 'var(--yellow)' : 'var(--red)',
                        border: `1px solid ${t.health_score > 70 ? 'rgba(16,185,129,0.3)' : t.health_score > 35 ? 'rgba(245,158,11,0.3)' : 'rgba(239,68,68,0.3)'}`,
                      }}>
                        {t.health_score}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  className={styles.torrentPlayBtn}
                  onClick={() => onStream(t)}
                  disabled={!t.magnet_link}
                >▶ Play</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Season/Episode Accordion ───────────────────────────────────────────────────
function SeasonsSection({ detail, onStreamEpisode }) {
  const [openSeason, setOpenSeason] = useState(
    detail.seasonData?.length ? detail.seasonData[0].seasonNumber : null
  )

  if (!detail.seasonData?.length) return null

  return (
    <section className={styles.seasonsSection}>
      <h2 className={styles.sectionTitle}>Seasons & Episodes</h2>
      <div className={styles.seasonsList}>
        {detail.seasonData.map(season => (
          <div key={season.seasonNumber} className={styles.seasonItem}>
            <button
              className={`${styles.seasonHeader} ${openSeason === season.seasonNumber ? styles.seasonHeaderOpen : ''}`}
              onClick={() => setOpenSeason(openSeason === season.seasonNumber ? null : season.seasonNumber)}
            >
              <div className={styles.seasonHeaderLeft}>
                {season.poster && (
                  <img src={season.poster} alt="" className={styles.seasonPoster} loading="lazy" />
                )}
                <div className={styles.seasonInfo}>
                  <span className={styles.seasonName}>{season.name || `Season ${season.seasonNumber}`}</span>
                  <span className={styles.seasonMeta}>
                    {season.episodeCount} episodes
                    {season.airDate && <> · {season.airDate.slice(0, 4)}</>}
                  </span>
                  {season.overview && (
                    <p className={styles.seasonOverview}>{season.overview}</p>
                  )}
                </div>
              </div>
              <span className={`${styles.seasonChevron} ${openSeason === season.seasonNumber ? styles.seasonChevronOpen : ''}`}>
                ›
              </span>
            </button>

            {openSeason === season.seasonNumber && (
              <div className={styles.episodesList}>
                {season.episodes.map(ep => (
                  <div key={ep.episodeNumber} className={styles.episodeRow}>
                    {ep.stillPath && (
                      <div className={styles.episodeThumb}>
                        <img src={ep.stillPath} alt="" loading="lazy" />
                        <div className={styles.episodeThumbOverlay}>
                          <span className={styles.episodeThumbNum}>S{String(season.seasonNumber).padStart(2,'0')}E{String(ep.episodeNumber).padStart(2,'0')}</span>
                        </div>
                      </div>
                    )}
                    <div className={styles.episodeInfo}>
                      <div className={styles.episodeHeader}>
                        <span className={styles.episodeNum}>
                          {String(ep.episodeNumber).padStart(2, '0')}
                        </span>
                        <span className={styles.episodeName}>{ep.name}</span>
                        {ep.tmdbRating && (
                          <span className={styles.episodeRating}>★ {ep.tmdbRating}</span>
                        )}
                        {ep.runtime && (
                          <span className={styles.episodeDuration}>{ep.runtime}m</span>
                        )}
                      </div>
                      {ep.airDate && (
                        <span className={styles.episodeAirDate}>{new Date(ep.airDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      )}
                      {ep.overview && (
                        <p className={styles.episodeOverview}>{ep.overview}</p>
                      )}
                    </div>
                    <button
                      className={styles.episodePlayBtn}
                      onClick={() => onStreamEpisode(season.seasonNumber, ep.episodeNumber, ep.name)}
                      title={`Stream S${String(season.seasonNumber).padStart(2,'0')}E${String(ep.episodeNumber).padStart(2,'0')}`}
                    >
                      ▶
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Main DetailPage ────────────────────────────────────────────────────────────
export default function DetailPage() {
  const { type, id } = useParams()
  const navigate = useNavigate()

  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showTrailer, setShowTrailer] = useState(false)
  const [imgErr, setImgErr] = useState(false)

  // Torrent picker state
  const [showTorrents, setShowTorrents] = useState(false)
  const [torrents, setTorrents] = useState([])
  const [torrentsLoading, setTorrentsLoading] = useState(false)
  const [streamTitle, setStreamTitle] = useState('')

  // Tracks the media context for the *current* picker session so we can pass
  // it through to StreamPage when the user picks a torrent.
  // Shape: { tmdbId, imdbId, mediaType, season?, episode? }
  const streamMetaRef = useRef(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    getTmdbDetails(type, id)
      .then(setDetail)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [type, id])

  // Generic: open torrent picker with a given query + media context
  const openTorrentPicker = useCallback((query, displayTitle, mediaMeta) => {
    streamMetaRef.current = mediaMeta
    setStreamTitle(displayTitle)
    setShowTorrents(true)
    setTorrents([])
    setTorrentsLoading(true)
    searchTorrents(query, { limit: 50, perProvider: 20, sort: 'health', imdbId: mediaMeta?.imdbId || null })
      .then(d => setTorrents(d.results || []))
      .catch(() => {})
      .finally(() => setTorrentsLoading(false))
  }, [])

  // Stream entire movie / whole show
  const handlePlay = useCallback(() => {
    if (!detail) return
    const query = buildTorrentQuery(detail)
    const displayTitle = detail.title || detail.name || ''
    openTorrentPicker(query, displayTitle, {
      tmdbId:    detail.tmdbId,
      imdbId:    detail.imdbId  || null,
      mediaType: type,           // 'movie' | 'tv'
      // No season/episode for full-show stream
    })
  }, [detail, type, openTorrentPicker])

  // Stream specific episode
  const handleStreamEpisode = useCallback((season, episode, epName) => {
    if (!detail) return
    const query = buildTorrentQuery(detail, { season, episode })
    const s = String(season).padStart(2, '0')
    const e = String(episode).padStart(2, '0')
    const displayTitle = `${detail.title || detail.name} S${s}E${e}${epName ? ' – ' + epName : ''}`
    openTorrentPicker(query, displayTitle, {
      tmdbId:    detail.tmdbId,
      imdbId:    detail.imdbId || null,
      mediaType: type,
      season,
      episode,
    })
  }, [detail, type, openTorrentPicker])

  // Navigate to StreamPage, embedding media context in the URL so StreamPage
  // can use it for accurate subtitle lookup instead of parsing the torrent name.
  const handleStreamTorrent = useCallback((torrent) => {
    setShowTorrents(false)
    const meta = streamMetaRef.current || {}

    const params = new URLSearchParams({
      magnet: torrent.magnet_link,
      title:  torrent.title || streamTitle || '',
    })

    // Subtitle context — only add params that have real values
    if (meta.tmdbId)    params.set('tmdbId',    String(meta.tmdbId))
    if (meta.imdbId)    params.set('imdbId',    String(meta.imdbId))
    if (meta.mediaType) params.set('mediaType', meta.mediaType)
    if (meta.season)    params.set('season',    String(meta.season))
    if (meta.episode)   params.set('episode',   String(meta.episode))

    navigate(`/stream/magnet?${params.toString()}`)
  }, [navigate, streamTitle])

  // ── Render ────────────────────────────────────────────────────────────────────
  if (loading) return (
    <div className={styles.loadingPage}><div className={styles.spinner} /></div>
  )

  if (error) return (
    <div className={styles.errorPage}>
      <p>Failed to load: {error}</p>
      <button className={styles.backBtn} onClick={() => navigate(-1)}>← Back</button>
    </div>
  )

  if (!detail) return null

  const backdrop = detail.backdropFull || detail.backdrop
  const runtime = detail.runtime ? `${Math.floor(detail.runtime / 60)}h ${detail.runtime % 60}m` : null
  const isTV = type === 'tv'

  return (
    <div className={styles.page}>
      {/* Hero backdrop */}
      <div className={styles.heroWrap}>
        {backdrop && !imgErr && (
          <img src={backdrop} alt="" className={styles.heroImg} onError={() => setImgErr(true)} />
        )}
        <div className={styles.heroGrad1} />
        <div className={styles.heroGrad2} />
        <div className={styles.heroGrad3} />
      </div>

      <div className={styles.content}>
        <button className={styles.backBtn} onClick={() => navigate(-1)}>← Back</button>

        {/* Main info */}
        <div className={styles.mainRow}>
          {/* Poster */}
          <div className={styles.posterCol}>
            <div className={styles.posterWrap}>
              {detail.poster ? (
                <img src={detail.poster} alt={detail.title} className={styles.poster} />
              ) : (
                <div className={styles.posterFallback}>🎬</div>
              )}
            </div>
            {detail.trailerKey && (
              <button className={styles.trailerBtn} onClick={() => setShowTrailer(true)}>
                ▷ Watch Trailer
              </button>
            )}
          </div>

          {/* Details */}
          <div className={styles.detailCol}>
            <div className={styles.badgeRow}>
              <span className={styles.typeBadge}>{isTV ? 'TV SERIES' : 'FILM'}</span>
              {detail.certification && <span className={styles.cert}>{detail.certification}</span>}
              {detail.year && <span className={styles.year}>{detail.year}</span>}
              {runtime && <span className={styles.year}>{runtime}</span>}
              {detail.status && <span className={styles.statusBadge}>{detail.status}</span>}
            </div>

            <h1 className={styles.title}>{detail.title || detail.name}</h1>
            {detail.tagline && <p className={styles.tagline}>"{detail.tagline}"</p>}

            {/* Ratings */}
            <div className={styles.ratingsRow}>
              {detail.tmdbRating && (
                <div className={styles.ratingBox}>
                  <span className={styles.ratingIcon}>★</span>
                  <div>
                    <span className={styles.ratingVal}>{detail.tmdbRating}</span>
                    <span className={styles.ratingLabel}> / 10 TMDB</span>
                    {detail.tmdbVotes && <p className={styles.ratingVotes}>{detail.tmdbVotes.toLocaleString()} votes</p>}
                  </div>
                </div>
              )}
              {detail.imdbId && (
                <a
                  href={`https://imdb.com/title/${detail.imdbId}`}
                  target="_blank" rel="noopener noreferrer"
                  className={styles.imdbLink}
                >
                  <span className={styles.imdbBadge}>IMDb</span>
                </a>
              )}
            </div>

            {/* Genres */}
            {detail.genres?.length > 0 && (
              <div className={styles.genres}>
                {detail.genres.map(g => <span key={g} className={styles.genre}>{g}</span>)}
              </div>
            )}

            {/* Overview */}
            {detail.overview && <p className={styles.overview}>{detail.overview}</p>}

            {/* Facts */}
            <div className={styles.facts}>
              {detail.director && <div className={styles.fact}><span className={styles.factLabel}>Director</span><span className={styles.factVal}>{detail.director}</span></div>}
              {isTV && detail.totalSeasons && <div className={styles.fact}><span className={styles.factLabel}>Seasons</span><span className={styles.factVal}>{detail.totalSeasons}</span></div>}
              {isTV && detail.totalEpisodes && <div className={styles.fact}><span className={styles.factLabel}>Episodes</span><span className={styles.factVal}>{detail.totalEpisodes}</span></div>}
              {isTV && detail.nextEpisodeDate && <div className={styles.fact}><span className={styles.factLabel}>Next Episode</span><span className={styles.factVal}>{new Date(detail.nextEpisodeDate).toLocaleDateString()}</span></div>}
              {detail.networks?.length > 0 && <div className={styles.fact}><span className={styles.factLabel}>Network</span><span className={styles.factVal}>{detail.networks[0].name}</span></div>}
              {detail.language && <div className={styles.fact}><span className={styles.factLabel}>Language</span><span className={styles.factVal}>{detail.language.toUpperCase()}</span></div>}
              {detail.budget > 0 && <div className={styles.fact}><span className={styles.factLabel}>Budget</span><span className={styles.factVal}>{formatMoney(detail.budget)}</span></div>}
              {detail.revenue > 0 && <div className={styles.fact}><span className={styles.factLabel}>Revenue</span><span className={styles.factVal}>{formatMoney(detail.revenue)}</span></div>}
            </div>

            {/* Actions */}
            <div className={styles.actions}>
              <button className={styles.playBtn} onClick={handlePlay}>
                <span>▶</span> {isTV ? 'Stream Show' : 'Stream Now'}
              </button>
              {detail.trailerKey && (
                <button className={styles.trailerInlineBtn} onClick={() => setShowTrailer(true)}>
                  <span>▷</span> Trailer
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Seasons & Episodes (TV only) */}
        {isTV && detail.seasonData?.length > 0 && (
          <SeasonsSection detail={detail} onStreamEpisode={handleStreamEpisode} />
        )}

        {/* Cast */}
        {detail.cast?.length > 0 && (
          <section className={styles.castSection}>
            <h2 className={styles.sectionTitle}>Cast</h2>
            <div className={styles.castRow}>
              {detail.cast.map(p => (
                <div key={p.name} className={styles.castCard}>
                  <div className={styles.castPhoto}>
                    {p.photo ? (
                      <img src={p.photo} alt={p.name} className={styles.castImg} loading="lazy" />
                    ) : (
                      <div className={styles.castFallback}>{p.name[0]}</div>
                    )}
                  </div>
                  <p className={styles.castName}>{p.name}</p>
                  {p.character && <p className={styles.castChar}>{p.character}</p>}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Similar */}
        {detail.similar?.length > 0 && (
          <section className={styles.similarSection}>
            <h2 className={styles.sectionTitle}>You May Also Like</h2>
            <div className={styles.similarGrid}>
              {detail.similar.slice(0, 12).map(item => (
                <MediaCard
                  key={item.tmdbId}
                  item={item}
                  onPlay={() => navigate(`/detail/${item.mediaType}/${item.tmdbId}`)}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Trailer modal */}
      {showTrailer && detail.trailerKey && (
        <TrailerModal trailerKey={detail.trailerKey} onClose={() => setShowTrailer(false)} />
      )}

      {/* Torrent picker modal */}
      {showTorrents && (
        <TorrentPickerModal
          title={streamTitle}
          torrents={torrents}
          loading={torrentsLoading}
          onStream={handleStreamTorrent}
          onClose={() => setShowTorrents(false)}
        />
      )}
    </div>
  )
}