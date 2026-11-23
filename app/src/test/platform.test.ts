import {
  dataRoot,
  devGroupArgs,
  engineEnvDir,
  installEnv,
  joinPath,
  logsDir,
  macBundlePath,
  explainSetupError,
  uvFileName,
  venvArgs,
  venvExecutable,
} from '../../electron/platform'

const windows = { platform: 'win32', home: 'C:\\Users\\lew', env: { LOCALAPPDATA: 'C:\\Users\\lew\\AppData\\Local' } }
const mac = { platform: 'darwin', home: '/Users/lew', env: {} }

describe('folders on Windows', () => {
  it('are under %LOCALAPPDATA%\\OpenStems, as they always were', () => {
    expect(dataRoot(windows)).toBe('C:\\Users\\lew\\AppData\\Local\\OpenStems')
    expect(engineEnvDir(windows)).toBe('C:\\Users\\lew\\AppData\\Local\\OpenStems\\engine-env')
    expect(logsDir(windows)).toBe('C:\\Users\\lew\\AppData\\Local\\OpenStems\\logs')
  })

  it('follow a profile that was moved', () => {
    const moved = { ...windows, env: { LOCALAPPDATA: 'D:\\tmp\\fresh\\Local' } }
    expect(engineEnvDir(moved)).toBe('D:\\tmp\\fresh\\Local\\OpenStems\\engine-env')
    expect(logsDir(moved)).toBe('D:\\tmp\\fresh\\Local\\OpenStems\\logs')
  })

  it('fall back to the home folder when LOCALAPPDATA is not set', () => {
    expect(engineEnvDir({ ...windows, env: {} })).toBe('C:\\Users\\lew\\AppData\\Local\\OpenStems\\engine-env')
  })
})

describe('folders on a Mac', () => {
  it('are in the Library, with forward slashes whatever system asks', () => {
    expect(dataRoot(mac)).toBe('/Users/lew/Library/Application Support/OpenStems')
    expect(engineEnvDir(mac)).toBe('/Users/lew/Library/Application Support/OpenStems/engine-env')
    expect(logsDir(mac)).toBe('/Users/lew/Library/Logs/OpenStems')
  })

  it('ignore the Windows variable', () => {
    const odd = { ...mac, env: { LOCALAPPDATA: 'C:\\somewhere' } }
    expect(dataRoot(odd)).toBe(dataRoot(mac))
    expect(logsDir(odd)).toBe(logsDir(mac))
  })
})

describe('other systems', () => {
  it('keep the layout they had', () => {
    const linux = { platform: 'linux', home: '/home/lew', env: {} }
    expect(engineEnvDir(linux)).toBe('/home/lew/AppData/Local/OpenStems/engine-env')
    expect(logsDir({ ...linux, env: { LOCALAPPDATA: '/tmp/profile' } })).toBe('/tmp/profile/OpenStems/logs')
  })
})

describe('programs', () => {
  it('in a Python environment are in Scripts with .exe on Windows and in bin elsewhere', () => {
    expect(venvExecutable(engineEnvDir(windows), 'openstems', 'win32')).toBe(
      'C:\\Users\\lew\\AppData\\Local\\OpenStems\\engine-env\\Scripts\\openstems.exe',
    )
    expect(venvExecutable(engineEnvDir(windows), 'python', 'win32')).toBe(
      'C:\\Users\\lew\\AppData\\Local\\OpenStems\\engine-env\\Scripts\\python.exe',
    )
    expect(venvExecutable(engineEnvDir(mac), 'openstems', 'darwin')).toBe(
      '/Users/lew/Library/Application Support/OpenStems/engine-env/bin/openstems',
    )
    expect(venvExecutable(engineEnvDir(mac), 'python', 'darwin')).toBe(
      '/Users/lew/Library/Application Support/OpenStems/engine-env/bin/python',
    )
  })

  it('name the bundled uv', () => {
    expect(uvFileName('win32')).toBe('uv.exe')
    expect(uvFileName('darwin')).toBe('uv')
  })

  it('join paths the way the named system writes them', () => {
    expect(joinPath('win32', 'C:\\a', 'b', 'c.txt')).toBe('C:\\a\\b\\c.txt')
    expect(joinPath('darwin', '/a', 'b', 'c.txt')).toBe('/a/b/c.txt')
    // What Node's own join gives for the same parts.
    expect(joinPath('win32', 'C:\\a\\', 'b')).toBe('C:\\a\\b')
    expect(joinPath('win32', 'C:/a', 'b')).toBe('C:\\a\\b')
    expect(joinPath('win32', '\\\\server\\share', 'b')).toBe('\\\\server\\share\\b')
    expect(joinPath('darwin', '/a/', 'b')).toBe('/a/b')
  })
})

