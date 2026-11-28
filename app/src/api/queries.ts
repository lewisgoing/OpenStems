import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type JobOptions, type Quality, type Schemas, type SettingsPatch, unwrap } from './client'
import { useEngine } from './engine'

export const keys = {
  jobs: ['jobs'] as const,
  links: ['links'] as const,
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

/** Songs being fetched from links, and the ones whose fetch failed. */
export function useLinks() {
  const { api } = useEngine()
  return useQuery({
    queryKey: keys.links,
    queryFn: async () => (await unwrap(api.GET('/v1/links'))).links,
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

export interface NewLink extends Omit<NewJobs, 'paths'> {
  url: string
}

export function useLinkActions() {
  const { api } = useEngine()
  const path = (id: string) => ({ params: { path: { link_id: id } } })
  return {
    /** Fetch the song behind a link; it is queued like a dropped file once it is here. */
    add: useMutation({
      mutationFn: (body: NewLink) =>
        unwrap(
          api.POST('/v1/links', {
            body: { url: body.url, recipe: body.recipe, model: body.model, quality: body.quality, options: body.options ?? {} },
          }),
        ),
    }),
    retry: useMutation({ mutationFn: (id: string) => unwrap(api.POST('/v1/links/{link_id}/retry', path(id))) }),
    /** Cancel a fetch, or dismiss one that failed. */
    remove: useMutation({ mutationFn: (id: string) => unwrap(api.DELETE('/v1/links/{link_id}', path(id))) }),
  }
}

/** Write some of a song's stems as one file. Resolves with where it is. */
export function useCreateMix() {
  const { api } = useEngine()
  return useMutation({ mutationFn: (paths: string[]) => unwrap(api.POST('/v1/mixes', { body: { paths } })) })
}

/** A stretch of a song to write as files: of its own file (`source`), or of some of its stems. */
export type NewClips = Schemas['CreateClips']

/**
 * Write a stretch of a song as files to drag into a DAW. Resolves with the files, written
 * now or found from before; the engine names them.
 */
export function useCreateClips() {
  const { api } = useEngine()
  return useMutation({ mutationFn: async (body: NewClips) => (await unwrap(api.POST('/v1/clips', { body }))).clips })
}

/**
 * A song's own file made playable before it is separated: a FLAC, its peaks, its length and
 * the grid detection finds. The first time for a song it takes seconds (the engine decodes
 * and analyses it), then it is found again; it never changes while the file does not.
 */
export function useSourcePreview(path: string | null) {
  const { api } = useEngine()
  return useQuery({
    queryKey: ['source-preview', path],
    enabled: Boolean(path),
    staleTime: Number.POSITIVE_INFINITY,
    // Its failures are sentences (the file is gone, it is not audio): asking again cannot help.
    retry: false,
    queryFn: () => unwrap(api.POST('/v1/sources/preview', { body: { path: path ?? '' } })),
  })
}

export function useJobActions() {
  const { api } = useEngine()
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.jobs })
  return {
    /** Start every job that is waiting for the user's Start. */
    startAll: useMutation({ mutationFn: () => unwrap(api.POST('/v1/jobs/start')) }),
    /** Start one waiting job, ahead of pressing Start for the rest. */
    start: useMutation({
      mutationFn: (id: string) => unwrap(api.POST('/v1/jobs/{job_id}/start', { params: { path: { job_id: id } } })),
    }),
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
      // Switching the GPU on or off changes the memory budget, and with it every fit.
      void queryClient.invalidateQueries({ queryKey: keys.system })
      void queryClient.invalidateQueries({ queryKey: keys.models })
      void queryClient.invalidateQueries({ queryKey: keys.recipes })
    },
  })
}

/** The tempo, key and bar 1 of a song, set by the user over what detection found. */
export function useSetAnalysis() {
  const { api } = useEngine()
  const queryClient = useQueryClient()
  type Change = { bpm?: number | null; key?: string | null; downbeat?: number | null }
  return {
    /** A job: before it runs the figures are kept for the run, after it its stems are re-tagged. */
    job: useMutation({
      mutationFn: ({ id, ...change }: Change & { id: string }) =>
        unwrap(api.POST('/v1/jobs/{job_id}/analysis', { params: { path: { job_id: id } }, body: change })),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.jobs }),
    }),
    /** Stems that are written, by their folder. */
    stemSet: useMutation({
      mutationFn: ({ directory, ...change }: Change & { directory: string }) =>
        unwrap(api.POST('/v1/stemsets/analysis', { body: { directory, ...change } })),
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: keys.jobs })
        void queryClient.invalidateQueries({ queryKey: ['stemsets'] })
      },
    }),
  }
}

/**
 * Stems of one song the user hides from the lists (true), keeps in them though they are
 * empty (false), or leaves to the setting again (null). Kept with the song, so both windows,
 * the queue and the history say the same. Resolves with the stem set as it is now.
 */
export function useSetHidden() {
  const { api } = useEngine()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ directory, stems }: { directory: string; stems: Record<string, boolean | null> }) =>
      unwrap(api.POST('/v1/stemsets/hidden', { body: { directory, stems } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.jobs })
      void queryClient.invalidateQueries({ queryKey: ['stemsets'] })
    },
  })
}

/**
 * A song's name, by the user; null gives it its file's name back. The name is the song's:
 * every row of the same file follows, and stems that are written are renamed on the disk,
 * their folder and their files. Both resolve with the song as it is now.
 */
export function useRename() {
  const { api } = useEngine()
  const queryClient = useQueryClient()
  type Job = Schemas['JobInfo']
  type StemSet = Schemas['StemSetInfo']
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.jobs })
    void queryClient.invalidateQueries({ queryKey: ['stemsets'] })
  }
  return {
    job: useMutation({
      mutationFn: ({ id, name }: { id: string; name: string | null }) =>
        unwrap(api.POST('/v1/jobs/{job_id}/name', { params: { path: { job_id: id } }, body: { name } })),
      // The row shows the new name with the answer, before the list is fetched again.
      onSuccess: (job) => {
        queryClient.setQueryData<Job[]>(keys.jobs, (list) => list?.map((other) => (other.id === job.id ? job : other)))
        refresh()
      },
    }),
    /** Stems that are written, by their folder: the answer is where they are now. */
    stemSet: useMutation({
      mutationFn: ({ directory, name }: { directory: string; name: string | null }) =>
        unwrap(api.POST('/v1/stemsets/name', { body: { directory, name } })),
      onSuccess: (set, { directory }) => {
        queryClient.setQueriesData<StemSet[]>({ queryKey: ['stemsets'] }, (list) =>
          list?.map((other) => (other.directory === directory ? set : other)),
        )
        refresh()
      },
    }),
  }
}

/** A part of a waiting song as the trimmer chose it, or null for the whole song. */
export type NewJobRange = Schemas['JobRangeRequest'] | null

/**
 * The part of a waiting song to separate alone (while the separate_selection setting is on
 * when it starts), or null to take it away. Resolves with the job, its range named by the engine.
 */
export function useSetJobRange() {
  const { api } = useEngine()
  return useMutation({
    mutationFn: ({ id, range }: { id: string; range: NewJobRange }) =>
      unwrap(api.POST('/v1/jobs/{job_id}/range', { params: { path: { job_id: id } }, body: { range } })),
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
    /** Download the model that reads chords for MIDI (230 KB); the system info then says it is there. */
    chordModel: useMutation({
      mutationFn: () => unwrap(api.POST('/v1/notes/model')),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.system }),
    }),
  }
}
