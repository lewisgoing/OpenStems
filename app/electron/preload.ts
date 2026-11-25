import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EngineStatus, OpenStemsBridge, SetupStatus, UpdateStatus } from './bridge'
import { TRAFFIC_LIGHTS_INSET } from './traylogic'

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const bridge: OpenStemsBridge = {
  engine: () => ipcRenderer.invoke('engine:get'),
  onEngineStatus: (listener) => subscribe<EngineStatus>('engine:status', listener),
  restartEngine: () => ipcRenderer.invoke('engine:restart'),
  setup: () => ipcRenderer.invoke('setup:get'),
  detectGpu: () => ipcRenderer.invoke('setup:detect'),
  runSetup: (variant) => ipcRenderer.invoke('setup:run', variant),
  switchBuild: (variant) => ipcRenderer.invoke('setup:switch', variant),
  onSetupStatus: (listener) => subscribe<SetupStatus>('setup:status', listener),
  // With context isolation on, the real path of a dropped File is only available here.
  pathsForFiles: (files) => files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  startDrag: (paths) => ipcRenderer.send('drag:start', paths),
  clipboardText: () => ipcRenderer.invoke('clipboard:read'),
  revealInExplorer: (path) => ipcRenderer.invoke('shell:reveal', path),
  openFolder: (path) => ipcRenderer.invoke('shell:open-folder', path),
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pick-folder', defaultPath),
  folderSpace: (path) => ipcRenderer.invoke('fs:space', path),
  pickFile: (options) => ipcRenderer.invoke('dialog:pick-file', options),
  showMain: () => ipcRenderer.invoke('main:show'),
  hidePopup: (viaKeyboard) => ipcRenderer.send('popup:hide', viaKeyboard === true),
  reportActivity: (activity) => ipcRenderer.send('tray:activity', activity),
  shellStatus: () => ipcRenderer.invoke('shell:get'),
  setShell: (patch) => ipcRenderer.invoke('shell:set', patch),
  updates: () => ipcRenderer.invoke('update:get'),
  onUpdateStatus: (listener) => subscribe<UpdateStatus>('update:status', listener),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: (force) => ipcRenderer.invoke('update:install', force === true),
  info: {
    version: process.env.OPENSTEMS_APP_VERSION ?? '0.0.0',
    platform: process.platform,
    e2e: process.env.OPENSTEMS_E2E === '1',
    welcome: process.env.OPENSTEMS_E2E === '1' && process.env.OPENSTEMS_E2E_WELCOME === '1',
  },
}

contextBridge.exposeInMainWorld('openstems', bridge)

// The full window on a Mac: its three buttons sit in the page's own title bar, at the left.
// The page reads how much room they take from a CSS variable, and nothing in full screen,
// where macOS hides them. The quick-drop window has no such buttons.
if (process.platform === 'darwin' && !new URLSearchParams(location.search).has('window')) {
  let inset = TRAFFIC_LIGHTS_INSET
  const apply = () => document.documentElement?.style.setProperty('--traffic-lights-inset', `${inset}px`)
  ipcRenderer.on('window:traffic-lights', (_event, value: number) => {
    inset = value
    apply()
  })
  // The preload runs before the page has a root element.
  if (document.documentElement) apply()
  document.addEventListener('DOMContentLoaded', apply)
  // Settings in the application menu. The page listens for the event on `window`. A page
  // that is still loading has no listener yet: the mark on the root element is what it
  // reads once it is up.
  ipcRenderer.on('menu:settings', () => {
    if (document.documentElement) document.documentElement.dataset.openView = 'settings'
    window.dispatchEvent(new Event('openstems:settings'))
  })
}
