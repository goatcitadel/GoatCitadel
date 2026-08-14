# Evolution Control Plane

Last updated: 2026-08-14

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

## APIs and Compatibility

Canonical resource APIs are:

- `POST/GET /api/v1/change-plans`
- `GET /api/v1/change-plans/:planId`
- `POST /api/v1/change-plans/:planId/responses`
- `POST /api/v1/change-plans/:planId/confirmations`
- `POST /api/v1/change-plans/:planId/cancellations`
- `POST /api/v1/change-plans/:planId/rollback-requests`

Dedicated owner routes handle secure fields, provider OAuth start/poll/completion, and the native path picker. Compatibility Chat and Settings routes re-enter the same adapters and return additive plan/receipt references. An explicit legacy Settings save counts as confirmation only for its exact server-resolved typed operation; it does not create a generic write bypass.

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
