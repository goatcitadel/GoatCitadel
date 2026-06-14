import hmac
import ipaddress
import json
import hashlib
import os
import platform
import socket
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse


def utc_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def flatten_messages(messages: List[Dict[str, Any]]) -> str:
    parts: List[str] = []
    for message in messages:
        role = str(message.get("role", "user"))
        content = message.get("content", "")
        if isinstance(content, str):
            parts.append(f"{role}: {content}")
            continue
        if isinstance(content, list):
            text_bits: List[str] = []
            for item in content:
                if isinstance(item, dict):
                    maybe_text = item.get("text")
                    if isinstance(maybe_text, str):
                        text_bits.append(maybe_text)
            parts.append(f"{role}: {' '.join(text_bits)}")
    return "\n".join(parts).strip()


def load_manifest() -> List[Dict[str, Any]]:
    raw_manifest_path = os.environ.get("GOATCITADEL_NPU_MANIFEST_PATH", "").strip()
    if raw_manifest_path:
        manifest_path = Path(raw_manifest_path).expanduser()
    else:
        manifest_path = Path(__file__).parent / "model-manifest.json"
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        payload = {"models": []}
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Invalid manifest JSON: {manifest_path} ({error})") from error

    models = payload.get("models", [])
    if not isinstance(models, list):
        return []
    normalized: List[Dict[str, Any]] = []
    for model in models:
        if not isinstance(model, dict):
            continue
        model_id = str(model.get("modelId", "")).strip()
        if not model_id:
            continue
        normalized.append(
            {
                "modelId": model_id,
                "label": str(model.get("label", model_id)),
                "family": str(model.get("family", "other")),
                "source": str(model.get("source", "local")),
                "path": str(model.get("path")) if model.get("path") else None,
                "sha256": str(model.get("sha256")) if model.get("sha256") else None,
                "default": bool(model.get("default", False)),
                "requiresQnn": bool(model.get("requiresQnn", False)),
                "contextWindow": int(model.get("contextWindow", 0)) or None,
                "enabled": bool(model.get("enabled", True)),
            }
        )
    return normalized


def detect_capabilities() -> Dict[str, Any]:
    details: List[str] = []
    onnxruntime_available = False
    onnxruntime_genai_available = False
    qnn_available = False
    python_version = platform.python_version()

    try:
        import onnxruntime as ort  # type: ignore

        onnxruntime_available = True
        providers = ort.get_available_providers()
        qnn_available = "QNNExecutionProvider" in providers
        details.append(f"onnxruntime providers={providers}")
    except Exception:  # pragma: no cover - depends on host env
        details.append("onnxruntime unavailable")

    try:
        import onnxruntime_genai  # type: ignore  # noqa: F401

        onnxruntime_genai_available = True
        details.append("onnxruntime-genai available")
    except Exception:  # pragma: no cover - depends on host env
        details.append("onnxruntime-genai unavailable")

    machine = platform.machine().lower()
    system = platform.system().lower()
    is_windows_arm64 = system == "windows" and machine in {"arm64", "aarch64"}

    fallback_configured = bool(os.environ.get("GOATCITADEL_NPU_FALLBACK_URL", "").strip())
    local_inference_ready = onnxruntime_available and onnxruntime_genai_available
    supported = local_inference_ready and (qnn_available or not is_windows_arm64)
    if not supported and is_windows_arm64:
        details.append("Windows ARM64 detected; install ORT/GenAI with QNN support for NPU acceleration.")
    if fallback_configured:
        details.append("fallback proxy configured; responses are not local NPU inference unless local adapter is used")

    return {
        "platform": platform.platform(),
        "arch": machine,
        "isWindowsArm64": is_windows_arm64,
        "pythonVersion": python_version,
        "onnxRuntimeAvailable": onnxruntime_available,
        "onnxRuntimeGenAiAvailable": onnxruntime_genai_available,
        "qnnExecutionProviderAvailable": qnn_available,
        "supported": supported,
        "localInferenceReady": local_inference_ready,
        "streamingChatCompletions": local_inference_ready,
        "fallbackProxyConfigured": fallback_configured,
        "details": details,
    }


