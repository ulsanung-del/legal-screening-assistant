import asyncio
import logging
import time

from fastapi import APIRouter, BackgroundTasks, HTTPException

from backend.api.schemas import (
    ErrorResponse,
    EmailDraftRequest,
    EmailDraftResponse,
    JobStatusResponse,
    ScreenRequest,
    ScreeningResult,
)
from backend.config import get_settings
from backend.services.job_store import get_job_store
from backend.services.metrics import get_metrics_store
from backend.services.pipeline_service import run_screening
from backend.services.rate_limiter import get_rate_limiter

router = APIRouter()
logger = logging.getLogger(__name__)

_job_locks: dict[str, asyncio.Lock] = {}


def _cleanup_jobs() -> None:
    settings = get_settings()
    store = get_job_store()
    _ = store.cleanup_expired_jobs(settings.job_ttl_minutes)

    expired_lock_ids = [
        job_id
        for job_id, lock in _job_locks.items()
        if not lock.locked() and store.get(job_id) is None
    ]
    for job_id in expired_lock_ids:
        _job_locks.pop(job_id, None)


def _get_job_lock(job_id: str) -> asyncio.Lock:
    lock = _job_locks.get(job_id)
    if lock is None:
        lock = asyncio.Lock()
        _job_locks[job_id] = lock
    return lock


async def _run_screening_background(job_id: str, raw_text: str) -> None:
    lock = _get_job_lock(job_id)
    if lock.locked():
        get_rate_limiter().release_screening()
        return

    async with lock:
        started = time.perf_counter()
        metrics = get_metrics_store()
        try:
            store = get_job_store()
            record = store.get(job_id)
            if record is None:
                return
            if record.status == "completed" and record.screening_result:
                return

            store.set_progress(job_id, 25, "langgraph")

            # run_screening is intentionally kept synchronous for now because it
            # wraps LangGraph, Gemini, RAG, and embedding calls. Offloading it to
            # the executor keeps the FastAPI event loop responsive. This function
            # is the future queue migration point if Redis/Celery is introduced.
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(None, run_screening, job_id, raw_text)

            duration_ms = (time.perf_counter() - started) * 1000
            metrics.record_screen(duration_ms)
            if store.get(job_id) is not None:
                store.set_completed(job_id, result)
        except Exception:
            logger.exception("Screening job failed: job_id=%s", job_id)
            duration_ms = (time.perf_counter() - started) * 1000
            metrics.record_screen(duration_ms, error=True)
            if store.get(job_id) is not None:
                store.set_failed(job_id, "스크리닝 처리 중 오류가 발생했습니다.")
        finally:
            get_rate_limiter().release_screening()


@router.post("/screen", response_model=JobStatusResponse, status_code=202)
async def screen_contract(body: ScreenRequest, background_tasks: BackgroundTasks) -> JobStatusResponse:
    _cleanup_jobs()
    settings = get_settings()
    store = get_job_store()
    try:
        record = store.require(body.job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.") from None

    if record.status == "completed" and record.screening_result:
        return store.to_status_dto(body.job_id)
    if record.status == "processing":
        return store.to_status_dto(body.job_id)

    if not get_rate_limiter().try_acquire_screening(settings.max_concurrent_screenings):
        raise HTTPException(
            status_code=429,
            detail=ErrorResponse(
                code="TOO_MANY_SCREENINGS",
                message="동시 스크리닝 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
            ).model_dump(),
        )

    try:
        store.set_processing(body.job_id)
        if settings.local_demo_mode:
            await _run_screening_background(body.job_id, record.raw_text)
        else:
            background_tasks.add_task(_run_screening_background, body.job_id, record.raw_text)
    except Exception:
        get_rate_limiter().release_screening()
        raise
    return store.to_status_dto(body.job_id)


@router.get("/jobs/{job_id}", response_model=JobStatusResponse)
def get_job_status(job_id: str) -> JobStatusResponse:
    _cleanup_jobs()
    store = get_job_store()
    try:
        return store.to_status_dto(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.") from None


@router.get("/result/{job_id}", response_model=ScreeningResult)
def get_result(job_id: str) -> ScreeningResult:
    _cleanup_jobs()
    store = get_job_store()
    record = store.get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
    if record.screening_result is None:
        raise HTTPException(
            status_code=404,
            detail="스크리닝 결과가 없습니다. POST /api/screen을 먼저 호출하세요.",
        )
    return record.screening_result


@router.post("/email-draft", response_model=EmailDraftResponse)
def get_email_draft(body: EmailDraftRequest) -> EmailDraftResponse:
    _cleanup_jobs()
    store = get_job_store()
    record = store.get(body.job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
    if record.screening_result is None:
        raise HTTPException(status_code=404, detail="스크리닝 결과가 없습니다.")
    return EmailDraftResponse(
        job_id=body.job_id,
        email_draft=record.screening_result.output_email,
    )
