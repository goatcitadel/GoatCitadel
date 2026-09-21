# Native Windows worker capacity inventory

Status: local native inventory, mounted observation transport and retained
Gateway/worker delivery for both mounted and journal-bound host backing-file measurements.
Complete declared-inventory accounting and protected persistence are implemented.
The job/runtime owner now supports capture while holding a verified-empty job.
Installed workload-quiescence ownership, native accounting collection, hard quotas,
complete pool inventory and backend activation remain unfinished.

## Owner and authority

### Helper parent pipe continuity

`CellPipeParentEvidence` retains non-inheritable duplicates of the helper's
input, output and separate runtime pipe. All three endpoints must resolve to
the same retained OS process, creation time and unchanged primary token. The
runtime client end must have been opened by the helper itself; inherited stdio
ends may have been opened by its spawning parent. Reused pipe objects, a different
runtime peer, impersonation, process exit and disconnected stdio refuse further
use. Failure is permanent for that instance. Closing it leaves the caller's
original handles usable.

The client-identity lane covers real Node-spawned native stdio and a separate
duplex connection in normal and AddressSanitizer builds, alongside 163 native
identity assertions and the existing 121 signer-inspection checks per build.
Evidence: `.tmp/worker-parent-endpoint-native-v1.log`, retained in
`Goat Cell Controller Client Identity Kicesg`.

This is endpoint continuity evidence. Installed parent admission, current runtime
grants and mounted-journal acceptance remain separate requirements; the component
does not activate an installed runtime.

### Helper runtime request path

The production provisioning helper now handles operation 17 with a bounded
`GCRHP001` bootstrap and a separately bound runtime request. It verifies the
controller, binds separate runtime and control parent endpoints to inherited
stdio, authenticates each role once, and connects `CellRuntimeParentConnection`
to the controller client's runtime callback. The launch secret is distinct from the public pipe locator,
is sent through private stdin rather than arguments or environment, and is
erased after authentication or refusal. Runtime grants still require fresh
parent callbacks; bootstrap validation cannot launch work by itself.

`createWindowsWorkerCellProvisioning().runRuntime()` copies the admitted request
before asynchronous work, pins and launches the helper, validates all 21 retained
records and current volume authority, and waits for both runtime retention and
clean helper completion. A connection failure after retention preserves its
evidence while withholding overall success. There is no execution replay or
direct-mode fallback. The packaged helper now includes the full native runtime
dependency closure.

The helper-protocol lane passes 69 existing stream cases and twelve runtime/control
bootstrap/handshake cases in both normal and AddressSanitizer builds. It invokes
production request decoding and authentication over actual child stdio and local
pipes with controlled custody, and confirms runtime refusal without an installed
controller. Evidence: `.tmp/worker-control-parent-native-v1.log`, retained in
`Goat Cell Helper Protocol E0M4eW`. This verifies
source composition and transport; this proof alone does not establish installed
controller execution, mounted-journal execution or live Gateway runtime admission.
The production helper builds reproducibly for x64 and ARM64 using the actual
packaging source list (`.tmp/worker-control-parent-helper-build-v1.log`,
`Goat Runtime Helper Build 4RRBk0`); ARM64 execution is not claimed.

Controller runtime setup and final receipts now use five-second per-message
deadlines within the admitted overall runtime deadline. Runtime dispatch keeps
its original deadline, and the low-level ten-minute I/O ceiling is unchanged.
The protocol lane passes 19 runtime handoff cases in normal and AddressSanitizer
builds, including controlled 600,000 ms, 600,001 ms and 24-hour budgets. A 24-hour
budget also reaches the real controller's mounted-journal refusal and completes
its bounded receipt. Evidence: `.tmp/worker-runtime-deadline-native-v1.log`,
retained in `Goat Cell Controller Protocol zBhwDr`. These are immediate protocol
checks with long budgets; no 24-hour workload, mounted execution or installed
service acceptance was performed.

### Independent runtime control channel

`CellRuntimeControlChannel` carries fresh input and delivery challenges over a
separate authenticated pipe. It never reads or writes the runtime stream, so an
outstanding runtime-authority reply or terminal-result transfer cannot be consumed
by a nested input/delivery check. The outer owner must authenticate and retain both
endpoints; the adapter rejects aliased handles and never opens an endpoint itself.

Messages 37/38 carry a fixed 1,168-byte request and exact reply. They bind the
runtime nonce, request digest, 21-record journal head, fresh ordinal and action.
Input additionally carries its exact binary stream frame. An unchanged staged
frame may request a new grant for another queue attempt; altered repeats, skipped
sequences, excess bytes and input after delivery are rejected. Every valid request
crosses current protected-owner callbacks. Delivery has a distinct action, requires
input EOF, and does not stand in for workload admission or individual tool approval.
File authorization uses action 3 on this same channel, after input EOF and the
start of delivery. Its 1,060-byte body binds the retained result digest, work and
file identities, logical/allocation counts, a per-file ceiling and an exact UTF-8
logical path; unused bytes must be zero. It has a separate owner callback and
never falls back to ordinary delivery permission. The helper forwards that
challenge to its authenticated parent. The Node parent independently derives the
selection from its retained terminal result before calling the file owner, with
peer checks on both sides of that call. Missing ownership, changed metadata or
revocation refuses the grant. This does not supply the installed Gateway's
file-disclosure policy or publish an artifact.
Each exchange is bounded to five seconds within the admitted lifetime. Any failure
permanently fences that channel without retrying I/O or cancelling borrowed events.

The runtime-transfer lane passes in normal and AddressSanitizer builds with 612
authority assertions over 99 authority/control pipe fixtures, including 66 new
control fixtures. These cover exact binary input, fresh grants for repeated queue
attempts, changed repeats, revoked input/delivery, altered replies, malformed
requests, aliases, cancellation, reentrancy and a 24-hour budget. Pending bytes in
both runtime directions remain unchanged across control checks. Existing transfer,
dispatch and native-to-Node stream checks also pass. Evidence:
`.tmp/worker-runtime-control-native-v2.log`, retained in
`Goat Runtime Transfer SgNm9i`.

`WindowsRuntimeParentStreams.reauthorizeInput()` supplies the parent-side exact
issued-frame check. It calls current input authority again without polling the
source, advancing the stream or sending another ACK. Stale or changed frames and
concurrent next-input polls fence both paths. Output may continue while the
independent input check is pending. The worker's focused stream, parent-session
and helper suites pass 96 tests, including the fast-peer case where a control
check arrives before the input write callback resolves; worker typecheck passes.
Evidence: `.tmp/worker-runtime-control-worker-v1.log` and
`.tmp/worker-runtime-control-typecheck-v1.log`.

The protected parent now creates two private endpoints before launching the
helper. The control name has a fixed `.control` suffix; its `GCRPC001/002` hello
cannot be substituted for the runtime `GCRPA001/002` hello. Both authenticate
before the session starts. Native custody repeats the stdio/process/token checks,
requires both endpoints to have the same retained parent process, rejects aliases,
and serializes those custody checks. Secret copies are wiped after each exchange.

`WindowsRuntimeParentSession.runControl()` owns the separate control reader.
It shares cancellation and failure with the runtime reader, reauthorizes only
the last issued input, waits for actual output-consumer completion before delivery,
and uses one canonical delivery ordinal sequence across both pipes. Control checks
continue during maximum-sized result retention. Successful finish joins the
control reader; denied or lost control cannot turn an already retained result
into a successful completion or trigger execution replay.

Verification includes 312 focused worker tests and a later 53-test parent/dual-pipe
run, plus worker typecheck. Three tests use two actual local named pipes and the
production parent session, covering completion, control loss and revocation after
retention. Their request/result and authority callbacks are controlled fixtures;
no workload runs. Evidence: `.tmp/worker-control-parent-worker-v1.log`,
`.tmp/worker-control-parent-focused-v2.log`, and
`.tmp/worker-control-parent-typecheck-v4.log`.

`CellRuntimeControlEndpoint` creates a separate, exclusive local controller pipe
with the fixed installed-service ACL. A fresh random locator and the retained
request nonce/digest/journal head travel over the already authenticated runtime
pipe. The secondary hello and welcome must echo that exact binding. Both ends
repeatedly bind the secondary peer to the retained primary process through
`VerifyBoundPipe`, including live process-object, creation-time and PID checks.
The endpoint owns its additional handle and evidence; it borrows the original
runtime pipe and cancellation event. Setup is a single five-second attempt
within the runtime deadline. Failed verification or repeated setup fences future
access without closing an exposed handle before its caller cancels and joins
pending I/O. Explicit close releases only the secondary endpoint.

Normal and AddressSanitizer endpoint cases use real private pipes and retained
OS process evidence with controlled primary admission and a test-user ACL.
They cover mismatched bindings, wrong message kinds, denied peer admission,
reentry, cancellation, caller mutation, long budgets, repeated setup, handle
lifetime and an actual different server process. A successful handshake carries
an exact-input control exchange while leaving the original pipe usable. This
does not establish the positive installed-service custody path.
The runtime-transfer lane passes 730 authority assertions across 122
authority/control/endpoint pipe fixtures in each normal and AddressSanitizer
build. Evidence: `.tmp/worker-controller-control-endpoint-native-v4.log`, retained
in `Goat Runtime Transfer bIbqtp`. The fixture also preserves the existing
request-transfer, dispatch-refusal and native-to-Node stream checks.

`CellRuntimeHelperForwardingSession` connects that secondary endpoint and forwards
exact-input and delivery challenges to the separately authenticated parent
control pipe. Primary runtime, stream and retention messages keep their existing
pipe and owner. The helper binds the controller's new endpoint through installed
`VerifyBoundPipe`; its original peer guard continues checking both parent pipes.
The forwarding owner serializes custody checks, uses a private cancellation event
and joins its own control and deadline threads before releasing the endpoint.
Malformed replies, lost control or revoked custody cancel the primary session.
Neither the borrowed stop event nor another process is signalled by this owner.

Returning from the runtime call does not finish the parent session. Forwarding
stays active through the controller's validated outer receipt, because receipt
of retained-result acknowledgement is followed by another delivery check.
Only then does the helper join the forwarder and send the parent's finish
message. Pending control bytes at that boundary refuse completion; an uncertain
retention or failed finish never replays execution.

The runtime-session verification lane includes eight four-pipe forwarding
scenarios. Normal and AddressSanitizer builds each pass 83 assertions, including
an authorization check deliberately delayed until after the helper runtime call
returns. The tests also cover exact repeated input, a 24-hour overall budget,
revocation after retention, cancellation, altered replies, lost parent control
and reentrant custody. Primary admission, parent permission/retention, controller
traffic and terminal job metadata are controlled; these cases run no workload.
Evidence: `.tmp/worker-helper-forwarding-native-v1.log`, retained in
`Goat Runtime Forwarding 47fUKs`.

Canonical live admission and controller listener activation remain unfinished.
Installed execution and durable local retention of the controller's outcome
after failed delivery are not established by this transport proof.

### Controller-local attempt and outcome retention

`CellRuntimeLocalOutcome` creates an exclusive, nonce-named `.runtime` file in
the original journal's protected host control directory. It flushes and reads
back an attempt record before dispatch. A later writer cannot reuse that nonce,
including when the first process exited with only an intent or partial outcome.
Recovery is read-only; it does not truncate evidence, repair records or replay
execution. Files have strict size and allocation ceilings, exact file security,
single-link/default-stream checks and pinned directory/file identity.

The intent binds the request digest, journal anchor and head, assignment and
profile. After dispatch joins, retention appends the canonical native result and
a complete-record integrity hash, flushes it, and verifies its readback before
remote delivery. Raw output buffers are excluded. If the native result cannot
be encoded, a diagnostic-only outcome preserves the encoding error, execution
error and observed job error/process ID without claiming canonical success.
Recovered inventory must belong to the same assignment and profile.

Local retention rechecks the original journal bytes, lifetime, file identity and
host-directory custody. It does not depend on a still-connected worker, an
unrevoked runtime grant or the journal remaining healthy for further execution.
Loss of local custody still refuses the append and preserves the uncertain file.
The session exposes separate local-intent, local-outcome and remote-retention
flags. Intent failure prevents launch; outcome persistence failure withholds
remote completion. Exception unwinding joins owned threads before attempting to
retain an already-started outcome.

Normal and AddressSanitizer file fixtures each pass 106 assertions, including
full 20,000-entry inventory persistence/recovery, duplicate nonce refusal,
interrupted attempts, deterministic corruption, host-custody loss, reentrancy,
diagnostic-only outcomes and raw-output exclusion. Evidence:
`.tmp/worker-local-outcome-results-v5.log`, retained in
`Goat Local Outcome uZeNR2`. These use real protected temporary NTFS directories
with controlled journal/admission metadata through a private test port; the
production entry separately refuses an absent original journal.

The session lane separately passes 271 assertions across 25 sessions and 16
actual AppContainer fixture jobs in each normal and AddressSanitizer build.
Controlled persistence callbacks verify the dispatch/retention ordering,
retention after cancellation and failed remote delivery, refusal to launch when
intent persistence fails, and withheld remote completion when outcome persistence
fails. Evidence: `.tmp/worker-local-outcome-session-v1.log`, retained in
`Goat Runtime Session UGyitk`. Journal/runtime-bundle admission and canonical
callbacks remain controlled in those job cases.

Positive mounted-journal recovery, installed listener acceptance, complete pool
accounting/reservation for these files, retention lifecycle and live Gateway
acceptance remain unfinished. This file-store proof performs no service,
physical drive, formatting, attachment or workload operation.

### Controller listener runtime composition

The controller service source now supplies its operation-17 runtime owner through
`CellRuntimeControllerConnection`. It creates the secondary endpoint with the
fixed installed-service ACL and binds the helper to the already retained primary
process through `VerifyBoundPipe`. Custody checks are serialized. The runtime
session keeps request admission on the primary pipe and sends fresh exact-input
and delivery challenges over the secondary pipe. Native request limits still
apply inside the session; the independent control transport also enforces its
hard input ceiling.

The connection retains that endpoint after the runtime call returns. The outer
protocol sends its receipt and waits for the helper's finish acknowledgement;
the helper completes its parent-side finish before acknowledging. Only then can
the service release the secondary endpoint and its primary peer. A runtime or
permission error remains distinct from lost endpoint custody, allowing an
authenticated failure receipt when the peer remains available. No error retries
the job or signals another owner's cancellation event.

The outer completion gate now requires both local persistence flags as well as
joined dispatch, completed output and protected remote retention. Remote
retention cannot substitute for the original attempt or its local outcome.
This is source composition, not proof of installed-service execution. Positive
mounted-journal acceptance, live canonical admission, complete accounting and
backend activation remain separate requirements.