class RuntimeState:
    def __init__(self) -> None:
        self.started_at = utc_iso()
        self.models = load_manifest()
        self.capability = detect_capabilities()
        self.backend = "qnn" if self.capability.get("qnnExecutionProviderAvailable") else (
            "cpu" if self.capability.get("onnxRuntimeAvailable") else "unknown"
        )
        default_model = next((m for m in self.models if m.get("default") and m.get("enabled")), None)
        if default_model is None:
            default_model = next((m for m in self.models if m.get("enabled")), None)
        self.active_model_id: Optional[str] = default_model.get("modelId") if default_model else None
        self.last_error: Optional[str] = None

    def status(self) -> Dict[str, Any]:
        return {
            "status": "ok",
            "startedAt": self.started_at,
            "activeModelId": self.active_model_id,
            "backend": self.backend,
            "capability": self.capability,
            "models": len([m for m in self.models if m.get("enabled")]),
            "updatedAt": utc_iso(),
            "lastError": self.last_error,
        }

    def enabled_models(self) -> List[Dict[str, Any]]:
        return [self.with_readiness(m) for m in self.models if m.get("enabled")]

    def resolve_model(self, model_id: Optional[str]) -> Dict[str, Any]:
        target = model_id or self.active_model_id
        for model in self.enabled_models():
            if model.get("modelId") == target:
                return model
        raise HTTPException(
            status_code=404,
            detail={"error": {"message": f"Unknown model: {target}", "type": "invalid_request_error"}},
        )

    def with_readiness(self, model: Dict[str, Any]) -> Dict[str, Any]:
        path_value = model.get("path")
        expected_sha = str(model.get("sha256") or "").strip().lower()
        if not path_value:
            return {**model, "readiness": "missing_path", "backend": self.backend}
        model_path = Path(str(path_value)).expanduser()
        if not model_path.exists():
            return {**model, "readiness": "missing_path", "backend": self.backend}
        if expected_sha:
            actual_sha = sha256_path(model_path)
            if actual_sha != expected_sha:
                return {**model, "readiness": "hash_mismatch", "backend": self.backend}
        return {**model, "readiness": "ready", "backend": self.backend}


app = FastAPI(title="GoatCitadel NPU Sidecar", version="0.1.0")
STATE = RuntimeState()
FALLBACK_BASE_URL = os.environ.get("GOATCITADEL_NPU_FALLBACK_URL", "").strip().rstrip("/")
FALLBACK_API_KEY = os.environ.get("GOATCITADEL_NPU_FALLBACK_API_KEY", "").strip()
TIMEOUT_SECONDS = float(os.environ.get("GOATCITADEL_NPU_REQUEST_TIMEOUT_SECONDS", "60"))

# Shared-secret bearer token guarding the inference + proxy surface. When unset the sidecar only
# binds loopback (see resolve_listen_host) so the open default stays local-only.
AUTH_TOKEN = os.environ.get("GOATCITADEL_NPU_AUTH_TOKEN", "").strip()
# Explicit opt-in required before the sidecar will bind a non-loopback host.
ALLOW_REMOTE = os.environ.get("GOATCITADEL_NPU_ALLOW_REMOTE", "").strip().lower() in {"1", "true", "yes", "on"}
# Endpoints exempt from bearer auth (liveness only; exposes no inference or upstream proxy).
PUBLIC_PATHS = frozenset({"/health"})


def is_loopback_host(host: str) -> bool:
    candidate = host.strip().strip("[]")
    if candidate == "" or candidate.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(candidate).is_loopback
    except ValueError:
        try:
            infos = socket.getaddrinfo(candidate, None)
        except socket.gaierror:
            return False
        return bool(infos) and all(ipaddress.ip_address(info[4][0]).is_loopback for info in infos)


