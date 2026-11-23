// Prepares what the installer ships besides the app itself:
//
//   package/engine/requirements.txt        every pinned dependency, NVIDIA (CUDA) build
//   package/engine/requirements-rocm.txt   the same for the AMD (ROCm) build
//   package/engine/wheels/*.whl            openstems, the three git-pinned loaders and AMD's
//                                          small `rocm` helper, pre-built
//   package/bin/uv.exe                     uv, which creates the Python environment on first run
//
// On a Mac the same script prepares the Apple Silicon build instead: one requirements file,
// `package/engine/requirements-mps.txt` (PyTorch from PyPI), the same local wheels without
// AMD's helper, and `package/bin/uv` for aarch64-apple-darwin.
//
// The loaders are pinned to git commits and AMD ships `rocm` as source only. Building their
// wheels here means the user's machine needs neither git nor a build step. The large AMD
// wheels are not shipped: the requirements file names them by URL with the sha256 from the
// lockfile, and uv checks the hash after downloading.
//
//   node scripts/prepare-package.mjs
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const UV_VERSION = '0.13.6'
// Per system: the uv archive, its published sha256 (the `.sha256` file beside it in the uv
// release), the file inside it, and the requirements files to write with their uv groups.
const TARGETS = {
  win32: {
    uvArchive: 'uv-x86_64-pc-windows-msvc.zip',
    uvSha256: 'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f',
    uvMember: 'uv.exe',
    uvFile: 'uv.exe',
    builds: [
      ['requirements.txt', ['--no-dev']], // the default groups minus dev: the NVIDIA build
      ['requirements-cu126.txt', ['--no-default-groups', '--group', 'cu126']], // older NVIDIA cards
      ['requirements-rocm.txt', ['--no-default-groups', '--group', 'rocm']],
    ],
  },
  darwin: {
    uvArchive: 'uv-aarch64-apple-darwin.tar.gz',
    uvSha256: '60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472',
    // The tarball holds one folder with uv and uvx in it.
    uvMember: 'uv-aarch64-apple-darwin/uv',
    uvFile: 'uv',
    builds: [['requirements-mps.txt', ['--no-default-groups', '--group', 'mps']]], // Apple Silicon
  },
}
// PACKAGE_PLATFORM names the system to prepare for, for trying the other one's steps.
const platform = process.env.PACKAGE_PLATFORM || process.platform
const target = TARGETS[platform]
if (!target) throw new Error(`no package is prepared on ${platform}: Windows and macOS only`)
const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${target.uvArchive}`

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const engineDir = join(appDir, '..', 'engine')
const outDir = join(appDir, 'package')
const wheels = join(outDir, 'engine', 'wheels')
const bin = join(outDir, 'bin')
// Windows ships bsdtar, which reads zip files; name it by path so a GNU tar on PATH is not used.
// macOS has bsdtar as its system tar.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : '/usr/bin/tar'

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options })

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function download(url, expected) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = sha256(bytes)
  if (digest !== expected) throw new Error(`sha256 mismatch for ${url}: ${digest}`)
  return bytes
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(wheels, { recursive: true })
mkdirSync(bin, { recursive: true })
const work = join(tmpdir(), `openstems-wheels-${process.pid}`)
mkdirSync(work, { recursive: true })

const builtHashes = new Map() // name -> sha256 of the wheel built here

/** Build a wheel from a source folder into `wheels` and return its version. */
function buildWheel(name, source) {
  const before = new Set(readdirSync(wheels))
  run('uv', ['build', '--wheel', '--out-dir', wheels], { cwd: source })
  const built = readdirSync(wheels).find((file) => !before.has(file) && file.endsWith('.whl'))
  if (!built) throw new Error(`no wheel was built for ${name}`)
  builtHashes.set(name, sha256(readFileSync(join(wheels, built))))
  return built.split('-')[1]
}

/**
 * A requirement for a wheel built here, pinned by its content. These packages are installed
 * by name from the bundled wheels folder; the hash makes uv refuse a package of the same name
 * and version from an index, whoever published it.
 */
function localRequirement(name, marker) {
  return `${name}==${builtVersions.get(name)}${marker ? ` ${marker}` : ''} --hash=sha256:${builtHashes.get(name)}`
}

// The sha256 uv recorded for a direct-URL package when it locked the project.
const lock = readFileSync(join(engineDir, 'uv.lock'), 'utf8')
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function lockedHash(url) {
  const wheel = new RegExp(`url = "${escape(url)}", hash = "sha256:([0-9a-f]{64})"`).exec(lock)
  if (wheel) return wheel[1]
  const at = lock.indexOf(`source = { url = "${url}" }`)
  const sdist = at < 0 ? null : /sdist = \{ hash = "sha256:([0-9a-f]{64})" \}/.exec(lock.slice(at, at + 2000))
  if (!sdist) throw new Error(`uv.lock has no hash for ${url}`)
  return sdist[1]
}

const builtVersions = new Map() // name -> version, so a package shared by both builds is built once

// 1. The engine's own wheel.
console.log('building the openstems wheel')
builtVersions.set('openstems', buildWheel('openstems', engineDir))

// 2. One pinned requirements file per PyTorch build, from the lockfile's dependency groups.
async function pin(groupArgs) {
  const exported = run('uv', ['export', '--frozen', '--no-hashes', '--no-emit-project', ...groupArgs], { cwd: engineDir })
  const requirements = []
  for (const line of exported.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const git = line.match(/^(\S+) @ git\+(https:\/\/\S+?)@([0-9a-f]{40})\s*(;.*)?$/)
    const direct = line.match(/^(\S+) @ (https:\/\/\S+?)\s*(;.*)?$/)
    if (git) {
      // Git-pinned packages become wheels built from their pinned commit.
      const [, name, url, commit, marker] = git
      if (!builtVersions.has(name)) {
        console.log(`building ${name} at ${commit.slice(0, 10)}`)
        const clone = join(work, name)
        run('git', ['clone', '--quiet', url, clone])
        run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', commit], { cwd: clone })
        builtVersions.set(name, buildWheel(name, clone))
      }
      requirements.push(localRequirement(name, marker))
    } else if (direct && direct[2].endsWith('.tar.gz')) {
      // A source-only package (AMD's `rocm`): fetch it, check the locked hash, build the wheel.
      const [, name, url, marker] = direct
      if (!builtVersions.has(name)) {
        console.log(`building ${name} from ${url}`)
        const archive = join(work, `${name}.tar.gz`)
        writeFileSync(archive, await download(url, lockedHash(url)))
        const folder = join(work, `${name}-src`)
        mkdirSync(folder, { recursive: true })
        run(tar, ['-xzf', archive, '-C', folder, '--strip-components', '1'])
        builtVersions.set(name, buildWheel(name, folder))
      }
      requirements.push(localRequirement(name, marker))
    } else if (direct) {
      // A large wheel downloaded on the user's machine: pin its content by hash.
      const [, name, url, marker] = direct
      requirements.push(`${name} @ ${url}${marker ? ` ${marker}` : ''} --hash=sha256:${lockedHash(url)}`)
    } else {
      requirements.push(line)
    }
  }
  requirements.push(localRequirement('openstems'))
  return requirements
}

for (const [file, groupArgs] of target.builds) {
  const requirements = await pin(groupArgs)
  writeFileSync(join(outDir, 'engine', file), `${requirements.join('\n')}\n`, 'utf8')
  console.log(`${file}: ${requirements.length} pinned requirements`)
  console.log(requirements.filter((l) => /roformer|mdxnet|openstems|^torch|^rocm/.test(l)).map((l) => `  ${l}`).join('\n'))
}
rmSync(work, { recursive: true, force: true })
rmSync(join(wheels, '.gitignore'), { force: true }) // uv build drops one in its output folder
console.log(`${readdirSync(wheels).length} local wheels`)

// 3. uv itself, checked against the published sha256.
const archive = join(outDir, target.uvArchive)
console.log(`downloading uv ${UV_VERSION} (${target.uvArchive})`)
writeFileSync(archive, await download(UV_URL, target.uvSha256))
// Only uv itself is taken, without the folder the macOS tarball wraps it in.
const strip = target.uvMember.split('/').length - 1
run(tar, ['-xf', archive, '-C', bin, ...(strip ? ['--strip-components', String(strip)] : []), target.uvMember])
rmSync(archive)
const uv = join(bin, target.uvFile)
if (!existsSync(uv)) throw new Error(`${target.uvFile} was not extracted`)
if (platform !== 'win32') chmodSync(uv, 0o755)
console.log(`ready in ${outDir}`)