The composed-session lane passes 387 assertions in each normal and
AddressSanitizer build across 33 sessions, eight controller connections and 23
actual AppContainer fixture jobs. It checks authenticated endpoint continuity
after runtime return, the outer finish boundary, local persistence requirements,
revocation, cancellation, peer loss and delivery refusal. Primary OS evidence is
real; secondary test ACLs, canonical callbacks, journal/bundle dispatch and
persistence callbacks remain controlled. The running-revocation fixture now
withholds input until the explicit denial rather than depending on a delay.
Evidence: `.tmp/worker-controller-listener-session-v3.log`, retained in
`Goat Runtime Session REUgPD`. The helper's eight forwarding scenarios also pass
83 assertions per build against the same production source snapshot, retained
in `Goat Runtime Forwarding Bu6gBy`; that case passed in the mixed v2 run before
the separate session timing fixture was corrected and rerun.

The service-protocol lane passes 14,990 assertions per normal/AddressSanitizer
build over 122 controller and 109 native-client sessions. Both interactive
launch forms are refused. Its journal, checkpoint, authority and runtime-handoff
fixtures perform no physical attachment, formatting, protection or mounting.
Evidence: `.tmp/worker-controller-listener-protocol-v1.log`, retained in
`Goat Cell Controller Protocol zjIQ0c`.

### Shared native request preparation

`@goatcitadel/contracts/remote-worker-runtime-node` now owns the Node-only
`GCRUN001` and `GCSTDIO2` encoders. Existing worker imports delegate to that
subpath. It is not exported from the browser-safe contracts root. Gateway
admission can use the same format without importing worker application code.

`prepareWindowsRuntimeDispatch` derives an immutable result expectation from
the same copied request used to encode the executable bytes. The projection
contains nonce, request/checkpoint/bundle digests and result limits; it excludes
commands, environment and raw output. Getters, proxies, cycles and unexpected
fields are rejected before serialization. The returned Buffer remains mutable:
transport must call `bindWindowsRuntimeDispatch` against its independently
retained binding after asynchronous authority checks to obtain a checked copy.
Preparation grants no approval and writes no runtime state.

The existing 935-byte request and digest remain unchanged. Focused contracts
and worker tests pass 73 and 168 cases, and package structure tests pass 31.
The native helper handshake fixture now consumes the derived expectation and
records the shared source and build hashes in its evidence. These checks do not
establish installed dispatch or canonical live admission. The protected Gateway
request producer and complete native collector remain required.

### Atomic runtime admission storage

`Storage.remoteWorkerRuntimeAdmissions.admitPreparedForAssignment` joins the
existing complete-inventory capacity owner, cell state owner and immutable
result-expectation owner in one database transaction. It requires a fresh ready
native cell, the exact runtime bundle and journal head, current capacity,
execution, cleanup and backup revisions, and current protected assignment
authority. Active or unresolved backup states cannot start work.

Admission also requires the complete executable request. A normalized copy must
produce exactly the independently supplied expectation; changing the command
while retaining its earlier approval digest is refused. Inside the transaction,
the original journal identity and prepared digest, all five mounted workspace
identities, owner/controller SIDs, job/AppContainer names and launch directories
must agree with canonical history and platform state. Process, memory, CPU,
wall-time, output and diagnostic limits cannot exceed the immutable reservation.
A self-consistent request and projection cannot override those canonical checks.
Only metadata is retained; the command and environment are not written to storage.
Preparation and admission also require the profile's immutable environment-name
digest to match the native policy. The explicit launch environment may contain
only `SystemRoot`, `TEMP`, and `TMP` (Windows case-insensitive names); subsets are
allowed. Extra names such as `NODE_OPTIONS`, `PATH`, or credential variables are
refused before a candidate or starting transition is produced. This checks the
name allowlist, not installed-host provenance of the supplied values.

Accepted capacity commits the inventory, its high-water evidence, the cell's
starting transition and the exact expectation together. Rejection starts
nothing. Quarantine retains its capacity evidence without creating a runtime
expectation; later captures cannot erase the retained high-water violation.
Authority and cell state are rechecked after the writes. A failed write or
intervening revocation, lease renewal, cleanup, backup or execution transition
rolls back the entire accepted attempt. A second admission of a starting cell
is refused even with fresh revisions; uncertain responses require reconciliation,
not another dispatch.

This is an internal storage commit boundary, not a worker approval endpoint.
Its independent expectation and complete inventory must come from the trusted
request and collection owners. It does not approve arbitrary executable bytes, manufacture
native collection or activate the backend. No schema migration is added.

Admission also requires a retained `remote_worker.native_runtime` approval.
The transaction locks that approval before assignment authority and checks its
approved status, danger-or-higher risk, operator resolution, database-clock
expiry, explicit workspace/task/Chat/durable-run links, exact request expectation,
assignment generation, profile and all four cell revisions. These checks repeat
before commit. Generic approval resolution cannot edit this kind's payload or
merge its linkage; a changed request requires a new review. Capacity changes,
including quarantine evidence, invalidate the earlier revision-bound review.
This guard does not select a launch, create an approval, bypass current policy,
or dispatch a process. Those execution-owner handoffs remain uncomposed.

### Gateway request preparation

`createRemoteWorkerExecutionOwners` now composes `nativeRuntimeRequests` for the
governed Gateway owner. It is separate from the worker settlement protocol and
has no dispatch or approval RPC. The producer snapshots the launch and scan
configuration before awaiting storage, respects cancellation on both sides of
the read, and rejects changed configuration or inconsistent response bindings.

The storage preparation method reads current protected assignment and complete
journal authority in one transaction. It supplies a fresh random nonce and the
canonical journal identity, prepared digest and mounted head, then applies the
same canonical workspace, platform and limit checks used by admission. Its
response is explicitly `review_required`, with a candidate expectation and the
current cell revisions. Repeated preparation produces distinct candidates and
does not insert an expectation, record capacity or start a cell. Starting or
revoked cells cannot prepare another candidate.

Preparation also returns a metadata-only `approvalDraft` for the existing
approval lifecycle. Its task, workspace, Chat and durable-run links come from
the protected assignment manifest. The payload binds the candidate nonce and
request expectation, assignment generation, profile and current cell revisions.
The Gateway checks these bindings and projects only the draft's explicit fields;
it does not propagate an approval ID, resolved status, command or environment
from the response. Producing a draft does not create or resolve an approval.
The operator-only approval replay path now attaches a matching in-memory review
after retained replay/event work. Gateway execution owners are reused for that
process lifetime. The cache permits at most 32 retained/in-flight reviews and
4 MiB of serialized request content; expiry bounds access to five minutes and
expired entries are removed on reads/writes. Restart, expiry or mismatched
approval scope/bindings yields unavailable context, without reconstructing a
command or preventing access to retained approval history. Public response
redaction still applies.

The canonical approval panel displays the executable, command, working directory,
environment and execution limits. Missing context or a mismatched request digest
disables its approve control while preserving rejection. No new browser storage
or fetch path is introduced. Focused page tests and desktop/mobile component
browser proof cover these states; this is not installed-worker dispatch proof.

The internal producer's `requestReview` now submits its draft through the real
Gateway approval lifecycle with a database-owned five-minute expiry. Its creation
hook locks the pending approval and rechecks the protected assignment, complete
journal, cell readiness/revisions, request binding, environment policy and
explicit execution links in the approval transaction. A stale candidate aborts
creation. It creates no runtime expectation or starting transition. Cancellation
before commit refuses the handoff; cancellation after commit preserves the
returned decision, including a policy-generated rejection. A lost response must
be reconciled rather than blindly creating another review.

`admitReviewed` now selects its executable request and expectation from that
private review context, not from admission-call fields. It snapshots the trusted
capacity capture before reading the canonical approval and checks the reviewed
assignment and revisions. Only a currently approved, matching review enters the
existing atomic storage admission owner. An attempt is consumed before that
commit call: concurrent calls, rejected/quarantined captures and uncertain
responses cannot automatically reuse it. A cancelled committed admission remains
visible as `admitted_cancelled` and returns no executable request. Accepted reply
metadata must match the reviewed request and the expected starting transition.
This is storage admission, not process launch or a substitute for fresh dispatch
policy and native authorization checks.

`selectAdmittedForAssignment` provides the internal workload handoff from that
same bounded private context. Only a confirmed, non-cancelled admission becomes
selectable. Selection requires exactly one retained candidate for the registry,
assignment and generation, then rechecks the canonical native authorization
repository with the current protected lease. It compares the returned expectation
and checks that the same unexpired candidate remains after the asynchronous read.
Restart, expired context, foreign scope, changed expectations and revoked
authority withhold executable bytes; selection never reconstructs or re-admits
a request. Repeated selection repeats authorization and grants no permission
to replay native execution.

The protected settlement protocol now exposes `runtime.request.page` through
that same process-lifetime producer. It returns at most 32 KiB of canonical
request JSON per page, within the existing 256 KiB envelope ceiling, and caps the
complete request at 4 MiB. Every page rechecks current canonical admission.
Only page zero may discover the request; later pages must bind its admitted
nonce and execution digest. Replies also bind the assignment, current lease,
fresh challenge, total size and complete JSON digest. Commands and environment
stay ephemeral; this transport does not write them to worker or Gateway storage.

The worker downloads under a held current lease, with five-second page deadlines
and a sixty-second overall ceiling. It verifies contiguous bytes, UTF-8, JSON
digest, strict native request shape and the independently returned execution
expectation before returning a request. No partial response or changed metadata
permits helper entry. The installed entry point's `selectAdmitted: true` path
uses this download, then refreshes and compares the mounted history under the
same lease before entering the existing driver. Supplying executable fields
alongside selection is refused. Connected-worker offer routing and native
collection remain separate unfinished work.

Request delivery passes 16 contract tests, 94 Gateway tests (including the
worker-client/Gateway-adapter integration), and 42 worker entry-point/dispatch
tests. Evidence: `.tmp/runtime-request-pages-contracts-v1.log`,
`.tmp/runtime-request-pages-gateway-v2.log`,
`.tmp/runtime-request-pages-worker-v4.log`. Four-package typecheck passed in
`.tmp/runtime-request-pages-typecheck-v3.log`. These are controlled adapters,
not live installed execution or a physical-volume acceptance run.
The named authentication matrix passed in
`artifacts/verification/2026-09-15T06-14-58-930Z-auth-matrix-19095bbe`;
the async-boundary lane passed with 1,008 production files scanned in
`.tmp/runtime-request-pages-async-v1.log`.

The producer and execution-owner focused suite passes 72 tests in
`.tmp/native-workload-selection-tests-v1.log`, including unavailable-before-
admission, current-lease rechecks, restart, expiry during lookup, changed scope,
revocation, cancellation and unsuccessful admission outcomes. Storage and Gateway
typechecks pass in `.tmp/native-workload-selection-typecheck-v1.log`.

The worker controller's `runRuntime` now accepts that structured request plus
the independently admitted expectation. It uses the shared encoder and compares
every expectation field before helper pinning, pipe setup or spawning. Changed
commands, bundle identities, journal bindings and input/output/inventory limits
refuse before transport. The request is captured before asynchronous custody
checks; subsequent caller mutation cannot replace the launch. This is covered
by mocked controller protocol tests, not installed-service execution proof.

Native reviews preserve the original execution run in immutable linkage while
`approvalWaitRuns` owns a separate wait-run identity for each review. This matters
because the wait ledger has a unique run-ID constraint: multiple reviews cannot
reserve their shared execution parent as the wait run. Reservation and deferred
materialization require the existing parent, refuse parent-as-wait records, and
verify that any reused wait belongs to the exact approval. Lifecycle priming does
not rewrite native parent linkage to the separate wait ID. A real SQLite lifecycle
test creates two reviews for one parent and rematerializes through new service
instances without replacing the parent or creating duplicate wait runs.
Linked Chat wake routing requires the review's explicit parent run and native
action binding to match the trace.

The parent Chat approval reader now discovers native reviews through the persisted
wait ledger using the exact assignment generation, workspace, task, parent run,
session and turn. It refuses ambiguous unresolved reviews and rechecks approval
and trace ownership before retaining the inline approval and waiting trace. The
existing Chat stream/finalizer owns the subsequent durable pause. A decision
resolved before the first pause remains visible until its wait is settled;
discovery does not depend on the in-memory executable cache. SQLite and PostgreSQL
lookup fixtures and Gateway pause tests cover these paths. Native lease handoff,
resume admission and dispatch still require their execution-owner connection.

The native approval-wait wake now carries the explicit parent run/turn binding
and defers completion until that approval's exact linked Chat wake effect has
completed. It rechecks the canonical approval and wait reservation before
checking the dependency. Missing, pending or failed parent wakes leave the review
discoverable; completing the separate wait early cannot hide a decision before
the parent's first pause. A real SQLite effect test covers the early-decision
ordering and a new processor reading the retained parent completion. This is
effect-ordering proof, not native lease renewal or execution proof.

Native approval and rejection wakes now use a distinct retained resume record.
It binds the assignment generation, canonical parent/checkpoint, prior lease,
resolved approval and native request-binding digest without inventing a tool
intent or pending tool action. The existing durable wake transaction writes the
record and queues the parent together. Parent-claim recovery retains a separate
native binding record and rejects substituted approval data before appending.
The worker renewal reader accepts these native records without tool state.
Real SQLite Gateway tests cover both decisions, first parent binding, two
successive parent recoveries, and rollback after request substitution. This
does not prove the dispatch transport.

The protected storage lease tests now cover both native decisions on SQLite and
PostgreSQL. They verify atomic wake rollback, the first resumed parent and two
subsequent parent claims, expiry followed by lease rotation, rejection of missing
protected authority, wrong credentials and stale tokens, and idempotent renewal
without returning a new lease secret. The original native resume digest remains
stable across recoveries. These tests use controlled waiting seals and parent
claims; they do not launch a native process or exercise the installed transport.

For Chat-linked requests, the Gateway's reviewed admission owner now reads the
canonical resume through the current protected worker lease before submitting
capacity admission. It requires the native resume schema, exact approval id,
approval snapshot digest and request-binding digest. It rechecks cancellation,
review expiry and single-attempt ownership after that asynchronous read. Focused
Gateway tests cover missing or substituted resume records and concurrent readers.
The storage admission transaction repeats the native resume check before and
after capacity, execution-state and expectation writes. SQLite and PostgreSQL
resume fixtures exercise the shared guard with real parent and lease records:
queued or unrotated continuations fail, approved rotated continuations pass,
rejected decisions cannot admit a launch, and substituted approvals or requests
fail. Mounted inventory/admission rollback tests remain a separate proof lane;
these fixtures do not establish a complete native launch journey.

`runWindowsWorkerGatewayRuntime` composes an admitted structured request with the
native provisioning driver's runtime entry point. It captures the exact lease,
history and request before entering that driver and supplies the protected
Gateway result uploader to the helper's private session. Direct sessions use
the same retention owner. Scope or request mismatches and pre-launch cancellation
fail before driver entry; launch and upload failures are never retried here.
Composition tests use a controlled driver/uploader, alongside the existing
private-session and helper protocol tests. The installed workload selector has
not yet been connected to this entry point.

