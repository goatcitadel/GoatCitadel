# Governed Hooks

GoatCitadel hooks are Gateway-owned lifecycle subscriptions. They can observe approved runtime events and, only where the event contract permits, request a bounded mutation or block. Hooks never bypass deny-wins policy, approvals, path jails, or the guarded egress path.

## Current operator surface

Settings → Hooks creates signed HTTPS webhooks and displays their durable delivery evidence. New hooks are metadata-only: identifiers, lifecycle state, and safe scalar fields are delivered; prompt text, messages, tool output, credentials, and secrets are not. Client-facing delivery history exposes status, timestamps, retries, and a safe failure classification only; outbound payloads, remote response bodies, patch/decision data, and raw error text remain Gateway-owned audit evidence.

Webhook destinations must use HTTPS and are governed by the hooks-scoped egress allowlist (`toolPolicy.hooks.networkAllowlist`), which is distinct from the tool-sandbox allowlist: a non-empty list restricts webhook hosts to the listed entries, and an empty list permits any public HTTPS destination. Delivery always follows the guarded egress path regardless of allowlist posture, including private-address blocking, DNS-aware checks, redirect validation, bounded responses, idempotency, retries, circuit breaking, and dead-letter truth.

The signing secret is write-only. It is placed in OS-keychain custody and the hook record stores only an opaque reference. When a Gateway with keychain custody encounters a legacy plaintext signing value, it migrates the value before listing or dispatch; if that cannot happen safely, it disables the hook, strips the stored value, and emits operator-visible evidence. A record with no usable signing secret fails closed at delivery; GoatCitadel never sends an unsigned webhook.

## Versioned event contract, ordering, and failure

Every event is registered under `goatcitadel.hook.v1`; the registry declares its allowed modes, timeout, response shape, and failure posture. Inline **pre** events execute serially in ascending priority. An `open` failure records evidence and continues; a `closed` failure blocks only where that event's contract permits it. **Post** observers are materialized as durable deliveries and execute asynchronously with idempotency, retry/backoff, circuit breaking, and dead-letter state.

| Event family | Event names | Delivery posture |
| --- | --- | --- |
| Existing runtime events | `llm.*`, `tool.call.*`, approval and orchestration events, `before_message_write`, and `agent_end` | Existing compatibility names remain supported under the v1 registry. |
| Session and input | `session.start/end`, `prompt.submit.before` | Session observers are durable; prompt submission is an inline metadata-only control point. |
| Context and delegation | `context.compaction.before/after`, `subagent.start/end` | Compaction before is inline; compaction after and subagent lifecycle events are durable observers. |
| Finalization | `agent.finalize.before` | Inline, bounded assistant-finalization control; webhooks may allow or stop but may not request revision. |

**Run safe test** sends a synthetic metadata envelope rather than conversation or tool data. Only a completed post-event observe delivery can be redriven; the redrive creates a new durable delivery with a new idempotency key. Failed, dead-letter, pre, mutate, and intercept executions are never replayed.

## API compatibility

The typed Gateway API is `/api/v1/workspaces/:workspaceId/hooks`: list, create, update, delete, delivery history, synthetic test, and permitted redrive. Existing hook CRUD endpoints retain their names through the v1 compatibility transition; clients should send the versioned trigger values and the `dataScope` field. New writes require a signed webhook and reject `content` scope until an explicit event-scoped approval-backed data grant exists.

## Managed packages

The contract reserves `managed_package` actions for immutable, capability-lifecycle-managed hook artifacts. A package must be reviewed and hash-bound before it can ever be callable. This branch does not enable an arbitrary local script runner and does not claim hostile-code sandboxing; no unmanaged project script is discovered or executed.

`agent.finalize.before` is dispatched before an assistant message is committed. An intercept hook may stop that commit. The `revise` decision is deliberately reserved for the approved managed-package/durable-continuation adapter; a webhook cannot request it, and no hook is allowed to loop a Chat turn or bypass an approval gate.
