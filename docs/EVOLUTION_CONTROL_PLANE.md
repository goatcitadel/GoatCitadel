# Evolution Control Plane

Last updated: 2026-09-13

Status: implemented Gateway owner contract. The durable control-plane foundation and hermetic verification lane are present. Real-provider onboarding, retained browser secure-input evidence, Windows live restart/restore evidence, and signed packaged-update promotion evidence remain held claim rows.

## Product Shape

The **Evolution Control Plane** is an internal layer, not a new primary page. Operators see **Change Plans** in Chat and Settings, **Improvements** in Ops, and **Updates** in the relevant setup or evidence views.

The layer governs persistent changes to GoatCitadel itself:

- current-Chat and future-Chat provider, model, and effort selection;
- provider credentials and OAuth connections;
- typed runtime configuration;
- channel connections;
- remediation, improvement, and capability lifecycle actions;
- managed GoatCitadel source registration and governed source updates.

It deliberately excludes local presentation preferences, ordinary document/project/task/memory CRUD, read-only diagnostics, and ordinary tool effects already owned by policy, approvals, and the external-side-effect ledger. The frozen inventory and exclusions live in `apps/gateway/src/services/evolution-control-plane-governance.ts` and are contract-tested.

## Authority Boundary

`EvolutionControlPlaneService` is the singleton orchestration owner. It resolves a bounded intent to a registered adapter, claims the target, persists lifecycle truth, obtains owner input, checks exact confirmation and approvals, invokes the low-level owner, verifies the result, and records a receipt.

Adapters do not replace existing owners. They coordinate them through the following contract:

```text
inspect -> describeInputs -> validate -> [stage] -> apply -> verify -> [reconcile] -> [rollback]
```

The Gateway remains the only mutation authority. Mission Control is an API client. Code Mode may generate and validate a patch or skill candidate, but it cannot confirm a plan, activate a capability, promote a credential, mutate the live source tree, or restart the product.

The first-party model tool is `change.request`. It creates a plan from a discriminated, allowlisted intent and returns only plan ID, status, and required-action kind. It cannot confirm or apply a plan. The contract rejects raw setting keys, secrets, OAuth material, paths, patches, commands, and delegated-agent authority.

## Canonical Change Plan

The public contract is `packages/contracts/src/change-plan.ts`. Its v1 kinds are:

| Kind | Canonical owner scope |
| --- | --- |
| `session_model` | current Chat only |
| `installation_default_model` | future Chats |
| `provider_connection` | provider profile and dedicated credential owner |
| `runtime_configuration` | registered typed runtime operation |
| `channel_connection` | channel draft, test, and final connection |
| `runtime_remediation` | governed remediation owner |
| `capability_candidate` | capability proposal/version lifecycle |
| `connector_install` | one MCP connector installed from its template: allowed hosts, the saved server (switched off, "Reading is free") and, when asked, connectors in Chat |
| `improvement_candidate` | improvement lifecycle |
| `managed_source_registration` | one verified GoatCitadel source install |
| `product_source_update` | immutable staged source-update manifest |

The lifecycle is:

```text
draft -> awaiting_input -> awaiting_confirmation -> staging -> awaiting_approval
      -> applying -> verifying -> monitoring -> completed

recovery: manual_required | failed | cancelled | rolling_back
          -> rolled_back | rollback_failed
```

Not every plan visits every state. `applied` is retained for one compatibility window for legacy Chat records. Every state change uses a positive compare-and-swap revision. Effectful actions also bind a one-time action nonce, target revision or hash, immutable form snapshot, idempotency key, expiry, and one active claim per target.

Canonical state is stored in `change_plans`; transitions are append-only in `change_plan_events`; immutable owner, approval, artifact, and rollback relationships are stored in `change_plan_links`. SQLite migrations 201-204 and PostgreSQL migrations 145-148 provide the Change Plan, legacy backfill, managed-source, and source-update schemas.

Startup recovery inspects the linked owner and reconciles observed state. It never blindly repeats `apply` after a process interruption.

A denied canonical approval settles its waiting parent as `cancelled`; an expired approval settles it as `failed`. Both clear the pending action, release the target claim and retain the exact approval reference and terminal event. The durable approval-resolution signal, startup reconciliation and explicit resume all use this path. A refusal that arrives before the parent wait is persisted is rechecked immediately afterward. Pending approval expiry uses the repository's database clock; a completed rejection uses its recorded resolution timestamp. Lookup uses the current required-action binding, not historical approval links. Duplicate delivery and competing transitions retain one canonical outcome under revision checks.

