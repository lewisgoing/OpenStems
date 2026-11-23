import { fireEvent, render, screen } from '@testing-library/react'
import type { SetupStatus } from '../../electron/bridge'
import {
  adaptersFromVendorIds,
  formatMarker,
  parseAdapters,
  parseMarker,
  recommendVariant,
  rocmSupport,
} from '../../electron/variant'
import { SetupScreen } from '@/App'
import { TooltipProvider } from '@/components/ui'
import { EngineBuildRow, gpuHint, selfTestLines } from '@/views/SettingsView'
import { bridge } from './setup'

// What Windows reports on the development machine: a virtual adapter, an integrated Radeon,
// the NVIDIA card, and two USB display adapters.
const DEV_MACHINE = JSON.stringify([
  { Name: 'SudoMaker Virtual Display Adapter', PNPDeviceID: 'ROOT\\DISPLAY\\0000' },
  { Name: 'AMD Radeon(TM) Graphics', PNPDeviceID: 'PCI\\VEN_1002&DEV_13C0&SUBSYS_88771043&REV_E6\\4&1EBE6A9C&0&0041' },
  { Name: 'NVIDIA GeForce RTX 5070 Ti', PNPDeviceID: 'PCI\\VEN_10DE&DEV_2C05&SUBSYS_89F71043&REV_A1\\57274753862DB04800' },
  { Name: 'DisplayLink USB Device', PNPDeviceID: 'USB\\VID_17E9&PID_430F&MI_01\\A&54946CD&0&0001' },
])
const amd = (name: string) => ({ name, vendor: 'amd' as const })

describe('video adapters', () => {
  it('keeps PCI devices and reads the vendor from the device id', () => {
    expect(parseAdapters(DEV_MACHINE)).toEqual([
      { name: 'AMD Radeon(TM) Graphics', vendor: 'amd' },
      { name: 'NVIDIA GeForce RTX 5070 Ti', vendor: 'nvidia' },
    ])
  })

  it('reads a single adapter, which PowerShell prints as one object', () => {
    const one = JSON.stringify({ Name: ' AMD Radeon RX 7900 XTX ', PNPDeviceID: 'PCI\\VEN_1002&DEV_744C' })
    expect(parseAdapters(one)).toEqual([{ name: 'AMD Radeon RX 7900 XTX', vendor: 'amd' }])
  })

  it('returns nothing for output it cannot read', () => {
    expect(parseAdapters('')).toEqual([])
    expect(parseAdapters('not json')).toEqual([])
    expect(parseAdapters('[{"Name": 5}, null]')).toEqual([])
  })

  it('falls back to vendor ids', () => {
    expect(adaptersFromVendorIds([{ vendorId: 0x1002 }, { vendorId: 0x8086 }]).map((a) => a.vendor)).toEqual(['amd', 'intel'])
  })
})

describe('AMD support', () => {
  it.each([
    ['AMD Radeon RX 7900 XTX', 'listed'],
    ['AMD Radeon RX 9070 XT', 'listed'],
    ['AMD Radeon RX 9060 XT', 'listed'],
    ['AMD Radeon(TM) RX 7700', 'listed'],
    ['AMD Radeon PRO W7900', 'listed'],
    ['AMD Radeon AI PRO R9700', 'listed'],
    ['AMD Radeon RX 7900 XT', 'family'],
    ['AMD Radeon RX 7800 XT', 'family'],
    ['AMD Radeon RX 7700 XT', 'family'],
    ['AMD Radeon RX 9060', 'family'],
    ['AMD Radeon RX 7600', 'no'],
    ['AMD Radeon RX 6800 XT', 'no'],
    ['AMD Radeon RX 580', 'no'],
    ['AMD Radeon(TM) Graphics', 'no'],
  ])('%s is %s', (name, expected) => {
    expect(rocmSupport(name)).toBe(expected)
  })
})

