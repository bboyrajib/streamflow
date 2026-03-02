import React, { useState, useCallback } from 'react'
import styles from './SearchBar.module.css'

export default function SearchBar({ onSearch, loading }) {
  const [value, setValue] = useState('')

  const handleSubmit = useCallback(e => {
    e.preventDefault()
    if (value.trim()) onSearch(value.trim())
  }, [value, onSearch])

  return (
    <form className={styles.form} onSubmit={handleSubmit} role="search">
      <div className={styles.inputWrapper}>
        <span className={styles.icon} aria-hidden="true">⌕</span>
        <input
          className={styles.input}
          type="search"
          placeholder="Search movies, shows, music..."
          value={value}
          onChange={e => setValue(e.target.value)}
          autoFocus
          autoComplete="off"
          spellCheck="false"
          aria-label="Search torrents"
        />
        {loading && <span className={styles.spinner} aria-label="Searching..." />}
      </div>
      <button
        type="submit"
        className={styles.btn}
        disabled={loading || !value.trim()}
      >
        Search
      </button>
    </form>
  )
}
