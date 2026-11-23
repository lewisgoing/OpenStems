import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../../electron/bridge'
import { DEFAULT_PREFS, parsePrefs } from '../../electron/traylogic'
import { type UpdateBackend, Updater, fakeBackend } from '../../electron/updatelogic'
import { ToastProvider } from '@/components/toast'
import { TooltipProvider } from '@/components/ui'
import { UpdatePill, UpdateSettings, updateSummary } from '@/components/Update'
import { bridge } from './setup'

/* ---- the state machine in the main process -------------------------------------- */

function updater(backend: Partial<UpdateBackend> | null, beforeInstall = vi.fn(async () => undefined)) {
  const full: UpdateBackend | null = backend && {
    check: async () => '0.3.0',
    download: async (onProgress) => onProgress(1),
    install: vi.fn(),
    ...backend,
  }
  const instance = new Updater({ current: '0.2.0', backend: full, beforeInstall })
  const seen: UpdateStatus['state'][] = []
  instance.onStatus((status) => seen.push(status.state))
  return { instance, seen, backend: full, beforeInstall }
}

describe('the updater', () => {
  it('finds a newer version and waits to be told to download it', async () => {
    const { instance, seen } = updater({})
    expect(instance.status).toEqual({ state: 'idle', current: '0.2.0', supported: true })
    const status = await instance.check()
    expect(status).toMatchObject({ state: 'available', version: '0.3.0', current: '0.2.0' })
    expect(status.checkedAt).toBeTypeOf('number')
    expect(seen).toEqual(['checking', 'available'])
  })

  it('says so when this version is the newest', async () => {
    const { instance } = updater({ check: async () => null })
    expect(await instance.check()).toMatchObject({ state: 'idle', version: undefined })
    expect(instance.status.checkedAt).toBeTypeOf('number')
  })

  it('downloads with progress, then is ready to restart', async () => {
    const progress: (number | undefined)[] = []
    const { instance } = updater(fakeBackend('0.3.0', () => undefined, 1))
    instance.onStatus((status) => status.state === 'downloading' && progress.push(status.progress))
    await instance.check()
    expect(await instance.download()).toMatchObject({ state: 'ready', version: '0.3.0', progress: 1 })
    expect(progress).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('stays quiet when a check it made by itself fails, and speaks up when the user asked', async () => {
    const { instance } = updater({ check: async () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')) })
    expect(await instance.check()).toMatchObject({ state: 'idle', error: undefined })
    expect(await instance.check(true)).toMatchObject({ state: 'idle', error: 'Could not check for updates. Is this PC online?' })
  })

  it('keeps a version it already found when a later check fails', async () => {
    let online = true
    const { instance } = updater({ check: async () => (online ? '0.3.0' : Promise.reject(new Error('offline'))) })
    await instance.check()
    online = false
    expect(await instance.check()).toMatchObject({ state: 'available', version: '0.3.0' })
  })

  it('goes back to "available" when a download fails', async () => {
    const { instance } = updater({ download: async () => Promise.reject(new Error('sha512 mismatch')) })
    await instance.check()
    expect(await instance.download()).toMatchObject({
      state: 'available',
      version: '0.3.0',
      error: 'The download did not finish. Try again.',
    })
  })

  it('does not download before a version is found, or check over a version that is ready', async () => {
    const check = vi.fn(async () => '0.3.0')
    const download = vi.fn(async () => undefined)
    const { instance } = updater({ check, download })
    await instance.download()
    expect(download).not.toHaveBeenCalled()
    await instance.check()
    await instance.download()
    await instance.check()
    expect(check).toHaveBeenCalledTimes(1)
    expect(instance.status.state).toBe('ready')
  })

  it('installs only a downloaded version, after everything of the app has stopped', async () => {
    const order: string[] = []
    const { instance } = updater(
      { install: () => order.push('install') },
      vi.fn(async () => {
        order.push('stopped')
      }),
    )
    expect(await instance.install()).toBe(false)
    await instance.check()
    expect(await instance.install()).toBe(false)
    await instance.download()
    expect(await instance.install()).toBe(true)
    expect(order).toEqual(['stopped', 'install'])
  })

  it('does nothing where the app cannot update itself', async () => {
    const { instance } = updater(null)
    expect(instance.status.supported).toBe(false)
    expect((await instance.check(true)).state).toBe('idle')
    expect((await instance.download()).state).toBe('idle')
    expect(await instance.install()).toBe(false)
  })

  it('checks by default, and remembers when that is turned off', () => {
    expect(DEFAULT_PREFS.checkForUpdates).toBe(true)
    expect(parsePrefs('{"checkForUpdates": false}').checkForUpdates).toBe(false)
  })
})

/* ---- what the user sees ------------------------------------------------------------- */

const status = (patch: Partial<UpdateStatus>): UpdateStatus => ({ state: 'idle', current: '0.2.0', supported: true, ...patch })

function tree(children: ReactNode) {
  return (
    <TooltipProvider>
      <ToastProvider>{children}</ToastProvider>
    </TooltipProvider>
  )
}

/** Push a new status the way the main process does. */
function push(next: UpdateStatus) {
  const listener = bridge.onUpdateStatus.mock.calls.at(-1)?.[0]
  act(() => listener?.(next))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the update button', () => {
  it('is absent while there is nothing new', async () => {
    const { container } = render(tree(<UpdatePill />))
    await act(async () => undefined)
    expect(container.querySelector('.update-pill')).toBeNull()
    push(status({ state: 'checking' }))
    expect(container.querySelector('.update-pill')).toBeNull()
  })

  it('offers the new version, shows the download, then offers the restart', async () => {
    bridge.updates.mockResolvedValueOnce(status({ state: 'available', version: '0.3.0' }))
    render(tree(<UpdatePill />))
    fireEvent.click(await screen.findByRole('button', { name: 'Update to 0.3.0' }))
    expect(bridge.downloadUpdate).toHaveBeenCalled()

    // The same button carries the download: it cannot be pressed, and it fills as it goes.
    const pill = screen.getByRole('button')
    push(status({ state: 'downloading', version: '0.3.0', progress: 0.42 }))
    expect(screen.getByRole('button')).toBe(pill)
    expect(pill).toBeDisabled()
    expect(pill).toHaveTextContent('Downloading 42%')
    expect(pill).toHaveAccessibleName('Downloading version 0.3.0: 42%')
    expect(pill.querySelector('.update-pill-fill')).toHaveStyle({ transform: 'scaleX(0.42)' })

    push(status({ state: 'ready', version: '0.3.0', progress: 1 }))
    expect(screen.getByRole('button', { name: 'Restart to update' })).toBe(pill)
    await act(async () => {
      fireEvent.click(pill)
    })
    expect(bridge.installUpdate).toHaveBeenLastCalledWith()
    // The engine takes a moment to stop: the press is answered at once.
    expect(pill).toHaveTextContent('Restarting')
    expect(pill).toBeDisabled()
  })

  it('asks before a restart that would stop the queue', async () => {
    bridge.updates.mockResolvedValueOnce(status({ state: 'ready', version: '0.3.0' }))
    bridge.installUpdate.mockResolvedValueOnce({ started: false, activeJobs: 2 })
    render(tree(<UpdatePill />))
    const restart = await screen.findByRole('button', { name: 'Restart to update' })
    await act(async () => {
      fireEvent.click(restart)
    })
    expect(await screen.findByText(/2 jobs are queued or running/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }))
    expect(bridge.installUpdate).toHaveBeenLastCalledWith(true)
  })

  it('uses one word in the quick-drop window', async () => {
    bridge.updates.mockResolvedValueOnce(status({ state: 'available', version: '0.3.0' }))
    render(tree(<UpdatePill compact />))
    expect(await screen.findByRole('button', { name: 'Update' })).toBeInTheDocument()
    push(status({ state: 'downloading', version: '0.3.0', progress: 0.5 }))
    expect(screen.getByRole('button')).toHaveTextContent('50%')
    push(status({ state: 'ready', version: '0.3.0' }))
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
  })

  it('says what went wrong, once', async () => {
    bridge.updates.mockResolvedValueOnce(status({ state: 'available', version: '0.3.0' }))
    render(tree(<UpdatePill />))
    await screen.findByRole('button', { name: 'Update to 0.3.0' })
    push(status({ state: 'available', version: '0.3.0', error: 'The download did not finish. Try again.' }))
    expect(screen.getByRole('alert')).toHaveTextContent('The download did not finish. Try again.')
  })
})

describe('the update summary', () => {
  it('is one sentence per state', () => {
    expect(updateSummary(status({}))).toBe('Not checked yet.')
    expect(updateSummary(status({ checkedAt: Date.now() }))).toMatch(/^Up to date\. Checked at /)
    expect(updateSummary(status({ state: 'checking' }))).toBe('Checking for a new version.')
    expect(updateSummary(status({ state: 'available', version: '0.3.0' }))).toBe('Version 0.3.0 is available.')
    expect(updateSummary(status({ state: 'downloading', version: '0.3.0', progress: 0.5 }))).toBe('Downloading version 0.3.0: 50%.')
    expect(updateSummary(status({ state: 'ready', version: '0.3.0' }))).toBe('Version 0.3.0 is downloaded. Restart to finish.')
    expect(updateSummary(status({ error: 'Could not check for updates. Is this PC online?' }))).toMatch(/online/)
    expect(updateSummary(status({ supported: false }))).toMatch(/installed app/)
  })
})

describe('the update settings', () => {
  const Row = ({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) => (
    <div>
      <div>{label}</div>
      <div>{hint}</div>
      {children}
    </div>
  )

  it('checks on request and follows the result', async () => {
    bridge.updates.mockResolvedValueOnce(status({}))
    render(tree(<UpdateSettings Row={Row} />))
    expect(await screen.findByText('OpenStems 0.2.0')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Not checked yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(bridge.checkForUpdates).toHaveBeenCalled()

    push(status({ state: 'available', version: '0.3.0' }))
    expect(screen.getByRole('status')).toHaveTextContent('Version 0.3.0 is available.')
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(bridge.downloadUpdate).toHaveBeenCalled()

    push(status({ state: 'ready', version: '0.3.0' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }))
    })
    expect(bridge.installUpdate).toHaveBeenCalled()
  })

  it('saves whether to check automatically', async () => {
    render(tree(<UpdateSettings Row={Row} />))
    const auto = await screen.findByRole('switch', { name: 'Check for updates automatically' })
    expect(auto).toBeChecked()
    await act(async () => {
      fireEvent.click(auto)
    })
    expect(bridge.setShell).toHaveBeenLastCalledWith({ checkForUpdates: false })
  })

  it('explains itself where the app cannot update', async () => {
    bridge.updates.mockResolvedValueOnce(status({ supported: false }))
    render(tree(<UpdateSettings Row={Row} />))
    expect(await screen.findByRole('button', { name: 'Check for updates' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(/installed app/)
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })
})
