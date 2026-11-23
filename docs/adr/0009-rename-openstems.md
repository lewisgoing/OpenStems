# 0009: The app is called OpenStems

Date: 2026-11-22. Status: accepted. Version 0.2.0 is the first under the new name.

## Decision

lew-stems is renamed to OpenStems, everywhere: the app, the installer, the command, the
Python package, the environment variables, the data folders, the repository and the documents.
One name, changed once, before more people install the app.

## The two forms of the name

| Where | Form | Examples |
| --- | --- | --- |
| What people read, and folders | `OpenStems` | the window, the Start menu entry, `OpenStems-Setup-0.2.0.exe`, `%LOCALAPPDATA%\OpenStems`, `%APPDATA%\OpenStems`, `Music\OpenStems`, the repository `lewisgoing/OpenStems` |
| What is typed or imported | `openstems` | the command `openstems doctor`, the Python package `openstems`, the app id `ing.lewisgo.openstems`, storage keys, temp folders |
| Environment variables | `OPENSTEMS_*` | `OPENSTEMS_MODELS_DIR`, `OPENSTEMS_ENGINE` |

In the app's code the preload bridge is `window.openstems`.

## What is carried over from lew-stems

A fresh install has nothing to carry. For someone who used lew-stems, the first start as
OpenStems does this once (`openstems.settings.adopt_legacy_settings`):

- The old settings file, `%APPDATA%\lew-stems\settings.json`, is read and saved as
  `%APPDATA%\OpenStems\settings.json`. Its folders are kept as they are, so a models folder
  chosen in Settings is still the models folder.
- Folders that were never chosen lived under the old name: `%LOCALAPPDATA%\lew-stems\models`,
  `%LOCALAPPDATA%\lew-stems\cache` and `Music\lew-stems`. Each one that holds anything stays
  in use, so no model is downloaded twice and no output goes missing from History.
- User recipes in `%APPDATA%\lew-stems\recipes` are copied.

Nothing is moved and nothing is deleted. After that first start the new settings file is the
only one read. A config folder set through `OPENSTEMS_CONFIG_DIR` takes no part in this.

## What is not carried over

- **The Python environment.** It cannot be moved, and a new version rebuilds it anyway. The
  old one, `%LOCALAPPDATA%\lew-stems\engine-env` (several GB), belongs to the lew-stems
  install: uninstalling lew-stems removes it.
- **The install itself.** OpenStems has a new app id, so it installs beside lew-stems and
  does not replace it. Uninstall lew-stems from Windows Settings; its uninstaller leaves
  models, outputs and settings alone, as before.
- **Environment variables.** `LEW_STEMS_*` are no longer read. Set `OPENSTEMS_*` instead.
- **The choice of recipe and quality in the window**, which the browser storage of the old
  app held. It starts from the defaults in Settings.

## Packaging

The wheels built at packaging time (the app's own and the three loaders, plus AMD's `rocm`)
are installed by name from the bundled wheels folder. Each is now pinned by sha256 in the
requirements files, as AMD's large wheels already were. With the hash, uv refuses a package of
the same name and version from an index, whoever published it. This matters more under a name
that reads like a public package.

## About the earlier records

The earlier decision records and the changelog were renamed along with the code, so that the
commands in them still work. Where a record describes a run from before the rename, the files
and folders carried the old name on the day: the first installer was
`lew-stems-setup-0.1.0.exe`.

A real folder on the development machine, `D:\lew-stems`, keeps its name. The rename is of the
app, not of anyone's disk.

## Checked

- Engine: the unit tests under the new package name, and seven tests of the carry-over
  (`tests/test_settings_legacy.py`): the old settings file, old default folders with and
  without content, user recipes, a broken old file, an existing new file, and a config folder
  chosen by hand.
- App: type-check, unit tests and the end-to-end suite under the new names.
- The lockfile changed only in the project's own name and version.
