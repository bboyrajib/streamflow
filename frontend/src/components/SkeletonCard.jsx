import React from 'react'
import styles from './SkeletonCard.module.css'

export default function SkeletonCard() {
  return (
    <div className={styles.card} aria-hidden="true">
      <div className={`skeleton ${styles.badge}`} />
      <div className={`skeleton ${styles.title}`} />
      <div className={`skeleton ${styles.titleShort}`} />
      <div className={styles.meta}>
        <div className={`skeleton ${styles.metaItem}`} />
        <div className={`skeleton ${styles.metaItem}`} />
        <div className={`skeleton ${styles.metaItem}`} />
      </div>
    </div>
  )
}
