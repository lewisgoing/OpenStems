import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import type { OpenStemsBridge, SetupStatus, ShellStatus, TorchVariant, TrayActivity, UpdateStatus } from '../../electron/bridge'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const setupStatus: SetupStatus = {
  state: 'ready',
  log: [],
  managed: false,
  variant: 'cuda',
  installed: null,
  detected: true,
  gpus: [],
  note: '',
}

const shellStatus: ShellStatus = {
  closeToTray: true,
  checkForUpdates: true,
  notifyReady: true,
  startAtLogin: false,
  canStartAtLogin: true,
}
const updateStatus: UpdateStatus = { state: 'idle', current: '0.0.0-test', supported: true }

/** A stand-in for the preload bridge. Tests read `window.openstems.startDrag.mock.calls`. */
export const bridge = {
  engine: vi.fn(async () => ({ state: 'ready' as const, baseUrl: 'http://127.0.0.1:1', token: 't' })),
  onEngineStatus: vi.fn(() => () => undefined),
  restartEngine: vi.fn(async () => undefined),
  setup: vi.fn(async (): Promise<SetupStatus> => setupStatus),
  detectGpu: vi.fn(async (): Promise<SetupStatus> => setupStatus),
  runSetup: vi.fn(async (_variant?: TorchVariant) => undefined),
  switchBuild: vi.fn(async (_variant: TorchVariant) => undefined),
  onSetupStatus: vi.fn(() => () => undefined),
  pathsForFiles: vi.fn((files: File[]) => files.map((f) => `C:/in/${f.name}`)),
  startDrag: vi.fn(),
  clipboardText: vi.fn(async () => ''),
  revealInExplorer: vi.fn(async () => undefined),
  openFolder: vi.fn(async () => undefined),
  pickFolder: vi.fn(async () => null),
  pickFile: vi.fn(async () => null),
  showMain: vi.fn(async () => undefined),
  hidePopup: vi.fn((_viaKeyboard?: boolean) => undefined),
  reportActivity: vi.fn((_activity: TrayActivity) => undefined),
  shellStatus: vi.fn(async (): Promise<ShellStatus> => shellStatus),
  setShell: vi.fn(async (patch: Partial<ShellStatus>): Promise<ShellStatus> => ({ ...shellStatus, ...patch })),
  updates: vi.fn(async (): Promise<UpdateStatus> => updateStatus),
  onUpdateStatus: vi.fn((_listener: (status: UpdateStatus) => void) => () => undefined),
  checkForUpdates: vi.fn(async (): Promise<UpdateStatus> => updateStatus),
  downloadUpdate: vi.fn(async (): Promise<UpdateStatus> => updateStatus),
  installUpdate: vi.fn(async (_force?: boolean) => ({ started: true, activeJobs: 0 })),
  info: { version: '0.0.0-test', platform: 'win32', e2e: false },
} satisfies OpenStemsBridge

window.openstems = bridge

// jsdom has no ResizeObserver or canvas context.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
