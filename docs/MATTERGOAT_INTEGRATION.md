# MatterGoat Integration — GoatCitadel Handoff

**What this is.** MatterGoat is a Mattermost fork (`github.com/goatcitadel/mattergoat`)
that acts as the **collaboration room** — channels, threads, users, files, AI
session UI, approvals, provenance display — and routes agent *turns* to
**GoatCitadel**, the **runtime brain** (this repo: orchestration, providers, tools,
policy, durable runs, memory).

The **canonical contract** lives in the MatterGoat repo:
`docs/goatcitadel-integration-requests.md`. **This doc is the GoatCitadel-side
handoff:** what GoatCitadel exposes today, how it behaves, where the code is, and
what's deliberately deferred.

Division of responsibility: **GoatCitadel = runtime brain (canonical)** for
runs/models/tools/policy/memory; **MatterGoat = collaboration room** that holds
governed session state (`MG*` tables) and mirrors GoatCitadel runtime state as
read-only provenance.

---

## What GoatCitadel exposes today (live)

### 1. `POST /api/v1/turns/complete` — run one agent turn
- **File:** `apps/gateway/src/routes/turns.ts` (registered in `app.ts`; operator
  route-access policy for `/api/v1/turns` in `routes/route-access.ts`).
- **Auth:** operator bearer (the standard `/api/v1` token), via the auth plugin.
- **Idempotency:** automatic — every `/api/v1` POST requires an `Idempotency-Key`
  (MatterGoat sends the turn id) and is deduped by the idempotency plugin.
- **⚠️ Path is a slash, not a colon.** The contract was originally sketched as
  `/api/v1/turns:complete`, but the gateway's app-level path-security guard
  (`app.ts`) rejects colons as "suspicious encoded path segments", so the colon
  path is **unreachable as deployed**. Use `/api/v1/turns/complete`. (Bare-Fastify
  unit tests do not exercise the guard — only a booted-app smoke catches this.)

**Request** (snake_case; the messages are the *full allowed context* — fetch
nothing extra):
```json
{
  "session_id": "...", "turn_id": "...", "agent_ref": "...",
  "operation": "mattergoat_collaborate", "user_ref": "...", "channel_ref": "...",
  "messages": [
    {"role": "system", "message": "...", "file_ids": []},
    {"role": "user", "author_ref": "...", "message": "...", "file_ids": []}
  ]
}
```

**Response:**
```json
{
  "message": "...", "markers": ["FINAL_SYNTHESIS"], "needs_approval": false,
  "provider": "openai", "model": "gpt-...", "run_id": "uuid",
  "usage": {"input_tokens": 0, "output_tokens": 0}
}
```

**Behavior:**
- **Stateless + advisory (Phase 1).** Maps the messages to a single
  `fastify.services.llm.createChatCompletion` — **no tools, no session, no side
  effects.** This is intentional: Phase-1 GoatCitadel-backed agents are advisory.
