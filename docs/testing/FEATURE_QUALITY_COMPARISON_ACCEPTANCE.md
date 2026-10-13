# Feature-quality comparison acceptance

This opt-in suite extends the existing [comparison harness](AGENT_COMPARISON.md).
Preparation makes unrun fixtures. Controlled conformance tests prove the harness;
they do not prove live product quality or cross-product parity.

Live hosted/local execution and physical two-machine acceptance were explicitly
deferred by the user on 2026-10-12. The matrices and budgets below remain the
requirements for a future campaign. No deferred cell is counted as passed, and
OpenClaw/Hermes recovery launch bindings and public native evidence readers are
implemented. Controlled checks do not establish live acceptance.

## Matrix and accounting

The original five fixtures remain unchanged: cited research from supplied files,
code repair, document generation, workflow capture/reuse, and scheduled delivery.
Three products times five tasks times three trials gives **45 cells per track**.

`feature_acceptance_v1` is a separate matrix: open-web research, scheduled
tool-using agent work, provider recovery, and delegated recovery. Three products
times four tasks times three trials gives **36 additional cells per track**.
It does not substitute for the original 45. Skill/context and MCP acceptance
remain separate product evidence in the pilot inventory.

All hosted baseline, acceptance, retry, child and retest requests share the same
pilot journal: **450 requests or $25, whichever is reached first**. Local runs
use a separate **450-request, zero-provider-dollar** journal from the same pilot.
The local request cap is a conservative pilot policy; it does not price hardware,
electricity or operator time. A new campaign does not reset either track. Never
initialize a second pilot to continue an exhausted budget.

Each campaign pins one common supported context limit of at most 64,000 tokens,
4,096 output tokens, and a ten-minute task deadline. Primary, auxiliary, retry and
child provider routes must all use the cell's short-lived metered proxy. Missing
usage and ambiguous outcomes remain unknown/reserved. The buffered proxy does
not prove time to first token or prompt-cache effectiveness.

## Prepare and execute

Use the reviewed configuration and supervised option shapes in
[AGENT_COMPARISON.md](AGENT_COMPARISON.md). Hosted and local configurations must
name the exact endpoints, model, source revisions, reasoning, tools, grants and
transport metadata approved in the live preflight. Do not put secret values in
these files. Every command below runs from the repository root.

```powershell
# Once for the whole pilot; preparation does not call a model.
node scripts/verification/agent-comparison-pilot.mjs init C:\acceptance\pilot

# Reuse this pilot for original fixtures, extra acceptance, and all retests.
node scripts/verification/agent-comparison-pilot.mjs prepare C:\acceptance\pilot\pilot.json C:\acceptance\hosted-config.json C:\acceptance\hosted-baseline
node scripts/verification/agent-comparison-pilot.mjs prepare-acceptance C:\acceptance\pilot\pilot.json C:\acceptance\hosted-config.json C:\acceptance\hosted-features
node scripts/verification/agent-comparison-pilot.mjs prepare-acceptance C:\acceptance\pilot\pilot.json C:\acceptance\local-config.json C:\acceptance\local-features
```

Execution is a separate, explicitly authorized live operation. The concrete Goat
adapter is `scripts/verification/lib/agent-comparison-goat-acceptance.mjs`. Its
reviewed API source pin is `997e682752d939b415ee71523794197a37d4d4d3`. The CLI checks
the product manifest against this pin and requires a clean checkout at the exact
declared revision. A dirty implementation checkout cannot serve as live proof.
After a new release-candidate commit, re-review the adapter against its APIs and
receipts and update the pin deliberately; do not bypass the checkout check.

The adapters use native public APIs or CLI transcripts. The shipped supervisor
supplies process ownership, typed operator reviews and deliberate fault
setup/observation. Its launch hash binds the complete comparison-module family,
native executable, product source pin and effective configuration. Preparation
requires a clean checkout; it starts no runtime and makes no model request.
The repository does not guess an installed runtime, acquire
channel credentials, auto-approve effects, or attach to an ambient Gateway.

