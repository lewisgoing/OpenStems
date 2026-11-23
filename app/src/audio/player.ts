/**
 * Sample-synced stem playback through Web Audio.
 *
 * Every stem is decoded into an AudioBuffer and all sources are started at the same
 * context time, so the stems stay locked together. Solo and mute are gain changes.
 */

export interface StemSource {
  name: string
  url: string
}

export interface PlayerState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  loaded: number
  total: number
  playing: boolean
  duration: number
  muted: ReadonlySet<string>
  soloed: ReadonlySet<string>
  error?: string
}

type Listener = (state: PlayerState) => void

const RAMP_SECONDS = 0.015

export class StemPlayer {
  private context: AudioContext | null = null
  private buffers = new Map<string, AudioBuffer>()
  private gains = new Map<string, GainNode>()
  private sources: AudioBufferSourceNode[] = []
  private listeners = new Set<Listener>()
  private startedAt = 0 // context time when playback (re)started
  private offset = 0 // position in the song at that moment
  private generation = 0
  private abort: AbortController | null = null
  state: PlayerState = {
    status: 'idle',
    loaded: 0,
    total: 0,
    playing: false,
    duration: 0,
    muted: new Set(),
    soloed: new Set(),
  }

  constructor(private readonly headers: Record<string, string> = {}) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }

  /** Current position in seconds. Cheap: safe to call every animation frame. */
  get position(): number {
    if (!this.context || !this.state.playing) return this.offset
    return Math.min(this.state.duration, this.offset + this.context.currentTime - this.startedAt)
  }

  async load(stems: StemSource[]): Promise<void> {
    this.dispose()
    const generation = ++this.generation
    const abort = new AbortController()
    this.abort = abort
    this.context = new AudioContext({ latencyHint: 'interactive' })
    const context = this.context
    this.set({ status: 'loading', loaded: 0, total: stems.length, muted: new Set(), soloed: new Set(), error: undefined })
    try {
      let loaded = 0
      await Promise.all(
        stems.map(async (stem) => {
          const response = await fetch(stem.url, { headers: this.headers, signal: abort.signal })
          if (!response.ok) throw new Error(`Could not load ${stem.name} (${response.status})`)
          const buffer = await context.decodeAudioData(await response.arrayBuffer())
          if (generation !== this.generation) return
          this.buffers.set(stem.name, buffer)
          const gain = context.createGain()
          gain.connect(context.destination)
          this.gains.set(stem.name, gain)
          loaded += 1
          this.set({ loaded })
        }),
      )
      if (generation !== this.generation) return
      const duration = Math.max(0, ...[...this.buffers.values()].map((b) => b.duration))
      this.set({ status: 'ready', duration })
    } catch (error) {
      if (generation !== this.generation || abort.signal.aborted) return
      this.set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  private startSources(at: number): void {
    const context = this.context
    if (!context) return
    // One shared start time keeps every stem sample-aligned.
    const when = context.currentTime + 0.03
    this.sources = []
    for (const [name, buffer] of this.buffers) {
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(this.gains.get(name)!)
      source.start(when, Math.min(at, buffer.duration))
      this.sources.push(source)
    }
    const first = this.sources[0]
    if (first) {
      first.onended = () => {
        // Only the natural end of the song lands here; stops are detached first.
        if (this.sources.includes(first) && this.position >= this.state.duration - 0.05) {
          this.stopSources()
          this.offset = 0
          this.set({ playing: false })
        }
      }
    }
    this.startedAt = when
    this.offset = at
  }

  private stopSources(): void {
    const sources = this.sources
    this.sources = []
    for (const source of sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // Already stopped.
      }
      source.disconnect()
    }
  }

  async play(): Promise<void> {
    if (this.state.status !== 'ready' || this.state.playing || !this.context) return
    await this.context.resume()
    this.startSources(this.offset >= this.state.duration - 0.05 ? 0 : this.offset)
    this.set({ playing: true })
  }

  pause(): void {
    if (!this.state.playing) return
    const position = this.position
    this.stopSources()
    this.offset = position
    this.set({ playing: false })
  }

  toggle(): void {
    if (this.state.playing) this.pause()
    else void this.play()
  }

  seek(seconds: number): void {
    const target = Math.min(Math.max(0, seconds), this.state.duration)
    if (this.state.playing) {
      this.stopSources()
      this.startSources(target)
    } else {
      this.offset = target
    }
    this.set({})
  }

  private applyGains(muted: ReadonlySet<string>, soloed: ReadonlySet<string>): void {
    const context = this.context
    if (!context) return
    for (const [name, gain] of this.gains) {
      const audible = soloed.size > 0 ? soloed.has(name) : !muted.has(name)
      gain.gain.cancelScheduledValues(context.currentTime)
      gain.gain.setTargetAtTime(audible ? 1 : 0, context.currentTime, RAMP_SECONDS)
    }
  }

  toggleMute(name: string): void {
    const muted = new Set(this.state.muted)
    if (muted.has(name)) muted.delete(name)
    else muted.add(name)
    this.applyGains(muted, this.state.soloed)
    this.set({ muted })
  }

  /** Solo one stem; with `additive`, add it to the soloed set instead. */
  toggleSolo(name: string, additive = false): void {
    let soloed = new Set(this.state.soloed)
    if (soloed.has(name)) soloed.delete(name)
    else if (additive) soloed.add(name)
    else soloed = new Set([name])
    this.applyGains(this.state.muted, soloed)
    this.set({ soloed })
  }

  isAudible(name: string): boolean {
    const { muted, soloed } = this.state
    return soloed.size > 0 ? soloed.has(name) : !muted.has(name)
  }

  dispose(): void {
    this.generation += 1
    this.abort?.abort()
    this.abort = null
    this.stopSources()
    this.buffers.clear()
    this.gains.clear()
    void this.context?.close().catch(() => undefined)
    this.context = null
    this.offset = 0
    this.state = { ...this.state, status: 'idle', playing: false, loaded: 0, total: 0, duration: 0 }
  }
}
