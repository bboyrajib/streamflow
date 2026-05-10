// Must be the first import — patches global.fetch before bittorrent-tracker loads
import './patch-fetch.js'
import express from 'express'
import cors from 'cors'
import WebTorrent from 'webtorrent'
import https from 'https'
import http from 'http'
import fetch from 'node-fetch'
import path from 'path'
import { fileURLToPath } from 'url'
import MemoryChunkStore from 'memory-chunk-store'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT || '9090')
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',')
const TORRENT_TTL = 30 * 60 * 1000
const MAX_TORRENTS = 5

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HLS TRANSCODING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { spawn } from 'child_process'
import { mkdirSync, existsSync, rmSync, createWriteStream } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const HLS_BASE_DIR  = join(tmpdir(), 'torrent-hls')
const HLS_TTL       = 10 * 60 * 1000
const HLS_SEG_TIME  = 4

const hlsSessions = new Map()

mkdirSync(HLS_BASE_DIR, { recursive: true })

function hlsSessionKey(infoHash, fileIndex) {
  return `${infoHash}:${fileIndex}`
}

function hlsDir(infoHash, fileIndex) {
  return join(HLS_BASE_DIR, `${infoHash}_${fileIndex}`)
}

function resetHlsTTL(key) {
  const session = hlsSessions.get(key)
  if (!session) return
  clearTimeout(session.timer)
  session.timer = setTimeout(() => destroyHlsSession(key), HLS_TTL)
}

function destroyHlsSession(key) {
  const session = hlsSessions.get(key)
  if (!session) return
  console.log(`[hls] destroying session ${key}`)
  try { session.ffmpeg?.kill('SIGKILL') } catch (_) {}
  try { if (existsSync(session.dir)) rmSync(session.dir, { recursive: true, force: true }) } catch (_) {}
  clearTimeout(session.timer)
  hlsSessions.delete(key)
}

// ── Hardware encoder detection ────────────────────────────────────────────────
// Priority: nvenc (NVIDIA) → vaapi (Intel/AMD on Linux) → qsv (Intel QSV) → software
// Override with HLS_HW_ENCODER=nvenc|vaapi|qsv|software
let _hwEncoderCache = null

// Functional test — encodes one synthetic frame to confirm the encoder actually works.
// Checking `ffmpeg -encoders` is not enough: an encoder can be compiled in while its
// GPU driver is absent, causing ffmpeg to fail silently when a real encode starts.
function testEncoder(extraArgs) {
  return new Promise(resolve => {
    const args = [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1',
      '-frames:v', '1',
      ...extraArgs,
      '-f', 'null', '-',
    ]
    const ff = spawn(process.env.FFMPEG_PATH, args, { stdio: 'ignore' })
    const timer = setTimeout(() => { try { ff.kill() } catch (_) {}; resolve(false) }, 5000)
    ff.on('close', code => { clearTimeout(timer); resolve(code === 0) })
    ff.on('error', () => { clearTimeout(timer); resolve(false) })
  })
}

async function detectHwEncoder() {
  if (_hwEncoderCache !== null) return _hwEncoderCache
  if (process.env.HLS_HW_ENCODER) {
    _hwEncoderCache = process.env.HLS_HW_ENCODER
    console.log(`[hls] using encoder from env: ${_hwEncoderCache}`)
    return _hwEncoderCache
  }

  const device = process.env.VAAPI_DEVICE || '/dev/dri/renderD128'
  const candidates = [
    { name: 'nvenc', args: ['-c:v', 'h264_nvenc'] },
    { name: 'vaapi', args: ['-vaapi_device', device, '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi'] },
    { name: 'qsv',   args: ['-c:v', 'h264_qsv'] },
  ]

  for (const { name, args } of candidates) {
    if (await testEncoder(args)) {
      _hwEncoderCache = name
      console.log(`[hls] hardware encoder available: ${name}`)
      return _hwEncoderCache
    }
  }

  _hwEncoderCache = 'software'
  console.log('[hls] no hardware encoder found, using libx264')
  return _hwEncoderCache
}

function buildVideoCodecArgs(encoder) {
  switch (encoder) {
    case 'nvenc':
      // NVIDIA NVENC — software decode, GPU encode
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-pix_fmt', 'yuv420p']
    case 'vaapi': {
      // VA-API — software decode, upload to GPU, encode (Intel/AMD)
      const device = process.env.VAAPI_DEVICE || '/dev/dri/renderD128'
      return ['-vaapi_device', device, '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-qp', '23']
    }
    case 'qsv':
      // Intel Quick Sync Video
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23', '-pix_fmt', 'nv12']
    default:
      // Software fallback
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']
  }
}

async function getOrStartHlsSession(infoHash, fileIndex) {
  const key = hlsSessionKey(infoHash, fileIndex)

  if (hlsSessions.has(key)) {
    resetHlsTTL(key)
    const session = hlsSessions.get(key)
    if (!session.ready && !session.error) {
      await new Promise((resolve, reject) => {
        session.readyCallbacks.push({ resolve, reject })
      })
    }
    if (session.error) throw new Error(session.error)
    return session
  }

  const torrent = getClient().torrents.find(t => t.infoHash === infoHash)
    || torrents.get(infoHash)?.torrent
  if (!torrent) throw new Error('Torrent not loaded — open /api/info first')

  const file = torrent.files[parseInt(fileIndex)]
  if (!file) throw new Error(`File index ${fileIndex} not found`)

  const dir = hlsDir(infoHash, fileIndex)
  mkdirSync(dir, { recursive: true })

  const session = {
    dir,
    ffmpeg: null,
    timer: null,
    ready: false,
    error: null,
    readyCallbacks: [],
    playlistPath: join(dir, 'stream.m3u8'),
    audioStreams: [],   // filled after probe, used by master.m3u8 route
  }
  hlsSessions.set(key, session)

  // ── Probe audio streams so we can map each one into HLS individually ──────
  // We need a second read of the file just for probing. probeFile() opens its
  // own createReadStream(), which is fine — WebTorrent supports concurrent reads.
  // If probing fails (e.g. torrent not seeded enough yet) we fall back to the
  // safe single-track behaviour so playback is never blocked.
  let audioStreams = []
  try {
    const probed = await probeFile(file)
    audioStreams = probed.filter(s => s.type === 'audio')
    session.audioStreams = audioStreams
    console.log(`[hls] probe found ${audioStreams.length} audio stream(s) for "${file.name}"`)
  } catch (e) {
    console.warn(`[hls] probe failed, using single audio fallback: ${e.message}`)
  }

  // ── Build ffmpeg args ─────────────────────────────────────────────────────
  //
  // SINGLE audio stream (or probe failed):
  //   Standard behaviour — transcode to AAC stereo, one track in the manifest.
  //
  // MULTIPLE audio streams:
  //   Map each audio stream to its own output stream (-map 0:v -map 0:a:0 -map 0:a:1 …).
  //   Transcode every audio stream to AAC stereo independently.
  //   Name each output audio stream via -metadata:s:a:<i> so hls.js can label it.
  //   Use a single .m3u8 / .ts output — mpegts supports multiple audio PIDs in
  //   one TS file, and hls.js exposes them as switchable audio tracks automatically.
  //
  // NOTE: We intentionally use a single-file HLS output (not per-rendition).
  // Per-rendition (separate .m3u8 per audio group) requires ffmpeg to write
  // multiple files from one pass, which is complex with pipe:0 input. The
  // single-TS approach is simpler and hls.js handles it perfectly.
  // ─────────────────────────────────────────────────────────────────────────

  // ── Build ffmpeg args ─────────────────────────────────────────────────────
  //
  // SINGLE audio:  one output — video+audio in stream.m3u8 / seg%05d.ts
  //
  // MULTIPLE audio: one output per audio track using ffmpeg's multi-output mode.
  //   Output 0  →  video + audio track 0  →  stream.m3u8  / seg%05d.ts
  //   Output 1  →  audio track 1 only     →  audio1.m3u8  / audio1/seg%05d.ts
  //   Output 2  →  audio track 2 only     →  audio2.m3u8  / audio2/seg%05d.ts
  //   ...
  //
  // The master manifest then uses EXT-X-MEDIA pointing at audio1.m3u8 etc,
  // and EXT-X-STREAM-INF points at stream.m3u8 which carries audio track 0.
  // hls.js switches by reloading the correct audio playlist — this is the
  // standard HLS multi-audio approach and works reliably in hls.js.
  // ─────────────────────────────────────────────────────────────────────────

  const multiAudio = audioStreams.length > 1

  // Create subdirs for extra audio tracks
  if (multiAudio) {
    for (let i = 1; i < audioStreams.length; i++) {
      mkdirSync(join(dir, `audio${i}`), { recursive: true })
    }
  }

  const videoCodecArgs = buildVideoCodecArgs(await detectHwEncoder())
  const ffmpegArgs = ['-loglevel', 'warning', '-i', 'pipe:0']

  if (multiAudio) {
    // ── Output 0: video + first audio track ───────────────────────────────
    ffmpegArgs.push('-map', '0:v:0', '-map', '0:a:0')
    ffmpegArgs.push(...videoCodecArgs, '-c:a:0', 'aac', '-b:a:0', '192k', '-ac:a:0', '2')
    const s0 = audioStreams[0]
    if (s0.language) ffmpegArgs.push('-metadata:s:a:0', `language=${s0.language}`)
    if (s0.title)    ffmpegArgs.push('-metadata:s:a:0', `title=${s0.title}`)
    ffmpegArgs.push(
      '-hls_time', String(HLS_SEG_TIME),
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', join(dir, 'seg%05d.ts'),
      '-start_number', '0',
      join(dir, 'stream.m3u8'),
    )
    // ── Outputs 1…N: audio-only tracks ────────────────────────────────────
    for (let i = 1; i < audioStreams.length; i++) {
      const s = audioStreams[i]
      ffmpegArgs.push('-map', `0:a:${i}`)
      ffmpegArgs.push('-c:a:0', 'aac', '-b:a:0', '192k', '-ac:a:0', '2')
      if (s.language) ffmpegArgs.push('-metadata:s:a:0', `language=${s.language}`)
      if (s.title)    ffmpegArgs.push('-metadata:s:a:0', `title=${s.title}`)
      ffmpegArgs.push(
        '-hls_time', String(HLS_SEG_TIME),
        '-hls_list_size', '0',
        '-hls_flags', 'independent_segments',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', join(dir, `audio${i}`, 'seg%05d.ts'),
        '-start_number', '0',
        join(dir, `audio${i}.m3u8`),
      )
    }
  } else {
    // Single audio — original simple behaviour
    ffmpegArgs.push(...videoCodecArgs, '-c:a', 'aac', '-b:a', '192k', '-ac', '2')
    ffmpegArgs.push(
      '-hls_time', String(HLS_SEG_TIME),
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', join(dir, 'seg%05d.ts'),
      '-start_number', '0',
      join(dir, 'stream.m3u8'),
    )
  }

  console.log(`[hls] starting session ${key} for "${file.name}" (${audioStreams.length || 1} audio track(s))`)
  const ff = spawn(process.env.FFMPEG_PATH, ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] })
  session.ffmpeg = ff

  const torrentStream = file.createReadStream()
  torrentStream.pipe(ff.stdin)
  torrentStream.on('error', err => { console.error('[hls] torrent stream error:', err.message); ff.stdin.end() })
  ff.stdin.on('error', () => {})

  let stderrBuf = ''
  ff.stderr.on('data', chunk => {
    stderrBuf += chunk.toString()
    if (!session.ready && existsSync(session.playlistPath)) {
      session.ready = true
      session.readyCallbacks.forEach(cb => cb.resolve())
      session.readyCallbacks = []
      console.log(`[hls] session ${key} ready`)
    }
    if (stderrBuf.includes('Error') || stderrBuf.includes('Invalid')) {
      console.warn('[ffmpeg stderr]', stderrBuf.slice(-300))
      stderrBuf = ''
    }
  })

  ff.on('error', err => {
    const msg = err.code === 'ENOENT'
      ? 'FFmpeg not found — install it and add to PATH'
      : err.message
    console.error('[hls]', msg)
    session.error = msg
    session.readyCallbacks.forEach(cb => cb.reject(new Error(msg)))
    session.readyCallbacks = []
  })

  ff.on('close', code => {
    if (code !== 0 && code !== null) console.log(`[hls] ffmpeg exited ${code} for ${key}`)
    if (!session.ready && existsSync(session.playlistPath)) {
      session.ready = true
      session.readyCallbacks.forEach(cb => cb.resolve())
      session.readyCallbacks = []
    }
    console.log(`[hls] transcoding complete for ${key} — stream is now full VOD`)
  })

  await new Promise((resolve, reject) => {
    session.readyCallbacks.push({ resolve, reject })
    let attempts = 0
    const poll = setInterval(() => {
      if (session.error) { clearInterval(poll); return }
      if (existsSync(session.playlistPath)) {
        if (!session.ready) {
          session.ready = true
          session.readyCallbacks.forEach(cb => cb.resolve())
          session.readyCallbacks = []
        }
        clearInterval(poll)
      }
      if (++attempts > 60) {
        clearInterval(poll)
        const msg = 'FFmpeg took too long to produce first segment'
        session.error = msg
        session.readyCallbacks.forEach(cb => cb.reject(new Error(msg)))
        session.readyCallbacks = []
      }
    }, 500)
  })

  if (session.error) { destroyHlsSession(key); throw new Error(session.error) }

  resetHlsTTL(key)
  return session
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUDIO / SUBTITLE EXTRACTION
//
// These helpers probe a torrent file with `ffprobe` to list all embedded
// streams, then use `ffmpeg` to extract a chosen stream on-the-fly and pipe
// the bytes back to the client.
//
// NEW ENDPOINTS:
//   GET /api/probe?infoHash=&file=
//       → { streams: [{ index, type, codec, language, title, default, forced }] }
//
//   GET /api/extract/audio?infoHash=&file=&stream=&format=
//       format: aac (default) | mp3 | flac | opus | wav
//       → streaming audio file
//
//   GET /api/extract/subtitle?infoHash=&file=&stream=&format=
//       format: srt (default) | vtt | ass
//       → subtitle text file
//
// REQUIREMENTS: ffmpeg + ffprobe in PATH (same requirement as HLS)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Probe a torrent file for all streams using ffprobe.
// Returns array of stream descriptors.
function probeFile(file) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-i', 'pipe:0',
    ]
    // console.log("[probe] file:", file)
    const ff = spawn(process.env.FFPROBE_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const torrentStream = file.createReadStream()
    torrentStream.pipe(ff.stdin)
    torrentStream.on('error', err => { ff.stdin.end(); console.error('[probe] stream err:', err.message) })
    ff.stdin.on('error', () => {})

    let stdout = ''
    let stderr = ''
    ff.stdout.on('data', d => { stdout += d })
    ff.stderr.on('data', d => { stderr += d })

    ff.on('error', err => {
      const msg = err.code === 'ENOENT' ? 'ffprobe not found — install FFmpeg and add to PATH' : err.message
      reject(new Error(msg))
    })

    ff.on('close', () => {
      try {
        const data = JSON.parse(stdout)
        const streams = (data.streams || []).map(s => ({
          index:     s.index,
          type:      s.codec_type,          // 'audio' | 'video' | 'subtitle' | 'data'
          codec:     s.codec_name,
          codecLong: s.codec_long_name || null,
          language:  s.tags?.language || null,
          title:     s.tags?.title    || null,
          default:   s.disposition?.default === 1,
          forced:    s.disposition?.forced  === 1,
          channels:  s.channels || null,
          sampleRate: s.sample_rate || null,
          bitRate:   s.bit_rate    || null,
          // subtitle specifics
          width:     s.width  || null,
          height:    s.height || null,
        }))
        resolve(streams)
      } catch (e) {
        // ffprobe sometimes fails when only partial data is available
        // (torrent still downloading). Return empty gracefully.
        console.warn('[probe] parse failed:', e.message, '| stderr:', stderr.slice(-200))
        resolve([])
      }
    })
  })
}

