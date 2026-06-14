# GoatCitadel NPU Sidecar

Local Python sidecar exposing OpenAI-compatible endpoints for NPU-first local inference flows.

## Endpoints

- `GET /health`
- `GET /v1/capabilities`
- `GET /v1/models`
- `POST /v1/chat/completions`

## Quick Start

```bash
cd apps/npu-sidecar
python -m venv .venv
. .venv/Scripts/activate
pip install -r requirements.txt
python server.py
```

By default the sidecar listens on `http://127.0.0.1:11440`.

By default the sidecar binds loopback only and serves loopback callers without auth. Protected
endpoints still reject non-loopback callers when no token is configured, so alternate ASGI launchers
cannot silently turn the local-only default into a remote unauthenticated service. To expose it
beyond loopback you must opt in **and** set a shared secret, otherwise startup refuses to bind:

```bash
GOATCITADEL_NPU_ALLOW_REMOTE=1 \
GOATCITADEL_NPU_AUTH_TOKEN=<shared-secret> \
GOATCITADEL_NPU_HOST=0.0.0.0 \
python server.py
```

When `GOATCITADEL_NPU_AUTH_TOKEN` is set, every endpoint except `GET /health` requires
`Authorization: Bearer <token>`.

## Notes

- Runtime capability detection checks for `onnxruntime`, `onnxruntime-genai`, and QNN provider availability.
- If `GOATCITADEL_NPU_FALLBACK_URL` is configured, chat completions are proxied to that OpenAI-compatible endpoint.
- Model entries come from `model-manifest.json`.
- `GOATCITADEL_NPU_HOST` defaults to `127.0.0.1`; non-loopback values require `GOATCITADEL_NPU_ALLOW_REMOTE=1` and `GOATCITADEL_NPU_AUTH_TOKEN`.