def resolve_listen_host(host: str) -> str:
    """Validate the requested bind host against the loopback/auth policy or raise RuntimeError."""
    if is_loopback_host(host):
        return host
    if not ALLOW_REMOTE:
        raise RuntimeError(
            f"Refusing to bind GOATCITADEL_NPU_HOST={host!r}: non-loopback binds require "
            "GOATCITADEL_NPU_ALLOW_REMOTE=1 (and a GOATCITADEL_NPU_AUTH_TOKEN)."
        )
    if not AUTH_TOKEN:
        raise RuntimeError(
            f"Refusing to bind non-loopback GOATCITADEL_NPU_HOST={host!r} without "
            "GOATCITADEL_NPU_AUTH_TOKEN: inference endpoints would be unauthenticated."
        )
    return host


def is_authorized(request: Request) -> bool:
    if not AUTH_TOKEN:
        # No token configured: only reachable on loopback, so treat the local caller as trusted.
        return True
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return False
    return hmac.compare_digest(token.strip(), AUTH_TOKEN)


@app.middleware("http")
async def enforce_bearer_auth(request: Request, call_next):
    if request.url.path not in PUBLIC_PATHS and not is_authorized(request):
        return JSONResponse(
            status_code=401,
            content={"error": {"message": "Missing or invalid bearer token.", "type": "unauthorized"}},
            headers={"WWW-Authenticate": "Bearer"},
        )
    return await call_next(request)


@app.get("/health")
async def health() -> Dict[str, Any]:
    return STATE.status()


@app.get("/v1/capabilities")
async def capabilities() -> Dict[str, Any]:
    return STATE.capability


@app.get("/v1/models")
async def list_models() -> Dict[str, Any]:
    data = []
    for model in STATE.enabled_models():
        data.append(
            {
                "id": model["modelId"],
                "object": "model",
                "created": int(time.time()),
                "owned_by": "goatcitadel-npu-sidecar",
                "metadata": model,
            }
        )
    return {"object": "list", "data": data}


async def maybe_proxy(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not FALLBACK_BASE_URL:
        return None

    headers = {"Content-Type": "application/json"}
    if FALLBACK_API_KEY:
        headers["Authorization"] = f"Bearer {FALLBACK_API_KEY}"

    proxy_payload = {**payload, "stream": False}
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS, follow_redirects=False) as client:
        response = await client.post(f"{FALLBACK_BASE_URL}/v1/chat/completions", json=proxy_payload, headers=headers)
    if response.is_error:
        raise HTTPException(
            status_code=response.status_code,
            detail={"error": {"message": response.text[:500], "type": "provider_error"}},
        )
    proxied = response.json()
    if isinstance(proxied, dict):
        proxied.setdefault("backend", "fallback_proxy")
        proxied["goatcitadel_provenance"] = {
            "localInference": False,
            "backend": "fallback_proxy",
            "fallbackReason": "GOATCITADEL_NPU_FALLBACK_URL configured",
        }
    return proxied