// Extract a single stream from a torrent file and pipe to the HTTP response.
// `streamIndex` is the ffprobe stream index (0-based across all streams).
// `outputArgs` is an array of ffmpeg output flags, e.g. ['-c:a', 'libmp3lame']
// `outputFormat` is the container format string for -f, e.g. 'mp3'
function extractStream(file, streamIndex, outputArgs, outputFormat, res, filename) {
  const args = [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-map', `0:${streamIndex}`,
    ...outputArgs,
    '-f', outputFormat,
    'pipe:1',
  ]

  const ff = spawn(process.env.FFMPEG_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const torrentStream = file.createReadStream()
  torrentStream.pipe(ff.stdin)
  torrentStream.on('error', err => { ff.stdin.end(); console.error('[extract] stream err:', err.message) })
  ff.stdin.on('error', () => {})

  ff.on('error', err => {
    const msg = err.code === 'ENOENT' ? 'FFmpeg not found — install it and add to PATH' : err.message
    console.error('[extract]', msg)
    if (!res.headersSent) res.status(500).json({ error: msg })
  })

  ff.stderr.on('data', d => console.warn('[extract ffmpeg]', d.toString().slice(0, 200)))

  ff.stdout.pipe(res)
  res.on('close', () => { try { ff.kill('SIGKILL') } catch (_) {} })
}

// Audio codec → ffmpeg output args + container format + mime type
const AUDIO_FORMATS = {
  aac:  { args: ['-c:a', 'aac',         '-b:a', '192k', '-ac', '2'], fmt: 'adts',   mime: 'audio/aac',   ext: 'aac'  },
  mp3:  { args: ['-c:a', 'libmp3lame',  '-b:a', '192k', '-ac', '2'], fmt: 'mp3',    mime: 'audio/mpeg',  ext: 'mp3'  },
  flac: { args: ['-c:a', 'flac'],                                     fmt: 'flac',   mime: 'audio/flac',  ext: 'flac' },
  opus: { args: ['-c:a', 'libopus',     '-b:a', '128k'],              fmt: 'ogg',    mime: 'audio/ogg',   ext: 'opus' },
  wav:  { args: ['-c:a', 'pcm_s16le'],                                fmt: 'wav',    mime: 'audio/wav',   ext: 'wav'  },
  // passthrough — keep original codec, remux into matroska
  copy: { args: ['-c:a', 'copy'],                                     fmt: 'matroska', mime: 'audio/x-matroska', ext: 'mka' },
}

// Subtitle codec → ffmpeg output args + container format + mime type
const SUBTITLE_FORMATS = {
  srt:  { args: ['-c:s', 'subrip'],   fmt: 'srt',  mime: 'text/plain; charset=utf-8',      ext: 'srt' },
  vtt:  { args: ['-c:s', 'webvtt'],   fmt: 'webvtt', mime: 'text/vtt',                      ext: 'vtt' },
  ass:  { args: ['-c:s', 'ass'],      fmt: 'ass',  mime: 'text/plain; charset=utf-8',       ext: 'ass' },
  copy: { args: ['-c:s', 'copy'],     fmt: 'srt',  mime: 'text/plain; charset=utf-8',       ext: 'srt' },
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// IN-MEMORY TTL CACHE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class TTLCache {
  constructor() { this._store = new Map() }
  get(key) {
    const e = this._store.get(key)
    if (!e) return undefined
    if (Date.now() > e.exp) { this._store.delete(key); return undefined }
    return e.val
  }
  set(key, val, ttlMs) { this._store.set(key, { val, exp: Date.now() + ttlMs }) }
  has(key) { return this.get(key) !== undefined }
  del(key) { this._store.delete(key) }
  flush() { this._store.clear() }
  stats() { return { keys: this._store.size } }
}

const torrentSearchCache = new TTLCache()
const tmdbSearchCache    = new TTLCache()
const tmdbDetailCache    = new TTLCache()
const tmdbBrowseCache    = new TTLCache()
const probeCache         = new TTLCache()   // probe results per file

const TORRENT_CACHE_TTL = 10 * 60 * 1000
const TMDB_SEARCH_TTL   = 30 * 60 * 1000
const TMDB_DETAIL_TTL   = 6 * 60 * 60 * 1000
const TMDB_BROWSE_TTL   = 60 * 60 * 1000
const PROBE_CACHE_TTL   = 60 * 60 * 1000   // probe results valid for 1 hour

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REQUEST COALESCING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const inFlight = new Map()
function coalesce(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key)
  const p = fn().finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HEALTH SCORE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function healthScore(seeders, leechers) {
  const s = Math.max(0, parseInt(seeders) || 0)
  const l = Math.max(0, parseInt(leechers) || 0)
  if (s === 0) return 0
  const seederScore = Math.min(Math.log10(s + 1) / 3, 1)
  const ratio = l === 0 ? 1.0 : Math.min(s / l, 2) / 2
  const raw = seederScore * 0.75 + ratio * 0.25
  return Math.min(Math.round(raw * 100), 100)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TRACKERS / MAGNET HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const EXTRA_TRACKERS = [
  // HTTP(S) trackers — TCP-based, work even when ISP/firewall blocks UDP
  // HTTP(S) trackers — TCP-based, work even when ISP/firewall blocks UDP
  'http://tracker.opentrackr.org:1337/announce',
  'https://tracker.lilithraws.org:443/announce',
  'http://t.nyaatracker.com:80/announce',
  'http://tracker2.dler.org:80/announce',
  'http://bvarf.tracker.sh:2086/announce',
  'http://tracker.mywaifu.best:6969/announce',
  'https://tracker1.520.jp:443/announce',
  'https://tracker.tamersunion.org:443/announce',
  // UDP trackers — faster when available
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  // WebSocket trackers — for WebTorrent WebRTC peers
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
]

function buildMagnet(infoHash, name = '') {
  let m = `magnet:?xt=urn:btih:${infoHash}`
  if (name) m += `&dn=${encodeURIComponent(name)}`
  for (const tr of EXTRA_TRACKERS) m += `&tr=${encodeURIComponent(tr)}`
  return m
}

function extractInfoHash(magnet) {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i)
  return m ? m[1].toLowerCase() : null
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXPRESS + WEBTORRENT SETUP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const app = express()
app.use(cors({
  origin: ALLOWED_ORIGINS,
  exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
}))
app.use(express.json())

const frontendDist = path.join(__dirname, 'public')
app.use(express.static(frontendDist))

function createClient() {
  const c = new WebTorrent({
    dht: {
      bootstrap: [
        'router.bittorrent.com:6881',
        'router.utorrent.com:6881',
        'dht.transmissionbt.com:6881',
        'dht.libtorrent.org:25401',
      ],
    },
  })
  c.on('error', err => console.error('[wt]', err.message))
  return c
}

let client = createClient()
function getClient() {
  if (client.destroyed) { console.log('[wt] recreating'); client = createClient() }
  return client
}

const torrents = new Map()

function resetTTL(h) {
  const e = torrents.get(h)
  if (!e) return
  clearTimeout(e.timer)
  e.timer = setTimeout(() => {
    console.log(`[evict] ${h}`)
    try { e.torrent.destroy() } catch (_) {}
    torrents.delete(h)
  }, TORRENT_TTL)
}

function evictOldest() {
  if (torrents.size < MAX_TORRENTS) return
  let oldest = null, t = Infinity
  for (const [h, e] of torrents) { if (e.addedAt < t) { t = e.addedAt; oldest = h } }
  if (oldest) { try { torrents.get(oldest).torrent.destroy() } catch (_) {} torrents.delete(oldest) }
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return fetchBuffer(res.headers.location).then(resolve).catch(reject)
      if (res.statusCode !== 200) { res.destroy(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function fetchTorrentBuffer(infoHash, sendStatus) {
  const sources = [
    `https://itorrents.org/torrent/${infoHash.toUpperCase()}.torrent`,
    `https://thetorrent.org/${infoHash.toUpperCase()}.torrent`,
    `https://torrage.info/torrent.php?h=${infoHash}`,
  ]
  for (const url of sources) {
    try {
      sendStatus(`Fetching metadata from ${new URL(url).hostname}…`)
      const buf = await fetchBuffer(url)
      // A valid .torrent is bencoded — it must start with 'd' (0x64). Reject HTML/error pages.
      if (buf && buf.length > 200 && buf[0] === 0x64) { console.log(`[meta] ${buf.length}b from ${url}`); return buf }
      if (buf) console.log(`[meta] ${new URL(url).hostname}: invalid torrent data (starts with 0x${buf[0]?.toString(16) ?? '??'})`)
    } catch (e) { console.log(`[meta] ${new URL(url).hostname}: ${e.message}`) }
  }
  return null
}

function waitReady(torrent) {
  return new Promise((resolve, reject) => {
    if (torrent.ready) return resolve(torrent)
    const t = setTimeout(() => reject(new Error('Torrent ready timeout')), 60_000)
    torrent.once('ready', () => { clearTimeout(t); resolve(torrent) })
    torrent.once('error', err => { clearTimeout(t); reject(err) })
  })
}

function waitForPeers(torrent, timeoutMs, onProgress) {
  return new Promise((resolve, reject) => {
    if (torrent.numPeers > 0) return resolve(torrent.numPeers)
    const iv = setInterval(() => {
      const p = torrent.numPeers
      onProgress?.(`Waiting for peers… ${p} connected`)
      if (p > 0) { clearInterval(iv); clearTimeout(to); resolve(p) }
    }, 2000)
    const to = setTimeout(() => { clearInterval(iv); reject(new Error(`No peers after ${timeoutMs / 1000}s`)) }, timeoutMs)
  })
}

async function getOrAdd(hashOrMagnet, sendStatus, torrentUrl = null) {
  const infoHash = hashOrMagnet.startsWith('magnet:')
    ? extractInfoHash(hashOrMagnet)
    : hashOrMagnet.toLowerCase().startsWith('http')
      ? null
      : hashOrMagnet.toLowerCase()

  if (infoHash && torrents.has(infoHash)) { resetTTL(infoHash); return waitReady(torrents.get(infoHash).torrent) }
  const ex = infoHash && getClient().torrents.find(t => t.infoHash === infoHash)
  if (ex) { torrents.set(infoHash, { torrent: ex, timer: null, addedAt: Date.now() }); resetTTL(infoHash); return waitReady(ex) }

  evictOldest()
  let buf = null

  if (torrentUrl) {
    try {
      sendStatus(`Fetching .torrent from ${new URL(torrentUrl).hostname}…`)
      const b = await fetchBuffer(torrentUrl)
      if (b && b.length > 200) buf = b
    } catch (e) { console.log('[torrent_url]', e.message) }
  }

  if (!buf && infoHash) buf = await fetchTorrentBuffer(infoHash, sendStatus)

  sendStatus('Connecting to BitTorrent swarm…')
  // Always use buildMagnet() so trackers are included — a bare magnet with no
  // trackers relies solely on DHT which is slow and often fails for less popular torrents
  const input = buf
    || (infoHash ? buildMagnet(infoHash, '') : null)
    || (hashOrMagnet.startsWith('magnet:') ? hashOrMagnet : null)

  if (!input) throw new Error('No magnet, infoHash, or .torrent available')

  // Pass trackers explicitly — magnet URI parsing alone may not pick them all up
  const torrent = getClient().add(input, {
    strategy: 'sequential',
    announce: EXTRA_TRACKERS,
  })
  torrent.on('warning', w => console.log(`[wt-warn] ${w.message || w}`))
  torrent.on('error', e => console.log(`[wt-err] ${e.message}`))
  const hb = buf ? null : setInterval(() => sendStatus(`Fetching metadata… ${torrent.numPeers} peers`), 4000)
  try {
    await waitReady(torrent)
    if (hb) clearInterval(hb)
  } catch (e) {
    if (hb) clearInterval(hb)
    try { torrent.destroy() } catch (_) {}
    throw e
  }

  const h = torrent.infoHash
  // Log tracker status to help diagnose peer connection failures
  if (torrent.discovery?.tracker?._trackers) {
    for (const tr of torrent.discovery.tracker._trackers) {
      tr.on('warning', w => console.log(`[tracker] ${tr.announceUrl} warn: ${w.message || w}`))
      tr.on('update', r => console.log(`[tracker] ${tr.announceUrl} seeds=${r.complete} leech=${r.incomplete}`))
    }
  }
  console.log(`[ready] "${torrent.name}" peers=${torrent.numPeers}`)
  console.log(`[files] ${torrent.files.map((f, i) => `[${i}] ${f.name} (${(f.length / 1e6).toFixed(1)}MB)`).join(' | ')}`)
  torrents.set(h, { torrent, timer: null, addedAt: Date.now() })
  resetTTL(h)
  return torrent
}

const isPlayable = name => ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.mp3', '.flac', '.aac', '.ogg', '.wav'].some(ext => name.toLowerCase().endsWith(ext))
const isSubtitle = name => ['.srt', '.vtt', '.ass', '.ssa', '.sub'].some(ext => name.toLowerCase().endsWith(ext))
const MIME = {
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
  avi: 'video/x-msvideo', mov: 'video/quicktime', m4v: 'video/mp4',
  mp3: 'audio/mpeg', flac: 'audio/flac', aac: 'audio/aac', ogg: 'audio/ogg', wav: 'audio/wav',
  srt: 'text/plain', vtt: 'text/vtt', ass: 'text/plain', ssa: 'text/plain',
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TMDB HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TMDB_KEY  = process.env.TMDB_API_KEY || '863132acc2bd530a41f149bc37736902'
const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_IMG  = 'https://image.tmdb.org/t/p'

const MOVIE_GENRES = {
  28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',
  99:'Documentary',18:'Drama',10751:'Family',14:'Fantasy',36:'History',
  27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Sci-Fi',
  10770:'TV Movie',53:'Thriller',10752:'War',37:'Western',
}
const TV_GENRES = {
  10759:'Action & Adventure',16:'Animation',35:'Comedy',80:'Crime',
  99:'Documentary',18:'Drama',10751:'Family',10762:'Kids',9648:'Mystery',
  10763:'News',10764:'Reality',10765:'Sci-Fi & Fantasy',10766:'Soap',
  10767:'Talk',10768:'War & Politics',37:'Western',
}

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
}

async function tmdbFetch(endpoint, params = {}, cache = tmdbBrowseCache, ttl = TMDB_BROWSE_TTL) {
  const cacheKey = `tmdb:${endpoint}:${JSON.stringify(params)}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached

  return coalesce(cacheKey, async () => {
    const url = new URL(`${TMDB_BASE}${endpoint}`)
    url.searchParams.set('api_key', TMDB_KEY)
    url.searchParams.set('language', 'en-US')
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    try {
      const r = await fetch(url.toString(), {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) { console.log(`[tmdb] ${endpoint} → HTTP ${r.status}`); return null }
      const data = await r.json()
      cache.set(cacheKey, data, ttl)
      return data
    } catch (e) {
      console.log(`[tmdb] ${endpoint}: ${e.message}`)
      return null
    }
  })
}

function imgUrl(filePath, size = 'w500') {
  return filePath ? `${TMDB_IMG}/${size}${filePath}` : null
}

function formatTMDBCard(item) {
  const isMovie = item.media_type ? item.media_type === 'movie' : !!item.title
  return {
    tmdbId:      item.id,
    mediaType:   isMovie ? 'movie' : 'tv',
    title:       item.title || item.name,
    overview:    item.overview || null,
    year:        (item.release_date || item.first_air_date || '').slice(0, 4) || null,
    tmdbRating:  item.vote_average ? Math.round(item.vote_average * 10) / 10 : null,
    tmdbVotes:   item.vote_count || null,
    popularity:  item.popularity || null,
    poster:      imgUrl(item.poster_path, 'w500'),
    posterThumb: imgUrl(item.poster_path, 'w185'),
    backdrop:    imgUrl(item.backdrop_path, 'w1280'),
    genreIds:    item.genre_ids || [],
    language:    item.original_language || null,
  }
}

async function enrichTMDBItem(item) {
  const isMovie   = item.media_type ? item.media_type === 'movie' : !!item.title
  const mediaType = isMovie ? 'movie' : 'tv'
  const id        = item.id

  try {
    const [details, credits, videos, releaseDates] = await Promise.all([
      tmdbFetch(`/${mediaType}/${id}`, { append_to_response: 'external_ids' }, tmdbDetailCache, TMDB_DETAIL_TTL),
      tmdbFetch(`/${mediaType}/${id}/credits`, {}, tmdbDetailCache, TMDB_DETAIL_TTL),
      tmdbFetch(`/${mediaType}/${id}/videos`, {}, tmdbDetailCache, TMDB_DETAIL_TTL),
      isMovie
        ? tmdbFetch(`/movie/${id}/release_dates`, {}, tmdbDetailCache, TMDB_DETAIL_TTL)
        : tmdbFetch(`/tv/${id}/content_ratings`, {}, tmdbDetailCache, TMDB_DETAIL_TTL),
    ])

    if (!details) return formatTMDBCard(item)

    const genreMap = isMovie ? MOVIE_GENRES : TV_GENRES
    const genres   = (details.genres || []).map(g => g.name || genreMap[g.id]).filter(Boolean)
    const cast     = (credits?.cast || []).slice(0, 8).map(p => ({
      name:      p.name,
      character: p.character,
      photo:     imgUrl(p.profile_path, 'w185'),
      tmdbId:    p.id,
    }))
    const crew     = credits?.crew || []
    const director = isMovie
      ? crew.find(p => p.job === 'Director')?.name || null
      : (details.created_by || [])[0]?.name || null

    let certification = null
    if (isMovie) {
      const us = (releaseDates?.results || []).find(r => r.iso_3166_1 === 'US')
      certification = us?.release_dates?.find(d => d.certification)?.certification || null
    } else {
      const us = (releaseDates?.results || []).find(r => r.iso_3166_1 === 'US')
      certification = us?.rating || null
    }

    const trailer = (videos?.results || [])
      .filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
      .sort((a, b) => (a.type === 'Trailer' ? -1 : 1))[0]

    const base = {
      tmdbId:        details.id,
      mediaType,
      title:         details.title || details.name,
      originalTitle: details.original_title || details.original_name || null,
      overview:      details.overview || null,
      tagline:       details.tagline || null,
      year:          (details.release_date || details.first_air_date || '').slice(0, 4) || null,
      releaseDate:   details.release_date || details.first_air_date || null,
      genres,
      genreIds:      (details.genres || []).map(g => g.id),
      cast,
      director,
      certification,
      tmdbRating:    details.vote_average ? Math.round(details.vote_average * 10) / 10 : null,
      tmdbVotes:     details.vote_count || null,
      popularity:    details.popularity || null,
      imdbId:        details.external_ids?.imdb_id || null,
      runtime:       details.runtime || (details.episode_run_time || [])[0] || null,
      status:        details.status || null,
      language:      details.original_language || null,
      poster:        imgUrl(details.poster_path, 'w500'),
      posterThumb:   imgUrl(details.poster_path, 'w185'),
      backdrop:      imgUrl(details.backdrop_path, 'w1280'),
      backdropFull:  imgUrl(details.backdrop_path, 'original'),
      trailer:       trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
      trailerKey:    trailer?.key || null,
    }

    if (isMovie) {
      return {
        ...base,
        budget:  details.budget || null,
        revenue: details.revenue || null,
        collection: details.belongs_to_collection ? {
          id:     details.belongs_to_collection.id,
          name:   details.belongs_to_collection.name,
          poster: imgUrl(details.belongs_to_collection.poster_path, 'w342'),
        } : null,
      }
    }

    const seasonCount   = details.number_of_seasons || 0
    const seasonNumbers = Array.from({ length: seasonCount }, (_, i) => i + 1)
    const seasons = []
    for (let i = 0; i < seasonNumbers.length; i += 5) {
      const batch = await Promise.all(
        seasonNumbers.slice(i, i + 5).map(sn =>
          tmdbFetch(`/tv/${id}/season/${sn}`, {}, tmdbDetailCache, TMDB_DETAIL_TTL)
        )
      )
      for (const s of batch) {
        if (!s) continue
        seasons.push({
          seasonNumber: s.season_number,
          name:         s.name,
          overview:     s.overview || null,
          airDate:      s.air_date || null,
          episodeCount: s.episodes?.length || 0,
          poster:       imgUrl(s.poster_path, 'w342'),
          episodes: (s.episodes || []).map(ep => ({
            episodeNumber: ep.episode_number,
            name:          ep.name,
            overview:      ep.overview || null,
            airDate:       ep.air_date || null,
            runtime:       ep.runtime || null,
            stillPath:     imgUrl(ep.still_path, 'w300'),
            tmdbRating:    ep.vote_average ? Math.round(ep.vote_average * 10) / 10 : null,
          })),
        })
      }
    }

    return {
      ...base,
      totalSeasons:   seasonCount,
      totalEpisodes:  details.number_of_episodes || null,
      networks: (details.networks || []).map(n => ({
        id:   n.id,
        name: n.name,
        logo: imgUrl(n.logo_path, 'w92'),
      })),
      lastAirDate:     details.last_air_date || null,
      nextEpisodeDate: details.next_episode_to_air?.air_date || null,
      inProduction:    details.in_production || false,
      seasonData:      seasons,
    }
  } catch (e) {
    console.log(`[enrich ${id}]`, e.message)
    return formatTMDBCard(item)
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TORRENT SEARCH PROVIDERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function safeJSON(response, source) {
  const ct = response.headers.get('content-type') || ''
  if (!response.ok) { console.log(`[${source}] HTTP ${response.status}`); return null }
  if (!ct.includes('json') && !ct.includes('text/plain')) {
    console.log(`[${source}] Non-JSON (${ct.split(';')[0]})`)
    return null
  }
  try { return await response.json() } catch { return null }
}

function parseSize(str) {
  if (!str) return null
  const m = String(str).match(/([\d.]+)\s*(TB|TiB|GB|GiB|MB|MiB|KB|KiB)/i)
  if (!m) return null
  const n = parseFloat(m[1])
  const u = m[2].toUpperCase()
  if (u.startsWith('T')) return Math.round(n * 1e12)
  if (u.startsWith('G')) return Math.round(n * 1e9)
  if (u.startsWith('M')) return Math.round(n * 1e6)
  if (u.startsWith('K')) return Math.round(n * 1e3)
  return null
}

function torrentItem(overrides) {
  const s = Math.max(0, parseInt(overrides.seeders) || 0)
  const l = Math.max(0, parseInt(overrides.leechers) || 0)
  return {
    id:           null,
    title:        'Unknown',
    magnet_link:  null,
    torrent_url:  null,
    size_bytes:   null,
    seeders:      s,
    leechers:     l,
    category:     null,
    source:       'unknown',
    providers:    [],
    health_score: healthScore(s, l),
    poster:       null,
    ...overrides,
    seeders:      s,
    leechers:     l,
    health_score: healthScore(s, l),
  }
}

async function searchKnaben(query, limit) {
  try {
    const r = await fetch('https://api.knaben.org/v1', {
      method: 'POST',
      headers: { ...FETCH_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        search_type: '100%', search_field: 'title', query,
        from: 0, size: limit, order_by: 'seeders', order_direction: 'desc',
        hide_unsafe: false, hide_xxx: true,
      }),
      signal: AbortSignal.timeout(12000),
    })
    const json = await safeJSON(r, 'knaben')
    if (!json) return []
    return (json.hits || []).flatMap(item => {
      if (!item.hash) return []
      const hash = item.hash.toLowerCase()
      return [torrentItem({
        id: hash, title: item.title || 'Unknown',
        magnet_link: item.magnetUrl || buildMagnet(hash, item.title),
        size_bytes: item.bytes || null, seeders: item.seeders, leechers: item.peers,
        category: item.category || null, source: 'knaben', providers: ['knaben'],
      })]
    })
  } catch (e) { console.log('[knaben]', e.message); return [] }
}

async function searchPirateBay(query, limit) {
  try {
    const r = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`, {
      headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000),
    })
    const json = await safeJSON(r, 'piratebay')
    if (!json) return []
    const catMap = { '201':'Movie','202':'Movie','205':'TV','100':'Audio','200':'Video','300':'Apps','400':'Games' }
    return json.slice(0, limit).flatMap(item => {
      if (!item.info_hash || item.name === 'No results returned') return []
      return [torrentItem({
        id: item.info_hash.toLowerCase(), title: item.name,
        magnet_link: buildMagnet(item.info_hash, item.name),
        size_bytes: parseInt(item.size) || null, seeders: item.seeders, leechers: item.leechers,
        category: catMap[item.category] || null, source: 'piratebay', providers: ['piratebay'],
      })]
    })
  } catch (e) { console.log('[piratebay]', e.message); return [] }
}

async function searchYTS(query, limit) {
  try {
    const r = await fetch(
      `https://yts.si/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=${Math.min(limit, 50)}&sort_by=seeds`,
      { headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000) }
    )
    const json = await safeJSON(r, 'yts')
    if (!json || json.data?.movie_count === 0) return []
    return (json.data?.movies || []).flatMap(movie =>
      (movie.torrents || []).map(t => {
        const title = `${movie.title} (${movie.year}) [${t.quality}] [${t.type}]`
        return torrentItem({
          id: t.hash.toLowerCase(), title,
          magnet_link: buildMagnet(t.hash, title),
          size_bytes: t.size_bytes || null, seeders: t.seeds, leechers: t.peers,
          category: 'Movie', source: 'yts', providers: ['yts'],
          poster: movie.medium_cover_image || null,
        })
      })
    ).slice(0, limit)
  } catch (e) { console.log('[yts]', e.message); return [] }
}

async function searchEZTV(query, limit, imdbId = null) {
  try {
    const mapItem = t => {
      if (!t.hash) return null
      return torrentItem({
        id: t.hash.toLowerCase(), title: t.title || t.filename || 'Unknown',
        magnet_link: t.magnet_url || buildMagnet(t.hash, t.title),
        size_bytes: parseInt(t.size_bytes) || null, seeders: t.seeds, leechers: t.peers,
        category: 'TV', source: 'eztv', providers: ['eztv'],
      })
    }

    if (imdbId) {
      const numericId = String(imdbId).replace(/^tt/i, '')
      const r = await fetch(
        `https://eztv.re/api/get-torrents?imdb_id=${numericId}&limit=${Math.min(limit, 100)}`,
        { headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000) }
      )
      const json = await safeJSON(r, 'eztv')
      if (!json) return []
      return (json.torrents || []).map(mapItem).filter(Boolean).slice(0, limit)
    }

    const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    const words = q.split(' ').filter(w => w.length > 1)
    const pages = [1, 2, 3]
    const fetches = pages.map(page =>
      fetch(
        `https://eztv.re/api/get-torrents?limit=100&page=${page}`,
        { headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000) }
      ).then(r => safeJSON(r, 'eztv')).catch(() => null)
    )
    const results = await Promise.all(fetches)
    const all = results.flatMap(json => json?.torrents || [])
    return all
      .filter(t => {
        const hay = (t.title || t.filename || '').toLowerCase()
        return words.every(w => hay.includes(w))
      })
      .map(mapItem).filter(Boolean).slice(0, limit)
  } catch (e) { console.log('[eztv]', e.message); return [] }
}

