# GoatCitadel Master Completion Program

Last updated: 2026-09-13

Status: canonical aggregate execution ledger

## Purpose and authority

This document is the single execution plan for unfinished GoatCitadel work and
intentional deferred backlog. It replaces cross-document ordering from older
parity plans, review snapshots, and feature-specific backlogs. Those documents
remain useful as owner contracts and historical evidence, but they do not create
work independently of this program.

When sources disagree, use this order:

1. current implementation under `apps/`, `packages/`, and `scripts/`;
2. `CANONICAL_RUNTIME_STATE_MODEL.md` and `1_0_CONTRACT.md`;
3. the current owner contract linked from the relevant tranche below;
4. this aggregate program;
5. dated reviews, packets, checklists, and older plans.

Before starting a tranche, reconcile its rows against the then-current `main`.
An unchecked historical box is not proof that work remains, and a shipped
foundation is not proof that an integrated journey is complete.

## Status vocabulary

| Status | Meaning |
|---|---|
| `complete` | The tranche's implementation and named acceptance proof are complete. |
| `in_progress` | Work has started, but at least one required acceptance row is still open. |
| `planned` | Current, evidence-backed work that has not started in this program. |
| `blocked_external` | Completion requires a real device, credential, second machine, or administrator-owned control that local code cannot supply. |
| `deferred_decision` | Intentional backlog that must not enter the critical path without an explicit product or architecture decision. |
| `superseded` | An older proposal or status row has been replaced by current implementation or product direction. |

## Verification strategy

The tranche order is designed to avoid rerunning broad proof after every small
change:

1. Run focused owner tests, the touched package typecheck, and
   `git diff --check` inside each implementation slice.
2. Run a named subsystem lane once when its tranche closes, not after every
   commit in that tranche.
3. Run browser, accessibility, and visual proof once after the consolidated UI
   tranche, unless an earlier change requires an immediate safety check.
4. Run installer, desktop, remote-hardened, and release-certificate proof only
   against the exact release candidate.
5. Run `pnpm verify:all` once in the final exact-SHA campaign after all earlier
   tranche gates are green.
6. Do not replace real PostgreSQL, browser, packaged-process, physical-device,
   or two-machine acceptance with mocked or source-only proof where the owner
   contract requires the real boundary.

## Program ledger

### Active comparison-improvement sequence (2026-09-08)

The approved OpenClaw / Hermes comparison follow-up prioritizes daily Chat
usability before channel journeys and native remote execution. This sequence
specializes the existing tranches; it does not revive separate Cowork or Code
surfaces or turn historical protocol receipts into live outcome proof.

| Slice | Existing tranche | Scope | Status | Acceptance |
|---|---|---|---|---|
| C0 | M0/M1 | Reconcile current owners; extract provider readiness, tool-result projection, and memory retrieval quality | `complete` | Focused owner tests, typechecks, docs and whitespace checks |
| C1 | M5/M7 | First useful Chat response, progressive model setup, fresh onboarding state | `in_progress` | Canonical completed-turn evidence, stale-state regression, browser first-run proof |
| C2 | M6/M7 | Explicit workflow capture, inactive skill candidate, exact artifact review and separate activation | `in_progress` | Persisted capture/revision/replay tests, canonical activation, subsequent skill reuse |
| C3 | M6/M7 | Versioned capability pack bindings and owner-backed execution, Browser QA first | `in_progress` | Migration preservation, approval/recovery tests, MCP discovery and browser task proof |
| C4 | M5/M7 | Telegram, Discord, and Slack end-to-end journeys; Signal outbound only | `in_progress` | Authenticated ingress, progress, approval resume, artifact and scheduled delivery, reconnect/deduplication |
| C5 | M2/M3/M4/M7 | Native Windows-to-Windows workers with bounded execution and retained container support | `in_progress` | Governed live inference and settlement; native boundary tests; two-machine acceptance |
| C6 | M1/M10 | Comparable task-outcome benchmark for GoatCitadel, OpenClaw, and Hermes | `in_progress` | Pinned revisions, equivalent models/tools/budgets, repeated outcomes and separate unsupported cases |

M7's daily usability rows C1-C4 can close before M4. Its remote-worker
projection rows still depend on M4. C5 does not make Docker or WSL a prerequisite
for the initial Windows-to-Windows target. Physical-device, external-channel,
live-provider, and installer acceptance remain distinct from local test proof.
Live evaluation must declare request and cost caps before dispatch and count
retries and child calls against the same limits.

Local implementation now covers the C0 extractions, C1 onboarding projection,
C2 capture/review/activation/reuse path, C3 governed pack composition, and C4
progress and channel evidence. The C2 candidate remains inactive until the
existing approval owner promotes it; approved instructions are loaded only for
their workspace and are checked again before use. Pack setup preserves child
reviews and reports partial connection failure for operator reconciliation.
Browser QA uses verified package bytes, and rollback compensates only its owned
MCP changes while routing skill/settings reversals through separate owner reviews.

The C2 rejected-approval parent inconsistency found during UI acceptance now has
canonical refusal settlement, exact approval lookup, duplicate-safe delivery and
startup recovery using database-clock approval expiry. Thirty-six focused Gateway
tests, six SQLite tests and an actual PostgreSQL binding/CAS test pass. Refusal preserves inactive candidates,
uses existing temporary-input cleanup and never replays activation or rollback.
Live/provider/channel acceptance remains separate from this local repair.

The Memory enumeration gap from UI acceptance (GATE-01) now has local database,
authenticated API and browser proof. The shared client and canonical page can
load past 500 items with complete totals, signed scope-bound cursors and a reload
path for intervening writes. SQLite and actual PostgreSQL enumerate 1,211 matching
records without omissions; browser acceptance covers all 503 fixture records and
reload to 504 after mutation. See [Memory enumeration](MEMORY_ITEM_ENUMERATION.md).
This closes that local follow-up, not the remaining C1-C6 acceptance work.

The Memory portion of GATE-02 now compares canonical revisions atomically for
policy saves and recommendation decisions. SQLite and actual PostgreSQL reject
concurrent overwrites and roll back partial settlement. The real Gateway/browser
journey preserves the draft and winning policy until the operator reviews and
saves with the current revision. All three named Memory truth scenarios pass.
Other GATE-02 mutation owners remain open. See
[Memory maintenance revisions](MEMORY_MAINTENANCE_REVISIONS.md).

The Workbench content-save portion of GATE-02 now requires the reviewed file
revision and serializes cooperating Gateway processes through a project write
lock. The real browser/Gateway conflict and explicitly reviewed save journey
passes alongside independent-process tests. Saved acknowledgements retain their
own file snapshot and failed follow-up work cannot revive a completed write.
Workbench file actions now also require an explicit source/destination review.
The owner compares the exact action, recursive source contents and destination
parent under that lock; a stale action retains the form and requires a new review.
Focused owner/client/UI tests and the real browser conflict/rename journey pass.
Other GATE-02 mutation owners remain open; these checks do not establish
crash-atomic filesystem or hostile-process isolation. See
[Workbench file revisions](WORKBENCH_FILE_REVISIONS.md).

Permission profile record saves and archives now require the reviewed revision.
SQLite and actual PostgreSQL enforce it atomically, including independent-writer
races and transaction rollback. The Settings editor retains conflicting drafts;
archive confirmations preserve their captured version and require a new review
after a conflict. Ordinary edits also stop reasserting unchanged default contexts.
Activations and default-selection changes now also require an actor/context-bound
review. A persisted generation and shared transaction guard serialize competing
profiles, including inserts into empty contexts. Default create/save is atomic;
conflicts preserve drafts and winning selections until explicit fresh review.
SQLite, actual PostgreSQL and real Gateway/browser checks cover these races and
additive migration preservation. This completes the local permission-profile
revision slice; the remaining C1-C6 acceptance work stays open. See
[Permission profile revisions](PERMISSION_PROFILE_REVISIONS.md).

The personality portion of GATE-02 now requires one catalog revision for
creation, edits/renames, reset/removal and the global Work default. SQLite and
actual PostgreSQL serialize independent writers, including initial creation.
Settings preserves conflicting drafts, requires explicit rebase and captures
confirmation revisions; typing during creation/rename follows the saved ID.
The named real Gateway/browser lane rejects five stale mutations and accepts
each after fresh review, with desktop and 390 px captures. This completes the
local personality revision slice. Citadel, integration and MCP mutation owners,
C5/C6 source work and full C1-C6 acceptance remain open. See
[Personality catalog revisions](PERSONALITY_CATALOG_REVISIONS.md).

Citadel profile edits, archive and restore now enforce reviewed record revisions
across storage, Gateway and both operator surfaces. SQLite and actual PostgreSQL
prove five competing-writer pairs; the named Gateway/browser lane rejects five
stale writes and accepts five explicitly reviewed retries. Settings retains edit
drafts and Library retains an unsaved Charter during lifecycle conflicts, with
desktop and 390 px proof. This completes the local profile-record slice only:
Charter, template, blueprint and mutable access-rule owners, integration/MCP
preconditions, C5/C6 source work and full C1-C6 acceptance remain open. See
[Citadel profile revisions](CITADEL_RECORD_REVISIONS.md).

Blueprint import and Mason staging now validate the full portable structure before
the first persistence call, including every Chamber and the Charter's policy and
collection fields. Malformed input preserves the current Charter and Chambers;
valid Mason drafts still stage successfully. This closes the malformed-input
preflight gap only. Atomic setup writes and required reviewed revisions for
Charter/template/blueprint changes remain open.

[Implementation evidence and remaining work](testing/COMPARISON_IMPLEMENTATION_STATUS.md)
records the controlled skill-reuse journey, real local Browser QA execution,
stdio session ownership, and the exact limits of the Windows/PostgreSQL receipts.

C5 has versioned native cell identities, paired storage migrations, stricter
Windows process launch limits, and a worker client that verifies inference
receipts and output chains. It now publishes a verified text artifact and retains
terminal settlement before sending, including exact recovery after a restart.
Canonical capability/permission checks, LlmService dispatch, expiring operator
spending grants, and CAS verification execute together in the controlled native
mTLS test. Retries share the same request/dollar grant; uncertain charges remain
held, and release requires a retained no-dispatch receipt from the canonical owner.
Production now composes inference, artifact and canonical tool-effect owners behind
the existing explicit activation setting. Authenticated inference has its own
90-second execution bound; the worker process completed a 32.5-second controlled
call while admission timeouts remained short. An internal Gateway offer-creation
service now derives assignment identity from the admitted Chat run and checks its
current capability and permission bindings. Storage rechecks the execution claim
and mutation admission atomically before publishing one stable offer. Its creator
is the admitted actor, allowing a replacement Gateway with a current durable
claim to replay the original offer while rejecting the old process. Admission now
freezes prepared Chat history, guidance, active skill instructions and routed
context into an immutable snapshot. Recovery and worker inference verify its
identity and exact bytes. Worker inference now enters the canonical completion
pipeline for QMD memory and inline hooks. Related utility calls retain their own
usage identities and consume additional reservations from the same operator grant.
SQLite 209 / PostgreSQL 154 retain those per-dispatch holds and settlements.
Durable Chat now discovers existing assignments and materializes their verified
text through the canonical message/trace writer. Its finalizer records the worker
result receipt atomically with terminal state and the sealed checkpoint.
SQLite 210 / PostgreSQL 155 now retain one immutable local/worker choice before
durable Chat starts either runner. Controlled task-bound fixtures select a
native worker registry through the admitted operator's execution-workspace grant;
offer creation and placement commit together. Recovery preserves that choice and
remote failure never starts a second local runner. Profiles whose selected tools
all have supported runtime owners now enter the bounded model/tool loop; placement
requires an admitted worker with the additional `governed_tool` capability.
Native MCP placement now enters the Gateway's current requester authority or
static configuration/environment authority. Worker effects receive a private
context from the verified profile; approved replay preserves the native tool,
exact arguments and policy mapping. Controlled Windows worker journeys prove one
effect and replay without another dispatch, including approval continuation and
requester revocation before dispatch. Separate built-Gateway restarts prove native
MCP continuation before dispatch and across an approval wait. Requester fixtures
use constructor-owned synthetic resolvers; static fixtures use stock startup and
the real connect API. Both use loopback model/MCP transports and synthetic worker
credential custody.

