from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.api.routes import health, metrics, screen, upload
from backend.api.schemas import ErrorResponse
from backend.config import get_settings
from backend.services.rate_limiter import get_rate_limiter

settings = get_settings()
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Deepgle Legal API",
    version="0.1.0",
    description="1차 법무 계약서 스크리닝 API",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def preload_local_demo_pipeline() -> None:
    if not settings.local_demo_mode:
        return
    loop = asyncio.get_running_loop()
    try:
        from backend.services.pipeline_service import get_screening_pipeline

        await loop.run_in_executor(None, get_screening_pipeline)
        logger.info("[LocalDemo] screening pipeline preloaded")
    except Exception:
        logger.warning("[LocalDemo] pipeline preload failed; first request will retry", exc_info=True)

PROTECTED_API_PREFIXES = (
    "/api/upload",
    "/api/screen",
    "/api/result",
    "/api/jobs",
    "/api/email-draft",
    "/api/metrics",
)
DEMO_TOKEN_HEADER = "x-demo-token"


def _client_id(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    return request.client.host if request.client else "unknown"


@app.middleware("http")
async def demo_api_protection_middleware(request: Request, call_next):
    if (
        request.method != "OPTIONS"
        and settings.demo_api_token
        and any(request.url.path.startswith(prefix) for prefix in PROTECTED_API_PREFIXES)
    ):
        token = request.headers.get(DEMO_TOKEN_HEADER)
        if token != settings.demo_api_token:
            return JSONResponse(
                status_code=401,
                content=ErrorResponse(
                    code="UNAUTHORIZED",
                    message="데모 API 토큰이 없거나 올바르지 않습니다.",
                ).model_dump(),
            )
    if request.method == "POST" and request.url.path == "/api/upload":
        decision = get_rate_limiter().allow_upload(
            _client_id(request),
            settings.uploads_per_minute,
        )
        if not decision.allowed:
            return JSONResponse(
                status_code=429,
                headers={"Retry-After": str(decision.retry_after_seconds)},
                content=ErrorResponse(
                    code="RATE_LIMITED",
                    message="업로드 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
                ).model_dump(),
            )
    return await call_next(request)


api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(upload.router, tags=["upload"])
api_router.include_router(screen.router, tags=["screen"])
api_router.include_router(metrics.router, tags=["metrics"])
app.include_router(api_router, prefix="/api")


@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    logger.warning("HTTP exception handled: status=%s", exc.status_code)
    if isinstance(exc.detail, dict) and "code" in exc.detail:
        return JSONResponse(status_code=exc.status_code, content=exc.detail)
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(
            code=f"HTTP_{exc.status_code}",
            message=str(exc.detail),
        ).model_dump(),
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled internal server error")
    return JSONResponse(
        status_code=500,
        content=ErrorResponse(
            code="INTERNAL_ERROR",
            message="서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
        ).model_dump(),
    )