async function searchTorrentsCsv(query, limit) {
  try {
    const r = await fetch(
      `https://torrents-csv.com/service/search?q=${encodeURIComponent(query)}&size=${limit}&page=0`,
      { headers: FETCH_HEADERS, signal: AbortSignal.timeout(12000) }
    )
    const json = await safeJSON(r, 'torrents-csv')
    if (!json) return []
    return (json.torrents || []).slice(0, limit).map(t => torrentItem({
      id: t.infohash.toLowerCase(), title: t.name || 'Unknown',
      magnet_link: buildMagnet(t.infohash, t.name),
      size_bytes: t.size_bytes || null, seeders: t.seeders, leechers: t.leechers,
      source: 'torrents-csv', providers: ['torrents-csv'],
    }))
  } catch (e) { console.log('[torrents-csv]', e.message); return [] }
}

// Torrentio (Stremio addon) — aggregates torrents from many sources including
// 1337x, ThePirateBay, RARBG, etc. Requires an IMDB ID, not a text query.
// Returns streams with infoHash directly, plus metadata (seeds, size, source) in the title.
// Endpoints: /stream/movie/{imdbId}.json, /stream/series/{imdbId}:{season}:{episode}.json
async function searchTorrentio(query, limit, imdbId = null) {
  // Torrentio only works with IMDB IDs — skip if we don't have one
  if (!imdbId) return []
  try {
    const url = `https://torrentio.strem.fun/stream/movie/${imdbId}.json`
    const r = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(12000),
    })
    const json = await safeJSON(r, 'torrentio')
    if (!json) return []
    const streams = json.streams || []
    return streams.slice(0, limit).flatMap(s => {
      if (!s.infoHash) return []
      const title = s.behaviorHints?.filename || s.title?.split('\n')[0] || 'Unknown'
      // Parse seeders (👤), size (💾), and source (⚙️) from Torrentio's formatted title string
      const titleStr = s.title || ''
      const seedMatch = titleStr.match(/👤\s*(\d+)/)
      const sizeMatch = titleStr.match(/💾\s*([\d.]+\s*[TGMK]B)/i)
      const srcMatch  = titleStr.match(/⚙️\s*(\S+)/)
      return [torrentItem({
        id: s.infoHash.toLowerCase(),
        title,
        magnet_link: buildMagnet(s.infoHash, title),
        size_bytes: parseSize(sizeMatch?.[1] || ''),
        seeders: parseInt(seedMatch?.[1]) || 0,
        leechers: 0,
        source: 'torrentio',
        // Track the original source site that Torrentio found this on
        providers: ['torrentio', srcMatch?.[1] || ''].filter(Boolean),
      })]
    })
  } catch (e) { console.log('[torrentio]', e.message); return [] }
}

