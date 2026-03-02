import { useState, useCallback } from 'react'
import { searchTorrents, resolveMagnet } from '../api/torrents.js'

export function useSearch() {
  const [results, setResults] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')

  const search = useCallback(async (q) => {
    if (!q.trim()) return
    setLoading(true)
    setError(null)
    setQuery(q)
    setResults([])

    try {
      const data = await searchTorrents(q, 24)
      setResults(data.results || [])
      setTotal(data.total || 0)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Resolve a raw magnet link — returns a single result object for streaming
  const resolveMagnetLink = useCallback(async (magnet) => {
    setLoading(true)
    setError(null)
    try {
      const data = await resolveMagnet(magnet)
      return data
    } catch (e) {
      setError(e.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  return { results, total, loading, error, query, search, resolveMagnetLink }
}