describe('the recommended build', () => {
  it('is NVIDIA whenever an NVIDIA card is present, even beside a Radeon', () => {
    const choice = recommendVariant(parseAdapters(DEV_MACHINE))
    expect(choice.variant).toBe('cuda')
    expect(choice.gpu).toBe('NVIDIA GeForce RTX 5070 Ti')
    expect(recommendVariant([amd('AMD Radeon RX 7900 XTX'), { name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia' }]).variant).toBe('cuda')
  })

  it('is AMD for a supported Radeon, and says it is untested', () => {
    const choice = recommendVariant([amd('AMD Radeon(TM) Graphics'), amd('AMD Radeon RX 7900 XTX')])
    expect(choice.variant).toBe('rocm')
    expect(choice.gpu).toBe('AMD Radeon RX 7900 XTX')
    expect(choice.note).toMatch(/not been tested/)
    expect(choice.note).toMatch(/26\.2\.2/)
  })

  it('is AMD for a card of a supported family, with a warning', () => {
    const choice = recommendVariant([amd('AMD Radeon RX 7800 XT')])
    expect(choice.variant).toBe('rocm')
    expect(choice.note).toMatch(/not on AMD's list/)
  })

  it('is the standard build on the CPU for a Radeon AMD does not support', () => {
    const choice = recommendVariant([amd('AMD Radeon RX 6800 XT')])
    expect(choice.variant).toBe('cuda')
    expect(choice.note).toMatch(/CPU/)
  })

  it('is the standard build on the CPU when nothing usable is found', () => {
    expect(recommendVariant([{ name: 'Intel(R) UHD Graphics', vendor: 'intel' }]).variant).toBe('cuda')
    expect(recommendVariant([]).note).toMatch(/CPU/)
  })
})

describe('the setup marker', () => {
  it('round-trips the version and the build', () => {
    expect(parseMarker(formatMarker('0.2.0', 'rocm'))).toEqual({ version: '0.2.0', variant: 'rocm' })
  })

  it('reads a marker from before AMD support as the NVIDIA build', () => {
    expect(parseMarker('0.1.0\n')).toEqual({ version: '0.1.0', variant: 'cuda' })
    expect(parseMarker('0.1.0 something')).toEqual({ version: '0.1.0', variant: 'cuda' })
  })
})

describe('the GPU line in Settings', () => {
  const base = { torch: '2.9.1+rocm7.2.1', fake_engine: false }
  it('names the backend', () => {
    expect(gpuHint({ ...base, cuda_available: true, gpu_backend: 'rocm', gpu_backend_version: '7.2.53211' })).toBe(
      'PyTorch 2.9.1+rocm7.2.1, ROCm 7.2.53211',
    )
    expect(gpuHint({ torch: '2.14.1+cu130', fake_engine: false, cuda_available: true, gpu_backend: 'cuda', gpu_backend_version: '13.0' })).toBe(
      'PyTorch 2.14.1+cu130, CUDA 13.0',
    )
  })

  it('says when the CPU is in use', () => {
    expect(gpuHint({ ...base, cuda_available: false, gpu_backend: 'rocm', gpu_backend_version: '7.2.53211' })).toMatch(/Running on the CPU\.$/)
    expect(gpuHint({ ...base, fake_engine: true, cuda_available: false })).toBeUndefined()
  })
})

const status = (patch: Partial<SetupStatus>): SetupStatus => ({
  state: 'needed',
  log: [],
  managed: true,
  variant: 'cuda',
  installed: null,
  detected: true,
  gpus: [],
  note: '',
  ...patch,
})

describe('the setup screen', () => {
  it('waits for the graphics card check before setup can start', () => {
    render(<SetupScreen status={status({ detected: false })} />)
    expect(screen.getByRole('status')).toHaveTextContent('Checking your graphics card')
    expect(screen.getByRole('button', { name: 'Set up' })).toBeDisabled()
  })

  it('sets up the detected build', () => {
    render(<SetupScreen status={status({ variant: 'rocm', recommended: 'rocm', note: 'Found AMD Radeon RX 7900 XTX.' })} />)
    expect(screen.getByRole('radio', { name: 'AMD Radeon' })).toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent('Found AMD Radeon RX 7900 XTX.')
    expect(screen.getByText(/2\.5 GB/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    expect(bridge.runSetup).toHaveBeenLastCalledWith('rocm')
  })

  it('lets the user pick the other build and says which one fits', () => {
    render(<SetupScreen status={status({ variant: 'cuda', recommended: 'cuda', note: 'Found NVIDIA GeForce RTX 5070 Ti.' })} />)
    fireEvent.click(screen.getByRole('radio', { name: 'AMD Radeon' }))
    expect(screen.getByRole('status')).toHaveTextContent('The NVIDIA build is the one that fits this PC.')
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    expect(bridge.runSetup).toHaveBeenLastCalledWith('rocm')
  })

  it('shows the build as text while setup runs', () => {
    render(<SetupScreen status={status({ state: 'running', variant: 'rocm' })} />)
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Setting up' })).toBeDisabled()
  })
})

describe('the engine build row', () => {
  const renderRow = () =>
    render(
      <TooltipProvider>
        <EngineBuildRow />
      </TooltipProvider>,
    )

  it('is absent in development, where the engine is not set up by the app', async () => {
    bridge.detectGpu.mockResolvedValueOnce(status({ state: 'ready', managed: false }))
    const { container } = renderRow()
    await Promise.resolve()
    expect(container).toBeEmptyDOMElement()
  })

  it('switches the build only after a confirmation', async () => {
    bridge.detectGpu.mockResolvedValueOnce(status({ state: 'ready', installed: 'cuda', recommended: 'cuda' }))
    renderRow()
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to AMD Radeon' }))
    expect(bridge.switchBuild).not.toHaveBeenCalled()
    expect(await screen.findByText(/Your models, stems and settings are not touched/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Switch and download' }))
    expect(bridge.switchBuild).toHaveBeenCalledWith('rocm')
  })
})

describe('the self-test summary', () => {
  it('says what passed and how much faster the GPU is', () => {
    expect(
      selfTestLines({
        ok: true,
        ops: [
          { name: 'stft', ok: true },
          { name: 'conv2d', ok: true },
        ],
        models: [{ id: 'bs-roformer-sw', ok: true, gpu_seconds: 0.8, cpu_seconds: 18.8 }],
      }),
    ).toEqual(['All 2 operations match the CPU.', 'bs-roformer-sw matches the CPU and runs 24 times faster on the GPU.'])
  })

  it('names each failure', () => {
    expect(
      selfTestLines({
        ok: false,
        ops: [
          { name: 'stft', ok: false },
          { name: 'conv2d', ok: true },
          { name: 'attention', ok: false },
        ],
        models: [{ id: 'mdx23c-drumsep', ok: false, detail: 'GPU run failed: RuntimeError: HIP error' }],
      }),
    ).toEqual(['2 of 3 operations failed: stft, attention.', 'mdx23c-drumsep failed: GPU run failed: RuntimeError: HIP error.'])
  })

  it('passes on the reason when there is no GPU to test', () => {
    expect(selfTestLines({ ok: false, gpu_available: false, problems: ['It found no supported Radeon GPU.'] })).toEqual([
      'It found no supported Radeon GPU.',
    ])
  })
})
