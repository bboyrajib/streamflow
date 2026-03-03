import React, { useState, useEffect, useRef } from 'react'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import styles from './Layout.module.css'

export default function Layout() {
  const [scrolled, setScrolled] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchVal, setSearchVal] = useState('')
  const navigate = useNavigate()
  const location = useLocation()
  const inputRef = useRef(null)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (searchOpen) setTimeout(() => inputRef.current?.focus(), 50)
  }, [searchOpen])

  const handleSearch = (e) => {
    e.preventDefault()
    if (searchVal.trim()) {
      navigate(`/?q=${encodeURIComponent(searchVal.trim())}`)
      setSearchOpen(false)
      setSearchVal('')
    }
  }

  return (
    <div className={styles.root}>
      <header className={`${styles.header} ${scrolled ? styles.scrolled : ''}`}>
        <div className={styles.headerInner}>
          <NavLink to="/" className={styles.logo}>
            <span className={styles.logoMark}>▶</span>
            <span className={styles.logoText}>STREAMFLOW</span>
          </NavLink>

          <nav className={styles.nav}>
            <NavLink to="/" end className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}>
              Discover
            </NavLink>
            <NavLink to="/browse/movie" className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}>
              Movies
            </NavLink>
            <NavLink to="/browse/tv" className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}>
              TV Shows
            </NavLink>
          </nav>

          <div className={styles.actions}>
            {searchOpen ? (
              <form className={styles.searchForm} onSubmit={handleSearch}>
                <input
                  ref={inputRef}
                  className={styles.searchInput}
                  type="text"
                  placeholder="Search movies, shows…"
                  value={searchVal}
                  onChange={e => setSearchVal(e.target.value)}
                  onKeyDown={e => e.key === 'Escape' && setSearchOpen(false)}
                />
                <button type="submit" className={styles.searchBtn}>⌕</button>
                <button type="button" className={styles.closeBtn} onClick={() => { setSearchOpen(false); setSearchVal('') }}>✕</button>
              </form>
            ) : (
              <button className={styles.iconBtn} onClick={() => setSearchOpen(true)} title="Search">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
              </button>
            )}
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <Outlet />
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span className={styles.footerLogo}>STREAMFLOW</span>
          <span className={styles.footerText}>Powered by WebTorrent · TMDB</span>
          <span className={styles.footerDisco}>For educational purposes only</span>
        </div>
      </footer>
    </div>
  )
}
