# llama.cpp Integration Memo for GoatCitadel on This Machine

Last updated: 2026-04-12

This memo is implementation-facing. It is anchored to the installed Windows runtime at `C:\llama` (`8683 / d0a6dfeb2`), the current GoatCitadel wrapper/config contract, the upstream `llama.cpp` source/docs at the same baseline commit, and the user's observed local behavior on this machine.

Machine/runtime context used here:

- model file in active use: `Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf`
- GPU: RTX 3080 with 10 GB VRAM
- RAM: 64 GB
- empirically stable raw-text contexts: `40960`, `49152`, `65536`
- empirical output behavior: `--reasoning off` produced cleaner outputs than `--reasoning-format none`
- empirical multimodal behavior: worked at lower contexts than the long-context text runs

Primary repo/code evidence inspected:

- local build surfaces: `C:\llama\llama-server.exe --help --version`, `C:\llama\llama-cli.exe --help --version`, `C:\llama\llama-mtmd-cli.exe --help`
- GoatCitadel wrapper/config: [apps/gateway/src/services/llama-cpp-runtime-service.ts](../apps/gateway/src/services/llama-cpp-runtime-service.ts), [packages/contracts/src/llama-cpp.ts](../packages/contracts/src/llama-cpp.ts), [data/llamacpp-runtime-state.json](../data/llamacpp-runtime-state.json)
- baseline `llama.cpp` source/docs: [`tools/server/README.md`](https://github.com/ggml-org/llama.cpp/blob/d0a6dfeb28a09831d904fc4d910ddb740da82834/tools/server/README.md), [`tools/server/server.cpp`](https://github.com/ggml-org/llama.cpp/blob/d0a6dfeb28a09831d904fc4d910ddb740da82834/tools/server/server.cpp), [`tools/server/server-context.cpp`](https://github.com/ggml-org/llama.cpp/blob/d0a6dfeb28a09831d904fc4d910ddb740da82834/tools/server/server-context.cpp), [`tools/server/server-common.cpp`](https://github.com/ggml-org/llama.cpp/blob/d0a6dfeb28a09831d904fc4d910ddb740da82834/tools/server/server-common.cpp), [`common/arg.cpp`](https://github.com/ggml-org/llama.cpp/blob/d0a6dfeb28a09831d904fc4d910ddb740da82834/common/arg.cpp), [`common/chat.cpp`](https://github.com/ggml-org/llama.cpp/blob/d0a6dfeb28a09831d904fc4d910ddb740da82834/common/chat.cpp), [`docs/multimodal.md`](https://github.com/ggml-org/llama.cpp/blob/d0a6dfeb28a09831d904fc4d910ddb740da82834/docs/multimodal.md)

## 1. Model Selection and Discovery Reality

### Repo-confirmed

- GoatCitadel should treat `llama.cpp` as **single-model-first**, not provider-fleet-first.
- In non-router mode, `GET /v1/models` effectively describes the currently loaded model. The returned `id` defaults to the model path passed via `-m` unless `--alias` is set. This is documented in `tools/server/README.md` and implemented in `tools/server/server-context.cpp`.
- Router mode exists (`--models-dir`, `/models/load`, `/models/unload`), but it is a separate operating mode. It is not the same thing as a hosted provider model catalog.
- GoatCitadel already leans in the right direction: [llama-cpp-runtime-service.ts](../apps/gateway/src/services/llama-cpp-runtime-service.ts) reads `/models`, falls back to alias when health does not provide a model id, and treats `modelId` as opaque.

### Empirically confirmed on this machine

- The active local baseline is one installed runtime and one manually chosen GGUF model, not a rotating pool.
- The current runtime state cache already points at a single active model id (`gemma-4`) and a single server base URL in [data/llamacpp-runtime-state.json](../data/llamacpp-runtime-state.json).

### Still unproven

- Clean router-mode behavior for GoatCitadel on this machine is unproven.
- Stable multi-model load/unload behavior for this exact Gemma-4 workflow is unproven.

### Integration decision

- Hard-code one canonical host-facing model string first: `gemma-4-local`
- Launch `llama-server` with `--alias gemma-4-local`
- Have GoatCitadel send `model: "gemma-4-local"` everywhere
- Never use the raw GGUF filename as the product-facing model id
- Treat router mode as a later feature after the base path is stable

## 2. llama-server Launch Profiles for This User

### Repo-confirmed

- The installed server exposes the flags needed for the profiles below: `--host`, `--port`, `--alias`, `-c`, `-np`, `-b`, `-ub`, `--flash-attn`, `--reasoning`, `--mmproj`, `--mmproj-offload`.
- GoatCitadel's current launch contract already supports `modelPath`, `alias`, `ctxSize`, `threads`, `gpuLayers`, `parallel`, `batchSize`, `ubatchSize`, and `flashAttention` in [packages/contracts/src/llama-cpp.ts](../packages/contracts/src/llama-cpp.ts), and builds the server command line in [apps/gateway/src/services/llama-cpp-runtime-service.ts](../apps/gateway/src/services/llama-cpp-runtime-service.ts).

### Empirically confirmed on this machine

- Raw text runs were stable at `40960`, `49152`, and `65536`.
- Multimodal worked, but only at lower contexts than those long-context text runs.
- `--reasoning off` produced cleaner output than `--reasoning-format none`.

### Still unproven

- A single always-on production profile that mixes very high context and multimodal is unproven.
- The best explicit `-ngl` value for this exact model on this GPU is unproven from repo evidence; it should stay configurable until separately smoke-tested.

### Recommended profiles

#### Default text provider profile

Use this as the only hard-coded GoatCitadel launch profile at first:

```text
-m <model-path>
--host 127.0.0.1
--port 8080
--alias gemma-4-local
-c 40960
-np 1
-b 1024
-ub 512
--flash-attn on
--reasoning off
```

Notes:

- Leave GPU layers to the configured/default local policy unless the user later proves a preferred `-ngl`.
- Keep this as a text-only provider profile.

#### Long-context text profile

Same shape as the default text profile, but treated as a manual escalation profile for `49152` and `65536`.

- Keep `-np 1`
- Keep text-only mode
- Treat success above `40960` as empirical for raw text, not guaranteed for every request shape

#### Multimodal profile

Keep this separate from the default profile:

```text
-m <model-path>
--mmproj <mmproj-path>
--host 127.0.0.1
--port 8080
--alias gemma-4-local-mm
-np 1
--flash-attn on
--reasoning off
```

Notes:

- Use a lower context than the long-context text profile
- Do not make this the same runtime profile as normal text chat
- Treat multimodal as a separate preset, not a transparent extension of the text path

## 3. Request/Response Compatibility Risks

### Repo-confirmed

- `llama-server` exposes OpenAI-style `/v1/chat/completions`, `/v1/completions`, `/v1/models`, `/v1/responses`, plus Anthropic-style `/v1/messages`.
- The upstream server docs explicitly avoid strong claims of full OpenAI compatibility.
- `/v1/responses` is implemented as a translation layer over chat-completions behavior, not as an independent hosted-provider-grade surface.
- Reasoning can be returned as `reasoning_content`.
- In non-router mode, model identity from `/v1/models` may be an alias or a file path depending on launch args.

### Empirically confirmed on this machine

- The user's cleaner-output experience is tied to `--reasoning off`, which matters for what GoatCitadel should expect in API outputs from this machine.

### Still unproven

- Stable parity for `/v1/responses` with GoatCitadel's future provider abstraction is unproven.
- Stable parity for Anthropic `/v1/messages` with this model/template/runtime combination is unproven.

### Integration decision

- Narrow first integration to `POST /v1/chat/completions`
- Do not use `/v1/responses` as the primary v1 contract
- Do not use `/v1/messages` as the primary v1 contract
- GoatCitadel must tolerate:
  - model ids that are aliases or file paths
  - `message.content` plus optional `reasoning_content`
  - stream vs non-stream shape differences
  - multimodal content parts only when the launch profile is explicitly multimodal-capable
- Host rule:
  - send `model = gemma-4-local`
  - ignore `owned_by`, `created`, and similar metadata for routing logic
  - never infer product identity from the GGUF path

## 4. Structured Output and Tool/Function Calling Reality

### Repo-confirmed

- The server supports grammar and JSON-schema style constraints through `--grammar`, `--json-schema`, and OpenAI-style `response_format`.
- Reasoning and tool parsing are tied to chat-template/Jinja behavior in the shared chat/server code.
- Tool parsing support exists in the server surface, but the docs describe parallel tool calling as only supported on some models and template-dependent.

### Empirically confirmed on this machine

- The only local behavior proven here is that `--reasoning off` yields cleaner results than `--reasoning-format none`.
- Tool/function calling reliability has not been proven locally for this exact Gemma-4 build.

### Still unproven

- Reliable provider-grade tool/function calling with this model/template pair is unproven.
- Strong schema-following behavior for production workflows on this exact runtime is unproven.

### Integration decision

- Allow structured output only behind external host-side validation
- Treat llama.cpp schema constraints as best-effort generation guidance, not acceptance criteria
- Disable tool/function calling in initial GoatCitadel llama.cpp integration
- Revisit tool/function calling only after explicit smoke tests on this exact model/build

Why this stays off at first:

- parsing depends on template/Jinja behavior
- reasoning parsing and tool parsing can interact
- the host still needs fallback handling and validation anyway

If later enabled:

- make it opt-in per model/profile
- do not assume global provider parity

## 5. Slots, Concurrency, and Long-Running Request Behavior

### Repo-confirmed

- `llama-server` supports slots and parallel request processing (`-np`, `/slots`, cache/slot endpoints, unified KV options).
- The server also exposes metrics and slot state endpoints, but these are operational aids, not a replacement for host backpressure logic.
- Multimodal disables some mechanics that help the text path, including context-shift and cache-reuse in `server-context.cpp`.

### Empirically confirmed on this machine

- Long-context text requests are viable on this machine for raw text.
- Multimodal works at lower contexts than the stable long-context text path.

### Still unproven

- Parallel server slots with this model and long contexts are unproven on this machine.
- A good `parallel=2` operating point for this hardware is unproven.

### Integration decision

- Use `parallel=1` for first integration
- GoatCitadel should own queueing and backpressure instead of relying on multi-slot behavior immediately
- Host assumptions for long-context requests:
  - first-token latency can be long
  - throughput can degrade near the upper context range
  - instability risk increases when long context is combined with multimodal or concurrency

Required host behavior:

- one in-flight generation per local llama.cpp provider instance
- explicit request timeout handling
- user abort/cancel support
- treat `parallel=2` as an optional later experiment, never the default

## 6. API Failure Modes a Host Must Handle

### Repo-confirmed

- `/health` returns `503` while the model is still loading, then `200` with `{"status":"ok"}` when ready
- `/v1/models` may return an id derived from `-m` unless `--alias` is set
- metrics, props, and other non-core endpoints can be disabled depending on launch flags
- slot-local cache state can be lost on restart unless separately persisted/restored

### Empirically confirmed on this machine

- The local GoatCitadel runtime state already tracks `healthy`, `desiredState`, `processState`, `activeModelId`, and launch command state in [data/llamacpp-runtime-state.json](../data/llamacpp-runtime-state.json).

### Still unproven

- The exact malformed-output rate for this model under structured-output prompts is unproven.
- The exact overload/no-slot behavior for this model under concurrency experiments is unproven.

### Required host handling

| Failure mode | Required host action |
|---|---|
| server process not running / connection refused | mark provider unhealthy, show process/liveness error, allow controlled restart |
| `/health` returns `503` while model is loading | retry with bounded backoff during startup only |
| `/v1/models` reports unexpected `id` | log mismatch, keep alias as canonical host model id, do not rewrite provider identity from server metadata |
| malformed or schema-invalid output | fail validation, do not blind-retry forever, optionally fall back to plain text if the calling workflow allows it |
| multimodal request on text-only launch | reject at host layer before sending, or surface a clear provider-capability error |
| slot/no-capacity behavior during later concurrency experiments | queue or fail fast at host layer; do not depend on the server to make UX decisions |
| restart/reset loss of slot-local cache state | treat slot state as disposable unless GoatCitadel explicitly adds restore logic |
| request feature behaves differently from hosted OpenAI assumptions | surface launch profile, alias, and feature mode in diagnostics |

## 7. Security and Local Exposure Notes

### Repo-confirmed

- `llama-server` supports API keys.
- `GET /health` and `GET /models` remain public even with API keys configured.
- Built-in server tools exist and are explicitly documented as experimental and unsafe for untrusted environments.

### Empirically confirmed on this machine

- The local GoatCitadel baseline is already pointed at `http://127.0.0.1:8080/v1`, which is the right default posture for this machine.

### Still unproven

- Any need for LAN sharing of this local runtime is unproven and should not be assumed.

### Integration decision

- Bind to `127.0.0.1` only
- API key support is fine if GoatCitadel is not the only local client, but do not treat it as full endpoint privacy because `/health` and `/models` remain public
- For v1:
  - no public LAN exposure
  - no reverse proxy publishing
  - no built-in llama.cpp `--tools`
  - no web UI / proxy features
- If multimodal local-file access is later enabled, use a narrow `--media-path`, not a broad filesystem root

## 8. Recommended Initial GoatCitadel Integration Contract

### Repo-confirmed

- GoatCitadel already has the config shape needed for a stable first contract in [packages/contracts/src/llama-cpp.ts](../packages/contracts/src/llama-cpp.ts).
- GoatCitadel already builds launch args from that shape in [apps/gateway/src/services/llama-cpp-runtime-service.ts](../apps/gateway/src/services/llama-cpp-runtime-service.ts).

### Empirically confirmed on this machine

- The machine and runtime can already support a stable local text-provider path with one model and one server instance.

### Still unproven

- Router mode, tool-calling mode, and multimodal-as-default mode are unproven as a first contract.

### Decision-complete contract

- Base URL: `http://127.0.0.1:8080/v1`
- Health path: `/health`
- Models path: `/v1/models`
- Canonical model id: `gemma-4-local`
- Launch mode: one process, one model, one alias, one slot
- Primary endpoint: `/v1/chat/completions`
- Default request mode: text-only, non-tool, non-router
- Reasoning default: launch with `--reasoning off`
- Structured output default: disabled by default; opt-in per request with external validation
- Host parsing rule:
  - prefer `message.content`
  - if present, treat `reasoning_content` as auxiliary/debug output, not user-visible final output
- Host diagnostics should log:
  - base URL
  - alias
  - model path
  - profile name
  - ctx size
  - slot count
  - whether multimodal is enabled

## 9. Safe Defaults vs Experimental Modes

### Repo-confirmed

- The runtime exposes all of these toggles, but repo availability does not make them equally safe as product defaults.

### Empirically confirmed on this machine

- Safe text-first operation is already proven enough to justify a narrow first contract.
- Long-context and multimodal success are both real, but not in the same confidence bucket.

### Still unproven

- Production-ready behavior for the experimental list below is still unproven on this machine.

### Safe defaults

- single-model alias
- localhost-only server
- `parallel=1`
- text-only default profile
- `--reasoning off`
- `/v1/chat/completions` only
- external validation for any JSON contract
- no tool/function calling
- no router mode
- no built-in llama.cpp tools

### Experimental modes

- `49152` / `65536` as normal production defaults
- multimodal in the same runtime path as normal chat
- router mode and `/models/load`
- `parallel > 1`
- `/v1/responses` as the primary contract
- tool/function calling
- profile switching at runtime via UI
- slot save/restore as a user-facing feature

Integration rule:

- hard-code safe defaults first
- keep experimental modes config-only and hidden behind explicit enablement

## 10. Gaps Still Requiring Manual Smoke Tests

### Repo-confirmed

- These checks are the right ones because they exercise the exact server surfaces GoatCitadel will depend on.

### Empirically confirmed on this machine

- The user has already reduced risk on context and reasoning behavior, but not yet through the final GoatCitadel API path.

### Still unproven

- The final GoatCitadel-to-llama-server path on this machine still needs manual smoke proof.

### Minimal first-integration checklist

1. Launch `llama-server` with the default text profile and confirm `/health` and `/v1/models`.
2. Confirm `/v1/models` returns `id = gemma-4-local` when alias is set.
3. Send a plain `/v1/chat/completions` request and verify GoatCitadel displays only cleaned final content.
4. Verify `--reasoning off` still gives cleaner output than `reasoning_format=none` through the API path, not just the CLI path.
5. Run one structured-output request and confirm external validation catches bad JSON.
6. Run one long-context request at `40960`, then manually test `49152` and `65536`.
7. Run one multimodal request using the separate multimodal profile and record the highest stable context.
8. Force a startup failure or bad model path and verify GoatCitadel reports a provider-health error cleanly.
9. Confirm the server is reachable only on `127.0.0.1`.
10. Leave router mode, tool calling, and `parallel=2` disabled until the checks above pass cleanly.

## Future TODO

- Add Hugging Face repo browsing / file selection instead of requiring manual repo + filename entry.
- Add server-side persisted llama.cpp profile storage so presets follow the user across machines and not just the local browser.