The trusted transport composition may supply the installed owner's current-lease
callback for long-running work. Before result upload, retention captures that
lease and reads the provisioning snapshot through the protected Gateway route.
Assignment scope and generation must remain exact, the lease revision cannot go
backwards, and the complete native history must match apart from lease revision.
Cancellation, failed lookup or changed history withholds upload without launching
again. Worker tests cover this renewal path with controlled route responses;
live installed renewal during native execution remains unverified.

`runWindowsWorkerAssignmentRuntime` now owns the installed execution lifetime.
It shares protected-key validation, lease/control checks, expiry cancellation and
joining of in-flight renewals with cell startup. Before runtime driver creation,
it reads installed controller custody and verifies refreshed Gateway history
against the admitted history. It uses controller-service dispatch, preserves
request-specific authorization ports, renews during quiet execution, and supplies
the latest lease for result retention. Provisioning remains a separate entry
point. Controlled-driver tests cover initial refusals, quiet renewal, revocation
cancellation and cleanup; existing provisioning tests cover the shared-lifecycle
extraction. This does not enable a workload selector or prove an installed launch.

Result upload holds a freshly renewed lease across its history lookup and page
transfer, so this execution owner's background renewal cannot invalidate pages
mid-transfer. Renewal resumes after release; the original expiry timer and
cancellation signal remain active throughout. A transfer that exceeds its lease
still fails and needs result reconciliation, never workload replay. Tests cover
both successful release and expiry during a held transfer, with no subsequent
renewal after the execution owner closes.

Before runtime driver entry, dispatch performs the existing protected result
lookup for the exact admitted nonce and request digest. A retained receipt is
returned without entering the launch path. A failed or cancelled lookup prevents
dispatch. A missing result is not evidence that no launch occurred: the native
helper must still reject a previously recorded launch intent. Worker composition
and result-client tests cover receipt recovery and failure without automatic
launch or upload retries.

SQLite v240 / PostgreSQL v185 add a nullable approval reference to retained
runtime expectations. Canonical native admission writes its exact approval id
in the same transaction as capacity admission and expectation retention. Exact
replay must preserve that id; the existing immutable-evidence guards also protect
the new column. Older expectations remain null, with no inferred approval or
data backfill. Rollback disables the new producer while retaining the additive
column and evidence. This association is groundwork for request-specific Gateway
authorization, not an execution grant by itself. Migration and admission checks
use isolated databases; production-sized upgrade acceptance remains separate.

The retained-result repository now has an internal request-specific authorization
check. It reads the immutable approval association before locking the canonical
approval, protected credential, mesh, assignment and cell. It requires the exact
request digest, current approved decision and database-clock expiry, manifest
links, native profile, unchanged admission revisions and complete mounted
history. Chat-linked work also requires its exact canonical resumed parent.
Legacy expectations with no associated approval refuse both phases. Both phases
permit the admitted starting-to-running transition; execution also requires no
retained result. Neither check reserves a launch or establishes
that an absent result means the command never ran. The helper's one-attempt
intent ledger remains required.

The protected settlement protocol now carries `runtime.authorize`. Each bounded
request includes the admitted nonce/digest, execution or delivery phase, and a
fresh random challenge. It accepts no worker-authored approval id, decision,
expectation or executable input. The Gateway derives protected authority through
the existing signed route and reads the canonical repository on every call.
The worker verifies the complete returned expectation, assignment, current lease,
phase and challenge within five seconds; stale replies and interrupted calls
cannot be reused or retried automatically. The installed runtime entry point
composes this check with its existing policy callbacks for execution, delivery
and retention, holding the renewed lease through each request. This does not
replace peer custody, per-input policy or the native one-attempt ledger.

Focused transport proof passes 9 contract tests, 80 Gateway tests and 50 worker
tests, including signed-request rejection, forged fields, earlier-receipt replay,
deadline/cancellation refusal, exact expectation binding, policy failure and
the three installed-owner callback phases. Evidence is retained in
`.tmp/runtime-auth-transport-contracts-v1.log`,
`.tmp/runtime-auth-transport-gateway-v2.log` and
`.tmp/runtime-auth-transport-worker-v3.log`; all four affected package typechecks
pass in `.tmp/runtime-auth-transport-typecheck-v3.log`. These tests use controlled
transport/native adapters and do not establish live installed execution.
The named authentication matrix passed in
`artifacts/verification/2026-09-15T05-54-38-112Z-auth-matrix-f30e9889`, and
`verify:gateway:async-boundary` passed with 1,007 production files scanned
(`.tmp/runtime-auth-transport-async-v1.log`).

The final authorization checks pass in all three protected-authority fixtures
on each database: `.tmp/runtime-authorization-tests-v3.log` (SQLite) and
`.tmp/runtime-authorization-postgres-tests-v2.log` (PostgreSQL). They cover exact
request and lease bindings, approval rejection/expiry/substitution, cleanup and
backup transitions, continued running authority, terminal-state refusal and
retained-failure replay prevention. Each mutation is rolled back in the isolated
fixture and the original authority is checked again. Storage typecheck passed
in `.tmp/runtime-authorization-typecheck-v3.log`.

The combined worker implementation passed the complete remote-worker Vitest
suite on September 14: 1,053 tests across 54 files with two test workers. Source
hashes matched the saved pre-suite snapshot afterward. Evidence is retained in
`.tmp/runtime-composed-worker-tests-v1.log`. This covers the worker package's
test scope, including controlled native adapters; it is not installed-service,
physical-volume or live-provider acceptance. The post-recovery storage, worker
and Gateway typechecks passed in `.tmp/runtime-approval-binding-typecheck-v3.log`.
The full named migration-parity lane also passed in
`.tmp/runtime-authorization-migration-parity-v1.log`.

Connected-worker offer routing still needs connection to this native entry
point. A candidate expectation is not an approval. Complete native collection, live dispatch and
installed-service acceptance remain required.

### Canonical native outcome read

The protected `runtime.outcome.read` exchange returns bounded retained exit,
error, byte-count and verification facts for an exact nonce and request digest.
It checks current assignment authority for both the receipt lookup and decoded
result read, then requires their immutable receipt fields to agree. Missing
records stay explicitly absent. Commands, environment, raw output and inventory
paths are not included. The exchange grants no retry or Chat completion authority.

The worker binds every read to a fresh challenge and current held lease, uses a
five-second deadline, and checks counts against its independent expectation.
Installed startup now requires the canonical outcome to match its exact retained
receipt before returning. Nonzero exit codes remain visible as facts; they are
not converted into successful Chat turns. A failed read never relaunches work.

Local proof: 17 contract cases, 97 Gateway cases including signed protocol and
worker-client integration, and 25 startup cases pass in
`.tmp/runtime-outcome-contracts-v1.log`, `.tmp/runtime-outcome-gateway-v2.log`
and `.tmp/runtime-outcome-startup-v1.log`. Four-package typecheck passes in
`.tmp/runtime-outcome-typecheck-v2.log`. These use controlled retained results
and do not establish installed execution, connected-worker native routing or
end-to-end Chat continuation.

### Connected-worker native continuation routing

Assignment workloads now include a bounded `nativeContinuation` only when their
canonical current-generation resume ledger identifies a native decision. Its
approval and native binding hashes must still match the canonical approval, and
the continuation is covered by the workload identity hash. Ordinary Chat
workloads keep their existing identity shape.

The connected worker checks that route before entering inference. Approved
routes require a trusted native continuation owner and protected key custody;
missing composition reports `native_runtime_owner`. Rejections never enter that
owner. Returning from the owner reports `native_parent_continuation`, not Chat
completion. The foreground process does not automatically retry either unresolved
native state. Gateway inference, tool-sequence reconstruction and artifact
verification also refuse the pending native route.

Thirty worker checks and nine Gateway checks pass in
`.tmp/native-continuation-worker-v2.log` and
`.tmp/native-continuation-gateway-v2.log`. Real SQLite and temporary PostgreSQL
each pass approval and rejection across three parent/lease recovery cycles in
`.tmp/native-continuation-sqlite-v2.log` and
`.tmp/native-continuation-postgres-tests-v2.log`. The owned PostgreSQL process
was stopped. Ordinary SQLite offer/replay/rollback proof also passes in
`.tmp/native-continuation-chat-offers-v1.log`.

This connects routing to the trusted host port and prevents model fallback.
`createWindowsWorkerNativeContinuation` now connects that port to installed
runtime startup. It requires protected Windows custody, resolves the trusted
peer/input/output policy owner, reads existing provisioning history, and selects
the admitted request without entering provisioning operations. Recorded outcome
facts remain separate from parent Chat completion.

Each request page can carry the exact approved continuation. Gateway selection
requires the matching private review, native binding hash and current canonical
resume record after execution authorization. Changed approval, decision,
generation, binding or resume hashes withhold executable bytes; the client also
refuses a removed or substituted continuation in any reply. The installed path
preserves this binding through its held-lease download.

This handoff passes 48 worker cases, 135 Gateway cases and 17 contract cases in
`.tmp/native-bound-selection-worker-v1.log`,
`.tmp/native-bound-selection-gateway-v1.log` and
`.tmp/native-bound-selection-contracts-v1.log`. Four-package typecheck passes in
`.tmp/native-bound-selection-typecheck-v1.log`.

Canonical parent consumption of retained native outcomes and complete installed
policy/collection composition remain unfinished. No host configuration enables
this port by default. These controlled tests do not establish native installed
execution or end-to-end Chat completion.

### Parent-side retained result inspection

`readForChatContinuation` reads the immutable native result for an already
authorized Chat parent. It requires the current assignment generation, exact
durable run, canonical native resume, approval decision/hash and native binding.
Recorded results must retain the same admitting approval and expectation, then
decode against all original native history records and their plan/checkpoint
hashes. It rechecks the parent/decision binding before returning.

This internal read does not require or recreate a live worker lease. The Chat
owner remains responsible for its canonical write fence when consuming the
snapshot. Missing results remain pending; rejection is distinct from successful
execution. Reading either state creates no admission or completion evidence.
The method is not exposed through the worker RPC.

Nine controlled snapshot/real binary decoder checks pass in
`.tmp/native-parent-read-decoder-v1.log`. Real SQLite and temporary PostgreSQL
each pass approved/rejected parent binding across recovery, including missing
result and foreign parent/generation/resume refusal, in
`.tmp/native-parent-read-sqlite-v1.log` and
`.tmp/native-parent-read-postgres-tests-v2.log`. The owned PostgreSQL process
was stopped. Four-package typecheck passes in
`.tmp/native-parent-read-typecheck-v1.log`. The later controlled native-result
Chat acceptance below covers canonical output and settlement consumption.

### Native facts in resumed Chat

The retained parent reader now projects a bounded `nativeChatContext`. Approved
work needs verified binding, bundle, workspace, quiescence, drained output,
capture and inventory evidence; approval alone leaves it pending. Rejection
provides a decision with no execution result. Native exit codes remain literal,
including nonzero exits. Raw process output and inventory paths are not model
context.

The protected worker refreshes its workload after native execution and uses the
same normalized context and inference identity as the Gateway. Existing retained
context skips native relaunch. A distinct model sequence prevents replaying an
answer generated before the native facts existed. Parent usage collection includes
all canonically attributed assignment attempts, preserving uncertain dispatches
and refusing incomplete or foreign usage rather than publishing partial totals.

Earlier model history is reconstructed from a bounded, assignment-scoped request
inventory. Each original request body/hash, frame chain, context/profile/worker
binding and model/tool step must verify. Prior native decision boundaries remain
in that history; unresolved tools, missing/branched steps and uncertain inference
stay unavailable. The protected workload owner rechecks the original active
lease/workload after asynchronous projection. The worker verifies the projected
history as part of its workload identity, while the Gateway independently
reconstructs the expected input and final response.

The original 16-step limit applies across native boundaries. Earlier root usage
IDs travel with the workload and remain in final accounting. The final allowed
model step cannot start tools requiring another model step. Installed
policy/collection composition and installed-machine acceptance remain unfinished;
source composition is not installed acceptance.

Focused evidence: `.tmp/native-chat-usage-parent-tests-v1.log` covers 11 SQLite
resume and controlled retained-result checks; `.tmp/native-chat-usage-postgres-tests-v2.log`
covers approved/rejected PostgreSQL recovery plus SQLite/PostgreSQL usage attribution.
The native input/usage Gateway checks are in
`.tmp/native-chat-history-gateway-tests-v1.log`; cross-dialect sequence-history
checks are in `.tmp/native-chat-history-postgres-tests-v2.log`.
These are isolated tests, not live provider or installed-machine acceptance.

History reconstruction and the worker/Gateway input/final-output round trip pass
in `.tmp/native-chat-history-roundtrip-v1.log` (14 tests across two files).
Worker continuation/inference/step-limit checks pass in
`.tmp/native-chat-history-worker-v1.log` (29 tests). SQLite/PostgreSQL bounded
request inventory checks are in `.tmp/native-chat-reconstruction-postgres-tests-v2.log`.
The round trip uses controlled authoritative records and real request/frame
hashes; it does not launch a native executable or call a provider.

### Controlled native-result Chat acceptance

`remote-worker-native-chat-acceptance.test.ts` now carries a controlled nonzero
native result through real SQLite approval, parent wake, protected lease rotation,
native admission/result repositories, Gateway-governed inference, worker artifact
construction, CAS verification, assignment settlement and durable Chat completion.
The provider transport is replaced with a deterministic response; there is no
provider network call or spend. Native journal/result bytes are constructed
fixtures, not an installed execution claim.

The case rejects altered artifact bytes, replays inference and settlement without
another provider attempt, records the canonical assistant and durable result once,
then closes/reopens the database and replays the same completed Chat chunks.
It passes in `.tmp/native-chat-acceptance-v7.log`. The shared real-database retained
result case passes on SQLite in `.tmp/native-chat-result-sqlite-v1.log` and on
temporary PostgreSQL in `.tmp/native-chat-result-postgres-tests-v2.log`.
The final shared-fixture PostgreSQL regression passes all three retained-result
and approved/rejected resume cases in
`.tmp/native-chat-result-final-postgres-tests-v2.log`; its owned cluster is stopped.
The acceptance case is included in the `verify:remote-workers` Gateway check.
The integrated run at `artifacts/verification/2026-09-15T08-10-39-005Z-remote-workers-13200921`
remains failed: it exposed stale approval-error assertions, test contention,
lint findings and an expired 240-second PostgreSQL runner budget. Its 23
spawned-worker recovery cases passed. The owned PostgreSQL cluster stopped.