```powershell
$adapterPath = (Resolve-Path -LiteralPath 'scripts/verification/lib/agent-comparison-goat-acceptance.mjs').Path
$adapterHash = (Get-FileHash -LiteralPath $adapterPath -Algorithm SHA256).Hash.ToLowerInvariant()
node scripts/verification/agent-comparison-acceptance.mjs --prepare-launch C:\acceptance\hosted-features\manifest.json C:\acceptance\web-options.json C:\reviewed-runtime\node.exe reviewer C:\acceptance\web-launch.json

# options.cellId selects one declared cell, e.g. goatcitadel:web_research:1.
# Review the adapter and shipped supervisor imports BEFORE using their hashes.
# A terminal is required for exact typed launch, permission and artifact reviews.
node scripts/verification/agent-comparison-acceptance.mjs C:\acceptance\hosted-features\manifest.json C:\acceptance\web-options.json C:\acceptance\web-cell-1 $adapterPath $adapterHash --shipped-supervisor C:\acceptance\web-launch.json

# Independent recording requires both complete exported journals and bound measurements.
node scripts/verification/agent-comparison-record.mjs C:\acceptance\hosted-features\manifest.json web_research 1 C:\acceptance\web-cell-1\workspace C:\acceptance\web-cell-1\evidence C:\acceptance\web-cell-1\journal-export.json C:\acceptance\web-measurements.json C:\acceptance\web-result.json C:\acceptance\web-cell-1\pilot-budget-export.json
```

The local command uses its local manifest/options and the same form of recorder
arguments. A local journal cannot be replaced with the hosted journal. Preserve
the campaign directory, raw native receipts, artifacts and journals, including
failed/incomplete trials. Session shutdown alone leaves task outcome unverified.

## Supervisor boundary

The reviewed supervisor exports `createAcceptanceSupervisor({session, manifest,
options})`. It returns these ports; none receives a task-success grade to return:

| Port | Required behavior |
| --- | --- |
| `start({taskId, revision, workspace, connectionFile, signal})` | Launch only a fresh task-owned Gateway using the cell's proxy credential; return `runtimeId`, stable `stateId`, `revision`, exact `workspace`, secret-free `configurationSha256`, loopback `baseUrl`, and fresh `token`. All model routes, including fallback/auxiliary routes, must use the proxy. |
| `stop({runtimeId, stateId})` | Close only the exact owned process tree, with bounded cleanup. Never stop another server or reuse the operator's daily data. |
| `reviewPermissions({taskId, runtimeId, configurationSha256, sourceReceipts, signal})` | Obtain an explicit operator review and return the same configuration hash, `reviewedBy`, `reviewedAt`, and native `policy` with `files`, `terminal`, `skills`, `schedule`. Retain feature-specific grants in this review too. Files must be workspace-only; scheduled delivery requires per-send approval. |
| `restart({runtimeId, stateId, signal})` | Restart that owned process over the same state/configuration; return a new runtime identity and refreshed connection details. Changing state or configuration invalidates the trial. |
| `reviewSources({artifact, artifactSha256, tools, signal})` | Human review with `reviewerKind:"human"`, reviewer identity, exact artifact hash, claim hashes and support decisions, reviewed conflicts, and `conflictSearchCompleted`. An LLM self-grade is refused. |
| `authorizeSchedule({task, signal})` | Human authorization with actor identity, exact channel/connection/numeric target, schedule expression and future `scheduledFor` within five minutes. The adapter creates the job through the public API; it does not submit internal creator authority. |
| `approve({approval, signal})` | Human decision for the exact pending approval. Return `actorKind:"human"`, `actorId`, matching `approvalId`, `decision:"approve"`; the adapter resolves it through the public approval route once. |
| `armPreDispatchFailure({runtimeId, providerId, signal})` | Arrange one charged controlled failure before forwarding upstream; return `boundary:"before_upstream_forward"`, `maxFaults:1`. The product did reach the fixture transport. This is not native confirmed non-dispatch. |
| `observeProviderFault({runtimeId, signal})` | Retain the exact fault receipt, no-upstream-forward boundary and zero useful output; join its timing to native initial/fallback usage and actual route disclosure. |
| `armUncertainEffect({runtimeId, signal})` | Configure one reviewed isolated transport case; return exact runtime, native `toolName`, `argsSha256`, and bounded task prompt. This is a separate Chat run. |
| `observeEffectTransport({...scope, effectId, toolName, argsSha256, signal})` | Read the owned external transport ledger. Return the exact correlation, raw `dispatches` with transport receipt IDs/outcomes, and observed automatic retry count. A Chat error alone does not prove that a send happened. |

