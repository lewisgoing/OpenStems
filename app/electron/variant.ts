/**
 * Which PyTorch build the first-run setup installs, decided from the machine's video
 * adapters. Pure logic: no Node or Electron imports, so the unit tests can load it.
 *
 *   cuda   PyTorch for CUDA 13.0 (NVIDIA, GTX 16 and RTX 20 series and later). Also the
 *          fastest build on a CPU.
 *   cu126  The same PyTorch for CUDA 12.6: the last build with GTX 900 and 10 series cards
 *          in it. It cannot run a 50-series card.
 *   rocm   AMD's PyTorch-on-Windows build (ROCm), for the Radeon cards AMD supports.
 */
import type { TorchVariant } from './bridge'

export type { TorchVariant }

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'other'

export interface GpuAdapter {
  name: string
  vendor: GpuVendor
}

export interface VariantChoice {
  variant: TorchVariant
  /** The adapter the choice is based on, when there is one. */
  gpu: string | null
  /** One sentence for the setup screen. */
  note: string
}

/** Every build, in the order they are offered. */
export const VARIANTS: TorchVariant[] = ['cuda', 'cu126', 'rocm']

export const VARIANT_LABEL: Record<TorchVariant, string> = {
  cuda: 'NVIDIA',
  cu126: 'NVIDIA (older)',
  rocm: 'AMD Radeon',
}

/** Which cards a build is for, in a few words. */
export const VARIANT_CARDS: Record<TorchVariant, string> = {
  cuda: 'GTX 16 series, RTX 20 series and later',
  cu126: 'GTX 900 and 10 series, Titan V',
  rocm: 'RX 9070, 9060 XT, 7900 XTX, 7700',
}

/** Download size shown before setup starts. */
export const VARIANT_DOWNLOAD: Record<TorchVariant, string> = {
  cuda: 'about 3 GB',
  cu126: 'about 3.5 GB',
  rocm: 'about 2.5 GB, 5 GB once unpacked',
}

const VENDOR_IDS: Record<string, GpuVendor> = { '10DE': 'nvidia', '1002': 'amd', '1022': 'amd', '8086': 'intel' }

/**
 * Parse `Get-CimInstance Win32_VideoController | ConvertTo-Json`: one object, or an array.
 * Virtual and USB display adapters are dropped: only PCI devices can run a model.
 */
export function parseAdapters(json: string): GpuAdapter[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  const rows = Array.isArray(raw) ? raw : [raw]
  const adapters: GpuAdapter[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const { Name: name, PNPDeviceID: id } = row as { Name?: unknown; PNPDeviceID?: unknown }
    if (typeof name !== 'string' || typeof id !== 'string') continue
    const match = /^PCI\\VEN_([0-9A-F]{4})/i.exec(id)
    if (!match?.[1]) continue
    adapters.push({ name: name.trim(), vendor: VENDOR_IDS[match[1].toUpperCase()] ?? 'other' })
  }
  return adapters
}

/** From Chromium's GPU info, when the Windows query fails: vendor ids only, no names. */
export function adaptersFromVendorIds(devices: { vendorId: number }[]): GpuAdapter[] {
  return devices.map(({ vendorId }) => {
    const vendor = VENDOR_IDS[vendorId.toString(16).toUpperCase().padStart(4, '0')] ?? 'other'
    const name = vendor === 'nvidia' ? 'NVIDIA GPU' : vendor === 'amd' ? 'AMD GPU' : vendor === 'intel' ? 'Intel GPU' : 'GPU'
    return { name, vendor }
  })
}

/**
 * How a Radeon stands with AMD's PyTorch-on-Windows 7.2.1 build.
 *
 *   listed   named in AMD's support matrix
 *   family   same chips as a listed card (RX 7000 and 9000 desktop series), not named by AMD
 *   no       anything else: integrated graphics, RX 6000 and older
 */