After correcting the assertions and lint findings, transport validation moved
unchanged into `remote-worker-assignment-execution-transport.ts`. Gateway and
worker checks now use four test workers without increasing test timeouts or
dropping suites. The bounded retries pass 882 Gateway tests across 45 files and
1,109 worker tests across 57 files in
`.tmp/native-integrated-remote-workers.gateway-bounded-v1.log` and
`.tmp/native-integrated-remote-workers.worker-runtime-bounded-v1.log`.
Typechecks pass in `.tmp/native-integrated-repairs-typecheck-v1.log`.
The complete lint target set passes across 532 files in nine chunks
(`.tmp/native-integrated-full-eslint-1-v2.log` through
`.tmp/native-integrated-full-eslint-9-v2.log`). Equivalent character-code checks
replace control-character regexes in three native wire validators; 41 contract
tests pass in `.tmp/native-runtime-control-contracts-v1.log`, including every
ASCII control character in both scope identifiers.
The full registered PostgreSQL owner suite passes 103 tests with no failures,
cancellations or skips in `.tmp/native-postgres-full-postgres-tests-v2.log`.
It took 23 minutes on an isolated loopback cluster, which stopped cleanly.
The runner uses a three-minute default test timeout and an independent
thirty-minute whole-process ceiling; the expanded migration/recovery suite
outgrew the old aggregate limit. Final typechecks pass in
`.tmp/native-wire-final-typecheck-v1.log`. The Gateway async-boundary lane also
passes across 1,012 production files in
`.tmp/native-integrated-repairs-async-boundary-v1.log`.
These retries do not make the original integrated artifact green.

### Capture inside the owned job lifetime

`RunBoundedJob` accepts an optional trusted `JobQuiescenceObserver`. After all
processes exit and both output pipes drain, it retains the exact private job and
launch-directory pins while invoking the observer. `JobQuiescence` cannot be
constructed or copied by a caller, and exposes no job handle. Its borrowed scope
is valid only inside the callback. It rechecks canonical authority, cancellation,
the capture deadline and the exact job's zero-process count.

`ObserveDirectoryInventory` scans the independently pinned launch directory and
repeats those checks throughout the native reader. This is launch-directory
evidence, not a complete cell or pool inventory. The observer must discard all
provisional output; the runner invokes that cleanup before launch and on capture
failure. Publication requires `quiescent_capture_verified` after the final check.
Capture failure and physical job cleanup remain separate result fields; the
runner re-queries the exact job before reporting cleanup after a failed capture.

`RunVerifiedRuntimeJob` keeps the admitted runtime bundle pinned through capture.
When a protected workspace reference is present, it also checks the exact root
identities and descriptors at every capture authority boundary. Preflight and
final workspace failures discard provisional output. Missing observer callbacks
or an invalid capture deadline refuse before launching a process.

Inside that callback, `JobQuiescence::CellBinding()` provides a borrowed binding
for `CellProvisioningJournal::ObserveMountedInventory`. The journal freezes the
callback and context before invoking caller code and supplies its independently
decoded cell name and mounted guest work identity. The job requires both to match
its admitted launch, then checks current authority and the exact empty job.
Each inventory guard repeats the binding and journal checks. An explicit empty
binding, mismatch, revocation or journal lifetime drift withholds the inventory.
The binding is valid only for the live capture callback; the runner's final
check still gates publication. Omitting the binding retains the trusted caller's
existing responsibility to establish quiescence separately.

`CellJournalRuntimeRunner::Run` composes this with the verified runtime runner.
It freezes the admitted runtime command, journal anchor/head, scan limits and
canonical authority callbacks. Before launch, and around each canonical
authorization, it requires the same journal lifetime, complete native mounted
custody, exact cell/principals and all recorded guest roots. Capture passes the
borrowed job binding to the journal reader. The inventory stays private until
the job's final capture check and the runtime's protected-workspace check pass.
A valid inventory remains distinguishable from a workload's nonzero exit code.

The same capture now measures the original host backing file and journal after
the guest inventory, under the retained empty job and the remaining capture
deadline. Host allocation stays separate from guest allocation. Both observations
must match the journal anchor/head, assignment and profile, and both remain
provisional until final runtime checks pass. A partial read, binding mismatch,
revocation or cancellation discards both observations.

`pnpm verify:remote-worker:windows-cell-job` passes 6,149 assertions in each normal
and AddressSanitizer build (`.tmp/native-paired-collection-job-v1.log`; native
receipts in `%TEMP%\Goat Worker Cell Job AiUtO1`).
The paired-capture tests control the journal/backing boundary while exercising
the real stopped job and guest tree scan. Attachment, layout, formatting, root
protection and mounting flags are false. This proves local paired collection.
Whole-pool collection and installed mounted-volume acceptance remain separate.
The runner requires a protected workspace and never provisions or repairs one.

The terminal `GCRRS001` result can retain the paired backing counts using flag
bit 15 and four little-endian u64 values at header offsets 220, 228, 236 and 244:
VHDX file bytes, VHDX allocated bytes, journal bytes and journal allocated bytes.
The remaining four header bytes stay reserved. This does not increase the wire
or database size limit. Historical results keep zero reserved bytes and their
original digests, and decode with `backing: null`.

The flag requires verified guest inventory and its bound checkpoint. The native
codec rejects incomplete capture, inconsistent counts and unsafe totals; the
parent decoder also checks the retained disk plan's virtual and reserved sizes.
The host allocated total is the two allocated counts added together. Guest
allocation remains separate; these counts do not establish complete pool usage,
quota enforcement or independent host identities. Host identities still belong
to the independently retained journal history. Local outcome retention, native
pipe delivery and Gateway result storage preserve the exact encoded bytes.

Paired-result verification on 2026-09-15 passes 53 contract tests, 34 worker
transport tests and the controlled Gateway Chat acceptance test, including
database close/reopen with the same backing counts and digest. Gateway and
worker typechecks, focused lint and docs checks pass. Native result proof has
106 local-outcome checks and 160 result/pipe checks per normal/AddressSanitizer
build; stopped-job proof retains its 6,149 checks. The isolated native-to-Node
retention retry passes 11 cases per build with the paired maximum-size result.
An earlier concurrent retention run failed its parent-success acknowledgment
assertion after native receipt. A controlled early-close case now reproduces
that signature: the native callback has its receipt, but the Node owner's final
check observes a closed endpoint and reports uncertainty. The fixture previously
released its native endpoint immediately after the receipt. It now joins both
callback owners before closing either successful endpoint, using its stdout
completion report and bounded pipe-close wait. Production authorization and
protocol behavior are unchanged. Delayed final checks succeed with the endpoint
held open; deliberate premature closure still fails without losing the committed
result or authorizing replay. The corrected lane passes 13 cases per build
(`.tmp/native-retention-owner-join-v2.log`; receipts in
`%TEMP%\Goat Native Retention ZQ28Pk`).
Per-case state and logs are retained before assertions. Earlier paired logs are
`.tmp/native-backing-result-{contracts-v1,worker-v1,chat-v1,typecheck-v2,native-v2,job-v1,retention-v2}.log`;
the failed run remains `.tmp/native-backing-result-retention-v1.log`.

`RunCellRuntimeDispatch` adds an exact-byte boundary in front of that runner.
The trusted owner supplies an independently retained connection nonce and SHA256
digest. The `GCRUN001` envelope binds the journal anchor/head, capture limits and
complete protected runtime configuration, including command, environment, bundle,
root identities and job limits. A changed byte or connection refuses before any
journal read, canonical callback or launch. The worker encoder prepares these
bytes and a separate transport check returns an independently copied buffer.
Computing or matching this digest is not authorization: native journal custody
and current canonical admission are still required. The dispatch format accepts
the native job's longer deadline; the local stdio helper retains 25 seconds.
Requests with an explicit local file-collection plan use `GCRUN002`. Its nested
configuration length still covers only `GCSTDIO2`; a `GCFPLAN1` trailer contains
three LE32 values (path count, per-file bytes, total bytes), followed by LE32
length-prefixed UTF-8 paths. Selection is limited to 64 relative work paths,
512 UTF-8 bytes per path, 1 MiB per file and 64 MiB total; the original overall
dispatch-size bound remains unchanged. The existing request digest covers the
entire trailer, and legacy requests retain byte-identical `GCRUN001` encoding.
The Gateway's ephemeral approval review shows the paths and ceilings. Storage
preserves that copied plan through exact-request admission; native dispatch
uses it for pinned staging and rejects an external selector override. This
authorizes local collection only. Installed file-transfer negotiation,
disclosure and artifact publication still require their separate owners.
`GCFSL001` carries the subsequent path-to-identity handoff: an 8-byte magic,
32-byte nonce, 32-byte request digest, 32-byte canonical result digest, LE32
count and one 24-byte file identity per approved path, in that plan's order.
The record is bounded to 1,644 bytes. The native encoder requires matching
staged labels/content; native and shared decoders derive file accounting from
retained terminal inventory and enforce distinct regular-file identities and
the approved ceilings. The mapping must arrive through authenticated native
custody. It is not a signature, ancestry proof or disclosure grant. Installing
the codec alone does not supply installed disclosure policy.

The native controller/client session owners now have an explicit per-file
delivery callback. A collection request without that owner refuses before
dispatch. After terminal-result retention, `CellRuntimeFileBatchTransfer`
exchanges the bounded selection record and each `GCRFA001` content record in
approved order. `GCFSA001` and `GCFSD001` are 40-byte selection/complete receipts:
their 8-byte magic is followed by SHA256 of the exact selection record. They
acknowledge integrity-checked local receipt, not publication or durability.
The sender freezes records before callbacks; both peers recheck connection and
per-file authority around content I/O. Cancellation, denial, reentry, malformed
receipt or incomplete transfer withholds the receiver's entire batch. Terminal
metadata already retained remains distinct from failed file delivery. The
native helper now forwards the complete batch to its protected Node parent,
using independently repeated file grants. Upstream control exchanges and reply
inspection share one lock, so a reply to the helper's local file check cannot
be mistaken for unsolicited controller traffic. A refused destination wipes
helper content and withholds completion without repeating terminal retention.

`WindowsRuntimeFileBatchReceiver` checks the same manifest, per-file frames,
native content hashes and complete receipts against the independently admitted
plan and retained terminal inventory. The parent dispatcher holds the complete
batch privately, rejects missing or duplicate delivery, and permits the outer
finish only after all files pass. Failure clears accumulated content. Its
retention adapter permits only the explicitly bounded next manifest, at most
1,644 bytes, instead of widening standalone retention to arbitrary tail data.

The provisioning driver derives that plan from the exact admitted request and
requires separate file authorization and consumption owners before helper setup.
It invokes the consumer only after the exact helper exits cleanly, its outer
receipt matches, and current custody is checked; borrowed content is wiped on
either consumer success or failure. Protected startup still needs the Gateway
disclosure and artifact settlement owners. A retained terminal result alone
cannot resolve file settlement or reopen execution. Collection approval is
never substituted for a disclosure grant.
`CellControllerRuntimeAuthority::Run` now joins the bounded request transfer,
fresh digest-bound approval exchange and this native dispatch entry. Its
104-byte controller challenge binds the connection nonce, increasing ordinal,
21-checkpoint count, journal head and complete request digest. The client
requires a separate current canonical workload-admission callback; provisioning
approval cannot answer this challenge. Both endpoints recheck peer custody and
fence their instance after failure. Each exchange has a five-second I/O deadline
within the owning runtime deadline. No approval is cached across challenges.

The journal runner supplies `JobQuiescenceObserver::authorize_execution` in
addition to capture authority. The launcher checks it immediately before process
creation and before resuming the verified suspended child, then schedules fresh
checks at 250 ms intervals while the entry process runs. Authorization callbacks
are bounded by the outer owner; cancellation and wall time are rechecked after
each callback. Revocation terminates and joins only the exact retained job.
The protected runtime revalidates workspace custody at these execution checks.
The bounded stream adapters now connect `JobStdioChannel` to distinct input,
stdout and stderr frames. Every frame binds the runtime nonce/digest, per-stream
sequence, cumulative byte count and explicit EOF. A frame carries at most 976
binary bytes; input and combined output stay within the independently retained
job limits. Wrong direction, order, totals, padding or data after EOF fence the
stream. Both output streams must end independently.

Input keeps at most one pending frame outside the native channel. A full queue
withholds its acknowledgment until that same staged frame is accepted. This
acknowledgment reports channel acceptance, not child consumption or tool success.
An uncertain job cleanup cannot generate successful output EOF. The raw streams
remain ephemeral and require the normal Gateway sanitization before diagnostic
persistence. Stream framing itself does not authorize input/tool effects.

`CellControllerRuntimeChannel` serializes stream I/O and fresh runtime approval
on one pipe. While an approval exchange waits, it can admit pending input and
drain output. Each queue attempt requires separate current input admission;
the fixed exchange deadline also bounds that callback's eventual publication.
Late admission cannot enqueue bytes or emit an ACK. An unsolicited approval,
reentrant callback or transport failure permanently fences the channel. The
owner table is copied at construction, and the channel never signals its
borrowed cancellation event. Its surrounding owner must cancel and join the
exact job before releasing any borrowed pipe, channel or callback lifetime.

`CellRuntimeResultTransfer` provides a separate terminal exchange after the
stream owner ends both output streams and joins the native dispatch. Its bounded
encoding preserves exit status, native cleanup/capture checks, usage counters,
runtime bundle verification and the complete declared inventory. It excludes
raw output prefix/tail buffers. Inventory requires final capture, bundle and
protected-workspace verification, the admitted anchor/head/root identities, and
valid ordered object counts and totals; a nonzero workload exit stays separate.

The transfer binds the request nonce/digest and hashes the entire result under
its own domain. Fixed 4096-byte chunks have exact offsets and lengths. Current
delivery authority and cancellation/deadline checks surround I/O; incomplete,
substituted, revoked or expired data never reaches the result consumer. The
first ACK means validated receipt only. A distinct `GCRTA003` acknowledgment
attests exact protected retention after a separate committer returns the saved
result digest and current authority still passes. Neither ACK proves effect
success or grants replay permission. Each endpoint is one-shot, including after
failed or ambiguous delivery; an uncertain commit requires recovery lookup.

`CellRuntimeSession` now composes request transfer, the original journal runtime
dispatch, serialized authority/streams, native thread join and terminal receipt.
It copies the expected request binding/head and callback table before caller
code runs. A private event and monitor forward external cancellation or the
overall deadline to the exact job. Internal failures never signal the caller's
borrowed stop event. Every dispatch thread is joined before borrowed resources
are released, including error unwinding. Completed or failed sessions cannot
be reused. A missing original journal refuses before launch.

Terminal delivery additionally requires both output EOFs, completed input,
no pending input frame and exact agreement between stream and native job byte
counts. It uses separate current delivery permission after the job has joined.
Preflight failures or incomplete streams remain local failure outcomes; the
surrounding connection owner must close the pipe on any session error, rather
than retrying or manufacturing terminal success.

`CellRuntimeClientSession` owns the worker side of that connection. It freezes
the admitted request and callbacks, supplies bounded nonblocking input with one
outstanding exact ACK, validates output ordering/EOF, handles fresh workload
challenges and checks final stream/native byte counts before retention. Missing
input, output, workload, delivery or retention owners refuse before sending the
request. Raw output stays ephemeral. Private cancellation never signals the
caller event. The controller session now requires the distinct retention ACK;
validated receipt, retention confirmation and receipt transmission are separate
states. The retained result becomes a client outcome only after all these gates.