Research requires source review; schedule requires authorization/restart/approval;
fallback requires both fault ports and external transport observation; delegation
requires restart. Missing ports refuse the run before native task mutations.
The adapter verifies public provider configuration on startup and every restart.
It never retries an uncertain API mutation.

## Evidence and limits

- Research requires actual `browser.search` and `browser.extract` receipts from
  at least two HTTPS domains, artifact quotation checks, and human claim review.
- Scheduled work requires a genuine `scheduled_due` occurrence, its exact
  tool-using Chat child, canonical approval replay, a restart, one acknowledged
  delivery, and at least 30 seconds of unchanged delivery state after reconnect.
  A manual cron trigger is refused. Post-Chat delivery recovery is explicitly
  recorded as `delivery_resumed`, not an invented Chat re-execution.
- Provider recovery requires a retained controlled pre-forward failure joined to
  canonical failed initial usage and successful fallback, visible route disclosure, and a
  distinct uncertain-effect run whose external observer proves no repeated send.
  A fault receipt without those native outcomes cannot pass.
- Delegation requires the public two-child delegation projection, actual child
  usage/budgets and structured `{region,totalCents}` outputs, restart after exactly
  one child finishes, retained identities, and independently computed synthesis.
  Missing projection/budget/result data, or both children finishing before the
  restart boundary, leaves the trial incomplete. No fixture-derived child result
  is substituted. This adapter is not hardware or automatic-fanout composition proof.

Automatic fanout provides durable task decomposition and a parent join. The local
Gateway durable worker currently executes queued children serially; admission of
two children does not prove simultaneous child inference. The separate public
composition fixture uses a controlled local provider, exact project/activation
and tool permissions, one-child settlement before parent synthesis, and the actual
approval owner. It does not replace the live restart/budget comparison above.

The fanout recovery tests also simulate a committed child aggregate followed by a
lost parent wake and advanced watcher acknowledgement. A fresh service instance
finds the exact waiting parent through bounded maintenance, reuses committed child
results, and refuses closed admissions or changed session control. This controlled
crash-boundary proof does not claim an actual killed-process acceptance run.

Raw API and operator receipts are retained with hashes outside the model workspace;
Gateway/proxy credentials are redacted. Receipt hashes bind retained bytes and do
not authenticate arbitrary third-party logs. Permission review v1 normalizes four
shared dimensions; feature-specific equivalence still requires the retained source
review of each product's actual grants and transport configuration.

Revision-pinned native web adapters are supplied for OpenClaw and Hermes. For
this exact additional suite, their scheduling and delegation cells retain
source-backed unsupported predicates in `agent-comparison-acceptance-profile.mjs`;
this does not claim that those products lack scheduling or delegation. Their
provider-recovery cells now bind the metered fallback and reviewed marker through
normal native configuration/launch paths. Readers validate exact public terminal
and transcript receipts; OpenClaw RPC route evidence is not Chat-visible proof,
and Hermes custom billing does not distinguish its two custom-provider aliases.
Missing native canonical reconciliation evidence stays unavailable. Original
acceptance predicates are unchanged and cannot pass on these missing metrics.
All live cells remain unrun until compatible model configuration and a reviewed
clean candidate are available. A passing controlled test never upgrades them to live.

For scheduled Goat work, the shipped supervisor additionally needs a reviewed
future occurrence and test destination in `settings.schedule`. A fresh profile
may configure `channelKey:"ntfy"` with `connection:{baseUrl,topic}` for an explicitly
owned credential-free HTTP receiver at `127.0.0.1`; the public connection API
creates its identity after typed review. No channel credentials are inherited.
Alternatively a custom reviewed supervisor may provision an authorized destination.
The same original task deadline covers setup, reviews, restart and observation.
The owned-process proof confirms root cleanup; it does not certify an OS sandbox
or containment of escaped descendants.

## Controlled validation

```powershell
node --test scripts/verification/lib/agent-comparison-acceptance.test.mjs scripts/verification/lib/agent-comparison-goat-acceptance.test.mjs
node scripts/verification/agentic-proof.mjs --profile chatFanout --output output/feature-quality/chat-fanout-proof.json
```

These tests exercise both track budgets, phase/provenance checks, independent
criteria, native HTTP action shapes, operator ownership and cleanup. They do not
contact live models, search providers, or delivery channels.
