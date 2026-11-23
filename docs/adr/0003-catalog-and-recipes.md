# 0003: Catalog, recipes and presets

Date: 2026-11-20. Status: accepted.

## Catalog

- **Generated, not hand-written.** `scripts/gen_catalog.py` builds `models.toml` from the
  registries inside the three loader packages: URL, sha256 and size per file, license, and the
  stems, chunk size and overlap read from each model's config YAML (fetched and hash-checked).
  Rerun it to add a model.
- **17 models**, 7.6 GB in total. All were downloaded on 2026-11-20, hash-verified, and
  null-tested against their loader library (`docs/benchmarks.md`).
- **Seed set** (`openstems models pull --set seed`, 3.4 GB): the seven models the standard
  recipes need. SW, Leap Xe vocals and instrumental, becruily karaoke, anvuew de-reverb,
  Gabox denoise and DrumSep.
- **Loaders are pinned to git commits.** As with bs-roformer-infer (ADR 0002), the PyPI
  releases of melband-roformer-infer and mdxnet-infer lag their repositories.
- **Stem names are normalized** where a config's name would mislead: Leap Xe instrumental
  (`other`) and HyperACE instrumental (`instrument`) become `instrumental`; the karaoke models'
  `Vocals` becomes `lead`; the de-reverb models' `noreverb` becomes `dry`; the Gabox denoise
  model's `Instrumental` becomes `clean`. The adapters check the stem count, not the names.
- **Chunk sizes are rounded down to the STFT hop** (three models), for the reason in ADR 0002.
- **Licenses** are recorded as the registries state them. Most say "not-reviewed"; SW and
  DrumSep are undocumented. None of that blocks personal use; nothing is redistributed.
- **Every checkpoint loads with `weights_only=True`**, including DrumSep, which the mdxnet-infer
  library itself loads with `weights_only=False`.
- **Kim Mel-Band RoFormer** is registered under `melband-roformer-kim-vocals` in the loader, and
  **Gabox denoise-debleed** only in the loader's override and checksum files, not in its
  checkpoint registry. Both resolve and verify.

## Recipes

All of the plan's recipes exist as TOML. Deviations:

- **`cleanup` is two recipes**, `cleanup-dereverb` and `cleanup-denoise`. A recipe is a fixed
  list of passes, so "one utility model, your choice" is two one-pass recipes rather than one
  recipe with a switch.
- **`acapella-clean` derives `backing`** as the dry vocal minus the lead. The karaoke model emits
  only the lead vocal.
- **`full-song-best-vocals-alt`** is the second wiring (SW on the Leap Xe instrumental), shipped
  as an experimental recipe so both can be compared inside the app.
- **`mega-53`** computes only the stems that are ticked.
- A recipe can also be an **ensemble**: a pass that names several models averages their
  waveforms. No built-in recipe uses one yet; user recipes can.

## Quality presets

| Preset | Overlap | TTA | Cost relative to Fast |
| --- | --- | --- | --- |
| Fast | 2 | no | 1x |
| Balanced | 4 | no | about 2x |
| Best | 8 | yes | about 12x |

RoFormers run at batch 1 and MDX23C at batch 4. Measured times are in `docs/benchmarks.md`.

## Open decisions

- **What melody means: default kept.** `melody` is other + guitar + piano as one stem, with
  guitar, piano and other also written on their own.
- **Full-song wiring: SW runs on the mix. Final.** Lewis listened to both wirings on three
  excerpts with vocals on 2026-11-21 and found both good, so the faster one stays. The scores
  from ground-truth stems agree:
  `scripts/compare_wirings.py` ran both wirings at Balanced on the 50 test tracks of the
  MUSDB18 7-second excerpts (songs with vocals, and the true stems to score against).
  Median SDR in dB, mean in brackets, higher is better:

  | Wiring | vocals | drums | bass | other |
  | --- | --- | --- | --- | --- |
  | SW on the mix | 12.19 (11.50) | 11.51 (11.85) | 9.64 (9.63) | 7.98 (7.44) |
  | SW on the Leap Xe instrumental | 12.19 (11.50) | 11.57 (12.12) | 9.71 (9.70) | 8.09 (7.34) |

  Vocals are identical, because both wirings take them from Leap Xe on the mix. Running SW on
  the instrumental scores higher on drums in 39 of 50 tracks and on bass in 33, but by a median
  of 0.06 and 0.07 dB; on `other` the two split 26 to 24 and the mean favours the mix. A tenth
  of a decibel is not audible, and the second wiring needs a third model run, about half again
  as long. So the default stays for now.

  The second wiring ships as the experimental recipe `full-song-best-vocals-alt`, so it
  stays available for comparison in the app. Renders of three
  instrumental songs are in `D:\lew-stems\compare-wirings`.

## Custom models

`openstems models import CHECKPOINT --config CONFIG --arch ARCH` copies the files into
`{models}/custom/<id>/`, hashes them and writes a `model.toml`. The command shows the pickle
warning and asks for confirmation; the API requires `acknowledge_pickle_risk`.