`RemoteWorkerRuntimeResultRepository` now retains the authorized request's
digest and non-secret limits before dispatch, then validates `GCRRS001` results
against that expectation and all twenty-one journal records. SQLite v238 and
PostgreSQL v183 add immutable expectation/result tables. Writes share the
assignment, credential, mesh, lease and cell fences; exact nonce lookup recovers
a committed result without executing the request again. The worker cannot
create an expectation through a public submission. This internal storage owner
does not authorize commands or advance cell execution/cleanup state.

The protected assignment-settlement route now accepts `runtime.result.page`
and `runtime.result.lookup`. A complete result uses at most 31 pages of 32 KiB,
within the existing RPC limits. SQLite v239 and PostgreSQL v184 add bounded
staging; incomplete prefixes are transport data, never execution evidence.
Changed leases or execution revisions require staging to restart at offset zero.
Only complete validation and an immutable commit produce a retained receipt.
The worker validates the terminal bytes before upload, checks each exact page
acknowledgment, and exposes lookup after an uncertain response without rerunning
the workload or automatically retrying delivery.

The contract, worker and Gateway suites pass 139 tests. Isolated SQLite and
PostgreSQL retention/page tests pass all 12 worker/mesh/parent revocation
scenarios, including cancellation during staging/commit, restart recovery,
20,000 objects, and immutable replay. Typecheck, migration parity and the
Gateway async-boundary lane pass. Evidence:
`.tmp/worker-runtime-result-pages-postgres-v1.log`,
`.tmp/worker-runtime-result-pages-contracts-v1.log`,
`.tmp/worker-runtime-result-pages-worker-v1.log`, and
`.tmp/worker-runtime-result-pages-gateway-v1.log`. No user database was migrated.

`CellRuntimeResultPipeCommitter` now supplies the native client's retention
callback. It forwards frozen canonical metadata on a separate borrowed parent
pipe and returns a digest only after both validation and retention receipts.
It rejects controller-pipe aliases, changed bindings/digests and repeated
attempts. `WindowsRuntimeResultRetentionParent` independently validates the
complete result, bounds asynchronous authority/commit work, and withholds the
saved receipt on refusal, cancellation or uncertainty. Its production factory
uses the protected Gateway uploader; credentials stay in the parent.

The outer owner must authenticate and hold both borrowed pipe lifetimes and
provide current custody/delivery authority. The adapters do not open endpoints
or create dispatch permission. Controller operation 17 now carries a separate
128-byte connection/request/head binding after the complete recovery history.
The controller reopens the original journal, emits all twenty-one verified
records and rechecks canonical authority before an explicit same-pipe runtime
handoff. Both sides require their own runtime owner and distinct retained-result
state before a successful terminal receipt. The binding and ready message do
not grant workload, input or delivery permission.

`CellRuntimeParentAuthority` forwards fresh request/head-bound challenges over
a distinct protected-parent pipe. Runtime admission and result delivery have
separate message kinds and ordinal sequences; a controller handle alias,
replayed reply, changed binding, cancellation or revocation fences the bridge.
`WindowsRuntimeParentAuthority` validates the independently retained twenty-one
checkpoints and routes each challenge to its specific current authority owner.
It bounds asynchronous approval and reply work and rejects late or reentrant
approval. These adapters still require the authenticated outer dispatcher and
canonical admission owners; neither endpoint custody nor a volume check grants
workload execution.

`CellRuntimeParentStreams` now supplies bounded parent input polls and output
forwarding. Each 88-byte poll binds the request, next input sequence, current
total and a fresh poll ordinal. Its 1148-byte reply distinguishes idle, data
and EOF; idle releases no bytes and does not advance the input sequence. Output
receipts bind both the stream kind and its 80-byte header. The matching
`WindowsRuntimeParentStreams` handler obtains permission for the exact input
bytes and awaits the output consumer before replying. Both sides enforce
sequence/EOF and byte limits and refuse replay after an uncertain exchange.
The parent must return idle promptly when no input is available and sanitize
output before diagnostic persistence. These callbacks do not establish child
consumption, tool effects or completion. All parent adapters require one outer
owner to serialize callbacks and retain the authenticated pipe lifetime.

`CellRuntimeParentConnection` now composes those native callbacks with one
failure state and phase checks. `WindowsRuntimeParentSession` owns the exclusive
parent reader, routes requests to their specific authority/stream owners and
hands terminal metadata to retention only after admitted runtime and stream
completion. It verifies result counters against the observed streams before
storage. Post-retention delivery checks remain available until an explicit
100-byte request/digest/length finish handshake completes. Retention success
and finish success remain distinct on cancellation or denial. The Gateway
factory supplies the existing protected uploader. Standalone retention still
rejects trailing bytes; only this dispatcher opts into one bounded subsequent
control frame.

The helper and controller source now compose their runtime owners as described
above. Live Gateway admission and installed mounted-session acceptance remain open.
The actual controller refuses the unmounted journal fixture before dispatch.
Controlled server/runtime replies exercise the production client's successful
handoff and rejection cases without bypassing that native reopen. The local
session fixtures control journal/
bundle dispatch and canonical callbacks while executing real AppContainer jobs;
they do not prove an installed session over an actual mounted journal.

The controller source dispatches through the composed workload/capture lifetime.
These APIs neither infer quiescence from a missing job name nor activate the
controller observers, mount a drive, enforce quotas or certify the storage pool.
Installed execution must still prove full accounting and protected delivery.
Blocking native calls
and authority callbacks also require the owner's outer process watchdog.

`apps/remote-worker-windows-cell-native/src/cell_capacity.cpp` provides the following
read-only operations:

- `ScanCellDirectoryFootprint` receives an already admitted directory handle and
  an independently recorded 64-bit volume identity plus 128-bit file identity.
  It checks the original handle, opens the exact object by ID, and opens each
  descendant relative to its verified parent. It never chooses a drive, follows
  a host path to adopt a replacement, or creates, deletes or repairs an object.
- `ScanCellWorkspaceFootprint` uses `CellWorkspaceDirectories` to verify all
  recorded roots and their protected security descriptors before reading, after
  every caller authority check, and after the final inventory. It scans the
  parent root once, including control/runtime/work, without adding overlapping
  subtree totals.
- `ScanCellDirectoryInventory` and `ScanCellWorkspaceInventory` use those same
  readers and authority/security checks to return every verified object identity,
  its file/directory kind, logical bytes and allocated bytes. The result includes
  the root, zero-byte files and directory allocations, is sorted by volume/file
  identity, and contains no paths or filenames. Entry output is bounded to 20,000
  objects and is published only after complete readback; failures clear entries
  and totals together. Root identity is copied before clearing a reused output.
  These local APIs do not change the aggregate operation-14/15 wire records or
  create an installed capture/quiescence owner.
- `ScanCellCapacityAreas` enumerates thirteen independently admitted, disjoint
  NTFS roots in the footprint-category order. Every area requires a real root,
  including empty areas; it never invents absence evidence. The 20,000-object
  ceiling and 60-second maximum apply across the combined capture. All object
  handles stay held until every area has been scanned and a final joint metadata
  and membership readback has completed. No authority callback runs after that
  readback starts. Duplicate identities, nested roots, partial coverage, late
  revocation/cancellation and changes to an earlier area clear the full output.
  This is a native directory collection primitive, not installed pool coverage:
  the installed owner still must bind the actual area layout, quiesce all shared
  writers, combine journal-backed VHDX/guest measurements and CAS references,
  and deliver the resulting complete capacity inventory to admission.
  The named capacity lane passes 1,420 checks per normal/AddressSanitizer build
  and compiles for ARM64 (`.tmp/native-capacity-areas-v4.log`; native receipts in
  `%TEMP%\Goat Cell Capacity e0cLlh`). Tests use actual
  temporary NTFS trees and verify that an early area's file remains pinned
  through the last authority callback. No volume or installed-service operation
  is exercised.
- `CellCapacityLayout` opens host-area roots against a separately retained
  assignment/profile and ordered identity record. It pins each root's NTFS
  ancestry, requires the exact controller-owned descriptor, and rechecks root
  identities and ACLs before and after every authority callback and after the
  combined scan. Scan deadlines include these checks. Relabeling, substitution,
  reentrant capture, closing during authorization, or weakened ACLs withhold all
  observations. It never creates or repairs roots and does not adopt current
  identities. Mutable guest roots still use the journal owner. Installed record
  production, coverage selection and native admission delivery remain to be
  connected; this class does not assert that an installation covers every area.
  The capacity lane passes 1,517 checks in normal and AddressSanitizer builds
  and compiles for ARM64 (`.tmp/native-capacity-layout-v2.log`; receipts in
  `%TEMP%\Goat Cell Capacity 7oR9sG`). Protection tests
  create their own temporary directories with ACLs applied at creation.
- `CellMountedWorkspace::ObserveFootprint` and `ObserveInventory` bind those reads to their exact
  acknowledged workspace checkpoints, original volume and mount, frozen
  controller security, and protected host directories. It verifies the mounted
  boundary after each caller authority callback and before publishing output.
- `CellProvisioningJournal::ObserveMountedFootprint` and `ObserveMountedInventory` require an independently
  retained journal anchor and final checkpoint digest. It validates all
  twenty-one records and returns the assignment/profile bindings, recorded
  workspace identities and footprint together. It rechecks the held journal
  around authority callbacks and after the mounted reader finishes; a changed
  assignment, profile, disk specification, identity, checkpoint or owner cannot
  relabel the earlier reading. Both reads retain the journal lifetime revision;
  a close/reopen cannot preserve authority by reusing earlier values. Inventory
  publication also requires unique ordered object identities on the recorded
  volume, all four workspace roots, matching byte/count totals and a maximum of
  20,000 entries. Missing mounted owners remain unavailable. The inventory APIs
  are owner calls; operation 16 transports their object records separately from
  the aggregate observations in operations 14/15.

The caller must establish workload quiescence and retain canonical authority.
These reads do not authorize execution. The caller must also supply a process
watchdog for a blocking OS call or authority callback. The scanner's own fixed
deadline and cancellation checks are cooperative, including time spent in a
callback; the callback cannot widen the frozen entry/depth/time bounds.
The mounted and journal wrappers keep that same cooperative time budget through
their own verification. They run no caller callback after the reader's final
tree readback. The canonical consumer must recheck authority before using the
observation, and serialize the owner throughout the call. These inventory APIs
do not themselves establish workload quiescence.

## Per-object inventory transport

Read-only operation 16 retains the complete twenty-one-record history, trusted
local principals, current authority and bounded deadline used by capacity
observations. An absent `observe_inventory` owner refuses dispatch before opening
the parent. The installed service does not yet supply a quiescence/capture owner.

Controller message 17 carries the 352-byte bound summary; message 18 carries a
fixed 1,000-byte batch containing the connection nonce, first object index,
count and up to twenty 48-byte object records. Reserved and unused bytes must
be zero. Entries are strictly ordered, unique, on the recorded volume and
consistent with every recorded workspace root and summary total. At most
20,000 objects and 1,000 batches are accepted; missing, repeated, reordered,
cross-connection or extra batches cannot publish an inventory.

The native client delivers the complete inventory only after a successful
terminal receipt. The helper forwards the summary and batches as private stream
frames 8/9. `observeInventory` on the Windows worker verifies the native history,
exact batch encoding and totals using the shared contracts decoder, then waits
for the receipt, clean helper exit and final current-authority checks before
returning immutable records. The existing aggregate paths keep their encoding.

