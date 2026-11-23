/**
 * Listening to one stem at a time, for the quick-drop window: click a stem to hear it before
 * dragging it out. Only the stem that is asked for is fetched and decoded, so the first sound
 * comes quickly, and the last few decoded stems are kept so going back to one is instant.
 *
 * Switching between stems of the same song keeps the position, so the same bar can be
 * compared across stems.
 */

export interface AuditionState {
  /** The file being loaded or played, if any. */
  path: string | null
  status: 'idle' | 'loading' | 'playing'
  error?: string
}

export interface AuditionSource {
  /** The stem's file path: its identity. */
  path: string
  /** Where to fetch it. */
  url: string
  /** Stems of one song share a group, and with it the playback position. */
  group: string
}

type Listener = (state: AuditionState) => void

const KEEP = 8

export class Audition {
  state: AuditionState = { path: null, status: 'idle' }
  private context: AudioContext | null = null
  private output: GainNode | null = null
  private buffers = new Map<string, AudioBuffer>()
  private source: AudioBufferSourceNode | null = null
  private listeners = new Set<Listener>()
  private group: string | null = null
  private startedAt = 0
  private offset = 0
  private request = 0

  /** `silent` keeps everything running but sends no sound out: for automated tests. */
  constructor(
    private readonly headers: Record<string, string> = {},
    private readonly silent = false,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(state: AuditionState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }

  /** Where playback is in the current stem, in seconds. */
  private position(): number {
    if (!this.context || !this.source) return this.offset
    return this.offset + this.context.currentTime - this.startedAt
  }

  private halt(): void {
    const source = this.source
    this.source = null
    if (!source) return
    source.onended = null
    try {
      source.stop()
    } catch {
      // Already stopped.
    }
    source.disconnect()
  }

  /** Play this stem, or stop it if it is the one playing. */
  async toggle(stem: AuditionSource): Promise<void> {
    if (this.state.path === stem.path && this.state.status !== 'idle') {
      this.stop()
      return
    }
    // Another stem of the same song picks up where this one is; another song starts over.
    const resumeAt = this.source && this.group === stem.group ? this.position() : 0
    const request = ++this.request
    this.halt()
    this.group = stem.group
    this.context ??= new AudioContext({ latencyHint: 'interactive' })
    const context = this.context
    if (!this.output) {
      this.output = context.createGain()
      this.output.gain.value = this.silent ? 0 : 1
      this.output.connect(context.destination)
    }
    this.set({ path: stem.path, status: 'loading' })
    try {
      let buffer = this.buffers.get(stem.path)
      if (!buffer) {
        const response = await fetch(stem.url, { headers: this.headers })
        if (!response.ok) throw new Error(`Could not load the stem (${response.status})`)
        buffer = await context.decodeAudioData(await response.arrayBuffer())
        this.buffers.set(stem.path, buffer)
        // Decoded audio is large: keep the last few, drop the oldest.
        for (const old of [...this.buffers.keys()].slice(0, Math.max(0, this.buffers.size - KEEP))) this.buffers.delete(old)
      }
      if (request !== this.request) return // something else was clicked meanwhile
      await context.resume()
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(this.output)
      const at = resumeAt < buffer.duration - 0.05 ? resumeAt : 0
      source.onended = () => {
        if (this.source === source) this.stop()
      }
      source.start(0, at)
      this.source = source
      this.startedAt = context.currentTime
      this.offset = at
      this.set({ path: stem.path, status: 'playing' })
    } catch (error) {
      if (request !== this.request) return
      this.set({ path: null, status: 'idle', error: error instanceof Error ? error.message : String(error) })
    }
  }

  stop(): void {
    this.request += 1
    this.halt()
    this.offset = 0
    if (this.state.status !== 'idle') this.set({ path: null, status: 'idle' })
  }

  dispose(): void {
    this.stop()
    this.buffers.clear()
    void this.context?.close().catch(() => undefined)
    this.context = null
    this.output = null
  }
}
