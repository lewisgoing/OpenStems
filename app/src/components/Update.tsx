import { type ReactNode, useCallback, useEffect, useState } from 'react'
import type { ShellStatus, UpdateStatus } from '../../electron/bridge'
import { cn, formatPercent } from '@/lib/format'
import { useToast } from './toast'
import { Button, Dialog, Switch, Tooltip } from './ui'

/** Where self-update stands, kept current by the main process. Null until it has answered. */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    let live = true
    void window.openstems.updates().then((s) => {
      if (live) setStatus(s)
    })
    const off = window.openstems.onUpdateStatus(setStatus)
    return () => {
      live = false
      off()
    }
  }, [])
  return status
}

/**
 * Restarting into the new version stops the queue, so with jobs queued or running the user
 * is asked first. Returns the action and the dialog to render.
 */
function useRestart(): { restart: () => void; restarting: boolean; dialog: ReactNode } {
  const [activeJobs, setActiveJobs] = useState(0)
  // The engine takes a few seconds to stop before the installer runs: say so at once.
  const [restarting, setRestarting] = useState(false)
  const start = useCallback((force: boolean) => {
    void (force ? window.openstems.installUpdate(true) : window.openstems.installUpdate()).then((result) => {
      if (result.started) setRestarting(true)
      else if (result.activeJobs > 0) setActiveJobs(result.activeJobs)
    })
  }, [])
  const restart = useCallback(() => start(false), [start])
  const dialog = (
    <Dialog
      open={activeJobs > 0}
      onOpenChange={(open) => !open && setActiveJobs(0)}
      title="Restart while jobs are in the queue?"
      description={`${activeJobs} ${activeJobs === 1 ? 'job is' : 'jobs are'} queued or running. Restarting stops ${activeJobs === 1 ? 'it' : 'them'}; you can run ${activeJobs === 1 ? 'it' : 'them'} again afterwards.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => setActiveJobs(0)}>
            Later
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setActiveJobs(0)
              start(true)
            }}
          >
            Restart now
          </Button>
        </>
      }
    />
  )
  return { restart, restarting, dialog }
}

/**
 * The one thing the app says about a new version: a small button that takes it from
 * "available" through the download to the restart. It is absent while there is nothing new.
 * `compact` is for the quick-drop window, where the label is short: "Update 0.3.6".
 *
 * An app that cannot install the version itself (`manual`, an unsigned Mac app) has one
 * step: the button opens the download page and stays as it is.
 */
export function UpdatePill({ compact, className }: { compact?: boolean; className?: string }) {
  const status = useUpdateStatus()
  const toast = useToast()
  const { restart, restarting, dialog } = useRestart()

  // Whatever went wrong with a check or a download is said once, wherever it was started.
  const error = status?.error
  useEffect(() => {
    if (error) toast.show(error, { kind: 'error' })
  }, [error, toast])

  if (!status?.version || status.state === 'idle' || status.state === 'checking') return null
  const { version, state } = status
  const manual = Boolean(status.manual)
  const downloading = state === 'downloading' && !manual
  const ready = state === 'ready' && !manual
  const percent = formatPercent(status.progress ?? 0)

  const label = restarting
    ? 'Restarting'
    : ready
      ? compact
        ? 'Restart'
        : 'Restart to update'
      : downloading
        ? compact
          ? percent
          : `Downloading ${percent}`
        : manual
          ? `Get ${version}`
          : compact
            ? `Update ${version}`
            : `Update to ${version}`
  const hint = ready
    ? `Version ${version} is downloaded. Restarting installs it.`
    : downloading
      ? `Downloading version ${version}`
      : manual
        ? `Version ${version} is available. You have ${status.current}. This opens the download page.`
        : `Version ${version} is available. You have ${status.current}.`

  // One button from the offer to the restart: it arrives once, and after that only what it
  // says changes. While downloading it fills from the left; full, it becomes the restart.
  return (
    <>
      <Tooltip label={hint}>
        <button
          type="button"
          className={cn('update-pill pressable no-drag flex-none', className)}
          data-state={restarting ? 'restarting' : manual ? 'available' : state}
          data-compact={compact ? 'true' : undefined}
          aria-label={downloading ? `Downloading version ${version}: ${percent}` : undefined}
          disabled={downloading || restarting}
          onClick={ready ? restart : () => void window.openstems.downloadUpdate()}
        >
          {downloading && (
            <span className="update-pill-fill" style={{ transform: `scaleX(${status.progress ?? 0})` }} aria-hidden="true" />
          )}
          <span className="tabular relative">{label}</span>
        </button>
      </Tooltip>
      {dialog}
    </>
  )
}

const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** One sentence on where self-update stands, for Settings. */
export function updateSummary(status: UpdateStatus): string {
  if (!status.supported) return 'Updates are for the installed app. This one runs from the source.'
  if (status.error) return status.error
  switch (status.state) {
    case 'checking':
      return 'Checking for a new version.'
    case 'available':
      return status.manual
        ? `Version ${status.version} is available. Download it from the release page.`
        : `Version ${status.version} is available.`
    case 'downloading':
      return `Downloading version ${status.version}: ${formatPercent(status.progress ?? 0)}.`
    case 'ready':
      return `Version ${status.version} is downloaded. Restart to finish.`
    case 'idle':
      return status.checkedAt ? `Up to date. Checked at ${clock(status.checkedAt)}.` : 'Not checked yet.'
  }
}

interface RowProps {
  label: string
  hint?: ReactNode
  children: ReactNode
}

/** The Updates rows of Settings. `Row` is the settings row the view lays its other rows out with. */
export function UpdateSettings({ Row }: { Row: (props: RowProps) => ReactNode }) {
  const status = useUpdateStatus()
  const [shell, setShell] = useState<ShellStatus | null>(null)
  const { restart, restarting, dialog } = useRestart()
  useEffect(() => {
    let live = true
    void window.openstems.shellStatus().then((s) => {
      if (live) setShell(s)
    })
    return () => {
      live = false
    }
  }, [])
  if (!status) return null

  const action =
    status.state === 'ready' ? (
      <Button variant="primary" disabled={restarting} onClick={restart}>
        {restarting ? 'Restarting' : 'Restart to update'}
      </Button>
    ) : status.state === 'available' ? (
      // A manual update stays here: the same call opens the download page in the browser.
      <Button variant="primary" onClick={() => void window.openstems.downloadUpdate()}>
        {status.manual ? 'Open download page' : 'Download'}
      </Button>
    ) : status.state === 'downloading' ? (
      <Button disabled>
        <span className="spinner" />
        Downloading
      </Button>
    ) : (
      // No spinner: a check is over in a moment, and the line under the version says it is running.
      <Button disabled={!status.supported || status.state === 'checking'} onClick={() => void window.openstems.checkForUpdates()}>
        Check for updates
      </Button>
    )

  return (
    <>
      <Row label={`OpenStems ${status.current}`} hint={<span role="status">{updateSummary(status)}</span>}>
        {action}
      </Row>
      {shell && status.supported && (
        <Row label="Check automatically" hint="Looks for a new version a few times a day. Nothing is downloaded until you say so.">
          <Switch
            label="Check for updates automatically"
            checked={shell.checkForUpdates}
            onChange={(checkForUpdates) => {
              setShell({ ...shell, checkForUpdates })
              void window.openstems.setShell({ checkForUpdates }).then(setShell)
            }}
          />
        </Row>
      )}
      {dialog}
    </>
  )
}
