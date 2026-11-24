import type { TrimPlayerState, TrimTrack } from '@/audio/trimplayer'
import type { Grid, Range } from '@/lib/grid'

/**
 * A stand-in for the trimmer's player: jsdom has no Web Audio. Tests mock
 * `@/audio/trimplayer` with this module and read what the editor asked of it.
 */
export class TrimPlayer {
  /** The player the editor made last. */
  static last: TrimPlayer | null = null
  state: TrimPlayerState = { playing: false, waiting: false, loop: null, once: null, audible: [], click: false, tracks: {} }
  position = 0
  tracks: TrimTrack[] = []
  clickGrid: Grid | null = null
  private listeners = new Set<() => void>()

  constructor() {
    TrimPlayer.last = this
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<TrimPlayerState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** For tests: say how far the tracks are, as decoding would. */
  markTracks(tracks: TrimPlayerState['tracks']): void {
    this.set({ tracks })
  }

  setDuration(_seconds: number): void {}

  setTracks(tracks: TrimTrack[]): void {
    this.tracks = tracks
  }

  buffer(_id: string): AudioBuffer | null {
    return null
  }

  load(_ids: string[]): void {}

  setAudible(ids: string[]): void {
    this.set({ audible: [...ids] })
  }

  setClick(grid: Grid | null): void {
    this.clickGrid = grid
    this.set({ click: grid !== null })
  }

  setLoop(range: Range | null): void {
    this.set({ loop: range, once: null })
  }

  play(): void {
    this.set({ playing: true })
  }

  playRange(range: Range, loop: boolean): void {
    this.set({ playing: true, loop: loop ? range : null, once: loop ? null : range })
  }

  pause(): void {
    this.set({ playing: false })
  }

  toggle(): void {
    if (this.state.playing) this.pause()
    else this.play()
  }

  seek(t: number): void {
    this.position = t
    this.set({})
  }

  dispose(): void {}
}