const PROXY_BASE      = 'https://torrent-search-api-murex.vercel.app/api'
const PROXY_PROVIDERS = ['nyaasi', 'glodls']

async function searchViaProxy(provider, query, limit) {
  try {
    const url = `${PROXY_BASE}/${provider}/${encodeURIComponent(query)}/1`
    const r = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(15000) })
    const json = await safeJSON(r, provider)
    if (!json || !Array.isArray(json)) return []
    return json.slice(0, limit).flatMap(item => {
      const magnet     = item.Magnet || item.magnet || ''
      const name       = item.Name   || item.name   || item.title || 'Unknown'
      const torrentUrl = item.TorrentUrl || item.torrent_url || item.Torrent || item.torrent || ''
      const infoHash   = magnet ? extractInfoHash(magnet) : null
      const id = infoHash || (magnet || null) || torrentUrl || null
      if (!id) return []
      return [torrentItem({
        id, title: name,
        magnet_link: magnet || null,
        torrent_url: torrentUrl || null,
        size_bytes:  parseSize(item.Size || item.size || ''),
        seeders:     item.Seeders  || item.seeders  || 0,
        leechers:    item.Leechers || item.leechers || 0,
        category:    item.Category || item.category || null,
        source: provider, providers: [provider],
        poster: item.Poster || item.poster || null,
      })]
    })
  } catch (e) { console.log(`[${provider}]`, e.message); return [] }
}