This transports one mounted tree. It does not establish a complete thirteen-area
inventory, installed collection, workload quiescence, quotas or backend activation.
The separate bounded page exchange now submits validated captures to the Gateway. See
[per-object transport evidence](COMPARISON_IMPLEMENTATION_STATUS.md#per-object-native-inventory-transport).

## Observation transport

Controller operation 14 is read-only and accepts the existing 256-byte request
plus the complete independently retained creation, volume, format, protection,
mount and workspace histories. Operations 1-12 keep their existing encoding;
operation 13 remains reserved. Observation is bounded to 60 seconds, 20,000
entries and 64 levels. The controller requires a composed quiescence owner and
returns unavailable before opening the parent when that owner is absent. The
installed service does not yet supply it.

The 352-byte capacity frame carries the connection nonce, journal anchor,
assignment/profile hashes, final checkpoint hash, all five recorded workspace
identities, footprint root and separate logical/allocation/file/directory counts.
The client compares every identity with the independently validated native
history and trusted local principals. It withholds the observation until the
entire history, current-authority exchange and successful terminal receipt pass.
Malformed, early, repeated, substituted or incomplete responses cannot publish
capacity. Caller-owned request data and the callback table are frozen before
the first authorization callback.

Local identity/native guards run at each scan boundary. Remote read-authority
checks run at most once per 250 milliseconds during the scan, with an additional
forced check before the controller sends its observation. These cached checks
never authorize effects, and the original 256-challenge limit remains in force.

The helper forwards the result as frame 6 and retains the existing terminal
receipt. `createWindowsWorkerCellProvisioning().observeCapacity` keeps input open
for read-authority challenges and accepts at most 33,507 output bytes. It checks
the complete canonical history again, joins the exact helper process, requires
a successful receipt and clean exit, and rechecks canonical and local authority
before returning immutable counts with their receipt and assignment scope.
An unavailable or failed exchange returns no observation. Accounting/admission
consumption and installed quiescence remain separate work.

## Gateway persistence and worker delivery

The portable contract decoder validates the exact native bytes against all
twenty-one independently retained records. It is shared by the worker and
Gateway. The protected assignment settlement route accepts `cell.capacity.snapshot`
and `cell.capacity.observation`; neither is a provisioning acknowledgement.
The current credential, mesh admission, assignment generation and lease remain
authoritative through the database transaction and successful replay. The
original provisioning claim is retained identity, so its expiry does not prevent
a later observation under a still-current assignment. Changed cell ownership,
cleanup, profile or native history cannot reuse the old reading.

SQLite 233 and PostgreSQL 178 add immutable observation rows with the native
frame, terminal receipt, connection nonce, plan/profile/checkpoint identities,
revision, original assignment lease revision and database timestamp. A new
observation compares the expected revision. An identical retry acknowledges its
original row even after newer observations; different bytes or a changed
expected revision under the same nonce conflict. Missing observation is `null`,
never zero usage. This table does not change cell readiness, complete-capacity
high-water values, reservations or admission. Rollback disables the producer and
retains the additive evidence table; there is no destructive down migration.

`observeAndRecordWorkerCellCapacityOnConnection` composes the native observation
port, worker durable state and protected RPC client. Each RPC reads the current
lease from the existing assignment owner. The coordinator retains the validated
native receipt before sending and the canonical acknowledgement afterward.
Response loss, cancellation and local acknowledgement-write failure preserve the
pending bytes for exact replay without another scan. Retained state contains no
lease token or protected credential. Concurrent local observation owners and
late authorization callbacks are rejected.

This delivery entry point is not an automatic installed observer. The installed
controller still lacks a workload-quiescence owner and refuses operation 14.
The protected executor must establish that boundary before calling the observer.
Whole-pool accounting, hard quotas, backend activation and physical mounted-volume
acceptance remain open. See the separate
[persistence evidence](COMPARISON_IMPLEMENTATION_STATUS.md#retained-native-capacity-observations).

## Host backing-file allocation

`CellVirtualDiskFile::ObserveCapacity` reports the original VHDX file's length
and allocation after checking its recorded control/backing identities, fixed-disk
specification, current security and authority. Caller-owned records and callbacks
are frozen before use. Changed file metadata, cancellation, deadline expiry and
closing/reopening the same owner withhold all output. The attachment wrapper
uses the retained original file and separately verifies attachment identity;
its attached success path still requires physical acceptance.

`CellProvisioningJournal::ObserveBackingFootprint` joins that measurement with
the journal's actual length/allocation. It requires an independently retained
anchor and final digest, either a complete five-record creation history or a
complete twenty-one-record mounted workspace, and fresh native verification.
The result preserves assignment/profile bindings and the two distinct host-file
identities. The backing reader's final readback is followed only by local
verification, never another caller authority callback. Both layers require
serialized workload quiescence and an outer process watchdog.

The host-file total charges the VHDX and journal once. Allocation inside the
guest NTFS volume is a separate measurement and must not be added to the VHDX
charge. Host directory/volume metadata, other retained roots, sidecars, backups
and publication owners still require complete pool inventory. Host measurements
have their own operation 15 and fixed frame; operation 14 and its retained storage
remain mounted-tree observations. Host persistence is implemented below;
complete accounting consumption remains unfinished.

`pnpm verify:remote-worker:windows-cell-backing-capacity` passes 83 assertions in
each normal and AddressSanitizer build, with independent Windows allocation
queries, both authority-boundary permission failures and unchanged VHDX hashes.
ARM64 compiles but is not executed. The named native job lane passes 4,992
assertions per build, including 2,430 journal checks and the new joined accounting
cases. Those cases use actual unattached VHDX files and ordinary temporary
directories; attachment, binding and formatting flags are false. See
[backing-file evidence](COMPARISON_IMPLEMENTATION_STATUS.md#journal-bound-host-backing-capacity).

## Host backing observation transport

Read-only operation 15 requires all twenty-one independently retained records,
the trusted local principals and the original 256-byte request. Operation 13
remains reserved; operation 14 retains its encoding. The new controller message
16 has exactly 424 bytes: nonce, journal anchor, prepared/assignment/profile/head
digests, host parent and four workspace identities, disk GUID and reserved/virtual
sizes, control/backing identities, VHDX length/allocation, journal length/allocation
and their host-file allocation sum. Every identity and disk field must match
the complete validated history. The journal is exactly 21,504 bytes and its
allocation is bounded to 64 KiB; fixed VHDX allocation must fit its reservation.

The controller requires a distinct quiescence-owning backing observer. The
installed service supplies neither observer and refuses either operation before
opening the parent. Host observation shares the 60-second deadline and at most
256 current-authority challenges. The client rejects mixed observation kinds,
duplicates, altered history, observations before authority and missing or failed
terminal receipts. The helper forwards the validated host frame as kind 7;
the worker publishes `observeBackingCapacity` results only after the successful
receipt, clean helper exit and final current-authority checks. The maximum helper
output is 33,579 bytes. Partial or failed streams return no usable observation.

The portable shared contract decodes the same raw bytes for worker and future
Gateway consumers. Host fields have distinct names and never include guest-tree
allocation. This is transport evidence, not an installed observer, retained host
accounting row, hard quota or execution-readiness signal.

Fresh normal/AddressSanitizer controller runs each pass 2,407 host-capacity
assertions across 29 sessions, with existing provisioning/workspace/mounted
capacity groups also passing. The compiled helper passes 62 stream cases in each
build. Shared contracts pass 75 tests; 201 focused worker tests pass, followed by
10 startup tests after updating their interface doubles. Typecheck, strict lint
and reproducible x64/ARM64 controller builds pass. See
[host transport evidence](COMPARISON_IMPLEMENTATION_STATUS.md#host-backing-observation-transport).

## Retained host observations

SQLite 234 and PostgreSQL 179 add a separate immutable host-observation stream.
The shared assignment transaction checks the current protected credential, mesh
admission, assignment lease, native cell and all twenty-one retained records.
It preserves the original revision, lease revision and database timestamp on
exact replay, including after the setup claim expires. Historical migrations and
mounted-observation rows remain unchanged. Rollback disables the new producer
and retains both evidence tables.

The protected settlement route accepts `cell.backing_capacity.snapshot` and
`cell.backing_capacity.observation`. The Gateway awaits its storage owner and
validates the exact acknowledgement before returning `cellBackingCapacity`.
Mounted and host frames cannot substitute for one another, even with the same
nonce, assignment and revision.

`observeAndRecordWorkerCellBackingCapacityOnConnection` retains the native
receipt before submission and replays pending bytes after response loss without
rescanning. It reads the current assignment lease for each protected request.
Both observation types share one active owner per durable-state instance and
assignment, while their retained keys and revisions stay separate. Cancellation,
late callbacks, lease regression, corrupt state and mismatched acknowledgements
withhold success and preserve pending evidence.

This is an explicit delivery entry point. The installed controller still lacks
the required quiescence owner; persistence neither starts an observation nor
updates reservations, full-pool accounting, quotas or readiness. See
[host persistence evidence](COMPARISON_IMPLEMENTATION_STATUS.md#retained-host-capacity-observations).

## Admission resource limits

The shared capacity-admission contract compares supplied and retained
disk, memory, file-count, process-count and raw-output peaks with the immutable
cell reservation. Existing violations return `quarantine` and retain their
high-water evidence even if later observations decrease or an incoming byte
request would otherwise be rejected. Invalid numeric observations fail before
authority/storage access; exact limits remain admissible.

`RemoteWorkerCellCapacityAdmissionRepository` evaluates that contract and records
high-water evidence in one protected transaction. Current credential, mesh,
assignment lease and immutable-profile checks remain locked through the write.
Capacity, cleanup and execution revisions all participate because diagnostics can
advance raw output independently. Final authority/revision failure rolls back
state and evidence together. The injected Gateway service requires this awaited
owner for both admission and read-only snapshots; it has no preflight-only fallback.

This service still requires a complete footprint from its caller. It does not
convert these partial native observations into full-pool accounting, compose
installed workload quiescence or enforce OS quotas. Production accounting and
worker quarantine/termination integration remain open. SQLite/PostgreSQL tests
cover revocation, rollback and concurrent one-winner admission. See
[transactional admission proof](COMPARISON_IMPLEMENTATION_STATUS.md#transactional-worker-capacity-admission).

## Declared inventory accounting and admission

The shared inventory contract requires all thirteen footprint areas, including
independent evidence for empty areas. Physical identities appear once; guest
objects identify their included host volume-backing object. Host allocated bytes
are charged once, guest allocation stays separate, and logical file references
are charged individually even when several references share one CAS object.
Missing areas, duplicate identities, invalid backing/reference graphs, unsafe
byte counts and mismatched profile/capture/inventory hashes are refused.

`admitInventory` retains the normalized input and its hash with the capacity
decision in the protected assignment transaction. SQLite 235 / PostgreSQL 180
add immutable retained inventory rows. Backup revision joins the existing
capacity, execution and cleanup fences; failures after the insert roll back
the inventory, peaks and evidence together. Logical-byte and inode high-water
values persist across lower captures and intervening footprint-only admissions.
Both admission methods return `quarantine` for a retained violation. Rejected
prospective work does not create an inventory or advance capacity evidence.
Protected reads recheck current authority and verify the retained input/hash.

Native inventories may include `nativeLayout`, containing the provisioning
assignment binding, profile and thirteen ordered raw host-root identities.
Normalization requires each root to appear as a host directory in its recorded
area. Identity hashes use the domain `goatcitadel.native-file-identity.v1` with
a trailing zero byte followed by the native 24-byte volume/file identity.
The inventory digest includes the layout. Historical and non-native inventories
retain their original field set and digests; older readers reject the new field
rather than silently dropping it. Existing immutable JSON rows retain the
extension without a schema migration or rewriting historical evidence.

Admission checks native layout assignment/profile against the retained
provisioning plan. Once an assignment has retained a layout, later inventory
captures cannot omit it, replace a root or reorder its area identities. Reads
repeat the provisioning binding check. The 39 focused contract tests and three
revocation-boundary fixtures on each of SQLite and PostgreSQL pass, including
same-layout recapture, readback, substitution/downgrade rejection and unchanged
evidence after refusal (`.tmp/native-layout-retention-contracts-v2.log`,
`.tmp/native-layout-retention-sqlite-v1.log`, and
`.tmp/native-layout-retention-postgres-tests-v2.log`). The PostgreSQL proof uses
an owned temporary cluster, which is stopped after the run. These are controlled
layout records; this proof does not establish installed-root discovery or native
transport of a full pool capture.

The retained native layout now has a bounded binary representation (`GCLAY001`,
384 bytes). `CellCapacityLayout::Capture` emits `GCCAP001`: a nonce, that layout,
thirteen area summaries and ordered per-object identities and byte counts.
Frames contain no paths, are limited to 20,000 objects (960,840 bytes), and are
discarded if the final retained-root, cancellation or deadline checks fail.
The TypeScript decoder requires an independently retained layout and expected
nonce; it rejects root substitution, duplicate identities, invalid ordering,
unsafe totals, inconsistent summaries, reserved bytes and trailing data.
Decoding supplies host-directory observations and evidence hashes, not collector
custody, quota authority or complete guest/backing/shared-artifact accounting.

`OpenRecordedBytes` restores a saved layout only after matching an independently
supplied assignment binding and profile, then reuses the pinned-root and exact
ACL checks from `OpenRecorded`. Invalid bytes or a failed binding/root check
invalidate any previous open layout. The native decoder rejects truncated or
extended records, invalid headers, empty bindings/file IDs and repeated roots,
and clears its output on failure. This supports recovery of retained data; the
installed owner must still provide the protected record and original root
handles under current authority. It neither discovers nor adopts replacement
roots. Recovery fixtures read the saved bytes from an owned temporary file,
close/reopen the layout and verify that substitution cannot leave stale capture
authority (`.tmp/native-capacity-layout-recovery-v4.log`).

Host-area scans can borrow exact handles from a separate native journal/backing
owner. Each borrowed file must match its recorded parent, physical identity and
measured logical/allocated counts, and must occur exactly once in the complete
area enumeration. Missing, duplicate or substituted files refuse the whole
capture. The collector duplicates the retained handle rather than reopening a
locked path with broader sharing. Ordinary files still refuse open writers;
links, alternate streams, unsafe attributes and changed metadata remain invalid.
The borrowed owner supplies a separate custody/quiescence guard, followed by a
fresh canonical/layout authority check. All retained handles participate in the
joint final metadata/membership readback. This native-only input grants no
authority to a peer request and does not replace installed journal composition.

Controlled writer-handle fixtures prove identical encoded counts to an ordinary
scan, rejection of unlisted writers and out-of-area borrowed files, and full
discard on cancellation, revocation or early/middle/final callback writes. Actual
borrowed capture bytes also decode in TypeScript. These are ordinary owned
files, not attached VHDX acceptance (`.tmp/native-capacity-borrowed-files-v5.log`).

`CellProvisioningJournal::ObserveHostCapacity` now supplies its own original
journal and VHDX handles to the host-area reader. It binds the layout to the
journal's assignment/profile, freezes the journal lifetime and full checkpoint
history, and rechecks custody throughout one bounded observation. Both the
backing measurement and host inventory are withheld on any failure. The caller
still supplies the recorded layout and global workload quiescence; installed
collection and mounted-volume traversal are not enabled by this method.

The host scanner, layout scan/wire capture and journal observation accept an
optional synchronous `CellCapacityCaptureObserver`. Its callback runs while
every enumerated host handle remains held. The borrowed `CellCapacityPinnedView`
can recheck joint metadata/membership and cooperative cancellation/deadline
without invoking external authority; it must not escape the callback. External
authority is checked again after the observer, followed by final joint readback.
Both observer callbacks are required and copied before authority callbacks run.
Related output remains provisional: callback errors or subsequent validation
failure invoke its discard callback exactly once across the nested owners.
Successful publication leaves the related evidence with its owner.

`CellDirectoryInventoryPins` now retains a complete single-tree inventory's
handles beyond the initial call. Its later `Check` compares the held metadata
and memberships, checks cancellation/deadline, and never invokes the borrowed
authority callback after that callback's context has expired. Open-owner reuse
is refused; callback close/reentry withholds provisional output. Explicit close
or destruction releases the handles. The caller still owns the admitted root,
cancellation handle, current authority and global writer quiescence.
`CaptureCellWorkspaceInventory` adds the existing complete workspace identity
and security checks around this retained read. Workspace scans pass only their
remaining wall time to the inner reader. The native lane passes 1,664 checks in
each normal/AddressSanitizer build, plus ARM64 compilation and real wire decoding
(`.tmp/native-retained-inventory-20260915-b.log`). Proof includes writer exclusion
after return, membership drift, cancellation, reentry, explicit release and
mismatched workspace roots. The complete controller/helper production builds
also reproduce for x64 and ARM64 on F:
(`.tmp/native-retained-inventory-payload-20260915-a.log`).
`CellMountedWorkspace::CaptureInventory` now retains those handles through the
mounted owner's final checkpoint, dependency, cancellation and identity checks.
Failures close newly captured handles and clear the inventory; reuse of an open
owner preserves its original handles. The mounted lane passes 785 checks in each
normal/AddressSanitizer build and compiles ARM64
(`.tmp/native-mounted-retained-inventory-20260915-a.log`). The tests use actual
protected directories with controlled volume verification, including late
revocation, cancellation, history drift and reopening writers after failure.

`CellProvisioningJournal::CaptureMountedInventory` connects that retained reader
through the existing independent anchor/head, journal custody and mounted
checkpoint validation. Its cell-binding callback is mandatory. The caller must
still retain journal/volume custody and writer quiescence through the joined
capture; retained handles alone neither authorize execution nor enable installed
capture. The focused journal run passes 835 checks in each normal/AddressSanitizer
build with the same source hashes and independent checkpoint decoding
(`.tmp/native-journal-retained-20260915-a.log`). It covers missing cell authority,
null output, revoked authority and absent physical mounted owners using a real
exclusive journal and an unattached VHDX.

`CellVolumeMount::WithCapacityLeaf` now lends a noncopyable, callback-scoped
`CellCapacityMountLeaf` for the exact independently recorded host directory. Its
private constructor prevents paths or peer claims from admitting a leaf. Before
and after the callback, the owner checks current authority, immutable history,
target, security and read-only native volume/protection state. A duplicated
no-follow handle remains held. Native `Check` does not call expired execution
authority; callback errors, close/reentry, revocation, cancellation and late
readback drift discard provisional evidence exactly once.

Host scans accept these capabilities in `CellCapacityBorrowedFiles.mounts`.
Every supplied leaf must occur exactly once under its recorded parent as the
literal `volume` directory with the mount-point reparse tag. The scanner counts
the host directory identity/allocation and never enumerates its mounted contents.
Unadmitted links, foreign parents, following handles, duplicate/missing leaves and
late mount-owner refusal clear the complete observation. The generic single-tree
scanner still rejects all reparse points. All host handles remain held through
the final owner checks and related-evidence callback.

The scanner lane passes 1,753 checks per normal/AddressSanitizer build, ARM64
compilation and existing native-to-contract wire decoding
(`.tmp/native-capacity-mount-leaf-20260915-a.log`). Its mount-owner capability is
controlled while junction metadata, no-follow handles and allocation reads are
real. The junction points only into the task-owned test tree; guest streams
would fail if traversed. This is not a physical mounted-volume acceptance run.
The mount and mounted-inventory regression lanes also pass 2,427 and 785 checks
respectively per normal/AddressSanitizer build, with ARM64 compilation
(`.tmp/native-mount-leaf-regression-20260915-a.log`). The mount fixture verifies
immutable bindings, callback freezing, native failure at every boundary,
close/reentry, cancellation, deadline consumption and exact-once discard. Its
production entry refuses controlled history and an ordinary directory when
physical protected-volume dependencies are absent.
The journal's host reader now supplies its native mount capability automatically
when its mounted history is complete, checks the recorded mount checkpoints and
requires the exact host workspace parent. Creation-only journals retain their
existing host-only path. `ObserveJoinedCapacity` captures guest handles from
inside the held host callback, rechecks host custody during guest authorization,
and retains guest handles through the remaining host and journal checks. It
requires cell binding, matching anchor/head/assignment/profile, a shared deadline
and a combined entry ceiling. Failures clear both outputs.
Capacity read scopes defer destruction if a callback closes the journal:
authority is revoked immediately, subsequent reads are refused, and the
outermost active read releases the native owners and file handles. This prevents
destroying an owner while its callback is still on the stack.
Focused journal validation passes 57 host cases and 835 mounted-history cases
per normal/AddressSanitizer build
(`.tmp/native-joined-journal-focused-20260915-a.log`). The host cases use a real
exclusive journal and unattached VHDX. They prove missing-cell-authority refusal,
guest refusal inside a held host scan, cleared combined output, successful host
retry, immediate revocation on close, retained file custody during the callback
and actual handle release after unwinding. They do not prove positive physical
mounted host/guest composition. Controller/helper production builds reproduce
for x64 and ARM64 (`.tmp/native-joined-journal-payload-20260915-a.log`).

The runtime runner's existing guest/backing capture also retains guest handles
through backing-file observation, rechecks them alongside job authority, and
clears both provisional outputs on any failure. The installed coordinator still
needs to invoke combined capture with complete pool coverage and global writer
quiescence. These source paths do not establish positive physical mounted-volume
acceptance or installed capture readiness.

The first full native job run after this connection stopped at the sanitizer
core phase's exact-job cancellation assertion
(`.tmp/native-joined-journal-job-20260915-a.log`). Retrying that same executable
without recompilation passed all 3,234 core checks
(`.tmp/native-joined-journal-core-retry-20260915-a.log`). The retry does not make
the failed full run green.
The cancellation fixture previously started its 150 ms timer before preparing
the AppContainer profile. It now prepares the command first and waits, within a
bounded test deadline, for a process in that exact named job before signalling
cancellation. It still requires cancellation and verified zero remaining
processes. The independent pre-cancelled/no-launch check remains in place.
The next full run caught a binding-alias regression introduced by the read-scope
change (`.tmp/native-joined-journal-job-20260915-b.log`): clearing output before
copying an input anchor/head could erase inputs referring into that same output.
The backing, mounted, host and joined entry points now freeze those inputs before
clearing output. Host/joined regression cases cover this alongside the existing
backing-reader alias assertion. That failed run remains failure evidence.
The fresh full lane subsequently passes in 436 seconds
(`.tmp/native-joined-journal-job-20260915-c.log`): 6,149 combined checks in each
normal/AddressSanitizer build, plus 59 host-capacity and 835 mounted-history checks
per build. Network and owner-crash checks and phase-receipt validation complete
within the same successful run. Attachment, physical formatting and mounting
remain disabled. This establishes the local named integration lane, including
the repaired cancellation test and input-alias cases; it does not establish a
positive installed host/guest collector on a physical mounted volume.
Fresh controller/helper production builds also reproduce for x64 and ARM64
after the input-alias correction
(`.tmp/native-joined-journal-payload-20260915-b.log`).

The combined-read algorithm now has a private reader seam for positive custody
tests; the public entry remains fixed to the native journal readers. Those tests
use real host journal/VHDX accounting and real protected guest directories. They
attempt competing writes during guest collection and final host authorization,
then confirm handles are released after return. Additional cases cover reader
failure, substituted guest/host bindings, omitted guest collection, authority and
cell-binding revocation, cancellation, a shared deadline, combined entry bounds
and aliased input/output bindings. Only the mounted-volume reader is controlled:
both fixture trees use ordinary NTFS directories, so these tests establish the
joined lifetime and failure behavior without claiming physical volume acceptance.
The focused lane passes 116 host/joined cases and 835 mounted-history cases in
each normal/AddressSanitizer build against the same source hashes
(`.tmp/native-joined-positive-focused-20260915-a.log`).
The controller/helper production closure also reproduces for x64 and ARM64
(`.tmp/native-joined-positive-payload-20260915-a.log`).

The September 15 retained-inventory integration run found only about 31 MiB
free on C:, where the earlier native fixtures were retained. Subsequent native
artifact runs use the task-owned F: temporary root instead of consuming more
system-drive space. Three completed source backup copies and the prior
controller/helper build outputs were relocated to
`.tmp/retained-evidence-20260915/`; `relocation-manifest.json` records every
original/new path and verified file digest. Original evidence manifests were
preserved byte-for-byte. No test tree containing reparse points, user data,
attached image, drive-root permission or installed service was moved or changed.
The native job lane now requires at least 4 GiB free in its selected temporary
directory before it creates fixtures. The low-space refusal was exercised on
C: (`.tmp/native-retained-inventory-preflight-20260915-a.log`). This is an expected
preflight rejection, not a passing native integration run. The retained-inventory
run on F: reached the workspace phase and exhausted the existing combined
40-second watchdog (`.tmp/native-retained-inventory-job-20260915-b.log`). The
runner now separates core, provisioning and workspace proof. All three receipts
must come from the same unchanged executable; their checks cannot overlap, and
the original complete receipt assertions still validate the combined result.
Raw phase receipts retain elapsed time and executable hashes. Missing evidence,
wrong phase labels and duplicated/inconsistent counts are rejected.

Progress markers showed the provisioning group completing 1,280 assertions in
about 40 seconds on F:, rather than identifying a stopped operation
(`.tmp/native-workspace-phase-integration-20260915-c.log`). Its aggregate test
process budget is now 120 seconds; core and workspace retain 40 seconds each,
and the overall test lane allows 600 seconds. Individual native operation
deadline/cancellation assertions remain unchanged. These are test-harness
budgets, not worker runtime policy or installed-controller limits.
The full lane now passes on F: in about 7.2 minutes
(`.tmp/native-workspace-phase-integration-20260915-e.log`). Each normal and
AddressSanitizer build contributes 3,234 core, 2,430 provisioning and 485 workspace
assertions to the validated 6,149-check combined proof, followed by 50 host-capacity
and 831 mounted-workspace assertions. The lane also completes its network and
owner-crash checks. Attachment, physical formatting and mounting flags remain
false. The phase-combination unit check independently rejects missing records,
wrong labels and duplicate or inconsistent counts.

The scanner lane passes 1,635 checks in both normal and AddressSanitizer builds,
plus ARM64 compilation and decoding of real native capture bytes in TypeScript
(`.tmp/native-capacity-pinned-observer-20260915-b.log`). Cases include a competing
writer refused inside the observer, child-membership mutation, cancellation,
callback failure, incomplete observers and exactly-once nested discard. This
callback is a prerequisite for coordinated collection; it does not establish
global writer quiescence, installed guest collection, complete pool coverage or
execution authority. Dependent evidence owners must retain their own custody
and quiescence guarantees through the enclosing capture.

The journal host-capacity cases now run as a separate
`--host-capacity-journal` invocation within the native job lane, retaining the
same 40-second process watchdog. An isolated replay of the compiled,
source-hash-verified fixtures passes all 50 assertions in normal and
AddressSanitizer builds, including callback failure and layout custody loss
(`.tmp/native-capacity-pinned-isolated-20260915-b.log`). It creates only an
unattached VHDX in the owned fixture. Earlier full native job runs timed out
in the default AddressSanitizer invocation even after these cases were separated
(`.tmp/native-capacity-pinned-journal-20260915-c.log`). The test now emits elapsed
phase diagnostics and preserves them in timeout errors without increasing the
40-second watchdog. A subsequent full named lane passes in normal and
AddressSanitizer builds, with 6,149 main checks (including 2,430 provisioning
journal checks) and 50 separate host-capacity checks per build
(`.tmp/native-capacity-job-phase-20260915-a.log`). Attachment, format and mount
flags remain false. That fresh integrated pass supersedes the red status; it
does not identify or claim to fix the earlier intermittent timing cause.
The complete production controller and runtime helper still build reproducibly
for x64 and ARM64 (`.tmp/native-capacity-pinned-payload-20260915-a.log`); these
build checks do not establish installed execution or live capture acceptance.

The real journal fixture exposed an ordinary-file allocation error: compression
information reported a 5,120-byte logical file where NTFS retained 16,384 bytes
of allocation. Ordinary files now use `FileStandardInfo.AllocationSize`;
sparse/compressed files retain their separate compression-allocation measurement.
The scanner checks a non-aligned ordinary file, and the journal fixture verifies
the actual retained journal and unattached VHDX counts occur exactly once.
Existing retained evidence is not rewritten. The full native job lane passes
6,192 checks per normal/AddressSanitizer build, including early/middle/final
revocation of the joined observation (`.tmp/native-journal-host-capacity-v5.log`).
The attachment-proof environment flag was absent; no attach, format or mount
operation was performed.

`composeRemoteWorkerNativeCapacityInventory` joins the host capture, mounted
per-object observation, backing observation and shared-artifact references.
All frames are decoded against independently retained history/layout inputs.
The capture owner separately supplies the host nonce and four source digests:
the host capture's domain-separated digest, canonical guest summary/chunks under
`goatcitadel.native-capacity-guest-source.v1`, canonical backing bytes under
`goatcitadel.native-capacity-backing-source.v1`, and canonical normalized references.
The resulting capture and area evidence bind those inputs and the checkpoint.

Composition requires the journal, backing file and every retained host workspace
directory to occur in the host capture. File counts must agree across sources.
The existing backing object becomes `volume_backing`; guest objects reference it
and contribute only to separate guest allocation. Shared logical references must
target host files in `immutableArtifactBytes`. The combined inventory retains its
native layout and the existing 20,000-object bound. Empty references are an
explicit, hashed observation; they do not remove physical artifacts.

Seventy-four contract tests pass across composition, inventory accounting,
layout and wire decoding (`.tmp/native-capacity-composition-contracts-v4.log`),
including source substitution, missing identities, conflicting allocation,
combined size limits and shared-reference accounting. These are controlled
frames. The join does not establish that captures shared a quiescent window;
that remains the installed collection owner's obligation. Transport, protected
retention of that window and production collection are not enabled by this API.

`EncodeCellJoinedCapacity` now converts a completed native joined observation
into the existing layout, host-capture, guest-summary/chunk and backing frames.
It validates all 21 independently retained records and local principals, the
assignment/profile/layout binding, the original host directories and files,
matching allocation counts, distinct host/guest volumes and the combined
20,000-object limit. Any failure clears every output frame. Host frames use the
capture nonce; guest/backing frames preserve the retained protocol nonce. This
data encoder neither dispatches a protocol operation nor grants authority.

`CellJoinedCapacityCollector::Capture` connects that encoder to the original
live journal and host layout. It freezes the complete reference and callback
descriptors, binds the journal lifetime and all retained bytes, and preserves
the original host handles and protection descriptor. It checks canonical
authority and cell binding around collection and encoding, then revalidates the
native journal and layout before publishing. Cancellation, changed custody,
failed native readback or a deadline overrun discards every frame. The single
deadline is bounded by both the caller's scan limit and the retained request;
a stricter admitted object limit also applies. Deferred journal close protects
the synchronous capture stack while revoking ownership immediately.

The public collector uses fixed native readers; its test-only private seam
exercises controlled lifecycle outcomes. It does not supply the installed
service's pool-wide writer exclusion, shared-reference owner or activation.

`pnpm verify:remote-worker:windows-cell-joined-capacity-wire` passes 3,624 native
checks in each normal and AddressSanitizer run, then decodes the emitted frames
with the current TypeScript contracts and exercises inventory accounting. The
fixture charges 69,300,224 host bytes and 90,112 guest bytes separately, rejects
altered source frames and exercises the exact combined object ceiling. Native
acknowledgements are retained separately from the encoded observations. Evidence:
`.tmp/native-joined-capacity-collector-20260915-c.log`. Collector cases include
callback-side input replacement, early and late revocation, cancellation during
final readback, both deadline bounds and stricter object limits. The timeout
fixture compares its frozen inputs without repeatedly revalidating the complete
history; the original sanitizer attempt exhausted its short budget before the
intended capture (`.tmp/native-joined-capacity-collector-20260915-b.log`). Runtime
deadlines are unchanged. These are controlled accounting
values over real acknowledged journal identities and an unattached VHDX, not a
physical mounted-volume scan or proof of canonical admission. The collector's
final readback verifies owner custody; excluding all pool writers through the
handoff remains the enclosing owner's responsibility. Installed capture
ownership, whole-pool quiescence and shared-reference collection remain required.

`deliverWorkerNativeCapacityInventory` retains one explicitly identified capture
before delivery. Its bounded local record preserves the source JSON, complete
original history and exact acknowledgement. A write must read back unchanged
before transport. Response loss, acknowledgement-write failure or cancellation
leave the pending source available for retry without another native capture.
Lease renewal can authorize delivery while preserving the original bundle hash.
A fresh capture requires a new nonce; concurrent delivery owners for the same
assignment and state adapter are refused.

The supplied protected delivery owner must deduplicate by bundle hash and return
matching bundle, inventory and capture digests with a canonical revision. A saved
local acknowledgement is confirmed against that owner again; a changed revision
requires reconciliation. Local receipt caching is not execution or quota
authority. Fifteen focused delivery tests pass alongside both existing capacity
delivery suites (44 tests total, `.tmp/native-capacity-delivery-v3.log`), including
reopening actual temporary file-backed state, corruption/readback refusal and
authority loss. These tests use controlled canonical-owner callbacks. Installed
collection remains separate work; the protected page path below now connects
the durable delivery ledger to Gateway staging.

The delivery envelope now has a shared contracts owner. The worker uses
`createRemoteWorkerNativeCapacityDelivery` without changing its existing durable
schema or bundle hash. `readRemoteWorkerNativeCapacityDelivery` reconstructs the
inventory from raw source frames and checks all submitted digests against
independently retained history, layout and capture-window bindings. A renewed
authorization lease does not replace the original capture history. A submitted
capture cannot supply its own independent bindings, even when internally
consistent. Both ingress shapes enforce a 16 MiB UTF-8 bound; returned evidence
is recursively frozen. This verifier is a prerequisite for canonical source
retention, not a database commit, authority check or transport endpoint.
The focused proof passes 59 contract tests across delivery, composition, capture
and layout (`.tmp/native-capacity-delivery-verifier-contracts-20260915-1103.log`),
16 worker delivery tests including independent receiver verification
(`.tmp/native-capacity-delivery-verifier-worker-20260915-1101.log`), and 12
verification-lane checks. Worker/contracts typechecking and focused ESLint pass.

`Storage.remoteWorkerNativeCapacityDeliveries` retains the verified source
envelope and canonical inventory admission in one transaction. SQLite migration
241 and PostgreSQL migration 186 add an immutable, 16 MiB bounded evidence table
with unique assignment-scoped bundle digests, capture nonces and capacity
revisions. The PostgreSQL migration enforces the envelope checks on both fresh
bootstrap and upgrade paths. No existing evidence is backfilled or replaced;
rollback disables the producer and leaves retained rows intact.

The repository requires independent capture bindings and current protected
assignment authority. It checks the capture history against the canonical
provisioning head, permits a newer authorization lease without rewriting the
original capture, and revalidates source against its canonical inventory on
readback. Response-loss retries return the original receipt without another
admission, including after later captures. Reusing a nonce for different source
fails and rolls back its inventory write. Write failure or authority loss rolls
back source, inventory and capacity evidence together. Rejection leaves no new
record; quarantine retains its distinct decision and evidence.

The controlled canonical-row fixture covers worker, mesh-authority and parent
revocation on both SQLite and PostgreSQL, plus replay, renewed leases, nonce
conflicts, rollback, rejection, quarantine and immutable retention. It uses
encoded fixture observations and an owned temporary PostgreSQL cluster. This
does not prove installed collection or a live transport. Installed capture
coordination must still register independent expectations before production use.
Proof: three SQLite cases (`.tmp/native-capacity-retention-sqlite-20260915-d.log`)
and three PostgreSQL cases
(`.tmp/native-capacity-retention-20260915-pg-v4.log`) pass. The latter cluster was
stopped after the run. All 24 migration-integrity tests and migration parity
(241 SQLite / 186 PostgreSQL) pass, with all 425 pre-existing migration manifest
entries preserved. Storage/Gateway typechecking, focused lint and docs checks
also pass. No installed database, provider, external channel or disk operation
was used for this retention proof.

The protected settlement protocol accepts `cell.native_capacity.page` and
`cell.native_capacity.lookup`. Pages carry at most 32 KiB of source bytes as
lowercase hex, with fixed offsets and a 16 MiB total ceiling. They bind the
capture nonce, canonical bundle digest and separate serialized-delivery digest.
The existing 512 KiB RPC ceiling remains unchanged. A page acknowledgement must
echo the exact submitted bytes; reaching the end requires a complete canonical
receipt. Partial staging cannot claim capture completion.

`deliverWorkerNativeCapacityOnConnection` joins the local durable capture ledger
to this protected page client. It starts retries with canonical lookup, replays
the original source after response loss, follows lease renewal within the same
assignment, and preserves the capture's accept/quarantine decision separately
from its stable receipt. That retained decision is not fresh workload admission.
The Gateway snapshots protected authority and page data before yielding, checks
the owner response against the exact request, and withholds cancelled results.
Its production composition uses `Storage.remoteWorkerNativeCapacityPages` for
durable staging. Requests require a previously registered independent capture
expectation; the peer protocol cannot create one. The installed capture
coordinator still needs to provide those expectations. No in-memory staging
substitute or implicit expectation adoption is enabled.

Controlled proof passes 14 page-contract tests
(`.tmp/native-capacity-pages-contracts-20260915-a.log`), 24 worker delivery/client
tests (`.tmp/native-capacity-pages-worker-20260915-b.log`), 62 protected protocol
tests (`.tmp/native-capacity-pages-gateway-20260915-a.log`), four owner-boundary
tests (`.tmp/native-capacity-pages-exchange-20260915-a.log`) and 12 lane checks.
Gateway/worker typechecking and focused ESLint pass. The client tests use a
controlled protected-route callback, and the protocol tests use signed requests
with controlled owners; they do not prove an installed or live remote transport.

SQLite migration 242 and PostgreSQL migration 187 add immutable capture
expectations and ordered source pages. Only the trusted coordinator's
`prepareForAssignment` may register the original history, layout, capture window,
source digests, length, admission parameters and expected cell revisions. These
records exclude lease tokens and protected credential authority. The page RPC
accepts only page/lookup fields and cannot choose the capture's admission inputs.

Each page is bounded, hashed, checked against its registered capture, committed
under current assignment/cell authority, and read back unchanged. Lease renewal
can resume the original capture. Exact duplicate pages return retained progress;
changed pages, gaps, stale revisions and unregistered captures fail. The final
page must assemble to the registered UTF-8 digest and canonical source envelope
before the source/inventory owner commits admission and returns a receipt. A
failed final page rolls back that page and admission while preserving the prior
prefix. Completed lookup and replay verify the retained receipt instead of
advancing capacity again. Staging rows remain retained for governed recovery.

The staging fixture passes all three authority-revocation cases on SQLite
(`.tmp/native-capacity-staging-sqlite-20260915-a.log`) and PostgreSQL
(`.tmp/native-capacity-staging-20260915-pg-v4.log`). SQLite proof opens a second
connection to each actual temporary file-backed database and recovers the
partial upload. The PostgreSQL cluster was stopped after validation. Additional
proof passes 61 contract tests, 91 Gateway tests, seven async-storage tests and
24 migration-integrity tests. Migration parity passes at 242 SQLite / 187
PostgreSQL entries, preserving all 427 earlier entries. These controlled frames
and temporary databases establish staging behavior, not installed native
collection, global capture quiescence, whole-pool quotas or live remote proof.

`pnpm verify:remote-worker:windows-cell-capacity` builds the contracts first and
tests actual C++ capture bytes through the TypeScript decoder. The current proof
passes 1,605 native checks in each of normal and AddressSanitizer builds, checks
decoded file sizes against the fixture files and compiles ARM64 without executing
it (`.tmp/native-journal-host-capacity-scanner-v1.log`). Receipts include native and decoder
source hashes. The 26 focused contract tests include a 20,000-object frame and
malformed inputs (also rerun within
`.tmp/native-capacity-delivery-verifier-contracts-20260915-1103.log`). All filesystem
fixtures are owned temporary directories; this proof performs no virtual-disk
operation or installed-service change.

The controller and provisioning/runtime-helper production build inputs include
both capacity wire files. Repeated builds for x64 and ARM64 produce identical
hashes per target, and the source receipts retain the encoder inputs
(`.tmp/native-journal-host-payload-v1.log`). The 31 package-content checks
also pass (`.tmp/native-capacity-production-package-v1.log`). This verifies build
and package composition only: neither payload was installed or executed, and
the installed observation callbacks still require a quiescence owner.

The independent binding must come from an admitted collector. Declared coverage
does not prove a complete or quiescent OS scan. Native per-object APIs cover an
admitted guest tree or thirteen independently retained host roots; those scans
and the current aggregate mounted/backing observations
cannot be relabeled as a complete inventory. Installed capture composition,
whole-pool enumeration/reservations, quota enforcement and worker termination
remain separate owners. Rollback disables the new producer and retains the
additive schema/evidence; there is no destructive down migration or backfill.
See [declared inventory evidence](COMPARISON_IMPLEMENTATION_STATUS.md#declared-capacity-inventory-and-native-object-records).

## Reported footprint

A successful observation contains the root identity, logical file bytes,
allocated bytes, file count and directory count. Directory count includes the
root. Logical and allocated bytes remain separate for sparse and compressed
files. Directory allocations are included; volume metadata, other roots,
AppContainer profile storage, database sidecars elsewhere and other footprint
categories require their own inventory owner.

The implementation uses handle-based
[file standard information](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info),
[compression information](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_compression_info)
and [stream information](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_stream_info).
The native tests compare allocation totals with separate path-based
`GetCompressedFileSizeW` controls on their own fixtures.

## Incomplete and changed reads

- Hard links, repeated identities, junctions/reparse points, mount crossings,
  named streams (including empty streams and directory ADS), unsupported nodes,
  remote/offline recall, invalid names and non-NTFS roots are refused.
- Enumeration is bounded by entry count, depth and time. It never reports a
  truncated tree as a complete footprint. File identities use their full widths.
- Entry handles remain held through final metadata and directory-membership
  readback. A live file writer prevents a compatible read pin. Changed child
  identities or memberships invalidate the observation.
- Opening the root by ID preserves object identity across a prior rename;
  it is not a lease on the old name. A rename during inspection is either
  prevented by the OS or rejected by the final readback. The protected workspace
  wrapper additionally retains its existing name/security checks.
- Every error clears the entire output. A caller must treat that error as an
  unavailable observation, never as zero usage. Failures preserve all files and
  prior canonical evidence.

This is an observation of an owner-quiesced tree, not an atomic snapshot of an
actively changing tree. It is a capacity input, not a hard disk/file-count limit,
complete host accounting or a hostile-code isolation claim.

## Verification

### Retaining per-object observations

The internal Gateway exchange owner now retains the complete native summary,
ordered chunks and terminal receipt through the asynchronous storage owner.
SQLite migration 236 and PostgreSQL migration 181 add independent immutable
observation history. Existing migrations and remote request limits are unchanged.
Reads and writes validate every object against the independently retained native
history and the current protected assignment, credential, mesh and cell fences.
Exact nonce replay returns its original record; conflicting bytes are refused.
A final authority failure rolls back the observation transaction.

This is partial mounted-tree evidence. It does not advance cell readiness,
capacity admission, quotas or complete pool accounting. The internal exchange
can hold 20,000 objects. Remote delivery uses pages of at most 64 native chunks
through protected assignment settlement. SQLite 237 and PostgreSQL 182 hold one
bounded staging capture per assignment generation. Each page validates the entire
contiguous prefix under current protected authority; only a complete capture
enters immutable observation history. A first page can replace an interrupted
capture. Later pages must match the retained nonce, lease and cell revisions.
Exact retries acknowledge progress without creating duplicate observations.
The worker sender validates the complete capture before transport, checks every
page acknowledgement, and withholds completion on changed history or cancellation.
This delivery path does not invoke or enable an installed scanner.
See [inventory retention evidence](COMPARISON_IMPLEMENTATION_STATUS.md#per-object-inventory-retention).

Run `pnpm verify:remote-worker:windows-cell-capacity` on Windows. It compiles and
executes the real reader in normal and AddressSanitizer builds, then compiles
ARM64 without claiming ARM64 execution. The harness retains its input hashes,
compiled images, native receipts and ordinary temporary NTFS fixtures.

The cases cover exact empty/nested/multi-buffer counts, Unicode names, zero-byte
files, independent logical/allocation totals, sparse/compressed files, links and
streams, bounds, cancellation, callback deadline exhaustion, child changes at
every authority boundary, held writers, renamed/replaced roots, protected
workspace identity/security drift, and attempted widening of frozen limits.
Per-object cases compare identities and individual allocations against separately
opened known fixtures, preserve aggregate totals, exercise reused outputs, and
refuse partial records after revocation/cancellation, links, streams or a held
writer. The September 14 follow-up passes 1,298 assertions in each normal and
AddressSanitizer build; the mounted per-object integration passes 525 per build.
Both lanes compile ARM64 without executing it.

`pnpm verify:remote-worker:windows-cell-mounted-capacity` exercises the mounted
reader against real protected temporary directories and native checkpoint bytes,
with controlled physical-volume verification. It runs normal/AddressSanitizer
builds and compiles ARM64. The existing `pnpm verify:remote-worker:windows-cell-job`
lane also exercises the journal observation using its real exclusive journal,
unattached VHDX fixture, controlled volume stages and controlled footprint and
per-object readers. Those checks cover independent anchor/head rejection, assignment/profile
and checkpoint drift, revocation, cancellation, timeout, frozen input bounds,
wrong-root and partial-result refusal, owner lifetime changes, malformed object
inventories, and preservation of every journal byte.
The actual protected-volume composition still needs physical acceptance.

`pnpm verify:remote-worker:windows-cell-controller-protocol` runs the production
client against an actual local pipe and independently retained native history.
Capacity readings in that peer are controlled values; the actual controller
test proves refusal when quiescence ownership is missing, including a nonexistent
parent. `pnpm verify:remote-worker:windows-cell-helper-protocol` exercises the
compiled helper callbacks over owned process streams. Both run normal and
AddressSanitizer builds. The worker's volume-protocol tests cover complete and
fragmented capacity streams, terminal gating, current authority, exact bounds and
failure withholding. These checks do not establish an installed live scan.

`pnpm verify:remote-worker:windows-runtime-transfer` exercises the separate
runtime-request transfer over actual private local pipes in normal and
AddressSanitizer builds. Requests use ordered 4 KiB chunks and an independently
retained nonce/digest. A transfer acknowledgment establishes byte receipt only;
the composed receiver still refuses a missing native journal. The framed
runtime-authority owner now exercises fresh digest-bound approvals as well.
Positive installed-listener and live Gateway execution/result-delivery acceptance
remain open.
See [transfer evidence](COMPARISON_IMPLEMENTATION_STATUS.md#bound-runtime-request-transfer).

`pnpm verify:remote-worker:windows-runtime-streams` verifies binary framing,
per-stream ordering/EOF, combined limits, native-channel backpressure and a real
AppContainer echo job over private duplex pipes in normal/AddressSanitizer builds.
It keeps runtime authorization and terminal execution results as separate proof
requirements. See [stream evidence](COMPARISON_IMPLEMENTATION_STATUS.md#bounded-runtime-stream-adapters).

No virtual drive is attached, partitioned, formatted or mounted by these lanes.
No drive-root permissions, installed service, provider credential, user database
or external destination are changed. Test-created directory permissions and
file encoding features are confined to the retained fixture directory.