Mesh catalog/profile validation now binds the actual publication identity and
requires current activation authority before model dispatch. A private mesh
policy mapping now preserves exact targets, shared limits, deny-wins and approval
replay; SQLite 219 / PostgreSQL 164 retain its accounting identity. Chat now
admits Gateway-owned mesh schemas from exact manifest bytes and current
activation bindings, and its policy probes recover those bindings from the
persisted profile and catalog. Chat mesh calls now pass through the canonical
invocation coordinator, hooks, policy and approved-effect owner. Dispatch rechecks
the frozen target after execution fences, while retained intents must match the
exact Chat, approval, profile and publication identity before replay. Controlled
SQLite tests join real policy approval, dispatch and node settlement without
repeating an effect. Worker placement now accepts selected mesh tools when the
current activation and Gateway effect owners are composed. Worker effects mint
private contexts from the verified profile and use canonical policy, dispatch
and approved continuation. Controlled SQLite tests verify exact targets and
replay without another dispatch. Admitted nodes can now discover only their
confirmed dispatch envelopes through a bounded API. Argument reads recheck
current activation and admission before disclosure; lost process-local input
is unavailable after restart. Native settlement now rechecks current M2/M3
authority transactionally for first submission and replay, with controlled
SQLite/PostgreSQL revocation proof. A protected native mesh exchange now composes
the canonical publication and invocation owners through fixed PoP-v2 route 13.
It derives node identity from current M2/M3 authority, requires governed-tool
scope, consumes a durable nonce, and rechecks admission after reads. Controlled
signed-action and Windows loopback mTLS tests pass. The destination runtime now
checks exact local manifest/entry/permission hashes, records execution before
entering a constructor-supplied local owner, and retains the exact settlement
before sending. Two real Windows process-death cases over native mTLS prove one
local effect, unknown interrupted execution, and successful settlement replay
without repeating the effect. The process API composes this owner explicitly;
the shipped foreground host now has the filesystem read/write and HTTP MCP
adapters described below; additional adapters and service composition are unfinished.
Retained mesh recovery now precedes fresh assignment work. An assignment and a
serialized mesh cycle can then run together, avoiding self-targeted dependency
deadlock and starvation. Uncertain receipts keep the host stopped across restart;
neither cancellation nor restart grants permission to retry the effect.
A controlled ordinary Chat journey now publishes and activates the mesh
capability, waits for tool approval across a built-Gateway restart, completes
through a native Windows destination process and replays without another effect
or Chat reply. It uses a test-owned local effect adapter and synthetic custody.
Destination deadlines now include input and progress waits and recheck elapsed
wall/monotonic time before owner entry and success. Expired preflight cannot run
the effect; late execution results remain unknown. Worker lease/control refresh
also tolerates a parent-heartbeat race through at most two fresh, independently
authorized renewals without repeating completed work. The named worker lane now
includes the complete worker package with a no-skips requirement.
Published tool schemas now govern Gateway input admission, destination execution
and successful output settlement. Validation preserves exact approved values and
runs with bounded resources and cancellation; invalid output after execution
requires reconciliation. Missing manifest authority no longer widens response
limits. The fresh portable Windows package includes the pinned validator graph
and passes actual packaged positive/negative schema execution. MCP selector
validation is supplemented by the destination-native registry/schema owner below.
The stock worker now loads a separately pinned local registry and executes its
filesystem reader and Windows NTFS writer within their declared roots. The writer
uses a fixed digest-pinned native helper, retained directory identity and an exact
previous-content check before replacement. Native schemas, permission envelopes,
file identity and byte limits are enforced locally. A destination HTTP MCP owner
now connects to a separately operated server using an exact pinned endpoint and
native input/output schemas. It validates fresh discovery, rechecks Gateway
authority immediately before sending a tool call and retains uncertainty for
lost or invalid post-dispatch responses. It supports anonymous and bearer-authenticated
Streamable HTTP with JSON/SSE responses. The separately configured credential file
is pinned by exact bytes, isolated from destination filesystem roots and rechecked
before every send. A configuration digest prevents reuse of old activation authority
after endpoint/schema/credential changes. Operator-owned file permissions, OAuth,
stdio hosting and protected MCP process/custody composition remain distinct limits.
Disabling tools preserves retained
settlement/reconciliation while stopping fresh polling. Installed registry setup
now has a packaged administrator command, immutable generations and an atomic
selection guarded by stopped-service, expected-selection and writer-lock checks.
The native host derives registry settings from protected files and pins them for
the child lifetime. Temporary-file/native checks cover this composition; actual
installed lifecycle and custody still require host acceptance.
Additional destination tools and MCP transports, broader placement,
delegation/council execution, native protected volume/executor/custody composition
and the installed service remain source gaps, separate from second-machine proof.

The full built-Gateway probe now boots the native listener through the real
async storage facade. It exposed and fixed a callable-proxy availability check
and worker-budget rejection of canonical local/token-fingerprint actor IDs.
SQLite 214 / PostgreSQL 159 now align worker authority with canonical attempt
zero while preserving positive-attempt evidence and retry behavior. SQLite join
authority also accepts the exact 600-second endpoint using integer milliseconds.
The built Gateway now admits ordinary task-bound Chat to a native worker, restarts,
renews that worker's lease under a replacement parent, and completes the original
turn without repeating inference or output. The passing loopback run records one
worker request and three separate normal Chat post-commit requests. Its synthetic
native custody does not certify an installed service, live model or second host.

The provider terminal outbox now retains bounded, exact model tool requests.
Protected worker submissions select a retained call by identity; the Gateway
derives its name and arguments, rechecks current authority, and invokes the
existing governed tool/effect owner. The worker verifies the projected result
and replays a recorded batch after restart without repeating the effect. A bounded
model/tool loop now reconstructs each follow-up from the frozen original context,
retained provider calls and settled tool results. Gateway artifact verification
and Chat materialization check the entire sequence and aggregate its canonical
usage events. SQLite 215 / PostgreSQL 160 add tool-owned model attempts to the
same operator grant pool. Each LlmService attempt inherits exact execution
lineage, rechecks the protected worker/effect authority, and reserves a bounded
request and cost before transport. Approval continuations use the same owner;
uncertain usage stays held, and canonical Chat totals include tool model calls.
Deferred streams retain their guard and cannot dispatch after the tool returns.
The full built Gateway now preserves an approval wait across restart, accepts
its decision through the ordinary approval API, resumes the same worker/Chat
generation and finishes without repeating the tool or reply. Approval-sensitive
builtins retain their canonical execution boundary before invocation; successful
output cannot fabricate that receipt afterward. The full delegated workflow
remains unfinished. Automatic placement now includes supported tool
profiles; it retains the same task, frozen-context, grant and native-worker checks.
Local native-process proof covers ordinary placement through approved tool
execution, withdrawal and replay. It does not certify the installed native service.

Ordinary Chat now receives a Gateway-owned execution task only when worker
placement commits. SQLite 216 / PostgreSQL 161 bind it immutably to the admitted
payload and scope; the original request is unchanged. Offer failure rolls back
task creation and parent metadata. Generated task status follows durable Chat
atomically, while caller-selected tasks retain their existing lifecycle owner.
The verified worker assignment supplies the task identity for canonical usage
ingestion. Oversized generic Chat context remains local without truncation.

Worker approval waits now retain nonterminal effect history and their original
approval correlation across restart. Exact Chat linkage gates the inline waiting
projection, and the normal Chat finalizer records its approval-keyed durable wait
and checkpoint. Under current execution authority, canonical rejection settles
the retained effect without another tool invocation. A restarted native worker can read the exact sealed wait
through protected assignment sync and remain parked in the foreground loop.
That read cannot renew a lease or authorize work. Parked rejection and edited
decisions now retain an immutable continuation with the declined pending request.
Their linked wake defers until the first Chat wait and its finalizers settle.
After native lease rotation, a matching terminal refusal receipt supplies a
bounded model-facing result; it does not execute the tool. The real local worker
process resumed a parked rejection and replayed that refusal without another
tool invocation. SQLite 212 / PostgreSQL 157 now retain additional immutable
parent-owner bindings, chained to the previous binding and the exact current
worker lease. The Gateway recovery owner requeues the same attempt, and native
sync keeps the worker parked until a fresh binding permits protected renewal.
Local proof covers repeated approve/reject/edit owner recovery and a native
worker resuming a rejected tool after another parent replacement. SQLite 213 /
PostgreSQL 158 now retain parent recovery before an approval handoff, without
inventing an approval or changing the assignment generation. The Gateway binds a
fresh claim before protected worker renewal; an expired worker lease alone cannot
gain that handoff. Repeated recovery passes shared SQLite/PostgreSQL and Gateway
owner tests. Native Windows processes now resume pre-approval recovery through
retained inference, artifact publication and completed Chat. A separate approved
read survives an additional parent replacement before executing, and its result
replays without another file read. Both journeys use the real local mTLS listener
with controlled provider/permission/notification callbacks. Full Gateway-process
restart now passes for both text inference and approved file-read continuation
with controlled providers and synthetic custody. Physical two-machine acceptance
remains unproved.
The resumed Chat dispatcher now suppresses only the resolved approval whose wake
it has bound, so it remains running during worker renewal and settlement instead
of parking on the same approval again. Other approvals still create their own wait.
The ordinary approved-action executor now refuses worker-owned tools through
canonical tool, placement and historical assignment checks; approval does not
move their execution to the local runner or supply missing worker authority.
The approval processor retains the exact pending action and retries the ownership
wait with backoff until the canonical waiting generation settles. It then records
a skipped-local-action handoff, allowing the linked durable wake to continue.
SQLite 211 / PostgreSQL 156 now retain separate immutable approval-wake and
parent-dispatch binding records. The storage owner can fence renewal of the exact
prior worker lease against a replacement Chat lease without creating another
assignment generation. Gateway wake now records its immutable handoff in the same
transaction as the queue CAS. Resumed Chat binds the new parent lease, and native
sync directs the worker to wait or renew its retained lease. The worker persists
its proposed secret before renewal and recovers a lost response after restart.
Approved tools use the canonical side-effect owner, recheck execution authority
and the admitted runtime owner, and project only matching retained terminal
evidence. Local owner tests cover interrupted projection and unknown external
outcomes without redispatch. Early approval still establishes the first canonical
Chat wait. This source integration does not close full approval/rejection recovery
or physical two-machine acceptance.

Inference now renews the retained lease and checks cancellation while waiting.
Unknown renewal/control outcomes abort the owned connection; pending rotation
drains before later transcript writes use its current secret. Recovery uses the
canonical transcript watermark. A continuous foreground loop now polls sequentially,
owns its retained state across processes, propagates shutdown, and stops on uncertain
outcomes. This is not a protected native executor or an installed Windows service.
Transcript and settlement owners now publish only persisted state, serialize
writes, and resume a partially saved transcript without changing its prefix.
Inference receipts also retain the complete canonical provider-attempt list,
including output-cap recovery retries.

