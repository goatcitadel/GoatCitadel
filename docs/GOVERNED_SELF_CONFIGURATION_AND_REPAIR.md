# Governed Self-Configuration and Self-Repair

Last updated: 2026-08-07

Status: current owner contract and parity acceptance rubric. The first direct-loopback official-search credential vertical is implemented in source, including durable pre-effect reservation and receipt-bound resume, but generic self-repair and **shipped parity** remain open until the named integrated proof lane and remaining repair classes pass.

Program placement: implementation order and dependencies are owned by tranche
`M5` in [MASTER_COMPLETION_PROGRAM.md](./MASTER_COMPLETION_PROGRAM.md). This
document remains authoritative for the self-configuration acceptance matrix.

## Product Promise

An operator should be able to ask for a capability in Chat, have GoatCitadel identify a repairable setup blocker, complete the safe configuration or repair through a governed in-product flow, verify the result against the live owner, and continue the original durable turn.

For example, on a blank profile an operator can ask GoatCitadel to search with Brave. GoatCitadel should explain that the Brave credential is missing, present a secure credential control beside the conversation, validate and store the credential without putting it into Chat, verify a real Brave request, and resume the original turn. The operator should not have to discover an environment-variable name, switch to a terminal, or resend the request.

This is a composed operator journey. A setup page, a doctor command, a secret store, an approval system, and a durable-run engine do not establish parity independently.

## Upstream Patterns and Caveats

The following implementation sources were rechecked on 2026-08-07 at immutable pins. They are pattern inputs, not a license to copy upstream trust decisions.

