import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, createContext, useContext, useEffect, useMemo, useRef } from 'react'
import { type Api, type Connection, type Job, type Link, type Schemas, eventsUrl, makeApi } from './client'
import { keys } from './queries'

interface Engine {
  api: Api
  connection: Connection
}

const EngineContext = createContext<Engine | null>(null)

export function useEngine(): Engine {
  const engine = useContext(EngineContext)
  if (!engine) throw new Error('useEngine must be used inside <EngineProvider>')
  return engine
}

type EngineEvent =
  | { type: 'snapshot'; jobs: Job[]; links?: Link[] }
  | { type: 'link.updated'; link: Link }
  | { type: 'link.removed'; id: string }
  | { type: 'job.updated'; job: Job }
  | { type: 'job.progress'; id: string; state: Job['state']; progress: number; message: string }
  | { type: 'job.removed'; id: string }
  | { type: 'jobs.order'; ids: string[] }
  | { type: 'model.progress'; id: string; state: NonNullable<Schemas['ModelInfo']['download']>['state']; done: number; total: number; error?: string | null }
  | { type: 'models.changed' | 'settings.changed' | 'stemsets.changed' | 'worker.status' }
  | { type: 'notice'; level: 'info' | 'error'; message: string }

interface EngineProviderProps {
  connection: Connection
  children: ReactNode
  onNotice?: (message: string, level: 'info' | 'error') => void
}

export function EngineProvider({ connection, children, onNotice }: EngineProviderProps) {
  const notice = useRef(onNotice)
  notice.current = onNotice
  const api = useMemo(() => makeApi(connection), [connection])
  const queryClient = useQueryClient()

  // One WebSocket carries everything; it keeps the query cache current.
  useEffect(() => {
    let socket: WebSocket | null = null
    let closed = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const setJobs = (update: (jobs: Job[]) => Job[]) =>
      queryClient.setQueryData<Job[]>(keys.jobs, (jobs) => update(jobs ?? []))

    const setLinks = (update: (links: Link[]) => Link[]) =>
      queryClient.setQueryData<Link[]>(keys.links, (links) => update(links ?? []))

    const handle = (event: EngineEvent) => {
      switch (event.type) {
        case 'snapshot':
          queryClient.setQueryData(keys.jobs, event.jobs)
          queryClient.setQueryData(keys.links, event.links ?? [])
          break
        case 'link.updated':
          setLinks((links) =>
            links.some((l) => l.id === event.link.id)
              ? links.map((l) => (l.id === event.link.id ? event.link : l))
              : [...links, event.link],
          )
          break
        case 'link.removed':
          setLinks((links) => links.filter((l) => l.id !== event.id))
          break
        case 'job.updated':
          setJobs((jobs) =>
            jobs.some((j) => j.id === event.job.id)
              ? jobs.map((j) => (j.id === event.job.id ? event.job : j))
              : [...jobs, event.job],
          )
          break
        case 'job.progress':
          setJobs((jobs) =>
            jobs.map((j) =>
              j.id === event.id
                ? { ...j, state: event.state, progress: event.progress, message: event.message }
                : j,
            ),
          )
          break
        case 'job.removed':
          setJobs((jobs) => jobs.filter((j) => j.id !== event.id))
          break
        case 'jobs.order':
          setJobs((jobs) => {
            const byId = new Map(jobs.map((j) => [j.id, j]))
            return event.ids.flatMap((id) => byId.get(id) ?? [])
          })
          void queryClient.invalidateQueries({ queryKey: keys.jobs })
          break
        case 'model.progress':
          // Progress arrives several times a second: patch the cache, do not refetch.
          queryClient.setQueryData<Schemas['ModelList']>(keys.models, (list) =>
            list && {
              ...list,
              models: list.models.map((m) =>
                m.id === event.id
                  ? { ...m, download: { state: event.state, done: event.done, total: event.total, error: event.error } }
                  : m,
              ),
            },
          )
          break
        case 'models.changed':
          void queryClient.invalidateQueries({ queryKey: keys.models })
          void queryClient.invalidateQueries({ queryKey: keys.recipes })
          break
        case 'settings.changed':
          void queryClient.invalidateQueries({ queryKey: keys.settings })
          // The other window may have switched the GPU off: the memory budget follows.
          void queryClient.invalidateQueries({ queryKey: keys.system })
          break
        case 'stemsets.changed':
          void queryClient.invalidateQueries({ queryKey: ['stemsets'] })
          break
        case 'worker.status':
          void queryClient.invalidateQueries({ queryKey: keys.system })
          break
        case 'notice':
          notice.current?.(event.message, event.level)
          break
      }
    }

    const connect = () => {
      socket = new WebSocket(eventsUrl(connection))
      socket.onopen = () => {
        attempt = 0
      }
      socket.onmessage = (message) => {
        try {
          handle(JSON.parse(String(message.data)) as EngineEvent)
        } catch {
          // Ignore malformed events.
        }
      }
      socket.onclose = () => {
        if (closed) return
        attempt += 1
        retry = setTimeout(connect, Math.min(250 * 2 ** attempt, 4000))
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(retry)
      socket?.close()
    }
  }, [connection, queryClient])

  const value = useMemo(() => ({ api, connection }), [api, connection])
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>
}
