"""Loopback-only FastAPI surface for the desktop shell."""

from __future__ import annotations

import ipaddress
import os
import secrets
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse

from lke.core import CommandGateway, Database
from lke.core.errors import ConflictError, IdempotencyConflictError, LKEError, NotFoundError, ValidationError
from lke.retrieval import ContextCompiler


_TAURI_ORIGINS = {"tauri://localhost", "https://tauri.localhost", "http://tauri.localhost"}
_DEV_ORIGINS = {"http://127.0.0.1:5173", "http://localhost:5173"}
_MAX_API_REQUEST_BYTES = 11 * 1024 * 1024


class WorkspaceCreate(BaseModel):
    workspace_id: str | None = None
    name: str = Field(min_length=1, max_length=200)


class BranchCreate(BaseModel):
    branch_id: str = Field(min_length=1, max_length=100)
    parent_branch_id: str = "main"
    expected_revision: int = Field(ge=0)
    idempotency_key: str = Field(min_length=1, max_length=200)
    reason: str = "Create scenario branch"


class CommandRequest(BaseModel):
    branch_id: str = "main"
    expected_revision: int = Field(ge=0)
    idempotency_key: str = Field(min_length=1, max_length=200)
    command_type: str
    payload: dict[str, Any]
    reason: str = Field(min_length=1, max_length=1000)


class ContextRequest(BaseModel):
    branch_id: str = "main"
    actor_entity_id: str = Field(min_length=1, max_length=100)
    as_of_narrative_order: int = Field(ge=0)
    token_budget: int = Field(default=4000, ge=64, le=100000)


def _loopback(host: str | None) -> bool:
    if not host:
        return False
    try:
        return ipaddress.ip_address(host.split("%", 1)[0]).is_loopback
    except ValueError:
        return host.lower() == "localhost"


def create_app(database: Database | None = None, auth_token: str | None = None) -> FastAPI:
    data_dir = Path(os.environ.get("LKE_DATA_DIR", Path.home() / "AppData" / "Local" / "LKE"))
    db = database or Database(data_dir / "knowledge.sqlite3")
    gateway = CommandGateway(db)
    context_compiler = ContextCompiler(db)
    allowed_origins = _TAURI_ORIGINS | (_DEV_ORIGINS if os.environ.get("LKE_DEV_MODE") == "1" else set())
    token = auth_token or os.environ.get("LKE_API_TOKEN") or secrets.token_urlsafe(32)

    app = FastAPI(title="Living Knowledge Engine", version="0.1.0", docs_url=None, redoc_url=None)
    app.state.database = db
    app.state.gateway = gateway
    app.state.context_compiler = context_compiler
    app.state.auth_token = token

    @app.middleware("http")
    async def protect_local_api(request: Request, call_next):
        if not _loopback(request.client.host if request.client else None):
            return JSONResponse({"detail": "Loopback access only"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin not in allowed_origins:
            return JSONResponse({"detail": "Origin is not allowed"}, status_code=403)
        if request.method == "OPTIONS":
            requested_method = request.headers.get("access-control-request-method", "").upper()
            requested_headers = {item.strip().lower() for item in request.headers.get("access-control-request-headers", "").split(",") if item.strip()}
            if requested_method not in {"GET", "POST"} or not requested_headers <= {"authorization", "content-type"}:
                return JSONResponse({"detail": "Preflight request is not allowed"}, status_code=403)
            return Response(status_code=204, headers={
                "Access-Control-Allow-Origin": origin or "null",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
                "Access-Control-Max-Age": "300",
                "Vary": "Origin",
            })
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > _MAX_API_REQUEST_BYTES:
            return JSONResponse({"detail": "Request body is too large"}, status_code=413)
        if request.url.path != "/api/v1/health" and request.headers.get("authorization") != f"Bearer {token}":
            return JSONResponse({"detail": "Authentication required"}, status_code=401)
        response = await call_next(request)
        if origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        return await request_validation_exception_handler(request, exc)

    @app.exception_handler(LKEError)
    async def lke_error_handler(request: Request, exc: LKEError):
        if isinstance(exc, (ConflictError, IdempotencyConflictError)):
            status = 409
        elif isinstance(exc, NotFoundError):
            status = 404
        elif isinstance(exc, ValidationError):
            status = 422
        else:
            status = 400
        return JSONResponse({"detail": str(exc)}, status_code=status)

    @app.get("/api/v1/health")
    def health():
        return {"ok": True, "service": "lke", "api_version": "v1"}

    @app.post("/api/v1/workspaces", status_code=201)
    def create_workspace(body: WorkspaceCreate):
        return gateway.create_workspace(body.name, body.workspace_id)

    @app.get("/api/v1/workspaces")
    def list_workspaces():
        return gateway.list_workspaces()

    @app.post("/api/v1/workspaces/{workspace_id}/branches", status_code=201)
    def create_branch(workspace_id: str, body: BranchCreate):
        return gateway.create_branch(
            workspace_id=workspace_id,
            parent_branch_id=body.parent_branch_id,
            branch_id=body.branch_id,
            expected_revision=body.expected_revision,
            idempotency_key=body.idempotency_key,
            reason=body.reason,
        )

    @app.get("/api/v1/workspaces/{workspace_id}/branches")
    def list_branches(workspace_id: str):
        return gateway.list_branches(workspace_id)

    @app.get("/api/v1/workspaces/{workspace_id}/entities")
    def list_entities(workspace_id: str, branch_id: str = "main", q: str | None = None):
        if q:
            return gateway.search_entities(workspace_id, branch_id, q)
        return gateway.list_entities(workspace_id, branch_id)

    @app.get("/api/v1/workspaces/{workspace_id}/relations")
    def list_relations(workspace_id: str, branch_id: str = "main"):
        return gateway.relations(workspace_id, branch_id)

    @app.get("/api/v1/workspaces/{workspace_id}/claims")
    def list_claims(workspace_id: str, branch_id: str = "main"):
        return gateway.list_claims(workspace_id, branch_id)

    @app.post("/api/v1/workspaces/{workspace_id}/context")
    def compile_context(workspace_id: str, body: ContextRequest):
        return context_compiler.compile_actor_context(
            workspace_id,
            body.branch_id,
            body.actor_entity_id,
            as_of_narrative_order=body.as_of_narrative_order,
            token_budget=body.token_budget,
        )

    @app.get("/api/v1/workspaces/{workspace_id}/sources")
    def list_or_search_sources(workspace_id: str, q: str | None = None):
        return gateway.search_sources(workspace_id, q) if q else gateway.list_sources(workspace_id)

    @app.get("/api/v1/workspaces/{workspace_id}/revisions")
    def revisions(workspace_id: str, branch_id: str = "main"):
        return gateway.revisions(workspace_id, branch_id)

    @app.get("/api/v1/workspaces/{workspace_id}/revision")
    def current_revision(workspace_id: str, branch_id: str = "main"):
        return {"workspace_id": workspace_id, "branch_id": branch_id, "revision": gateway.current_revision(workspace_id, branch_id)}

    @app.post("/api/v1/workspaces/{workspace_id}/commands")
    def execute_command(workspace_id: str, body: CommandRequest):
        return gateway.execute(
            workspace_id=workspace_id,
            branch_id=body.branch_id,
            idempotency_key=body.idempotency_key,
            expected_revision=body.expected_revision,
            command_type=body.command_type,
            payload=body.payload,
            actor="user",
            reason=body.reason,
        )

    return app


def main() -> None:
    import uvicorn

    port = int(os.environ.get("LKE_API_PORT", "48123"))
    uvicorn.run(create_app(), host="127.0.0.1", port=port, access_log=False)
