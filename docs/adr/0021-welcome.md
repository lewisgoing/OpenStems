# 0021: The welcome on a first start

Date: 2026-11-23. Status: accepted. `PLAN.md` (phase 6) says first run should "offer to
download the seed models"; this widens that offer into three short steps.

## Decision

After first-run setup, the first time the app opens with the engine ready, a dialog walks
through three steps (`src/components/Welcome.tsx`):

1. **Folders.** The stems folder (`output_dir`) and the models folder (`models_dir`), each
   with the free space on its drive (a disk on a Mac) and a Change button. The models folder
   says how large the recommended set is, and warns when it would not fit with a gigabyte to
   spare. This step comes first because downloads go to whatever `models_dir` is when they
   start, and `Service.patch_settings` reloads the runtime, so a new folder takes effect at
   once. A folder that already holds some of the models shrinks the download in step 3.
2. **Format.** The four formats as cards, each with the size of one stem of a four-minute
   song (WAV and MP3 exact, FLAC taken as 60 percent of WAV 24-bit: `stemBytes`). Under them
   two switches: "Start songs as soon as they are added" (`auto_start`, off by default, the
   one setting a newcomer trips over when a dropped song just waits) and tempo sync for FL
   Studio. With tempo sync on, MP3 and FLAC say FL reads no tempo from them.
3. **Models.** The recommended set, as the old offer showed it, with the reason when it is
   not the usual set, and a summary of what the first two steps chose.

- **Every choice is the setting itself**, saved as it is made. There is no separate
  onboarding state to apply at the end, and closing early (Skip, Escape) keeps what was
  chosen.
- **Who sees it.** The same rule as the offer it replaces: nothing installed or downloading,
  and neither `openstems.welcome.v1` nor the old `openstems.seed-offer.v1` in local storage.
  An existing install that updates is not onboarded again. Settings > Getting started has
  "Show the welcome again", which clears the key and opens it at the first step.
- **Free space** comes from the main process (`fs:space`, `statfs`), with the folder's
  nearest existing ancestor (a picked folder may not exist yet). The walk and the arithmetic
  are plain functions in `electron/space.ts`, tested on Windows with Mac paths too.
  `statfs` works on both systems.
- **Motion.** A modal, centered, on the dialog's own entrance. A step entered with the
  pointer slides in 12 px from the side it lies on (220 ms, the strong ease-out); one
  reached from the keyboard appears at once; reduced motion keeps the fade only. Every step
  is as tall as the tallest, so Continue never moves. The dialog itself takes focus, so no
  focus ring shows before anything is pressed.
- **Tests.** The FakeEngine reports every model installed, so `OPENSTEMS_E2E_WELCOME=1`
  forces the welcome in an end-to-end run, and `__openstemsE2E.pickFolder` stands in for the
  folder picker (`e2e/welcome.spec.ts`).

## Known limit

`OPENSTEMS_OUTPUT_DIR` and `OPENSTEMS_MODELS_DIR` win over the settings file. On a machine
that sets them (the development machine does) a folder picked in the welcome, or in
Settings, is saved but not used. Packaged apps do not set them.

## Mac

The words are the platform's (`words().drive`: "disk"). Nothing in it has been seen on a
Mac yet; the component and `space.ts` tests cover the Mac wording and paths on Windows.
