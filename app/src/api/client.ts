import createClient from 'openapi-fetch'
import type { components, paths } from './schema'

export type Schemas = components['schemas']
export type Job = Schemas['JobInfo']
export type JobState = Job['state']
export type StemFile = Schemas['StemFile']
/** A song on its way from a link to the queue. */
export type Link = Schemas['LinkInfo']
export type Mix = Schemas['MixInfo']
export type Recipe = Schemas['RecipeInfo']
export type Model = Schemas['ModelInfo']
export type Settings = Schemas['SettingsModel']
export type SettingsPatch = Schemas['SettingsPatch']
export type StemSet = Schemas['StemSetInfo']
export type SystemInfo = Schemas['SystemInfo']
export type Peaks = Schemas['Peaks']
export type Quality = 'fast' | 'balanced' | 'best'
export type JobOptions = Schemas['JobOptions']

export interface Connection {
  baseUrl: string
  token: string
}

export type Api = ReturnType<typeof makeApi>

export function makeApi(connection: Connection) {
  return createClient<paths>({
    baseUrl: connection.baseUrl,
    headers: { Authorization: `Bearer ${connection.token}` },
  })
}

/** URL of an output file, for fetch() by the audio player. */
export function fileUrl(connection: Connection, path: string): string {
  return `${connection.baseUrl}/v1/files?path=${encodeURIComponent(path)}`
}

export function eventsUrl(connection: Connection): string {
  const url = new URL(`${connection.baseUrl}/v1/events`)
  url.protocol = 'ws:'
  url.searchParams.set('token', connection.token)
  return url.toString()
}

export class ApiError extends Error {}

/** openapi-fetch returns `{ data, error }`; turn that into a value or a thrown ApiError. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call
  if (error !== undefined || data === undefined) {
    throw new ApiError(describeError(error) ?? `Request failed (${response.status})`)
  }
  return data
}

function describeError(error: unknown): string | null {
  if (error && typeof error === 'object' && 'detail' in error) {
    const detail = (error as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) {
      return detail.map((d) => (d && typeof d === 'object' && 'msg' in d ? String(d.msg) : String(d))).join('; ')
    }
  }
  return null
}