const BLOCKED_CATEGORIES = new Set(['software','games','game','apps','application','books','ebooks','xxx','adult','other'])
const BLOCKED_TITLE_RE   = /\.(exe|zip|rar|iso|apk|dmg|pkg|deb|rpm|msi|pdf|epub|mobi|azw)$|\b(crack|keygen|patch|activator|serial|license\.key)\b/i

function looksLikeMedia(item) {
  const cat = (item.category || '').toLowerCase()
  if ([...BLOCKED_CATEGORIES].some(b => cat.includes(b))) return false
  if (BLOCKED_TITLE_RE.test(item.title || '')) return false
  return true
}

async function aggregateTorrents(query, limitPerProvider = 20, { imdbId = null } = {}) {
  const directSearches = [
    // searchKnaben(query, limitPerProvider),
    searchPirateBay(query, limitPerProvider),
    searchTorrentsCsv(query, limitPerProvider),
    searchEZTV(query, limitPerProvider, imdbId),
    searchTorrentio(query, limitPerProvider, imdbId),
  ]
  const proxySearches = PROXY_PROVIDERS.map(p => searchViaProxy(p, query, limitPerProvider))
  const settled = await Promise.allSettled([...directSearches, ...proxySearches])

  const byHash = new Map()
  const byId   = new Map()

  for (const r of settled) {
    if (r.status !== 'fulfilled') continue
    for (const item of r.value) {
      if (!item.id) continue
      const key    = item.id.toLowerCase()
      const isHash = /^[a-f0-9]{40}$|^[a-z2-7]{32}$/i.test(key)
      const store  = isHash ? byHash : byId

      if (!store.has(key)) {
        store.set(key, { ...item, providers: [...(item.providers || [item.source])] })
      } else {
        const existing = store.get(key)
        for (const p of (item.providers || [item.source])) {
          if (!existing.providers.includes(p)) existing.providers.push(p)
        }
        if (item.seeders > existing.seeders) {
          existing.seeders      = item.seeders
          existing.leechers     = item.leechers
          existing.health_score = item.health_score
          existing.size_bytes   = item.size_bytes || existing.size_bytes
          existing.magnet_link  = item.magnet_link || existing.magnet_link
        }
      }
    }
  }
  return [...byHash.values(), ...byId.values()].filter(looksLikeMedia)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/search/torrents', async (req, res) => {
  const q = req.query.q?.trim()
  if (!q) return res.status(400).json({ error: 'q param required' })
  const limitPerProvider = Math.min(parseInt(req.query.per_provider) || 20, 50)
  const page    = Math.max(parseInt(req.query.page) || 1, 1)
  const perPage = Math.min(parseInt(req.query.limit) || 50, 200)
  const sortBy  = req.query.sort || 'health'
  const imdbId   = req.query.imdb_id?.trim() || null
  const cacheKey = `torrents:${q}:${limitPerProvider}:${imdbId || ''}`
  let allResults = torrentSearchCache.get(cacheKey)
  const wasCached = allResults !== undefined
  if (!allResults) {
    try {
      allResults = await aggregateTorrents(q, limitPerProvider, { imdbId })
      torrentSearchCache.set(cacheKey, allResults, TORRENT_CACHE_TTL)
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }
  const sorted = sortBy === 'seeders'
    ? [...allResults].sort((a, b) => b.seeders - a.seeders)
    : [...allResults].sort((a, b) => b.health_score !== a.health_score ? b.health_score - a.health_score : b.seeders - a.seeders)
  const start = (page - 1) * perPage
  const paged = sorted.slice(start, start + perPage)
  res.json({
    query: q, total: sorted.length, page, per_page: perPage,
    total_pages: Math.ceil(sorted.length / perPage),
    providers_queried: ['piratebay', 'yts', 'eztv', 'torrents-csv', 'torrentio', ...PROXY_PROVIDERS],
    cached: wasCached, results: paged,
  })
})

