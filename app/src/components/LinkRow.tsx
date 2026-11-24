import { AlertTriangle, RotateCcw, X } from 'lucide-react'
import type { Link } from '@/api/client'
import { useLinkActions, useLinks } from '@/api/queries'
import { cn, formatPercent } from '@/lib/format'
import { linkHost } from '@/lib/link'
import { RowMenu, linkMenuItems } from './RowMenu'
import { useToast } from './toast'
import { IconButton, ProgressBar } from './ui'

/** Links still on their way: the ones a queue has to show besides its jobs. */
export function useOpenLinks(): Link[] {
  return useLinks().data ?? []
}

export function linkStatus(link: Link): string {
  switch (link.state) {
    case 'waiting':
      return 'Waiting to fetch'
    case 'resolving':
      return `Finding the song on ${linkHost(link.url)}`
    case 'downloading':
      return `Fetching from ${linkHost(link.url)}`
    case 'failed':
      return link.error ?? 'The link could not be fetched'
  }
}

/**
 * A song that is being fetched from a link, in the place its job will take. It looks like a
 * job that is working, because to the person waiting it is one. A fetch that failed stays,
 * with the reason, until it is tried again or dismissed.
 */
export function LinkRow({ link, compact }: { link: Link; compact?: boolean }) {
  const actions = useLinkActions()
  const toast = useToast()
  const failed = link.state === 'failed'
  const fetching = link.state === 'downloading'
  const menu = linkMenuItems(link, {
    retry: () => actions.retry.mutate(link.id, { onError: toast.error }),
    remove: () => actions.remove.mutate(link.id, { onError: toast.error }),
  })
  return (
    <RowMenu
      items={menu}
      label={`${link.name} actions`}
      render={
        <li
          data-testid="link-row"
          data-state={link.state}
          className={cn(
            'group/row row-hover',
            compact ? 'mb-0.5 rounded-[10px] px-2.5 py-2' : 'row-enter relative mb-1 rounded-[10px] border border-transparent px-3 py-2.5',
          )}
        />
      }
    >
      <div className="flex items-center gap-2.5">
        {failed ? (
          <AlertTriangle size={14} className="flex-none text-danger" aria-hidden="true" />
        ) : (
          <span className="spinner flex-none" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" title={link.url}>
            {link.name}
          </div>
          <div
            className={cn('truncate text-[12px] text-muted', !compact && 'mt-0.5')}
            data-testid="link-status"
            title={failed ? (link.error ?? undefined) : undefined}
          >
            {linkStatus(link)}
          </div>
        </div>

        {compact && <LinkActions link={link} actions={actions} onError={toast.error} />}
        {fetching && <span className="tabular flex-none font-mono text-[12px] text-muted">{formatPercent(link.progress)}</span>}
        {!compact && <LinkActions link={link} actions={actions} onError={toast.error} />}
      </div>

      {!failed && (
        <div className={cn('mt-2', compact ? 'ml-[24px]' : 'ml-[26px]')}>
          <ProgressBar value={link.progress} indeterminate={!fetching || link.progress < 0.02} />
        </div>
      )}
    </RowMenu>
  )
}

function LinkActions({
  link,
  actions,
  onError,
}: {
  link: Link
  actions: ReturnType<typeof useLinkActions>
  onError: (error: unknown) => void
}) {
  const failed = link.state === 'failed'
  return (
    <div className="reveal-on-hover flex flex-none items-center">
      {failed && (
        <IconButton label="Try again" onClick={() => actions.retry.mutate(link.id, { onError })}>
          <RotateCcw size={14} />
        </IconButton>
      )}
      <IconButton label={failed ? 'Dismiss' : 'Cancel'} onClick={() => actions.remove.mutate(link.id, { onError })}>
        <X size={14} />
      </IconButton>
    </div>
  )
}
