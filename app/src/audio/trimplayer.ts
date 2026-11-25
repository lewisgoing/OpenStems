/**
 * Playback for the trimmer: a song's own file and its stems, sample-locked as the stems panel's
 * player locks them (every source starts at one context time, and in or out is a gain).
 * Adds what trimming needs: looping a range on every source at once, playing a range once,
 * and a click on every beat of the grid, so a grid can be heard as well as seen.
 *
 * Tracks are fetched and decoded when they are asked for, not all at once: the editor asks
 * for what is chosen. Every buffer starts at the song's 0: a stem whose leading silence was
 * trimmed is padded back by its `start`, so loops and the playhead mean the same on all.
 */

import type { Grid, Range } from '@/lib/grid'
import { beatAt, timeAtBeat } from '@/lib/grid'

export interface TrimTrack {
  /** "original" for the song's own file, `stem:<name>` for a stem. */
  id: string
  /** What the track is, in a sentence about it: "kick", "the song". */
  label: string
  url: string
  /** Seconds into the song where its file begins. */
  start: number
}

type TrackStatus = { state: 'loading' } | { state: 'ready' } | { state: 'error'; error: string }

/**
 * A decoded file put at its place in the song: a stem whose leading silence was trimmed
 * begins `start` seconds into the song, so that much silence goes back in front of it and
 * every track starts at the song's 0. A file that starts at 0 is returned as it is.
 */
export function padToSong(context: Pick<BaseAudioContext, 'createBuffer'>, decoded: AudioBuffer, start: number): AudioBuffer {
  const pad = Math.round(start * decoded.sampleRate)
  if (pad <= 0) return decoded
  const padded = context.createBuffer(decoded.numberOfChannels, decoded.length + pad, decoded.sampleRate)
  for (let c = 0; c < decoded.numberOfChannels; c++) padded.copyToChannel(decoded.getChannelData(c), c, pad)
  return padded
}

export interface TrimPlayerState {
  playing: boolean
  /** Play was pressed and what is to be heard is still being decoded. */
  waiting: boolean
  /** The range being looped, if any. */
  loop: Range | null
  /** The range playing once, if any: playback stops at its end and goes back to its start. */
  once: Range | null
  /** The tracks that can be heard. */
  audible: readonly string[]
  click: boolean
  /** Each track asked for so far, by id. */
  tracks: Readonly<Record<string, TrackStatus>>
}

const RAMP = 0.015
const CLICK_RATE = 22050
/** Sources start this far ahead, so all of them start together. */
const LEAD = 0.03

interface Loaded {
  track: TrimTrack
  buffer: AudioBuffer | null
  abort: AbortController | null
}

export class TrimPlayer {
  state: TrimPlayerState = { playing: false, waiting: false, loop: null, once: null, audible: [], click: false, tracks: {} }
  private duration = 0
  private context: AudioContext | null = null
  private output: GainNode | null = null
  private known = new Map<string, TrimTrack>()
  private loaded = new Map<string, Loaded>()
  private gains = new Map<string, GainNode>()
  private sources = new Map<string, AudioBufferSourceNode>()
  private listeners = new Set<() => void>()
  private startedAt = 0
  private offset = 0
  private timer = 0
  private clickGrid: Grid | null = null
  private clickTimer = 0
  private clickBufferCache: AudioBuffer | null = null
  private generation = 0