- **Runs as the referenced agent.** `agent_ref` is resolved via
  `fastify.services.agents.getAgent` → `presetDefaults`: `preferredProviderId`/
  `preferredModel` drive the completion and `promptFraming` is prepended as a
  leading system message. An unknown `agent_ref` falls back to the gateway default
  (an advisory turn must not fail because an agent isn't registered).
- **Markers are GoatCitadel's job.** The handler parses `<<MG:...>>` protocol
  markers and the "Approval Needed" gate out of the model's **own** output and
  returns them in `markers`/`needs_approval`, so MatterGoat never trusts markers
  parsed from untrusted prior-turn text.
- `run_id` is a fresh UUID per turn (correlation only — no durable run is persisted
  yet; see Deferred).

### 2. `GET /api/v1/agents` — agent discovery (pre-existing, unchanged)
MatterGoat lists agents here and mirrors each as an `MGAgentProfile`
(`runtime=goatcitadel`, `bridge_agent_id = agentId`). It reads only
`agentId`/`name`/`roleId`/`title` from the full `AgentProfileRecord`. **No
GoatCitadel change was needed** — the endpoint already existed.

---

## Operator config to enable a live route
1. GoatCitadel: an operator token (the `/api/v1` bearer) and at least one
   configured LLM provider.
2. MatterGoat: set `MatterGoatSettings.GoatCitadelURL` to this gateway's base
   (e.g. `https://host:8080`) and `GoatCitadelToken` to the operator token; set an
   agent profile's `runtime` to `goatcitadel`.

Then a turn flows: MatterGoat → `POST {GoatCitadelURL}/api/v1/turns/complete`
(bearer + `Idempotency-Key`) → GoatCitadel runs the model as the agent → structured
reply + markers + provenance → MatterGoat posts the governed message.

---

## Not in GoatCitadel yet (deferred — the next phases)

1. **Full session / tool execution (the big one).** `turns/complete` is stateless
   advisory. To let GoatCitadel-backed agents actually *do* things (tools, durable
   runs, real approvals), wire the handler to the session runtime
   (`ChatTurnRuntime` / `agentSendChatMessage`) instead of the stateless
   `createChatCompletion`. Everything below depends on this.
2. **Approvals producer.** MatterGoat already exposes the *receiver*
   (`POST /api/v4/mattergoat/runtime/approvals`, authed by a shared
   `GoatCitadelCallbackToken`, plus `GET .../runtime/approvals/{id}` to poll). When
   a turn hits a Ward / approval gate, GoatCitadel should **call** that endpoint and
   wait for the decision before proceeding. (No producer today because advisory
   turns never gate.)
3. **Provenance read** — `GET /api/v1/runs/{run_id}`. Not implemented: the stateless
   turn persists no durable run, so there's nothing to read back. Lands with #1.
4. **Phase 4** — SSE streaming variant, A2A handoff, webhook events, memory propose.

---

## Local smoke (how to verify the live endpoint)
The `buildApp()`-based vitest suites (`app.test.ts`, `turns.integration.test.ts`)
run in **CI only** — locally, Vite can't resolve the
`@goatcitadel/contracts/citadel-vault-node` workspace subpath. To smoke locally,
boot the real gateway and curl it:

```bash
# from apps/gateway, with a config root and a >=24-char token:
GATEWAY_HOST=127.0.0.1 GATEWAY_PORT=8732 \
GOATCITADEL_AUTH_MODE=token GOATCITADEL_AUTH_TOKEN=<>=24 chars> \
GOATCITADEL_DATABASE_DRIVER=sqlite GOATCITADEL_ROOT_DIR=<tmp with a copy of ./config> \
pnpm exec tsx src/main.ts
```
Expected: no bearer → `401`; missing `Idempotency-Key` → `400`; bad body → `400`;
a valid turn → `200` with the structured `{message, markers, needs_approval,
provider, model, run_id, usage}` body (needs a configured provider to get a real
completion).

---

## Code map (GoatCitadel side)
| Concern | Location |
|---|---|
| Turn endpoint + agent selection + marker parsing | `apps/gateway/src/routes/turns.ts` |
| Route registration | `apps/gateway/src/app.ts` (`app.register(turnsRoutes)`) |
| Operator access policy | `apps/gateway/src/routes/route-access.ts` (`/api/v1/turns`) |
| Stateless completion | `fastify.services.llm.createChatCompletion` |
| Agent lookup / presets | `fastify.services.agents.getAgent` → `AgentPresetDefaults` |
| Full-stack smoke (CI) | `apps/gateway/src/turns.integration.test.ts` |
| Route unit test | `apps/gateway/src/routes/turns.test.ts` |

**GoatCitadel PRs:** #129 (endpoint), #130 (run as agent via presets), #131 (path
fix `/turns:complete` → `/turns/complete` + full-stack smoke). Paired MatterGoat
PRs: #1 (client foundation), #2 (discovery), #3 (per-agent bots), #4 (approvals
receiver), #5 (path fix).