Artifact publication now tolerates an ordinary lease renewal after its initial
exact admission fence, while retaining the same upload, parent owner, generation,
payload and live authority checks. SQLite/PostgreSQL owner proof and a delayed
native CAS commit passed. Final settlement now commits its proposed lease
rotation atomically; the worker retains the exact proposal across response loss
and restart. Cancellation closes without renewing authority, including routine
parent heartbeats under SQLite 218 / PostgreSQL 163. All six built-Gateway restart
cases now pass, including delayed artifact and final-settlement cases. The named
runtime-truth lane now enters through a real governed Chat file read and passes
both same-run approval/restart recovery and the canonical Next shell check.
That proof also exposed and fixed implicit document creation from a request to
read a file and report its contents. Inspection alone no longer creates an
artifact obligation; explicit output requests still do. See the current
[implementation evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#real-approval-restart-acceptance)
for the separate receipts and remaining source gaps; C5 and final certification
remain open.

The Windows provisioner now supports a fixed
[TLS 1.3 client CertificateVerify signing operation](security/remote-worker-tls-client-signing.md).
It signs only the client-purpose transcript preimage under the current protected
runtime key, with authenticated caller, state, generation, receipt and public-key
bindings. Its public receipt is verified against the exact submitted bytes;
cross-purpose and stale-authority inputs fail closed. Native x64 execution and
reproducible x64/ARM64 builds cover this operation. This is a custody prerequisite:
the connected worker still needs protected admission/runtime integration,
trusted adapter loading, native execution/volume support and its installed
service before the physical-machine journey can close.

Worker evidence and signing callbacks now run asynchronously under the exact
connection's cancellation/deadline ownership. Request authority is snapshotted,
late signatures cannot send after shutdown, and native-client cancellation waits
for its owned process to close or reports uncertain termination. Real mTLS tests
cover ordering, concurrent connections and cancellation. A disposable Windows
probe also completed both TLS transcript variants with an external signer and
public-only client input; this is adapter feasibility, not the installed custody
journey. [Current evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#protected-worker-signing-lifecycle)
keeps the earlier feasibility receipt separate from later native integration.

The native TLS key adapter now uses the image-pinned provisioner client command,
per-key authority and cleanup, a bounded owned process, fixed GCPW receipts and
independent signature verification. The worker transport accepts its public-only
TLS context and verifies TLS 1.3 before preparing HTTP. Real native-adapter
handshakes and a built worker's channel-bound HTTP request passed alongside
malformed/helper-timeout tests and reproducible x64/ARM64 DLL builds. The helper
was synthetic. [Native adapter evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#native-tls-adapter-and-worker-transport)
keeps installed custody, trusted DLL admission and ARM64 execution limits explicit.

The connected worker now also supports native admission and runtime signing with
a retained public key reference. A real built foreground worker admitted through
canonical Gateway owners, and a separate process reconnected without a retained
private key or another bootstrap exchange. Gateway bootstrap verification binds
PoP-v2 to its stored target generation. Normal startup now loads a fixed native
guard that pins the helper and adapter before TLS loading and retains those
leases with its runtime owners. The complete named TLS lane passed 166 worker
tests, 16 identifier tests and 23 native/integration checks, including actual
built-entrypoint admission/restart, image replacement refusal and GC cleanup.
This uses a staged bundle and synthetic native signer; installed package trust,
service custody, native volume/executor and broader worker routing/delegation
remain unfinished. The
[guarded startup evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#guarded-normal-windows-worker-startup)
also records the unchanged bearer-storage and live-acceptance limits.

The Windows worker now has a portable package builder/verifier and an environment-
restricted foreground launcher. A copied 1,047-file package ran its embedded Node
outside the checkout and passed protected admission/restart through the launcher;
12 package-file tests and unchanged-inventory verification passed. The package is
unsigned, its signing fixture synthetic, and installed package/service custody,
native volume/executor and physical acceptance remain required. The
[package evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#portable-windows-worker-package)
keeps those gates separate from the new relocation proof.

C6 supplies [pinned task preparation, recoverable shared-budget accounting,
independent artifact verifiers, and recorded outcome reports](testing/AGENT_COMPARISON.md).
A supervised loopback transport now enforces per-HTTP-attempt caps, including
opaque retries and children, against the campaign's pinned endpoint and prices.
It retains fsynced evidence and stops at the cell deadline. Source-pinned OpenClaw
and Hermes CLI profiles now prepare reviewable launches, use fresh homes and
filtered environments, and retain bounded process evidence under the shared
provider connection. A native GoatCitadel driver now starts a fresh authenticated
Gateway and uses its workspace/project/session, route-preflight, and durable Chat
APIs. These drivers support the three file/terminal tasks; their native
configuration and permissions still require operator review. Supervised workflow
controls retain source/capture/reuse and schedule/reconnect evidence, withhold
reuse inputs until exact native skill approval, and preserve duplicate-delivery
evidence for independent verification. The product's own UI/CLI still owns those
supervised steps. Actual pinned OpenClaw and Hermes runtimes now pass a native
file-tool roundtrip through the controlled proxy with the declared model, reasoning
and output bounds. Native permission probes now record workspace, sibling-file
and terminal behavior. They exposed an OpenClaw legacy-config mismatch; its
canonical ask mode now prevents unapproved terminal execution. Hermes retains
host-user file access and risk-pattern shell approvals. Reports require exact
native permission-review evidence and withhold comparability for missing,
unknown or different policies. OpenClaw now has an opt-in foreground approval
Gateway, retained native event client and interactive operator console. The
campaign driver preserves native one-time approval/denial, retains decision
intent and outcome, and stops its owned processes at cancellation or deadline.
Separate controlled campaign checks passed approval/resume, denial and cancellation.
The GoatCitadel adapter now supports a typed native console, separate Chat and
approval-wait scope checks, isolated Git project identity, post-turn child
closeout and retained cancellation. Separate actual working-build checks passed
approval, denial and cancellation. Hermes now has an opt-in native interactive
CLI profile with explicit file/terminal toolsets and a bounded read-only native
transcript export. Separate controlled checks passed approval, denial and turn
cancellation; 79 comparison tests passed. Hermes stdout is visible but is not
captured or byte-limited; stderr, transcript export, provider budgets and the
deadline remain bounded. Deadline shutdowns retain their actual cause.
An experimental GoatCitadel skill-workflow adapter now connects native capture,
artifact review, activation approval and new-session reuse. All 96 local
comparison tests passed, and a fresh actual working-build journey passed all six
independent outcome checks with zero upstream model requests. Canonical approved
tool completion and policy-blocked post-commit handoff now preserve the evidence
needed for capture and subsequent Chat turns. The adapter follows full Change
Plan scope, native approval resume and exact Journey/version provenance. Fresh
runtime-truth and durable-recovery lanes also passed. See the
[native workflow evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#goatcitadel-native-skill-workflow-in-progress).
The campaign driver now verifies complete snapshot coverage in bounded phase
bundles before assembling its receipts. Revalidation of the 405-snapshot native
run passed the same six checks without exceeding the verifier's 100-receipt cap;
it is retained separately from new execution proof.
OpenClaw now has a native skill workflow using its public agent and Workshop
owners, exact typed review, native revision-bound apply, and a new-session read
of the complete reviewed instructions. A fresh pinned-runtime controlled campaign
passed all six independent checks with 11 synthetic model calls and zero upstream
requests. Normal process cleanup now permits bounded final evidence assembly,
while operator cancellation still stops it. The native skill filter excludes
bundled instructions that an empty bundled allowlist had previously permitted;
Workshop autonomy is off and lifecycle review is explicit. See the
[OpenClaw workflow evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#openclaw-native-skill-workflow).
Hermes now completes the same controlled skill task using its native CLI,
staged write gate, typed review, native `/skills approve` action, retained
mutation ledger and a new-session `skill_view` read. A fresh pinned-runtime run
passed all six checks with 13 synthetic model calls and zero upstream requests;
all 115 local comparison tests passed. Native pending-ID approval lacks an
expected-hash argument, and Windows file bytes differ from the loaded text's
newlines; both boundaries are retained explicitly. See the
[Hermes workflow evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#hermes-native-skill-workflow).
A read-only GoatCitadel delivery observer now follows canonical cron, Chat,
connector and provider acknowledgement records and checks for duplicates for at
least 30 seconds after explicit reconnect. Its controlled tests pass, with 127
local comparison tests in total. Actual Gateway testing found and fixed cron
minute drift, first scheduler-session creation and normal-cadence settlement;
64 focused cron tests and 32 autonomous admission/profile tests passed separately.
Channel argument persistence, queue-aware cron settlement, explicit transport
acknowledgement and opaque durable-id API access now have focused fixes. The
latest controlled working-build run passed all four scheduled-delivery checks
with six synthetic model calls and one simulated Telegram acknowledgement. The
new per-part journal reconciles queue, approval and provider receipt; reopening
Gateway preserves the delivery and its diagnostics without resending. See the
[handoff and reconnect evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#queued-approval-handoff-and-reconnect-proof).
The pinned OpenClaw runtime now passes all four controlled scheduled-delivery
checks with three synthetic model calls and one simulated Telegram acknowledgement.
Send-time native task/run/queue snapshots establish the exact occurrence, and
delivery evidence remains unchanged for more than 30 seconds after the owned
Gateway restarts as a new process. All 147 comparison tests passed. See the
[OpenClaw delivery evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#openclaw-native-scheduled-delivery).
The pinned Hermes runtime also passes all four controlled scheduled-delivery
checks. Six synthetic model calls created and executed one reminder; the native
fire claim and execution ledger bind its simulated Telegram acknowledgement.
After a new Gateway process starts, 31 seconds of unchanged delivery evidence
show no duplicate. The evidence reader handles bounded SQLite write contention;
all 174 comparison tests passed. See the
[Hermes delivery evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#hermes-native-scheduled-delivery).
Clean-pinned GoatCitadel campaign proof, operator review of campaign
configurations, equivalent cross-product policies and live campaigns
remain pending.
The final controlled runs sent zero upstream model requests. See the
[OpenClaw approval evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#supervised-openclaw-approval-and-resume)
[GoatCitadel approval evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#supervised-goatcitadel-approval-and-resume)
and [Hermes approval evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md#supervised-hermes-approval-and-resume).
No live-provider comparison, external-channel delivery, two-machine
run, packaged installation, or release is certified by these rows. The operator
selected Telegram for initial channel acceptance and a Windows mini PC for the
second host; destination details and combined request/dollar caps are pending.
The pre-existing M0-M10 entries below retain their original scope and dates.

| ID | Priority | Tranche | Status | Depends on | Closing proof |
|---|---|---|---|---|---|
| `M0` | P0 | Canonical ledger and stale-status reconciliation | `complete` | None | `pnpm docs:check`; `git diff --check` |
| `M1` | P0/P1 | Proof integrity, storage correctness, and agentic hot-path foundations | `complete` | M0 | Focused storage/Gateway/harness tests, dual-dialect corrupt-shape proof, concurrent-verifier proof |
| `M2` | P0 | Remote-worker admission, transport, and operator control | `in_progress` | M1 | Focused mesh/auth suites and real two-machine TLS 1.3/mTLS/PoP admission |
| `M3` | P0 | Remote-worker durable execution and ordered event transport | `in_progress` | M2 | Worker death/reconnect/takeover, replay, transcript, approval-resume, and no-duplicate proof |
| `M4` | P0/P1 | Live worker inference, execution cell, settlement, and visibility | `in_progress` | M3 | `pnpm verify:remote-workers` with the connected-worker row executed, plus live Ops/Chat data |
| `M5` | P0 | Governed self-configuration and repair expansion | `in_progress` | M1; M2 for remote custody | `pnpm verify:self-configuration` with live provider, packaged restart, browser secure input, profile, rollback, and delegated-resume evidence |
| `M6` | P1/P2 | Gateway capability and policy follow-ons | `complete` | M1; M5 where repair is involved | Focused capability/policy/provider tests and explicit owner decisions |
| `M7` | P1/P2 | Consolidated Mission Control UX and live-worker projection | `in_progress` | M4; stable M5/M6 APIs | Focused component tests, populated stories, accessibility, surface, and one visual-regression pass |
| `M8` | P1 | Mobile companion completion and pinned-Gateway proof | `in_progress` | M3-M5 contract stability | External mobile build/tests and HX-508 device-auth, paging, approval, offline/reconnect, attachment, and revocation bundle |
| `M9` | P0 | Packaging, desktop, remote-hardened, rollback, and recovery | `planned` | M2-M8 release-bearing scope | `pnpm verify:install`, `pnpm verify:desktop`, packaged lifecycle, exact hashes/versions, hardened recovery bundle |
| `M10` | P0 | Final exact-SHA certification | `planned` | M1-M9 | All required named lanes, then `pnpm verify:all`, authenticated queues, and release evidence |

## M0 - Canonical ledger and stale-status reconciliation

### Scope

- Establish this file as the only cross-workstream execution order.
- Keep detailed owner contracts, but make them link here instead of publishing
  competing implementation sequences.
- Mark completed or superseded rows truthfully, including original parity
  epics, Google Meet, agent-fanout budget weighting, capability lifecycle APIs,
  and mobile voice capture.
- Correct remote-worker proof wording: the named composition lane, the live
  PostgreSQL row, and the single-host connected-worker end-to-end row all
  execute, while two-machine admission and the routes 11-12 inference /
  artifact-effect settlement stages remain held.
- Preserve dated review and QA artifacts as historical evidence rather than
  rewriting them into current status.

### Exit criteria

- Every active or deferred item below has one master tranche.
- Owner documents link back to this program.
- No completed historical row appears in an active execution order.
- Documentation validation and whitespace checks pass.

Closure evidence (2026-08-08): `pnpm docs:check` passed, including governance
validation and 9/9 Docker-secret documentation tests; `git diff --check` passed.

## M1 - Proof integrity, storage correctness, and agentic foundations

### Implementation progress

- Worktree-scoped cross-process output locks and staged publication now protect
  the shared verifier/build outputs (`FR-362`).
- SQLite and PostgreSQL migrators now reject corrupt pre-existing object shapes
  instead of accepting name existence as shape proof (`FR-356`). Fresh
  PostgreSQL 16 proof covers the corrupt-table and corrupt-index cases; the
  schema inspector uses PostgreSQL's canonical `pg_catalog.bool` type name.
- Concurrent audit events are durably microbatched under the existing ordered
  lock, ordinary prompt-budget receipts are gated off the live path, and scoped
  active-grant reads resolve concurrently before the unchanged deny-wins merge.
- Capability-profile policy probes now use bounded, order-preserving fan-out and
  a non-materializing inspection path. The durable profile freezes the probe
  evidence, while canonical invocation still re-evaluates, records the
  limit-counting decision, and enforces deny-wins policy before execution.
- Pre-dispatch terminal outcomes use one canonical tool-row write, and advisory
  runtime-decision projections drain through a bounded, shutdown-owned queue
  after canonical settlement instead of extending response latency.
- Checkpoint continuation now follows bounded high-intent Chat classifications,
  and the first eligible successful root Chat turn warms the operator review
  inbox without promoting learned memory or adding a foreground model call.
- The final governed-remediation storage checkpoint is paired at SQLite 192 and
  PostgreSQL 135 with migration-lineage and schema-parity coverage.
- PostgreSQL 140 now installs one normalized final schema authority instead of
  treating a raw migration-text manifest as catalog truth. Destructive
  governed-remediation, remote-mesh, and mobile-push bootstrap bridges acquire
  replacement locks before reclassification, reject unmodeled owned objects
  and physical/catalog drift, preserve nonempty authority, and converge fresh
  and historical lineages to the same exact head. Live PostgreSQL 16 proof
  covers corrupt-object preservation, the writer-versus-replacement race, and
  the v140 finite-lineage repair; paired migration parity remains SQLite 196 /
  PostgreSQL 140.
- The HX-407 sparse-repair conflict is closed by owner decision: `createDatabase`
  does not admit sparse databases, and the canonical schema-shape gate stays
  exactly as fail-closed for every application boot. The frozen lineage's
  skip-on-absent-parent behaviour is a migration-layer guarantee rather than a
  `createDatabase` admission, so the HX-407 proof now runs the migration runner
  directly, un-skipped, and additionally asserts that the gate refuses the same
  sparse database. A sparse ledger is only ever manufactured by tests: every
  production `createDatabase` caller opens a fresh or in-order-migrated
  database, only the migration runner writes `schema_migrations`, and the
  read-only doctor inspects the file without migrating it.

### Closure evidence

- `FR-362`: concurrent verifier/build lanes cover cross-process exclusion,
  stale-owner recovery, staged publication, and worktree isolation.
- `FR-356`: focused SQLite/PostgreSQL shape regressions pass; a disposable real
  PostgreSQL 16 server passed the exact corrupt-table and corrupt-index cases,
  and the full PostgreSQL migrator suite passed 51/51.
- Focused policy/Gateway regressions cover non-materializing inspection,
  bounded eight-way probe fan-out with stable evidence order, canonical
  invocation recording, one-write terminal preflight, and bounded advisory
  decision draining.
- Audit microbatching, prompt-receipt gating, scoped-grant fan-in, high-intent
  checkpoint continuation, and first-turn operator-review warming retain their
  focused regressions.
- The paired SQLite 192/PostgreSQL 135 migration parity and integrity checks,
  touched package typechecks, documentation validation, and whitespace checks
  pass at closeout.

### Superseded proposals

- Do not move short Chat turns outside durable execution. Optimize admission,
  heartbeat, and checkpoint cost while keeping durable execution authoritative.
- `agent.fanout` budget weighting is complete: fanout consumes bounded subtask
  count rather than one flat tool run.

### Owner evidence and proof

- `review/full-code-review-2026-07-09.md` (`FR-356`, `FR-362`)
- `citadel_update/AGENTIC_FAST_LANE_PLAN.md`
- Focused storage/Gateway/harness tests, corrupt-shape regressions in both
  dialects including live PostgreSQL 16, concurrent-lane regressions, touched
  package typechecks, `pnpm docs:check`, and `git diff --check`.

## M2 - Remote-worker admission, transport, and operator control

### Implementation progress

- The hardened Windows provisioner, authenticated local service transport,
  Ed25519 custody, protected filesystem/journal recovery, deterministic x64 and
  ARM64 packaging are restored on the current program branch. The protected
  service can now sign a fixed, secret-free 288-byte admission-evidence
  envelope without exporting its private key; x64 execution, ASan, and paired
  deterministic x64/ARM64 builds pass.
- Proof-of-possession verification can now prepare a verified request without
  burning its replay nonce; durable nonce consumption and generation-1
  credential admission commit atomically, including rollback at injected
  post-nonce and post-generation failures.
- The native TLS listener now has a bounded authenticated-handler seam with
  strict POST/JSON framing, one request per connection, body/handler deadlines,
  bounded sanitized responses, buffer wiping, and explicit
  `listening_dark`/`listening_live` runtime truth.
- Operator bootstrap/control routes and the admission exchange are composed
  over the canonical repositories. Real two-connection replay uses distinct
  TLS exporters/nonces and returns the same canonical generation without
  replaying the credential secret.
- The fixed protected envelope and operator-pinned signer are now verified by
  the Gateway, settled atomically with nonce/generation/credential authority,
  retained across restart in paired SQLite 193/PostgreSQL 136 storage, and
  cryptographically revalidated on current-authority reads. Quarantine or
  revoke kills credential and protected-evidence authority.
- Production ingress has a real protected-evidence verifier and can become
  `listening_live` only after its preflight succeeds. The current-authority
  resolver is consumed only by the production-dark M3 assignment-protocol
  owner; the runtime factory still omits that handler, and raw evidence rows
  are never callable authority.
- The protected Windows service now has a production-dark PoP-v2 signing
  operation over the exact contract-owned 285-byte preimage. Its local
  operation authority binds the authenticated caller SID, caller-pinned state,
  active generation, keyset receipt, and exact preimage before state or key
  access. Delete-on-close staging survives the injected crash boundary, and
  deterministic x64/ARM64 builds plus x64 execution/ASan proof pass. The
  untrusted helper performs one sign exchange and has query-only SCM rights; it
  cannot start or restart the service.
- A distinct production-dark Windows availability-broker service now
  owns the only new `StartServiceW` import. Its SCM entry accepts no operands;
  before each bounded start of the fixed signer it validates the exact demand-
  start service configuration, protected service-object ACL, stopped/pending
  state, fixed protected image path, file identity, single link, ADS closure,
  file ACL, and package-pinned SHA-256. A running result is accepted only after
  exact PID, image, LocalSystem token, service SID, privilege, status, and held-
  image revalidation. It cannot create, reconfigure, control, delete, or query
  an arbitrary service and persists no secret. The source supervisor now reports
  itself RUNNING before starting the signer, then supervises clean signer exits
  and repeats with a bounded pause. Failure or operator STOP ends supervision.
- The deterministic package proof now publishes an exact service/client/broker
  trio for x64 and ARM64, preserves partial publication as a HOLD, and passes
  the x64 ASan/native suite. The client/helper retains query-only SCM authority.
  Real installed broker/caller composition remains unproved; this is PE
  authority isolation, not containment against a
  malicious local administrator who already has direct signer start/stop rights.
- An exact-commit Codex Security review closed all 29 changed source files and
  nine trust surfaces with zero findings or deferred rows. Root integration
  proof passes focused Gateway, contracts, provisioner, atomic-storage, paired
  migration-parity, and touched-package typecheck lanes.
- A separate exact-commit trust-chain review closed the PoP-v2 signer with no
  blocker or residual integration issue. Its ten route descriptors remain
  production-dark, and activation still requires an administrator-owned
  installed-service lifecycle plus real two-machine proof.

### Current work

- The distinct shipped coordinator principal and administrator-owned installer
  recipe for the broker service are now frozen as executable, testable
  artifacts. `scripts/remote-worker/install-broker-coordinator.ps1` plus its
  paired uninstall/rollback script materialize the coordinator virtual service
  account `NT SERVICE\GoatCitadelRemoteWorkerProvisionerAvailability` through
  the unrestricted service SID, install the exact demand-start broker/signer
  pair the broker validates, and pin the executable/directory ACLs, required
  privilege list, protected two-ACE broker SCM DACL, and package-verified
  image SHA-256s, with a read-only preflight, fail-closed refusal branches,
  mid-run rollback, and machine-readable evidence bundles. A repo-hygiene
  contract test pins the security-critical recipe text against the broker
  sources and proves nothing wires the untrusted helper to start anything;
  the scripts parse and compose under Windows PowerShell 5.1 and PowerShell
  7, and the refusal branches are proven without Service Control Manager
  writes. Nothing is installed or started by this tranche; the broker and
  one-exchange signer stay production-dark until the composed supervisor and
  authenticated custody path are proved on a real administrator host.
- The portable package now includes a complete signer/client/broker install recipe.
  It reconciles the transport's exact directory/client ACLs and Windows SDK service
  SID type, requires both embedded image bindings, retains directory/image handles,
  refuses raced roots and existing destinations, and tracks partial copies for
  rollback. Client uninstall is hash-bound and refuses unknown footprint content.
  The named `verify:remote-worker:windows-install` lane exercises the actual Win32
  filesystem helpers and refusal logic under both PowerShell engines without
  installing or starting services. This closes source composition gaps; real
  SYSTEM-owned installation and authenticated custody still require host acceptance.
- The native worker host now owns the package launcher's process tree through
  atomic Job Object membership, closed environment forwarding, pinned Node/entrypoint
  bytes, graceful stop and bounded forced cleanup. A fixed-name SCM dispatcher uses
  the same lifecycle owner. `verify:remote-worker:windows-host` covers real foreground
  process death, descendant cleanup, nested-job breakaway and filesystem refusal.
  Its startup identity guard now checks the dedicated worker virtual account,
  service-logon token, exact SCM configuration and query-only worker service rights.
  The worker now has a separate stopped-service install/uninstall recipe and a
  native installed-file owner. Service mode reads fixed, administrator-controlled
  configuration and holds protected payload handles for the child lifetime;
  worker-writable state stays in a separate directory. The v3 package includes the
  installer helpers and requires their complete inventory. The named
  `verify:remote-worker:windows-service-install` lane checks actual temporary-file
  behavior, both PowerShell engines and native configuration/ACL policy. Real
  installed startup/stop/recovery, protected runtime signer caller identity,
  custody and the native execution-cell adapter remain open; the host does not grant
  signer access. Preflight refusal and synthetic configuration are not installed
  lifecycle or authenticated custody proof.
- Operator-owned initial enrollment now has a packaged command before restricted
  worker-service startup. It pins the installed inputs and payload, runs the
  native foreground host once with administrator-only staging state and stops at
  admission. A fresh report binds the exact retained credential bytes before
  atomic publication into worker state; conflicting credentials are preserved.
  Retries can reuse retained private authority with unchanged installation
  bindings. The broker must already be running, and the worker stays stopped.
  The named installer/TLS lanes cover local filesystem, runtime and transport
  behavior. Actual installed operator-to-service enrollment and custody remain
  acceptance gates; runtime-worker admission-signing authority is unchanged.
- The signing transport now distinguishes the elevated interactive operator from
  the dedicated runtime worker. The worker's authenticated exchange exposes only
  inspect, runtime PoP and TLS client signing; creation, admission signing and
  revocation stay administrative. Token/LSA identity is checked before custody
  execution and caller-specific operation advertisements are verified on both
  ends. The installer and native validators now agree on worker read/execute
  access to signer/client images and their protected directories, exact pipe
  read/write access, and query-only signer SCM access. The broker retains its
  SYSTEM/Administrators descriptor. After validating its own service identity,
  signer startup grants the worker query/wait access to its process and query-only
  access to its primary token, retaining existing ACL entries and owner/protection
  state. Both descriptors are checked before either write, and failure prevents
  transport startup. Broker source supervision now owns repeated bounded starts
  after clean signer exits. The client waits for pipe recreation within its
  original deadline before sending anything. Real cross-account authentication,
  installed availability and custody still require proof; the worker receives no
  service-start or configuration authority.
- Prove the installed stopped/start-pending/running broker contract, signer
  restart, exact caller rejection, drift rejection, ARM64 execution, and clean
  uninstall/rollback on a real Windows host, including the first-boot
  `ERROR_SERVICE_NEVER_STARTED` status posture. Source validation now accepts
  that status only for a stopped signer with no PID and clean remaining status
  metadata; broker self-validation and active signer states still reject it.
- Keep current-authority reads and every downstream mutation transactionally
  fenced through M3 node admission and assignment ownership.
- Prove operator-visible diagnostics and the real closed-ingress, N+1 rotation,
  quarantine, revoke, and restart journeys.
- Execute the real two-machine TLS 1.3/mTLS/exporter-bound PoP row.

### Acceptance

- A real second machine completes join, rotation, quarantine, revoke, and N+1
  admission without exposing bootstrap or provider secrets.
- Durable nonce replay remains fenced across restart and concurrent connection.
- Live PostgreSQL, auth, audit, rate-limit, and workspace-isolation proof pass.

Owner contract: `OPENCLAW_HERMES_PARITY_PROGRAM.md`, `HX-501`.

## M3 - Remote-worker durable execution and ordered transport

### Current work

- A production-dark task-bound durable-Chat offer/claim/workload owner now
  derives eligibility from the canonical durable payload and current session,
  M2 credential, M3 mesh admission, workspace, capability-profile, and parent
  run authorities. The worker supplies its lease secret, Gateway hashes it
  before the atomic claim, and response-loss replay returns secret-free
  canonical state.
- Route codes 8 through 10 now have a production-dark protected dispatch wire
  for offer polling, atomic claim, and immutable workload read. It requires the
  exact protected PoP-v2 descriptor, verifies current M2 credential/mTLS
  authority before proof, consumes the durable credential nonce before any
  assignment business read, and delegates the final M2/M3/task/durable fence
  to the storage transaction. The worker-proposed 32-byte lease secret is
  hashed at the Gateway boundary and cannot be echoed in the response. No
  native mux, runtime factory, startup composition, or worker poller is
  registered.
- The production-dark assignment RPC for synchronization, lease renewal,
  ordered event append, cancellation reads, and settlement now requires the
  contract-owned protected PoP-v2 proof. It binds the canonical M2 current
  credential/protected-evidence owner, worker generation, exact assignment
  workspace, and current mesh-admission generation before all five outcomes.
  The native mux and runtime factory remain intentionally uncomposed.
- Every protected route 2 through 6 now carries the exact M2 credential,
  protected-evidence, and M3 mesh-authority fence into its assignment owner.
  Storage rechecks that complete fence inside the same transaction after the
  canonical locks and before replay, read, or mutation. Focused regressions
  prove credential rotation, protected-context drift, and mesh join-authority
  revoke reject stale reads and writes. The live PostgreSQL contention proof
  now serializes credential rotation, protected-context drift, join-authority
  revoke, and duplicate replay against in-flight fenced routes on real
  concurrent connections: the stale side is rejected deterministically inside
  the storage transaction and the winning side commits exactly once.
  Composition remains gated on the authenticated worker runtime below.
- The authenticated connected-worker runtime core now exists as a real second
  process (`apps/remote-worker`). It durably retains the reusable M2 credential,
  per-assignment leases, and the Ed25519 PoP-v2 signing pin; it refuses to store
  any bootstrap-secret-shaped field, so reconnect and restart replay only the
  credential bearer, never the one-time bootstrap secret. It carries ordered
  transcript/events through a retained, hash-chained outbox with monotonic
  idempotent acknowledgement, a bounded (fail-closed) unacknowledged window,
  reconnect catch-up that resends byte-identical frames, and durable restart
  re-hydration of the exact unacknowledged tail — the worker half of Gateway-side
  exactly-once materialization. Terminal settlement is idempotent, retains the
  canonical HX-306 usage ids without fabricating accounting, rejects a
  conflicting re-settle, and does not re-settle after restart.
- With the live-PostgreSQL contention gate satisfied (`96cb77496`), the
  production-dark routes 8-10 dispatch wire and routes 2-6 assignment RPC are now
  composable into the native listener: the native mux registers routes 8-10, the
  admission composition requires both the assignment RPC and dispatch owners
  (fail-closed), and a reusable runtime-composition factory assembles both over
  the canonical repositories. This is gated behind an explicit
  `GOATCITADEL_WORKER_ASSIGNMENT_RUNTIME_ENABLED` flag (default OFF); default
  production omits the owners and the listener stays dark, so the connected-worker
  E2E composes them, not production-by-default.
- The closed protected-proof table is now exactly **thirteen** purposes.
  `REMOTE_WORKER_POP_V2_ROUTE_BINDINGS` adds code 11 (HX-503 inference
  request/response exchange) and code 12 (HX-506 artifact/effect settlement
  submission), plus code 13 for the closed mesh capability exchange. These are
  credential-authority POST routes. The contracts closure test pins all thirteen by
  exact shape, the Gateway protocol-v2 pin and the provisioner helper-protocol
  table walk mirror it, the Windows protected PoP-v2 **native signer** admits
  route codes 1-13 and refuses everything else, and the worker runtime signer
  still refuses the bootstrap route. The 285-byte preimage layout is unchanged.
  The named Windows provisioner lane passed with refreshed client binary
  anchors, byte-identical x64/ARM64 builds and x64 ASan execution; exact receipts
  are recorded in the comparison implementation status. ARM64 compilation is distinct from
  live ARM64 execution; the native ASan test executable runs on x64.
- Routes 11-12 are wired through the same flag-gated composition. The runtime
  composition builds the execution owner **only** when the production-dark
  HX-503 inference and HX-506 artifact/effect inner owners are injected;
  production injects none (there is no live governance, budget, LLM, CAS, or
  effect-coordinator adapter), so the all-or-nothing admission composition
  returns undefined and the listener stays `listening_dark` even with the flag
  ON. The routes 11-12 owner carries the routes 2-6 fence discipline verbatim:
  the canonical M2 credential and protected admission evidence are resolved
  before PoP, the durable nonce is consumed before any owner outcome is
  observed, the current mesh-node admission for the assignment's execution
  workspace is resolved, and that complete protected commit fence is rechecked
  **inside** the assignment storage transaction before the inference or
  settlement owner is reached.
- The connected-worker loop now EXECUTES single-host as `verify:remote-workers`
  scenario 12 (11 executed / 1 skipped-with-reason / 0 failed). A spawned
  `apps/remote-worker` process admits itself over the composed native mTLS
  listener (route 1, with a protected admission envelope bound to that
  connection's exporter), binds its mesh node (route 7), polls and claims an
  offer the harness created through the canonical storage owners exactly as a
  scheduler eventually would (routes 8-9), reads its workload (route 10), ships
  ordered transcript events (route 4), is killed mid-loop holding a live lease
  and an unacknowledged tail, restarts on the RETAINED credential, replays the
  first batch byte-identically while appending only the fresh tail, rotates its
  lease (route 3), reads control (route 5), and settles once (route 6). The
  assertions read durable state, never logs: exactly one runtime credential, one
  assignment generation, one settlement, three contiguous non-duplicated events,
  and zero HX-306 rows.
- Running the loop for the first time surfaced two real defects in the composed
  path, both fixed: the transport header allowlist omitted
  `x-goatcitadel-mesh-node-join-credential`, so every route-7 request was aborted
  before the mux and the composed route was unreachable; and the mesh-node
  admission owner's `admittedByActorId` postcondition expected a
  worker-generation segment the canonical storage owner never writes, so a real
  admission committed its effect and then answered 403.
- Still open on the live loop: production scheduler dispatch (offer creation is
  still production-dark), and routes 11-12. The E2E composes a fail-closed
  execution owner that refuses every call, because the HX-503 inference owner
  needs governance/approval/budget/routing/HX-306-accounting adapters and the
  HX-506 owners need a CAS store and an effect coordinator — production composes
  none of them. That gap is visible in the executed settlement itself: a
  `completed` outcome must cite a committed HX-506 artifact manifest, so with no
  artifact owner composed the worker settles the outcome it can evidence.
- Prove worker death, disconnect, lease takeover, cancellation, stale callback
  fencing, and approval-gated resume against the live listener. Death, restart,
  byte-identical replay, and no-duplicate accounting are now proven end-to-end
  by scenario 12; lease takeover by a second worker, cancellation-to-settlement,
  and approval-gated resume remain unexecuted.

Owner contracts: `OPENCLAW_HERMES_PARITY_PROGRAM.md`, `HX-502` and `HX-504`.

## M4 - Live worker adapters, settlement, and visibility

### Implementation progress

- The production-dark HX-503 inference owner is hardened through paired SQLite
  196/PostgreSQL 139 authority. It hashes the raw lease at the sole boundary,
  sends only a lease-free normalized command to downstream owners, and binds
  the exact current worker/assignment/run/task/profile/context, route, budget
  owner, operation, and token ceilings.
- Denied and waiting requests reserve no budget. Dispatchable requests require
  durable budget authority; release records a stable blocked intent before the
  external effect, and response-loss, expiry, concurrent claim, terminal
  settlement, and restart recovery are exact-idempotent. Canonical HX-306 usage
  IDs are retained without fabricating accounting evidence.
- The initial production-dark proof passed 22 contract tests, 53 Gateway tests, 24 selected
  storage tests with two live-PostgreSQL rows visibly skipped, all three package
  typechecks, and the full 196/139 migration-parity, integrity, and runtime
  schema lane. Listener, scheduler and live atomic budget composition were absent
  from that initial receipt; subsequent integration evidence is recorded below.
- HX-505 capacity admission now uses the stored immutable reservation, retains
  absolute cleanup/quarantine footprints without counting repeated scans twice,
  and rejects decisions made before a capacity or cleanup revision changes.
  Capacity and cleanup writes compare revisions inside their transactions and
  append evidence only after a successful update. The fresh
  `2026-09-11T04-42-59-335Z-remote-workers-dc62a0ba` receipt passes all twelve
  checks, including 778 Gateway, 14 worker-process and 21 PostgreSQL tests.
  The physical two-machine scenario remains skipped; this does not implement
  the protected native volume, executor or OS quota adapters.
- The internal Windows cell Job Object component now applies per-invocation
  CPU, memory, process, wall-time and output limits, atomically assigns the child
  at creation, excludes ambient handles/environment and verifies zero processes
  before returning. Launch now also requires the cell's exact AppContainer SID,
  zero capabilities and a low-integrity token verified before resuming the child.
  Launch also verifies the expected executable hash and directory identity from
  open NTFS handles, rejects aliases/unsafe metadata and retains the path
  components while running through volume GUID paths.
  The native workspace helper now creates controller, runtime and writable work
  roots exclusively relative to an admitted parent handle, with kernel-applied
  DACLs and integrity labels. Parent admission now verifies exact ownership,
  protected DACL and integrity, pins NTFS ancestry and rechecks the admitted
  identity before creation. Reverification checks parent and root identity,
  metadata and exact security; creation refuses existing names and retains partial
  disk state. A separate recorded reopen path requires independently retained
  parent/root identities and freshly verifies all protected descriptors. It never
  creates missing objects, adopts replacement names or repairs changed security.
  `pnpm verify:remote-worker:windows-cell-job` previously passed 697 resource/identity/file
  checks, including 53 launch-filesystem, 40 input-delivery, 57 interactive-stdio,
  239 workspace permission/reopen, 108 backing-file creation/recovery, 24 attachment/recovery-authority and 69 runtime
  bundle checks, plus eight controlled loopback checks
  in each of normal and AddressSanitizer builds, and separate static/interactive
  controller-crash child-lifetime tests. The child cannot open the
  private fixture file or parent controls. The network probe retains a timeout;
  the same native probe connects outside AppContainer to the same listener.
  The AppContainer edits its own work files while controller reads, runtime
  writes, sibling-cell access and root permission changes are refused. This is
  an internal protected-root creation/reopen primitive; the current-user fixture is not installed
  LocalSystem/service-SID custody proof. A shared v1 manifest now binds exact
  ordered runtime paths, sizes and hashes. The native verifier rejects missing,
  extra, changed, aliased and unsafe files, pins the complete declared tree, and
  requires the entry executable to belong to it before the bounded job launch.
  Normal native, AddressSanitizer, Node and TypeScript digest vectors agree;
  the full contracts package passed 738 tests in its separate bundle-contract
  receipt. An internal installer now copies from pinned source handles into an
  empty protected runtime root with exclusive creation and the exact root
  descriptor, then verifies and pins the installed inventory. Native proof
  launches that installed image inside AppContainer, completes a 256-file copy,
  cancels another copy with disk-matched counters and refuses to adopt its partial
  files. Shared literal volume-GUID path validation supports the protected root;
  normal NTFS directory index growth no longer fails metadata admission.
  The job and bundle launch entrypoints now accept explicitly bounded stdin
  through a private read-only child handle. Input pumping does not block output,
  wall limits or cancellation; pending writes are joined before their buffers
  are released. Native proof covers binary delivery up to 1 MiB, simultaneous
  output pressure, early closure, stalled readers and bundle-level admission.
  Pipe-delivery counters do not establish tool acceptance or effect completion.
  The same owner now also accepts a one-use interactive stdio channel. Empty
  queues keep stdin open until explicit EOF; all frames share the admitted input
  limit. Fixed input/output queues bound buffering, and unread protocol output
  fails rather than being returned as a truncated success. Native proof covers
  a fresh child challenge, binary exchanges through wrapping queues, cancellation,
  wall limits, duplicate channel refusal and actual verified/installed bundle
  exchanges. The complete runtime tree remains pinned throughout the exchange.
  A separate image-pinned native helper now connects this owner to the Node worker
  through bounded, byte-framed I/O. Launch configuration is frozen before async
  authority checks; explicit input EOF, output accounting and cancellation remain
  visible. An internal stdio MCP owner now shares initialization, discovery and
  schema checks with HTTP, invokes one tool, and requires confirmed native cleanup.
  Server-start failures remain uncertain after launch is attempted. The worker
  suite passed 376 tests, including persisted execution-before-launch and restart
  no-replay checks. Native and fresh portable-package stdio verification each
  passed 14 tests, including actual Node MCP execution from a protected workspace.
  The explicit protected stdio mode reopens independently recorded roots, retains
  their handles through native cleanup and verifies exact security before and
  after execution. Changed roots cannot fall back to bundle-only execution, and
  permission drift after child startup refuses a successful completion. The worker's
  existing execution journal now retains private workspace identities and launch
  hashes before native entry, carries them through settlement and refuses replay
  after restart. This metadata does not authorize provisioning, execution or cleanup.
  Service-owned provisioning and recovery reconciliation, credential custody, stock registry
  integration and the Gateway approval/recovery journey remain unfinished.
  The exact receipts are in the
  [interactive stdio completion ledger](./testing/COMPARISON_IMPLEMENTATION_STATUS.md#interactive-native-worker-stdio).
  [Packaged bridge proof](./testing/COMPARISON_IMPLEMENTATION_STATUS.md#packaged-native-stdio-bridge)
  distinguishes portable execution from installed-service and physical-worker
  acceptance.
  The [stdio MCP execution ledger](./testing/COMPARISON_IMPLEMENTATION_STATUS.md#stdio-mcp-execution-and-loaded-image-verification)
  records the native Node launch fix: a drive-letter launch locator is accepted
  only with the original file pins and verification of the suspended process's
  actual native image before resume. Directory identity remains volume-based.
  A separate internal owner now creates a fixed VHDX backing file inside the
  verified controller directory, preserving frozen controller rights with
  file-appropriate inheritance flags. It checks exact disk/file identity,
  physical allocation, fixed subtype and unattached state. Creation refuses
  existing files; cancellation and expiry join pending I/O and preserve disk
  state for canonical reconciliation. A freshly verified disk record now retains
  the control/backing object identities, disk GUID and frozen capacity. A read-only
  owner can reopen the exact recorded, unattached disk after all original handles
  close. It refuses missing/replaced files, mismatched metadata and security drift
  without repairing or recreating anything. A fresh native process verifies the
  retained workspace and disk records; complete backing-file hashes remain unchanged.
  This record does not establish workload death, attachment or cleanup authority.
  [Recorded disk proof and limits](testing/COMPARISON_IMPLEMENTATION_STATUS.md#reopening-recorded-virtual-disks)
  retain the separate normal/AddressSanitizer receipts and the failed first fixture.
  Allocation checks occur after creation,
  so this is not an OS quota or a transient usage guarantee. An internal attachment
  owner now retains verified backing identity, checks effective-token privilege,
  requests no drive letter/permanent lifetime and leaves uncertain outcomes for
  reconciliation. Detach is explicit and rechecks identity, privilege and control.
  The attachment owner now also accepts the independently retained disk record
  to reopen an existing attachment through current privilege and exact identity
  checks. Failed recovery remains unknown and cannot detach or silently start a
  new attachment. The administrator lane includes closing original disk handles,
  recovering the recorded attachment, rechecking privilege and detaching the exact
  owned image. Its positive recovery branch is still unverified on this host;
  local receipts explicitly retain `volumeAttachmentRecoveryVerified: false`.
  [Attachment recovery source and proof boundary](testing/COMPARISON_IMPLEMENTATION_STATUS.md#recorded-attachment-recovery-source)
  records the fresh privilege preflight and separate native results.
  A separate portable acceptance bundle now includes pinned Node, normal/ASan
  fixtures and their runtime dependencies. Its fresh ZIP extraction passed 697
  checks in each native build without invoking a compiler. The explicit volume
  preflight still rejects this session's missing privilege. This prepares mini-PC
  testing without closing physical-host or installed-worker acceptance; see
  [portable native cell acceptance](testing/COMPARISON_IMPLEMENTATION_STATUS.md#portable-native-cell-acceptance-bundle).
  A protected native provisioning journal now coordinates workspace and fixed-disk
  creation, flushing intent before each operation and verified object identities
  afterward. Recovery requires the independently retained plan/journal reference,
  preserves incomplete or conflicting work and cannot resume creation. Exact
  security, bounded logical/allocated bytes and the complete record chain are
  rechecked. This adds local durable resource records; installed service,
  capacity/reconciliation composition and installed custody are still required.
  The earlier native lane passed 941 checks in each normal/AddressSanitizer build,
  including 244 journal checks and recovery from the persisted journal in a new
  process. The earlier portable bundle has not been rebuilt for this change.
  See [the native provisioning journal](testing/COMPARISON_IMPLEMENTATION_STATUS.md#protected-native-provisioning-journal).
  Canonical cell claims and platform publication now use database time and require
  the exact unexpired lease returned by the winning claim. The final mutation
  rechecks that authority; caller clock changes and controller-name reuse cannot
  authorize stale publication. SQLite and actual PostgreSQL tests include expiry
  inside the open publication transaction. See
  [canonical provisioning lease proof](testing/COMPARISON_IMPLEMENTATION_STATUS.md#canonical-provisioning-lease-authority).
  SQLite 221 / PostgreSQL 166 now retain an immutable provisioning plan and the
  five exact native checkpoints. The coordinator commits each record before
  acknowledgement and uses independent snapshots to reject missing, rolled-back
  or uncommitted recovery history. The native owner requires exact-digest
  acknowledgements before later resource creation. Fresh normal/ASan proof passes
  998 checks each, with 301 journal checks; both record sets also pass the shared
  TypeScript decoder. The database/coordinator and native acknowledgement tests
  remain separate component proofs. A subsequent local process bridge now joins
  the real image-pinned helper to the canonical coordinator: 16 Gateway tests pass,
  including actual creation/recovery, lost-acknowledgement and cancellation cases.
  Separate normal/AddressSanitizer protocol tests verify refusal, retained evidence
  and the helper's own watchdog. Package inventory requires the newly pinned image.
  The named provisioning lane passes 5/5; installed service composition remains
  unfinished. See [the native process bridge](testing/COMPARISON_IMPLEMENTATION_STATUS.md#native-provisioning-process-bridge).
  PowerShell and JavaScript now agree on required native package images. The
  installer lane passes 31/31, including both PowerShell engines. A fresh unsigned
  worker ZIP passes both readers after extraction, and its own Node/driver/helper
  complete five checkpoints plus fresh helper recovery with a controlled file sink.
  This package proof is separate from canonical SQLite coordination and installed
  service custody. The restricted worker account cannot own privileged volume
  operations; a separate authenticated cell controller remains source work.
  Its dedicated identity/custody admission owner now compiles and passes 248
  checks in each normal/AddressSanitizer build, including actual interactive
  caller refusal without privilege changes. The native cell regression separately
  passes 998 checks per build. Positive installed custody, the service/IPC host,
  volume integration and packaging remain unfinished. See
  [controller identity admission](testing/COMPARISON_IMPLEMENTATION_STATUS.md#dedicated-cell-controller-identity-admission).
  The native pipe owner now binds retained client-process evidence to actual
  Windows identification tokens and drains pending I/O on stop/timeout. Its lane
  passes 121 checks in each normal/AddressSanitizer build using six client
  processes and seven pipe fixtures; worker/controller identity regressions
  also pass. This remains component proof. The service/client, request protocol,
  positive installed admission and provisioning composition are unfinished; see
  [controller pipe identity and I/O](testing/COMPARISON_IMPLEMENTATION_STATUS.md#controller-pipe-identity-and-bounded-io).
  The dedicated service source now composes installed identity, a local protected
  listener, bounded nonce-bound requests and native journal checkpoints. Its lane
  compiles both service variants and passes 205 protocol checks per normal/ASan
  build across nine fixture sessions, including actual creation/recovery and
  refusal of malformed or revoked requests. Installed SCM lifecycle, the worker
  client and mutual authentication, canonical Gateway bridge and package/installer
  integration remain unfinished. See
  [controller service and provisioning protocol](testing/COMPARISON_IMPLEMENTATION_STATUS.md#controller-service-and-provisioning-protocol).
  The worker-side identity owner now verifies the connected controller through
  retained OS process evidence, current SCM state, token policy and shared
  installation custody. The native client identity lane passes in normal/ASan
  builds with two separate server processes each; shared query-only inspection
  passes 121 checks per build. All 47 signer packaging checks and the existing
  controller identity/transport/protocol lanes pass after the extraction.
  Request forwarding in the provisioning helper, canonical acknowledgement
  composition, positive installed-service proof and packaging remain unfinished.
  See [worker-side controller authentication](testing/COMPARISON_IMPLEMENTATION_STATUS.md#worker-side-controller-authentication).
  The provisioning helper now has a fixed authenticated controller mode and
  forwards the Gateway's exact checkpoint digests without direct-mode fallback.
  The client/server protocol lane passes 419 checks per native build across
  26 sessions. The helper/Gateway lane passes 6/6 and the full TLS lane passes,
  including reproducible x64/ARM64 helper builds. Protocol fixture and canonical
  direct-helper proofs remain separate; positive installed-controller/Gateway
  acceptance, stock assignment
  composition and protected-volume execution remain unfinished. See
  [controller request and checkpoint forwarding](testing/COMPARISON_IMPLEMENTATION_STATUS.md#controller-request-and-checkpoint-forwarding).
  The Windows worker package now includes the controller. The installer stages
  separate stopped worker/controller services and the protected image/directory
  custody record; uninstall preserves cells and configuration. The expanded
  installer lane passes 33/33, including both PowerShell readers, native record
  and descriptor compatibility, and reproducible x64/ARM64 controller builds.
  A fresh x64 ZIP passes extraction, package readback and foreground probes.
  Actual elevated installation/startup and installed-controller/Gateway acceptance
  remain unproven. See [controller package and installation custody](testing/COMPARISON_IMPLEMENTATION_STATUS.md#controller-package-and-installation-custody).
  Protected assignment settlement now carries canonical cell snapshots and
  checkpoints through the asynchronous storage owner. The transaction rechecks
  worker/mesh/parent authority, exact assignment lease and the prepared native
  claim before acknowledging a record. Six SQLite/PostgreSQL cases, 52 Gateway
  regressions, 16 contract checks and four worker client checks pass. This does
  not issue creation permits or connect normal assignments to native execution;
  profile/claim creation, installed custody, helper startup and protected-volume
  execution remain unfinished. See
  [protected assignment provisioning exchange](testing/COMPARISON_IMPLEMENTATION_STATUS.md#protected-assignment-provisioning-exchange).
  A pinned helper read now exposes the fixed installed image/directory custody
  after native worker admission, without creating resources. Its worker owner
  bounds output, joins its child on interruption and checks current authority
  before returning metadata. The 49 focused worker cases, normal/ASan native
  codec/identity checks and seven-case provisioning regression pass. Positive
  installed-service admission, normal assignment
  startup and protected execution remain unfinished. See
  [installed custody startup query](testing/COMPARISON_IMPLEMENTATION_STATUS.md#installed-custody-startup-query).
  Gateway preparation now commits a canonical native profile, capacity
  reservation, claim and immutable plan together. The protected request cannot
  choose policy or approval fields. Only the first commit returns `create_once`;
  replays return `reconcile`, including after a lost response with no checkpoint.
  Protected-route, worker-client and factory composition checks pass, with the
  profile bound to retained signed installation evidence and current assignment
  state. Normal worker startup, native execution and installed/live proof remain
  unfinished. See
  [canonical native cell preparation](testing/COMPARISON_IMPLEMENTATION_STATUS.md#canonical-native-cell-preparation).
  The worker now has a provisioning startup owner which consumes the decision,
  retains a local stop marker, uses current rotated leases for protected requests,
  and drives the installed controller's exact checkpoint protocol. Recovery never
  recreates resources. Its 98 focused worker cases and eight-case native lane
  pass, including real helper creation/recovery and lost-acknowledgement evidence
  under temporary component fixtures. This exported owner does not activate the
  native backend or make normal assignments platform-ready. See
  [worker native provisioning startup](testing/COMPARISON_IMPLEMENTATION_STATUS.md#worker-native-provisioning-startup).
  A native device owner now binds an opened disk handle to the exact retained
  VHDX attachment/backing dependency and virtual length. It refuses arbitrary
  locators and exposes no formatting or raw-handle operation. Normal/ASan native
  proof passes 1,063 checks each, including 65 dependency metadata/refusal cases.
  Positive attached-device binding remains unverified in the explicit privileged
  lane. See [bound virtual-disk device source](testing/COMPARISON_IMPLEMENTATION_STATUS.md#bound-virtual-disk-device-source).
  The 53-file portable acceptance ZIP includes the device-binding source and
  prebuilt fixtures. Its extraction passed 1,063 checks in each native build
  without a compiler; it remains a private test bundle and does not prove an
  installed worker or a second Windows machine. It predates the GPT layout owner.
  Native GPT initialization/partitioning source now requires separate retained
  intent/completion records, fresh authorization and exact reserved/data partition
  readback. Lost acknowledgements and changed layouts stop further writes;
  recorded recovery cannot resume initialization. Its component sequence uses
  controlled SDK/acknowledgement fixtures in normal and AddressSanitizer builds. Native recovery
  and the protected Gateway exchange now derive identical GPT identifiers from
  the frozen assignment/profile/VHDX binding without rewriting the original
  provisioning records. Shared contracts verify the four layout records and
  their ordering. The native journal now composes attachment/layout with six
  additional flushed and independently acknowledged records in its existing
  protected file. Complete recovery requires the exact canonical volume history;
  legacy recovery and interrupted prefixes cannot silently resume it. The
  Gateway exchange now retains the six exact volume records in paired
  SQLite/PostgreSQL append-only storage with current assignment, admission and
  provisioning-claim checks. Creation-only coordinators explicitly refuse volume
  recovery. The controller and pinned helper now carry all eleven records and
  numbered checks against the current canonical history; the Windows startup
  coordinator requires volume preparation and never resumes a partial prefix.
  Consumers reject checkpoints and success without renewed authority for the
  current retained head. The compiled protocol passes 2,476 checks in each native
  build using controlled attachment/layout replies. Actual installed-service and
  attached-disk proof, formatting, mounting, quotas and normal assignment
  composition remain open.
  See [native GPT layout source](testing/COMPARISON_IMPLEMENTATION_STATUS.md#native-gpt-layout-source).
  See [canonical GPT identity and checkpoint contracts](testing/COMPARISON_IMPLEMENTATION_STATUS.md#canonical-gpt-identity-and-checkpoint-contracts).
  See [durable native volume journal](testing/COMPARISON_IMPLEMENTATION_STATUS.md#durable-native-volume-journal).
  See [canonical volume checkpoint exchange](testing/COMPARISON_IMPLEMENTATION_STATUS.md#canonical-volume-checkpoint-exchange).
  See [controller volume continuation](testing/COMPARISON_IMPLEMENTATION_STATUS.md#controller-volume-continuation).
  See [installer parity and the candidate](testing/COMPARISON_IMPLEMENTATION_STATUS.md#installer-inventory-parity-and-current-worker-package).
  See [canonical checkpoint coordination](testing/COMPARISON_IMPLEMENTATION_STATUS.md#canonical-provisioning-checkpoint-coordination).
  Normal assignment startup still must invoke native preparation and establish
  zero-workload authority. The separate `verify:remote-worker:windows-cell-attachment` command
  stopped at privilege preflight on this host; successful attachment/detach is
  unverified. Actual attached-volume acceptance, formatting and protection,
  installed ACL composition, quotas, governed runtime-bundle publication and custody,
  complete network enforcement, recovery, assignment wiring, service integration
  and packaging remain required. This component does not
  enable the native cell backend.
- Static MCP binding contracts and immutable profile validation now retain exact
  target, schema, catalog and actor/turn scope without endpoint or credential
  material. Separate proof passed 37 contract tests and three focused storage
  tests including PostgreSQL close/reopen. Production registry writes now issue
  opaque configuration identities, reject stale configuration snapshots and
  preserve concurrent status updates. Separate proof passed 18 registry tests,
  including two PostgreSQL RPC workers and restart, and six storage tests. The
  focused Gateway run passed 75 tests with its optional PostgreSQL case covered
  separately; fresh runtime-truth proof passed both backend and shell scenarios.
  OAuth now stages immutable credential references and publishes them against
  the original server/auth snapshot, atomically rotating configuration identity
  and clearing first-use approvals when authority changes. Server deletion
  atomically clears auth, tools and first-use approvals. Fresh proof passed 100
  focused Gateway tests, with the optional PostgreSQL case run separately in a
  passing 24-test registry run, plus both auth-matrix and runtime-truth scenarios.
  Durable OAuth reservations now use the shared external-effect ledger and
  ownership-fenced claims before HTTP. Auth and terminal ledger records commit
  together; unknown outcomes block automatic refresh across restart, and explicit
  reconnect starts a fresh grant that rejects a late result from the old request.
  New proof passed 107 focused Gateway tests and a separate 25-test PostgreSQL
  run, including actual RPC workers and loopback token requests, plus both
  auth-matrix and runtime-truth scenarios.
  Environment credentials now have private keychain proofs and opaque registry
  references. Explicit connect/reconnect accepts changed values; Gateway discovery,
  stdio/HTTP calls and OAuth setup use captured values and reject stale authority.
  Environment publication atomically rotates configuration identity and invalidates
  old OAuth grants and first-use approvals. Fresh proof passed 138 focused Gateway
  tests and a separate 25-test PostgreSQL run, plus both auth-matrix and runtime-truth
  scenarios. Static native MCP catalogs now join Chat admission, immutable
  profiles, policy checks, approved dispatch and worker placement. Fresh metadata
  from the invocation connection must match the frozen definition; actor, scope,
  shared capability, environment and configuration are rechecked before dispatch.
  The focused Gateway run passed 308 tests. A separate six-test catalog run covers
  cross-mode collisions and forged handles. Two stock built-Gateway/Windows-worker
  restart cases passed, including approval continuation and replay without another
  MCP call or Chat reply. These use loopback providers and synthetic worker custody;
  they do not prove installed custody or physical two-machine behavior.
  Canonical OAuth/environment replacement and removal now retain credential
  retirement records transactionally. Cleanup after startup/publication checks
  current bindings, preserves failed deletion for retry, and permanently fences
  retired versions against republication. Fresh proof passed 138 focused Gateway
  tests, 25 separate PostgreSQL tests, six real PowerShell control-flow cases
  using synthetic vaults, Gateway typecheck, async-boundary, runtime-truth and
  auth-matrix lanes. Fresh OAuth/environment writes now enter a private staging
  journal before keychain mutation. Publication consumes acknowledged staging
  transactionally; expired unreferenced ready versions enter
  durable retirement. Suspended/unacknowledged writers remain quarantined rather
  than being deleted on a timeout. The maintenance owner revisits bounded pending
  work. Fresh focused proof passed 115 Gateway tests; a separate PostgreSQL
  receipt passed all 26 tests, including staging recovery across two RPC owners
  and restart. Version 2 journals now carry the original Windows host/account
  custodian into retirement. Guarded helpers reject different custody, occupied
  slots and missing write/delete acknowledgements; unknown custody cannot complete
  automatic cleanup. A fresh 172-test Gateway run and separate 26-test PostgreSQL
  run passed, including synthetic Windows helper execution and custody retention
  across RPC owners/restart. Unacknowledged writers, legacy/unindexed inventory,
  custodian migration/rebinding, non-Windows retirement custody, actual keychain
  acceptance and installed/live acceptance remain required.

### Current work

- Connect HX-505 to the protected native volume/executor and the real container,
  backup and native-filesystem boundaries. The native journal now composes NTFS
  formatting through two additional flushed and independently acknowledged
  records, preserving all creation/volume bytes and requiring exact canonical
  history for recovery. Normal/AddressSanitizer builds each pass 3,641 native
  checks, including 1,094 journal cases; controller protocol regression and the
  eight-case helper/Gateway lane pass. Shared format contracts, SQLite 223 /
  PostgreSQL 168 and the protected Gateway/worker exchange now retain exact
  formatting checkpoints. Four SQLite and four real PostgreSQL scenarios pass,
  including rollback and expired/revoked authority. The controller, pinned helper
  and worker startup now carry all thirteen records through exact canonical
  acknowledgements and current authority. The compiled protocol passes 5,602
  checks across 67 sessions in each normal/AddressSanitizer build; 152 focused
  worker tests and the eight-case helper/Gateway regression pass. Native root
  protection now binds the original formatter, exact NTFS root identity and
  frozen controller permissions. It passes 1,197 component and 40 actual
  temporary-directory checks in each normal/AddressSanitizer build. Formatter
  checks now detect identity/filesystem drift during authority exchanges; 1,277
  component and 24 read-only Windows checks pass in each build. The native
  journal now retains two protection records after the unchanged thirteen-record
  history, with a portable policy/SID digest, exact acknowledgements and read-only
  complete recovery. Normal/AddressSanitizer builds each pass 4,109 checks,
  including 1,547 journal checks. Canonical protection contracts, SQLite 224 /
  PostgreSQL 169 and the protected Gateway/worker exchange now retain both
  protection records, bound to the complete earlier history and frozen policy.
  Four SQLite and four PostgreSQL scenarios, 41 contract, 59 worker and 50
  Gateway tests pass. The controller, pinned helper and worker startup now
  transport and validate all fifteen records. Protection binds locally resolved
  owner/controller policy; recovery requires the exact full history and cannot
  resume writes. Normal/AddressSanitizer controller fixtures each pass 9,442
  checks across 90 sessions; 181 focused worker tests pass and x64/ARM64
  controller payloads reproduce. No real drive was attached, partitioned,
  formatted or given new root permissions. Read-only mount-target inspection
  now verifies host parent/leaf identities, the exact volume-GUID reparse target,
  the expected alias and the resolved NTFS root. Normal/AddressSanitizer builds
  each pass 359 checks, including 17 actual directory checks; ARM64 compiles.
  A one-shot mount owner now requires four exact acknowledgements, fresh
  authority at directory creation/mount submission and final native readback;
  recovery requires the complete history and remains read-only. Normal and
  AddressSanitizer builds each pass 2,378 checks including nine ordinary
  directory checks; ARM64 compiles. Mount SDK success is simulated, with no
  physical volume mutation. The journal now retains four mount records after
  the unchanged fifteen-record history, with exact acknowledgements and
  read-only complete recovery. Normal/AddressSanitizer builds each pass 4,892
  checks, including 2,330 journal checks; an independent Node decoder verifies
  all nineteen records. Canonical v6 mount exchange now retains all four mount
  records through shared contracts, SQLite 225 / PostgreSQL 170 and protected
  Gateway/worker settlement. Four SQLite and four actual PostgreSQL scenarios,
  43 contract, 73 worker and 51 Gateway tests pass. Workers without mount recovery
  preserve the complete history and require reconciliation. Controller/helper
  mount transport and installed startup now require all nineteen records and
  independently retained creation identities. Normal/AddressSanitizer controller
  builds each pass 14,893 checks across 121 sessions; the compiled helper passes
  33 stream scenarios per build, closing the earlier protection/mount forwarding
  gap. The native journal lane passes 4,939 checks per build, 162 focused worker
  tests pass, and x64/ARM64 controller payloads reproduce. Typechecks pass. These
  checks use controlled volume drivers and unattached VHDX files. The mounted
  workspace directory component now binds four protected roots to the original
  volume handle, mount completion and frozen policy. Exact acknowledgements,
  fresh guards before each create and complete read-only recovery are covered by
  324 normal/AddressSanitizer checks per build, including 89 actual ordinary
  directory checks; ARM64 compiles. The native journal now appends two mounted
  workspace records after the unchanged nineteen-record history, with exact
  acknowledgements, journal readback after authority callbacks and complete
  read-only recovery. Normal/AddressSanitizer builds each pass 4,939 existing
  checks plus 679 dedicated journal checks; Node independently reconstructs the
  twenty-one records. Canonical exchange v7 now retains the workspace pair
  through SQLite 226 / PostgreSQL 171, protected Gateway settlement and worker
  coordination, with exact acknowledgements and independent complete recovery
  evidence. Contracts (47), worker (183), Gateway (52), SQLite (4), actual
  PostgreSQL (4), migration integrity and dependent typechecks pass. Concrete
  controller/helper transport and installed-worker source composition now carry
  all twenty-one records. Normal/AddressSanitizer builds each pass 14,894 existing
  controller checks plus 5,373 workspace checks; helper callbacks pass 48
  scenarios per build. All 204 focused worker tests, typecheck, strict lint and
  reproducible x64/ARM64 payload builds pass. These tests use controlled volume
  drivers and unattached images. Physical recovery, quotas, protected execution
  and installed acceptance remain required; this does not activate the backend.
  See [mounted workspace transport and startup](testing/COMPARISON_IMPLEMENTATION_STATUS.md#mounted-workspace-transport-and-startup).
- Finish mesh-tool and delegation/council placement, and custody-aware recovery
  of unacknowledged MCP writers or older unindexed credential versions.
- Prove installed Windows custody, enrollment and service lifecycle, followed by
  physical two-machine acceptance.
- Complete live-provider inference and artifact/effect acceptance through the
  existing canonical owners and the operator's spending grants.
- Populate remaining HX-507 unavailable projections only when their upstream
  owners supply real worker evidence and their release gates pass. The operator
  assignment-runtime endpoint now supplies retained usage, outstanding budget
  holds, cell state/capacity, artifact/effect summaries and bounded authenticated
  contact observations through asynchronous storage. Contact freshness uses the
  database's nonce-acceptance time; missing retained history is unknown and does
  not imply offline state. Six SQLite and six PostgreSQL scenarios, 15 contract
  tests, 45 Gateway tests and 13 nonce regressions pass. Reads cannot run recovery,
  consume/prune nonces or advance runtime state. UI consumption remains separate;
  recorded contact and cell state do not establish process/socket liveness or
  execution readiness. See [authenticated worker contact](testing/COMPARISON_IMPLEMENTATION_STATUS.md#authenticated-worker-contact).

### Acceptance

`pnpm verify:remote-workers` already proves the Gateway-side composition and
live PostgreSQL owners. As of this tranche the connected-worker runtime core
exists (`apps/remote-worker`, see M3) and the routes 2-6/8-10/11-12 assignment
RPC, dispatch, and execution owners are composable into the native listener
behind an activation flag, so the whole admission -> dispatch -> workload ->
inference -> ordered-event -> lease-renewal -> artifact/effect-settlement loop
now has a worker-facing wire route.

Scenario 12 now **executes**: the lane reports 11 executed / 1
skipped-with-reason / 0 failed, and the only remaining declared skip is
scenario 11's genuinely two-machine mTLS row. A real spawned
`apps/remote-worker` process drives admission, mesh-node binding, offer
poll/claim, workload read, ordered transcript transport, a mid-loop kill, a
restart with byte-identical replay, lease rotation, control read, and one
generation-fenced terminal settlement against the composed native listener.

M4 still does not close. The later comparison implementation adds a second
spawned-worker journey that executes canonical LlmService inference, spends an
operator grant, verifies its exact response in CAS, and completes with a committed
artifact manifest. It also rejects output after parent takeover or expiry, and
replays terminal settlement after restart without another model request. The
complete local worker receipt before the prepared-context change is
`2026-09-09T21-24-34-261Z-remote-workers-e9f9f1a6` (all twelve checks passed;
214 Gateway tests, six spawned-worker scenarios, and eighteen PostgreSQL tests
on the first cluster, including offer recovery after Gateway replacement;
physical two-machine scenario skipped). Earlier lint and connection-refused
failures remain retained.

Prepared-context integration is now validated by the later
`2026-09-09T22-06-40-006Z-remote-workers-38dbd833` receipt: 225 Gateway tests,
six spawned-worker scenarios and 18 PostgreSQL tests on the second fresh cluster
passed. That aggregate failed one lint check; the corrected follow-up passed all
240 lint targets. Separate routed-context and durable-recovery lanes passed
their configured checks. The [comparison evidence](testing/COMPARISON_IMPLEMENTATION_STATUS.md)
preserves the individual receipts, skips and failed attempts.

Production now composes inference, artifact and canonical tool-effect owners behind
explicit activation. Its internal Chat offer scheduler checks the canonical
admission and current execution claim. Eligible Chat admission freezes prepared
Chat history and restores its exact bytes during recovery and worker inference.
The canonical completion path now includes QMD memory and inline hooks under
the worker dispatch guard. Existing assignments now resume through durable Chat,
with verified text, canonical usage and transcript materialization committed by
the normal Chat writer. The canonical finalizer commits the worker result receipt
with terminal state and its sealed checkpoint. An immutable placement owner now
selects local or worker execution at normal durable Chat dispatch and preserves
the choice across retries. Automatic worker selection currently requires an
admitted text or supported tool profile with delegation disabled and an existing
operator grant. Ordinary Chat can receive an immutable generated task at placement.
Requester-scoped MCP/mesh calls, delegation/council and native protected
executor/custody/service remain unfinished. The heartbeat harness
seeds admitted Chat records, admits an idle worker and calls production placement
with controlled provider output; it does not prove live-provider quality or
installed Windows worker isolation. HX-507 fields that
depend on missing owners retain their unavailable labels. Text inference now has
a separate 90-second execution deadline and a real 32.5-second worker-process test;
requests beyond that bound still need a resumable asynchronous delivery design.

Owner contracts: `OPENCLAW_HERMES_PARITY_PROGRAM.md`, `HX-503` through `HX-507`.

## M5 - Governed self-configuration and repair expansion

### Implementation progress

- The generic durable coordinator binds requester, parent reservation,
  normalized recipe digest, purpose-specific approvals, phase leases, owner
  revisions, and receipt lineage in paired SQLite/PostgreSQL storage. Broad
  declarative-config repair remains explicitly manual because the canonical
  config owner cannot prove restart-safe rollback after an arbitrary config
  commit.
- The two dependencies that kept the fixed `config/budgets.json`
  compatibility mirror manual now exist. A native handle-relative
  capture/publish/restore port (Windows, following the repo's fixed
  System32 PowerShell + strictly-validated win32 wrapper precedent) walks
  each path segment relative to the previous directory handle under
  no-follow/no-reparse semantics, captures entry bytes plus volume/file
  identity through those handles, and publishes atomically with
  rename-by-handle against the pinned parent; live Windows tests prove it
  refuses a mid-flight junction/parent-identity swap instead of following
  it. The coordinator now also exposes a per-owner completion callback plus
  a durable settlement query so a finished recipe's pre-effect journal
  entries retire boundedly in process and across restarts.
- The budgets.json mirror is therefore the first callable recipe. It is
  approval-gated (`required_before_apply`), installation-scoped, limited to
  `local_dev`/`trusted_local` with `remote_hardened` failing closed, and it
  never auto-fires. The owner journals the handle-captured prior bytes
  before crossing the publish boundary and proves prior state, effect
  identity, restart reconciliation (journal replay on boot decides
  commit/rollback/no-effect from coordinator truth), and rollback to the
  exact captured bytes, with non-disclosure of every non-budgets config
  section. The coordinator itself is still not composed into the production
  Gateway, the handle port has no POSIX implementation (the recipe reports
  owner-unavailable and fails closed off Windows), and live provider,
  packaged-process restart, and browser secure-input rows stay held.
- OpenAI Codex OAuth has an exact installation-scoped, secret-free
  assessment and manual-required recipe boundary. It deliberately exposes no
  effect owner or live-probe claim: current keychain/OAuth APIs cannot prove
  CAS ownership, restart reconciliation, or rollback custody after token
  replacement or refresh.

### Current work

- Add provider bootstrap and OAuth repair only after an owner-specific live
  probe plus durable effect/reconcile/rollback custody exists; the current
  OpenAI Codex OAuth row remains manual rather than faking that authority.
- Compose schema/config, managed dependency, and owned-service recipes through
  existing owners with rollback.
- Add reason-specific rollback-failure reconciliation and high-signal Ops
  recovery.
- Add scoped remote credential custody only after M2 establishes the remote
  trust boundary.
- Prove exact-once delegated child-to-parent wake and continuation.
- Close packaged/source/Docker/shared-host profile coverage.

### Acceptance

The complete matrix in `GOVERNED_SELF_CONFIGURATION_AND_REPAIR.md` passes with
retained, secret-free live-provider, browser secure-input, packaged-process
restart, rollback, crash, replay, and durable-continuation evidence. Until then,
public claims remain “repair foundations,” not generic self-repair parity.

## M6 - Gateway capability and policy follow-ons

### Implementation progress

- Verified Code Mode source/wrapper and adapter artifact inspection plus
  cross-run evidence comparison were already live and are now removed from the
  active backlog.
- Workspace-scoped catalog metrics now distinguish intentional
  inspectable-only capability state from a broken callable-subset invariant,
  with stable catalog hashes and per-kind counts.
- Exact-snapshot audit exports now include the catalog plus explicitly requested,
  workspace-scoped Code Mode run hashes and durable artifact references. They do
  not export artifact contents or claim a fresh byte-integrity verification.
- Production-isolation evaluation and fail-closed hostile-sandbox claim metadata
  already cover the supported and candidate native/backend postures. General
  hostile-code promotion remains proof-gated and deferred, not an implementation
  claim.
- `route_local` remains an evaluated, durable audit signal. It will not gain an
  execution seam until a real local-placement authority can enforce it without
  bypassing Gateway policy, accounting, or the remote-worker scheduler.

### Closed design boundaries

- Automatic Code Mode continuation across uncertain effect boundaries remains
  unimplemented pending a separate durable replay/authority design.
- A bundled real embedding default and a trusted-local policy/audit fast path
  remain optional, footprint- and security-sensitive portfolio decisions.

### Deferred decisions owned here

- Candidate asset-store ownership, governed parallel read-only Code Mode
  fanout, and richer imported-skill provenance.
- Krea, FAL, Novita, and SimpleX adapters. These are portfolio choices, not
  release blockers.

Capability promotion, revoke, rollback, candidate detail, and lifecycle
filtering already exist and are not M6 implementation tasks. Verified Code Mode
source/wrapper artifact inspection and run comparison across catalog, source,
wrapper, policy, permission, override, and sandbox evidence are also complete
in the Gateway and Chat workbench. Google Meet has a Gateway-owned voice/session
integration and is not a missing adapter.

Owner backlogs: `CAPABILITY_SYSTEM_BACKLOG.md`,
`PROVIDER_CHANNEL_EXPANSION_BACKLOG.md`, and `citadel_update/STATUS.md`.

## M7 - Consolidated Mission Control UX

### Implementation progress

- `MCUX-103` is complete: Integrations, Channels, Permissions, Runtime, and
  Add-ons now participate in the shared route dirty-state registry. Editors
  with local selection also require an explicit discard confirmation and keep
  active drafts across background reloads.
- `MCUX-108` is complete: the unused shared split-layout components and their
  accidental app-owned React Reflex dependency were retired.
- The reverified July polish rows for Run Detail's no-selection state,
  progressive Skills loading, capability-route framing, provider capability
  chips, measured filter overflow, reminder date input, and saved-board cost
  coverage truth are complete.
- MCUX-106 fixture implementation is complete: Projects and Approvals now seed
  real selected records, route through exact fixture identifiers, and wait for
  populated master/detail selectors.
- The remaining July layout defects are complete: Activity uses compact ages
  and readable summary tracks, Schedules use wider grid tracks, mobile section
  indexes wrap, and command-palette overflow guidance is measured.
- Projects now has distinct overview and selected-detail routes; the legacy
  agent-catalog URL focuses its catalog owner; onboarding and Mason replace
  internal state captions with operator language; Curator uses readable time
  and aligned evidence columns.
- Chat now renders one canonical approval or user-input control card in the
  composer instead of repeating the same blocked state in a second warning
  strip. Header approval navigation and execution-plan status remain because
  they expose persisted queue access and plan truth rather than duplicate the
  decision controls.
- The shared accessible identifier chip now middle-ellipsizes visible values,
  preserves the full value for assistive technology and hover inspection, and
  copies the exact identifier. Approval, user-input, selected-turn trace,
  Council seat, Journey evidence, artifact lineage, and expanded trust-policy
  identifiers use it without turning ordinary descriptive text into copy UI.
- Focused Settings and primitive proof is green. Broad accessibility, surface,
  and visual proof remains intentionally grouped with the rest of M7.

### Current work

- Integrate live HX-507 worker visibility after M4 instead of testing seeded and
  live variants in separate broad campaigns. The HX-507 Ops/Chat projections are
  wired and label registry/assignment/lease/generation/control/settlement truth
  from canonical storage, but the live-runtime fields (connection health,
  usage/cost, resource cell, artifact/effect) remain server-labeled `unavailable`
  and gain new read ports only after M4's inference/settlement routing hold lands
  and a connected worker populates those records.

### Acceptance

Run focused component tests while implementing, then populated visual stories,
accessibility smoke, surface regression, and one clean visual-regression pass.

Owner backlog: `review/mission-control-ui-ux-backlog.md` and dated frontend
review evidence.

## M8 - Mobile companion completion

### Current work

- The Gateway now has a production-dark, grant-bound push-registration and
  delivery owner in paired SQLite 195/PostgreSQL 138 storage. Raw Expo/FCM
  tokens remain only in deterministic OS-keychain custody; durable metadata,
  approval-refresh payloads, provider receipts, audit, replay, and diagnostics
  are secret-redacted. Registration/revoke, crash-gap suppression, outbox CAS,
  unknown-after-send quarantine, and custody-mismatch cleanup have focused
  proof. The production provider and scheduler remain explicitly unavailable,
  and the API reports that delivery posture instead of treating an enabled
  registration as live delivery.
- The credentialed Expo provider and outbox scheduler now exist
  production-dark. The Expo access token is config/secret-store shaped and
  ABSENT by default (`GOATCITADEL_MOBILE_PUSH_EXPO_ACCESS_TOKEN`, then the
  `mobile-push-expo` OS-keychain provider secret); with no credential the
  scheduler creates no timer and the posture stays
  `deliveryAvailability: "unavailable"` — both test-pinned. The adapter sends
  the pinned data-only/silent payload (no title/body/sound the OS could
  display before the companion app's JavaScript validates the hint),
  classifies tickets honestly (invalid token, rate-limit/5xx retry, auth
  failure unavailable, transport ambiguity unknown-after-send), and keeps raw
  FCM delivery `provider_unavailable` until its own credentialed adapter
  exists. An atomic revoke/send fence (registration row-lock plus delivery
  CAS in one immediate transaction) commits immediately before the provider
  boundary: a revocation or token rotation that committed after claim wins
  and no send happens, while a revocation racing an armed in-flight send
  leaves the running row to settle exactly once with an honest receipt —
  proven in SQLite and under live PostgreSQL for both commit orders.
- The Gateway-verifiable consumer approval-key owner now exists
  production-dark in paired SQLite 197/PostgreSQL 141 storage: one Ed25519
  device approval public key per durable companion grant, registration fenced
  on the active grant row, idempotent rotation/revoke with revision
  authority, cross-grant key reuse refused by a unique SPKI digest, and
  operator forensics retained after revoke. Signed-companion
  registration/rotation/disable, operator list/revoke, panic-off and
  device-grant-revoke projections, and versioned
  approval-decision-signature verification helpers
  (`goatcitadel.mobile-approval-decision.v1`) are in place and fail closed on
  missing/revoked keys, inactive grants, stale timestamps, and digest
  mismatches. Every registration response pins
  `verificationAvailability: "unavailable"`: the `approval_key` capability
  stays `scaffolded` until the mobile client ships its device-auth-gated
  signer under the physical-device hold.
- Full-body companion signatures still cover push tokens and rejected extra
  fields, while the retained replay/audit correlation hash uses a versioned,
  allowlisted secret-free tuple. Durable replay authority remains the
  session-scoped nonce rather than a token-derived fingerprint.
- The external mobile client now implements the Expo notification/device/task
  modules, signed token registration/rotation/revoke, a grant-and-session fence
  immediately before raw-token send, fail-closed tombstones across session or
  grant changes, refresh-only foreground/background handling, and typed opaque
  approval deep links. Final correction tip `6834a14cd` passes 49 Jest suites
  (193 passed, one skipped), lint/typecheck, Android Expo export, and npm-ci
  dry-run; a real clean install remains blocked by private-package registry
  authentication.
- Paired general companions can now read the secret-redacted pending approval
  queue and submit a request-signed rejection. Approval and edit remain
  operator-only because the current client-local biometric key is not bound to
  a Gateway-verifiable approval signature; the capability must remain
  `scaffolded` until that end-to-end key owner exists.
- Remaining M8 mobile scope: the mobile client's device-auth-gated approval
  signer against the new Gateway key owner (then the `approval_key`
  capability decision that retires `scaffolded`), live credentialed delivery
  (operator-provisioned Expo access token plus physical-device delivery
  proof), an FCM-credentialed adapter if raw FCM delivery is ever wanted,
  and any approved geofence-context work. The Gateway-side approval-key
  owner, credentialed provider/scheduler, revoke/send fence, and
  data-only/silent payload pin above are built and production-dark.
- Exercise device auth, session paging, approvals, offline/reconnect,
  attachments, and revocation against one pinned Gateway SHA (`HX-508`).
- Keep screen share, notification awareness, accessibility helper, and call
  screening outside the consumer build unless an explicit enterprise/sideload
  decision accepts their policy and OS-permission posture.

Mobile voice capture is implemented. Transcription is a separate optional
follow-on and must not keep the capture row open.

Owner contract: `MOBILE_NATIVE_CAPABILITIES_PLAN.md`; implementation and device
proof live in the adjacent `personal-ai-mobile-app` repository.

## M9 - Packaging, desktop, and deployment parity

### Current work

- Execute the clean Windows install, first launch, status, restart, stop,
  uninstall, reinstall, and single-instance journeys on the exact candidate.
  Harness ready (2026-08-11): `scripts/install-smoke/run-clean-host-smoke.ps1`
  runs the full journey as one command with a machine-readable evidence bundle
  (runbook: `scripts/install-smoke/README.md`); its read-only preflight refuses
  on any non-clean host (proven refusing on a developer machine, exit 2). The
  clean-VM execution itself remains the outstanding evidence item.
- Prove `remote_hardened` network allowlist, no loopback bypass, secure auth,
  and illegal-egress refusal.
- Exercise failed startup and broken auth/policy recovery with operator-visible
  rollback evidence.
- Include M5 packaged restart and, where claimed, M2-M4 remote-worker runtime
  posture in the same candidate campaign.
- Assemble exact installer hashes, installed version/identity, logs, traces, and
  the packaging proof bundle.

Owner checklist: `PACKAGING_DEPLOYMENT_PARITY_CHECKLIST.md` (`GC-P1-09`).

Signed public-trust release promotion additionally requires administrator-owned
GitHub tag/environment protections and signing controls. That external control
plane is not a local code task and remains fail-closed until independently
verified.

### Broad verification record (2026-08-11, merged tip 7df5584e4)

The 2026-08-09 handoff blockers are closed and the program branch merged
cleanly into `main` after a defect-free broad campaign: the final full
`verify:all` scored 592 scenarios with 10 classified non-defect failures
(3 fast-lane parallel-shard load-flakes green solo, 4 cross-platform
visual margins against freshly Linux-captured baselines, 3 tracked
pre-existing usability harness drifts unmasked by earlier fixes). The
arc eliminated the un-awaited route-port defect class (sweep plus the
`verify:gateway:async-boundary` guard), required companion request
signatures on read routes, fixed stuck-loading hook guards, re-verified
the native deterministic pins after toolchain servicing, and refreshed
all 104 mission-control visual baselines. The HX-407 sparse-repair proof
is no longer held: the owner decision recorded under M1 re-points it below
the schema-shape gate, and it now runs un-skipped. This record is broad
single-host verification evidence, not M9/M10 completion: every external
hold above remains open, and packaging artifacts must be rebuilt and
re-hashed at any SHA they are claimed for.

## M10 - Final exact-SHA certification

After M1-M9 close, build one release candidate and run every required named
lane against that exact source state. At minimum this includes runtime truth,
durable recovery, agentic proof, memory truth, realtime truth, backup,
remote-workers, self-configuration, surface, accessibility, visual, desktop,
install, auth/security, provider/channel/A2A/Code Mode lanes required by the
changed scope, and finally `pnpm verify:all`.

Also close credential- or control-plane-dependent queues with an authenticated
operator: live provider probes, GitHub AI-quality review, signing, and release
environment evidence. Record genuine environmental limitations separately from
product or harness failures.

The dated `qa_pre_qa_usability_2026-07-29` workbook is a useful campaign
checklist, but its results belong to an older SHA and are not current status.

## Deferred portfolio register

| Item | Status | Entry condition |
|---|---|---|
| Facilitated specialist review presets (`GC-P2-13`) | `deferred_decision` | Product approves a bounded Chat-native design built on existing Model Council/Assembly/delegation; no second runtime or chat surface |
| Advanced Citadel Vault keys | `deferred_decision` | Architecture for per-Chamber keys, rotation, recovery, and E2EE is approved |
| Sensitive mobile helpers | `deferred_decision` | Enterprise/sideload flavor, Play policy, OS access, consent, and audit boundaries are approved |
| Krea, FAL, Novita, SimpleX | `deferred_decision` | Provider/channel portfolio decision and the owner backlog's governance bar pass |
| Bundled real local embeddings | `deferred_decision` | Footprint, licensing, model distribution, fallback, and quality proof are approved |
| Trusted-local governance fast path | `deferred_decision` | Security design preserves deny-wins, Wards, rate limits, and durable audit |
| Cross-platform hostile-code isolation | `deferred_decision` | Platform-specific adversarial proof exists; Docker alone is insufficient |
| macOS/Linux packaging promotion | `deferred_decision` | Exact artifacts obtain the required signing/notarization/checksum/smoke evidence |

## Explicitly closed or superseded inputs

- Original parity epics `GC-P0-06`, `GC-P0-07`, `GC-P1-08`, `GC-P1-10`,
  `GC-P2-11`, and `GC-P2-12` are complete and do not belong in an active order.
- Google Meet is implemented as a governed voice/session integration; it is not
  a missing channel adapter.
- Agent fanout tool-run weighting is implemented.
- Capability candidate promotion, revoke, rollback, detail, and lifecycle
  surfaces exist; the May backlog must not reopen them generically.
- Mobile voice capture is implemented; only transcription remains optional.
- Citadel screens are shipped, and `require_dry_run` is enforced across the
  current integration/A2A side-effect owners. `route_local` remains audit-only
  until a real local-placement authority exists.
- Separate Cowork and Code primary surfaces are superseded by one Chat surface.
- Unchecked boxes in `superpowers/plans`, archived Mission Control plans, dated
  review ledgers, and blank manual-QA workbooks are not active tasks unless a
  current tranche explicitly promotes a reverified item.
