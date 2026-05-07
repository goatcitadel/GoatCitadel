---
name: genie-npu-ir20
description: "Route text generation to the ir20 Windows ARM64 laptop node running GenieAPIService with OpenAI-compatible endpoints over Tailscale mesh. Use when GoatCitadel needs local/private inference, NPU-backed generation, or a mesh compute target via the ir20 node's /v1/chat/completions API."
metadata:
  version: "0.1.0"
  tags:
    - inference
    - npu
    - mesh
    - openai-compat
  tools:
    - http.get
    - http.post
  keywords:
    - genie
    - npu
    - ir20
    - local inference
    - mesh compute
    - openai api
    - ibm granite
    - tailscale
---

# Genie NPU Node (ir20)

OpenAI-compatible text generation via a Windows ARM64 laptop node running GenieAPIService (FastAPI/Uvicorn) over Tailscale mesh.

Use this skill when:
- GoatCitadel needs **local/private inference** that stays on your devices and mesh
- **NPU-backed** generation is preferred (when available on ir20)
- Another GoatCitadel node needs a **mesh compute target** for text generation

Do not use this skill when:
- The task requires image generation (ir20 endpoints are probe-only for images)
- Low latency from a cloud provider is more appropriate
- The ir20 node is offline or unreachable

## Node Identity

- **Node name:** `ir20`
- **Service:** `GenieAPIService`
- **Port:** `8910`
- **Base path:** `/v1`
- **Observed models** (from `GET /v1/models`):
  - `IBM-Granite`
  - `IBM-Granite-v3.1-8B`

---

## Connection addresses (priority order)

Pick the first that works.

1) **Tailscale IP (preferred for mesh):**  
`http://100.64.0.4:8910/v1`

2) **Tailscale MagicDNS hostname (if enabled):**  
`http://ir20:8910/v1`

3) **LAN IP (same Wi‑Fi/LAN only):**  
`http://192.168.0.108:8910/v1`

### Notes
- The service binds to `0.0.0.0:8910` on the laptop (so LAN + Tailscale can reach it).
- Recommended Windows Firewall rule: allow inbound **only** from Tailscale range `100.64.0.0/10`.

---

## What the endpoints are (and what they’re for)

### Text endpoints (the important ones)
- `GET  /v1/models`  
  Returns available model IDs.
- `POST /v1/chat/completions`  
  Main “Chat Completions” endpoint (supports streaming via SSE).
- `POST /v1/completions`  
  Sometimes exists as an alias/compat endpoint. Prefer `/v1/chat/completions`.

### Image endpoints (likely “best effort”)
Swagger/OpenAPI may list:
- `POST /v1/images/generations`
- `POST /images/generations`

These are meant for **image generation** (like “DALL·E style” APIs). On this node, they may be present in OpenAPI but not actually wired to a working image model. Treat them as **probe-only**: try it, and if it errors, route image generation to another provider/node.

---

## Health checks

### 1) Basic “alive” check (fast)
`GET {base}/models`

Expected:
- HTTP 200
- JSON body containing model list
- Should respond quickly

### 2) Functional “can it generate text” check (strict)
`POST {base}/chat/completions` with a tiny request (`max_tokens` small).

---

## Request format

### Chat Completions request schema (practical)
Most requests look like this:

```json
{
  "model": "IBM-Granite",
  "stream": false,
  "messages": [
    { "role": "user", "content": "Reply with exactly: pong" }
  ],
  "temperature": 0,
  "max_tokens": 3
}
```

#### Parameters that typically work
- `model` (string): one of the IDs from `/v1/models`
- `messages` (array): `{role, content}` chat messages
  - roles: `system`, `user`, `assistant`
- `stream` (bool): `true` for SSE streaming, `false` for one-shot
- `temperature` (number): randomness
- `max_tokens` (int): keep small for control tests
- `top_p` (number): nucleus sampling (if supported)
- `top_k` (int): top‑k sampling (if supported)

#### Schema mismatch note: `temp` vs `temperature`
Some Genie/OpenAPI screens show `temp` while many OpenAI clients use `temperature`.
You already verified **`temperature` works** via `Invoke-RestMethod`. If a client requires `temp`, use it as a fallback:

```json
{ "temp": 0.2 }
```

If both are present, prefer `temperature` unless Genie errors.

---

## Streaming format (SSE)

When `stream: true`, responses arrive like:

```
data: { ... "object":"chat.completion.chunk", ... }
data: { ... }
data: [DONE]
```

Each chunk contains partial text under something like:
- `choices[0].delta.content`

Implementation tip:
- Concatenate `delta.content` fields until you see `[DONE]`.

---

## PowerShell: common gotchas and working patterns

### 1) The colon `:` interpolation trap
In PowerShell, this can break:

```powershell
$base = "http://$ip:8910/v1"   # ❌ sometimes parses weird
```

Use either:

```powershell
$base = "http://$($ip):8910/v1"
# or
$base = "http://{0}:8910/v1" -f $ip
```

### 2) The “file didn’t get created” trap
A here-string by itself only prints. You must pipe it to a file:

```powershell
@'
hello
'@ | Set-Content -Path .\skill.md -Encoding utf8
```