def sha256_path(candidate: Path) -> str:
    digest = hashlib.sha256()
    if candidate.is_dir():
        for file_path in sorted(path for path in candidate.rglob("*") if path.is_file()):
            digest.update(str(file_path.relative_to(candidate)).replace("\\", "/").encode("utf-8"))
            with file_path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        return digest.hexdigest()
    with candidate.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def generate_local_completion(model: Dict[str, Any], prompt: str, max_tokens: int) -> str:
    if model.get("readiness") != "ready":
        raise HTTPException(
            status_code=503,
            detail={
                "error": {
                    "message": f"Model '{model.get('modelId')}' is not ready for local inference: {model.get('readiness')}.",
                    "type": "model_not_ready",
                }
            },
        )
    if not STATE.capability.get("localInferenceReady"):
        raise HTTPException(
            status_code=503,
            detail={
                "error": {
                    "message": (
                        "Local NPU inference is not ready. Install onnxruntime + onnxruntime-genai, provide a ready "
                        "model manifest path, or configure GOATCITADEL_NPU_FALLBACK_URL for explicitly labeled proxy mode."
                    ),
                    "type": "runtime_unavailable",
                    "localInferenceReady": False,
                    "fallbackProxyConfigured": bool(FALLBACK_BASE_URL),
                }
            },
        )
    try:
        import onnxruntime_genai as og  # type: ignore

        model_path = str(Path(str(model["path"])).expanduser())
        og_model = og.Model(model_path)
        tokenizer = og.Tokenizer(og_model)
        params = og.GeneratorParams(og_model)
        params.set_search_options(max_length=max(1, min(max_tokens, 512)))
        generator = og.Generator(og_model, params)
        generator.append_tokens(tokenizer.encode(prompt))
        while not generator.is_done():
            generator.generate_next_token()
        return tokenizer.decode(generator.get_sequence(0))
    except HTTPException:
        raise
    except Exception as error:  # pragma: no cover - host/model dependent
        STATE.last_error = str(error)[:500]
        raise HTTPException(
            status_code=503,
            detail={"error": {"message": f"Local NPU inference failed: {str(error)[:500]}", "type": "inference_error"}},
        ) from error


async def stream_completion_chunks(response: Dict[str, Any]):
    content = response["choices"][0]["message"]["content"]
    chunk_id = response["id"]
    model_id = response["model"]
    for word in content.split(" "):
        payload = {
            "id": chunk_id,
            "object": "chat.completion.chunk",
            "created": response["created"],
            "model": model_id,
            "choices": [{"index": 0, "delta": {"content": word + " "}, "finish_reason": None}],
            "backend": response["backend"],
            "goatcitadel_provenance": response["goatcitadel_provenance"],
        }
        yield f"data: {json.dumps(payload)}\n\n"
    yield f"data: {json.dumps({'id': chunk_id, 'object': 'chat.completion.chunk', 'created': response['created'], 'model': model_id, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
    yield "data: [DONE]\n\n"


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> JSONResponse:
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail={"error": {"message": "JSON object body required", "type": "invalid_request_error"}})

    messages = payload.get("messages")
    if not isinstance(messages, list) or len(messages) == 0:
        raise HTTPException(
            status_code=400,
            detail={"error": {"message": "messages must be a non-empty array", "type": "invalid_request_error"}},
        )

    model = STATE.resolve_model(payload.get("model"))
    model_id = model["modelId"]

    proxied = await maybe_proxy(payload)
    if proxied is not None:
        proxied.setdefault("model", model_id)
        proxied.setdefault("backend", "fallback_proxy")
        return JSONResponse(proxied)

    prompt = flatten_messages(messages)
    text = generate_local_completion(model, prompt, int(payload.get("max_tokens", 256) or 256))

    usage = {
        "prompt_tokens": estimate_tokens(prompt),
        "completion_tokens": estimate_tokens(text),
    }
    usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]

    response = {
        "id": f"chatcmpl-npu-{uuid.uuid4().hex[:18]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_id,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": usage,
        "backend": STATE.backend,
        "goatcitadel_provenance": {
            "localInference": True,
            "backend": STATE.backend,
            "modelSha256": model.get("sha256"),
            "modelReadiness": model.get("readiness"),
            "fallbackReason": None,
        },
    }
    if bool(payload.get("stream", False)):
        return StreamingResponse(stream_completion_chunks(response), media_type="text/event-stream")
    return JSONResponse(response)


if __name__ == "__main__":
    import uvicorn

    host = resolve_listen_host(os.environ.get("GOATCITADEL_NPU_HOST", "127.0.0.1"))
    port = int(os.environ.get("GOATCITADEL_NPU_PORT", "11440"))
    uvicorn.run(app, host=host, port=port)
