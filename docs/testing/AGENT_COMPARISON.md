# Comparative task outcomes

This is the C6 evidence workflow in the [master program](../MASTER_COMPLETION_PROGRAM.md).
Preparation and report generation are local operations. They do not dispatch models,
send channel messages, or certify product quality.

1. Pin each checkout's full commit SHA. Record effective provider, model, reasoning,
   context/output limits, tool capabilities, grants, and task deadline. Use fresh,
   dedicated test workspaces with equivalent tools and input files. The capture
   scenario begins without a preinstalled skill.
2. Declare the total provider-request and dollar caps before dispatch. Count primary,
   retry, and child calls against one budget. `ComparisonDispatchBudget` reserves each
   attempt before its transport starts and retains ambiguous costs. Its sink must
   durably append and flush receipts. It is an adapter boundary, not a firewall:
   do not run an uninstrumented CLI and claim that this class capped its requests.
   The supervised transport below supplies an actual loopback HTTP boundary and
   an exclusive, fsynced campaign journal for that purpose.
3. Run `node scripts/verification/agent-comparison.mjs prepare config.json NEW_DIRECTORY`.
   The manifest contains at least three repetitions of each of the five common tasks
   for all three products, with rotating product order. A zero budget permits
   preparation only. No fixture becomes a successful result during preparation.
4. Execute the cells through instrumented product adapters or supervised runs whose
   canonical provider boundary enforces the declared combined cap. The shipped
   `agent-comparison-serve.mjs` starts a supervised, instrumented provider connection
   for one cell. Product configuration, tool/approval equivalence, and native task
   evidence require operator review. Reviewed native launch helpers are supplied
   for the three file/terminal tasks; skill and delivery steps remain supervised.
5. Run `node scripts/verification/agent-comparison-verify.mjs TASK WORKSPACE EVIDENCE NEW_RESULT_FILE`.
   The independent verifier checks each task criterion against retained artifacts,
   actual test results, skill-load records, and provider delivery receipts. It hashes
   its implementation, fixture module, and the exact evidence bytes. Model self-grades
   are not consumed by these verifiers.
6. Run `node scripts/verification/agent-comparison.mjs report MANIFEST NEW_REPORT_DIRECTORY RECEIPTS`.
   Preserve failed and unsupported rows. Missing cost is `null`, never zero. Inspect
   correctness before comparing time, cost, and intervention counts. A full common
   task campaign requires equivalent configurations and live observed outcomes.

Configuration shape (replace every placeholder and set explicitly authorized caps):

```json
{
  "schemaVersion": "goatcitadel.agent-comparison.v1",
  "trials": 3,
  "maxRequests": 0,
  "maxCostUsd": 0,
  "products": {
    "goatcitadel": {
      "revision": "FULL_40_CHARACTER_COMMIT_SHA",
      "provider": "SAME_EFFECTIVE_PROVIDER",
      "model": "SAME_EFFECTIVE_MODEL",
      "reasoning": "medium",
      "contextTokens": 128000,
      "outputTokens": 4096,
      "maxTaskMs": 600000,
      "tools": ["files", "terminal", "skills", "schedule"],
      "grants": ["dedicated-test-workspace", "authorized-test-channel"]
    },
    "openclaw": { "copy": "the same explicit fields, with OpenClaw's SHA" },
    "hermes": { "copy": "the same explicit fields, with Hermes's SHA" }
  }
}
```

Receipts bind `product`, `task`, `trial`, `revision`, `manifestSha256`,
`fixtureSha256`, and `effectiveConfigSha256`. They include `evidenceKind`
(`live` or `controlled`), `outcome`, `durationMs`, `requests`, `costUsd`, and
`manualInterventions`. Passing receipts also need `verifier`, `verifierSha256`,
and all task criteria under `checks`, each with `passed: true` and an
`evidenceSha256`. Hashes bind supplied receipts; operators must retain and inspect
the matching artifacts. The report does not independently authenticate remote logs.

Optional `timeToUsefulOutputMs`, `inputTokens`, `outputTokens`, and
`repeatedCorrections` fields preserve unavailable measurements as `null`. Useful
output means the first independently verified task result, not the first token.
Retain its timestamp and verification evidence with the receipt. Token counts
come from canonical provider accounting; repeated corrections are a subset of
manual interventions. The report rejects negative counts and timestamps beyond
the task duration, and never fills a missing measurement with zero.

The report reconstructs the expected trial matrix before accepting a manifest,
so deleting trials and recomputing the hash does not shrink the denominator.

### Permission evidence

Matching tool names and grants establishes declared configuration equality only.
`comparable_live_results` also requires a retained, known, equivalent permission
policy for every cell. Missing reviews, unknown policy values, enabled tools
described as disabled, and different permission policies prevent that status.
The JSON and Markdown reports show permission equivalence and the reviewed
policies separately from task outcomes. Controlled receipts still cannot count
as live results.

Retain `native-permission-review.json` alongside the native receipts. Its
`schemaVersion` is `goatcitadel.agent-comparison.permissions.v1`; copy the six
execution-binding fields from `session-start.json`, and include `reviewedBy`,
`reviewedAt`, `policy`, and `sourceReceipts` (native configuration/evidence paths
and their byte SHA-256 values). Every source receipt must also appear in
`execution.json`'s `nativeReceipts`. The verifier checks the exact binding and
bytes; a hash does not authenticate a third-party log or replace operator review.