### 3) UTF-8 console output (fix weird characters like `âï¸`)
```powershell
chcp 65001
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

---

## Working PowerShell examples

### Models list
```powershell
$base = "http://100.64.0.4:8910/v1"
curl.exe -s "$base/models"
```

### One-shot chat completion (Invoke-RestMethod)
```powershell
$base = "http://100.64.0.4:8910/v1"

$body = @{
  model="IBM-Granite"
  stream=$false
  messages=@(@{ role="user"; content="Reply with exactly: pong" })
  temperature=0
  max_tokens=3
} | ConvertTo-Json -Depth 10

$resp = Invoke-RestMethod -Method Post -Uri ($base + "/chat/completions") `
  -ContentType "application/json" -Body $body

$resp.choices[0].message.content
```

### Streaming (curl SSE)
```powershell
$base = "http://100.64.0.4:8910/v1"

$payloadPath = "$env:TEMP\genie_stream.json"
@{
  model="IBM-Granite"
  stream=$true
  messages=@(@{ role="user"; content="Count 1 to 10, each on a new line." })
  temperature=0.2
} | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 -NoNewline $payloadPath

curl.exe -N -s -X POST ($base + "/chat/completions") `
  -H "Content-Type: application/json" `
  --data-binary "@$payloadPath"
```

---

## Python examples (for GoatCitadel integrations / adapters)

### A) Plain HTTP (no OpenAI SDK)
```python
import requests

BASE = "http://100.64.0.4:8910/v1"

payload = {
  "model": "IBM-Granite",
  "stream": False,
  "messages": [{"role": "user", "content": "Reply with exactly: pong"}],
  "temperature": 0,
  "max_tokens": 3,
}

r = requests.post(f"{BASE}/chat/completions", json=payload, timeout=30)
r.raise_for_status()
print(r.json()["choices"][0]["message"]["content"])
```

### B) OpenAI Python SDK pointing at Genie (works if the endpoint is compatible)
If GoatCitadel uses the OpenAI SDK pattern, set:
- `base_url` to Genie
- `api_key` to any dummy string (if Genie doesn’t enforce auth)

```python
from openai import OpenAI

client = OpenAI(
  base_url="http://100.64.0.4:8910/v1",
  api_key="local-no-auth",
)

resp = client.chat.completions.create(
  model="IBM-Granite",
  messages=[{"role": "user", "content": "Reply with exactly: pong"}],
  temperature=0,
  max_tokens=3,
)
print(resp.choices[0].message.content)
```

If the SDK complains about unsupported fields, fall back to the plain HTTP method.

---

## GoatCitadel usage guidance (how to route work here)

When GoatCitadel needs text generation, it should:
1) Choose base URL in this order:
   - `http://100.64.0.4:8910/v1`
   - `http://ir20:8910/v1`
   - `http://192.168.0.108:8910/v1`
2) Call `GET /models` (cache for a short time, e.g., 60 seconds)
3) Prefer `IBM-Granite` unless explicitly asked for `IBM-Granite-v3.1-8B`
4) Use `POST /chat/completions` with:
   - `stream: false` for short tool calls / structured answers
   - `stream: true` for long-form interactive output

### Recommended defaults for stable agent behavior
- `temperature`: `0.0` to `0.3`
- `max_tokens`: small for “tool-ish” calls, larger for writing tasks
- Consider enforcing “less chatty” behavior with a system message:
  - “Follow instructions exactly. Output only what’s requested.”

---

## Security posture (recommended)

- Prefer allowing inbound 8910 only from Tailscale:
  - RemoteAddress: `100.64.0.0/10`
- Avoid exposing 8910 to the public internet.
- If you later want authenticated access:
  - Put a reverse proxy in front (Tailscale Serve / Caddy / Traefik) with auth.
  - Or implement an API key check in GenieAPIService.

---

## Troubleshooting quick hits

### Port bind error: WinError 10048
Meaning: something else already owns `8910`.

Find it:
```powershell
Get-NetTCPConnection -LocalPort 8910 -State Listen | Select-Object -First 1 | Format-List
```

Kill the owning PID (careful):
```powershell
$pid = (Get-NetTCPConnection -LocalPort 8910 -State Listen | Select-Object -First 1).OwningProcess
Stop-Process -Id $pid -Force
```

### `Invoke-RestMethod` returns weird truncated objects
PowerShell sometimes formats nested objects oddly. For inspection:
```powershell
$resp | ConvertTo-Json -Depth 50
```

---

## Capability summary

✅ Confirmed working:
- `/v1/models`
- `/v1/chat/completions` (non-stream)
- `/v1/chat/completions` (stream via SSE)

⚠️ Present but not guaranteed:
- image generation endpoints

---

## Execution Pipeline

1. Select base URL in priority order (Tailscale IP -> MagicDNS -> LAN)
2. Health check via `GET /v1/models` - confirm HTTP 200 and model list
3. Choose model (`IBM-Granite` default, `IBM-Granite-v3.1-8B` if requested)
4. Send `POST /v1/chat/completions` with `stream: false` for tool calls, `stream: true` for interactive output
5. For streaming, concatenate `choices[0].delta.content` until `[DONE]`
6. If connection fails, fall back to next base URL or route to another provider

## Future Extension (Planned)
This skill currently hardcodes `ir20` details. Later you can generalize by:
- Discovering nodes via mesh registry
- Probing `/v1/models` to detect capability
- Selecting nodes by latency/cost/availability
