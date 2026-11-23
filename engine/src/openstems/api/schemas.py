"""Request and response models of the local API. They define the OpenAPI schema that
the TypeScript client in ``app/`` is generated from."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

JobStateName = Literal["queued", "preparing", "running", "writing", "done", "failed", "cancelled"]
Quality = Literal["fast", "balanced", "best"]
OutputFormat = Literal["wav32f", "wav24", "flac", "mp3"]


class Health(BaseModel):
    status: Literal["ok"] = "ok"
    version: str
    fake_engine: bool


class WorkerStatus(BaseModel):
    alive: bool
    ready: bool
    pid: int | None = None
    restarts: int = 0
    current_job: str | None = None


class SystemInfo(BaseModel):
    version: str
    python: str
    torch: str | None = None
    # The names are older than AMD and Mac support. `cuda_available` means "a GPU works",
    # whichever backend it is; on a Mac (`mps`) `vram_gb` is the machine's unified memory.
    cuda_available: bool = False
    cuda_version: str | None = None
    gpu_backend: Literal["cuda", "rocm", "mps"] | None = None
    gpu_backend_version: str | None = None
    gpu_name: str | None = None
    vram_gb: float | None = None
    ffmpeg: str | None = None
    ffmpeg_decode_ok: bool = False
    problems: list[str] = []
    notes: list[str] = []
    fake_engine: bool = False
    worker: WorkerStatus
    config_dir: str
    logs_dir: str


class TrackInfo(BaseModel):
    path: str
    name: str
    ok: bool = True
    error: str | None = None
    duration: float = 0.0
    sample_rate: int = 0
    channels: int = 0
    codec: str = ""
    container: str = ""
    bytes: int = 0


class RegisterTracks(BaseModel):
    paths: list[str] = Field(description="Files or folders. Folders expand to their media files.")


class TrackList(BaseModel):
    tracks: list[TrackInfo]


class RecipePass(BaseModel):
    id: str
    models: list[str]
    input: str


class RecipeInfo(BaseModel):
    id: str
    name: str
    use_case: str
    description: str
    version: int
    builtin: bool
    experimental: bool
    selectable_outputs: bool
    single_model: bool = False
    outputs: list[str]
    models: list[str]
    passes: list[RecipePass]
    missing_models: list[str]
    download_bytes: int = 0
    supports_sum_to_mix: bool


class RecipeList(BaseModel):
    recipes: list[RecipeInfo]


class DownloadState(BaseModel):
    state: Literal["downloading", "verifying", "installed", "failed", "cancelled"]
    done: int
    total: int
    error: str | None = None


class ModelInfo(BaseModel):
    id: str
    name: str
    architecture: str
    loader: str
    license: str
    stems: list[str]
    use_cases: list[str]
    bytes: int
    status: Literal["installed", "unverified", "partial", "missing"]
    seed: bool
    experimental: bool
    custom: bool
    notes: str
    used_by: list[str] = []
    download: DownloadState | None = None


class ModelList(BaseModel):
    models: list[ModelInfo]
    models_dir: str
    installed_bytes: int


class VerifyResult(BaseModel):
    id: str
    ok: bool
    problems: list[str]


class ImportModel(BaseModel):
    checkpoint: str
    config: str
    architecture: Literal["bs_roformer", "mel_band_roformer", "mdx23c"]
    id: str | None = None
    name: str | None = None
    acknowledge_pickle_risk: bool = Field(
        default=False, description="Must be true: checkpoints are pickles."
    )


class JobOptions(BaseModel):
    sum_to_mix: bool | None = None
    output_format: OutputFormat | None = None
    match_source_rate: bool | None = None
    outputs: list[str] | None = Field(default=None, description="Subset of output stems.")
    trim_silence: bool | None = None
    normalize: bool | None = None
    midi_stems: list[str] | None = None
    force: bool | None = None


class CreateJob(BaseModel):
    path: str
    recipe: str | None = Field(default=None, description="Recipe id.")
    model: str | None = Field(default=None, description="Run a single model instead.")
    quality: Quality | None = None
    options: JobOptions = JobOptions()
    start: bool | None = Field(
        default=None,
        description="Start as soon as the GPU is free, or wait for Start. "
        "Default: the auto_start setting.",
    )


class CreateBatch(BaseModel):
    paths: list[str]
    recipe: str | None = None
    model: str | None = None
    quality: Quality | None = None
    options: JobOptions = JobOptions()
    start: bool | None = Field(
        default=None,
        description="Start as soon as the GPU is free, or wait for Start. "
        "Default: the auto_start setting.",
    )


class CreateLink(BaseModel):
    url: str = Field(description="The web address of a song's page, or of a media file.")
    recipe: str | None = None
    model: str | None = None
    quality: Quality | None = None
    options: JobOptions = JobOptions()
    start: bool | None = Field(
        default=None,
        description="Once fetched: start as soon as the GPU is free, or wait for Start. "
        "Default: the auto_start setting.",
    )


class LinkInfo(BaseModel):
    """A song on its way from a link to the queue. It becomes a job once it is fetched."""

    id: str
    url: str
    name: str = Field(description="The song's title once known; the site's name before.")
    state: Literal["waiting", "resolving", "downloading", "failed"]
    progress: float
    error: str | None = None
    created_at: float


class LinkList(BaseModel):
    links: list[LinkInfo]


class CreateMix(BaseModel):
    paths: list[str] = Field(description="Two or more stem files of one song.")


class MixInfo(BaseModel):
    path: str
    name: str
    label: str
    stems: list[str]
    samples: int
    sample_rate: int


class StemFile(BaseModel):
    name: str
    file: str
    path: str
    peaks: str | None = None
    midi: str | None = None
    samples: int | None = None
    sample_rate: int | None = None


class JobInfo(BaseModel):
    id: str
    track_path: str
    track_name: str
    recipe_id: str
    recipe_name: str
    quality: str
    state: JobStateName
    progress: float
    message: str
    error: str | None = None
    cached: bool
    output_dir: str | None = None
    options: dict[str, Any] = {}
    stems: list[StemFile] = []
    analysis: dict[str, Any] = {}
    queue_position: int | None = None
    held: bool = Field(default=False, description="Queued, and waiting for the user's Start.")
    created_at: float
    started_at: float | None = None
    finished_at: float | None = None


class JobList(BaseModel):
    jobs: list[JobInfo]


class Reorder(BaseModel):
    ids: list[str] = Field(description="Every queued job id, in the new order.")


class Removed(BaseModel):
    removed: int


class SettingsModel(BaseModel):
    models_dir: str
    output_dir: str
    cache_dir: str
    output_format: OutputFormat
    match_source_rate: bool
    naming_template: str
    default_recipe: str
    default_quality: Quality
    sum_to_mix: bool
    trim_silence: bool
    normalize: bool
    detect_tempo_key: bool
    write_midi: bool
    watch_folder: str
    watch_enabled: bool
    vram_budget_gb: float
    use_gpu: bool
    auto_start: bool


class SettingsPatch(BaseModel):
    models_dir: str | None = None
    output_dir: str | None = None
    cache_dir: str | None = None
    output_format: OutputFormat | None = None
    match_source_rate: bool | None = None
    naming_template: str | None = None
    default_recipe: str | None = None
    default_quality: Quality | None = None
    sum_to_mix: bool | None = None
    trim_silence: bool | None = None
    normalize: bool | None = None
    detect_tempo_key: bool | None = None
    write_midi: bool | None = None
    watch_folder: str | None = None
    watch_enabled: bool | None = None
    vram_budget_gb: float | None = None
    use_gpu: bool | None = None
    auto_start: bool | None = None


class StemSetInfo(BaseModel):
    directory: str
    track_name: str
    track_path: str
    track_hash: str
    recipe_id: str
    recipe_name: str
    created_at: str
    analysis: dict[str, Any] = {}
    stems: list[StemFile]
    source_exists: bool = True


class StemSetList(BaseModel):
    stem_sets: list[StemSetInfo]


class Rebuilt(BaseModel):
    stem_sets: int


class Peaks(BaseModel):
    version: int
    sample_rate: int
    samples: int
    samples_per_peak: int
    length: int
    peak: float = 0.0
    data: list[float]


class Diagnostics(BaseModel):
    path: str


class SelfTestOp(BaseModel):
    name: str
    ok: bool
    error: float | None = None
    detail: str = ""


class SelfTestModel(BaseModel):
    id: str
    ok: bool
    difference_db: float | None = None
    half_precision_db: float | None = None
    gpu_seconds: float | None = None
    cpu_seconds: float | None = None
    detail: str = ""


class SelfTest(BaseModel):
    """GPU against CPU: single operations, then one short separation per architecture."""

    ok: bool
    torch: str | None = None
    gpu_backend: Literal["cuda", "rocm", "mps"] | None = None
    gpu_backend_version: str | None = None
    gpu_name: str | None = None
    gpu_available: bool = False
    ops: list[SelfTestOp] = []
    models: list[SelfTestModel] = []
    problems: list[str] = []
    notes: list[str] = []


class ErrorBody(BaseModel):
    detail: str
