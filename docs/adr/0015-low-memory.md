# 0015: Machines with little memory

Date: 2026-11-23. Status: accepted. **Not yet run on a small machine: every number for a Mac
and for full precision is an estimate.**

This deviates from the plan, which targets one machine with 16 GB of graphics memory.

## The requirement

OpenStems has to work for people with less memory than the development machine. The two
cases in mind are a Mac with 8 GB, where the GPU shares its memory with the system and every
other app, and Windows cards with 4 to 6 GB of graphics memory. The owner's Mac has 32 GB, so
the path for a small machine must be testable on a large one.

## Decision

Every model has a memory figure, every machine has a memory budget for one model run, and the
two are compared into a fit: "fits", "tight" or "no". The app shows the fit and chooses the
first download by it. Nothing is blocked. A run that does run out of memory degrades in fixed
steps and ends on the CPU with a note, instead of failing. `OPENSTEMS_MEMORY_GB` makes a
large machine plan as a small one.

The rules are plain functions with no PyTorch in them, in
`engine/src/openstems/domain/memory.py`. Detecting the machine is elsewhere ("Where it
lives").

## What a model needs

- **Catalog models carry `memory_gb`**: the peak graphics memory of one run, measured on the
  RTX 5070 Ti with half precision. The figures are the Peak VRAM column of "Every model and
  preset" in `docs/benchmarks.md`. They live in `MEMORY_GB` in `scripts/gen_catalog.py`, which
  writes them into `catalog/models.toml`. All 17 models have one.
- **The batch is 1**, except for DrumSep: its only measurement is at its preset's batch of 4,
  which is the larger figure.
- **A model with no measurement** (one you imported) gets an estimate: the checkpoint's size
  plus the largest activation memory measured for its architecture. That is 3.6 GB for
  BS-RoFormer, 1.4 GB for Mel-Band RoFormer and 0.7 GB for MDX23C. The 53-stem model is left
  out of that maximum.
- **Full precision needs more.** The Apple GPU, the CPU and the GTX 900 and 10 series run at
  full precision (ADR 0012, ADR 0014). There the need is taken to be
  `weights + 2 x (measured peak - weights)`. The weights do not grow: autocast leaves them at
  full precision on CUDA too. Everything else is taken to double. Two is the upper bound, not
  a measurement, so these figures should be too high, not too low.

Examples, in GB:

| Model | Checkpoint | Half precision (measured) | Full precision (estimate) |
| --- | --- | --- | --- |
| Mel-Band guitar (becruily) | 0.04 | 0.90 | 1.76 |
| MDX23C DrumSep | 0.41 | 1.09 | 1.77 |
| Mel-Band vocals (becruily) | 0.85 | 1.51 | 2.17 |
| BS-RoFormer dereverb (anvuew) | 0.19 | 1.47 | 2.75 |
| BS-RoFormer karaoke (anvuew) | 0.19 | 2.00 | 3.81 |
| BS-RoFormer SW | 0.65 | 2.32 | 3.99 |
| BS-RoFormer karaoke (becruily) | 0.19 | 2.66 | 5.13 |
| BS-RoFormer HyperACE v2 | 0.27 | 2.96 | 5.65 |
| BS-RoFormer Leap Xe | 0.25 | 3.80 | 7.35 |
| BS-RoFormer 53-stem | 1.27 | 9.50 | 17.73 |

## What a machine has for one run

| Where models run | Budget for one model run |
| --- | --- |
| NVIDIA or AMD card | The card's total memory |
| Apple GPU (mps) | (the Mac's memory - 2 GB) x 0.75 |
| CPU, or the GPU switched off or not working | Half of the machine's memory |

- **A card** is counted whole. What the desktop and other programs already hold on it is not
  subtracted.
- **A Mac** shares one memory between the GPU, the system and every app. 2 GB are left for
  the system and OpenStems itself, and a quarter of the rest for everything else.
- **The CPU** gets half, because the decoded song and the rest of the machine live in the
  same memory.
- **A machine that does not say** how much memory it has gets no budget, and everything
  counts as fitting.

| Machine | Budget (GB) | Small |
| --- | --- | --- |
| Mac, 8 GB | 4.5 | yes |
| Mac, 16 GB | 10.5 | no |
| Mac, 32 GB | 22.5 | no |
| Card, 4 GB | 4.0 | yes |
| Card, 6 GB | 6.0 | yes |
| Card, 8 GB | 8.0 | see below |

A card reports a little less than its name says: the 16 GB card here reports 15.9. So a real
8 GB card comes out just under 8 and counts as small, and the tables below, which use the
round numbers, are a little kind to real cards. Windows reports a PC's own memory the same
way (31.2 for 32 GB here), so a 16 GB PC that runs on the CPU has a budget just under 8 and
counts as small too. A Mac reports its memory exactly.

Two cases sit on an edge, and a real card may fall on the other side of it:

- **SW on a 4 GB GTX 900 or 10 series card.** The full-precision estimate is 3.99 GB against
  4.00: "tight" by 0.3 percent, on a figure that is itself a doubling. A card that reports
  3.98 or less makes SW "no", and with it `full-song`, `drum-kit`, `melody` and `drumless`,
  and the recommended set changes. Expect that row to read "no" on a real card until the
  full-precision figure is measured.
- **Leap Xe (3.80) on a 4 GB half-precision card**: "tight" at 4.0, and "no" on a card that
  reports less than 3.8.

## Fit

A need of up to 85 percent of the budget "fits". Up to the whole budget it is "tight": it
fits, with less than 15 percent to spare. Above the budget it is "no".

Models run one at a time, so a recipe is as large as its largest model. The API gives `fit`,
`memory_gb` and `memory_estimated` on each model, `fit`, `fit_model` and `memory_gb` on each
recipe, and `memory_budget_gb`, `memory_gb`, `memory_kind` and `memory_overridden` in the
system info.

"no" is advice. A model or recipe marked "no" can still be queued, and the run goes through
the steps under "When memory runs out".

What the rules give for the built-in recipes:

| Recipe | Largest model | Mac 8 GB | Mac 16 GB and up | Card 4 GB | Card 6 GB and up | GTX 900/10, 4 GB | GTX 900/10, 6 GB | GTX 900/10, 8 GB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `full-song`, `drum-kit`, `melody`, `drumless` | SW | tight | fits | fits | fits | tight (on the edge, see above) | fits | fits |
| `full-song-best-vocals`, `vocals-instrumental`, `acapella-clean` | Leap Xe | no | fits | tight | fits | no | no | tight |
| `cleanup-dereverb`, `cleanup-denoise` | dereverb, denoise | fits | fits | fits | fits | fits | fits | fits |
| `mega-53` | 53-stem | no | no below 32 GB | no | no below 9.5 GB, tight at 10 and 11 GB, fits from 12 GB | no | no | no |

The middle columns are cards that run at half precision (GTX 16 series, RTX 20 series and
later, AMD). The last three are the full-precision cards of ADR 0012. `mega-53` fits a 32 GB
Mac and a 12 GB card, and is "no" on a 24 GB Mac (17.7 against 16.5).

On the development machine (15.9 GB, half precision) every model and every recipe "fits".

## The first download

The models offered at first run were the catalog's `seed` set. They are now
`recommended_ids`: the seed set, cut to what the machine can run.

- A seed model that is "no" gives its place to the first catalog model for the same use that
  is not "no". A model that fits is taken before one that is tight. Experimental and imported
  models are never stand-ins. With no stand-in, the place stays empty.
- "tight" seed models stay.
- Where nothing is "no", the set is the seed set, unchanged. That is the case on a Mac with
  16 GB or more and on every half-precision card from 4 GB up.

On an 8 GB Mac (and a 4 GB GTX 900 or 10 series card) the set becomes:

| Seed model | Offered instead |
| --- | --- |
| Leap Xe vocals | Mel-Band vocals (becruily) |
| Leap Xe instrumental | Mel-Band instrumental (becruily) |
| Karaoke (becruily) | Karaoke (anvuew) |
| SW, dereverb, denoise, DrumSep | unchanged |

That set is about 1.3 GB larger to download, because the Mel-Band checkpoints are larger
files that need less memory to run.

The API marks these with `recommended` on each model; `seed` is unchanged. The command line
has `openstems models pull --set recommended` beside `--set seed`.

**A gap this leaves.** The built-in recipes name their models. On an 8 GB Mac the stand-ins
are downloaded, but `vocals-instrumental`, `full-song-best-vocals` and `acapella-clean` still
ask for Leap Xe and the becruily karaoke model. The stand-ins run as single models, not
through those recipes. Recipes that pick a lighter model on a small machine are not built.

## When memory runs out

The order, for one model in one job (`Pipeline._separate` in `pipeline/run.py`):

1. **A smaller batch.** The runner halves the batch and retries, as before. The RoFormer
   presets already run at batch 1, so this helps DrumSep only.
2. **Drop the other warm models, try again once.** Skipped when no other model is loaded.
3. **Run this model on the CPU, for this job.** Everything warm is dropped first, and the
   GPU's cache is emptied (`ModelHost.release`), also when the model never finished loading:
   on a Mac the CPU run draws on the same memory. The other models of the recipe still try
   the GPU. A model used twice in a job stays on the CPU for that job. When the job ends the
   CPU copy is unloaded, so the next job tries the GPU again.
4. **If the CPU runs out too, the job fails** and says so: "not enough memory to run this
   model, even on the CPU. Close other apps and try again, or choose a smaller model."

A model that cannot be loaded for lack of memory takes the same path as one that runs out
while running. Errors that are not about memory pass through untouched.

**A machine that runs on the CPU anyway** (no GPU, or the GPU switched off) has no step 3.
Step 2 still applies, since other warm models hold the same memory. After it the job fails
with the words of step 4. Nothing is loaded a second time, and no note is written: no GPU
was involved.

What counts as out of memory is decided in one place, `engines/device.is_oom`: CUDA's
`torch.OutOfMemoryError`, the plain `RuntimeError` that MPS raises ("MPS backend out of
memory", "Invalid buffer size"), Python's `MemoryError`, and the CPU allocator's "not enough
memory". `is_oom` counts "Invalid buffer size" only for the device "mps". The pipeline
passes "mps" whatever the device: a failed load leaves it no model to ask, and no other
device words an error that way. The check this replaces looked at the class name only and
missed MPS.

**The note.** A job that used the CPU this way finishes as done, with a note such as
"BS-RoFormer SW ran on the CPU: not enough GPU memory". It is in the manifest's `notes`, in
the job's `notes` in the API, and that model has `"device": "cpu"` in the manifest's pass
provenance. The note stays with the result: it is there after a restart and when the same
job returns from the cache. Progress messages for that model end in "(on the CPU)".

A run on the CPU is many times slower than on the GPU. It gives the same stems.

## Small machines

A machine whose budget is under 8 GB is "small" (`domain.memory.is_small`):

- **One warm model at most.** The model host drops whatever is loaded before it loads the
  next model. Elsewhere it keeps models warm up to the setting, as before, and never more
  than the budget for one run.
- **It lets go sooner.** The worker unloads its model after 60 seconds without a job, not
  600. `OPENSTEMS_IDLE_UNLOAD_SECONDS` still overrides both.

Checkpoints are also read differently, on every machine: `torch.load` is called with
`mmap=True` and `weights_only=True`, so the tensors stay in the file until the model copies
them into itself, and the state dict is emptied once it has. The weights are then in memory
once while loading, not twice. A file in the old format, which cannot be mapped, is read
whole as before.

## The override

`OPENSTEMS_MEMORY_GB=<number>` replaces the memory the engine detects: the card's on a PC
with a graphics card, the machine's on a Mac or when models run on the CPU. Everything
follows from it: the budget, the fit, the recommended set, the warm-model cap and whether the
machine counts as small. Both the API process and the worker read it. Empty, zero, negative,
non-numeric and non-finite ("inf", "nan") values are ignored. `openstems doctor` shows when
it is set, on a Mac with a line such as:

```
Memory for one model   4.5 GB (OPENSTEMS_MEMORY_GB=8)
```

It is a switch for testing and for support. It changes what the engine plans for, not what
the machine has.

## Testing on a larger machine

On the 32 GB Mac, in a development checkout (`cd engine`):

```
OPENSTEMS_MEMORY_GB=8 uv run --no-sync openstems doctor
OPENSTEMS_MEMORY_GB=8 uv run --no-sync openstems models pull --set recommended
```

For the app, set the variable where the app starts; the app passes its environment to the
engine: `OPENSTEMS_MEMORY_GB=8 pnpm dev`, or for an installed app
`OPENSTEMS_MEMORY_GB=8 /Applications/OpenStems.app/Contents/MacOS/OpenStems`.

What this shows on the real engine: the budget of 4.5 GB, `full-song` as tight, the Leap Xe
recipes as "no", the changed first download, one warm model, and the unload after a minute.

**The limit.** Pretending does not create memory pressure. The models still have all 32 GB,
so nothing runs out, nothing swaps, and the steps under "When memory runs out" never start.
A run that is marked "no" will simply work. Two things stand in for the real case:

- **With the FakeEngine**, `OPENSTEMS_FAKE_OOM` makes chosen models run out of memory on a
  pretend GPU. The value is a comma-separated list of `<model id>` or `<model id>:<mode>`;
  `all` means every model. The modes are `run` (the default: the GPU fails, the CPU works),
  `load` (loading on the GPU fails), `once` (the first GPU run fails) and `always` (the CPU
  fails too). For example `OPENSTEMS_ENGINE=fake OPENSTEMS_FAKE_OOM=bs-roformer-sw` and a
  `full-song` job ends done with the note. This acts out the order of the steps and what the
  job says. It runs no model.
- **PyTorch's own limit**, not tried here: `PYTORCH_MPS_HIGH_WATERMARK_RATIO` lowers the
  point at which MPS refuses an allocation, which may produce a real out-of-memory error on
  a large Mac.

Only an 8 GB Mac, or a 4 to 6 GB card, shows what really happens.

## Where it lives

| Question | Place |
| --- | --- |
| The rules: need, budget, fit, small, the recommended set | `engine/src/openstems/domain/memory.py` |
| The measured figures | `MEMORY_GB` in `scripts/gen_catalog.py`, written to `catalog/models.toml` |
| The memory of a device, and what is an out-of-memory error | `engine/src/openstems/engines/device.py` |
| The machine's memory and the override | `engine/src/openstems/procutil.py` |
| The fallback order and the note | `Pipeline._separate` in `engine/src/openstems/pipeline/run.py` |
| One warm model on a small machine | `ModelHost.get` in `engine/src/openstems/engines/host.py` |
| The shorter idle time | `engine/src/openstems/worker/process.py` |
| Mapped checkpoint loading | `torch_common._read_checkpoint` |
| The API fields | `Service.memory`, `model_info`, `recipe_info` in `api/service.py` |
| The doctor in its own process, and the kept report | `run_doctor_process`, `Service._refresh_machine` in `api/service.py` |
| The pretend out-of-memory | `engines/fake.py` (`fake_oom`) |

## What changes elsewhere

- **The fit needs the budget, and the budget needs the doctor**, so `/v1/models` and
  `/v1/recipes` now depend on it, where before only Settings asked for it. To keep that off
  the app's start:
  - The API process no longer runs the doctor itself. It starts `openstems doctor --json`
    in a process of its own (`run_doctor_process`), as it does for the self-test. The API
    process never imports torch, so it holds no GPU context and no GPU memory next to the
    worker. The doctor took about 2.4 seconds this way on the development machine.
  - The report is kept in the cache folder (`machine.json`, with the app's version). A
    later start answers from it at once and runs the doctor again in the background. If the
    machine changed (a card, a driver, the engine build), the new report replaces the kept
    one and the app is told to ask again (`worker.status` and `models.changed`).
  - Only the first start of a version waits for the doctor.
  - A doctor that crashes or does not finish in 120 seconds leaves one problem in the
    system info and the CPU's budget, and is not kept.
- **`/v1/system` says where models run** in `memory_kind` ("cuda", "mps" or "cpu"), as the
  settings and `OPENSTEMS_DEVICE` stand. The app words the budget by it, and asks again
  when a setting changes.
- **`openstems doctor --json`** prints the report as JSON.
- **`openstems doctor`** prints one more line, "Memory for one model".
- **The engine reads the machine's memory on Windows** (`GlobalMemoryStatusEx`), which it
  did not before. It is used for the CPU's budget.
- **On the development machine nothing else changes.** Everything fits, the recommended set
  is the seed set, and the worker keeps models warm as before.

## Measured, and estimated

Measured, all on the RTX 5070 Ti:

- The half-precision peak of every catalog model (`docs/benchmarks.md`).

Estimated, and to be replaced by measurements:

- **The full-precision factor of 2.** No model has been measured at full precision, on any
  device.
- **Every Mac figure**: the 2 GB reserve, the three-quarter share, the budgets that follow,
  and so every "fits", "tight" and "no" for a Mac.
- **Every figure for the GTX 900 and 10 series**, for the same reason.
- **The CPU's half.**
- **The activation allowance for imported models.**
- **What "small" is** (under 8 GB) and the 60 seconds. Both are choices.

## Checked, all on Windows

- The engine's lint, type-check and unit tests. `engine/tests/test_low_memory.py` covers the
  fit rule and its edges, the budget per kind of machine, the override, the fallback order
  for CUDA's error, the MPS wording and a failed load, the note in the manifest and on the
  job, one warm model and the shorter idle time, mapped loading with small files, the
  recommended set on an 8 GB Mac and on small and large cards, and the API with a real
  worker process and the FakeEngine.
- `openstems doctor` on the RTX 5070 Ti prints what it printed, plus the new line.

## What is not known

- **Whether an 8 GB Mac runs SW at all on the GPU.** The estimate says 4.0 GB against a
  budget of 4.5. Nothing has measured it.
- **Whether a real MPS out-of-memory error reaches the fallback**, or macOS swaps heavily or
  ends the process first (ADR 0014 lists the same doubt for the batch backoff).
- **Whether the CPU helps on a Mac.** The CPU and the GPU share the same memory there. The
  fallback helps only as far as MPS refuses an allocation that the CPU, with swap, can still
  make.
- **The CPU fallback with a real model.** It was run with stand-in engines and the
  FakeEngine only. Loading each of the three model families on the CPU after a GPU failure
  has not been executed.
- **How much mapped loading saves.** It was checked with small files written by
  `torch.save`, not with a catalog checkpoint, and the saving was not measured.
- **The live message** "Not enough GPU memory: ... runs on the CPU" can be lost to the
  worker's progress throttle. The "(on the CPU)" ending and the final note arrive.
- **Whether a small NVIDIA card on Windows raises out of memory at all.** Recent NVIDIA
  drivers can let CUDA spill into the PC's own memory ("CUDA - Sysmem Fallback Policy" in the
  NVIDIA Control Panel) instead of refusing the allocation. Then a model that is too large
  would run on the GPU, slowly, and never reach the steps above. This is from the driver's
  documentation as remembered, not checked here. Whoever tests a 4 to 6 GB card should note
  whether a run marked "no" ends with the CPU note or just takes very long.
- **What the app says is a possibility, not a promise.** The engine never consults the fit:
  it always tries the GPU first. So for "no" the app says "It may not fit. If it does not,
  it runs on the CPU, which is much slower."

## For whoever tests on a small machine

1. `openstems doctor`: note the "Memory for one model" line.
2. Download the recommended set and run `full-song` on a song of a few minutes.
3. Then run a recipe marked as not fitting, such as `vocals-instrumental` on an 8 GB Mac.
4. Send Settings > Export diagnostics with the machine's model and memory, and say for each
   run whether it finished, how long it took, and whether the job carried the CPU note.