Refusing rollback approval instead records `manual_required`: the earlier effect remains in place, with its recovery evidence retained for operator review. Refusal settlement never invokes apply or rollback or activates a candidate. Initial-apply refusals discard temporary setup inputs through the existing adapter cleanup owner before releasing the target claim; cleanup failure remains retryable. A pending decision never applies. An approved decision applies through reconciliation only where the approval is the operator's last word: llama.cpp setup, any runtime setting the operator saved in Settings except a Gateway authentication change (which still needs its credential after approval), and a connector installed from Capabilities; every other approved plan, including anything proposed from Chat and any rollback, waits for its explicit continuation. Settings opens such an approval in a dialog where the change was saved, with the full review behind "Show details"; a danger-level approval with an action preview approves there in one click, and nuclear keeps its typed confirmation. Approved resume still requires its original scope, revision, approval binding, deadline and owner checks. `GET` and list projections remain read-only. In the cockpit Inbox, a plan's approval that is bound to its plan (its plan id and the hash of the plan's request) shows the plan's own title, summary and impact as the action to review, so a danger-level plan can be approved there once; a danger-level approval without that binding can only be denied.

An operator can opt out of the separate approval for their own Settings saves, Capabilities installs and Capabilities skill switches with the `settingsApprovalSkipEnabled` runtime flag (Settings, Tools, "Apply my Settings and Capabilities changes without an Inbox approval"). It is off by default, turning it on is a danger-level plan that still needs one approval, and a `remote_hardened` install ignores it. Only two Gateway operator routes can ask for the skip, each for a plan from its own surface: the Settings save (`PATCH /api/v1/settings`, origin surface `settings`) and the Capabilities connector install (`POST /api/v1/capabilities/connectors/install`, origin surface `capabilities`, kind `connector_install` only). The generic Change Plan confirmation API and Chat-originated plans always keep their approval. A skipped approval still records the plan, its confirmation nonce, and an `operator_approval_skipped` event before apply. The skip follows those routes, not a person: any caller holding operator access to them, such as a local script while Gateway auth is off, gets it too, so turn it on only where that is acceptable.

The Capabilities skill switch (`POST /api/v1/capabilities/skills/state`, `apps/gateway/src/services/capability-skill-actions-service.ts`) follows the same flag outside the Change Plan path. It always asks `SkillStateService` first, with the operator as requester, so the skill's own `skill.lifecycle` approval is created as usual. When the skip applies, the switch resolves that approval at once through the Inbox's own resolve, as the same operator, with a fixed resolution note, and appends an `operator_approval_skipped` event (`kind: "skill.lifecycle"`, `reason` `setting` or `tightening`) to the approvals audit stream; the recovered `skill_lifecycle_apply` effect stays the only executor. Switching a skill on, or pausing one that is off, skips only with the flag on (`setting`): a paused skill can still be used when it is named or matched confidently. Turning a skill off, or pausing one that is on, skips even with the flag off, because it only takes power away (`tightening`). Whether a pause starts from on is read from the approval itself (`preview.currentState`, which the skill state owner writes in the same commit as the change it binds); when that can't be read, the approval waits. A `remote_hardened` install always asks and never reads the flag. A failed resolve leaves the approval waiting in the Inbox, except one that ran out of time as the skip approved it: the approvals owner commits the expiry rejection, and the switch answers `declined` with `expired`. The approval's id follows from the request, so asking again for the same change before the skill changes hands back the approval already made; a decided one is never resolved again and records no skip. The switch answers `202` with `approved` or `waiting`, or `200` with `unchanged` or `declined` (a rejected or edited approval, which never applies; `expired` when the expiry check rejected it). Pinned skills and stale revisions are refused with a `409` before any approval exists. The old skill state routes (`PATCH /api/v1/skills/by-id/state`, `/api/v1/skills/:skillId/state`, `/api/v1/skills/bulk-state`), Chat's `/skill` commands, `change.request` and tool calls never skip; `capability-skill-skip-guard.test.ts` fails if any other production file writes the skip notes or both requests a skill approval and resolves one.

A `connector_install` plan is created only by that Capabilities install route: the generic create route refuses the kind, and the adapter refuses any origin other than a Capabilities one with no Chat linkage, so `change.request` cannot start one either. It is `danger`, has no staging step, and re-checks the template when it applies: the template must be listed in Capabilities, need no API key, have somewhere to sign in when it uses OAuth, and not already be saved under the same name (ignoring case). Apply adds only the template's hosts that the current allowed list does not cover, saves the connector switched off with the template's policy, sets "Reading is free" through the audited MCP policy write under the operator's name, and turns on connectors in Chat only when asked and still off. Its result summary is plain sentences only: one per finished step and, when a step fails, what did not happen and what to do next, with `failureCode` naming that step (`connector_install_allowlist_failed`, `_save_failed`, `_posture_failed` or `_chat_flag_failed`). The owner's redacted error text goes to the result's `failureDetail` (at most 300 characters), which clients show only as technical detail; the install route's receipt carries the plain summary. Startup reconciliation reports what the owners hold and never repeats a step.

## APIs and Compatibility

Canonical resource APIs are:

- `POST/GET /api/v1/change-plans`
- `GET /api/v1/change-plans/:planId`
- `POST /api/v1/change-plans/:planId/responses`
- `POST /api/v1/change-plans/:planId/confirmations`
- `POST /api/v1/change-plans/:planId/cancellations`
- `POST /api/v1/change-plans/:planId/rollback-requests`

Dedicated owner routes handle secure fields, provider OAuth start/poll/completion, and the native path picker. The Capabilities install route (`POST /api/v1/capabilities/connectors/install`) creates and confirms its own `connector_install` plan and answers `202` with the plan receipt, which has either finished or waits for an approval in the Inbox. Compatibility Chat and Settings routes re-enter the same adapters and return additive plan/receipt references. An explicit legacy Settings save counts as confirmation only for its exact server-resolved typed operation; it does not create a generic write bypass.

Malformed input returns `400`, forbidden authority `403`, missing resources `404`, stale or claimed targets `409`, semantic validation failures `422`, and unavailable owners `503`.

## Operator Input and Secret Custody

The server may describe these actions: public form, secure input, OAuth, native path picker, confirmation, approval, and artifact review.

Public form answers are bound to the exact plan revision and immutable form hash. Credentials and OAuth values never use that route. Provider and channel secrets are written to temporary, plan-scoped secure-owner references; OAuth device flows are bound to the exact plan/action. Final confirmation promotes the temporary reference to the canonical owner. Cancellation and expiry discard temporary references.

Native paths are selected through the desktop-controlled picker and are retained only by the Gateway owner. Public Change Plans and model context receive an install ID and label, never the path. Legacy browser-stored OAuth flows are scrubbed because they lack plan/action binding.

Untrusted channel origins may request a plan but cannot receive secure input, native path, confirmation, or apply authority. The first-party Chat surface remains the confirmation boundary.

## Models, Channels, Capabilities, and Improvements

`/model` and `/think` create current-Chat plans. Provider/model availability and effort support are validated against model-specific metadata before confirmation. A separate linked default plan is created only when the operator chooses **Make this my default**; it affects future Chats, including optional default effort, and does not rewrite existing sessions.

A model-less installation enters guided setup before the first Chat. Provider/API-key or OAuth setup uses dedicated secure controls, performs live owner verification, then confirms the future-Chat model and effort.

Channel setup retains draft -> validate -> test -> finalize. Drafts use positive revisions, secrets are replaced by secure-store references and presence state, and finalization promotes temporary references only through the confirmed plan.

Local improvement signal collection is enabled by default; scheduled model evaluation is opt-in. Automatic tuning no longer writes runtime decisions directly. It creates an improvement candidate and Change Plan. Generated skills remain Code Mode candidates and are not callable until validation, canonical approval, exact hash verification, and activation. Existing autonomous grants cannot bypass that confirmation.

## Source and Packaged Updates

Source evolution is opt-in and supports one registered GoatCitadel source install in v1. Registration validates repository identity and baseline, clean state, fixed local volume, canonical project markers, safe Git shape, and no symlink, junction, reparse, or path-jail escape. Models never receive the registered path.

Code Mode stages an update in an isolated leased worktree. The immutable manifest records the base SHA/tree, patch hash, changed-file hashes, Gateway-selected validation commands and results, artifact references, risk, and rollback material. Generated code cannot select its own proof requirements.

Live apply requires a separate **Apply and restart** approval. The Windows native helper revalidates the registered root, exact base, clean state, manifest and patch hashes, policy, approval, and helper identity; applies only the approved patch with no-follow/path-jail controls; restarts and smoke-checks the product; and restores the prior state when the approved operation fails. Protected-core, dependency, native-binary, lockfile, trust-root, and migration changes require specialized approval and deeper proof. Dependency apply is offline-only after verified prefetch. Automatic migration apply is limited to proven local SQLite changes; PostgreSQL migration plans stop at `manual_required`.

Packaged installs reject Chat-generated patches. They may present only an official update that passes the existing publisher, signed-manifest, payload, and installer verification boundary.

## Rollout and Proof

Runtime defaults are:

- `evolutionControlPlaneV1Enabled`: on, with a kill switch;
- `improvementLocalObservationV1Enabled`: on;
- `improvementModelEvaluationV1Enabled`: off until opted in;
- `productSourceEvolutionV1Enabled`: off until explicitly enabled and a source install is registered.

`pnpm verify:chat-evolution` extends `verify:self-configuration` with focused contract, policy, Gateway, storage, Chat/Settings UI, capability, source-helper, and packaged-update-boundary checks. Its proof matrix is intentionally `foundation_only`: public claims remain held until retained real-provider onboarding, browser secure-input, live Windows restart/automatic restore, and signed installer promotion evidence exists.