`policy` has exactly four fields:

| Field | Supported values |
| --- | --- |
| `files` | `workspace_only`, `host_user`, `disabled`, `unknown` |
| `terminal` | `per_command_approval`, `allowlist_miss_approval`, `risk_based_approval`, `unrestricted`, `denied`, `disabled`, `unknown` |
| `skills` | `review_before_activation`, `automatic_activation`, `disabled`, `unknown` |
| `schedule` | `authorized_destination`, `per_send_approval`, `disabled`, `unknown` |

The native launcher retains this file from the operator's existing exact-launch
review and the profile's source-reviewed policy; it never invents a reviewer.
For supervised skill/delivery journeys, the final `reuse` or `reconnect` receipt
may attach `permissionReview: { path: "native-permission-review.json", sha256 }`.
The controller retains that reference, and the verifier checks its binding and
native sources. The recorder uses this verified evidence, not a policy asserted
in the measurements file. Earlier receipts without it remain usable as task
evidence but cannot establish a comparable campaign.
Per-product, per-task summaries show observed passes/failures, exclusions, and
minimum/median/maximum duration, cost, and manual interventions. Missing costs
remain unknown and controlled runs never enter the live success denominator.
Only the documented configuration and receipt fields enter report output.

Scheduled delivery requires an explicit test destination and time. Approval resume,
restart recovery, and native Windows remote execution remain separate capability
rows; do not force unsupported features into the common-task success denominator.

`workflow_capture_reuse` has three ordered phases: complete and verify a source
workflow, explicitly capture/review its reusable skill, then reuse that exact
version in a new session. Reuse input files are introduced only after capture.
Retain source-turn provenance, the reviewed instruction hash, activation evidence,
and the new session's actual skill-load record. A preinstalled skill or reuse in
the source conversation cannot pass this scenario.

Adapter references checked during implementation:

- [OpenClaw agent CLI](https://docs.openclaw.ai/cli/agent): structured output and isolated execution controls.
- [Hermes CLI](https://hermes-agent.nousresearch.com/docs/user-guide/cli/): query-file input, model/provider selection, and toolsets.

These references inform adapter work; they are not a compatibility receipt for an
unpinned upstream revision.

## Independent verification and recording

Keep the output workspace and evidence directory separate. `execution.json` in
the evidence directory uses schema `goatcitadel.agent-comparison.execution.v1`
and declares `taskId`, `product`, `source` (`native_receipts` or
`controlled_fixture`), and `nativeReceipts` (relative `path` plus byte `sha256`).
The verifier rejects changed receipts, rewritten input fixtures, linked files,
and evidence outside these roots. It preserves raw code-test output with its hash.
The code-repair verifier executes the submitted module and tests as trusted code
under the host user, with time, heap, output, and process-stop bounds. This is not
a hostile-code sandbox; inspect unfamiliar submissions before invoking it.

Research produces `answer.json`; document generation produces `report.md`.
Workflow evidence includes the three native phase/session/turn identities,
`reviewed-skill.md`, reviewed and loaded instruction hashes, and activation events.
Delivery evidence includes the persisted schedule, authorized destination, actual
provider acknowledgment, and at least 30 seconds of observation after reconnect.
The controlled fixtures in `agent-comparison-verifiers.test.mjs` document these
shapes without representing real product or channel success.

To combine fresh verification with campaign accounting, run:

```text
node scripts/verification/agent-comparison-record.mjs MANIFEST TASK TRIAL WORKSPACE EVIDENCE JOURNAL MEASUREMENTS NEW_RESULT_FILE
```

The journal contains `manifestSha256` and the complete ordered `events` emitted
by `ComparisonDispatchBudget`. Cell IDs use `product:task:trial`. Measurements
must bind `executionId`, `manifestSha256`, `cellId`, `revision`,
`effectiveConfigSha256`, and `fixtureSha256`; the same bindings must be retained
in `execution.json`. They also contain the duration and operator-intervention
measurements described above. Recording derives request counts and known costs
from the complete journal, including primary, retry, and child reservations. It
records an otherwise successful output as blocked when dispatch accounting is
missing or ambiguous. Retain the whole recording result; add its `receipt` to
the final report's receipt array.

These commands check retained evidence; they do not authenticate its external
origin or retroactively enforce a budget on an uninstrumented product. Reviewed
GoatCitadel/OpenClaw/Hermes launch profiles and supervised skill/delivery controls
are described below. Live campaigns and native skill/channel operations remain
pending; those operations still use the product's own UI or CLI.

Local coverage:

```text
node --test scripts/verification/lib/agent-comparison.test.mjs scripts/verification/lib/agent-comparison-verifiers.test.mjs scripts/verification/lib/agent-comparison-provider.test.mjs scripts/verification/lib/agent-comparison-session.test.mjs scripts/verification/lib/agent-comparison-native-driver.test.mjs
```

## Supervised provider connection

Add a public `transportProfile` to the preparation config before creating its
manifest. It pins `upstreamUrl` (one HTTPS `/chat/completions` endpoint),
`outputField` (`max_tokens` or `max_completion_tokens`), and `pricing` with
`inputUsdPerMillion`, `outputUsdPerMillion`, `requestUsd`, `observedAt`, and
`sourceSha256`. Retain the actual pricing source whose bytes match that hash.
Use verified upper rates, including applicable request fees. Every product cell
must use this same transport and price profile; changing it requires a new
declared campaign rather than changing prices halfway through a report.

Create an options JSON file with schema
`goatcitadel.agent-comparison.supervised.v1`, `cellId` (for example
`goatcitadel:cited_research:1`), absolute `checkoutRoot`, `apiKeyEnv` (the name of
a credential environment variable, never its value), and the same `upstreamUrl`,
`outputField`, and `pricing`. Then run:

```text
node scripts/verification/agent-comparison-serve.mjs MANIFEST OPTIONS NEW_CELL_DIRECTORY
```

`NEW_CELL_DIRECTORY` must be directly under the manifest's canonical campaign
directory. The command checks the product's clean checkout and pinned commit,
requires positive authorized caps, and opens the campaign's one budget writer.
It creates the initial task workspace, prompt, evidence directory, and a
`provider-connection.json` containing only a short-lived loopback token. Setup
makes no upstream call. The upstream credential stays in the supervising process;
start the product from a separate credential-free environment and give it only
this connection. These files are operator-owned evidence, not an OS isolation
boundary or a substitute for reviewing the product's permissions.

Configure a fresh product profile and inspect its effective model, reasoning,
tools, grants, and every auxiliary/retry provider path before dispatch. Retain
that native configuration evidence. Disable alternate providers and inherited
personal credentials, preserving the declared approval posture. In particular,
Hermes's top-level `--oneshot` enables automatic approval, so it does not preserve
a governed comparison profile. Use the pinned revision's interactive or query-file
flow and record actual interventions. The harness does not automate these reviews
or assert that an unconfigured product's egress was captured.

The proxy admits only the pinned text model and function tools. It enforces a
conservative input bound, output cap, ordinary service tier, and per-request
deadline. Each HTTP attempt reserves the worst-case price before dispatch, so SDK
retries and opaque children share the cap. Their lineage is `unclassified` unless
native product evidence proves it. Model discovery is answered locally; redirects,
multimodal requests, hosted provider tools, and unsupported extra body fields are
rejected. Missing usage, failed transport, or failed receipt persistence retains
the full reservation and cannot return a successful model result.

Responses are buffered until native usage evidence and budget settlement are
flushed. First-token latency is therefore unavailable. Costs use reported token
counts and pinned rates (`usage_with_pinned_rates`), not a claim about the provider's
final invoice or cache discounts. Both limitations must accompany reported costs
and timings.

The cell closes at its declared deadline. For an earlier stop, stop the product's
work and press Ctrl+C in the supervising process. This aborts and drains its owned
provider connections, writes native attempt receipts plus `session-finish.json`,
and exports `journal-export.json` for the recording command. It does not terminate
an independently started product process. A crashed writer's lock and incomplete
journal remain for operator inspection; automatic lock stealing and truncation
are deliberately unsupported.
A cell with retained provider attempts cannot be reopened as a fresh trial with
reset timing. Keep failed and interrupted outcomes; ordinary retries must remain
inside the original live cell and shared budget.

Copy the execution binding from `session-start.json` into the task's native
`execution.json` and measurements; retain both product-native task receipts and
the hashed provider-attempt references. A transport closeout is always unverified
task evidence. Complete the independent task verifier before recording a result.
For workflow capture, only source inputs are materialized initially: introduce
the reuse fixture after reviewing the captured skill, in a new native session.
For scheduled delivery, use only the explicitly authorized destination and time.

## Reviewed native CLI profiles

The native helper prepares GoatCitadel at
`41d0f2e52910c60c39fa0b788042638eddf302e5`, OpenClaw at
`309ae03db2d45312d877e766f8f60731ad5971b7` and Hermes at
`bf53ff00a7360826ec2c9e2949533160068a8fc8`. Its command and config shapes were
read from those source revisions. The local tests cover configuration binding,
credential filtering, literal argument transport, and actual controlled process
exit/abort/output limits. They do not establish that either product has completed
a live benchmark using these configurations.

Use a profile declaring `files` and/or `terminal`, with `test-workspace` as its
only grant. These adapters support `cited_research`, `code_repair`, and
`document_generation`. Other grants, revisions, or tool sets fail before launch;
the skill-capture and scheduled-delivery journeys retain their supervised flow.
The pinned Hermes runtime requires a context window of at least 64,000 tokens.
Preparation rejects smaller Hermes profiles instead of silently increasing their
budget. Review one compatible context limit across all three products.
The prepared native policies differ in their mechanisms, so common manifest
labels alone are not evidence of equivalent permissions. Retain the review and
actual operator-intervention counts alongside results.

The OpenClaw headless profile uses canonical `tools.exec.mode: "ask"` and an empty
safe-binary list. The pinned `agent exec` command merges a `mode: "full"` default;
legacy `security`/`ask` fields alone leave that mode active. Approval connections
are confined to the owned comparison listener, which rejects Gateway traffic.
The default headless adapter owns no OpenClaw approval Gateway and never selects
a personal one. The opt-in supervised approval path below starts a separate
Gateway for terminal approval/resume.
Hermes applies risk-pattern approval rules and allows ordinary commands; its
native file tools can access host-user paths. These are different policies from
GoatCitadel's workspace roots and per-command shell approval.

### Controlled native file-tool check

Use the following command to verify the actual pinned OpenClaw or Hermes runtime
against synthetic responses through the shipped comparison proxy:

```text
node scripts/verification/agent-comparison-native-conformance.mjs PRODUCT ABSOLUTE_CHECKOUT ABSOLUTE_NATIVE_EXECUTABLE NEW_ABSOLUTE_DIRECTORY [--permissions]
```

`PRODUCT` is `openclaw` or `hermes`. Prepare a clean checkout at the revision above,
install its pinned dependencies in that dedicated checkout, and build OpenClaw
before running. The executable is the absolute native Node path for OpenClaw or
the dedicated Python environment's executable for Hermes. The output directory
must be new; existing evidence is never overwritten. No provider credential is
needed or inherited.

The command creates a fresh product home and workspace, requests one native read
of `fixture.txt`, verifies that its contents return through the tool result, and
requires the expected final reply. It fixes the context limit at 128,000 tokens,
output at 512 tokens, reasoning at `none`, and runtime at 90 seconds. Every local
model call passes through the real proxy and its fsynced synthetic budget journal;
the upstream transport is replaced with controlled responses and never calls a
model provider. Synthetic prices and caps do not authorize a live campaign.

Add `--permissions` to test an outside-workspace read and a harmless terminal
command. Both the sibling file and terminal script belong to the new fixture
directory. Only an independently read, create-only marker proves terminal
execution; quoted commands and absent output do not. Native tool IDs are matched
exactly, and auxiliary model requests cannot mark the main agent's tools missing.

`proof.json`, `launch.json`, `manifest.json`, and `journal.jsonl` retain the result,
profile hash, configured permissions and observed native tool results. Probe
`success` means the controlled observations completed and matched the profile's
tested permission rules. Contradictory or inconclusive observations fail the
check and retain their evidence. It does not mean every
action was allowed or that an approval/resume journey passed. In particular,
`approval_unavailable` distinguishes failed approval registration from policy
denial. The default OpenClaw profile denies the sibling read and leaves the
terminal action unexecuted; Hermes allows both controlled actions. Host isolation,
approved terminal execution, skill/channel operations, model quality and live
comparative outcomes still need their separate checks. Earlier failed runs remain
separate when native configuration or the harness changes.

Preparation needs the manifest, the existing supervised options, the absolute
native Node executable for GoatCitadel/OpenClaw or Python executable for Hermes, and a new
launch-file path. It works with zero caps and starts no product or provider call:

```text
node scripts/verification/agent-comparison-native.mjs prepare MANIFEST OPTIONS NATIVE_EXECUTABLE NEW_LAUNCH_JSON
```

The file contains the exact config template, native tool mapping, review notes,
source revision, executable and tool-Node hashes, and launch hash. GoatCitadel also
binds its built Gateway entrypoint and the two native-driver files. Review it before recording a
separate JSON with `schemaVersion: "goatcitadel.agent-comparison.native.v1"`, its
`launchSha256` and `effectiveConfigSha256`, `nativePolicyReviewed: true`,
`credentialIsolationReviewed: true`, `reviewedBy`, and an ISO `reviewedAt`.
These are the only supported review fields; credentials do not belong there.
Changing the source checkout, executable, profile, or manifest invalidates review.

```text
node scripts/verification/agent-comparison-native.mjs run MANIFEST OPTIONS LAUNCH_JSON REVIEW_JSON NEW_CELL_DIRECTORY
```

Run still requires the explicitly authorized positive campaign caps and named
upstream credential. The supervisor writes a fresh product home/config, gives the
product only the loopback proxy token, and excludes ambient provider credentials,
preload hooks, proxy variables, and personal executable paths. It preserves
native approvals; headless denials are retained outcomes, not auto-approved
commands. OpenClaw's native cost metadata is zero because the proxy owns pinned
cost accounting; use the provider journal, not the CLI's estimated cost.
Checkout-local `.env` and `.env.local` files are rejected without reading their
contents, because Hermes can load a project dotenv file despite a fresh home.

GoatCitadel starts a new token-authenticated loopback Gateway with an empty
runtime, disabled OS secret store, one proxy-backed provider, and a reviewed
file/terminal policy. It creates a workspace, project, and session through public
APIs, checks the route preflight, then uses the durable Chat send path. It retains
the native HTTP responses, including pending approvals, without approving them.
The local controlled process proof completed a canonical Chat turn; it does not
certify a live model or a clean pinned product benchmark.

The supervisor bounds captured output, stops its own direct process on deadline
or interruption, and closes the provider connection. A fresh home and environment
are not OS isolation. Inspect dependencies, ignored build/runtime files, plugin
paths, and native file/terminal permissions as part of configuration review.
The executable hash is not a hash of the entire installed dependency closure.
Detached descendants are not certified stopped; unclosed inherited output pipes
or failed cleanup produce explicit uncertainty instead of hanging the budget
owner. Use the product's native shutdown and a dedicated test account/host when
required by its policy. No personal runtime is selected or modified by the helper.

`native-launch.json`, `native-output.json`, and `native-process.json` preserve the
review and process evidence. A zero exit code remains `taskOutcome: unverified`;
the independent task verifier and native execution evidence are still required.
For the three artifact tasks, the helper also writes `execution.json` with those
receipt hashes and any retained GoatCitadel HTTP evidence.

### Supervised OpenClaw terminal approvals

Set `nativeApprovalGateway: true` in the OpenClaw options before preparing and
reviewing its launch. GoatCitadel supports this option as described below;
Hermes rejects it. For OpenClaw it selects
Gateway-backed `agent` execution, keeps native ask mode, and binds the supervisor,
profile, approval adapter, event client, and terminal console source hashes into
the launch review. Reusing a headless launch or changing those files fails review.

Run the normal native command directly in an interactive terminal. Piped input
is rejected before provider setup. The terminal displays the fixture workspace
and polls native pending requests. Enter `pending` to refresh, `allow-once EXACT_ID`
to authorize that request once, or `deny EXACT_ID` to refuse it. Ctrl+C or closing
input stops supervision. The console never selects an approval automatically,
adds standing grants, or retries a decision after an uncertain response.

The supervisor starts a fresh foreground Gateway on an ephemeral loopback port
with an independent token. Channels, cron, discovery, updates and public model
catalog refresh are disabled for this profile. A native CLI event client uses the
public SDK and the fresh Gateway's `operator.admin` scope, required by its owner
for cross-requester approval visibility. It retains events but cannot make a
decision through this implementation. The separate native approvals CLI applies
each typed decision. Existing Gateways and operator credentials are not selected.

The Gateway, event client and agent share the cell deadline and stop together
when the owned run exits, an approval owner fails, or the operator cancels.
Decision intent is retained before calling the native owner; the response or an
unconfirmed outcome is retained afterward. `execution.json` hashes those receipts,
the approval events and owned-process closeout. A successful approval is still
not task-quality evidence, and manual intervention counts remain separately
reviewed. Detached descendants and hostile-code isolation are not certified.

An opt-in controlled check runs this same campaign driver with a generated,
create-only marker command and synthetic model responses:

```text
node scripts/verification/agent-comparison-native-approval-conformance.mjs ABSOLUTE_OPENCLAW_CHECKOUT ABSOLUTE_NODE NEW_ABSOLUTE_DIRECTORY [allow-once | deny | abort]
```

Only this fixture command supplies a deterministic approval, after checking the
exact generated script and absence of its execution marker. `allow-once` requires
the marker after native resolution; `deny` and `abort` require no marker. Its
review is explicitly labeled as a controlled fixture, its prices are synthetic,
and it makes no upstream model request. It does not authorize a live campaign.

### Supervised GoatCitadel terminal approvals

Set `nativeApprovalGateway: true` in the GoatCitadel options before preparing and
reviewing its launch. Use the normal native command in an interactive terminal.
It displays native requests and accepts the same `pending`, `allow-once EXACT_ID`
and `deny EXACT_ID` commands. The supervisor forwards bounded output from its
isolated Gateway child and passes real terminal input to that child.

The launch pins Git as well as Node and the built Gateway. Only the new fixture
workspace receives an empty Git repository, using isolated Git configuration and
empty templates. Its relative project path resolves under the native workspace
root (`.`); that configured root and its filesystem and command jails are the
exact fixture directory. No commit
or staging is performed.

The adapter validates native workspace/session/turn linkage, the Chat run and
the distinct approval-wait run before forwarding a decision. Both workflows must
still await that approval. It retains intent, native result or uncertainty, and
waits for terminal Chat/durable state and the canonical post-turn children before
closing the Gateway. Console closure retains `interrupted.json`; a cancelled
child exits 130. The execution record hashes these HTTP and interruption receipts.

An interactive working-build fixture uses a generated create-only command:

```text
node scripts/verification/agent-comparison-goat-approval-conformance.mjs ABSOLUTE_WORKING_CHECKOUT NEW_ABSOLUTE_DIRECTORY [allow-once | deny | abort]
```

Review the displayed exact request and generated script, then type its requested
decision, or press Ctrl+C for `abort`. This helper makes no decision automatically.
Its built-app hash is retained, its provider responses and prices are synthetic,
and its proof is labeled `working_build_not_clean_pinned_campaign`. It does not
establish live-model quality, equivalent native policies or benchmark success.

### Supervised Hermes terminal approvals

Set `nativeInteractiveCli: true` in the Hermes options before preparing and
reviewing its launch. This option is Hermes-only and cannot be combined with
`nativeApprovalGateway`. It starts the native interactive CLI with explicit
file/terminal toolsets, omitting `--quiet` and leaving native approvals enabled.
Both stdin and stdout must be real terminals. Review and choose each action in
Hermes's own menu, then use `/exit` after the turn has settled.

Hermes needs terminal stdout to remain interactive. This mode therefore shows
stdout directly without capturing or byte-limiting it; the launch review and
process receipt disclose that limit. Stderr remains bounded. After shutdown, a
read-only export retains bounded native sessions, messages and tool-call IDs in
`native-hermes-transcript.json`, hashed by `execution.json`. Missing or excessive
native evidence cannot establish success. Approval counts remain unverified.
The combined provider budget and execution deadline still apply.

An interactive Windows fixture exercises a disposable file in the fresh workspace:

```text
node scripts/verification/agent-comparison-hermes-interactive-conformance.mjs ABSOLUTE_HERMES_CHECKOUT ABSOLUTE_PYTHON NEW_ABSOLUTE_DIRECTORY [allow-once | deny | abort]
```

Inspect the displayed command and exact generated file before selecting native
Allow once or Deny. For `abort`, press Ctrl+C at the pending menu, then `/exit`
after the interrupted turn. The helper supplies no approval. It requires the
native tool result and normal CLI exit; cancellation also requires the retained
interruption. A deadline with an unchanged file is insufficient. Responses and
prices are synthetic, and the fixture makes no upstream model request. Native
host access and risk-pattern approvals remain as documented above.

### Experimental GoatCitadel skill workflow

`nativeSkillWorkflow: true` opts a GoatCitadel `workflow_capture_reuse` cell into
the public-API workflow adapter. It requires `nativeApprovalGateway: true` and
file/skill tools. Typed `stage`, `artifacts` and `confirm` reviews bind exact
displayed hashes; native activation approval remains separate. The adapter
retains native phase receipts and uses a new session for reuse. It keeps review
input open across the three reviews, preserves full Change Plan session/turn
scope, and submits the native resume action after the exact approval effect
completes. Activation history binds the operator's approval to the candidate,
version and observed outcome. The independent verifier requires the native launch
receipt referenced by the permission review as well as the workflow receipts.
The campaign and fixture share an evidence reader that verifies all raw snapshots
against the existing phase bundles before referencing those bundles. It preserves
repeated polls and concurrent completion order, requires exact binding and hashes,
and limits files to 4 MiB, total reads to 32 MiB and snapshots to 500. The raw
files remain retained; the independent verifier still accepts at most 100
top-level receipts. See the
[campaign evidence repair](COMPARISON_IMPLEMENTATION_STATUS.md#bounded-native-workflow-campaign-evidence).

A controlled working-build run passed the complete capture/activation/reuse path
and all six independent outcome checks. The new Chat loaded the exact reviewed
skill hash and processed inputs withheld until activation. Model responses were
synthetic and upstream requests were zero. This is separate from clean-pinned
campaign proof and live-model quality. See the
[retained evidence and remaining work](COMPARISON_IMPLEMENTATION_STATUS.md#goatcitadel-native-skill-workflow-in-progress).

To exercise that local fixture from a real terminal with fresh isolated state:

```sh
node scripts/verification/agent-comparison-goat-workflow-conformance.mjs ABSOLUTE_WORKING_CHECKOUT NEW_ABSOLUTE_DIRECTORY
```

### Supervised OpenClaw skill workflow

For a pinned OpenClaw `workflow_capture_reuse` cell, declare `tools: ["files", "skills"]`
and both `nativeApprovalGateway: true` and `nativeSkillWorkflow: true` before
preparing and reviewing its launch. Terminal tools and proposals with supporting
files are not supported by this workflow adapter. Use a real terminal for its
typed artifact review and separate apply confirmation.

The native agent stages a pending Workshop proposal. Review includes its origin,
native revision hash, complete draft, and a derived preview of the installed
instructions. The native public apply owner performs activation. Its durable
event and the installed bytes must match before the shared phase controller
releases held-out input. A different native session must actually read the whole
reviewed skill, and post-reuse inventory/history must show no extra activation.

The agent-level skill filter permits only `release-note`, which is not preinstalled.
Other file/terminal profiles use an explicitly empty agent skill filter. In this
pinned revision an empty `skills.allowBundled` would instead allow bundled skills.
Workshop autonomy is off and lifecycle approval is pending. That policy governs
Workshop operations; it does not prevent arbitrary skill-file edits through
other filesystem owners or establish an OS sandbox.

To exercise the real pinned runtime with synthetic provider responses:

```text
node scripts/verification/agent-comparison-openclaw-workflow-conformance.mjs ABSOLUTE_OPENCLAW_CHECKOUT ABSOLUTE_NODE NEW_ABSOLUTE_DIRECTORY
```

Inspect each displayed artifact/action before entering its exact requested hash.
The fixture does not answer its own review. It uses the production campaign
driver and retains `controlled_fixture` provenance through independent
verification. Its six passing outcome checks establish a controlled native
journey, not real-model quality or a comparable live campaign. See the
[native evidence](COMPARISON_IMPLEMENTATION_STATUS.md#openclaw-native-skill-workflow).

### Supervised Hermes skill workflow

For a pinned Hermes `workflow_capture_reuse` cell, declare `tools: ["files", "skills"]`,
`nativeInteractiveCli: true` and `nativeSkillWorkflow: true` before preparing and
reviewing the launch. This workflow has no approval Gateway. Use the native Python
executable; the reviewed Node coordinator owns its sequential CLI processes.
Terminal tools, skill batches and supporting-file writes are outside this adapter.

The native opt-out command and startup sync leave Hermes's essential manual as
the baseline. Optional bundled skills, external/project discovery, inline skill
shell expansion, background curator and persistent memory are disabled. Source
and capture run through the native one-query CLI, with capture resuming the source
session. The model's `skill_manage` call must produce one pending write through
`skills.write_approval` without activating it.

Inspect the displayed pending payload, file bytes and loaded instruction text,
then enter the exact artifact and action hashes. The coordinator hands the
terminal to Hermes. Use its displayed `/skills pending`, `/skills diff <id>`,
`/skills approve <id>` and `/exit` commands; do not send a model prompt in that
operator session. Pending writes, native messages, the mutation ledger and
installed file hashes are retained. Held-out input stays unavailable until the
exact reviewed installation is observed. Reuse starts a new session and must
actually read the full reviewed instructions with `skill_view`.

Native approval uses only a pending ID, with no expected-hash argument. The
adapter's content-addressed references do not create native skill versions or a
CAS approval guarantee. On Windows the native Python writer uses CRLF bytes and
the reader normalizes newlines; file and model-loaded text hashes are separate.
The native ledger actor is retained as recorded, including `agent` for this
CLI-approved write. Hermes's host-user file access and mandatory manual remain
declared differences, so passing this journey does not establish equivalent
campaign permissions. Native review stdout is visible but uncaptured/unbounded;
one-query output, stderr and SQLite/skill evidence are bounded.

To run the pinned native runtime with synthetic provider responses and typed review:

```text
node scripts/verification/agent-comparison-hermes-workflow-conformance.mjs ABSOLUTE_HERMES_CHECKOUT ABSOLUTE_PYTHON NEW_ABSOLUTE_DIRECTORY
```

The fixture never answers its own review or sends an upstream model request.
See the [native evidence](COMPARISON_IMPLEMENTATION_STATUS.md#hermes-native-skill-workflow)
for the separate diagnostic runs, fresh six-check result and remaining work.

## Supervised skill and delivery journeys

Keep `agent-comparison-serve.mjs` running while using the product's own UI or CLI
for the workflow phases. The workflow controller supplies ordered prompts and
retains evidence; it does not execute native approvals or channel sends. Each
receipt must copy the six execution-binding fields from `session-start.json`,
declare `source` as `native_receipts` or `controlled_fixture`, and reference an
operator/adapter-retained `native-*.json` file with its exact SHA-256. A filename
or model-authored summary is not proof of native owner behavior.

```text
node scripts/verification/agent-comparison-workflow.mjs CELL source SOURCE_RECEIPT
node scripts/verification/agent-comparison-workflow.mjs CELL review REVIEW_RECEIPT REVIEWED_SKILL
node scripts/verification/agent-comparison-workflow.mjs CELL reuse REUSE_RECEIPT
node scripts/verification/agent-comparison-workflow.mjs CELL schedule SCHEDULE_RECEIPT
node scripts/verification/agent-comparison-workflow.mjs CELL reconnect RECONNECT_RECEIPT
```

Skill receipts contain a `phase` using the workflow fields described above. The
source phase also records `sourceArtifactSha256`. The review receipt includes
the complete native `activationEvents` inventory and exact instruction/version
hashes. Only after that native approval is retained does the controller release
`input/changes.json` and the new-session reuse prompt. Exact command replay can
finish an interrupted fixture release; changed evidence or output is preserved
and rejected. The controller does not install or activate a skill itself.

Schedule/reconnect receipts contain the native `delivery` evidence described
above. Reconnect must preserve the schedule identity and authorized destination.
Duplicate deliveries and extra capability activations remain in the evidence so
the independent verifier can fail the task. The final command writes an ungraded
`execution.json`; run the existing independent verifier and campaign recorder.
No comparison result is certified until the real product steps and receipt
collection have been performed under the declared campaign caps.

### GoatCitadel native delivery observer

For a dedicated GoatCitadel scheduled-delivery cell, the read-only observer can
collect the schedule and reconnect receipts from the Gateway's native APIs:

```text
node scripts/verification/agent-comparison-goat-delivery.mjs CELL OBSERVER_SETTINGS_JSON
```

Run this from a real terminal. Supply the Gateway token through
`GOATCITADEL_COMPARISON_GATEWAY_TOKEN`. The settings JSON contains only `baseUrl`,
`scheduleId`, and `authorization`; authorization contains the exact `channelKey`
(`telegram`), `connectionId`, numeric chat `target` as a string, and ISO
`scheduledFor` time. Keep credentials out of this file. The cell must already
retain its session binding, evidence-source declaration, reviewed native schedule
policy and hashed permission-source receipts.

Create and approve one bounded reminder through the product's existing owners
before attaching the observer. Its next run must be at the independently reviewed
time, still in the future, with an end time no more than a minute later. Use a
dedicated test runtime with no earlier channel deliveries. The observer performs
GET requests only; it neither creates a schedule nor approves or sends a message.

Collection follows the persisted cron occurrence through its exact completed Chat
child, connector-delivery child, immutable queue-admission checkpoint and the
eventual acknowledged channel record. Manual runs, legacy-only telemetry, changed scope, truncated inventories,
missing provider acknowledgement and duplicate deliveries fail verification.
After the first acknowledgement, reconnect through the product's native controls
and type `RECONNECTED`. The observer then checks for duplicates for at least 30
seconds. This input is retained as operator confirmation; it is not independent
proof that a process restarted. Cancellation and deadlines bound the wait.

The observer assembles bounded native receipts and writes an ungraded
`execution.json`. Run the independent verifier and recorder afterward. The native
launch profiles still do not launch scheduled-delivery campaigns automatically.

The separate `agent-comparison-goat-delivery-conformance.mjs` command exercises a
fresh built Gateway with synthetic model and Telegram transports and a task-owned
runtime restart. It accepts an absolute checkout and a new absolute output
directory. It uses no real provider credentials or external message destination.
The latest controlled working-build run passed all four scheduled-delivery checks
with one simulated Telegram acknowledgement. The queue's per-part journal binds
the approval and provider receipt, and delivery evidence remains stable for 30
seconds after closing and reopening Gateway over the same persisted state. The
supervisor process stays alive during this particular restart. These controlled
results do not establish live delivery or a clean-pinned cross-product comparison.
See the [handoff and reconnect evidence](COMPARISON_IMPLEMENTATION_STATUS.md#queued-approval-handoff-and-reconnect-proof).

### Controlled OpenClaw native scheduled delivery

The pinned OpenClaw delivery command owns a fresh Gateway process, isolated home,
loopback model proxy and loopback Telegram simulator:

```text
node scripts/verification/agent-comparison-openclaw-delivery-conformance.mjs ABSOLUTE_OPENCLAW_CHECKOUT ABSOLUTE_NODE NEW_ABSOLUTE_DIRECTORY
```

Use the clean revision in `NATIVE_COMPARISON_PINS` and its built public Gateway
SDK. The command accepts no real provider or Telegram credential. It records the
effective native configuration, waits for Gateway readiness and retains native
startup jobs as a disabled baseline. A synthetic model calls the native
`automations` tool to create exactly one reviewed, isolated, one-shot reminder
with an explicit Telegram account and destination. Filesystem, terminal and skill
tools are unavailable to this turn. Model dispatches use the existing combined
request/cost ledger with synthetic pricing.

The read-only observer collects `cron.get` and `cron.runs` responses plus bounded
SQLite snapshots. Before the simulator acknowledges a send, it captures the
active cron task, scheduler run receipt and pending outbound queue in one read
transaction. This links the scheduled occurrence and native queue to the wire
receipt even though public run history omits the run ID. Native scheduler and
delivery timestamps have different owners; the observer checks their persisted
relationships instead of requiring the timestamps to match. A manual run,
another destination, retry, competing message-tool send, missing acknowledgement
or extra delivery fails verification.

After one acknowledged delivery, the coordinator stops only its owned Gateway
process tree and starts a new one over the same state. The observer requires
distinct process identities, unchanged effective configuration and stable native
schedule/run/queue/receipt evidence for at least 30 seconds after reconnect. It
retains bounded phase bundles and writes ungraded execution evidence before the
independent scheduled-delivery verifier runs. Process termination and cleanup
outcomes remain in the native evidence directory.

This adapter accepts `controlled_fixture` evidence only. Its native policy
authorizes a fixed destination when the schedule is created; it does not claim
GoatCitadel's per-send approval behavior. A live provider receipt adapter,
equivalent campaign policies and repeated external delivery acceptance remain
separate work. See the [native delivery evidence](COMPARISON_IMPLEMENTATION_STATUS.md#openclaw-native-scheduled-delivery).

### Controlled Hermes native scheduled delivery

```text
node scripts/verification/agent-comparison-hermes-delivery-conformance.mjs ABSOLUTE_HERMES_CHECKOUT ABSOLUTE_PYTHON NEW_ABSOLUTE_DIRECTORY
```

Use the clean Hermes revision in `NATIVE_COMPARISON_PINS` and its Python
environment with the Telegram dependencies pinned by that checkout's `uv.lock`.
The command creates a dedicated home, model proxy and Telegram API simulator,
then starts the native foreground Gateway. On Windows, Python's virtual
environment launcher can have a different PID from the running interpreter;
readiness verifies the native process's ancestry, home and code revision.

The native CLI searches and loads the scheduling tool's schema, then creates a
one-shot reminder for the exact reviewed destination. Session-title requests
also pass through the combined model budget. The scheduled agent has no tools,
uses the declared model and returns the reminder through the real Telegram
adapter pointed at the loopback simulator. Optional bundled skills, memory,
curator work, session mirroring and restart notifications are disabled in this
controlled profile.

The evidence reader opens existing stores read-only. When Telegram receives the
send, it records the active execution and fire claim before acknowledging it.
The completed execution must preserve that identity, scheduled instant and
process birth time. This profile uses native in-process delivery; a detached
worker queue is a different path and cannot substitute for the observed send.
The stopped-runtime transcript also verifies one completed, tool-free cron
session and its final response.

The coordinator then restarts its owned Gateway tree over the same configuration
and state, retaining every delivery snapshot during a 30-second observation
window. It assembles the shared workflow receipts and runs the independent four
scheduled-delivery checks. Cancellation, deadlines, unexpected wire requests,
duplicate sends and changed configuration fail the command, with native logs
and process cleanup retained.

This command accepts no real provider or Telegram credentials. Its
`controlled_fixture` evidence does not establish live delivery, equivalent
per-send approvals, or comparable performance. See the
[Hermes delivery evidence](COMPARISON_IMPLEMENTATION_STATUS.md#hermes-native-scheduled-delivery).
