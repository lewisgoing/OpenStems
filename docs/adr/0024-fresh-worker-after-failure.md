# 0024: A job that fails unexpectedly leaves the next one a fresh worker

Date: 2026-11-24. Status: accepted. Changes `PLAN.md`'s "one long-lived GPU process".

## What happened

**Seen.** On 0.4.0, on the owner's Windows PC, a full-song job failed 0.13 s after it
started: "AttributeError: module 'torch' has no attribute 'device'". The owner's screenshot
shows the same message on an Every stem job, which is no longer in the queue's record. The
worker had been running since 9:05, and this was the first job in the record since then.
The owner restarted the app and retried the same job. It finished in 28 s in the new worker.

**Not seen.** The traceback. The worker printed it to its standard error, and the app keeps
only the last lines of that in memory. So the first error is not known.

**Most likely.**
- The worker imports PyTorch lazily, on its first job. A first import takes about 2 s on
  that machine, so 0.13 s means torch was already loaded, broken, in that worker. The Every
  stem job had probably failed before it.
- About 20 minutes later C: had 0.8 GB free, and Windows could promise only 2.3 GB more of
  its 62 GB. Loading PyTorch's CUDA libraries promises several GB. When that cannot be had,
  Windows fails the load with WinError 1455, "the paging file is too small".

**Reproduced** in a separate process on that machine, with the installed 0.4.0 engine:
1. A first import of torch fails while loading a DLL.
2. Python drops `torch` from `sys.modules` but keeps the submodules it had loaded
   (`torch._utils` and others). They still hold the module that failed, which never got
   `device`.
3. A second import loads PyTorch on top of them.
4. From then on `torch.cuda.get_device_properties`, `mem_get_info`, `memory_allocated`,
   `reset_peak_memory_stats` and `synchronize` raise exactly that AttributeError, in every
   job that process runs.

The pipeline itself made that second import. It asked whether the first error was memory
running out (`run._out_of_memory`), and asking imported `engines.device`, which imports
torch.

## Decision

- **A job that fails with an unexpected error ends the worker** (`worker.process.run_job`).
  "Unexpected" is any exception that is not a `DomainError` (the user's errors, such as a
  missing file, and running out of memory after the CPU fallback) and not a cancel. Its
  "failed" event says so. The job manager then sends nothing more and waits for "ready"
  (`JobManager._on_failed`), and the supervisor waits for the old process to exit (killing
  it after 10 s) and starts a fresh one (`WorkerSupervisor._replace`). That is not counted
  as a crash, and the other jobs are not failed. The next job loads PyTorch in a clean
  process. This covers more than a failed import: a CUDA error also spoils the GPU's context
  for the rest of the process.
- **Asking about memory never imports PyTorch.** With `torch` not loaded, no error is a
  model short of memory, so `_out_of_memory` answers no and the error goes out as it was
  raised.
- **The traceback goes to the engine's log.** The worker sends it with the "failed" event,
  and the API process writes it to `engine.log` with the job's id.
- **WinError 1455 says what to do**: "Windows ran out of memory (its paging file is full).
  Close some programs or free space on the system drive (usually C:), then try again." The
  DLL Windows names is in the log. That covers both forms the error takes:
  - PyTorch's own DLL loader raises it with the code (`OSError.winerror`).
  - The DLL behind `torch._C`, which Python loads itself, fails as an ImportError with only
    Windows' sentence in the machine's language (`worker.process.paging_file_full`).

## Cost

After an unexpected failure the warm models are gone, so the next job loads its model
again. That costs a few seconds, and only after an error that is already rare. Purging
`torch` and its submodules from `sys.modules` and importing it again would keep the
process, but an extension module such as `torch._C` cannot be loaded twice in one process.
A fresh process is the only clean state.

## Tests

- `tests/test_api.py::test_a_job_that_breaks_the_worker_leaves_the_next_job_a_fresh_one`
  runs a real worker process with the FakeEngine. `OPENSTEMS_FAKE_IMPORT_FAILS=<model id>`
  makes loading that model fail the way the import does, and leaves the process failing
  every later load. With the old worker, the second job fails with the AttributeError.
- `tests/test_low_memory.py::test_a_failed_import_of_torch_is_not_tried_again` makes a real
  import of torch fail at `torch._C` in a subprocess. It then checks that the
  out-of-memory question does not import torch again. It fails on 0.4.0.
- `tests/test_worker.py` covers which failures end the process, and the 1455 message.

## Mac

The change is the same on both systems: the worker, the supervisor and the job manager have
no platform branch. The 1455 message is for Windows' error only. macOS grows its swap as it
needs to, and a Mac short of memory ends processes instead, which the supervisor already
treats as a crash. Nothing here has been seen on a Mac. The Mac CI job runs the same tests.
