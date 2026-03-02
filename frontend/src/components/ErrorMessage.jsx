import React from 'react'
import styles from './ErrorMessage.module.css'

export default function ErrorMessage({ message, onRetry }) {
  return (
    <div className={styles.error} role="alert">
      <span className={styles.icon}>⚠</span>
      <div>
        <p className={styles.text}>{message}</p>
        {onRetry && (
          <button className={styles.retry} onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  )
}
