import { useEffect, useMemo, useState } from 'react'
import type { EngineStatus, SetupStatus } from '../../electron/bridge'
import type { Connection } from './client'

const SETUP_READY: SetupStatus = {
  state: 'ready',
  log: [],
  managed: false,
  variant: 'cuda',
  installed: null,
  detected: false,
  gpus: [],
  note: '',
}

/** The engine and first-run setup as the main process reports them, kept current. */
export function useEngineStatus(): { engine: EngineStatus; setup: SetupStatus; connection: Connection | null } {
  const [engine, setEngine] = useState<EngineStatus>({ state: 'starting', detail: 'Starting the engine' })
  const [setup, setSetup] = useState<SetupStatus>(SETUP_READY)

  useEffect(() => {
    void window.openstems.engine().then(setEngine)
    void window.openstems.setup().then(setSetup)
    const offEngine = window.openstems.onEngineStatus(setEngine)
    const offSetup = window.openstems.onSetupStatus(setSetup)
    return () => {
      offEngine()
      offSetup()
    }
  }, [])

  const connection = useMemo(
    () => (engine.state === 'ready' ? { baseUrl: engine.baseUrl, token: engine.token } : null),
    [engine],
  )
  return { engine, setup, connection }
}