  /** `silent` keeps everything running but sends no sound out: for automated tests. */
  constructor(
    private readonly headers: Record<string, string> = {},
    private readonly silent = false,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<TrimPlayerState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private setTrack(id: string, status: TrackStatus | null): void {
    const tracks = { ...this.state.tracks }
    if (status) tracks[id] = status
    else delete tracks[id]
    this.set({ tracks })
  }

  /** How long the song is. Known before any track is decoded. */
  setDuration(seconds: number): void {
    this.duration = Math.max(0, seconds)
  }

  /** Where playback is, in seconds of the song. Cheap: call it every frame. */
  get position(): number {
    if (!this.context || !this.state.playing) return this.offset
    return Math.min(Math.max(0, this.positionAt(this.context.currentTime)), this.duration)
  }

  private positionAt(when: number): number {
    let p = this.offset + (when - this.startedAt)
    const loop = this.state.loop
    if (loop && this.offset < loop.end && p >= loop.end) p = loop.start + ((p - loop.start) % (loop.end - loop.start))
    return p
  }

  /**
   * The tracks there are. A track whose file moved (a stem renamed by a new tempo) keeps what
   * was decoded of it; one still on its way is asked for again at its new place.
   */
  setTracks(tracks: TrimTrack[]): void {
    this.known = new Map(tracks.map((track) => [track.id, track]))
    for (const [id, loaded] of this.loaded) {
      const track = this.known.get(id)
      if (!track) continue
      const moved = track.url !== loaded.track.url
      loaded.track = track
      if (moved && !loaded.buffer) {
        loaded.abort?.abort()
        this.loaded.delete(id)
        this.load([id])
      }
    }
    // What is to be heard may only now have a file to load (the song's own, once previewed).
    this.load([...this.state.audible])
  }

  /** The decoded buffer of a track, starting at the song's 0, once it is there. */
  buffer(id: string): AudioBuffer | null {
    return this.loaded.get(id)?.buffer ?? null
  }

  private ensure(): AudioContext | null {
    if (this.context) return this.context
    if (typeof AudioContext === 'undefined') return null
    const context = new AudioContext({ latencyHint: 'interactive' })
    const output = context.createGain()
    output.gain.value = this.silent ? 0 : 1
    output.connect(context.destination)
    this.context = context
    this.output = output
    return context
  }

  private gainOf(id: string): GainNode | null {
    const context = this.context
    if (!context || !this.output) return null
    let gain = this.gains.get(id)
    if (!gain) {
      gain = context.createGain()
      gain.gain.value = this.heard(id) ? (id === 'click' ? 0.8 : 1) : 0
      gain.connect(this.output)
      this.gains.set(id, gain)
    }
    return gain
  }

  /** Fetch and decode these tracks, if they are not yet. */
  load(ids: string[]): void {
    for (const id of ids) {
      if (this.loaded.has(id)) continue
      const track = this.known.get(id)
      if (!track) continue
      const context = this.ensure()
      if (!context) {
        this.setTrack(id, { state: 'error', error: 'This window cannot play audio.' })
        continue
      }
      const abort = new AbortController()
      const loaded: Loaded = { track, buffer: null, abort }
      this.loaded.set(id, loaded)
      this.setTrack(id, { state: 'loading' })
      const generation = this.generation
      void this.decode(context, track, abort.signal).then(
        (buffer) => {
          if (generation !== this.generation || this.loaded.get(id) !== loaded) return
          loaded.buffer = buffer
          loaded.abort = null
          this.setTrack(id, { state: 'ready' })
          this.joined(id)
        },
        (error: unknown) => {
          if (generation !== this.generation || this.loaded.get(id) !== loaded || abort.signal.aborted) return
          this.loaded.delete(id)
          this.setTrack(id, { state: 'error', error: error instanceof Error ? error.message : String(error) })
          this.joined(id)
        },
      )
    }
  }

  private async decode(context: AudioContext, track: TrimTrack, signal: AbortSignal): Promise<AudioBuffer> {
    const response = await fetch(track.url, { headers: this.headers, signal })
    if (!response.ok) throw new Error(`Could not load ${track.label} (${response.status})`)
    const decoded = await context.decodeAudioData(await response.arrayBuffer())
    return padToSong(context, decoded, track.start)
  }

  /**
   * Whether every one of these tracks is decoded or failed: nothing more will come. A track
   * not known yet (the song's own file before its preview is made) is still to come.
   */
  private settled(ids: readonly string[]): boolean {
    return ids.every((id) => {
      const state = this.state.tracks[id]?.state
      return state === 'ready' || state === 'error'
    })
  }

  /** A track arrived: it joins what is playing, and a play that waited for it may start. */
  private joined(id: string): void {
    if (this.state.waiting && this.settled(this.state.audible)) {
      this.set({ waiting: false })
      this.begin(this.offset)
      return
    }
    const context = this.context
    const loaded = this.loaded.get(id)
    if (this.state.playing && context && loaded?.buffer && !this.sources.has(id)) {
      const when = context.currentTime + LEAD
      this.startOne(id, loaded.buffer, when, this.positionAt(when))
    }
  }

  private heard(id: string): boolean {
    if (id === 'click') return this.state.click
    return this.state.audible.includes(id)
  }

  private startOne(id: string, buffer: AudioBuffer, when: number, at: number): void {
    const context = this.context
    const gain = this.gainOf(id)
    if (!context || !gain) return
    const source = context.createBufferSource()
    source.buffer = buffer
    const loop = this.state.loop
    if (loop) {
      source.loop = true
      source.loopStart = loop.start
      source.loopEnd = loop.end
    }
    source.connect(gain)
    source.start(when, Math.max(0, Math.min(at, buffer.duration)))
    const old = this.sources.get(id)
    if (old) this.stopSource(old)
    this.sources.set(id, source)
  }

  private startAll(at: number): void {
    const context = this.context
    if (!context) return
    const when = context.currentTime + LEAD
    for (const [id, loaded] of this.loaded) if (loaded.buffer) this.startOne(id, loaded.buffer, when, at)
    const click = this.clickBuffer()
    if (click && this.state.click) this.startOne('click', click, when, at)
    this.startedAt = when
    this.offset = at
    window.clearTimeout(this.timer)
    if (!this.state.loop) {
      const end = this.state.once ? this.state.once.end : this.duration
      this.timer = window.setTimeout(() => this.finished(), Math.max(0, (end - at + LEAD) * 1000))
    }
  }

  private stopSource(source: AudioBufferSourceNode): void {
    try {
      source.stop()
    } catch {
      // Already stopped.
    }
    source.disconnect()
  }

  private stopAll(): void {
    window.clearTimeout(this.timer)
    for (const source of this.sources.values()) this.stopSource(source)
    this.sources.clear()
  }

  /** The natural end: of the range played once (back to its start), or of the song. */
  private finished(): void {
    const once = this.state.once
    this.stopAll()
    this.offset = once ? once.start : 0
    this.set({ playing: false, once: null })
  }

  /** Start from `at`, once what is to be heard is decoded. */
  private begin(at: number): void {
    const context = this.context
    if (!context) return
    this.offset = at
    if (!this.settled(this.state.audible)) {
      this.set({ waiting: true })
      return
    }
    this.set({ playing: true, waiting: false })
    // The context's clock stands still until it runs: sources set to start on it start then.
    void context.resume()
    this.startAll(at)
  }

  /** Play from `from`, or from where playback is. */
  play(from?: number): void {
    const context = this.ensure()
    if (!context || this.duration <= 0) return
    this.stopAll()
    let at = from ?? this.position
    const loop = this.state.loop
    if (loop && (at < loop.start || at >= loop.end)) at = loop.start
    if (!loop && at >= this.duration - 0.05) at = 0
    this.set({ once: null })
    this.load([...this.state.audible])
    this.begin(at)
  }

  /** Play `range` from its start: looped, or once. */
  playRange(range: Range, loop: boolean): void {
    const context = this.ensure()
    if (!context) return
    this.stopAll()
    this.set({ loop: loop ? range : null, once: loop ? null : range })
    this.load([...this.state.audible])
    this.begin(range.start)
  }

  pause(): void {
    if (this.state.waiting) {
      this.set({ waiting: false })
      return
    }
    if (!this.state.playing) return
    const position = this.position
    this.stopAll()
    this.offset = position
    this.set({ playing: false, once: null })
  }

  toggle(): void {
    if (this.state.playing || this.state.waiting) this.pause()
    else this.play()
  }

  seek(t: number): void {
    const target = Math.min(Math.max(0, t), this.duration)
    if (this.state.playing) {
      this.stopAll()
      this.set({ once: null })
      const loop = this.state.loop
      this.startAll(loop && (target < loop.start || target >= loop.end) ? loop.start : target)
    } else {
      this.offset = target
      this.set({})
    }
  }

  /** Loop this range, or stop looping. Playing goes on from where it is. */
  setLoop(range: Range | null): void {
    const position = this.position
    this.set({ loop: range, once: null })
    if (this.state.playing) {
      this.stopAll()
      this.startAll(range && (position < range.start || position >= range.end) ? range.start : position)
    }
  }

  /** Hear only these tracks, and decode them if they are not yet. */
  setAudible(ids: string[]): void {
    this.set({ audible: [...ids] })
    this.load(ids)
    this.applyGains()
  }

  /** A click on every beat of `grid` (higher on the bar), or none. */
  setClick(grid: Grid | null): void {
    const was = this.clickGrid
    this.clickGrid = grid
    this.set({ click: grid !== null })
    if (!grid) {
      this.applyGains()
      return
    }
    const changed = !was || was.bpm !== grid.bpm || was.downbeat !== grid.downbeat || was.beatsPerBar !== grid.beatsPerBar
    if (!changed) {
      this.applyGains()
      return
    }
    const rebuild = () => {
      this.clickTimer = 0
      this.clickBufferCache = null
      const context = this.context
      if (this.state.playing && context && this.state.click) {
        const when = context.currentTime + LEAD
        const click = this.clickBuffer()
        if (click) this.startOne('click', click, when, this.positionAt(when))
      }
    }
    if (!was) {
      rebuild()
      this.applyGains()
      return
    }
    // A grid being dragged changes every frame: rebuild the click at most every 120 ms. A
    // rebuild that is waiting already uses the newest grid.
    if (!this.clickTimer) this.clickTimer = window.setTimeout(rebuild, 120)
  }

  private clickBuffer(): AudioBuffer | null {
    const grid = this.clickGrid
    if (!grid || this.duration <= 0 || typeof AudioBuffer === 'undefined') return null
    if (this.clickBufferCache) return this.clickBufferCache
    const length = Math.ceil(this.duration * CLICK_RATE)
    const data = new Float32Array(length)
    const first = Math.ceil(beatAt(grid, 0))
    const last = Math.floor(beatAt(grid, this.duration))
    const n = Math.round(0.03 * CLICK_RATE)
    for (let beat = first; beat <= last && beat - first < 20000; beat++) {
      const accent = ((beat % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar === 0
      const freq = accent ? 1760 : 1175
      const start = Math.round(timeAtBeat(grid, beat) * CLICK_RATE)
      for (let i = 0; i < n && start + i < length; i++) {
        if (start + i < 0) continue
        const t = i / CLICK_RATE
        data[start + i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 160) * (accent ? 0.5 : 0.32)
      }
    }
    const buffer = new AudioBuffer({ length: Math.max(1, length), numberOfChannels: 1, sampleRate: CLICK_RATE })
    buffer.copyToChannel(data, 0)
    this.clickBufferCache = buffer
    return buffer
  }

  private applyGains(): void {
    const context = this.context
    if (!context) return
    for (const [id, gain] of this.gains) {
      gain.gain.cancelScheduledValues(context.currentTime)
      gain.gain.setTargetAtTime(this.heard(id) ? (id === 'click' ? 0.8 : 1) : 0, context.currentTime, RAMP)
    }
    // The click starts with the other tracks; switched on while playing, it joins them.
    if (this.state.click && this.state.playing && !this.sources.has('click')) {
      const click = this.clickBuffer()
      const when = context.currentTime + LEAD
      if (click) this.startOne('click', click, when, this.positionAt(when))
    }
  }

  /**
   * Stop, close the audio context and let go of every buffer. What is set again afterwards
   * (tracks, what is heard) starts over, as React's development mode does with effects.
   */
  dispose(): void {
    this.generation += 1
    this.stopAll()
    window.clearTimeout(this.clickTimer)
    this.clickTimer = 0
    for (const loaded of this.loaded.values()) loaded.abort?.abort()
    this.loaded.clear()
    this.gains.clear()
    this.clickGrid = null
    this.clickBufferCache = null
    void this.context?.close().catch(() => undefined)
    this.context = null
    this.output = null
    this.offset = 0
    this.set({ playing: false, waiting: false, loop: null, once: null, click: false, tracks: {} })
  }
}