describe('the engine in development', () => {
  it('asks uv for the Apple Silicon PyTorch on a Mac and for nothing extra on Windows', () => {
    expect(devGroupArgs('win32')).toEqual([])
    expect(devGroupArgs('darwin')).toEqual(['--no-default-groups', '--group', 'dev', '--group', 'mps'])
  })
})

describe('first-run setup', () => {
  it('uses only the Python uv manages on a Mac, and asks Windows for nothing extra', () => {
    expect(venvArgs('win32')).toEqual([])
    expect(venvArgs('darwin')).toEqual(['--managed-python'])
  })

  it('copies files out of the uv cache on Windows, as it always did, and leaves a Mac at the default', () => {
    expect(installEnv('win32')).toEqual({ UV_LINK_MODE: 'copy' })
    expect(installEnv('darwin')).toEqual({})
  })
})

describe('the Mac app bundle', () => {
  it('is three levels above the program inside it', () => {
    expect(macBundlePath('/Applications/OpenStems.app/Contents/MacOS/OpenStems')).toBe('/Applications/OpenStems.app')
    expect(macBundlePath('/Users/lew/My Apps/OpenStems.app/Contents/MacOS/OpenStems')).toBe('/Users/lew/My Apps/OpenStems.app')
  })
})

describe('the Mac build configuration', () => {
  type Build = { mac: { identity?: string | null; hardenedRuntime?: boolean; entitlements?: string }; win: unknown; appId: string }
  const load = async () => {
    const file: string = '../../mac-build.cjs'
    const loaded = (await import(/* @vite-ignore */ file)) as { macBuild?: (env: object) => Build; default?: { macBuild: (env: object) => Build } }
    return (loaded.macBuild ?? loaded.default?.macBuild) as (env: object) => Build
  }

  it('signs ad hoc, without the hardened runtime, when there is no certificate', async () => {
    const macBuild = await load()
    const config = macBuild({})
    expect(config.mac.identity).toBe('-')
    expect(config.mac.hardenedRuntime).toBe(false)
    // An empty secret is no certificate.
    expect(macBuild({ CSC_LINK: '' }).mac.identity).toBe('-')
    expect(config.appId).toBe('ing.lewisgo.openstems')
  })

  it('leaves the build as package.json has it when a certificate is supplied', async () => {
    const macBuild = await load()
    const config = macBuild({ CSC_LINK: 'base64...' })
    expect(config.mac.identity).toBeUndefined()
    expect(config.mac.hardenedRuntime).toBe(true)
    expect(config.mac.entitlements).toBe('build/entitlements.mac.plist')
  })

  it("signs again with the project's own certificate when one is imported", async () => {
    const macBuild = await load()
    type WithHook = Build & { afterSign?: string }
    const config = macBuild({ OPENSTEMS_SIGN_IDENTITY: 'A'.repeat(40) }) as WithHook
    expect(config.mac.identity).toBe('-')
    expect(config.mac.hardenedRuntime).toBe(false)
    expect(config.afterSign).toBe('build/resign-mac.cjs')
    expect((macBuild({}) as WithHook).afterSign).toBeUndefined()
    // A Developer ID build is left to electron-builder, with no second signature.
    expect((macBuild({ CSC_LINK: 'x', OPENSTEMS_SIGN_IDENTITY: 'A'.repeat(40) }) as WithHook).afterSign).toBeUndefined()
  })

  it('never changes the configuration the Windows build reads', async () => {
    const macBuild = await load()
    const before = JSON.stringify(macBuild({ CSC_LINK: 'x' }))
    macBuild({}).mac.identity = 'changed'
    expect(JSON.stringify(macBuild({ CSC_LINK: 'x' }))).toBe(before)
  })
})

