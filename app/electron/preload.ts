import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EngineStatus, OpenStemsBridge, SetupStatus, UpdateStatus } from './bridge'

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
  revealInExplorer: (path) => ipcRenderer.invoke('shell:reveal', path),
  openFolder: (path) => ipcRenderer.invoke('shell:open-folder', path),
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pick-folder', defaultPath),
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
  },
}

contextBridge.exposeInMainWorld('openstems', bridge)