| Source | Useful pattern | GoatCitadel caveat |
|---|---|---|
| [OpenClaw system-agent prompt at `62937ea`](https://github.com/openclaw/openclaw/blob/62937ea6fc2515782d65c566399cf98e16af6893/src/system-agent/assistant-prompts.ts#L131-L145), [typed system-agent configuration tool](https://github.com/openclaw/openclaw/blob/62937ea6fc2515782d65c566399cf98e16af6893/src/agents/tools/system-agent-tool.ts#L184-L303), and [search setup flow](https://github.com/openclaw/openclaw/blob/62937ea6fc2515782d65c566399cf98e16af6893/src/flows/search-setup.ts#L491-L739) | The operator can ask the system agent to configure search; a typed ring-zero wizard gathers the specific provider setting, validates a snapshot/base hash, writes atomically, and revalidates. | OpenClaw's configuration layout and secret-at-rest choice are not GoatCitadel's trust boundary. GoatCitadel keeps raw credentials out of configuration files and model-visible tool arguments. |
| [OpenClaw Chat engine wizard handling](https://github.com/openclaw/openclaw/blob/62937ea6fc2515782d65c566399cf98e16af6893/src/system-agent/chat-engine.ts#L214-L254) and [sensitive wizard projection](https://github.com/openclaw/openclaw/blob/62937ea6fc2515782d65c566399cf98e16af6893/src/system-agent/chat-engine.ts#L793-L857) | Sensitive answers are rendered as structured operator input and redacted from history rather than requested as ordinary prose. | Redaction alone is insufficient: GoatCitadel's credential must never enter the generic Chat route, model context, idempotency body hash, or durable transcript before redaction. |
| [OpenClaw search-setup PR #115130](https://github.com/openclaw/openclaw/pull/115130) | The Chat-hosted search setup landed on 2026-07-28 and was shipped in the review window that GoatCitadel's 2026-08-01 parity pass claimed to cover. | This is direct evidence of a parity-review miss, not a later upstream feature that the review could not have seen. |
| [OpenClaw invalid-startup repair PR #110533](https://github.com/openclaw/openclaw/pull/110533) | A typed repairable error offers a consent-gated doctor action, leaves headless use command-only, and retries at most once. | GoatCitadel must resume a durable Chat checkpoint, not merely rerun a CLI command. Default-yes consent is not appropriate for every repair class. |
| [Hermes Brave provider schema at `3c27eb6`](https://github.com/NousResearch/hermes-agent/blob/3c27eb6234bf91b8ceee9e9071591b31e9b148cb/plugins/web/brave_free/provider.py#L129-L140), [tool configuration route](https://github.com/NousResearch/hermes-agent/blob/3c27eb6234bf91b8ceee9e9071591b31e9b148cb/hermes_cli/web_routers/tools.py#L527-L579), and [password drawer](https://github.com/NousResearch/hermes-agent/blob/3c27eb6234bf91b8ceee9e9071591b31e9b148cb/web/src/components/ToolsetConfigDrawer.tsx#L334-L391) | Provider schemas declare the required environment name and acquisition help; CLI/dashboard owners render password fields and persist only allowlisted settings. | Ordinary Hermes Chat does not itself configure Brave end to end. GoatCitadel uses the guided schema/UI idea but does not copy plaintext `.env` custody or treat presence as readiness. |
| [Hermes `secret.request` skill bridge](https://github.com/NousResearch/hermes-agent/blob/3c27eb6234bf91b8ceee9e9071591b31e9b148cb/tools/skills_tool.py#L406-L480), [Desktop password overlay](https://github.com/NousResearch/hermes-agent/blob/3c27eb6234bf91b8ceee9e9071591b31e9b148cb/apps/desktop/src/components/prompt-overlays.tsx#L141-L238), and [Gateway secret owner](https://github.com/NousResearch/hermes-agent/blob/3c27eb6234bf91b8ceee9e9071591b31e9b148cb/hermes_cli/tui_gateway/server.py#L5868-L5897) | The model requests a named missing prerequisite, while a separate password UI sends the secret to a host owner and only sanitized status returns to the model. | GoatCitadel generalizes this useful custody split, but binds it to authenticated actor, installation, durable run, one-time prompt, expiry, policy, exact target, live probe, and resume receipt. |
| [Hermes doctor recipes](https://github.com/NousResearch/hermes-agent/blob/3c27eb6234bf91b8ceee9e9071591b31e9b148cb/hermes_cli/doctor.py#L916-L955) and [managed lazy dependencies](https://github.com/NousResearch/hermes-agent/blob/3c27eb6234bf91b8ceee9e9071591b31e9b148cb/tools/lazy_deps.py#L834-L945) | Bounded doctor fixes and managed dependency bootstrap turn common setup failures into named repair recipes. | Only allowlisted GoatCitadel-owned dependencies and paths are repairable. Host-wide package managers and arbitrary model-authored commands remain manual or separately governed. |

GoatCitadel does not require a hosted portal, copy upstream configuration layout, or treat an updater claim as generic self-repair. Local-first operation, one Chat surface, deny-wins policy, approvals, path jails, provenance, and operator-visible runtime truth remain authoritative.

## Why the Earlier Parity Reviews Missed This

The miss was methodological, not a lack of nearby implementation evidence:

1. Reviews inventoried surfaces and components. Settings, provider-secret persistence, doctor checks, approvals, and durable waiting were each counted, but no row started from a blank profile and required `request capability -> detect blocker -> configure securely -> verify live -> resume the same turn`.
2. Self-healing was scoped to installation, startup, updater, and CLI doctor behavior. It was not treated as a generic Chat runtime responsibility when a callable capability encountered a missing prerequisite.
3. Credential isolation, hot reload, tool readiness, and repair were scored in separate workstreams. Passing those rows did not prove their composition, but the summaries implicitly treated the collection as parity.
4. Optional Brave and DDGS breadth was de-prioritized, which obscured the more important product behavior: the system should remediate an unavailable capability regardless of which search provider exposes the case.
5. The 2026-08-01 OpenClaw review covered a source window containing PR #115130 but did not search for or exercise its Chat-hosted setup journey. An earlier internal note did identify first-run and self-healing as important, but it was not committed and its acceptance scope stopped short of secure Chat remediation and durable continuation.

Future parity reviews therefore score composed blank-profile journeys and negative cases, not the presence of supporting components. A feature is not parity when the user still has to discover a hidden command, environment variable, or unrelated settings page to unblock the original request.

## GoatCitadel Ownership Boundaries

The Gateway owns remediation truth. The model may infer intent and explain a blocker, but it must not invent a repair recipe, receive a secret, authorize a mutation, or report verification from its own reasoning.

| Responsibility | Owner boundary |
|---|---|
| Detect and classify a blocker | Gateway provider, tool, integration, config, doctor, and runtime owners using typed errors such as `TOOL_MISSING_CREDENTIAL`, `CONFIG_INVALID`, and `SECRET_STORE_UNAVAILABLE` |
| Create and advance a remediation | A new Gateway-owned remediation coordinator backed by durable storage; never the model or Mission Control local state |
| Render the conversation and secure controls | Mission Control Chat; Settings and Ops may inspect the same Gateway record but do not own it |
| Persist or resolve credentials | `SecretStoreService` and the relevant credential owner, extending the existing provider-secret pattern to tool and integration credentials |
| Publish configuration | `ConfigGenerationService`, with positive revision checks, transactional publication, recovery markers, and monotonic rollback generations |
| Authorize risky effects | Deny-wins policy plus canonical approvals and approval effects |
| Execute and resume work | Durable Chat execution and its exact blocked checkpoint |
| Diagnose or repair managed runtime state | Doctor and the specific service/dependency owner through allowlisted repair recipes |
| Record evidence | Sanitized audit, realtime, durable timeline, and Journey projections; none is allowed to contain secret material |

The secure control is part of the Chat experience, but it is not a chat message. The Chat trace retains only a secret-free prompt and an opaque high-entropy `promptId`. The control posts the credential directly to a narrow authenticated Gateway secure-submit endpoint. The generic Chat user-input response route must reject any response carrying `secure_configuration` or a raw `secret`. A Settings deep link is an optional inspection route, not the only completion path.

The first credential owner is explicitly installation-global: all workspaces on one Gateway installation share the Brave or Parallel credential target. The Gateway host, not a remote Mission Control client, owns keychain custody. The secure card must disclose that scope before submission. The initial slice is limited to `local_dev` and `trusted_local`; `remote_hardened` fails closed until a scoped remote secret-custody design and proof exist. Future workspace-, Citadel-, actor-, or connection-scoped credentials require owner keys that include the deployment identity, scope kind, scope ID, and target ID, plus cross-scope overwrite/read tests.

Product source, installed binaries, policy, authentication posture, and capability activation are not ordinary configuration. Source repair goes through governed Code Mode and review; packaged binary repair goes through the verified installer/updater boundary. Neither may silently rewrite the running product from a Chat request.

## Non-Negotiable Secret Invariant

A raw credential or authorization code must never enter:

- the user, assistant, system, or tool transcript;
- model input, model output, routed context, compaction, or provider telemetry;
- learned, structured, session, workspace, or personal memory;
- tool invocation arguments, approval payloads, run variables, skill inputs, artifacts, citations, or clipboard-derived evidence;
- remediation records, database rows, logs, errors, audit events, realtime events, analytics, traces, screenshots, support bundles, process command lines/argv, shell history, or child-process environment variables.

There are two permitted raw-secret-bearing protocols:

1. an ephemeral password-style control sends the credential in one bounded request to the dedicated authenticated Gateway secure-submit handler, which passes it directly to the secure-store owner and, when needed, an in-memory live probe or final transport credential header; and
2. an OAuth redirect/token exchange keeps the PKCE verifier, authorization code, refresh token, and access token inside the authenticated redirect/token owner.

For a non-loopback client, both protocols require authenticated TLS. Secure-submit additionally requires the existing operator session/auth boundary, exact allowed origin and CSRF protection, `Cache-Control: no-store`, disabled request-body logging, a small fixed body limit, and rate limiting. The browser clears the field and its in-memory value after every success or failure and must not put it in form history, URL/query/fragment, local/session storage, clipboard evidence, or crash reporting.

Durable state stores only the secret reference, installation-global target scope, storage class, and sanitized presence/verification state. It does not store any secret-derived hash or fingerprint. If a same-process adapter needs a transient comparison token, it may use a keyed HMAC with a non-exported process-local random key and must discard it on restart; plain SHA-256 of credential material is not acceptable. High-entropy opaque prompt IDs may be stored as control-plane nonces because they are not derived from the credential. Keychain adapters must use a native/standard-input custody path that never places the value in child argv or environment variables.

Redaction is defense in depth, not proof that the invariant was met. Acceptance must show that the secret never entered a prohibited structure before redaction.

Chat receives only sanitized OAuth state such as `authorization_required`, `connected`, `expired`, or `probe_failed`.

## Durable Remediation Contract

The full remediation owner is a durable, workspace-scoped record containing only secret-free data. The initial search-credential slice uses the existing durable Chat run plus `pendingUserInput` trace and a dedicated secret-free secure-configuration reservation. That reservation fences the waiting run version before any provider/keychain effect and survives restart. Startup recovery retains the interrupted reservation as fail-closed quarantine evidence, rotates a database-expiring prompt on the same original turn/run, and atomically updates the trace and durable wait version; the broader multi-recipe remediation coordinator remains follow-on.

- remediation ID, workspace ID, Chat session ID, source turn ID, durable run ID, blocked checkpoint ID, and installation-global credential scope when applicable;
- repair class, allowlisted recipe ID and version, target owner/resource ID, and requested capability;
- state, positive record revision, expected target-owner revision, and a hash of the proposed non-secret mutation;
- opaque one-time `promptId` nonce, nonce scope, creation time, required absolute expiry for secure prompts, and bounded attempt count;
- approval/effect IDs when required, sanitized verification result, resume receipt, and rollback receipt/reference.

Every full-owner mutation uses compare-and-swap against the positive remediation revision and, where applicable, the target owner's revision. The initial search-credential slice atomically reserves the active prompt against the server-read waiting durable-run version, bumps that version before effects, and permits settlement only against the reserved version plus an exact target/provider/revision/scope receipt. The client chooses neither version. This is a revision fence for the Chat continuation, not general config CAS. A stale client refetches and asks the operator to reconfirm; it never overwrites a concurrent Settings or runtime change.

For the initial Chat slice, the server-generated `promptId` is the cryptographically random, short-lived, one-time nonce. The active trace and reservation bind it to the workspace, session, turn, durable run, exact admitted operator authority, recipe target, installation scope, required 15-minute expiry, and waiting-run version. The secret-free card may retain that opaque ID, but the model never sees it. The dedicated endpoint is `POST /api/v1/chat/sessions/:sessionId/turns/:turnId/user-input/:promptId/secure-configuration`; its body carries only `{ secret }` and is capped at 8,192 credential characters inside a 10 KiB request body. Actor, scope, target, action, recipe, and expected versions come from authenticated server state rather than caller arguments. The Gateway rechecks active trace, database-time expiry, deployment profile, deny-wins policy, target host policy, actor, and run-version authority before settlement.

Within one process, duplicate active submissions may be coalesced using a transient keyed HMAC that is deleted at settlement and never persisted. After immutable settlement, any retry returns the existing secret-free durable receipt without comparing, hashing, or reapplying the retried raw value. An expired, foreign, inactive, or stale request without a matching settlement fails closed, clears the field, and requires a fresh prompt. Startup never infers effect ownership from a run version: it preserves the old reservation as quarantine evidence, creates a new prompt nonce and database-time expiry on the same original durable turn, and requires newly supplied bytes. Successful replacement settlement reconciles the old quarantine; it never replays or reuses the prior secret. Approval-bound prompts rotate only after current deny-wins and one-time issuance authority revalidation. Packaged-process fault injection and explicit rollback-failure recovery evidence remain mandatory before the lane can be called complete.

Ward-approved `runtime.configure` actions also have a pre-reservation issuance fence. Before the secure card is exposed, the canonical executed tool-run row is compare-and-swap sealed with the exact secret-free prompt nonce and its original absolute expiry. That row cannot issue a second nonce. If the process stops after this seal but before the trace records `waiting_for_user_input`, recovery revalidates the approval evidence and current policy under the durable lease, then reconstructs only the same nonce and expiry; it never unseals the row or extends its authority. After reservation or settlement, the reservation lineage and receipt owners continue to fence duplicate writes.

Canonical states are:

```text
blocked -> offered -> awaiting_preapproval -> awaiting_secure_input
blocked -> offered -------------------------> awaiting_secure_input
awaiting_secure_input -> applying -> verifying -> credential_verified
credential_verified -> awaiting_activation_approval -> activating -> verified
credential_verified -----------------------------------------------> verified
verified -> resuming -> completed

terminal or recovery branches:
declined | expired | manual_required | failed
applying / verifying / activating -> rolling_back -> rolled_back | rollback_failed
```

Each optional stage has its own revision, expiry, and one-time authority. Any approval needed to persist the secret occurs before secure input. A later activation approval operates only on the stored secret reference; it never pauses with a raw secret in browser or Gateway memory. Policy, recipe, scope, target, trace, or revision drift clears the field and requires a fresh prompt/nonce rather than replaying the value.

Process restart must recover from the durable record and live owner state. Recovery must determine whether an effect was never applied, applied and awaiting verification, verified and awaiting resume, or failed and awaiting rollback. It must not blindly repeat a secret write, install, service action, external request, or Chat turn.

## Repair Classes

| Class | Governed behavior | Mandatory boundary |
|---|---|---|
| Missing or invalid API credential | Secure input, secure-store write, provider-specific live probe, then resume | No Chat/model/tool-argument path; rejected or unreachable probes do not count as verified |
| OAuth/account connection | Authenticated browser flow with PKCE/state, callback binding, token custody, and a live scoped probe | No pasted authorization codes or tokens in Chat; requested scopes remain operator-visible |
| Declarative configuration | Validate a complete candidate, show a sanitized semantic diff, require the risk-appropriate confirmation, publish by expected revision, and probe the live owner | No raw file mutation by Mission Control or model-authored arbitrary keys |
| Managed dependency or cache | Run a versioned allowlisted recipe inside a GoatCitadel-owned root, verify checksum/provenance and the installed capability, and retry once when the recipe permits | No arbitrary shell supplied by the model; no host-wide mutation disguised as bootstrap |
| GoatCitadel-owned service | Diagnose identity/lease/port truth, drain when required, perform an approved start/restart, then pass authenticated readiness | Never kill an unknown process or bypass shared-host admission |
| Durable data/config repair | Create the required backup or recovery marker, apply transactionally, validate semantic integrity, and retain a rollback receipt | No best-effort partial migration or success based only on file existence |
| Integration, plugin, or skill enablement | Establish provenance, permission/capability diff, health, and separate activation approval | A credential does not grant callability; inactive or unhealthy capabilities remain unavailable |
| Policy, auth, or host prerequisite | Explain the exact manual action or separately governed workflow | Remediation cannot weaken deny-wins policy, auth, approvals, path jails, network allowlists, or OS security |
| Product source or packaged binary | Use governed Code Mode plus review, or the signed installer/updater with release proof and rollback | Never silently self-modify the running product or claim hostile-code sandboxing |

If an owner cannot define a bounded recipe, precondition, verification probe, and rollback or safe stop, the class is `manual_required`, not “self-repairable.”

## Canonical End-to-End Flow

1. A preflight, tool call, provider call, or runtime owner returns a typed blocker. The initial implementation projects the secret-free remediation prompt through the existing `waiting_for_user_input` trace state; `waiting_for_remediation` is conceptual shorthand, not a current stored status. Adding a dedicated status later requires storage migration and exhaustive-consumer proof.
2. The Gateway maps the blocker to one allowlisted recipe, captures current owner revisions, creates the durable remediation, and emits a secret-free Chat card.
3. The operator may decline, choose a different capability, open details, submit a credential through the dedicated secure control, or approve the exact summarized mutation. No response is treated as consent, and generic Chat responses remain secret-free.
4. The Gateway atomically reserves the active `promptId` and expected waiting-run version before any effect, then rechecks policy, identity, deployment profile, database-time expiry, revisions, preconditions, recipe version, target egress policy, and target health.
5. A live probe verifies the capability actually needed by the blocked turn, the canonical owner applies it, and only an exact secret-free revision receipt may atomically consume the reservation and queue the original run. Presence checks, saved-file checks, mocked probes, or a model saying “fixed” are insufficient.
6. On verification failure, the owner rolls back to the previous valid generation/state when possible. If safe rollback is unavailable or fails, the remediation stops in explicit degraded/manual state and the original turn remains blocked.
7. On verification success, one idempotent resume receipt wakes the original durable run at its blocked checkpoint. The user message is not resubmitted, already-settled external effects are not replayed, and the model never receives the credential.
8. The completed card and Ops evidence show what class changed, which owner applied it, which live probe passed, which revisions were consumed/created, whether rollback was available, and whether the original turn resumed. Evidence remains secret-free.

The initial end-to-end scope is a blocker on the primary durable Chat turn. A delegated child blocker may surface a secret-free explanation to its parent, but automatic child-to-parent wake/resume remains follow-on until canonical parent wake support and duplicate-side-effect proof exist. Delegated repair is mandatory before claiming generic orchestration-wide self-repair.

## Live Probe Contract

Each recipe defines one read-only, idempotent, owner-specific probe. It uses the canonical network guard and host allowlist, authenticated TLS, a fixed endpoint/action, a ten-second-or-shorter timeout, a 64 KiB-or-smaller response cap, no arbitrary redirect, no automatic credential retry, and the minimum harmless request/cost needed to prove the blocked capability. For Brave search, use a disposable provider-issued test credential with a unique canary and a fixed one-result query; a fake key or mocked endpoint cannot close the live case.

Probe results are typed as `accepted`, `rejected`, `insufficient_scope`, `rate_limited`, `unavailable`, or `policy_denied`. Only `accepted` advances to verified. Authentication rejection, authorization/scope failure, 429, 5xx, DNS/TLS/connectivity failure, timeout, malformed/oversized response, redirect-policy failure, and store failure remain distinguishable sanitized states. If persistence succeeds but the probe does not, the owner restores the prior credential or deletes the new candidate before reporting settlement; it never resumes the turn as a degraded success.

## Blank-Profile Acceptance Matrix

All applicable cases start from a new local profile with no hidden environment credentials or warmed runtime state.

| Case | Required result |
|---|---|
| Model provider absent | A deterministic Gateway preflight can offer provider setup before a model is available; secure credential entry, live model probe, and exact original-turn resume succeed without adding the key to Chat. |
| Brave search credential absent | “Search the web with Brave for …” creates a Brave-specific secure card that discloses installation-global scope; a disposable provider-issued test credential containing a unique canary is submitted outside Chat, a real bounded Brave probe passes, and the original search continues without a second user message. |
| Credential rejected | A reachable 401/403 or provider-equivalent rejection does not persist or enable the candidate, does not resume the turn, and gives a sanitized retry path. |
| Provider unreachable | The credential remains unverified; the UI distinguishes reachability from rejection and cannot report or resume as success. Any allowed save-without-verification choice is separate and explicit. |
| Secure store unavailable or locked | The candidate is not moved to Chat, environment fallback, or another store without an explicit policy-supported choice. Store failure leaves the turn blocked and the prior owner state intact. |
| Secure-submit binding and transport | Generic Chat response, wrong actor/workspace/session/turn/prompt, stale run version, wrong profile, expired prompt, missing auth, foreign origin, CSRF, oversized body, or rate-limit violation fails before secret persistence or probe. `remote_hardened` is refused in the initial slice. |
| Installation-global scope isolation | Every workspace sees truthful installation-global scope; a workspace cannot relabel the target or overwrite it through caller-supplied arguments. Future scoped owners prove cross-workspace, Citadel, actor, connection, and deployment isolation before enablement. |
| Store/probe partial failure | Failure before store leaves state unchanged. Failure after store restores the prior secret or removes the new candidate. Neither path activates the capability or resumes the turn. |
| OAuth connector absent | The browser flow binds state, actor, workspace, remediation, nonce, and expiry; wrong/expired callback fails; the scoped live probe and original-turn resume succeed. |
| Managed browser/dependency absent | An allowlisted managed-root recipe installs or repairs the dependency, verifies provenance and a real capability probe, and resumes. A foreign path or unowned package manager produces `manual_required`. |
| Invalid GoatCitadel config | A sanitized diff or last-known-good repair is offered, a concurrent revision change is rejected, approval applies the new monotonic generation, readiness passes, and failure restores a verified rollback generation. |
| Owned service unavailable | Identity and lease checks precede restart; readiness must pass before resume. An unknown port owner is never terminated automatically. |
| Activation or policy also missing | Credential setup alone does not activate the tool. The separate permission/callability decision remains visible and deny-wins policy can leave the turn blocked. |
| Decline, expiry, and replay | Decline makes no mutation. Expired or consumed nonces fail closed. A fresh card uses a new nonce and current revisions. |
| Crash at every transition | Restart recovery is tested before apply, after apply, during probe, after verification, during rollback, and before resume; each converges once without duplicate external effects. |
| Delegated child blocker | The initial primary-turn scope reports the boundary honestly and does not fake child/parent continuation. Generic parity additionally requires canonical parent wake and exact-once resume from a blocked child. |
| Rollback failure | The system fails closed, preserves recovery evidence, exposes a high-signal Ops action, and never reports the capability or original turn as completed. |
| Secret non-disclosure | Transcript, model capture, memory, tool args, approvals, storage, logs, audit/realtime, artifacts, screenshots, support bundles, process argv/command-line captures, child environments, URLs, browser storage, and crash reports are scanned and contain neither the test-credential canary nor reversible derivatives. |

Windows packaged desktop, Windows source/dev, POSIX source/dev, Docker, shared-host, and remote-client profiles run the cases that apply to their ownership boundaries. The initial credential slice may pass only on `local_dev` and `trusted_local`; `remote_hardened` refusal is a required negative case, not a parity pass. A profile may mark a class `manual_required`, but it may not silently skip it or inherit proof from another profile.

## Parity Acceptance Rubric

Rate the composed journey, not its components:

| Dimension | Complete only when |
|---|---|
| Discovery | The exact upstream behavior is tied to a primary source and immutable observed pin/date; moving-branch links and release-note bundles cannot close the row. |
| Reachability | A blank-profile operator reaches remediation from the original Chat request or hard startup failure without knowing a hidden route, command, or environment variable. |
| Classification | Typed owner errors distinguish missing credential, rejected credential, unreachable service, invalid config, missing dependency, policy denial, and unowned/manual repair. |
| Secret custody | The non-disclosure case passes before redaction and the raw value exists only in the narrow secure-input/store/probe boundary. |
| Governance | Actor, scope, recipe, permission diff, approvals, deny-wins policy, path/network bounds, revision, nonce, and expiry are revalidated at apply time. |
| Verification | A live, bounded, owner-specific probe proves the requested capability, not just persistence or process liveness. |
| Durable continuity | Restart-safe state resumes the exact original primary run/checkpoint once, without a duplicate message, model secret exposure, or repeated settled side effect. Generic orchestration parity also passes delegated child-to-parent wake/resume. |
| Concurrency and replay | CAS conflicts, changed requests, expiry, nonce reuse, duplicate callbacks, and exact retries behave deterministically and fail closed. |
| Rollback and recovery | Pre-apply state is recoverable or the recipe is classified manual; every fault boundary has explicit convergence proof and rollback failure is visible. |
| Operator evidence | Chat and Ops show a sanitized decision, mutation, probe, resume, and rollback trail with exact owner/revision linkage. |

Status meanings:

- `foundation`: one or more owners exist, but the composed journey is not reachable or proved;
- `partial`: at least one full repair class passes end to end, but required blank-profile, profile, restart, secret, or rollback cases remain;
- `complete`: every mandatory dimension and applicable matrix case passes on the integrated release-bearing SHA with no silent skip, degraded substitute, or unverified success.

The named `pnpm verify:self-configuration` lane now runs the focused policy, Gateway fault, durable reservation, secure Chat control, contract-redaction, and owner-typecheck proofs and scans its exact artifact root for secret disclosure. Its acceptance-boundary scenario deliberately leaves the manifest `degraded` while real provider, packaged-process restart, and browser secure-input evidence are absent. Those held rows cannot be satisfied by mocked probes or source tests. Until a release-bearing run supplies all three as retained secret-free evidence, public claims must say that GoatCitadel has repair foundations rather than self-configuration parity.

## Current Foundation and Implementation Order

Current foundations include provider secret persistence, config generations and rollback recovery, doctor repair checks, daemon repair proposals, typed config/secret/tool errors, approvals/effects, secure provider routes, and durable Chat waiting states. The initial search slice now adds a password field, target-owned credential-acquisition help, a dedicated no-store/no-log/rate-limited loopback submit endpoint, installation-scoped OS-keychain targets, bounded official-provider probes, pre-effect SQLite/PostgreSQL reservation CAS, restart/expiry quarantine, automatic original-turn prompt regeneration, receipt-sealed durable continuation, exact retry replay, and narrow post-answer recovery of a side-effect-free tool history. A generic Chat response carrying a secret is rejected. Policies that require Ward approval can expose or regenerate secure input only while the Gateway can bind it through the exact server-recorded prompt lineage to the one-time approved `runtime.configure` action and revalidate its approval, pending-action receipt, tool-run receipt, actor, workspace, session, run, turn, target, and current policy at apply time. A real administrator recovery surface remains follow-on. The broader multi-recipe remediation coordinator, durable reason-specific rollback-failure reconciliation, scoped remote custody, other repair classes, delegated continuation, and packaged live-probe proof remain incomplete, so this is partial rather than generic self-repair parity.

One current operational restriction remains explicit. Existing installations whose generated network policy predates this slice must add only `api.search.brave.com` and/or `api.parallel.ai` through the Settings/config-generation owner before the credential card can open; the credential flow never widens egress implicitly. The authenticated operator flow is `GET /api/v1/settings`, preserve its complete `networkAllowlist`, then `PATCH /api/v1/settings` with `{ "expectedRevision": <positive revision from GET>, "networkAllowlist": [<preserved entries plus the required hosts>] }`. The patch replaces the list and is committed through `ConfigGenerationService`, so a `409` requires a refetch and recomputation rather than retrying a stale body. Browser-origin mutations also carry `x-goatcitadel-browser-intent: mutation`; token/basic/loopback operator authentication remains authoritative. An active reservation observed after a process crash is now quarantined in place while Gateway startup rotates a fresh prompt on the same original durable turn. If its approval authority has expired, drifted, or already been consumed, startup expires the old prompt without minting a successor.

Recommended slices:

1. Add the secret-free remediation contract, durable repository, primary-turn state machine, `promptId`/run-version/expiry rules, and deterministic preflight path.
2. Add the secure Chat card, dedicated secure-submit endpoint, and a general credential-owner interface; make installation-global Brave on `local_dev`/`trusted_local` the first end-to-end acceptance slice and refuse `remote_hardened`.
3. Add provider bootstrap and OAuth repair, including live probes and exact durable resume.
4. Compose schema/config, managed dependency, and owned-service recipes through existing owners with rollback.
5. Add scoped remote custody, packaged/source/Docker/shared-host profile coverage, delegated child-to-parent resume, and the named proof lane.
6. Only after integrated proof, update release/public claims from “repair foundations” to governed self-configuration and self-repair; until delegated resume and remote custody pass, describe the narrower primary-turn/local profile scope explicitly.

Related owner truth:

- [Canonical Runtime State Model](./CANONICAL_RUNTIME_STATE_MODEL.md)
- [Durable Runs Replay Foundation](./DURABLE_RUNS_REPLAY_FOUNDATION.md)
- [Capability System v1](./CAPABILITY_SYSTEM_V1.md)
- [Install and Setup Testing](./INSTALL_SETUP_TESTING.md)
- [Follow-On Parity Register](./FOLLOW_ON_PARITY_REGISTER.md)
