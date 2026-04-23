import json
import os
import platform
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse


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

    supported = onnxruntime_available and onnxruntime_genai_available and (
        qnn_available or is_windows_arm64
    )
    if not supported and is_windows_arm64:
        details.append("Windows ARM64 detected; install ORT/GenAI with QNN support for NPU acceleration.")

    return {
        "platform": platform.platform(),
        "arch": machine,
        "isWindowsArm64": is_windows_arm64,
        "pythonVersion": python_version,
        "onnxRuntimeAvailable": onnxruntime_available,
        "onnxRuntimeGenAiAvailable": onnxruntime_genai_available,
        "qnnExecutionProviderAvailable": qnn_available,
        "supported": supported,
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
        return [m for m in self.models if m.get("enabled")]

    def resolve_model(self, model_id: Optional[str]) -> Dict[str, Any]:
        target = model_id or self.active_model_id
        for model in self.enabled_models():
            if model.get("modelId") == target:
                return model
        raise HTTPException(
            status_code=404,
            detail={"error": {"message": f"Unknown model: {target}", "type": "invalid_request_error"}},
        )


app = FastAPI(title="GoatCitadel NPU Sidecar", version="0.1.0")
STATE = RuntimeState()
FALLBACK_BASE_URL = os.environ.get("GOATCITADEL_NPU_FALLBACK_URL", "").strip().rstrip("/")
FALLBACK_API_KEY = os.environ.get("GOATCITADEL_NPU_FALLBACK_API_KEY", "").strip()
TIMEOUT_SECONDS = float(os.environ.get("GOATCITADEL_NPU_REQUEST_TIMEOUT_SECONDS", "60"))


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

    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS, follow_redirects=False) as client:
        response = await client.post(f"{FALLBACK_BASE_URL}/v1/chat/completions", json=payload, headers=headers)
    if response.is_error:
        raise HTTPException(
            status_code=response.status_code,
            detail={"error": {"message": response.text[:500], "type": "provider_error"}},
        )
    return response.json()


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

    if not STATE.capability.get("onnxRuntimeAvailable"):
        raise HTTPException(
            status_code=503,
            detail={
                "error": {
                    "message": (
                        "NPU runtime not available. Install onnxruntime + onnxruntime-genai or configure "
                        "GOATCITADEL_NPU_FALLBACK_URL for proxy mode."
                    ),
                    "type": "runtime_unavailable",
                }
            },
        )

    prompt = flatten_messages(messages)
    text = (
        f"NPU sidecar is online ({STATE.backend}). Model '{model_id}' is selected. "
        "Configure a runtime adapter or fallback URL to execute real local inference."
    )
    if prompt:
        text += f" Last user prompt excerpt: {prompt[:220]}"

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
    }
    return JSONResponse(response)


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("GOATCITADEL_NPU_HOST", "127.0.0.1")
    port = int(os.environ.get("GOATCITADEL_NPU_PORT", "11440"))
    uvicorn.run(app, host=host, port=port)
