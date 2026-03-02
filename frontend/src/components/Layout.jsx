import React from 'react'
import { Outlet, NavLink } from 'react-router-dom'
import styles from './Layout.module.css'

export default function Layout() {
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <NavLink to="/" className={styles.logo}>
            <span className={styles.logoIcon}>▶</span>
            StreamFlow
          </NavLink>
          <nav className={styles.nav}>
            <NavLink to="/" className={({ isActive }) => isActive ? `${styles.navLink} ${styles.active}` : styles.navLink}>
              Browse
            </NavLink>
            <NavLink to="/add" className={({ isActive }) => isActive ? `${styles.navLink} ${styles.active}` : styles.navLink}>
              Add Torrent
            </NavLink>
          </nav>
        </div>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  )
}
