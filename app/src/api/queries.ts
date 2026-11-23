import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type JobOptions, type Quality, type SettingsPatch, unwrap } from './client'
import { useEngine } from './engine'

export const keys = {
  jobs: ['jobs'] as const,
  recipes: ['recipes'] as const,
  models: ['models'] as const,
  settings: ['settings'] as const,
  system: ['system'] as const,
  stemsets: (query: string) => ['stemsets', query] as const,
}

export function useJobs() {
  const { api } = useEngine()
  return useQuery({
    queryKey: keys.jobs,
    queryFn: async () => (await unwrap(api.GET('/v1/jobs'))).jobs,
    staleTime: Number.POSITIVE_INFINITY, // the WebSocket keeps this current
  })
}

export function useRecipes() {
  const { api } = useEngine()
  return useQuery({
    queryKey: keys.recipes,
    queryFn: async () => (await unwrap(api.GET('/v1/recipes'))).recipes,
  })
}

export function useModels() {
  const { api } = useEngine()
  return useQuery({ queryKey: keys.models, queryFn: () => unwrap(api.GET('/v1/models')) })
}

export function useSettings() {
  const { api } = useEngine()
  return useQuery({ queryKey: keys.settings, queryFn: () => unwrap(api.GET('/v1/settings')) })
}

export function useSystem() {
  const { api } = useEngine()
  return useQuery({ queryKey: keys.system, queryFn: () => unwrap(api.GET('/v1/system')) })
}

export function useStemSets(query: string) {
  const { api } = useEngine()
  return useQuery({
    queryKey: keys.stemsets(query),
    queryFn: async () =>
      (await unwrap(api.GET('/v1/stemsets', { params: { query: { q: query } } }))).stem_sets,
    placeholderData: (previous) => previous,
  })
}

export interface NewJobs {
  paths: string[]
  recipe?: string
  model?: string
  quality?: Quality
  options?: JobOptions
}

export function useCreateJobs() {
  const { api } = useEngine()
  return useMutation({
    mutationFn: async (body: NewJobs) =>
      (
        await unwrap(
          api.POST('/v1/jobs/batch', {
            body: { paths: body.paths, recipe: body.recipe, model: body.model, quality: body.quality, options: body.options ?? {} },
          }),
        )
      ).jobs,
  })
}

export function useJobActions() {
  const { api } = useEngine()
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.jobs })
  return {
    cancel: useMutation({
      mutationFn: (id: string) => unwrap(api.POST('/v1/jobs/{job_id}/cancel', { params: { path: { job_id: id } } })),
    }),
    retry: useMutation({
      mutationFn: (id: string) => unwrap(api.POST('/v1/jobs/{job_id}/retry', { params: { path: { job_id: id } } })),
    }),
    remove: useMutation({
      mutationFn: (id: string) => unwrap(api.DELETE('/v1/jobs/{job_id}', { params: { path: { job_id: id } } })),
    }),
    reorder: useMutation({
      mutationFn: (ids: string[]) => unwrap(api.POST('/v1/jobs/reorder', { body: { ids } })),
      onError: refresh,
    }),
    clearFinished: useMutation({
      mutationFn: () => unwrap(api.POST('/v1/jobs/clear-finished')),
      onSuccess: refresh,
    }),
  }
}

export function useModelActions() {
  const { api } = useEngine()
  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.models })
    void queryClient.invalidateQueries({ queryKey: keys.recipes })
  }
  const path = (id: string) => ({ params: { path: { model_id: id } } })
  return {
    pull: useMutation({
      mutationFn: (id: string) => unwrap(api.POST('/v1/models/{model_id}/pull', path(id))),
      onSuccess: refresh,
    }),
    cancel: useMutation({
      mutationFn: (id: string) => unwrap(api.POST('/v1/models/{model_id}/cancel', path(id))),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => unwrap(api.DELETE('/v1/models/{model_id}', path(id))),
      onSuccess: refresh,
    }),
    verify: useMutation({
      mutationFn: (id: string) => unwrap(api.POST('/v1/models/{model_id}/verify', path(id))),
      onSuccess: refresh,
    }),
    importModel: useMutation({
      mutationFn: (body: { checkpoint: string; config: string; architecture: 'bs_roformer' | 'mel_band_roformer' | 'mdx23c'; name?: string }) =>
        unwrap(api.POST('/v1/models/import', { body: { ...body, acknowledge_pickle_risk: true } })),
      onSuccess: refresh,
    }),
  }
}

export function usePatchSettings() {
  const { api } = useEngine()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: SettingsPatch) => unwrap(api.PATCH('/v1/settings', { body: patch })),
    onSuccess: (settings) => {
      queryClient.setQueryData(keys.settings, settings)
      void queryClient.invalidateQueries({ queryKey: keys.models })
      void queryClient.invalidateQueries({ queryKey: keys.recipes })
    },
  })
}

export function useMaintenance() {
  const { api } = useEngine()
  const queryClient = useQueryClient()
  return {
    rebuildIndex: useMutation({
      mutationFn: () => unwrap(api.POST('/v1/stemsets/rebuild')),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['stemsets'] }),
    }),
    exportDiagnostics: useMutation({ mutationFn: () => unwrap(api.POST('/v1/diagnostics')) }),
    selfTest: useMutation({ mutationFn: () => unwrap(api.POST('/v1/selftest')) }),
  }
}
