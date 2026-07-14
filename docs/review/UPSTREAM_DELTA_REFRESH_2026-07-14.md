# OpenClaw and Hermes Upstream Delta Refresh - 2026-07-14

Status: source-backed decision packet; no runtime change, migration allocation, staging, or commit

## Scope and verified snapshot

This refresh reviews only the changes after the upstream pins already recorded in
[`OPENCLAW_HERMES_PARITY_PROGRAM.md`](../OPENCLAW_HERMES_PARITY_PROGRAM.md). It is intentionally selective: security,
durable liveness, requester-scoped MCP, session catalog/liveness, live board refresh, node/worker capabilities, cron and
session recovery, skill-name collisions, Model Council structured content, and persistence races were inspected. Pure
refactors, upstream-specific UI shape, and product/provider surfaces outside GoatCitadel's approved boundary were
excluded.

Verified on 2026-07-14:

- GoatCitadel implementation snapshot: `ef079d74ae649dd2f7a817fd3b57fc7674d7fe30` on local `main`. The working tree was
  already heavily modified by other owners, so this packet treats current implementation plus the live uncommitted parity
  register as review evidence and changes no owner file.
- OpenClaw range:
  [`e330e4a17d3c9705ff79da123efe259acd9bd0f3...c3f08eba177d5b3b1dc0dc3d7c3856ae959ce09e`](https://github.com/openclaw/openclaw/compare/e330e4a17d3c9705ff79da123efe259acd9bd0f3...c3f08eba177d5b3b1dc0dc3d7c3856ae959ce09e),
  286 commits.
- Hermes Agent range:
  [`b663d50a6a0101d5214112b24ffe20924af32beb...444b5e96fa2829c29cfd7ecdc84d89f83a1441da`](https://github.com/NousResearch/hermes-agent/compare/b663d50a6a0101d5214112b24ffe20924af32beb...444b5e96fa2829c29cfd7ecdc84d89f83a1441da),
  52 commits.
- Upstream repositories were inspected read-only at the exact head objects. No checkout, merge, vendor copy, fetch-driven
  repin, or upstream mutation was performed.
- The latest coordination checkpoint supplied to this review says SQLite `165` / PostgreSQL `107` are live and `166` /
  `108` are exclusively reserved for `HX-407`. This packet allocates no migration. Later reservations shown in an
  uncommitted program draft must be reconciled by the program coordinator against the first committed integration SHA
  before another owner branches or writes.

## Executive decision

The refresh produces one genuinely new parity row:

- **`HX-415` - requester-scoped MCP connection resolution.** GoatCitadel has governed MCP server records, OAuth, policy,
  bounded transports, tool namespacing, and callable-catalog enforcement, but it does not yet resolve a server's transport
  URL and headers from the authenticated requester at invocation time. The new row must use GoatCitadel actor/device/
  companion/workspace authority, not an upstream sender-ID trust shortcut.

Everything else belongs in an existing owner:

- extend `HX-410` with post-commit, revision-aware board invalidation and canonical reload;
- extend `HX-407` and `HX-411` with upstream-source liveness, identity drift, tombstones, and control-generation revoke;
- extend `HX-408` and `HX-501` through `HX-507` with typed node/device capability publication and worker stream/resource
  limits;
- extend `HX-403` with a bounded structured/multimodal advisory projection;
- extend `HX-401` / `HX-413` with normalized skill/core-command collision proof;
- extend `HX-B01` / `HX-304` / `HX-411` with incomplete-worker-exit and persistence-race proof;
- add regression cases to `HX-108`, `HX-203`, `HX-204`, `HX-412`, and `HX-414` without reopening their architecture.

No delta justifies another primary conversation surface, a second backend, direct node shell ownership, direct MCP
transport from a publisher, or model-authored canonical board state.

## Decision matrix

| Ref | Priority | Classification | Upstream signal | GoatCitadel decision |
|---|---:|---|---|---|
| D1 | P0 | **genuine new requirement** | OpenClaw requester-scoped MCP resolver and redaction hardening | Add `HX-415`; architecture first, no migration yet. |
| D2 | P1 | extension | OpenClaw committed workboard change events and coalesced UI refresh | Extend `HX-410`; events invalidate, repositories remain canonical. |
| D3 | P1 | extension | OpenClaw adopted-session source identity, liveness, and disappearance events | Extend `HX-407` read/catalog truth and `HX-411` control revoke. |
| D4 | P1 | extension | OpenClaw paired/headless node camera, location, and notification capabilities | Extend `HX-408` publication plus `HX-501`-`HX-507` worker governance. |
| D5 | P0 | regression proof | Hermes long-running cron heartbeat, fail-safe liveness, and OpenClaw claim-conflict retry | Strengthen `HX-204`; do not introduce a second scheduler lease owner. |
| D6 | P0 | regression proof / conditional extension | Hermes polling health after actual receive progress; OpenClaw process-generation spool claims | Strengthen `HX-203` / `HX-409`; GoatCitadel Telegram stays webhook-driven. |
| D7 | P0 | extension | Hermes structured-content projection for multi-model advisory calls | Extend `HX-403`; keep one canonical Chat answer and exact `HX-306` attribution. |
| D8 | P1 | extension | Hermes normalized skill slug/core-command collision guard | Extend `HX-401` / `HX-413`; ambiguous aliases become inspectable but non-callable. |
| D9 | P1 | regression proof | Hermes bounded clean-exit protocol retry and incomplete-worker nudge | Strengthen `HX-304` / `HX-B01`; durable state, not a model nudge, is authoritative. |
| D10 | P1 | extension | Hermes serialized close/resume/multimodal persistence fixes | Extend `HX-B01` and future `HX-411` attach/handoff proof. |
| D11 | P1 | extension | OpenClaw terminal flow control for slow clients | Apply protocol semantics to `HX-411` / `HX-504`, not a terminal product. |
| D12 | P0 | regression proof | OpenClaw explicit owner authority, auth-lock release truth, and dangerous environment filtering | Strengthen `HX-108`; current Gateway/path/env owners remain authoritative. |
| D13 | P2 | regression proof | OpenClaw reversible restart-admission fence | Add a future-restart guard to `HX-412`; explicit operator drain remains intentionally closed. |
| D14 | P1 | regression proof | Hermes unknown-liveness session/compaction decisions fail safe | Strengthen `HX-B01` / `HX-414`; unknown cannot authorize destructive cleanup. |
| D15 | P2 | extension | OpenClaw disk accounting includes unremovable migrated sidecars | Extend `HX-505`; account first, never evict canonical live state to hide pressure. |
| D16 | P2 | already covered | Hermes routed reasoning inheritance and post-auto-detect credential validation | Keep `HX-306`, `HX-404`, and `HX-405` proof green. |
| D17 | - | not applicable now | Hermes macOS-only SQLite full-sync hardening | Do not copy into the Windows owner; reopen only with a supported macOS host contract. |

## D1 - New `HX-415`: requester-scoped MCP connection resolution

### Upstream evidence

The relevant OpenClaw series is:

- [`834561ad672381365e5359f1e76726290982a39c`](https://github.com/openclaw/openclaw/commit/834561ad672381365e5359f1e76726290982a39c)
  introduces requester-specific MCP transport resolution;
- [`d50feceadbf37723afd2dbdab3bc9186496010ea`](https://github.com/openclaw/openclaw/commit/d50feceadbf37723afd2dbdab3bc9186496010ea)
  tightens partitioning, validation, and failure handling;
- [`8b66fe773f405b02d6c1014914e69fabd928975d`](https://github.com/openclaw/openclaw/commit/8b66fe773f405b02d6c1014914e69fabd928975d)
  carries the scope into shared-thread harnesses;
- [`e85616940e9ae658e017b0f9cb6674f789dcc273`](https://github.com/openclaw/openclaw/commit/e85616940e9ae658e017b0f9cb6674f789dcc273)
  registers full resolved URLs for log redaction.

The head implementation in
[`mcp-connection-resolver.ts`](https://github.com/openclaw/openclaw/blob/c3f08eba177d5b3b1dc0dc3d7c3856ae959ce09e/src/agents/mcp-connection-resolver.ts)
and
[`agent-bundle-mcp-runtime.ts`](https://github.com/openclaw/openclaw/blob/c3f08eba177d5b3b1dc0dc3d7c3856ae959ce09e/src/agents/agent-bundle-mcp-runtime.ts)
provides the useful semantics: no shared fallback when requester identity is absent, static and requester partitions,
bounded resolution, ephemeral credential material, secret-safe rotation fingerprints, and requester-inclusive runtime keys.

### Current GoatCitadel truth

- [`mcp-runtime.ts`](../../apps/gateway/src/services/mcp-runtime.ts) owns bounded stdio/HTTP invocation, lifecycle,
  cancellation, quarantine, and child environment construction.
- [`mcp-server-admin-service.ts`](../../apps/gateway/src/services/mcp-server-admin-service.ts),
  [`gateway-mcp-oauth-service.ts`](../../apps/gateway/src/services/gateway-mcp-oauth-service.ts), and
  [`mcp.ts`](../../packages/contracts/src/mcp.ts) govern server records and OAuth at server scope.
- [`mcp-tool-namespace.ts`](../../apps/gateway/src/services/mcp-tool-namespace.ts) already rejects ambiguous bare tool names.
- [`HX_408_MESH_CAPABILITY_PUBLICATION_PACKET_2026-07-14.md`](HX_408_MESH_CAPABILITY_PUBLICATION_PACKET_2026-07-14.md)
  correctly forbids a mesh publisher from supplying a direct runtime URL or auth secret.
- No current owner resolves endpoint/headers per authenticated requester and binds that resolution to the immutable Chat
  capability profile before provider/tool execution. This is distinct from `HX-408`: publication describes an MCP
  capability; `HX-415` resolves who may connect and with which ephemeral transport material.

### Required contract

Owner: Gateway MCP runtime + Auth/Policy + Chat capability-profile owner; Security and QA are mandatory reviewers.

1. The requester key is a server-authenticated tuple such as operator/companion/device actor, workspace, session/turn, and
   connection generation. Never trust a body-supplied sender, account, or workspace label.
2. Resolve only after route auth, workspace authorization, deny-wins policy, callable-catalog membership, and immutable
   capability-profile binding have all succeeded.
3. The resolver may return only a validated transport URL plus bounded headers/options. It cannot grant a tool, activate a
   skill, weaken the network guard, or select a different descriptor.
4. Resolved secrets are process-local and transport-only. They are never stored in MCP server records, Chat history,
   artifacts, audit payloads, retained realtime events, capability-profile JSON, cache keys, or error strings.
5. The audit record stores only server ID, authenticated requester scope, resolver ID/version, outcome, latency class,
   connection generation, and a server-owned non-reversible rotation digest. It must not store the URL query, credentials,
   raw headers, or a reusable secret-derived fingerprint.
6. Missing requester identity, ambiguous actor mapping, timeout, invalid URL/header output, scope drift, revoked generation,
   or resolver exception fails closed for that server. Other independently authorized servers may remain available.
7. Runtime reuse keys include server ID, transport generation, workspace, authenticated requester, and any channel/device
   partition required by policy. Static connections cannot be reused as requester-scoped connections or vice versa.
8. Resolution and connection have separate bounded deadlines. Abort, revoke, timeout, and profile invalidation close the
   exact generation and fence late callbacks.
9. Network policy is re-evaluated against the resolved destination immediately before connect, including redirect and DNS
   rebinding protection. Resolution is not an SSRF bypass.
10. Redaction registers exact resolved values before any diagnostic boundary. Query credentials, passwords, bearer/basic
    values, and derived authorization strings must be absent from logs even on connect failure.

### Acceptance proof

Add a named `verify:mcp:requester-scope` lane and include it in `verify:runtime:truth`. At minimum prove:

- two authenticated requesters using one descriptor resolve to different endpoints/headers without cross-reuse;
- a missing, body-forged, stale, revoked, or cross-workspace requester fails before resolver or transport invocation;
- same requester + stable resolver generation may reuse an authorized runtime, while secret rotation or generation change
  cannot reuse it;
- resolver timeout, abort, invalid scheme, private-host denial, redirect drift, and partial multi-server failure are bounded;
- URL queries, header values, auth strings, resolver exceptions, and secret-derived material are absent from logs, audit,
  events, snapshots, errors, and persisted profiles;
- activation/invocation still requires `HX-408` callable projection, real approval where required, `HX-305` effect truth,
  and `HX-306` attempt/cost attribution;
- SQLite/PostgreSQL parity is required only if the final contract introduces durable metadata. No migration is allocated by
  this review.

### Do not copy

- upstream sender-ID authority or a shared fallback requester;
- plugin-supplied endpoint/auth that bypasses Gateway network policy;
- raw URL/header logging, stable secret hashes, or persistence of resolved credentials;
- direct MCP transport owned by Mission Control, a mesh node, or a skill publisher;
- requester scope inferred from Chat text, channel display names, or model output.

## D2 - Extend `HX-410` with live canonical board refresh

### Upstream evidence

OpenClaw commit
[`9d79d85f461b9d3c8ef1a2d1b9092e7eff45647e`](https://github.com/openclaw/openclaw/commit/9d79d85f461b9d3c8ef1a2d1b9092e7eff45647e)
adds committed workboard change events and a coalescing Control UI refresher, building on shared contract commit
[`561cf56c535287a8c7d12bb89b657ea891a4b98b`](https://github.com/openclaw/openclaw/commit/561cf56c535287a8c7d12bb89b657ea891a4b98b).
The source is split between
[`store-change-tracker.ts`](https://github.com/openclaw/openclaw/blob/c3f08eba177d5b3b1dc0dc3d7c3856ae959ce09e/extensions/workboard/src/store-change-tracker.ts)
and
[`live-refresh.ts`](https://github.com/openclaw/openclaw/blob/c3f08eba177d5b3b1dc0dc3d7c3856ae959ce09e/ui/src/lib/workboard/live-refresh.ts).
Related security fixes keep dispatch in caller workspace authority and avoid claim-auth timing leaks:
[`0ecbbe23825ad44b77e9a77689d13c872e3c6cdf`](https://github.com/openclaw/openclaw/commit/0ecbbe23825ad44b77e9a77689d13c872e3c6cdf)
and
[`429bf9383e4b3f91c2173eaac3d984ea480f79db`](https://github.com/openclaw/openclaw/commit/429bf9383e4b3f91c2173eaac3d984ea480f79db).

### Current truth and program edit

[`ops-saved-board-repo.ts`](../../packages/storage/src/ops-saved-board-repo.ts) has canonical workspace scoping and revision
CAS, while [`ops-saved-board-service.ts`](../../apps/gateway/src/services/ops-saved-board-service.ts) and
[`ops-boards.ts`](../../apps/gateway/src/routes/ops-boards.ts) expose the operator API. The current owner does not publish a
board-specific post-commit event and there is no board client refresh owner yet.

Amend `HX-410`, not the generic task Kanban owner:

- publish a secret-free `{workspaceId, boardId, revision, epoch, operation}` signal only after the repository transaction
  commits;
- publish nothing for validation failure, revision conflict, rollback, or a failed operation;
- authorize the subscription by workspace and actor before replay/live delivery;
- treat the signal as invalidation only; the client reloads canonical board state through the authenticated API;
- client logic tracks epoch/highest/applied revisions, coalesces bursts, ignores duplicates/stale revisions, detects gaps,
  invalidates in-flight loads, defers hidden/busy views, and retries bounded failures;
- preserve rejected local drafts separately on 409 and require explicit retry; a realtime event never auto-replays a
  mutation.

Owner: Ops saved-board Gateway service + retained realtime + Mission Control `/ops/boards` UI. Proof belongs in the
`HX-410` named lane plus `verify:realtime:truth` and `verify:surface:regression`.

Do not copy agent-authored HTML/JavaScript/Markdown/URLs, event payloads as canonical board state, unauthenticated workspace
broadcasts, or polling loops that race the retained event owner.

## D3 - Extend `HX-407` and `HX-411` with source liveness

### Upstream evidence

OpenClaw's adopted-session series includes paired-node catalog discovery and authorization
([`05fb55eb7b555ec60214c86d2b07935814db0e90`](https://github.com/openclaw/openclaw/commit/05fb55eb7b555ec60214c86d2b07935814db0e90),
[`0604903f88a780c5f9087287b00b0378239b0952`](https://github.com/openclaw/openclaw/commit/0604903f88a780c5f9087287b00b0378239b0952)),
Codex continuation
([`877af700bf993c4c5b42fbc32b81be5fe6d1d373`](https://github.com/openclaw/openclaw/commit/877af700bf993c4c5b42fbc32b81be5fe6d1d373)),
source liveness
([`bb6874fddfac2bd77748e86ddd6cf8579110c2b4`](https://github.com/openclaw/openclaw/commit/bb6874fddfac2bd77748e86ddd6cf8579110c2b4)),
and disappearance signals
([`e488dc0012ce42fdea3c22146e3d02a4fb80d1df`](https://github.com/openclaw/openclaw/commit/e488dc0012ce42fdea3c22146e3d02a4fb80d1df)).
The reusable pieces are in
[`session-upstream-monitor.ts`](https://github.com/openclaw/openclaw/blob/c3f08eba177d5b3b1dc0dc3d7c3856ae959ce09e/src/sessions/session-upstream-monitor.ts)
and session-catalog source markers: stable physical source identity, generation/CAS markers, bounded monitoring of watched
links, and fail-closed duplicate/ambiguous identity.

### Current truth and program edit

`HX-407` already has a bounded foreign-source reader, immutable normalized-artifact CAS, and fixed Codex/Claude adapters in
[`external-source-reader.ts`](../../apps/gateway/src/services/external-source-reader.ts),
[`external-source-artifact-store.ts`](../../apps/gateway/src/services/external-source-artifact-store.ts), and
[`external-source-adapters`](../../apps/gateway/src/services/external-source-adapters). `HX-411` has an architecture packet
but no control runtime.

Extend `HX-407` with read-only source-health truth:

- persist stable producer/source identity, scan generation, last successful observation, content fingerprint, and
  `present | stale | missing | conflicting | unsupported` disposition;
- monitor only configured/attached sources, with bounded cadence and cancellation;
- require repeated absence before a missing tombstone, but never let a polling error claim absence;
- source identity drift creates a new generation and invalidates attachments until explicit operator review;
- missing/stale source state is visible in Library and attached Chat context; it does not delete normalized artifacts or
  rewrite canonical Chat history.

Extend `HX-411` if control ships:

- an attached control token binds exact external source identity and generation;
- disappearance, replacement, duplicate identity, or ambiguous liveness atomically revokes the active control generation
  and blocks send/interrupt;
- reconnect is explicit and mints generation N+1 after re-authorization; a late N callback cannot heal or mutate N+1.

Owner: external-source catalog/scanner for `HX-407`; purpose-bound session-control owner for `HX-411`; mesh/auth only when
the source is on an admitted node. Proof should cover restart, source replacement, duplicate catalog identity, monitor
failure, repeated absence, reappearance, and late callbacks in both SQLite and PostgreSQL where durable state is added.

Do not copy direct terminal/shell ownership, implicit trust of a paired host, catalog UI as authority, automatic history
import, or control activation from source discovery alone.

## D4 - Extend mesh/worker rows with typed node capabilities

OpenClaw
[`92cca9343eab62c6446ff9e68f76ddd7e5f304a0`](https://github.com/openclaw/openclaw/commit/92cca9343eab62c6446ff9e68f76ddd7e5f304a0)
adds camera, location, and notification capabilities to a headless Linux node. The useful boundary is visible in
[`node-command-policy.ts`](https://github.com/openclaw/openclaw/blob/c3f08eba177d5b3b1dc0dc3d7c3856ae959ce09e/src/gateway/node-command-policy.ts)
and the typed extension commands, not the specific command surface.

Program edit:

- `HX-408` publications may describe typed device capabilities only through immutable manifests with input/output schema,
  permission/effect posture, health, resource ceilings, publisher identity, version, and lease/generation;
- capability publication remains inspectable until operator activation and never grants OS access by itself;
- every invocation is Gateway-mediated, approval/policy checked, generation fenced, and settled under `HX-305` effect
  truth and `HX-306` attempt/cost attribution;
- `HX-501`-`HX-507` own admitted remote worker identity, capability ceilings, dispatch, ordered events, revoke, quarantine,
  cost, and Ops visibility;
- device-specific privacy posture is explicit: location/camera are high-risk and must never become safe-auto because a node
  advertises them.

Proof: malicious manifest, schema drift, capability downgrade, revoked publisher, disconnect/reconnect, stale settlement,
oversized media, location precision policy, notification replay, cross-workspace invocation, and no-provider-secret-on-node.

Do not copy raw arbitrary node commands, a general remote shell, node-held provider secrets, direct device access from the
browser, or capability trust inferred from the operating system label.

## P0 regression additions

### `HX-204`: cron admission and long-running occurrence liveness

Sources:

- OpenClaw bounded retry of lifecycle claim conflicts:
  [`45e651314cb3900337235e079b840f9643bad49e`](https://github.com/openclaw/openclaw/commit/45e651314cb3900337235e079b840f9643bad49e).
- Hermes long-running script claim heartbeat:
  [`cd537187611769ebb6a1aa9460265e9ef5694606`](https://github.com/NousResearch/hermes-agent/commit/cd537187611769ebb6a1aa9460265e9ef5694606).
- Hermes fail-safe unknown running-set check:
  [`ffa525754da49033ccd93ed622804560bb5b163d`](https://github.com/NousResearch/hermes-agent/commit/ffa525754da49033ccd93ed622804560bb5b163d).

GoatCitadel already uses stable occurrence/admission identity, `active_run_id`, execution generation, transactional admission,
and restart settlement in [`cron-run-repo.ts`](../../packages/storage/src/cron-run-repo.ts) and
[`cron-automation-service.ts`](../../apps/gateway/src/services/gateway/cron-automation-service.ts). It does not reclaim a
live occurrence merely because a short wall-clock claim expired, so the Hermes heartbeat design should not be copied as a
second lease owner.

Add proof that:

- a long-running pre-step and child durable run cannot be concurrently re-admitted;
- a storage/CAS conflict may retry only before admission or external effect and always keeps the same occurrence key;
- unknown liveness retains the occurrence and requests reconciliation rather than starting a duplicate;
- if an expiring claim is introduced later, heartbeat uses database time, exact owner + generation CAS, bounded shutdown,
  and no ambiguous-delivery retry;
- recovery can distinguish admitted, running, waiting, post-send unknown, and terminal without a process-local running set.

### `HX-203` / `HX-409`: receive progress and claim-owner identity

Hermes
[`b8295cf6f737a9ff1a4696cef5fab9d010e27d3d`](https://github.com/NousResearch/hermes-agent/commit/b8295cf6f737a9ff1a4696cef5fab9d010e27d3d)
marks Telegram polling healthy only after real `getUpdates` progress. OpenClaw
[`f942734bb1a3829e45aa10cc5c59b807f81e690f`](https://github.com/openclaw/openclaw/commit/f942734bb1a3829e45aa10cc5c59b807f81e690f)
binds spool claims to process-start identity rather than PID alone.

GoatCitadel's supported Telegram ingress is webhook-driven; `getUpdates` in
[`telegram-target-discovery.ts`](../../apps/gateway/src/services/telegram-target-discovery.ts) is a setup discovery probe,
not an inbound runtime. Do not add a poller for parity. Instead prove:

- setup/token/outbound success is never labeled inbound receive health;
- any current or future polling channel becomes ready only after generation-fenced receive progress;
- stale generation success, teardown callbacks, and outbound probes cannot heal a degraded receive owner;
- persisted ingress claim ownership uses durable generation/boot identity, not PID alone, and a reused PID cannot own stale
  work;
- webhook acknowledgement still follows durable acceptance and exact-generation dedupe.

### `HX-403`: structured and multimodal council input

Hermes
[`8582f35d9667e762816f4c6bf364334bdcb595a7`](https://github.com/NousResearch/hermes-agent/commit/8582f35d9667e762816f4c6bf364334bdcb595a7)
creates a safe textual advisory view of structured message content while preserving the canonical multimodal conversation.

GoatCitadel's [`ChatCompletionMessage`](../../packages/contracts/src/llm.ts) already permits string or structured-array
content. [`assembly-service.ts`](../../apps/gateway/src/services/assembly-service.ts) hashes and reuses the exact prepared
history for Model Council participants, but it currently forwards the same structured history to every participant. This
needs a provider-neutral, bounded council projection rather than silently serializing unknown parts or raw image data.

Amend `HX-403` acceptance:

- preserve the immutable canonical history hash and attachment provenance;
- build a deterministic advisory projection that admits visible text and typed attachment references, excludes raw
  base64/binary bytes and provider-private fields, and uses an explicit bounded placeholder for image-only turns;
- never mutate or replace canonical history with the projection;
- keep routed-context bytes exactly once, preserve message ordering/roles, and avoid synthetic consecutive-user turns;
- each participant still receives no tools and cannot promote skill/memory or cause side effects;
- one canonical synthesis answer returns to Chat, with inspectable dissent/minority artifacts;
- every attempt, fallback, retry, and synthesis call retains effective-provider/model usage and cost under `HX-306`;
- prove mixed text/image, image-only, malformed/oversized parts, provider disagreement, recovery after C1/C2/C3, and exact
  replay against the immutable resolution hash through `pnpm verify:model-council`.

### `HX-108`: authority, environment, and cleanup failures

OpenClaw evidence:

- explicit global owner/admin authority rather than channel allowlist authority:
  [`c214fc4bee1e319919a1747035075db7040edad1`](https://github.com/openclaw/openclaw/commit/c214fc4bee1e319919a1747035075db7040edad1);
- auth lock release failures remain observable:
  [`35e3eff549dacf5f9fcdcd983de1d14857fd7229`](https://github.com/openclaw/openclaw/commit/35e3eff549dacf5f9fcdcd983de1d14857fd7229);
- workspace dotenv endpoint and cloud-SDK environment filtering:
  [`18ec9ce8f719d34ce4b134aa01f023eeb628fce6`](https://github.com/openclaw/openclaw/commit/18ec9ce8f719d34ce4b134aa01f023eeb628fce6),
  [`99ca3599d61d403bda604d6bd4b40b4777fda33c`](https://github.com/openclaw/openclaw/commit/99ca3599d61d403bda604d6bd4b40b4777fda33c).

Current GoatCitadel does not load workspace `.env` files into Gateway ownership, and MCP stdio children receive a bounded
safe base plus explicitly granted environment keys. Keep that architecture and add regression assertions:

- channel allowlist membership, workspace membership, display name, or message origin never implies operator/admin scope;
- a security lock/claim/revoke cleanup failure cannot be reported as a successful terminal action and remains visible for
  recovery;
- workspace files cannot redirect provider, auth, proxy, metadata, telemetry, or cloud-SDK endpoints;
- child environment deletion and dangerous-key comparison are case-insensitive on Windows;
- an explicit operator grant is exact-key and exact-owner scoped, is captured in the immutable capability profile, and
  still cannot override a deny-wins key family.

Run focused auth/MCP/config tests, `verify:mcp:conformance`, and `verify:runtime:truth`. Do not add broad workspace dotenv
loading merely to reproduce the upstream filter.

## P1 extensions and recovery proof

### `HX-401` / `HX-413`: normalized skill and command collisions

Hermes
[`370ebf2d3509b1fb7547e2ccdc55fe2a709e7400`](https://github.com/NousResearch/hermes-agent/commit/370ebf2d3509b1fb7547e2ccdc55fe2a709e7400)
rejects skill slash-command slugs that collide with core commands/aliases.

GoatCitadel has an explicit precedence order in [`precedence.ts`](../../packages/skills/src/precedence.ts), but
[`callable-skill-activation.ts`](../../apps/gateway/src/services/callable-skill-activation.ts) builds a normalized alias
map from capability ID, skill ID, candidate ID, and title where later entries can shadow earlier entries. Chat also has
local `/goal`, `/queue`, `/btw`, and related command handlers. Exact tool-name collisions already fail closed.

Program edit:

- define one NFKC + case-folded + separator-normalized command/skill alias identity;
- reserve every core command and alias before catalog projection;
- preserve documented source precedence for exact canonical skill names, but never use precedence to resolve an ambiguous
  explicit alias silently;
- an ambiguous or reserved alias remains visible in Library with collision evidence but is omitted from callable aliases;
- canonical full capability/skill IDs may remain callable only when unambiguous, trusted, exact-byte verified, and active;
- collision state cannot directly promote a skill or memory, and repair requires a new reviewed version/title/alias.

Proof: Unicode/case/whitespace/separator collisions, core aliases, candidate vs installed skill, same-precedence files,
cross-workspace catalogs, catalog reorder, restart, rollback, and exact full-ID invocation. Add these cases to
`verify:skills:catalog`, `verify:skill-learning`, and `verify:skill-hub:lifecycle`.

Do not copy upstream first-wins behavior for ambiguous aliases or turn skills into a second slash-command product surface.

### `HX-304` / `HX-B01`: incomplete worker exit

Hermes bounded protocol-violation retry is in
[`c3656e9f0cdbd690ed84971a1a31a3991c592534`](https://github.com/NousResearch/hermes-agent/commit/c3656e9f0cdbd690ed84971a1a31a3991c592534)
and
[`452861fdc1825702198f743c116513107f3b4831`](https://github.com/NousResearch/hermes-agent/commit/452861fdc1825702198f743c116513107f3b4831).
Commit
[`03fbf6edbb92a5306c15dbb1bf437d68ebeea655`](https://github.com/NousResearch/hermes-agent/commit/03fbf6edbb92a5306c15dbb1bf437d68ebeea655)
adds a nudge when a worker exits without complete/block.

GoatCitadel already records `run_incomplete_worker_exit`, transitions the exact leased run to failed, and auto-blocks a
linked task in [`durable-run-service.ts`](../../apps/gateway/src/services/durable-run-service.ts). Preserve durable state as
authority and add proof that:

- clean process/provider exit without a terminal or waiting transition is a named protocol failure;
- any retry budget is bounded, failure-class specific, persisted, and generation fenced;
- a successful real step resets only the appropriate violation streak;
- dependency fan-in does not release on incomplete exit;
- duplicate late completion, model text saying "done", or a nudge response cannot terminalize the task;
- exhaustion blocks/dead-letters with operator-visible evidence and no spin across restart.

Do not adopt a model nudge as canonical task-state authority.

### `HX-B01` / `HX-411`: close, resume, interrupt, and structured-history persistence

The Hermes cluster fixes shared-history aliasing, close-flush ordering, resumed-history loss, multimodal overrides, stale
overrides, and snapshot timing:

- [`35ebf6ba679f3b3e57e79b7c9ddb7a48c9c33646`](https://github.com/NousResearch/hermes-agent/commit/35ebf6ba679f3b3e57e79b7c9ddb7a48c9c33646),
  no history alias;
- [`a27d51ef467c4a5c16b08494741a04e7865fa454`](https://github.com/NousResearch/hermes-agent/commit/a27d51ef467c4a5c16b08494741a04e7865fa454),
  resumed history survives close;
- [`475922f2ce125290559b86f9a82363c1f6c2639f`](https://github.com/NousResearch/hermes-agent/commit/475922f2ce125290559b86f9a82363c1f6c2639f),
  serialized close handoff;
- [`0b422559f3b21b6dc2c94039b70df8a5b8a103cf`](https://github.com/NousResearch/hermes-agent/commit/0b422559f3b21b6dc2c94039b70df8a5b8a103cf),
  clean multimodal override;
- [`69fd846ef86c034c74a855e98733f7edd3ce433e`](https://github.com/NousResearch/hermes-agent/commit/69fd846ef86c034c74a855e98733f7edd3ce433e),
  serialized direct flush;
- [`962189d9ea66326d0e40672cbb7fd6110452cc30`](https://github.com/NousResearch/hermes-agent/commit/962189d9ea66326d0e40672cbb7fd6110452cc30),
  stale override cleanup;
- [`32bdc67e104934ca7324df430437e0cd839e01c3`](https://github.com/NousResearch/hermes-agent/commit/32bdc67e104934ca7324df430437e0cd839e01c3),
  snapshot under the staging lock;
- [`8341d775a97f7dfda65827617564d703e27719cb`](https://github.com/NousResearch/hermes-agent/commit/8341d775a97f7dfda65827617564d703e27719cb),
  API-local turn content restoration.

Canonical GoatCitadel Chat already persists the user message before durable dispatch and uses repository records rather than
a CLI-local mutable history list. Treat ordinary Chat as regression proof, and make the series an explicit `HX-411`
acceptance gate:

- send, close, interrupt, revoke, reconnect, and resume serialize through exact session/control generation and revision;
- snapshot structured parts and attachment references under the same owner lock/CAS used to stage the turn;
- persist exactly one canonical message per idempotency key, never a caller-owned mutable array;
- restart/reconnect cannot retain a stale override or replace a later canonical message;
- passive observer disconnect does not end the canonical session;
- shortened/projection history cannot overwrite full canonical history;
- attachment bytes remain hash-addressed artifacts, not duplicated inline persistence.

Proof the race matrix with two clients, close during stage, interrupt acknowledgement, stale N callback after N+1 reconnect,
process crash at every persistence boundary, and SQLite/PostgreSQL parity before `HX-411` ships.

### `HX-411` / `HX-504`: bounded slow-consumer flow control

OpenClaw
[`9c03b2310e6ce87cc3ea39876d98790e4596e4b5`](https://github.com/openclaw/openclaw/commit/9c03b2310e6ce87cc3ea39876d98790e4596e4b5)
uses high/low watermarks, output coalescing, pause/resume reassertion, and bounded session limits to retain slow terminal
clients. Adopt protocol semantics only:

- `HX-411` external-control event streams and `HX-504` worker transcript streams need ordered sequence/watermarks, bounded
  buffers, explicit high/low watermarks, replay after reconnect, and truthful sent/acknowledged/pending diagnostics;
- backpressure pauses the exact producer generation or disconnects with a replay cursor; it never drops canonical events
  silently;
- interactive control acknowledgements are not trapped behind bulk transcript output;
- reconnect/replay remains actor/workspace authorized and cannot attach to a different session generation.

Do not add a Gateway-owned terminal surface or raw PTY relay for parity.

### `HX-B01` / `HX-414`: unknown liveness is not permission to destroy

Hermes session pruning
[`ca559a78523e9370bc2b46e689c5b7bb8ceb36a1`](https://github.com/NousResearch/hermes-agent/commit/ca559a78523e9370bc2b46e689c5b7bb8ceb36a1)
keeps a session when active-process inspection throws. Hermes compression recovery similarly treats probe failure as active
([`fd461b58cad4ed64d0121b60481694a597aa1e6c`](https://github.com/NousResearch/hermes-agent/commit/fd461b58cad4ed64d0121b60481694a597aa1e6c)).
WebSocket orphan recovery is covered by
[`ca907480ae3448880464f557e12e0662ec28cb23`](https://github.com/NousResearch/hermes-agent/commit/ca907480ae3448880464f557e12e0662ec28cb23).

GoatCitadel does not use age-based process inspection as canonical Chat deletion authority, and passive SSE disconnect is
already separated from durable-run control. Add regression proof that unknown session, compaction, control, or worker
liveness blocks delete/reclaim/retry and emits recoverable evidence. It may degrade readiness or require reconciliation; it
cannot infer dead/idle/complete.

### `HX-505`: resource accounting includes non-removable bytes

OpenClaw
[`275cc7fd8f0dfdc8b9d0242fb35bfbc2ef61c108`](https://github.com/openclaw/openclaw/commit/275cc7fd8f0dfdc8b9d0242fb35bfbc2ef61c108)
accounts for migrated sidecars that cannot be removed. Extend the future worker-cell budget to count immutable artifacts,
staging files, retained transcript outbox, database sidecars, failed cleanup, and quarantine evidence. When pressure remains,
reject new work or quarantine the worker truthfully. Never delete or evict a live canonical session merely to make the
metric look healthy.

## Already covered or not applicable

- Hermes provider auto-detection validation
  ([`78e844d4465c4d9f6a2cb2f44e5076d31e1c68db`](https://github.com/NousResearch/hermes-agent/commit/78e844d4465c4d9f6a2cb2f44e5076d31e1c68db))
  is already represented by `HX-404` empty credential-pool/readiness proof.
- Hermes background-review routing/reasoning inheritance
  ([`8ef006933ec05eacae74c01ef9bf4f3d7f21bb0d`](https://github.com/NousResearch/hermes-agent/commit/8ef006933ec05eacae74c01ef9bf4f3d7f21bb0d))
  maps to the effective route frozen by `HX-305`, attempt accounting in `HX-306`, and model-scoped reasoning in `HX-405`.
  Keep a regression case that an already-routed child cannot inherit a conflicting parent route/reasoning namespace and
  cannot double-record usage.
- Hermes macOS SQLite durability hardening
  ([`9aba95b053170e3bdd326d18ac9c57d8acb25574`](https://github.com/NousResearch/hermes-agent/commit/9aba95b053170e3bdd326d18ac9c57d8acb25574))
  is not a Windows desktop parity change. If GoatCitadel later claims a canonical macOS host, add a platform-specific
  durability owner and live crash/power-loss proof instead of unconditionally copying pragmas.
- OpenClaw direct terminal launch/resume, paired-node terminal actions, and terminal keystroke races are outside the
  approved product boundary. Their useful liveness/backpressure semantics are captured above without a terminal product.
- OpenClaw workboard manual movement and worker-tool grants do not change GoatCitadel's authority model: task/board
  mutations remain explicit API actions with revision CAS, policy, and durable execution ownership.

## Proposed edits to the authoritative parity program

The program coordinator should make these edits only after reconciling the committed integration SHA and migration ledger:

1. Append both exact compare links from this packet to the source snapshot section and state that the refresh adds one new
   row, `HX-415`.
2. Add this Phase 4 row after `HX-414`:

   | ID | Requirement | Upstream driver | GoatCitadel owner | Status | Acceptance evidence |
   |---|---|---|---|---|---|
   | `HX-415` | Resolve MCP connections per authenticated requester without persisting or leaking transport credentials, and bind the resolver generation/digest to the immutable callable capability profile. | OpenClaw requester-scoped MCP resolver/redaction | MCP runtime, auth/policy, Chat capability profile | `missing` | Architecture packet, no migration allocation; two-requester isolation, missing/forged/stale requester denial, resolver/connect bounds, rotation fencing, SSRF recheck, secret absence, restart/revoke, and SQLite/PostgreSQL parity if durable metadata is introduced; named `verify:mcp:requester-scope`. |

3. Amend `HX-410` acceptance with post-commit board revision/epoch signals, authenticated workspace invalidation, canonical
   reload, gap/duplicate/out-of-order/reconnect proof, and no automatic mutation replay.
4. Amend `HX-407` with source identity/generation and `present | stale | missing | conflicting | unsupported` liveness;
   amend `HX-411` so source disappearance or identity drift revokes control generation before send.
5. Amend `HX-408` with typed device capability manifests and explicitly bind invocation to `HX-305`/`HX-306`; add the
   remote-node resource and ordered-stream cases to `HX-501`-`HX-507`.
6. Amend `HX-403` with the structured/multimodal advisory projection and exact effective-provider attempt accounting.
7. Amend `HX-401` / `HX-413` with normalized alias/core-command collision evidence and inspectable-but-non-callable
   disposition.
8. Add regression clauses to `HX-B01`, `HX-108`, `HX-203`, `HX-204`, `HX-304`, `HX-412`, and `HX-414` as specified in
   this packet. Do not change completed status unless a focused proof fails.
9. Extend the future `HX-411` / `HX-504` proof matrix with bounded slow-consumer backpressure and the serialized
   close/resume/interrupt persistence race matrix.
10. Add this packet to the program's evidence index. Keep all current migration reservations unchanged; `HX-415` remains
    migration-free until its architecture review proves durable state is necessary.

## Ordered execution plan and subagent lanes

No lane may branch or write from the current dirty tree without a committed integration SHA and an explicit disjoint file
allowlist. Once that gate exists, use these bounded owners:

1. **QA regression lane (no migration):** add the `HX-108`, `HX-203`, `HX-204`, `HX-304`, `HX-403`, `HX-412`, and
   `HX-414` focused cases first. A failed proof changes that row from regression-only to implementation repair; a green
   proof prevents speculative rewrites.
2. **`HX-415` architect lane (read-only first):** freeze requester identity, resolver interface, secret/redaction boundary,
   capability-profile binding, failure taxonomy, storage decision, and a threat matrix. Security independently reviews it.
3. **`HX-415` implementation lane:** only after the architecture and migration decision, use disjoint contracts/storage,
   Gateway runtime, and QA subagents. Mission Control receives diagnostics only after the Gateway owner is complete.
4. **`HX-410` realtime lane:** repository/service post-commit event, retained stream projection, client coalescer, then
   `/ops/boards` browser/visual proof. This lane must not overlap the current board UI owner without an allowlist.
5. **`HX-407` / `HX-411` liveness lane:** external-source liveness can proceed independently of control; control revoke
   waits for the frozen `HX-411` auth/storage owner. A separate QA subagent owns replacement/absence/reconnect races.
6. **Skills and Model Council lane:** collision index and structured advisory projection are disjoint Gateway owners but
   each needs an independent recovery/security reviewer before its named lane is accepted.
7. **Worker lane:** fold typed node caps, slow-consumer protocol, and disk accounting into the already frozen
   `HX-501`-`HX-507` order. Do not create a competing node runtime.

## Release gate

This refresh is adopted only when:

- the authoritative program contains the exact pins and decisions above;
- every extension has one canonical owner and a disjoint file/migration reservation;
- `HX-415` has a security-reviewed architecture packet and named proof before being marked partial;
- focused package tests and typechecks pass for each touched owner;
- `pnpm verify:mcp:conformance`, `pnpm verify:model-council`, `pnpm verify:skills:catalog`,
  `pnpm verify:skill-learning`, `pnpm verify:skill-hub:lifecycle`, `pnpm verify:channels:parity`,
  `pnpm verify:durable:recovery`, `pnpm verify:realtime:truth`, `pnpm verify:surface:regression`,
  `pnpm verify:runtime:truth`, `pnpm docs:check`, and `git diff --check` are green where applicable;
- conditional PostgreSQL skips are reported truthfully and are not called live parity proof;
- one Chat surface, Gateway authority, deny-wins policy, approvals, path/network jails, exact-byte provenance, and
  inspectable/callable separation remain intact.

## Do-not-copy summary

- no upstream sender-ID or paired-host trust shortcut;
- no raw requester MCP URL/header/secret persistence or logging;
- no direct publisher/node/browser MCP transport;
- no general remote shell or terminal product;
- no event payload or model response as canonical board/task state;
- no model nudge as terminal worker authority;
- no automatic source import/control or destructive cleanup on unknown liveness;
- no first-wins ambiguous skill alias;
- no broad workspace dotenv loading;
- no new primary conversation surface;
- no provider/product surface outside GoatCitadel's approved provider boundary.
