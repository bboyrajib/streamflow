import React from 'react'
import styles from './HealthBadge.module.css'

export default function HealthBadge({ seeders, showLabel = false }) {
  // seeders = -1 means "connecting, not yet known" — show neutral
  if (seeders === -1) {
    return (
      <span className={`${styles.badge} ${styles.connecting}`} title="Connecting…">
        <span className={styles.dot} />
        {showLabel ? 'Connecting' : '…'}
      </span>
    )
  }

  let color, label
  if (seeders > 10) {
    color = 'green'; label = 'Healthy'
  } else if (seeders > 0) {
    color = 'yellow'; label = 'Low'
  } else {
    color = 'red'; label = 'Dead'
  }

  return (
    <span className={`${styles.badge} ${styles[color]}`} title={`${seeders} seeders`}>
      <span className={styles.dot} />
      {showLabel ? label : `${seeders} seeds`}
    </span>
  )
}