app.get('/api/search/tmdb', async (req, res) => {
  if (!TMDB_KEY) return res.status(503).json({ error: 'TMDB_API_KEY not configured' })
  const q = req.query.q?.trim()
  if (!q) return res.status(400).json({ error: 'q param required' })
  const type = ['movie','tv','multi'].includes(req.query.type) ? req.query.type : 'multi'
  const page = Math.max(parseInt(req.query.page) || 1, 1)
  const year = req.query.year || null
  const cacheKey = `tmdb-search:${q}:${type}:${page}:${year}`
  const cached = tmdbSearchCache.get(cacheKey)
  if (cached) return res.json({ ...cached, cached: true })
  try {
    const endpoint = type === 'multi' ? '/search/multi' : `/search/${type}`
    const params = { query: q, page, include_adult: false }
    if (year) params.year = year
    const json = await tmdbFetch(endpoint, params, tmdbSearchCache, TMDB_SEARCH_TTL)
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    const items = (json.results || []).filter(r =>
      type === 'multi' ? (r.media_type === 'movie' || r.media_type === 'tv') : true
    )
    const enriched = []
    for (let i = 0; i < items.length; i += 5) {
      const batch = await Promise.all(items.slice(i, i + 5).map(item => enrichTMDBItem(item)))
      enriched.push(...batch)
    }
    const payload = { query: q, type, page: json.page, total_pages: json.total_pages, total_results: json.total_results, results: enriched }
    tmdbSearchCache.set(cacheKey, payload, TMDB_SEARCH_TTL)
    res.json({ ...payload, cached: false })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/tmdb/:type/:id', async (req, res) => {
  if (!TMDB_KEY) return res.status(503).json({ error: 'TMDB_API_KEY not configured' })
  const { type, id } = req.params
  if (!['movie', 'tv'].includes(type)) return res.status(400).json({ error: 'type must be movie or tv' })
  const cacheKey = `tmdb-detail:${type}:${id}`
  const cached = tmdbDetailCache.get(cacheKey)
  if (cached) return res.json({ ...cached, cached: true })
  try {
    const result = await enrichTMDBItem({ id: parseInt(id), media_type: type })
    if (!result?.tmdbId) return res.status(404).json({ error: 'Not found on TMDB' })
    const similar = await tmdbFetch(`/${type}/${id}/similar`, { page: 1 }, tmdbDetailCache, TMDB_DETAIL_TTL)
    result.similar = (similar?.results || []).slice(0, 12).map(formatTMDBCard)
    tmdbDetailCache.set(cacheKey, result, TMDB_DETAIL_TTL)
    res.json({ ...result, cached: false })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/tmdb/tv/:id/season/:season', async (req, res) => {
  if (!TMDB_KEY) return res.status(503).json({ error: 'TMDB_API_KEY not configured' })
  const { id, season } = req.params
  try {
    const data = await tmdbFetch(`/tv/${id}/season/${season}`, {}, tmdbDetailCache, TMDB_DETAIL_TTL)
    if (!data) return res.status(404).json({ error: 'Season not found' })
    res.json({
      seasonNumber: data.season_number, name: data.name,
      overview: data.overview || null, airDate: data.air_date || null,
      poster: imgUrl(data.poster_path, 'w342'),
      episodes: (data.episodes || []).map(ep => ({
        episodeNumber: ep.episode_number, name: ep.name,
        overview: ep.overview || null, airDate: ep.air_date || null,
        runtime: ep.runtime || null, stillPath: imgUrl(ep.still_path, 'w300'),
        tmdbRating: ep.vote_average ? Math.round(ep.vote_average * 10) / 10 : null,
        guestStars: (ep.guest_stars || []).slice(0, 4).map(p => ({
          name: p.name, character: p.character, photo: imgUrl(p.profile_path, 'w185'),
        })),
      })),
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/trending', async (req, res) => {
  try {
    const json = await tmdbFetch(`/trending/${req.query.type || 'all'}/${req.query.window || 'week'}`, { page: parseInt(req.query.page) || 1 })
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    res.json({ page: json.page, total_pages: json.total_pages, total_results: json.total_results, results: (json.results || []).map(formatTMDBCard) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/popular', async (req, res) => {
  try {
    const json = await tmdbFetch(`/${req.query.type || 'movie'}/popular`, { page: parseInt(req.query.page) || 1 })
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    res.json({ page: json.page, total_pages: json.total_pages, total_results: json.total_results, results: (json.results || []).map(formatTMDBCard) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/toprated', async (req, res) => {
  try {
    const json = await tmdbFetch(`/${req.query.type || 'movie'}/top_rated`, { page: parseInt(req.query.page) || 1 })
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    res.json({ page: json.page, total_pages: json.total_pages, total_results: json.total_results, results: (json.results || []).map(formatTMDBCard) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/upcoming', async (req, res) => {
  try {
    const json = await tmdbFetch('/movie/upcoming', { page: parseInt(req.query.page) || 1 })
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    res.json({ page: json.page, total_pages: json.total_pages, results: (json.results || []).map(formatTMDBCard) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/nowplaying', async (req, res) => {
  try {
    const json = await tmdbFetch('/movie/now_playing', { page: parseInt(req.query.page) || 1 })
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    res.json({ page: json.page, total_pages: json.total_pages, results: (json.results || []).map(formatTMDBCard) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/discover', async (req, res) => {
  const type = req.query.type || 'movie'
  const page = parseInt(req.query.page) || 1
  const params = { page, sort_by: req.query.sort || 'popularity.desc' }
  if (req.query.genre)     params.with_genres = req.query.genre
  if (req.query.year)      params[type === 'movie' ? 'primary_release_year' : 'first_air_date_year'] = req.query.year
  if (req.query.yearMin)   params[type === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte'] = `${req.query.yearMin}-01-01`
  if (req.query.yearMax)   params[type === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte'] = `${req.query.yearMax}-12-31`
  if (req.query.ratingMin) params['vote_average.gte'] = req.query.ratingMin
  if (req.query.ratingMax) params['vote_average.lte'] = req.query.ratingMax
  if (req.query.language)  params.with_original_language = req.query.language
  if (req.query.voteMin)   params['vote_count.gte'] = req.query.voteMin || 100
  try {
    const json = await tmdbFetch(`/discover/${type}`, params)
    if (!json) return res.status(502).json({ error: 'TMDB unavailable' })
    res.json({ page: json.page, total_pages: json.total_pages, total_results: json.total_results, results: (json.results || []).map(formatTMDBCard) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/genres', (req, res) => {
  res.json({
    movie: Object.entries(MOVIE_GENRES).map(([id, name]) => ({ id: parseInt(id), name })),
    tv:    Object.entries(TV_GENRES).map(([id, name]) => ({ id: parseInt(id), name })),
  })
})

app.get('/api/homepage', async (req, res) => {
  if (!TMDB_KEY) return res.status(503).json({ error: 'TMDB_API_KEY not configured' })
  try {
    const [trending, popularMovies, popularTV, topRatedMovies, topRatedTV, upcoming] = await Promise.allSettled([
      tmdbFetch('/trending/all/week', { page: 1 }),
      tmdbFetch('/movie/popular', { page: 1 }),
      tmdbFetch('/tv/popular', { page: 1 }),
      tmdbFetch('/movie/top_rated', { page: 1 }),
      tmdbFetch('/tv/top_rated', { page: 1 }),
      tmdbFetch('/movie/upcoming', { page: 1 }),
    ])
    const extract = r => r.status === 'fulfilled' && r.value ? (r.value.results || []).map(formatTMDBCard) : []
    res.json({
      trending: extract(trending).slice(0, 20),
      popularMovies: extract(popularMovies).slice(0, 20),
      popularTV: extract(popularTV).slice(0, 20),
      topRatedMovies: extract(topRatedMovies).slice(0, 20),
      topRatedTV: extract(topRatedTV).slice(0, 20),
      upcoming: extract(upcoming).slice(0, 20),
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get('/api/resolve', (req, res) => {
  const { magnet } = req.query
  if (!magnet?.startsWith('magnet:?')) return res.status(400).json({ error: 'Invalid magnet link' })
  const infoHash = extractInfoHash(magnet)
  if (!infoHash) return res.status(400).json({ error: 'Missing info hash' })
  const dn = magnet.match(/[&?]dn=([^&]+)/)?.[1]
  const title = dn ? decodeURIComponent(dn.replace(/\+/g, ' ')) : 'Unknown Torrent'
  res.json(torrentItem({ id: infoHash, title, magnet_link: magnet, source: 'direct', providers: ['direct'] }))
})

app.get('/api/info', async (req, res) => {
  let { magnet, infoHash: hashParam, torrent_url } = req.query
  if ((!magnet || magnet === 'magnet:') && req.query.xt) {
    const hash = req.query.xt.replace(/^urn:btih:/i, '').toLowerCase()
    if (/^[a-f0-9]{40}$|^[a-z2-7]{32}$/i.test(hash)) {
      magnet = `magnet:?xt=urn:btih:${hash}`
      if (req.query.dn) magnet += `&dn=${req.query.dn}`
      console.log(`[/api/info] Reconstructed magnet from unencoded URL: ${magnet.slice(0, 60)}`)
    }
  }
  if (!magnet && !hashParam) return res.status(400).json({ error: 'magnet or infoHash param required' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  let closed = false
  req.on('close', () => { closed = true })
  const send = (ev, data) => { if (!closed && !res.writableEnded) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`) }
  const sendStatus = msg => { console.log(`[status] ${msg}`); send('status', { message: msg }) }

  try {
    const torrent = await getOrAdd(hashParam || magnet, sendStatus, torrent_url)
    sendStatus(`Found ${torrent.numPeers} peers — waiting for data connection…`)
    await waitForPeers(torrent, 60_000, sendStatus)
    resetTTL(torrent.infoHash)

    const files = torrent.files.map((f, i) => ({
      index: i, name: f.name, path: f.path, length: f.length,
      playable: isPlayable(f.name), subtitle: isSubtitle(f.name),
      ext: f.name.split('.').pop().toLowerCase(),
    }))
    const playableFiles = files.filter(f => f.playable).sort((a, b) => b.length - a.length)
    const subtitleFiles = files.filter(f => f.subtitle)

    send('ready', {
      infoHash: torrent.infoHash, name: torrent.name, length: torrent.length,
      files, peers: torrent.numPeers,
      playableIndex: playableFiles[0]?.index ?? -1,
      subtitles: subtitleFiles,
    })
  } catch (err) {
    console.error('[/api/info]', err.message)
    send('error', { error: err.message })
  }
  res.end()
})

app.get('/api/stream', async (req, res) => {
  let { magnet, infoHash: hashParam, torrent_url, file: fileIndexStr } = req.query
  if ((!magnet || magnet === 'magnet:') && req.query.xt) {
    const hash = req.query.xt.replace(/^urn:btih:/i, '').toLowerCase()
    if (/^[a-f0-9]{40}$|^[a-z2-7]{32}$/i.test(hash)) {
      magnet = `magnet:?xt=urn:btih:${hash}`
      if (req.query.dn) magnet += `&dn=${req.query.dn}`
    }
  }
  if (!magnet && !hashParam) return res.status(400).json({ error: 'infoHash or magnet required' })

  try {
    const torrent = await getOrAdd(hashParam || magnet, () => {}, torrent_url)
    resetTTL(torrent.infoHash)

    if (torrent.numPeers === 0) {
      try { await waitForPeers(torrent, 45_000, () => {}) } catch (_) {
        return res.status(503).json({ error: 'No peers available — try again shortly' })
      }
    }

    const fileIndex = parseInt(fileIndexStr ?? '0', 10)
    if (fileIndex < 0 || fileIndex >= torrent.files.length)
      return res.status(404).json({ error: `File index ${fileIndex} out of range` })

    const file = torrent.files[fileIndex]
    torrent.files.forEach((f, i) => i === fileIndex ? f.select() : f.deselect())

    const fileLength = file.length
    const ext = file.name.split('.').pop().toLowerCase()
    const mime = MIME[ext] || 'application/octet-stream'
    const range = req.headers.range
    console.log(`[stream] "${file.name}" peers=${torrent.numPeers} range=${range || 'none'}`)

    const makeStream = opts => {
      const s = file.createReadStream(opts)
      s.on('error', err => {
        if (!err.message.includes('Writable stream closed prematurely'))
          console.error('[stream err]', err.message)
      })
      return s
    }

    if (range) {
      const [s, e] = range.replace(/bytes=/, '').split('-')
      const start = parseInt(s, 10)
      const end = e ? parseInt(e, 10) : fileLength - 1
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileLength}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime,
      })
      const stream = makeStream({ start, end })
      stream.pipe(res)
      req.on('close', () => stream.destroy())
    } else {
      res.writeHead(200, { 'Content-Length': fileLength, 'Content-Type': mime, 'Accept-Ranges': 'bytes' })
      const stream = makeStream()
      stream.pipe(res)
      req.on('close', () => stream.destroy())
    }
  } catch (err) {
    console.error('[/api/stream]', err.message)
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

app.get('/api/subtitle', async (req, res) => {
  const { infoHash, file: fileIndexStr } = req.query
  if (!infoHash) return res.status(400).json({ error: 'infoHash required' })
  try {
    const torrent = await getOrAdd(infoHash, () => {})
    const fileIndex = parseInt(fileIndexStr ?? '0', 10)
    if (fileIndex < 0 || fileIndex >= torrent.files.length)
      return res.status(404).json({ error: 'File not found' })
    const file = torrent.files[fileIndex]
    const ext = file.name.split('.').pop().toLowerCase()
    res.writeHead(200, {
      'Content-Type': ext === 'vtt' ? 'text/vtt' : 'text/plain',
      'Access-Control-Allow-Origin': '*',
    })
    file.createReadStream().pipe(res)
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROBE ENDPOINT
//
// GET /api/probe?infoHash=<hash>&file=<index>
//
// Runs ffprobe on the torrent file to list all embedded streams.
// Results are cached for 1 hour per (infoHash, fileIndex) pair.
//
// Response:
// {
//   infoHash, fileIndex, fileName,
//   streams: [{
//     index, type, codec, codecLong, language, title,
//     default, forced, channels, sampleRate, bitRate,
//     // audio-only extras above; subtitle extras:
//     width, height
//   }],
//   audioStreams:    [ ...filtered to type === 'audio' ],
//   subtitleStreams: [ ...filtered to type === 'subtitle' ],
//   videoStreams:    [ ...filtered to type === 'video' ],
// }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/probe', async (req, res) => {
  const { infoHash, file: fileIndexStr } = req.query
  if (!infoHash) return res.status(400).json({ error: 'infoHash required' })

  const fileIndex = parseInt(fileIndexStr ?? '0', 10)
  const cacheKey  = `probe:${infoHash}:${fileIndex}`
  const cached    = probeCache.get(cacheKey)
  if (cached) return res.json({ ...cached, cached: true })

  try {
    const torrent = await getOrAdd(infoHash, () => {})
    resetTTL(torrent.infoHash)

    if (fileIndex < 0 || fileIndex >= torrent.files.length)
      return res.status(404).json({ error: `File index ${fileIndex} out of range` })

    const file    = torrent.files[fileIndex]
    const streams = await probeFile(file)

    const payload = {
      infoHash,
      fileIndex,
      fileName:        file.name,
      fileSize:        file.length,
      streams,
      audioStreams:    streams.filter(s => s.type === 'audio'),
      subtitleStreams: streams.filter(s => s.type === 'subtitle'),
      videoStreams:    streams.filter(s => s.type === 'video'),
    }

    probeCache.set(cacheKey, payload, PROBE_CACHE_TTL)
    res.json({ ...payload, cached: false })
  } catch (err) {
    console.error('[/api/probe]', err.message)
    res.status(err.message.includes('not found') ? 503 : 500).json({ error: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUDIO EXTRACTION ENDPOINT
//
// GET /api/extract/audio?infoHash=<hash>&file=<fileIndex>&stream=<streamIndex>&format=<fmt>
//
// Parameters:
//   infoHash  — torrent info hash (required)
//   file      — torrent file index (default: 0)
//   stream    — ffprobe stream index to extract (default: first audio stream found)
//   format    — output format: aac (default) | mp3 | flac | opus | wav | copy
//
// The response streams the extracted audio directly.
// Content-Disposition triggers a browser download with a sensible filename.
//
// Example:
//   /api/extract/audio?infoHash=abc123&file=0&stream=1&format=mp3
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/extract/audio', async (req, res) => {
  const { infoHash, file: fileIndexStr, format = 'aac' } = req.query
  let   { stream: streamIndexStr } = req.query

  if (!infoHash) return res.status(400).json({ error: 'infoHash required' })

  const fmt = AUDIO_FORMATS[format]
  if (!fmt) {
    return res.status(400).json({
      error: `Unsupported format "${format}". Supported: ${Object.keys(AUDIO_FORMATS).join(', ')}`,
    })
  }

  try {
    const torrent   = await getOrAdd(infoHash, () => {})
    resetTTL(torrent.infoHash)

    const fileIndex = parseInt(fileIndexStr ?? '0', 10)
    if (fileIndex < 0 || fileIndex >= torrent.files.length)
      return res.status(404).json({ error: `File index ${fileIndex} out of range` })

    const file = torrent.files[fileIndex]

    // Resolve stream index — if not supplied, probe and pick the first audio stream
    let streamIndex
    if (streamIndexStr !== undefined) {
      streamIndex = parseInt(streamIndexStr, 10)
    } else {
      const cacheKey = `probe:${infoHash}:${fileIndex}`
      let probeResult = probeCache.get(cacheKey)
      if (!probeResult) {
        const streams = await probeFile(file)
        probeResult = { streams, audioStreams: streams.filter(s => s.type === 'audio') }
        probeCache.set(cacheKey, {
          infoHash, fileIndex, fileName: file.name, fileSize: file.length,
          streams, audioStreams: probeResult.audioStreams,
          subtitleStreams: streams.filter(s => s.type === 'subtitle'),
          videoStreams:    streams.filter(s => s.type === 'video'),
        }, PROBE_CACHE_TTL)
      }
      const firstAudio = probeResult.audioStreams?.[0] ?? probeResult.streams?.find(s => s.type === 'audio')
      if (!firstAudio) return res.status(404).json({ error: 'No audio streams found in this file' })
      streamIndex = firstAudio.index
    }

    const baseName    = file.name.replace(/\.[^.]+$/, '')
    const outFilename = `${baseName}_audio_stream${streamIndex}.${fmt.ext}`

    console.log(`[extract/audio] "${file.name}" stream=${streamIndex} format=${format}`)

    res.setHeader('Content-Type', fmt.mime)
    res.setHeader('Content-Disposition', `attachment; filename="${outFilename}"`)
    res.setHeader('Transfer-Encoding', 'chunked')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Access-Control-Allow-Origin', '*')

    extractStream(file, streamIndex, fmt.args, fmt.fmt, res, outFilename)
  } catch (err) {
    console.error('[/api/extract/audio]', err.message)
    if (!res.headersSent) res.status(err.message.includes('not found') ? 503 : 500).json({ error: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SUBTITLE EXTRACTION ENDPOINT
//
// GET /api/extract/subtitle?infoHash=<hash>&file=<fileIndex>&stream=<streamIndex>&format=<fmt>
//
// Parameters:
//   infoHash  — torrent info hash (required)
//   file      — torrent file index (default: 0)
//   stream    — ffprobe stream index to extract (default: first subtitle stream)
//   format    — output format: srt (default) | vtt | ass | copy
//
// Embedded subtitles (e.g. in MKV) are extracted on-the-fly.
// The response is plain text / WebVTT suitable for use as a <track> src.
//
// Example:
//   /api/extract/subtitle?infoHash=abc123&file=0&stream=3&format=vtt
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/extract/subtitle', async (req, res) => {
  const { infoHash, file: fileIndexStr, format = 'srt' } = req.query
  let   { stream: streamIndexStr } = req.query

  if (!infoHash) return res.status(400).json({ error: 'infoHash required' })

  const fmt = SUBTITLE_FORMATS[format]
  if (!fmt) {
    return res.status(400).json({
      error: `Unsupported format "${format}". Supported: ${Object.keys(SUBTITLE_FORMATS).join(', ')}`,
    })
  }

  try {
    const torrent   = await getOrAdd(infoHash, () => {})
    resetTTL(torrent.infoHash)

    const fileIndex = parseInt(fileIndexStr ?? '0', 10)
    if (fileIndex < 0 || fileIndex >= torrent.files.length)
      return res.status(404).json({ error: `File index ${fileIndex} out of range` })

    const file = torrent.files[fileIndex]

    // Resolve stream index
    let streamIndex
    if (streamIndexStr !== undefined) {
      streamIndex = parseInt(streamIndexStr, 10)
    } else {
      const cacheKey = `probe:${infoHash}:${fileIndex}`
      let probeResult = probeCache.get(cacheKey)
      if (!probeResult) {
        const streams = await probeFile(file)
        probeResult = {
          streams,
          subtitleStreams: streams.filter(s => s.type === 'subtitle'),
          audioStreams:    streams.filter(s => s.type === 'audio'),
        }
        probeCache.set(cacheKey, {
          infoHash, fileIndex, fileName: file.name, fileSize: file.length,
          streams, ...probeResult,
          videoStreams: streams.filter(s => s.type === 'video'),
        }, PROBE_CACHE_TTL)
      }
      const firstSub = probeResult.subtitleStreams?.[0] ?? probeResult.streams?.find(s => s.type === 'subtitle')
      if (!firstSub) return res.status(404).json({ error: 'No subtitle streams found in this file' })
      streamIndex = firstSub.index
    }

    const baseName    = file.name.replace(/\.[^.]+$/, '')
    const outFilename = `${baseName}_sub_stream${streamIndex}.${fmt.ext}`

    console.log(`[extract/subtitle] "${file.name}" stream=${streamIndex} format=${format}`)

    res.setHeader('Content-Type', fmt.mime)
    res.setHeader('Content-Disposition', `attachment; filename="${outFilename}"`)
    res.setHeader('Transfer-Encoding', 'chunked')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Access-Control-Allow-Origin', '*')

    extractStream(file, streamIndex, fmt.args, fmt.fmt, res, outFilename)
  } catch (err) {
    console.error('[/api/extract/subtitle]', err.message)
    if (!res.headersSent) res.status(err.message.includes('not found') ? 503 : 500).json({ error: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OPENSUBTITLES INTEGRATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const OS_API_KEY  = process.env.OPENSUBTITLES_API_KEY || 'vQLTlPHCpMzRzHOesjpbijBtjWa0P1Zi'
const OS_BASE     = 'https://api.opensubtitles.com/api/v1'
const OS_APP      = 'TorrentStreamServer v1.0'

const osSearchCache   = new TTLCache()
const osLinkCache     = new TTLCache()
const OS_SEARCH_TTL   = 30 * 60 * 1000
const OS_LINK_TTL     = 4 * 60 * 1000

function osHeaders(withAuth = false) {
  const h = {
    'Api-Key':      OS_API_KEY || 'undefined',
    'Content-Type': 'application/json',
    'Accept':       'application/json',
    'User-Agent':   OS_APP,
  }
  return h
}

async function searchOpenSubtitles({ query, tmdb_id, imdb_id, season, episode, languages = 'en', type }) {
  const cacheKey = `os:${query}:${tmdb_id}:${imdb_id}:${season}:${episode}:${languages}:${type}`
  const cached = osSearchCache.get(cacheKey)
  if (cached !== undefined) return cached

  return coalesce(cacheKey, async () => {
    const url = new URL(`${OS_BASE}/subtitles`)

    if (tmdb_id)  url.searchParams.set('tmdb_id', String(tmdb_id))
    if (imdb_id) {
      url.searchParams.set('imdb_id', String(imdb_id).replace(/^tt/i, ''))
    }
    if (query)    url.searchParams.set('query', query)

    if (season)   url.searchParams.set('season_number', String(season))
    if (episode)  url.searchParams.set('episode_number', String(episode))

    url.searchParams.set('languages', languages)

    if (type && type !== 'all') {
      url.searchParams.set('type', type)
    }

    url.searchParams.set('order_by', 'download_count')
    url.searchParams.set('order_direction', 'desc')

    try {
      console.log(`[os] search: ${url.toString()}`)
      const r = await fetch(url.toString(), {
        headers: osHeaders(),
        signal: AbortSignal.timeout(10000),
      })

      if (r.status === 401) throw new Error('OpenSubtitles: invalid or missing API key')
      if (r.status === 429) throw new Error('OpenSubtitles: rate limit hit (5 downloads/day on free tier)')
      if (!r.ok) throw new Error(`OpenSubtitles: HTTP ${r.status}`)

      const json = await r.json()

      const results = (json.data || []).map(item => {
        const attr  = item.attributes || {}
        const files = attr.files || []
        const feat  = attr.feature_details || {}
        return {
          subtitle_id:      item.id,
          file_id:          files[0]?.file_id ?? null,
          file_name:        files[0]?.file_name ?? null,
          language:         attr.language,
          language_name:    LANG_NAMES[attr.language] || attr.language,
          download_count:   attr.download_count || 0,
          new_download_count: attr.new_download_count || 0,
          hearing_impaired: attr.hearing_impaired || false,
          hd:               attr.hd || false,
          fps:              attr.fps || null,
          ratings:          attr.ratings || null,
          votes:            attr.votes || 0,
          from_trusted:     attr.from_trusted || false,
          ai_translated:    attr.ai_translated || false,
          machine_translated: attr.machine_translated || false,
          release:          attr.release || null,
          upload_date:      attr.upload_date || null,
          uploader:         attr.uploader?.name || null,
          uploader_rank:    attr.uploader?.rank || null,
          feature_title:    feat.title || feat.movie_name || null,
          feature_year:     feat.year || null,
          feature_type:     feat.feature_type || null,
          season:           feat.season_number ?? null,
          episode:          feat.episode_number ?? null,
          imdb_id:          feat.imdb_id ? `tt${String(feat.imdb_id).padStart(7, '0')}` : null,
          tmdb_id:          feat.tmdb_id || null,
          url:              attr.url || null,
        }
      })

      osSearchCache.set(cacheKey, results, OS_SEARCH_TTL)
      return results
    } catch (e) {
      console.log(`[os] search failed: ${e.message}`)
      throw e
    }
  })
}

async function getOsDownloadLink(file_id) {
  const cacheKey = `os-link:${file_id}`
  const cached = osLinkCache.get(cacheKey)
  if (cached !== undefined) return cached

  console.log(`[os] requesting download link for file_id=${file_id}`)
  const r = await fetch(`${OS_BASE}/download`, {
    method: 'POST',
    headers: osHeaders(),
    body: JSON.stringify({ file_id: parseInt(file_id) }),
    signal: AbortSignal.timeout(10000),
  })

  if (r.status === 401) throw new Error('OpenSubtitles: invalid or missing API key')
  if (r.status === 406) throw new Error('OpenSubtitles: daily download quota reached (5/day free, 20/day with account)')
  if (r.status === 429) throw new Error('OpenSubtitles: rate limited — try again in a moment')
  if (!r.ok) throw new Error(`OpenSubtitles download link: HTTP ${r.status}`)

  const json = await r.json()
  if (!json.link) throw new Error('OpenSubtitles: no download link in response')

  const result = {
    link:       json.link,
    file_name:  json.file_name,
    remaining:  json.remaining,
    reset_time: json.reset_time,
  }

  osLinkCache.set(cacheKey, result, OS_LINK_TTL)
  return result
}

function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim()
}

const LANG_NAMES = {
  en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', zh: 'Chinese',
  ja: 'Japanese', ko: 'Korean', ar: 'Arabic', hi: 'Hindi', tr: 'Turkish',
  sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', cs: 'Czech',
  sk: 'Slovak', hu: 'Hungarian', ro: 'Romanian', bg: 'Bulgarian', uk: 'Ukrainian',
  he: 'Hebrew', fa: 'Persian', id: 'Indonesian', th: 'Thai', vi: 'Vietnamese',
  'pt-br': 'Portuguese (Brazil)', 'zh-cn': 'Chinese (Simplified)',
  'zh-tw': 'Chinese (Traditional)',
}

app.get('/api/subtitles/search', async (req, res) => {
  const { query, tmdb_id, imdb_id, season, episode, type } = req.query
  const languages = req.query.languages || 'en'

  if (!query && !tmdb_id && !imdb_id) {
    return res.status(400).json({
      error: 'At least one of query, tmdb_id, or imdb_id is required',
    })
  }

  if (!OS_API_KEY) {
    return res.status(503).json({
      error: 'OpenSubtitles API key not configured. Set OPENSUBTITLES_API_KEY env var. Get a free key at https://www.opensubtitles.com/consumers',
    })
  }

  const cacheKey = `os-search-route:${query}:${tmdb_id}:${imdb_id}:${season}:${episode}:${languages}:${type}`
  const cached = osSearchCache.get(cacheKey)
  if (cached) return res.json({ ...cached, cached: true })

  try {
    const results = await searchOpenSubtitles({ query, tmdb_id, imdb_id, season, episode, languages, type })

    const payload = {
      query:     query || null,
      tmdb_id:   tmdb_id || null,
      imdb_id:   imdb_id || null,
      languages,
      total:     results.length,
      results,
    }
    osSearchCache.set(cacheKey, payload, OS_SEARCH_TTL)
    res.json({ ...payload, cached: false })
  } catch (err) {
    console.error('[subtitles/search]', err.message)
    res.status(502).json({ error: err.message })
  }
})

app.get('/api/subtitles/download', async (req, res) => {
  const { file_id, format = 'srt' } = req.query
  if (!file_id) return res.status(400).json({ error: 'file_id required' })

  if (!OS_API_KEY) {
    return res.status(503).json({
      error: 'OpenSubtitles API key not configured. Set OPENSUBTITLES_API_KEY env var.',
    })
  }

  try {
    const linkData = await getOsDownloadLink(file_id)

    const r = await fetch(linkData.link, {
      headers: { 'User-Agent': OS_APP },
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) throw new Error(`Subtitle fetch failed: HTTP ${r.status}`)

    let content = await r.text()
    const asVtt = format === 'vtt'

    if (asVtt && !content.trimStart().startsWith('WEBVTT')) {
      content = srtToVtt(content)
    }

    res.setHeader('Content-Type', asVtt ? 'text/vtt' : 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('X-OS-Remaining', String(linkData.remaining ?? '?'))
    res.setHeader('X-OS-Reset-Time', linkData.reset_time || '')
    res.send(content)
  } catch (err) {
    console.error('[subtitles/download]', err.message)
    if (!res.headersSent) res.status(502).json({ error: err.message })
  }
})

app.get('/api/subtitles/quota', (req, res) => {
  res.json({
    api_key_configured: !!OS_API_KEY,
    note: 'Free tier: 5 downloads/day without account, 20/day with free account. Check X-OS-Remaining header on /api/subtitles/download responses.',
    register_url: 'https://www.opensubtitles.com/consumers',
  })
})

app.get('/api/stats', (req, res) => {
  const h = req.query.infoHash?.toLowerCase()
  const torrent = torrents.get(h)?.torrent || getClient().torrents.find(t => t.infoHash === h)
  if (!torrent) return res.status(404).json({ error: 'Not found' })
  res.json({
    peers: torrent.numPeers,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    progress: torrent.progress,
    timeRemaining: torrent.timeRemaining,
    downloaded: torrent.downloaded,
    uploaded: torrent.uploaded,
  })
})

app.get('/api/health', (req, res) => res.json({
  ok: true, uptime: Math.round(process.uptime()),
  torrents: getClient().torrents.length, activeTorrents: torrents.size,
  hlsSessions: hlsSessions.size,
  opensubtitles: { api_key_configured: !!OS_API_KEY },
  cache: {
    torrentSearch: torrentSearchCache.stats(), tmdbSearch: tmdbSearchCache.stats(),
    tmdbDetail: tmdbDetailCache.stats(), tmdbBrowse: tmdbBrowseCache.stats(),
    osSearch: osSearchCache.stats(), osLinks: osLinkCache.stats(),
    probe: probeCache.stats(),
    inFlight: inFlight.size,
  },
}))

app.post('/api/cache/flush', (req, res) => {
  const target = req.query.target || 'all'
  if (target === 'torrents' || target === 'all') torrentSearchCache.flush()
  if (target === 'tmdb' || target === 'all') {
    tmdbSearchCache.flush(); tmdbDetailCache.flush(); tmdbBrowseCache.flush()
  }
  if (target === 'subtitles' || target === 'all') {
    osSearchCache.flush(); osLinkCache.flush()
  }
  if (target === 'probe' || target === 'all') {
    probeCache.flush()
  }
  res.json({ ok: true, flushed: target })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HLS ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/hls/:infoHash/:fileIndex/master.m3u8', async (req, res) => {
  const { infoHash, fileIndex } = req.params
  try {
    const session = await getOrStartHlsSession(infoHash, parseInt(fileIndex))
    const audioStreams = session.audioStreams || []
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3']

    if (audioStreams.length > 1) {
      // Audio track 0 is embedded in stream.m3u8 — declare it as default
      audioStreams.forEach((s, i) => {
        const lang      = s.language || 'und'
        const name      = s.title || (s.language ? s.language.toUpperCase() : `Track ${i + 1}`)
        const isDefault = i === 0 ? 'YES' : 'NO'
        // Track 0 is embedded in the video segments — RFC 8216 says URI must be omitted
        // for renditions whose media is carried in the variant stream itself.
        // Tracks 1+ have separate audio-only playlists, so they get a URI.
        const uriAttr = i === 0 ? '' : `,URI="audio${i}.m3u8"`
        lines.push(
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="${lang}",NAME="${name}",DEFAULT=${isDefault},AUTOSELECT=${isDefault}${uriAttr}`
        )
      })
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.42E01E,mp4a.40.2",AUDIO="audio"`)
    } else {
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.42E01E,mp4a.40.2"`)
    }

    lines.push('stream.m3u8')
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.send(lines.join('\n'))
  } catch (err) {
    console.error('[hls master]', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/hls/:infoHash/:fileIndex/stream.m3u8', (req, res) => {
  const { infoHash, fileIndex } = req.params
  const key = hlsSessionKey(infoHash, fileIndex)
  resetHlsTTL(key)
  const session = hlsSessions.get(key)
  if (!session?.ready) return res.status(404).json({ error: 'Session not ready' })
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  res.setHeader('Cache-Control', 'no-cache, no-store')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.sendFile(session.playlistPath)
})

// Serve extra audio-only playlists: audio1.m3u8, audio2.m3u8 …
app.get('/api/hls/:infoHash/:fileIndex/audio:trackNum.m3u8', (req, res) => {
  const { infoHash, fileIndex, trackNum } = req.params
  const key = hlsSessionKey(infoHash, fileIndex)
  resetHlsTTL(key)
  const session = hlsSessions.get(key)
  if (!session?.ready) return res.status(404).json({ error: 'Session not ready' })
  const playlistPath = join(session.dir, `audio${trackNum}.m3u8`)
  if (!existsSync(playlistPath)) return res.status(404).end()
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  res.setHeader('Cache-Control', 'no-cache, no-store')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.sendFile(playlistPath)
})

// Serve extra audio-only segments: audio1/seg00000.ts …
app.get('/api/hls/:infoHash/:fileIndex/audio:trackNum/:segment', (req, res) => {
  const { infoHash, fileIndex, trackNum, segment } = req.params
  if (!segment.endsWith('.ts')) return res.status(400).end()
  const key = hlsSessionKey(infoHash, fileIndex)
  resetHlsTTL(key)
  const session = hlsSessions.get(key)
  if (!session) return res.status(404).end()
  const segPath = join(session.dir, `audio${trackNum}`, segment)
  if (!existsSync(segPath)) return res.status(404).end()
  res.setHeader('Content-Type', 'video/mp2t')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.sendFile(segPath)
})

app.get('/api/hls/:infoHash/:fileIndex/:segment', (req, res) => {
  const { infoHash, fileIndex, segment } = req.params
  if (!segment.endsWith('.ts')) return res.status(400).end()
  const key = hlsSessionKey(infoHash, fileIndex)
  resetHlsTTL(key)
  const session = hlsSessions.get(key)
  if (!session) return res.status(404).end()
  const segPath = join(session.dir, segment)
  if (!existsSync(segPath)) return res.status(404).end()
  res.setHeader('Content-Type', 'video/mp2t')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.sendFile(segPath)
})

app.delete('/api/hls/:infoHash/:fileIndex', (req, res) => {
  destroyHlsSession(hlsSessionKey(req.params.infoHash, req.params.fileIndex))
  res.json({ ok: true })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SPA FALLBACK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'), err => {
    if (err) res.json({ ok: true, message: 'Server running. Build frontend with: npm run build' })
  })
})

let serverInstance = null

function start({ ffmpegPath, ffprobePath }) {
  if (serverInstance) {
    console.log("[server] Already running")
    return
  }

  if (ffmpegPath) process.env.FFMPEG_PATH = ffmpegPath
  if (ffprobePath) process.env.FFPROBE_PATH = ffprobePath

  console.log("FFMPEG:", process.env.FFMPEG_PATH)
console.log("FFPROBE:", process.env.FFPROBE_PATH)

  serverInstance = app.listen(PORT, () => {
    console.log(`\n[server] http://0.0.0.0:${PORT}\n`)
  })
}

function stop() {
  try {
    console.log("[server] Shutting down...")

    // Cleanup HLS sessions
    if (typeof hlsSessions !== "undefined") {
      hlsSessions.forEach((_, k) => destroyHlsSession(k))
    }

    // Cleanup torrent client
    if (typeof client !== "undefined" && client.destroy) {
      client.destroy()
    }

    if (serverInstance) {
      serverInstance.close(() => {
        console.log("[server] Closed")
      })
    }
  } catch (err) {
    console.error("[server] Shutdown error:", err)
  }
}

export { start, stop }