export function rocmSupport(name: string): 'listed' | 'family' | 'no' {
  const n = name.replace(/\(TM\)|\(R\)|™|®/gi, '').replace(/\s+/g, ' ')
  if (/RX 9070|RX 9060 XT|R9700|RX 7900 XTX|PRO W7900|RX 7700(?! ?XT)/i.test(n)) return 'listed'
  if (/RX 90[67]0|RX 7[789]00|W7[789]00/i.test(n)) return 'family'
  return 'no'
}

/**
 * Whether an NVIDIA card needs the build for older cards. PyTorch's CUDA 13 build starts at
 * the GTX 16 and RTX 20 series; the generations before that (Maxwell, Pascal, Volta) are only
 * in the CUDA 12.6 build. A name that says nothing is taken as a current card.
 */
export function nvidiaOlder(name: string): boolean {
  const n = name.replace(/\(TM\)|\(R\)|™|®/gi, '').replace(/\s+/g, ' ')
  return (
    /GTX ?(7[45]0|9[5-8]0|10[5-8]0)/i.test(n) || // 750 (Ti), 900 series, 10 series
    /GT ?10[13]0/i.test(n) ||
    /TITAN ?(X|Xp|V)\b/i.test(n) || // not TITAN RTX
    /Quadro ?[MP]\d{3,4}/i.test(n) ||
    /MX ?(110|130|150|230|250|330|350)\b/i.test(n)
  )
}

/** Pick the build for a machine. NVIDIA wins when both vendors are present. */
export function recommendVariant(adapters: GpuAdapter[]): VariantChoice {
  const cards = adapters.filter((a) => a.vendor === 'nvidia')
  // With two NVIDIA cards, a current one decides.
  const nvidia = cards.find((a) => !nvidiaOlder(a.name)) ?? cards[0]
  if (nvidia && nvidiaOlder(nvidia.name)) {
    return {
      variant: 'cu126',
      gpu: nvidia.name,
      note: `Found ${nvidia.name}. It gets the build for older NVIDIA cards, which has not been tested on such a card by OpenStems. It needs NVIDIA driver 560 or newer.`,
    }
  }
  if (nvidia) return { variant: 'cuda', gpu: nvidia.name, note: `Found ${nvidia.name}.` }

  const radeons = adapters.filter((a) => a.vendor === 'amd')
  const rank = { listed: 0, family: 1, no: 2 }
  const best = [...radeons].sort((a, b) => rank[rocmSupport(a.name)] - rank[rocmSupport(b.name)])[0]
  if (best) {
    const support = rocmSupport(best.name)
    if (support === 'listed') {
      return {
        variant: 'rocm',
        gpu: best.name,
        note: `Found ${best.name}. AMD support is new and has not been tested on this card by OpenStems. It needs AMD driver 26.2.2 or newer.`,
      }
    }
    if (support === 'family') {
      return {
        variant: 'rocm',
        gpu: best.name,
        note: `Found ${best.name}. It is in the same family as the cards AMD supports but is not on AMD's list, so it may not work. It needs AMD driver 26.2.2 or newer.`,
      }
    }
    return {
      variant: 'cuda',
      gpu: best.name,
      note: `Found ${best.name}, which AMD's PyTorch build does not support. Separation will run on the CPU, which is much slower.`,
    }
  }
  return {
    variant: 'cuda',
    gpu: null,
    note: 'No NVIDIA or supported AMD GPU was found. Separation will run on the CPU, which is much slower.',
  }
}

export function isVariant(value: unknown): value is TorchVariant {
  return value === 'cuda' || value === 'cu126' || value === 'rocm'
}

/** The marker file written after setup: `<app version> <variant>`. Older markers hold only the version. */
export function parseMarker(text: string): { version: string; variant: TorchVariant } {
  const [version = '', variant] = text.trim().split(/\s+/)
  return { version, variant: isVariant(variant) ? variant : 'cuda' }
}

export function formatMarker(version: string, variant: TorchVariant): string {
  return `${version} ${variant}`
}
