import { useMemo } from 'react'
import { useSettings, useSystem } from '@/api/queries'
import { type Machine, machineOf } from '@/lib/memory'

/** This machine's memory for one model run, as the engine reports it. */
export function useMachine(): Machine {
  const { data: system } = useSystem()
  const { data: settings } = useSettings()
  const useGpu = settings?.use_gpu ?? true
  return useMemo(() => machineOf(system, useGpu), [system, useGpu])
}
