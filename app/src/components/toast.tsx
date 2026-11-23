import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/format'
import { Button } from './ui'

interface ToastItem {
  id: number
  kind: 'info' | 'error'
  message: string
  action?: { label: string; run: () => void }
  /** Milliseconds this toast stays up, not counting time spent paused. */
  duration: number
  leaving?: boolean
}

interface ToastApi {
  show: (message: string, options?: { kind?: ToastItem['kind']; action?: ToastItem['action'] }) => void
  error: (error: unknown) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast must be used inside <ToastProvider>')
  return api
}

const VISIBLE_MS = 5000
const EXIT_MS = 160

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), EXIT_MS)
  }, [])

  const show = useCallback<ToastApi['show']>((message, options) => {
    const id = nextId.current++
    const duration = options?.action ? VISIBLE_MS * 2 : VISIBLE_MS
    // Keep at most three: older ones leave first.
    setToasts((list) => [...list.slice(-2), { id, kind: options?.kind ?? 'info', message, action: options?.action, duration }])
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      show,
      error: (error) => show(error instanceof Error ? error.message : String(error), { kind: 'error' }),
    }),
    [show],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[70] flex flex-col items-end gap-2" aria-live="polite">
        {toasts.map((toast) => (
          <ToastView key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/**
 * One toast. Its timer only runs while it can be read and is not being reached for: it
 * pauses while the pointer is over it and while the window is hidden, and resumes with
 * the time that was left.
 */
function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false)
  const [hidden, setHidden] = useState(() => document.hidden)
  const remaining = useRef(toast.duration)

  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const paused = hovered || hidden || Boolean(toast.leaving)
  useEffect(() => {
    if (paused) return
    const started = Date.now()
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current = Math.max(0, remaining.current - (Date.now() - started))
    }
  }, [paused, toast.id, onDismiss])

  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      data-leaving={toast.leaving ? 'true' : undefined}
      data-paused={paused && !toast.leaving ? 'true' : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className={cn(
        'toast pointer-events-auto flex max-w-[min(420px,calc(100vw-32px))] items-center gap-3 rounded-[10px] border bg-raised px-3.5 py-2.5 shadow-[0_10px_30px_rgb(0_0_0/0.5)]',
        toast.kind === 'error' ? 'border-danger/40' : 'border-line-strong',
      )}
    >
      <span className="min-w-0 flex-1 break-words whitespace-pre-line">{toast.message}</span>
      {toast.action && (
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            toast.action?.run()
            onDismiss(toast.id)
          }}
        >
          {toast.action.label}
        </Button>
      )}
    </div>
  )
}
