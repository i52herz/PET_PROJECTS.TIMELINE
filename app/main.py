from __future__ import annotations

import logging
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import config
from app.db import get_db, seed
from app.routers import auth, roadmaps

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("roadmap")

_CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' https://api.fontshare.com https://cdn.fontshare.com; "
    "font-src 'self' https://api.fontshare.com https://cdn.fontshare.com; "
    "img-src 'self' data:; "
    "connect-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'none'; "
    "form-action 'self'"
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if config.ENV == "dev":
        seed()
    yield


app = FastAPI(title="Goal Roadmap Builder v3", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(config.BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(config.BASE_DIR / "templates"))

app.include_router(auth.router)
app.include_router(roadmaps.router)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    if request.url.path.startswith("/static"):
        return await call_next(request)
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("Unhandled error: %s %s", request.method, request.url.path)
        raise
    duration_ms = (time.perf_counter() - start) * 1000
    logger.info("%s %s -> %s (%.1f ms)", request.method, request.url.path, response.status_code, duration_ms)
    return response


@app.middleware("http")
async def limit_payload_size(request: Request, call_next):
    if request.method not in ("POST", "PUT"):
        return await call_next(request)
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) <= config.MAX_PAYLOAD_BYTES:
                return await call_next(request)
            return JSONResponse({"detail": "Слишком большой запрос"}, status_code=413)
        except ValueError:
            pass
    body = await request.body()
    if len(body) > config.MAX_PAYLOAD_BYTES:
        return JSONResponse({"detail": "Слишком большой запрос"}, status_code=413)
    return await call_next(request)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    else:
        response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Content-Security-Policy", _CONTENT_SECURITY_POLICY)
    if config.ENV == "prod":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


@app.exception_handler(Exception)
async def unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled exception: %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "Внутренняя ошибка сервера"}, status_code=500)


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(request, "index.html", {"request": request})


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> FileResponse:
    return FileResponse(config.BASE_DIR / "static" / "favicon.ico")


@app.get("/api/health")
def health(session: Session = Depends(get_db)) -> dict[str, str]:
    try:
        session.execute(text("SELECT 1"))
    except Exception as exc:
        logger.exception("Health-check: БД недоступна")
        raise HTTPException(status_code=503, detail="Database unavailable") from exc
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8000,
        reload=config.ENV == "dev",
    )
