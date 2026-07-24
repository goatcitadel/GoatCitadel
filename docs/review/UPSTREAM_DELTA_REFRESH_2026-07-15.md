# OpenClaw and Hermes Upstream Delta Refresh - 2026-07-15

Status: source-backed decision packet; no upstream code copied

## Verified snapshot

Observed read-only at `2026-07-15T12:02:28-07:00`:

- GoatCitadel integration branch: `codex/openclaw-hermes-parity-20260714` at committed
  `24c04fa5677fc0eb737c756bed690622e4a98d7c`, with the active HX-411 work intentionally uncommitted.
- OpenClaw advanced from
  [`bb3fae834810cf466be70668b1bce2bd16e31227`](https://github.com/openclaw/openclaw/commit/bb3fae834810cf466be70668b1bce2bd16e31227)
  to
  [`ff4d854167ce06350ec5f477e28b3e55b4089b15`](https://github.com/openclaw/openclaw/commit/ff4d854167ce06350ec5f477e28b3e55b4089b15),
  an ancestor-verified range of 109 commits. Stable remains `v2026.7.1`; `v2026.7.2-beta.1` is prerelease evidence only.
- Hermes Agent advanced from
  [`569b912d7d0931c7256e9f5fb326609e9deda377`](https://github.com/NousResearch/hermes-agent/commit/569b912d7d0931c7256e9f5fb326609e9deda377)
  to
  [`58033baba282ef133b219731eb9d0dd01f0558fe`](https://github.com/NousResearch/hermes-agent/commit/58033baba282ef133b219731eb9d0dd01f0558fe),
  an ancestor-verified range of 87 commits. Stable remains `v2026.7.7.2`.
- Both upstream HEADs were fetched by object id into the existing clean review clones without checkout, merge, vendoring,
  branch movement, or upstream mutation.

## Decision

No new parity row is justified. The material changes strengthen existing GoatCitadel owners and acceptance gates. HX-411
and its reserved SQLite 174 / PostgreSQL 116 heartbeat occurrence remain the current integration dependency; the refresh
does not change migration ownership or authorize a competing runtime.

## Acceptance additions

| GoatCitadel owner | New upstream signal | Required GoatCitadel consequence |
|---|---|---|
| `HX-501` through `HX-507` | OpenClaw added operator-run/reclaim cloud-worker sessions, placement recovery, immutable workspace manifests, workspace journals/results, force-abandon handling, and crash reconciliation (`126b549a26a`). | Preserve exact assignment and workspace generations through launch, sync, result, reclaim, and teardown; expose governed run/reclaim controls only after canonical recovery authority exists; never infer a successful workspace handoff from transport completion. Add crash matrices for staged workspace input, ambiguous launch, result materialization, force-abandon, and later reclaim. |
| `HX-411`, `HX-204`, `HX-207` | OpenClaw made commitment heartbeats responsive under large queues (`1a34950d9c5`), rejected synchronous self-target session sends, and tightened usage merge identity (`65188a7430f`). Hermes evicts self-heal cache entries that point to dead sessions (`c346f018d`) and added opt-in, adapter-aware inbound profile routing (`5e65f6d79`, `647520f83`). | Recovery and heartbeat occurrence scans must not be starved by unrelated queues. Exact-session self-target cycles fail before enqueue. Cached session/profile routing is never authority: the Gateway re-resolves a live session, workspace, actor, and immutable profile under the current generation. Multiplex/profile routing is explicit and fail closed; bodies and adapter display names cannot mint a profile. |
| `HX-305`, `HX-306`, `HX-308`, `HX-415` | Hermes added HTTP MCP authentication (`e0e7cfa67`), exact MCP catalog version pins (`9df5f879b`), one provider-owned auxiliary path (`7c954969b`, `771571aee`), bounded Codex wall time (`bcd7e2ce8`), and stale-call circuit-breaker failover (`58033baba`). OpenClaw added bounded per-turn plugin discovery (`9d4610cbd10`), structural/model-scoped usage-limit handling with no silent API-key billing (`1a27e7f3ec2`), and code-only provider failover classification (`1c2bcbb56f2`). | Requester-scoped MCP authentication must resolve secret references inside the governed invocation boundary, bind exact catalog/version/auth material to the callable profile, and keep credentials out of persistence and diagnostics. Provider and auxiliary calls share one route/deadline/accounting owner. Retry, failover, refusal, and circuit-breaker states remain distinct; no fallback may change credential or billing posture silently. |
| `HX-302`, `HX-306`, `HX-414` | Hermes preserves image URLs and explicit unknown-part markers during bounded summarizer serialization (`704bbcca8`) and treats hidden/incomplete or content-filtered Codex output as incomplete/refusal instead of a final answer (`09b6d22df`, `fe1ab949f`, `6a8e7069b`). | Compaction must retain bounded typed multimodal provenance without embedding raw binary/base64. Hidden-only, sentinel, duplicate-interim, content-filter, zero-visible-output, and incomplete responses cannot become canonical success or trigger an unbounded retry loop. |
| `HX-403` | Hermes rejects half-configured Model Council participants at the API boundary and suppresses autosave until a complete participant slot exists (`fcdc10a0f`). | Council configuration remains an all-or-nothing exact participant/route snapshot. Partial participants are rejected before durable admission and cannot create default-expanded or silently substituted councils. |
| `HX-401`, `HX-413`, `HX-506` | OpenClaw moved skill-upload staging and managed-image records into SQLite (`f41c143345f`, `e38cd62e0de`) and hardened official-plugin config moves, npm metadata parsing, and activation settlement (`e4fe96983c7`, `9d4610cbd10`). | Temporary upload/image state that can cross restart becomes bounded durable intent/evidence tied to immutable bytes, never callability. Bundled-to-external or version changes require exact source/version/byte/audit comparison and explicit settlement; stale config cannot activate a candidate. Remote artifact work reuses the same content-addressed evidence boundary. |
| `HX-104`, `HX-105`, `HX-107` | Hermes changed periodic SQLite flushing to a passive checkpoint to avoid B-tree corruption (`c2a3b9ce5`) and preserved unrelated platform config on partial saves (`0ab90040a`). | Partial writes retain untouched canonical sections under revision/CAS. Online snapshot/checkpoint proof must cover active readers/writers and must not use a checkpoint mode that can invalidate concurrent ownership assumptions. |
| `HX-108`, `HX-203`, `HX-406`, `HX-505` | OpenClaw bounded another outbound response body (`30c257f6b45`), persisted Discord command-deploy cache (`f3adeb2ac67`), and tightened loopback/readiness classification. Hermes sanitizes sender-name prefixes before shared-session prompt construction (`170959d80`) and strips bracketed-paste control leakage before prompt persistence (`1011cd24e`). | Every connector-specific response reader inherits the common byte/time/redirect guard. Deploy/dedupe decisions that survive restart use canonical durable state. Display names and terminal paste controls are untrusted input and are normalized before prompt or evidence persistence. |
| `HX-306`, `HX-507` | OpenClaw excludes untimestamped usage from daily windows, separates missing-cost entries, and deduplicates merged usage (`e41585fb0c3`, `65188a7430f`). | Daily cost projections require canonical timestamps; unknown cost remains a distinct visible accounting disposition, never zero. Provider/run attempt identity deduplicates merges without erasing conflicting evidence. |

## Explicit non-adoptions

- OpenClaw ClickClack/channel additions and Hermes desktop multi-tile/plugin-shell work do not create parity requirements. A
  new integration needs a GoatCitadel product decision and a real governed owner; desktop layout remains subordinate to
  the one-primary-Chat product direction.
- Upstream release-publisher workflow refinements remain release-regression evidence, not a runtime row.
- No Elon Musk, X, xAI, or Grok provider/integration behavior is adopted. A Hermes xAI-scoped test-only change in this
  range is excluded from implementation and acceptance evidence. SpaceX remains outside that exclusion but has no delta
  in this range.
- No upstream code, schema, trust shortcut, sender identity, direct worker shell, or direct MCP transport is copied.

## Program impact

The active implementation order is unchanged:

1. finish HX-411 semantic runtime authority and durable heartbeat occurrence/recovery, including live PostgreSQL proof;
2. finish HX-411 autonomous, integration, approval, and external-session controls;
3. allocate later migrations only after the HX-411 heads are committed and rescanned;
4. apply the worker, Journey/external-source, requester-scoped MCP, and remaining provider/recovery additions through their
   existing owners and named verification lanes.