describe('a setup failure in plain words', () => {
  const refused = {
    code: 'EACCES',
    path: '/Users/ada/Library/Application Support/OpenStems',
    message: "EACCES: permission denied, mkdir '/Users/ada/Library/Application Support/OpenStems'",
  }

  it('says what to run on a Mac whose Application Support folder belongs to root', () => {
    const text = explainSetupError(refused, 'darwin')
    expect(text).toContain('sudo chown "$(id -un)" "/Users/ada/Library/Application Support"')
    expect(text).not.toContain('EACCES')
  })

  it('names the folder on Windows and gives no Mac command', () => {
    const folder = 'C:\\Users\\ada\\AppData\\Local\\OpenStems'
    const text = explainSetupError({ ...refused, code: 'EPERM', path: folder }, 'win32')
    expect(text).toContain(folder)
    expect(text).not.toContain('chown')
  })

  it('leaves every other error as it is', () => {
    expect(explainSetupError({ message: 'exit code 2' }, 'darwin')).toBe('exit code 2')
    expect(explainSetupError({ code: 'ENOSPC', message: 'no space left' }, 'win32')).toBe('no space left')
  })

  it('still reads well when the error names no path', () => {
    expect(explainSetupError({ code: 'EACCES', message: 'x' }, 'darwin')).not.toContain('chown')
  })
})

describe("signing again with the project's own certificate", () => {
  type Run = (command: string, args: string[]) => void
  type Hook = (context: object, env: object, run: Run) => Promise<void>

  async function hook(): Promise<Hook> {
    const file: string = '../../build/resign-mac.cjs'
    const loaded = (await import(/* @vite-ignore */ file)) as { afterSign?: Hook; default?: { afterSign?: Hook } }
    return (loaded.afterSign ?? loaded.default?.afterSign) as Hook
  }

  const context = (platform: string) => ({
    electronPlatformName: platform,
    appOutDir: '/tmp/out/mac-arm64',
    packager: { appInfo: { productFilename: 'OpenStems' } },
  })

  it('signs the app with the identity, then verifies the whole bundle', async () => {
    const afterSign = await hook()
    const calls: [string, string[]][] = []
    const env = { OPENSTEMS_SIGN_IDENTITY: 'ABC', OPENSTEMS_SIGN_KEYCHAIN: '/tmp/k.keychain-db' }
    await afterSign(context('darwin'), env, (command, args) => calls.push([command, args]))
    expect(calls).toHaveLength(2)
    const [sign, verify] = calls as [[string, string[]], [string, string[]]]
    expect(sign[0]).toBe('/usr/bin/codesign')
    expect(sign[1]).toEqual(expect.arrayContaining(['--force', '--deep', '--sign', 'ABC', '--keychain', '/tmp/k.keychain-db']))
    // The requirement is made anew from the certificate, never kept from the ad hoc signature.
    expect(sign[1].join(' ')).not.toMatch(/requirements/)
    expect(sign[1].at(-1)).toMatch(/mac-arm64[\\/]OpenStems\.app$/)
    expect(verify[0]).toBe('/usr/bin/codesign')
    expect(verify[1]).toEqual(expect.arrayContaining(['--verify', '--deep', '--strict']))
  })

  it('does nothing without an identity, or for another platform', async () => {
    const afterSign = await hook()
    const run = vi.fn()
    await afterSign(context('darwin'), {}, run)
    await afterSign(context('win32'), { OPENSTEMS_SIGN_IDENTITY: 'ABC' }, run)
    expect(run).not.toHaveBeenCalled()
  })
})
