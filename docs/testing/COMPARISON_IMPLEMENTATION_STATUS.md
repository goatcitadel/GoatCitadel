# Comparison implementation evidence

This tracks the approved C0-C6 sequence in the [master program](../MASTER_COMPLETION_PROGRAM.md).
It records local evidence separately from live-provider quality, external delivery,
packaged installation, and two-machine acceptance. The implementation is not complete.

Historical evidence paths beginning with `%TEMP%` refer to the Windows temporary
directory of the account that ran the check. Their named subdirectories and files
identify retained local receipts; those receipts are not published with this document.

Latest daily-usability progress: Workbench file actions now require an explicit
review of the exact source, destination and affected paths. Required revisions
reject intervening file edits, folder changes and destination replacement before
mutation. The browser keeps entered paths and requires a new review after a
conflict. See [Workbench file action reviews](#workbench-file-action-reviews).
Other GATE-02 owners and the C1-C6 acceptance boundaries remain open.

Earlier daily-usability progress: Workbench content saves require the reviewed
file revision and coordinate independent Gateway processes through a project
write lock. The browser preserves conflicting drafts until explicit review.
The named Workbench lane passes both its owner checks and the real browser save
journey. See [Workbench file save revisions](#workbench-file-save-revisions).
The file-action extension below closes that local follow-up; other GATE-02
owners and C1-C6 acceptance remain open.

Earlier daily-usability progress: Memory maintenance policy and recommendation
decisions now use required canonical revisions and atomic storage transactions.
SQLite and actual PostgreSQL reject concurrent overwrites and roll back a policy
if recommendation settlement fails. The real Gateway/browser conflict, retained
draft, explicit review and save journey passes. See
[Memory maintenance save revisions](#memory-maintenance-save-revisions) and the
[operator/API contract](../MEMORY_MAINTENANCE_REVISIONS.md). Other GATE-02 owners
and C1-C6 acceptance remain open.

Earlier daily-usability progress: Memory enumeration now has signed continuation,
complete totals and a Load more control beyond 500 items. SQLite and actual
PostgreSQL enumerate 1,211 scoped records without omissions. Authenticated API,
UI race/reload tests and both named Memory browser scenarios pass. See
[complete memory enumeration](#complete-memory-enumeration) and the
[operator/API contract](../MEMORY_ITEM_ENUMERATION.md).

Recent C2 progress: canonical refusal settlement repairs the rejected-approval
parent inconsistency found during UI acceptance. Denial, expiry, duplicate
delivery and startup recovery now retain one parent outcome without activation.
Temporary setup inputs use their existing cleanup owner; refusing rollback
preserves the earlier effect. All 36 focused Gateway tests, six SQLite storage
tests and the actual PostgreSQL approval-binding/CAS check pass. See
[canonical approval refusal settlement](#canonical-approval-refusal-settlement).

Latest C5 progress: Windows controller/helper transport and installed-worker
startup composition now require all twenty-one records through the mounted
workspace stage. Normal and AddressSanitizer builds each pass 14,894 existing
controller checks plus 5,373 workspace checks; the compiled helper passes 48
scenarios per build. All 204 focused worker tests, worker typecheck, strict lint
and reproducible x64/ARM64 controller builds pass. Six retained native histories
match the shared contracts and independently encoded workspace bytes. No drive
was attached, partitioned, formatted, mounted or given new root permissions.
Physical recovery, quotas, protected execution and installed/live acceptance
remain open. See [mounted workspace transport and startup](#mounted-workspace-transport-and-startup).

Earlier C5 progress: canonical exchange v7 retains both mounted workspace records
through paired SQLite 226 / PostgreSQL 171 storage, protected Gateway settlement
and worker coordination. Complete recovery requires independent readback of all
twenty-one records. The contracts match the retained normal/AddressSanitizer
native journal bytes exactly. Contracts (47), worker (183), Gateway (52), SQLite
(4) and actual PostgreSQL (4) focused tests pass, along with dependent typechecks.
No drive was attached, partitioned, formatted, mounted or given new root
permissions. Native controller/helper transport and installed startup still need
the final pair; quotas, protected execution and live acceptance remain open. See
[canonical mounted workspace exchange](#canonical-mounted-workspace-exchange).

Earlier C5 progress: the native journal now retains two mounted workspace records
after the unchanged nineteen-record creation/volume/format/protection/mount
history. Exact flushed-byte acknowledgements, fresh journal readback after
authority callbacks and complete read-only recovery govern this stage. Normal
and AddressSanitizer builds each pass 4,939 existing checks and a separate 679
workspace-journal checks; Node reconstructs all twenty-one records independently.
No real drive was attached, partitioned, formatted, mounted or given new root
permissions. Gateway exchange, controller/helper transport, startup, quotas,
protected execution and installed acceptance remain open. See
[durable mounted workspace journal](#durable-mounted-workspace-journal).

Earlier C5 progress: the mounted workspace directory component now binds four
protected roots to the original volume handle, completed mount digest, frozen
security policy and canonical cell name. Exact acknowledgements and fresh
per-directory guards govern creation; complete recorded recovery only reads.
Normal and AddressSanitizer runs each pass 324 checks, including 89 checks on
ordinary temporary NTFS directories; ARM64 compiles. No real drive was attached,
partitioned, formatted, mounted or given new root permissions. Journal/transport
integration, quotas, protected execution and installed acceptance remain open.
See [mounted workspace directory owner](#mounted-workspace-directory-owner).

Earlier C5 progress: the native controller, helper stream and installed startup
composition now carry all nineteen creation/volume/format/protection/mount
records. Recovery requires independently retained creation identities and the
complete mount history; partial recovery never resumes writes. Normal and
AddressSanitizer controller runs each pass 14,893 checks across 121 sessions;
the compiled helper passes 33 stream scenarios per build. The native journal
lane passes 4,939 checks per build, and 162 focused worker tests pass. Typechecks
and reproducible x64/ARM64 controller builds pass. No real drive was attached,
partitioned, formatted, mounted or given new root permissions. Mounted workspace
contents, quotas, protected execution and installed acceptance remain open. See
[native mount transport and startup](#native-mount-transport-and-startup).

Earlier C5 progress: canonical mount exchange now retains all four mount records
after the complete creation/volume/format/protection history. Shared contracts,
SQLite 225 / PostgreSQL 170 and protected Gateway/worker settlement require exact
bytes, current authority and append-only ordering. Four SQLite and four actual
PostgreSQL scenarios pass, together with 43 contract, 73 worker and 51 Gateway
tests. Both native nineteen-record receipts pass the shared decoder. Workers
without mount recovery retain the history and require reconciliation. No real
drive was attached, partitioned, formatted, mounted or given new root permissions.
Controller mount transport/startup, quotas, protected execution and installed
acceptance remain open. See [canonical mount checkpoint exchange](#canonical-mount-checkpoint-exchange).

Earlier C5 progress: the native provisioning journal now retains four mount
records after the unchanged fifteen creation/volume/format/protection records.
Every flushed record needs an exact canonical acknowledgement. Recovery requires
the complete nineteen-record history and remains read-only. Normal and
AddressSanitizer builds each pass 4,892 checks, including 2,330 journal checks;
Node independently reconstructs the mount records. No real drive was attached,
partitioned, formatted, mounted or given new root permissions. Canonical mount
exchange, controller transport/startup, quotas and protected execution remain
open. See [durable native mount journal](#durable-native-mount-journal).

Earlier C5 progress: a one-shot native mount owner now binds the original protected
volume to an exclusively created `volume` directory beneath its recorded cell
root. Four exact acknowledgements, current authority at both mutation boundaries
and final native readback govern progress; complete recovery only reads. Normal
and AddressSanitizer builds each pass 2,378 checks, including nine actual ordinary
directory checks; ARM64 compiles. Mount operations are simulated in this proof.
No real drive was attached, partitioned, formatted, mounted or given new root
permissions. Journal/transport integration, quotas, protected execution and
installed acceptance remain open. See [governed native mount owner](#governed-native-mount-owner).

Earlier C5 progress: read-only mount-target inspection now checks the recorded
host parent/leaf, literal mount-folder component, volume-GUID reparse target,
single expected mount alias and resolved NTFS root independently. Normal and
AddressSanitizer builds each pass 359 checks, including 17 actual temporary NTFS
directory checks; ARM64 compilation passes. No real volume was mounted,
attached, partitioned, formatted or given new root permissions. The governed
mount operation, its journal/transport, quotas and protected execution remain
unfinished. See [mount target inspection](#mount-target-inspection).

Earlier C5 progress: the native controller, pinned helper and worker startup now
carry all fifteen creation/volume/format/protection records. Recovery requires
the exact complete history and cannot resume writes. Protection policy binds
locally resolved owner/controller identities; peer messages cannot choose them.
Normal/AddressSanitizer controller fixtures each pass 9,442 checks across 90
sessions, and 181 focused worker tests pass. Controller payloads reproduce on
x64 and ARM64. No drive was attached, partitioned, formatted or given new root
permissions. Physical recovery, mounting, quotas, protected execution and
installed acceptance remain open. See
[native protection transport and startup](#native-protection-transport-and-startup).

Earlier C5 progress: shared protection contracts, SQLite 224 / PostgreSQL 169 and
the protected Gateway/worker exchange now retain both root-protection records.
The complete creation/volume/format history and frozen owner/controller policy
bind every checkpoint; acknowledgements require the exact committed bytes. Four
SQLite and four PostgreSQL scenarios pass, as do 41 contract, 59 worker and 50
Gateway tests. The contracts accept both native fifteen-record receipts. No
drive was attached or formatted. Native controller transport/startup, mounting,
quotas, protected execution and installed acceptance remain open. See
[canonical protection checkpoint exchange](#canonical-protection-checkpoint-exchange).

Earlier C5 progress: the native provisioning journal now retains root-protection
intent and completion after its thirteen unchanged creation/volume/format
records. Exact acknowledgements, current authority and a portable frozen-policy
digest bind progress; recovery requires all fifteen canonical records and cannot
resume writes. Normal/AddressSanitizer builds each pass 4,109 native checks,
including 1,547 journal checks. No drive was attached or formatted. Canonical
protection exchange, controller transport, mounting, quotas, protected execution
and installed acceptance remain open. See
[durable native protection journal](#durable-native-protection-journal).

Earlier C5 progress: native root protection now consumes only an original successful
formatter, binds the exact NTFS root and controller descriptor, and requires
acknowledged intent and verified completion. The component passes 1,193 checks
and 40 actual temporary-directory checks in each normal/AddressSanitizer build.
Formatter checks now follow authority exchanges with fresh native readback;
1,277 component and 24 read-only Windows checks pass in each build. No drive was
attached or formatted. Durable protection integration, mounting, quotas,
protected execution and installed acceptance remain open. See
[native volume root protection](#native-volume-root-protection).

Earlier C5 progress: the Windows controller, pinned helper and worker coordinator
now carry both format checkpoints after the complete creation/volume history.
Format creation requires renewed authority and exact canonical acknowledgements;
recovery requires all thirteen records and cannot resume writes. The compiled
protocol passes 5,602 checks across 67 sessions in each normal/AddressSanitizer
build; 152 focused worker tests and the eight-case helper/Gateway regression pass.
Physical formatting/recovery, protection, mounting, quotas, protected execution
and installed-service acceptance remain open. See
[controller format continuation](#controller-format-continuation).

Earlier C5 progress: shared contracts, SQLite/PostgreSQL persistence and the
protected Gateway/worker exchange now retain both format checkpoints after the
complete creation and volume histories. Four SQLite and four real PostgreSQL
scenarios pass, including rollback, replay and expiry/revocation refusal. The
contracts accept exact native normal/AddressSanitizer records, and 51 worker and
49 Gateway tests pass. Controller/helper format transport, physical formatting,
protected execution and installed-service acceptance remain open. See
[canonical format checkpoint exchange](#canonical-format-checkpoint-exchange).

Earlier C5 progress: the native provisioning journal now retains formatting intent
and completion after its unchanged creation and volume histories. Exact canonical
acknowledgements and renewed authority precede progress; recovery refuses partial
formatting or omitted/mismatched canonical records. The native job lane passes
3,641 checks in each normal/AddressSanitizer build, including 1,094 journal checks.
Controller protocol regression and the eight-case helper/Gateway lane also pass.
Canonical storage and transport integration, physical formatting/recovery,
protected execution and installed-service acceptance remain open. See
[durable native format journal](#durable-native-format-journal).

Earlier C5 progress: native NTFS formatter source now requires a bound recorded
volume, an independently acknowledged intent, current authority at submission,
kernel readback and an acknowledged completion record. Uncertain outcomes cannot
resume formatting. It passes 1,262 component and 24 read-only Windows checks in
each normal/AddressSanitizer build; the native job lane passes 3,133 checks in each.
Controller/canonical-journal integration and physical formatting remain open.
See [native NTFS formatter](#native-ntfs-formatter).

Earlier C5 progress: native source can now bind the volume for a fully recorded
VHDX/GPT data partition. It checks device number, exact extent and partition
identity, rejects ambiguous names, and rechecks both the held handle and current
volume name. The focused lane passes 348 checks in normal and AddressSanitizer
builds, and ARM64 compiles. The native job lane passes 1,871 checks in each build.
This is a prerequisite for formatting; physical binding and formatting have not
run. See [native volume binding](#native-volume-binding).

Earlier C5/HX-507 progress: assignment-runtime reads now include the last retained
authenticated request for the exact worker generation. Contact freshness uses
the database's acceptance time and a fixed 60-second window; replay, client clock
skew and reading the record cannot extend it. Missing pruned history is unknown,
and live connection status remains unavailable. Six SQLite and six PostgreSQL
scenarios, 15 contract tests, 45 Gateway tests and 13 nonce regressions pass. See
[authenticated worker contact](#authenticated-worker-contact).

Earlier C5/HX-507 progress: the operator assignment-runtime endpoint now reads
retained usage, outstanding budget holds, cell state/capacity and artifact/effect
summaries from storage. Reads do not run usage recovery or mutate runtime state;
they reject changes of assignment generation during composition. Four SQLite and
four PostgreSQL scenarios, 13 contract tests, 45 Gateway tests and 29 existing
usage tests pass. Live connection health and UI consumption remain separate work.
See [worker assignment runtime read API](#worker-assignment-runtime-read-api).

Earlier C5 progress: the controller, pinned helper and worker coordinator now
carry all eleven provisioning records and numbered checks against the current
canonical history. Volume creation requires renewed authority before each next
checkpoint and before success; recovery requires the exact six retained volume
records and never resumes writes. The compiled protocol passes 2,476 checks in
each normal/AddressSanitizer build, and 132 focused worker tests pass. Actual
installed-service and attached-disk acceptance, formatting, mounting, quotas,
protected execution and normal assignment startup remain open. See
[controller volume continuation](#controller-volume-continuation).

Earlier C5 progress: canonical storage and the protected assignment exchange now
retain all six volume checkpoints alongside the unchanged creation records.
SQLite and PostgreSQL reject stale claims, out-of-order writes and replacement;
the protected owner rechecks assignment and admission authority before commit.
Gateway and worker acknowledgements bind the exact volume bytes. Legacy creation
coordinators refuse volume recovery until their native protocol supports it.
Controller continuation, actual attached-disk proof, formatting, mounting, quotas
and normal assignment startup remain open. See
[canonical volume checkpoint exchange](#canonical-volume-checkpoint-exchange).

Earlier C5 progress: the native provisioning journal now composes attachment and
GPT layout with six additional flushed, acknowledged records in the same
protected file. Its original five creation records and storage reservation remain
intact. Complete volume recovery requires all six independently retained records
and current native verification; partial or mismatched histories cannot resume
writes. Shared contracts decode the same outer and nested record chains. The
Gateway/controller transport for these new records, actual attached-disk proof,
formatting, mounting, quotas and assignment startup remain open. See
[durable native volume journal](#durable-native-volume-journal).

Earlier C5 progress: the retained provisioning plan now determines the GPT disk
and data-partition identifiers in both native code and the protected Gateway
exchange. The existing five recovery records remain unchanged. Shared contracts
validate the four layout checkpoints and their ordering. Normal and
AddressSanitizer native builds each pass 1,241 checks; the native provisioning
bridge and focused contract/worker/Gateway checks also pass. The durable layout
bridge, actual attachment/layout execution, formatting, mounting, quotas and
normal assignment startup remain unfinished. See
[canonical GPT identity and checkpoint contracts](#canonical-gpt-identity-and-checkpoint-contracts).

Earlier C5 progress: native volume preparation has GPT initialization and
partitioning source with separate intent/completion checkpoints, current-authority
checks, bounded driver I/O and exact layout readback. Recovery verifies completed
records without resuming writes. Normal and AddressSanitizer builds each pass
1,235 checks, including 172 layout component cases. The production provisioning journal and Gateway
still need to compose this owner and freeze its GPT identifiers; real disk layout
execution, formatting, mounting, quotas and assignment activation remain open.
See [native GPT layout source](#native-gpt-layout-source).

Earlier C5 progress: native volume preparation now has a device owner which starts
from an independently retained VHDX attachment, verifies the opened device's
backing-file dependency and virtual length, and rejects arbitrary disk locators.
The normal and AddressSanitizer native lanes pass 1,063 checks each, including
65 dependency-metadata/refusal cases. Real attached-device binding remains in
the explicit privileged acceptance lane and is unverified here. Partitioning,
formatting, mounting, quotas and normal assignment activation remain source work.
See [bound virtual-disk device source](#bound-virtual-disk-device-source).

Earlier C5 progress: a worker coordinator now consumes the canonical creation
decision, retains a local stop marker, and serially acknowledges the exact native
checkpoints through the protected Gateway exchange. Its Windows composition reads
installed custody, uses each current rotated lease, selects only the installed
controller path, and cancels on lost authority. Restart recovery cannot recreate
resources. All 98 focused worker cases and the eight-case native provisioning
lane pass; the latter includes real helper creation/recovery and a lost-ACK case
under temporary component fixtures. See [worker native provisioning startup](#worker-native-provisioning-startup).
Normal assignments still need the protected execution platform and its explicit
startup wiring. Installed-service and physical/live acceptance remain open; the
native backend stays inactive.

Earlier C5 progress: Gateway preparation now commits the native profile, canonical
capacity reservation, provisioning claim and immutable plan in one transaction.
Only its first successful commit returns `create_once`; retries return
`reconcile`. Assignment state and retained signed installation evidence supply
profile bindings, and the Gateway supplies resource limits. The protected route
and worker client expose this decision without accepting worker-authored policy
or approval fields. See [canonical native cell preparation](#canonical-native-cell-preparation).
Normal worker startup still needs to consume that decision and drive native
creation/recovery. Protected execution and installed-service/live acceptance
remain unfinished; the native backend stays inactive.

Earlier C5 progress: the pinned provisioning helper has a read-only installed
custody query. It admits the restricted worker and verifies installed helper,
controller and directory identities before returning a bounded binary snapshot.
The worker reader checks current authority before and after the query and joins
its owned process on refusal or cancellation. All 49 focused worker cases pass;
normal/AddressSanitizer codec and identity checks and the seven-case provisioning
regression pass separately. See [installed custody startup query](#installed-custody-startup-query).
Positive installed-service admission, canonical native profile/claim creation,
normal assignment startup and protected execution remain unfinished. The native
backend stays inactive.

Earlier C5 progress: protected assignment settlement now carries bounded native
provisioning snapshots and checkpoints. Storage rechecks the current credential,
mesh admission, exact assignment lease and provisioning claim in the checkpoint
transaction; worker responses verify the complete canonical record chain. The
exchange is wired to the Gateway's asynchronous storage owner. Six SQLite and
disposable PostgreSQL cases pass, alongside focused contract, Gateway and worker
checks. See [protected assignment provisioning exchange](#protected-assignment-provisioning-exchange).
Native profile/claim creation, installed custody, helper startup from normal
assignments, protected execution and live acceptance remain unfinished. Reading
a prepared plan does not authorize native creation; the native backend stays inactive.

Earlier C5 progress: the worker package includes the dedicated controller, and the
installer stages its stopped service and protected image/directory custody record.
The installer lane passes 33/33, including PowerShell 5.1/7, native custody and
descriptor compatibility, and reproducible x64/ARM64 controller builds. A fresh
x64 ZIP passes extraction, both package readers and foreground probes. See
[controller package and installation custody](#controller-package-and-installation-custody).
Actual elevated installation/startup, installed-controller/Gateway acceptance,
stock assignment composition, protected execution and live acceptance remain open.
The native backend stays inactive.

Earlier C5 progress: the provisioning helper now has an authenticated controller
mode that forwards canonical checkpoint acknowledgements without direct-mode
fallback. The client/server protocol lane passes 419 checks in each native build
across 26 sessions. The helper/Gateway lane passes 6/6, and the TLS lane passes
with reproducible x64/ARM64 helper images. See
[controller request and checkpoint forwarding](#controller-request-and-checkpoint-forwarding).
These are separate current-user protocol and direct-helper Gateway proofs;
positive installed-controller/Gateway acceptance remains open. Controller
installer/package integration, stock assignment composition, protected volumes
and live acceptance remain unfinished. The native backend stays inactive.

Earlier C5 progress: the worker-side controller identity owner now binds a connected
pipe to its retained server process, current SCM instance, dedicated token and
independently installed image. Shared custody checks keep the protected cells
parent private to the controller. The client identity lane passes normal and
AddressSanitizer execution with two separate server processes per build; the
shared query-only inspection regression passes 121 checks per build. All 47 signer
packaging checks and the controller identity/transport/protocol regressions pass.
See [worker-side controller authentication](#worker-side-controller-authentication).
The provisioning helper still needs to use this owner for request forwarding and
canonical Gateway acknowledgements. Installed service, package integration,
protected volume composition and live acceptance remain unfinished; the native
backend stays inactive.

Earlier C5 progress: the controller service source now composes installed identity,
the protected local listener, bounded request handling and the native provisioning
journal. The protocol lane passes 205 checks in each normal/AddressSanitizer build,
including nine local sessions, five-checkpoint creation/recovery and malformed or
revoked-request refusal. The compiled service refuses interactive launch. See
[controller service and provisioning protocol](#controller-service-and-provisioning-protocol).
This is current-user component proof: the worker-side client, canonical Gateway
bridge, installer/package integration and positive installed-service acceptance
remain unfinished. The native backend stays inactive.

Earlier C5 progress: native pipe transport now matches a retained client process
to the kernel's identification token, rejects changed or exited callers, and
drains bounded I/O on cancellation or timeout. The local lane passes 121 checks
in each normal/AddressSanitizer build, using six separate client processes and
seven pipe fixtures. Worker/controller identity regressions pass separately. See
[controller pipe identity and I/O](#controller-pipe-identity-and-bounded-io).
The installed service/client, provisioning request protocol, volume composition
and physical acceptance remain unfinished. These primitives do not activate a
listener or a native backend in the current worker package.

Earlier C5 progress: the dedicated cell-controller identity and custody owner now
compiles and passes 248 checks in each normal/AddressSanitizer build. Actual OS
token and SCM queries prove interactive-process refusal without privilege changes;
positive installed-service custody remains unverified. The existing native cell
lane separately passes 998 checks in each build. See
[controller identity admission](#dedicated-cell-controller-identity-admission).
The controller service, authenticated IPC, volume composition and physical
acceptance remain unfinished; this owner is not in the current worker candidate.

Earlier C5 progress: PowerShell installation now requires the same native images
as the JavaScript package verifier. The named installer lane passes 31/31, and a
fresh worker ZIP passes both package readers after extraction. Its bundled runtime
pins the new provisioning helper and completes five checkpoints plus fresh helper
recovery with a controlled acknowledgement sink. See
[installer parity and the current package](#installer-inventory-parity-and-current-worker-package).
Installed service custody, privileged volume composition and physical acceptance
remain unfinished.

Earlier C5 progress: a pinned native process now connects the checkpoint coordinator
to protected workspace and unattached backing-file creation. The joint local lane
passes canonical commits, fresh helper recovery, lost acknowledgements and
cancellation. Normal and AddressSanitizer protocol checks verify refusal and an
independent native watchdog. See [the native process bridge](#native-provisioning-process-bridge).
Installed service, protected volume/credential composition, broader assignment
wiring and physical-host acceptance remain unfinished.

Earlier C5 progress: canonical storage now retains an immutable native provisioning
plan and all five exact journal checkpoints. The coordinator commits each checkpoint
before acknowledgement and treats a replay as recovery. The native journal requires
an exact-digest acknowledgement before the next resource operation. Normal and
AddressSanitizer builds each passed 998 checks, including 301 journal checks, and
their actual records passed the shared TypeScript decoder. SQLite, actual PostgreSQL,
coordinator and migration parity checks passed separately. See
[the checkpoint coordination evidence](#canonical-provisioning-checkpoint-coordination).
The installed native process bridge, volume/credential composition and physical-host
acceptance remain unfinished.

Earlier C5 progress: canonical cell provisioning now uses database time for claims
and requires the exact, unexpired claimed lease before recording a ready platform.
The mutation itself rechecks owner, lease and expiry. SQLite and actual PostgreSQL
regressions exercise backdated/future caller clocks, owner-name reuse and a lease
that expires while the publication transaction is open. See
[the canonical provisioning lease evidence](#canonical-provisioning-lease-authority).
The checkpoint owner is added below; installed service composition, protected volume
integration and physical-host acceptance remain unfinished.

Earlier C5 progress: a protected native provisioning journal now records intent
before workspace and fixed-disk creation and persists their verified identities
afterward. Recovery uses the independently retained plan and journal identity;
interrupted creation remains uncertain and cannot be retried by a recovered owner.
Normal and AddressSanitizer builds each passed 941 checks, including 244 journal
checks for real creation, fresh-process recovery, changed identities, corruption,
allocation and actual creation conflicts. See
[the provisioning journal evidence](#protected-native-provisioning-journal).
Canonical service composition, protected volume integration and physical-host
acceptance remain unfinished.

Earlier C5 progress: the native cell acceptance suite now has a portable test
bundle with pinned Node, normal/AddressSanitizer executables and their runtime
dependencies. A fresh ZIP extraction passed 697 checks in each native build;
the explicit volume preflight still rejects this session's missing privilege.
See [the portable acceptance evidence](#portable-native-cell-acceptance-bundle).
The bundle prepares mini-PC testing; service/volume integration and physical-host
acceptance remain unfinished.

Earlier C5 progress: destination HTTP MCP now supports a separately pinned bearer
credential, with actual worker/Chat restart and portable package proof. Credentials
remain outside filesystem tool roots and changed bytes prevent dispatch. See
[the bearer authentication evidence](#destination-mcp-bearer-authentication).
Installed registry configuration also has a packaged operator command, immutable
generations and native file protection.

Latest C6 progress: the pinned Hermes runtime passed all four controlled
scheduled-delivery checks with six synthetic model calls, one simulated Telegram
acknowledgement and no duplicate during 31 seconds after a new Gateway process
started. Its native fire claim, execution ID, process birth time and send-time
snapshot bind the acknowledgement to the scheduled occurrence. All 174 local
comparison tests passed, including a real SQLite writer-contention regression.
Controlled scheduled-delivery and skill journeys now have passing receipts for
all three runtimes; equivalent campaign policies, clean-pinned GoatCitadel proof
and live acceptance remain open. See
[the Hermes delivery evidence](#hermes-native-scheduled-delivery).

Earlier C6 progress: the pinned OpenClaw runtime passed all four controlled
scheduled-delivery checks with three synthetic model calls and one simulated
Telegram acknowledgement. Its owned Gateway process was stopped and a new
process reopened the same state; delivery evidence stayed unchanged for more
than 30 seconds. All 147 comparison tests and scoped lint passed. Native
send-time queue/task/run-receipt snapshots establish the exact scheduled
occurrence even though public history omits its run ID. See
[the OpenClaw delivery evidence](#openclaw-native-scheduled-delivery).
The subsequent Hermes proof is recorded below; equivalent campaign policies and
live acceptance remain open.

Earlier C6 progress: a read-only GoatCitadel delivery observer follows the canonical
cron occurrence, Chat child, connector child and acknowledged channel row, then
observes reconnect for at least 30 seconds. All 127 local comparison tests passed.
Actual Gateway testing exposed and now has focused fixes for cron minute drift,
creation of a new scheduler Chat and normal-cadence settlement of admitted runs.
Channel arguments now survive approval persistence, cron follows the exact channel
record after queue admission, and transport success requires an explicit send
outcome. Native durable IDs can be inspected through their defined API routes.
The latest controlled working-build run passed all four scheduled-delivery checks:
one approved simulated Telegram send, canonical queue/approval/provider linkage,
and stable delivery evidence for 30 seconds after closing and reopening Gateway.
SQLite 220 / PostgreSQL 165 add immutable per-part handoff records; approval waits
resume the same attempt and replay acknowledged parts without resending them.
Cross-product channel campaigns and live acceptance remain open. See
[the handoff and reconnect proof](#queued-approval-handoff-and-reconnect-proof).

Earlier C6 progress: the pinned Hermes runtime now completes native skill capture,
typed artifact/action review, native CLI approval, and actual skill loading in a
new session. Its fresh controlled campaign passed all six independent checks with
13 synthetic model calls and zero upstream requests. All 115 local comparison
tests passed. Windows file bytes and model-loaded instruction text have separate
reviewed hashes. See [the Hermes skill workflow](#hermes-native-skill-workflow).

Earlier C6 progress: the pinned OpenClaw runtime completes native skill capture,
typed artifact/action review, exact-version activation, and reuse in a new session.
The fresh controlled campaign passed all six independent checks with 11 synthetic
model calls, zero upstream requests, and complete bounded evidence assembly.
All 105 local comparison tests, scoped lint, and documentation checks passed.
See [the OpenClaw skill workflow](#openclaw-native-skill-workflow).

Earlier C6 progress: all 96 local comparison tests passed. A fresh actual
GoatCitadel working-build run passed capture, exact artifact review, native
activation and reuse in a new Chat, including all six independent outcome checks.
Two runtime repairs now preserve canonical approved-tool completion evidence and
release completed turns whose post-commit writes were correctly blocked by policy.
See [the native skill-workflow evidence](#goatcitadel-native-skill-workflow-in-progress).
Campaign assembly now verifies that bounded phase bundles preserve every raw
snapshot before using them in its receipt list. Revalidation of the retained
405-snapshot run passed all six outcome checks with six top-level receipts. See
[the campaign evidence repair](#bounded-native-workflow-campaign-evidence).
Earlier separate controlled checks passed Hermes approval, denial and turn
cancellation, with bounded native transcript export. See
[the Hermes evidence](#supervised-hermes-approval-and-resume),
[GoatCitadel approval evidence](#supervised-goatcitadel-approval-and-resume)
and [OpenClaw campaign evidence](#supervised-openclaw-approval-and-resume).
Equivalent cross-product skill/channel campaigns and live acceptance remain unfinished.

## Local source and proof

| Area | Implemented behavior | Evidence and limits |
| --- | --- | --- |
| C0 | Provider readiness, model-facing tool-result projection, and memory retrieval quality have bounded owners. | Focused tests and the later named architecture, typecheck, build, and async-boundary checks passed; broad receipts remain separate below. |
| C1 | Progressive model setup, refreshed onboarding state, and a first-task indicator derived from canonical completed Chat traces. | Browser proof used a deterministic provider. OAuth/API-key/local-provider live acceptance is pending. |
| C2 | Capture a completed workflow with settled tool-result identities, draft or revise a skill, reject private values, stage bounded immutable artifacts, review exact bytes, approve separately, and reuse only an active trusted version in its workspace. | The controlled browser journey activated the reviewed candidate and a new Chat loaded its exact instruction hash. Source-result drift, oversized evidence, and private-path/value checks passed. This is not live-model skill-quality evidence. |
| C3 | Versioned asset bindings, approval-governed execution, independent child review, recoverable verification, byte-pinned MCP installation, and owned compensation. | Browser QA performed actual Playwright navigation, click, snapshot, and screenshot. Settings rollback disabled only its owned MCP server. Skills/settings reversals require separate owner review and unchanged revisions; later edits are preserved. |
| C4 | Renewed progress signals, bounded setup-test cache freshness, canonical accepted-ingress timing, and operator-visible channel delivery evidence. | `verify:channels:parity` passed locally. Telegram is selected for live acceptance; destination and spending limits are pending. |
| C5 | Canonical inference/permission binding, expiring spending grants, per-attempt LlmService accounting, CAS verification, artifact/terminal recovery, and a bounded model/tool loop. Admission freezes prepared history and current capabilities; production uses the governed memory/hook pipeline. Placement includes supported tool profiles and requires the worker's governed-tool capability. SQLite 216 / PostgreSQL 161 add an immutable generated execution task for ordinary Chat without a caller-supplied task. Static and requester-scoped native MCP placement and approved execution use their current Gateway authority and policy owners. The foreground destination registry has filesystem read/write and anonymous/bearer HTTP MCP owners. | Stock built-Gateway restart cases cover text and approved tools with existing/generated tasks, static/requester MCP and destination mesh tools. Destination reads, writes and HTTP MCP have actual worker and Chat approval/restart proof. Bearer credentials have exact-byte/configuration binding, root separation and portable package proof. Requester MCP fixtures use a synthetic resolver; production requires current authority. Protected bundle installation and installed-image AppContainer launch have native proof. Additional destination tools, OAuth/stdio MCP, broader placement, delegation/council, protected native volume/executor/custody/service composition, retained-credential reconciliation, physical two-machine acceptance, and live provider quality remain unfinished. |
| C6 | Pinned fixtures/prices, supervised loopback transport, fsynced combined request/cost accounting, five independent task verifiers, native launch profiles and permission probes, retained permission-review evidence, supervised skill/delivery controls, and GoatCitadel/OpenClaw/Hermes native skill workflow and approval adapters. | All 174 local comparison tests passed. Fresh controlled GoatCitadel working-build, pinned OpenClaw and pinned Hermes scheduled-delivery runs each passed all four independent checks with one simulated Telegram acknowledgement and zero upstream requests. GoatCitadel proves queue/approval/provider linkage across a Gateway reopen; OpenClaw and Hermes prove exact native dispatch linkage across distinct Gateway processes. Each observes at least 30 seconds without duplicates. Hermes's in-process send is bound to its fire claim and execution ledger; its detached-worker queue is a separate path. Separate fresh controlled GoatCitadel working-build, pinned OpenClaw and pinned Hermes skill journeys passed all six independent outcome checks with zero upstream requests. Hermes uses staged native tool results, typed review, actual CLI approval, ledger/file hashes and a new-session skill_view result. Its pending-ID approval has no native expected-hash check; the adapter checks exact installed bytes and separately hashes Python's newline-normalized instruction text. Campaign assembly preserves every raw snapshot in bounded phase bundles and keeps controlled provenance explicit. Earlier separate controlled runs cover terminal approval, denial and cancellation. Hermes skill/terminal approval requires a real terminal; operator-review stdout is visible but not captured or byte-limited, while native transcript and stderr are bounded. Reports with missing, unknown or differing policies cannot claim comparability. Clean-pinned GoatCitadel campaign proof, equivalent campaign policies and live acceptance remain pending. |

The retained stdio process owner serializes a conversation's calls and separates
conversation/actor scopes. It closes processes on idle expiry, disconnection,
configuration change, failure, or Gateway shutdown. This is process ownership and
browser-state continuity, not hostile-code or filesystem isolation. Discovery and
unscoped calls retain their existing one-shot behavior.

Browser QA 2.1.0 binds all three reviewed npm archive integrities and the exact
182 installed runtime-file hashes. First installation uses the Gateway network
allowlist and the platform archive extractor; it does not run npm lifecycle
scripts or resolve floating dependencies. Each new process launch checks the
current package files. Corrupt existing installations are rejected and retained
for inspection. This does not isolate a trusted stdio server from its host.

Pack rollback retains registrations and downloaded evidence. MCP configuration
changes carry a server-authored plan/revision marker, invalidated by ordinary
operator edits. Child reversals re-enter capability lifecycle or runtime settings;
the parent does not grant its own approval to those operations.

Worker claims and renewals retain their proposed secrets before sending. A lost
response replays the exact pending request before synchronizing current authority.
Failed local persistence leaves the previous credential/lease visible; concurrent
vault writes serialize. During inference the worker renews and checks canonical
control, aborts on uncertain authority or expiry, and drains pending renewal before
using the rotated lease for subsequent transcript writes. A recovered canonical
transcript watermark prevents renewal from moving acknowledged progress backwards.
Transcript and settlement mutations serialize and become visible only after the
durable write succeeds. Restart verifies the saved transcript prefix, including
acknowledged entries, before retaining a missing suffix. Inference projections
carry the hashed canonical provider-attempt list, so recovery retries are retained
alongside the final attempt rather than disappearing from worker-side evidence.
Continuous foreground operation now waits between offers and completed assignments,
rejects competing processes sharing its retained state, and stops on uncertain
outcomes. Shutdown reaches every owned transport request. This is not an installed
Windows service or protected native credential custody; aborting a worker's
connection does not prove an upstream model request was cancelled without cost.

The worker inference adapter uses the canonical LlmService and rechecks the current
capability profile, permission, provider route, generation, parent run, worker
lease, and spending grant. An already claimed inference may span a valid parent
heartbeat; new work and artifact publication still require current exact
authority. Parent takeover or expiry aborts the request and prevents publication.
The native listener retains its TLS handshake/header/request bounds; a raw-socket
timeout that incorrectly remained active after TLS admission was removed. A
separate real TLS test verifies a response after 5.25 seconds, and the missing-
handshake and trickled-header tests still reject stalled clients.

Unknown provider usage retains the complete request/cost reservation. A guarded
failure before HTTP dispatch now retains a canonical owner-authored no-dispatch
receipt. Only that exact receipt releases unused capacity; an operator's belief,
an empty usage inventory, or a completed inference with zero dispatches is not
sufficient. The same cases are exercised through SQLite and PostgreSQL owners.
No provider usage or paid attempt is fabricated to settle a zero-dispatch result.

Worker artifact upload retains its intent before sending, validates open/part
replay bytes and declared metadata, and commits only an exact verified response.
Terminal settlement is retained before transport and replayed after restart
without another provider call. Authenticated inference has a separate 90-second
execution deadline after its complete bounded request arrives. Handshake, header,
and body admission deadlines remain short. A real worker process completed a
32.5-second controlled model call. This remains synchronous bounded inference
with retained text and provider tool requests. The bounded iterative Chat tool
loop is described below; unbounded inference streaming is not implemented.

Worker tool intents load their exact retained arguments and frozen tool owner,
then enter the canonical invocation and external-effect owners. The durable
boundary is awaited before an external call, including approved plugin replay.
Completed effects correlate to canonical Chat tool-run evidence. Lost responses
replay retained settlements; unknown outcomes require reconciliation. An approval
raised after a hook effect stays linked while that effect remains uncertain.
Requester-scoped MCP and mesh publication require their own canonical execution
contexts and are not enabled through this worker path.

The Gateway now has an internal offer-creation service for admitted durable Chat
turns. It reads the canonical task, profile and routed-context bindings and checks
current capability and permission authority. The repository rechecks the durable
claim and mutation admission after that asynchronous preflight, with creation and
validation in one transaction. Exact retries retain one offer; changed limits,
stale claims and invalid post-insert admission roll back. Offer identity binds the
original admitted actor, so a replacement Gateway can replay it under a fresh
durable claim; the old process remains fenced out. Recovery preserves the offer,
manifest and deadline. The service derives its deadline from the original
admission. Durable Chat now invokes production placement before either runner
starts. The placement ledger and offer commit together under the same admission
and durable-lease guards. An existing local choice rejects later worker offers;
an existing worker choice never falls back to local execution. The connected-worker
heartbeat harness seeds an admitted task-bound turn, admits an idle real worker,
and calls production placement to create its first offer. The complete tool and
delegation workflow remains on the local runner until the worker implements it.

Task-bound Chat admission now retains exact prepared history, guidance, activated
skill instructions and routed context before binding the durable run. The new
SQLite/PostgreSQL snapshot is immutable and bound to the admitted actor, request,
turn, capability profile and run metadata. Exact replay retains one snapshot;
changed bytes or stale claims fail. A replacement Gateway verifies and restores
that history before dispatch instead of adopting changed live history. Missing
context fails before preparation. The worker preserves message roles, tool-result
identities, Unicode and structured attachment parts, and the Gateway compares
the inference input against its stored snapshot before model dispatch. QMD memory
and inline completion hooks run after that snapshot in the canonical completion
path. They are not frozen by the prepared-history snapshot.

The completion guard now surrounds preparation, deferred stream iteration, JSON,
multipart and Gateway-owned embedding dispatch preparation. Memory utility calls
retain their own operation/generation, the parent operation, worker/turn/run scope,
and cancellation signal. Each related dispatch reserves one additional request
and bounded cost from the parent's grant; retries consume another reservation.
Both root and related reservations contribute to the same operator balance.
Canonical terminal usage settles actual costs, while unknown or unpriced usage
keeps its hold through revocation and restart. Only an exact owner-authored
no-dispatch record can release unused capacity. Embeddings without enforceable
model bounds/pricing are blocked before HTTP under this worker scope. This does
not yet implement the full tool/delegation loop, asynchronous
workflow recovery or protected native execution.

A controlled browser fixture verified initially blank limits, the exact review
dialog, authorization/balance display, and revocation with uncertain charges
still reserved. Visual inspection led to scoped Ops modal styling, canonical
theme tokens, and improved spacing. The fixture never authorized live spending;
its screenshots are retained in the task's browser tool output. Its owned server
and temporary browser tab were stopped after verification.

Approval replay still checks current policy, server trust, enabled tools, auth,
and capability scope. A canonical owner event is required to label an approved
failure as occurring before dispatch. Missing or conflicting evidence remains
uncertain. No external effect is automatically replayed after an ambiguous result.

## Retained local receipts

Run directories are under `artifacts/verification/` in the implementation checkout.
They are generated local evidence and are not release certification.

- `2026-09-09T07-13-31-142Z-comparison-browser-70ba1c9d`: exact skill review,
  activation, new-session skill load, and separate Browser QA child approvals.
  Reused skill instruction SHA-256:
  `5279192f0b15158758f0c145e8ff773be20d7b2f32714c30be51492fdaa2ca02`.
- `2026-09-09T07-27-31-539Z-comparison-browser-5fa9d46d`: restart reconciled the
  pack parent from canonical completed child plans without duplicating assets.
- `2026-09-09T08-06-21-880Z-comparison-browser-79eb4e26`: actual Playwright
  navigation, click, snapshot, and screenshot through four separately approved
  Chat invocations. The snapshot and image show `Check completed`.
  Screenshot SHA-256:
  `488fde21f09f324faec01e43899b75652539b900b5bc6eccfab1d5f96cd24590`.
  A separate policy-change scenario prevented dispatch and exposed a storage
  projection issue; the subsequent repository regression covers its correction.
- `2026-09-09T08-39-30-087Z-reviewed-mcp-package-86590320`: a fresh reviewed
  package download, real tool discovery, and rejection of a modified runtime file.
  Package manifest SHA-256:
  `c6b50edf2e9b4178ea076f34d3b1e3bcadabc8c7125877eefb5a96421ddd6ebd`.
- `2026-09-09T08-51-20-778Z-comparison-browser-b2a672e1`: Browser QA 2.1.0 setup
  completed, all four browser operations passed, and Settings rollback produced
  canonical `rolled_back` state with the owned MCP registration disabled. The
  screenshot has the same SHA-256 as the earlier fixture image. A policy denial
  now reads as `effectDisposition: none` / `pre_dispatch_blocked`; its first harness
  assertion used a nonexistent field, so the corrected check is retained separately
  in `pre-dispatch-trace-verification.json`. Visual inspection led to subsequent
  Settings receipt-style and rollback-description corrections.
- `2026-09-09T09-24-48-232Z-comparison-browser-23bcdb5e`: fresh Settings browser
  review verified the corrected receipt styles, readable rollback dialog, and
  rollback-specific description. Confirming through the UI produced the canonical
  rolled-back plan retained in `pack-rollback-ui-proof.json`.
- `2026-09-09T09-00-10-821Z-durable-recovery-3d187a3d`: durable recovery lane passed.
- `2026-09-09T09-10-09-332Z-runtime-truth-5e39b657`: runtime truth lane passed.
- `2026-09-09T06-54-59-033Z-remote-workers-c43fbb00`: complete remote-worker lane
  pass, including actual PostgreSQL. The conditional two-machine lane was skipped.
- `2026-09-09T09-31-57-538Z-remote-workers-5d057d96`: a later complete remote-worker
  lane pass with 15 PostgreSQL tests. It precedes the new inference heartbeat;
  the physical two-machine scenario was still skipped.
- `2026-09-09T10-29-39-857Z-remote-workers-65d67238`: remote-worker lane passed
  after the heartbeat and canonical watermark changes, including 15 PostgreSQL
  tests and the spawned protocol probe. It does not execute inference or artifact
  settlement in that spawned process; the two-machine scenario remains skipped.
- `2026-09-09T11-13-24-718Z-remote-workers-cc967750`: the final worker lane passed
  after transcript/settlement publication and provider-attempt receipt fixes.
  All 12 checks passed, including 179 Gateway tests, the spawned kill/restart
  probe, and all 15 PostgreSQL tests. The two-machine scenario was skipped;
  the spawned probe still excludes inference and artifact/effect submission.
- `2026-09-09T11-16-40-337Z-auth-matrix-719e0e82`: both authentication scenarios
  passed against an isolated Gateway, covering route principals and basic-auth
  restart/device revocation. This does not prove live provider OAuth onboarding.
- `2026-09-09T10-39-20-342Z-comparison-cli-fa7cdb97`: a real child invocation of
  the supervised comparison CLI verified clean-source preflight, initial fixtures,
  deadline shutdown, empty journal export, and lock release. It sent zero provider
  requests and ran no product agent; this is controlled CLI-lifecycle proof only.
- `2026-09-09T06-58-33-897Z-code-mode-hostile-sandbox-32fb71bf`: eight Windows
  canaries passed. This does not certify native remote-worker execution or other OSes.

Earlier failures remain in their own run directories. The initial broad fast run
`2026-09-09T05-08-10-612Z-fast-505e1d89` failed; later focused fixes and passes do
not turn that receipt into a green run. In particular, earlier browser runs
exposed first-use approval, one-shot MCP state loss, local-web intent, and
deterministic auxiliary-response sequencing problems. They are not passing runs.

The later selected fast run `2026-09-09T08-13-55-581Z-fast-e46d2181` passed nine
lanes: repository hygiene, storage migration parity, workspace typecheck, Gateway
shard 1, libraries, Mission Control, build, docs, and Gateway async boundaries.
Shard 3 failed one outdated lifecycle fixture that omitted the new MCP session
owner. Its corrected focused run passed all 13 tests. That does not rewrite the
failed aggregate receipt, and subsequent package/compensation changes have their
own focused checks.

The full fast run `2026-09-09T09-35-46-121Z-fast-732f05bf` passed 20 checks and
failed Gateway shard 2 on another outdated shutdown fixture. The corrected fixture,
two related lifecycle fixtures, and the updated capture checks passed 44 focused
tests. That full receipt remains failed. New comparison transport and worker
heartbeat checks ran separately after parts of the full lane had completed.

The full fast run `2026-09-09T10-30-35-157Z-fast-178141c3` passed all 21 checks.
The final comparison shutdown/restart tests and worker transcript/usage changes
were made after some of its earlier checks, so their focused and subsequent
subsystem results remain separate; this is not an exact-revision release receipt.
An overlapping standalone hygiene retry failed on the fast run's active output
lock. It did not bypass the lock or modify the earlier passing hygiene result.
The standalone retry after the lock was released passed all 821 script tests,
repository hygiene, and supply-chain posture checks. Its log is retained locally
at `.tmp/comparison-hygiene-final.log`. The final Gateway and worker typechecks,
49 worker tests, 12 execution-protocol tests, and scoped ESLint also passed.

No live-provider request, credential refresh, external-channel message, packaged
installation, commit, push, or release has been performed for this sequence.

Later worker receipts remain separate from the earlier ones above:

- `2026-09-09T17-49-05-387Z-remote-workers-87513dff`: local checks passed but all
  PostgreSQL connections were refused immediately after readiness. This receipt
  remains failed. The cause of that cluster's exit was not established.
- `2026-09-09T18-06-42-631Z-remote-workers-b8598d03`: all twelve checks passed,
  including 17 PostgreSQL tests and four worker-process scenarios. The harness
  now retains bounded per-attempt PostgreSQL server/stdout/stderr logs and permits
  one fresh-cluster retry for connection failures; this run passed on attempt one.
- `2026-09-09T18-23-47-940Z-remote-workers-fdcef2fb`: all twelve checks passed after
  adding the empty-inventory/completed-without-dispatch budget cases. PostgreSQL
  passed on attempt one. The final modal styling has subsequent browser and
  focused UI proof; it does not turn this into an exact-revision release receipt.
- `.tmp/comparison-no-dispatch-llm-2.log`: all 28 LlmService/accounting-adapter
  tests passed. `.tmp/comparison-accounting-core-final.log`: all 15 canonical
  accounting tests passed. `.tmp/comparison-campaign-final-tests.log`: all 42
  comparison transport/fixture/verifier/native-driver tests passed in that earlier run.
- `.tmp/comparison-48-tests.log`: all 48 comparison tests passed after the native
  GoatCitadel API driver and supervised workflow controls were added. The
  generated config passes canonical schemas; shell execution remains subject to
  approval, changed provider routes stop before Chat dispatch, and pending
  approvals are retained without being resolved by the driver.
- `.tmp/comparison-goat-process-HqVoCZ/evidence/goatcitadel/thread.json`: a fresh
  native Gateway completed a controlled Chat turn. The process receipt records
  four local provider requests and normal owned shutdown. This controlled run
  used the working build, not a clean pinned live campaign.

Further implementation receipts:

- `2026-09-09T19-43-52-325Z-remote-workers-b1d8f1ce`: all twelve checks passed,
  including 209 Gateway tests and the shared production execution composition.
  PostgreSQL passed all 17 tests on its second fresh cluster. The first cluster's
  connection-refused output remains retained. Physical two-machine acceptance
  remains skipped; the generated scenario note predates the composition update.
- `.tmp/comparison-long-inference-rebuilt-tests.log`: 27 tests passed, including
  the spawned worker's 32.5-second model wait and parent takeover/expiry cases.
- `.tmp/comparison-async-tool-boundary-tests.log`: 16 policy/executor checks passed.
  `.tmp/comparison-async-plugin-boundary-tests.log`: 98 coordinator checks passed.
- `.tmp/comparison-effect-approval-tests-3.log`: all 15 runtime/settlement tests
  passed, including approval after an auxiliary hook boundary. The first two
  follow-ups used incorrect receipt-projection fields in the new test; their
  failures remain separate.
- `.tmp/comparison-worker-process-tests.log`: all 68 worker tests passed, including
  actual process exclusion and OS lock release after a killed owner. This precedes
  the atomic report-write and idle-shutdown reporting refinements. The subsequent
  `.tmp/comparison-worker-process-final-tests.log` also passed all 68 tests.
- `2026-09-09T20-09-34-077Z-remote-workers-13715158`: all twelve checks passed
  after the foreground-loop, atomic report and auxiliary-approval refinements:
  210 Gateway tests, four spawned-worker scenarios, and 17 PostgreSQL tests on
  the first cluster. The physical two-machine scenario remains skipped. An
  earlier invocation stopped in the proof-note assertions before running the
  lane; its stale wording was corrected without rewriting that failure.
- `.tmp/comparison-native-minimum-full-tests.log`: all 49 comparison tests passed
  after rejecting Hermes profiles below its native 64,000-token minimum.
- `.tmp/comparison-hermes-proxy-5IG0dp/proof.json`: the pinned Hermes CLI used the
  actual comparison proxy, read an owned fixture through its native file tool,
  returned those bytes to the model, and completed normally. All three controlled
  model calls used the configured model, reasoning `none`, and 512-token output
  ceiling. The fsynced synthetic budget journal includes the startup probe.
  No upstream network model request was made. Earlier native attempts retained
  the 32,768-token incompatibility and one 60-second startup deadline; neither
  is reclassified as a pass. A diagnostic run traced module import at 20 seconds,
  and subsequent ordinary profile and proxy/tool runs passed.
- `.tmp/native-conformance-hermes-20260909-a/proof.json` and
  `.tmp/native-conformance-openclaw-20260909-a/proof.json`: the shipped
  `agent-comparison-native-conformance.mjs` command passed for both pinned native
  runtimes. Each read the owned fixture file and returned its content in a tool
  result before final completion. Hermes used three controlled model calls;
  OpenClaw used two. Both enforced the same model, reasoning and output ceiling.
  The command made zero upstream model requests. Native approval conformance,
  terminal permissions and host isolation were not exercised. OpenClaw's pinned
  dependency installation and build also passed in the task-owned checkout.
  These are controlled adapter checks, not live benchmark scores.
- `.tmp/comparison-worker-continuous-process-proof-3.log`: both continuous-worker
  process cases passed through the real native TLS listener. One process settled
  two distinct assignments, became idle, and restarted without redispatch. The
  smaller synthetic grant admitted only the first task: the second task required
  capacity for its primary call plus a possible recovery attempt and stopped
  before dispatch. The final failure report preserves the blocked stage details.
  The first two attempts incorrectly expected that smaller grant to admit both
  tasks; those failed test receipts remain separate.
- `.tmp/comparison-worker-process-recovery-report-tests.log`: all 68 worker tests
  passed after retaining unresolved-stage details. Gateway and worker typechecks
  passed in `comparison-continuous-gateway-typecheck.log` and
  `comparison-worker-recovery-report-typecheck.log` under `.tmp/`.
- `.tmp/comparison-worker-six-process-scenarios.log`: all six spawned-worker
  scenarios passed together after these changes, including long inference,
  parent takeover/expiry, terminal recovery, continuous assignment completion
  and budget exhaustion. The run took 138 seconds. Its owned processes and
  listener closed. This is a focused follow-up, not a replacement for the earlier
  twelve-check worker lane or physical two-machine acceptance.
- `2026-09-09T21-13-42-877Z-remote-workers-bedd0400`: 214 Gateway tests, all six
  spawned-worker scenarios, and 18 PostgreSQL tests passed with canonical Chat
  offer creation. Eleven of twelve checks passed; release hygiene failed on two
  unused helpers left by fixture extraction. The helpers were removed. That
  failed aggregate remains retained separately from the later corrected run.
- `.tmp/comparison-chat-offer-recovery-before-fix.log` reproduced a replay
  conflict after an expired durable run was reclaimed by a replacement Gateway.
  `.tmp/comparison-chat-offer-recovery-after-fix.log` passed after binding the
  creator to the original admitted actor. The regression also rejects the stale
  process and requires exactly one unchanged offer; the integrated worker lane
  runs the same recovery assertions on SQLite and PostgreSQL.
- `2026-09-09T21-24-34-261Z-remote-workers-e9f9f1a6`: all twelve checks passed
  after fixing offer creator identity and removing unused helpers. This run
  includes 214 Gateway tests, six spawned-worker scenarios, and 18 PostgreSQL
  tests across ten suites on the first hermetic cluster. Both database dialects
  exercised the replacement-Gateway recovery regression. Scenario 11 remains
  the physical two-machine skip. A subsequent proof-description correction
  derives the displayed PostgreSQL suite list from the executed registry; its
  focused assertions and lint are retained in
  `.tmp/comparison-chat-offer-proof-description.log`.
- `2026-09-09T22-06-40-006Z-remote-workers-38dbd833`: prepared-context
  integration passed 109 contract tests, 147 SQLite tests, 225 Gateway tests and
  all six spawned-worker scenarios. The real provider adapter received the
  seeded conversation history. PostgreSQL passed all 18 tests across ten files
  on its second fresh cluster, including immutable context, request/durable
  claim capture, offer binding and replacement-Gateway replay. The first cluster
  stopped with a Windows interruption; its connection-refused output and server
  log remain retained without assigning a cause. Eleven of twelve checks passed;
  lint rejected the intentional control-character regex. The equivalent character
  check fixed that issue, and `.tmp/comparison-chat-context-lint-followup.log`
  passed all 240 lane targets in four chunks. The failed aggregate is preserved;
  that follow-up is separate from a fully green worker run. Physical two-machine
  acceptance remains skipped.
- `.tmp/comparison-chat-context-final-contracts.log` passed 25 contract tests
  after the lint correction. `.tmp/comparison-chat-context-worker-negative.log`
  passed six worker tests, including rejection of missing, altered, substituted
  and cross-turn context before inference submission.
- `.tmp/comparison-chat-context-migration-parity-2.log` passed the named
  migration-parity lane at SQLite 208 / PostgreSQL 153. The append-only updater
  preserved all existing migration definitions; the initial check's stale
  version-count assertion was corrected and its failed log is retained.
  `.tmp/comparison-chat-context-schema-inventory.log` passed all 56 migrator and
  schema-inventory tests.
- `2026-09-09T22-08-58-407Z-routed-context-snapshots-e2b2feef`: seven checks
  passed, including admission, frozen recovery, Gateway composition and
  typechecks. This lane's optional PostgreSQL scenario was not configured and
  remains skipped; the new worker context's real PostgreSQL proof is recorded
  separately above.
- `2026-09-09T22-10-30-043Z-durable-recovery-fecd213f`: all three checks
  passed, including a real isolated Gateway restart, approval wait/dead-letter
  recovery, worker tests and approval-resume tests. The earlier invocation
  stopped at the output lock before running and was retried after the other
  named lane released it.

## Canonical completion receipts

The subsequent canonical-completion integration retained these separate receipts:

- `.tmp/comparison-chat-workflow-guard-status-tests.log`: 102 focused dispatch,
  completion, accounting and adapter tests passed before the related-budget slice.
- `.tmp/comparison-related-migration-parity.log`: the named migration-parity lane
  passed at SQLite 209 / PostgreSQL 154 without changing existing definitions.
- `.tmp/comparison-related-completion-tests.log`: 114 tests passed and two failed.
  The failures exposed an outdated one-argument memory fixture and no-dispatch
  evidence restricted to Chat transports. The corrected completion, memory,
  multipart and embedding follow-up passed 92 tests across four files in
  `.tmp/comparison-related-completion-followup.log`.
- `.tmp/comparison-related-storage-followup.log`: 82 tests passed and a raw-index
  count assertion failed. The corrected focused inventory check passed in
  `.tmp/comparison-related-raw-inventory-followup.log`. The canonical inventory
  is 324 tables, 4,652 columns and 734 indexes; the raw registry contains 746 indexes.
- `2026-09-09T23-17-52-395Z-remote-workers-c029acba`: all twelve checks passed,
  including 109 contract, 150 SQLite, 229 Gateway and six spawned-worker tests.
  All 18 PostgreSQL tests across ten suites ran on the first hermetic cluster.
  They include both root-reservation and related-dispatch last-slot races and
  unchanged cross-dialect restart/no-dispatch assertions. The spawned worker
  asserts canonical completion hooks before provider dispatch with memory disabled.
  Memory-enabled completion and shared-budget denial have separate focused proof.
  Physical two-machine acceptance remains skipped. A subsequent wording-only
  correction updates the matrix note; the original receipt is retained unchanged.
- `2026-09-09T23-27-53-661Z-usage-reconciliation-1ca86d93`: all nine configured
  checks passed. Its optional PostgreSQL concurrency check was skipped; the
  separate worker receipt above retains the executed PostgreSQL budget proof.
- `.tmp/comparison-related-lane-registry.log`: twelve checks passed and one
  expected the old completion-limit wording. Updating that assertion to require
  the current proof and its remaining limits passed all thirteen checks in
  `.tmp/comparison-related-lane-registry-followup.log`.
- `.tmp/comparison-related-final-lint.log` passed with zero warnings, and
  `.tmp/comparison-related-budget-panel.log` passed both panel tests after the
  explanation of shared memory-call and retry limits changed.

## Worker results in Chat

The durable Chat owner now discovers an existing assignment by its exact
workspace, session, turn and run. It waits for settlement under the current Chat
write fence instead of starting another local runner, model council or delegated
workflow. Cancellation stops the wait. Expired or unresolved worker authority
requires reconciliation; it does not fall back to another model request.

The bounded text output profile must have a passed Gateway verifier, an intact
CAS blob, the exact canonical inference frame chain, settled usage and matching
assignment/worker/context identities. The normal Chat writer commits its
assistant message, completed trace, canonical usage references and transcript
materialization receipts together. Replay cannot create a second receipt or
substitute another message. Steering is explicitly declined while this frozen
worker workload runs, rather than accepting instructions that it cannot apply.

The canonical finalizer also records the separate worker-to-durable-result receipt
inside the transaction that writes terminal state, its sealed checkpoint, timeline
and trace. It verifies the completed assistant output against that authority and
the worker's settled artifact. Receipt failure rolls back the terminal transition.
Exact replay uses the same receipt identity; it cannot replace the output or write
a second result. Terminal replay verifies the existing authority before invoking
the materialization owner.

The receipts in this section cover recovery and output for already-created text
assignments. The later placement integration below adds initial scheduling;
the complete tool workflow remains source work.

Focused receipts for this integration:

- `.tmp/comparison-worker-chat-handoff-tests.log`: 97 tests passed across the
  handoff, Chat stream/dispatch, and durable-context owners.
- `.tmp/comparison-worker-chat-output-tests.log`: six output and handoff tests
  passed, including corrupt frame/usage rejection and exact query parameters.
- `.tmp/comparison-worker-chat-handoff-storage.log`: ten SQLite checks passed.
- `.tmp/comparison-worker-chat-handoff-trace-followup.log`: 58 stream tests passed
  after adding the canonical usage/completion projection and steering behavior.
- `.tmp/comparison-worker-chat-handoff-connected.log`: the spawned worker exposed
  extra upload/authority properties reaching a storage query through an object
  spread. The reader now passes only its explicit key fields. The next invocation
  in `.tmp/comparison-worker-chat-handoff-connected-followup.log` reached the new
  message commit proof but rejected a fixture missing required source provenance.
  That fixture now supplies the same explicit unknown provenance as ordinary
  assistant ingestion. Both failed attempts remain retained.
- `2026-09-10T00-00-38-137Z-remote-workers-ef67e846`: all 12 checks passed,
  including 317 Gateway tests, six spawned-worker scenarios and 18 actual
  PostgreSQL tests. The physical two-machine scenario was skipped. This receipt
  precedes the separate durable-result integration below.
- `2026-09-10T00-08-58-818Z-durable-recovery-428b4f66`: three scenarios passed,
  including approval wait/resume across a restart. It precedes the durable-result
  callback changes.
- `.tmp/comparison-worker-durable-result-focused.log`: 50 tests passed, covering
  terminal transaction rollback, exact replay, altered-output rejection and
  refusal to materialize incomplete worker runs. Gateway typecheck and scoped
  ESLint passed.
- `.tmp/comparison-worker-durable-result-connected.log`: the first extended
  spawned-worker fixture reached Chat handoff but omitted the required status
  field when binding its existing run's retry policy. The fixture now preserves
  that status explicitly; this failed attempt remains separate from later proof.
- `2026-09-10T00-19-46-711Z-remote-workers-be2cb5fd`: all 12 checks passed with
  the durable-result integration, including 109 contract, 150 SQLite and 363
  Gateway tests, six spawned-worker scenarios, and all 18 real PostgreSQL tests.
  The spawned scenario now exercises the canonical Chat finalizer with an actual
  message, checkpoint and transcript/result receipts. Failed transactions leave
  no terminal transition or duplicate receipt; a new service instance replays
  completion without another model call. Initial placement and the full tool
  workflow are still outside that fixture. Physical two-machine acceptance was
  skipped. The proof's owned PostgreSQL port was confirmed closed afterward.
- `2026-09-10T00-25-35-979Z-runtime-truth-89574ae2`: both scenarios passed,
  including approval restart recovery and the canonical Mission Control shell
  cross-check, with no skipped scenario.
- `2026-09-10T00-26-28-009Z-durable-recovery-b6fde680`: all three scenarios
  passed after the durable-result callback changes, including approval wait and
  restart recovery, worker recovery, and approval wake handling. No scenario
  was skipped. The lane registry tests, documentation checks and whitespace
  check also passed for this slice.

## Durable Chat execution placement

SQLite 210 / PostgreSQL 155 add an immutable execution-location ledger. Normal
durable Chat claims a local runner or schedules one worker offer before execution.
Offer creation and the remote choice share one transaction, current mutation
admission and durable-lease guards. A replacement Gateway reuses that choice;
another owner, changed payload, different assignment or foreign scope is rejected.
Older assignments are adopted as remote choices. Older unplaced runs with prior
model or tool work remain local. No historical location is guessed by migration.

At this checkpoint, eligible automatic placement required explicit runtime activation, a task-bound
admission with frozen context, a text profile with tools and delegation disabled,
and an available native Windows worker. The admitted operator must already have
an unexpired spending grant for that execution workspace and current worker
generation. Its registry may be in another workspace when that exact grant and
bootstrap authorize the execution workspace. Placement creates no spending grant.
Policy, capability, lease and budget owners still recheck authority at dispatch.

Local and remote claim ordering, immutable rows, transaction rollback, stale
leases, takeover, exact replay and legacy-offer adoption have shared SQLite and
PostgreSQL coverage. The idle-worker fixture drives production placement through
inference, Chat materialization and finalization with controlled provider output.
It starts from seeded admitted records, so it is not a browser-to-worker or
physical two-machine acceptance run. Full tools, delegation, council execution,
generic unbound Chat task admission and native protected hosting remain open.

Placement validation retains separate attempts:

- `.tmp/comparison-worker-placement-migration-parity.log` first rejected stale
  registry head assertions. The next attempt in
  `.tmp/comparison-worker-placement-migration-parity-final.log` exposed a digest
  computed without the migrator's `atomic` prefix. Only the new PostgreSQL 155
  entry and its newly appended manifest record were corrected; earlier migration
  entries remain unchanged. The complete `verify:storage:migration-parity` lane
  then passed in `.tmp/comparison-worker-placement-migration-parity-v2.log`.
- `2026-09-10T01-04-32-879Z-remote-workers-98e68a67`: 11 of 12 checks passed.
  All 109 contract, 150 SQLite, six spawned-worker and 18 real PostgreSQL tests
  passed. Gateway passed 369 tests and failed one new cross-registry fixture
  that omitted its registry workspace, causing the assignment's foreign key to
  reject it. The aggregate remains failed; the physical two-machine scenario
  remains skipped. Its owned PostgreSQL port was confirmed closed afterward.
- `.tmp/comparison-worker-placement-gateway-followup.log`: all seven placement
  tests passed after creating the fixture's registry through the workspace owner.
  This focused result does not replace the failed aggregate above.
- `.tmp/comparison-worker-placement-postgres-inventory.log`: all 56 migrator tests
  passed after accounting for the placement table's nine columns and two indexes.
  The twelve remote-worker lane-registry tests also passed.
- `2026-09-10T01-12-18-742Z-durable-recovery-0d1c9d46`: all three scenarios
  passed with no skips, covering approval wait/restart, durable worker recovery
  and linked approval wake handling after placement was added.
- `2026-09-10T01-13-39-090Z-runtime-truth-19217171`: both scenarios passed
  with no skips, including the runtime restart proof and canonical Mission
  Control cross-check. Scoped ESLint also passed after the fixture correction.

## Retained model requests and governed tools

Provider tool calls now travel in the accounted terminal frame under the existing
inference outbox hash chain. The adapter sends only the tool definitions frozen in
the Gateway capability profile. It retains the exact call ID, model-facing name
and JSON arguments; missing IDs, truncated/non-object arguments, duplicate calls,
unadmitted names and calls outside the count/byte bounds fail before execution.
The bounds are 32 calls and 64 KiB of aggregate retained call material. Text-only
terminal frames retain their existing shape. No storage migration was needed.

A worker's protected `chat.tool` submission identifies only the inference request,
attempt and call index. The Gateway rechecks live assignment, capability and
permission authority, verifies the canonical output frames and resolves the
exact tool name and arguments. The existing effect owner remains responsible
for approval, the side-effect boundary and Chat tool records. Generation-locked
effect allocation retains a stable index on replay and enforces the existing
64-intent assignment bound. Later calls cannot skip an unresolved earlier call.
Successful model-facing results use the shared secret-redaction projection and
carry a hash that the worker verifies against the request and call identities.
At this earlier stage, tool-owned model requests were blocked before HTTP dispatch, including attempts
inside another dispatch guard: the original inference reservation has already
settled, and tool-side continuation spending authority had not been implemented.
The later tool-budget evidence below supersedes that spending restriction.

The connected worker executes each retained batch sequentially and recovers
recorded model and tool results without repeating their dispatch. It now continues
the model/tool sequence as described below. At that stage, approval-gated durable
continuation, tool-owned model spending, delegation and council execution were unfinished.
At this checkpoint, automatic placement remained limited to text profiles with tools and delegation
disabled. A successful tool receipt alone cannot publish an assistant artifact or
complete the Chat assignment.

Focused receipts for this slice:

- `.tmp/comparison-worker-tool-loop-gateway.log` retained the original empty-text
  chunk failure (48 passed, one failed); the corrected provider adapter passed
  all 12 tests in `.tmp/comparison-worker-tool-loop-adapter-followup.log`.
- The connected tools fixture first omitted its frozen policy decision, then
  lacked a worker tool capability, and then passed an oversized record object
  to a storage lookup. Those attempts are retained in the `connected-tools`
  logs. `.tmp/comparison-worker-tool-loop-connected-tools-v4.log` passed the
  selected restart scenario; six other scenarios were intentionally filtered.
- `.tmp/comparison-worker-model-tool-connected.log` passed the selected native
  mTLS worker scenario with one real temporary-file read through a controlled
  invocation coordinator, one provider request, retained effect/tool records,
  restart replay and no completed artifact. Six scenarios were filtered.
- `.tmp/comparison-worker-model-tool-contracts.log`: 25 contract tests passed.
  `.tmp/comparison-worker-model-tool-worker.log`: nine worker tests passed.
  `.tmp/comparison-worker-model-tool-sqlite.log`: 21 storage tests passed.
  `.tmp/comparison-worker-model-tool-gateway.log`: 32 Gateway tests passed,
  including protected call selection and authority-field rejection.
- `2026-09-10T01-57-56-348Z-remote-workers-ffb98e37`: 11 of 12 checks passed.
  All 112 contract, 151 SQLite, 378 Gateway, seven connected-worker and 18 real
  PostgreSQL tests passed. The aggregate failed the new worker loop's TypeScript
  narrowing check; its scenario matrix has ten executed passes, one failure and
  the physical two-machine skip. The hermetic PostgreSQL port 55926 was confirmed
  closed after teardown. This remains a failed aggregate receipt.
- After correcting the loop's type annotation,
  `.tmp/comparison-worker-model-tool-typecheck-final.log` passed all seven package
  typechecks. The final effect composition passed Gateway typecheck again in
  `.tmp/comparison-worker-model-tool-gateway-typecheck-final.log`.
  `.tmp/comparison-worker-model-tool-connected-final.log` passed the selected
  restart/withdrawal scenario and proved that an inner model guard cannot bypass
  the tool-side spending block. One provider request was accepted; the denied
  nested request retained canonical no-dispatch evidence. Six scenarios were
  intentionally filtered. These follow-ups do not replace the aggregate above.

These controlled receipts do not prove live-model quality, protected native
credential custody, physical two-machine installation or Telegram delivery.

## Foreground worker operation

The worker's iterative Chat loop is bounded to 16 model steps, preserving the
existing 32-root-attempt settlement limit when a model step uses its one recovery
attempt. Step zero retains its original request identity. Each subsequent step
has one stable identity and receives the exact frozen original context plus
retained assistant calls and completed, hash-verified tool results. Missing steps,
changed history, repeated call IDs, unresolved tools and extra model requests
after a final answer fail closed. Gateway dispatch rechecks this sequence before
provider spending or tool execution.

The `tools` stop boundary retains completed tool work before the next model step.
A restarted process reconstructs earlier steps through canonical Gateway receipts.
Artifact verification and Chat materialization use the same sequence reader;
only the final model response is publishable, and usage totals include every
step's canonical root attempts and related utility attempts.

Focused continuation receipts:

- `.tmp/comparison-worker-continuation-contracts.log`: 30 contract tests passed.
- `.tmp/comparison-worker-continuation-gateway-focused.log`: 24 Gateway tests
  passed, including changed/missing context and tool-result rejection.
- `.tmp/comparison-worker-continuation-worker-tests.log`: all 76 worker tests
  passed, including step exhaustion and approval-wait boundaries.
- `.tmp/comparison-worker-continuation-e2e-initial.log`: the selected native mTLS
  workflow passed with two controlled provider requests, one real temporary-file
  read through a controlled coordinator, restart between tool and model steps,
  verified final artifact, terminal recovery and normal Chat materialization.
  The final Chat usage totals included both model steps. Seven other scenarios
  were intentionally filtered in this focused receipt.
- `2026-09-10T02-30-41-364Z-remote-workers-bc4cdc5a`: 11 of 12 checks passed,
  including all seven package typechecks, 117 contract, 151 SQLite, 382 Gateway
  and 18 real PostgreSQL tests. Seven of eight connected-worker cases passed;
  budget exhaustion exposed an empty-usage-list error in the new worker loop's
  stopped-work reporting. Provider spending remained blocked. The aggregate
  remains failed, with ten scenario passes, one failure and the physical
  two-machine skip. The owned PostgreSQL listener on port 64443 was confirmed
  closed after teardown.
- The corrected loop preserves requests that stop before any model attempt.
  `.tmp/comparison-worker-continuation-worker-typecheck-followup.log` passed,
  and `.tmp/comparison-worker-continuation-worker-tests-followup.log` passed all
  78 worker tests. `.tmp/comparison-worker-continuation-connected-followup-v2.log`
  passed the budget-exhaustion, successful model/tool continuation and permission
  withdrawal scenarios; five other scenarios were intentionally filtered.
  These follow-up passes do not replace the failed aggregate receipt above.

These are local controlled proofs. They do not close physical Windows installation,
live Telegram delivery, approval recovery, native protection or provider quality.

`GOATCITADEL_CONNECTED_WORKER_RUN_MODE` accepts `once` (the default) or
`continuous`. Continuous mode requires `GOATCITADEL_CONNECTED_WORKER_STOP_AFTER=complete`
and `GOATCITADEL_CONNECTED_WORKER_EXECUTION_MODE=gateway_inference`. It waits two
seconds between assignments or empty polls. Only one process may own a canonical
state directory; another process fails before admission or retained-vault access.
SIGINT/SIGTERM request shutdown of owned transport work. The report identifies
unresolved work requiring recovery, and retained state is preserved.

This option does not install a Windows service, enable the Gateway listener, create
assignment offers, authorize spending, or supply protected native execution. Its
current runnable proof uses the isolated verification harness. Those source and
deployment prerequisites remain listed in C5 above.

## Worker approval wait handoff

An approval wait now remains nonterminal in the worker effect ledger. Its original
approval correlation and hash chain survive owner restart. A later canonical
rejection finishes that same history without invoking the tool again; a rejected
or uncertain effect cannot project a pending approval or a completed tool result.
Existing terminal receipts are immutable and are not rewritten by this change.

The worker reports `approval_resolution` as its stopping reason. The Gateway
verifies the exact assignment, tool, workspace, session, turn and parent-run
linkage before retaining one inline approval and marking the Chat trace waiting.
The normal Chat finalizer alone commits the durable `waiting` state and its
approval-keyed checkpoint. Replay preserves the inline approval; a failed trace
write rolls back the projection. Approval linkage now includes the invoking turn.

The ordinary approved-action executor checks canonical tool, placement and
historical assignment ownership before refreshing policy or executing a tool.
Worker-owned approvals are blocked from that local replay path; the approval
does not supply native worker lease or generation authority. Unavailable ownership
also fails closed, with the existing canonical failed-action record and event.

Focused evidence:

- `.tmp/comparison-worker-approval-gateway-initial.log`: 35 Gateway effect and
  protocol tests passed; `.tmp/comparison-worker-approval-storage.log`: all ten
  SQLite effect-history tests passed.
- `.tmp/comparison-worker-approval-chat-focused.log`: 32 tests passed across the
  effect runtime, settlement, Chat handoff and sequence owners, including five
  foreign-linkage cases and projection rollback after terminal Chat state.
- `.tmp/comparison-worker-approval-connected.log`: the selected native mTLS
  worker scenario passed with one controlled model request, a pending tool,
  worker restart without reinvocation, and the real Chat finalizer's durable wait
  and exact replay. Eight other scenarios were intentionally filtered.
- `.tmp/comparison-worker-approval-local-replay-guard.log`: all 45 guard and
  Gateway facade tests passed, including prevention of local file, channel and
  MCP replay for an approved worker-owned action.
- `.tmp/comparison-worker-approval-guard-final.log`: all six guard cases passed
  after explicitly removing the placement record from the historical fixture.
  `.tmp/comparison-worker-approval-worker-final.log`: all 79 worker tests passed.
- `2026-09-10T03-16-20-177Z-durable-recovery-89f60f97`: all three scenarios
  passed after the local approval-execution guard, including isolated Gateway
  restart and linked approval-wake checks.
- `2026-09-10T03-17-26-997Z-runtime-truth-6d821597`: both backend approval
  restart and canonical Next-shell consistency scenarios passed with no skips.
  The earlier runtime-truth command was refused by the durable-recovery output
  lock before tests ran; its log is retained separately. Both named lanes also
  have earlier passing receipts before the local approval-execution guard.
- `2026-09-10T03-05-29-886Z-remote-workers-d670b118`: all 12 checks passed
  before the local approval-execution guard, including 390 Gateway, nine
  connected-worker and 18 real PostgreSQL tests. Its owned PostgreSQL port 59006
  was confirmed closed after teardown.
- `2026-09-10T03-15-02-581Z-remote-workers-63fe7a32`: all 12 checks passed
  with the guard and facade regressions included: seven package typechecks,
  117 contract, 152 SQLite, 435 Gateway, nine connected-worker, 12 policy,
  23 shared-client, 20 UI and 18 real PostgreSQL tests. The scenario matrix has
  11 executed passes and the physical two-machine skip. The first disposable
  PostgreSQL cluster lost its connection; the same command's single permitted
  fresh-cluster retry passed all 18 tests. Both attempts' logs are retained,
  and ports 59147 and 58587 were confirmed closed after teardown. This current
  passing receipt does not rewrite the earlier failed aggregates above.

This proves the waiting handoff, not resumed worker execution after approval.
Fresh worker/parent lease binding and approved-action effect-owner reconciliation
remained unfinished at this checkpoint. Automatic placement still excluded
tool-bearing profiles then.

## Worker restart while waiting for approval

Protected assignment sync now exposes `waiting_approval` only after verifying the
retained current assignment/lease token, current native credential and mesh
admission, canonical parked Chat parent, exact pending tool approval, inline
projection, and the matching sealed waiting checkpoint. The observation carries
the approval ID and runtime-authority digest; neither authorizes execution.
The retained lease may expire during the wait. This read cannot renew it, dispatch
a tool or model, append a transcript, publish an artifact, or settle the assignment.

The worker preserves the active assignment and its secret across restart and
polls serially while awaiting approval. Missing or inconsistent evidence still
requires reconciliation. Resuming execution after the operator decision remains
unfinished and is separate from observing the wait.

Focused proof: `.tmp/comparison-worker-wait-sync-gateway.log` passed 57 tests,
including 24 approval-wait reader cases. The controlled owner fixtures cover
checkpoint, parent, trace, approval, tool, intent, and resolution drift.
`.tmp/comparison-worker-wait-sync-worker-all.log` passed all 84 worker tests.
`.tmp/comparison-worker-wait-sync-connected.log` passed the selected real local
mTLS worker scenario: restart after the canonical finalizer parks Chat preserves
the run and assignment with no second model/tool call or lease renewal. Eight
other scenarios were intentionally filtered in that focused command.

Final verification:

- `2026-09-10T03-56-14-697Z-remote-workers-54fb4de1`: all 12 checks passed
  after aligning the waiting read with the canonical Chat/session/mesh lock order.
  This includes seven package typechecks, 117 contract, 152 SQLite, 459 Gateway,
  nine connected-worker, 12 policy, 23 shared-client, 20 UI and 18 real PostgreSQL
  tests. PostgreSQL used one disposable cluster; its new parked-Chat checks cover
  an expired retained lease, refusal of renewal/execution, wrong tokens/revisions,
  and revoked credential or changed mesh authority. The matrix has 11 executed
  passes and the physical two-machine skip.
- `.tmp/comparison-worker-wait-sync-focused-final.log`: 27 selected cases passed,
  including the native restart, checkpoint reader, and two new protected sync
  checks for exact scope, nonce replay and credential rejection. Eighteen cases
  were intentionally filtered. The integrated lane above does not select the
  assignment-protocol unit file, so this separate result is retained explicitly.
- `2026-09-10T04-03-49-134Z-durable-recovery-2d0df58c`: all three scenarios
  passed, including canonical Gateway restart and linked approval-wake checks.
- `2026-09-10T04-04-50-328Z-runtime-truth-6945e638`: both approval-restart and
  canonical Next-shell consistency scenarios passed with no skips.
- The earlier `2026-09-10T03-44-25-287Z-remote-workers-fd35760a` also passed all
  12 checks before the lock-order follow-up. Both worker runs used one PostgreSQL
  attempt. Their owned ports 50988 and 54148 were confirmed closed after teardown.
  These receipts do not replace the older failed whole-workspace aggregates.

## Worker-owned approval execution deferral

The ordinary approval processor now distinguishes a missing worker resume owner
from a failed tool invocation. Canonical remote ownership raises a dedicated
internal continuation signal. The Gateway preserves the exact pending request;
the approval-effect owner retains its wait with bounded backoff. The linked Chat
wake remains unclaimable while that action is deferred. Other policy refresh
failures keep their existing failed-before-dispatch handling.

This closes the false-failure path at the local approval processor. It does not
bind a fresh parent/worker lease or execute the approved tool. Those C5 items
remain unfinished, including native reconnect after the approval is resolved.

`.tmp/comparison-worker-approval-deferral-tests-final.log` passed all 91 tests in
the ownership guard, Gateway approval facade, and approval-resolution service.
The new real SQLite case proves that a replacement approval processor retries
the same action, preserves its request and approved decision, and cannot claim
the linked Chat wake. The first test run passed 90/91; its test expectation was
corrected to respect the repository's existing unclaimable-wake guard. That
original receipt remains in `.tmp/comparison-worker-approval-deferral-tests.log`.
Gateway typecheck and scoped lint passed. These focused tests are also selected
by the remote-worker lane; the earlier 12/12 receipt above predates this change.

Fresh named verification after the deferral change:

- `2026-09-10T04-27-11-289Z-durable-recovery-4c4e1f59`: three scenarios passed,
  including the canonical Gateway restart and linked approval-wake checks.
- `2026-09-10T04-29-01-671Z-runtime-truth-03abeca7`: both approval-restart and
  canonical Next-shell consistency scenarios passed, with no skips.
- Documentation and whitespace checks passed. Both verification commands exited
  successfully, and no Node processes tied to either disposable fixture remained.

## Storage authority for worker approval resume

SQLite 211 / PostgreSQL 156 add immutable approval-wake and parent-dispatch
binding records. The assignment owner checks the exact approved pending request,
retained tool intent, waiting checkpoint, parent payload, prior lease and current
generation. The resumed Chat lease can belong to a replacement Gateway process;
the assignment generation and tool history remain unchanged. An expired prior
worker lease can renew only after that binding and current protected native
authority both pass. Ordinary expired leases remain invalid.

The same forward migrations update the database lease, event and settlement
authority guards to read the latest retained resume binding. An unbound wake
does not fall back to the original Gateway owner or an older binding. All other
generation, parent-version, expiry, control and progress checks remain in place.
The migration refuses an unexpected guard definition instead of silently
replacing it. Historical migrations are unchanged.

At this storage-foundation checkpoint, the Gateway approval wake, native
reconnect and approved-action execution paths did not yet call these methods.
The integration work below extends that checkpoint; these storage receipts alone
do not demonstrate a complete approval-resume journey.

Rollback retains both tables and their authority guards and disables the resume
owner. The migration does not rewrite existing runtime rows, and a destructive
down migration is unsupported.
The migration verifier now follows local TypeScript export aliases and tolerates
unrelated local exports while still detecting a changed helper implementation.
The manifest updater appended only this turn's new migration records; historical
migration entries were preserved.

Focused proof:

- `.tmp/comparison-worker-resume-ledger-sqlite-final.log`: the real SQLite owner
  proof passed, covering rollback, exact replay, immutable rows, changed payload,
  wrong parent owner, preserved tool history and refusal of unprotected renewal.
- `.tmp/comparison-worker-resume-ledger-parity-final.log`: migration verification
  passed, including 27 manifest tests, explicit runtime integrity and 45 generated
  schema tests. The earlier parity run rejected the new PostgreSQL draft's raw
  SQL digest; its final digest uses the migrator's canonical atomic format.
- Storage typecheck and scoped lint passed.

The first combined remote-worker run,
`2026-09-10T04-52-16-937Z-remote-workers-f715f138`, failed. It passed 10/12 checks,
including 153 SQLite tests and nine native-process tests. Three Gateway facade
tests still expected the old false failure; their corrected focused run passed
39/39 in `.tmp/comparison-worker-resume-ledger-approval-facade.log`. PostgreSQL
executed all 18 tests and failed one: its original-owner SQL guard rejected a
valid protected resume renewal. This exposed the missing forward guard update
described above. That failed receipt remains separate from subsequent proof.

After the guard update,
`.tmp/comparison-worker-resume-sql-guards-sqlite-progress.log` passed the shared
SQLite proof, including a rolled-back lease/progress write under the new owner,
rejection before binding, old-owner and stale-version rejection, and refusal to
use an older binding when a newer wake is unbound. The SQL probes do not grant
native credential authority. Migration verification passed again in
`.tmp/comparison-worker-resume-sql-guards-parity.log`.

The next combined run, `2026-09-10T05-11-50-998Z-remote-workers-2e0e38aa`,
passed 11/12 checks: seven package typechecks, 117 contract tests, 153 SQLite
tests, 544 Gateway tests, nine native-worker tests, policy/shared/UI checks,
static scans, lint and whitespace. PostgreSQL failed at migration startup because
the new guard-update block needed parentheses around its conditional expression.
The new migration draft and its integrity digest were corrected; historical
migrations remain unchanged. This combined receipt remains failed.

The PostgreSQL-only follow-up first lost its disposable server after three
passing tests. Its log and server log are retained as
`.tmp/comparison-worker-resume-postgres-focus.log` and
`.tmp/comparison-worker-resume-postgres-focus.server.log`; the process termination
does not establish its cause. One fresh-cluster retry passed all 18 tests with no
skips in `.tmp/comparison-worker-resume-postgres-focus-retry.log`. That includes
the protected resume renewal, changed-credential/token rejection, exact replay
after a lost response, and invalidation of the old active token. The owned retry
cluster stopped successfully. A remaining process for the first failed fixture
was verified against its exact data directory and PID and stopped; the ports
from both focused attempts and the combined run were then confirmed closed.

Final manifest and migration checks passed in
`.tmp/comparison-worker-resume-sql-guards-final-migration-tests.log`: 27 manifest
tests plus 69 PostgreSQL integrity/generated-schema tests. Documentation checks
also passed. These split receipts do not certify an integrated Gateway approval
resume, physical two-machine operation, live provider quality or installation.

## Gateway approval handoff and lease continuation

Gateway approval effects now verify the exact settled Chat wait before recording
a skipped-local-action handoff. The pending tool request remains intact. The
linked durable wake records immutable resume evidence in the same transaction
as the waiting-to-queued CAS; a failed queue write rolls both back. Unsettled or
changed finalizer/checkpoint evidence keeps the approval effect deferred.

The resumed Chat owner binds its current parent claim before execution. Protected
worker sync distinguishes a handoff waiting for that claim from one ready for
lease renewal. The worker persists the replacement secret before sending and
replays the exact renewal after a lost response. Observation alone grants no
execution authority. Ordinary expiry recovery cannot replace a generation whose
approval handoff still owns the retained lease.

Approved execution reuses the canonical pending-action and side-effect owners.
It checks current native execution authority and the admitted tool runtime owner
before dispatch. Its result projection requires matching persisted request,
result and terminal-owner evidence. A crash after execution commits can recover
the projection without redispatch; an unknown external outcome requires
reconciliation. Approval replay also preserves the protected turn, tool-run and
Citadel scope so a Citadel deny grant still applies. Approval arriving before
the first Chat park now retains that wait and reflects the approved decision in
the inline projection.

Focused local receipts:

- `.tmp/comparison-worker-resume-wiring-handoff-owner-tests-final.log`: 5/5 real
  SQLite/Gateway-owner cases passed for handoff, queue rollback and changed or
  unfinished finalizers. Native transport is separate from this fixture.
- `.tmp/comparison-worker-resume-wiring-effect-coordinator-final.log`: 126/126
  effect-runtime and tool-coordinator tests passed, including completed approved
  execution, projection crash recovery, unknown outcome, returned-result drift,
  current-authority loss, early approval and tool-owner replacement. Native
  authority and external dispatch are controlled in these effect fixtures.
- `.tmp/comparison-worker-resume-wiring-worker-lease-tests.log`: 16/16 worker
  lease cases passed, including a parked restart, handoff observation and exact
  renewal recovery after a lost response.
- `.tmp/comparison-worker-resume-wiring-policy-scope-test.log`: the focused
  Citadel deny-policy approval replay regression passed; 125 unrelated tests
  were intentionally filtered out. Gateway, policy and storage typechecks passed.

The first added handoff fixtures failed on incomplete capability/retry authority,
and two crash-injection tests initially attempted to spy on the asynchronous
storage proxy. The fixtures now use the canonical admission context and retry
policy and inject failures through the underlying repository. The original
failed receipts remain in the `comparison-worker-resume-wiring-handoff-tests`,
`approved-execution-tests` and `handoff-regression-retry` logs. They are separate
from the focused passing receipts above.

Combined verification `2026-09-10T06-16-00-083Z-remote-workers-2093c738` passed
all 12 checks: seven package typechecks, 117 contract tests, 153 SQLite tests,
671 Gateway tests, nine real worker-process cases, policy/shared/UI checks,
lint, static scans and 18 PostgreSQL tests across ten owner suites. The scenario
matrix reports 11 executed, one physical two-machine skip and zero failures.
The disposable PostgreSQL cluster stopped and its listener was confirmed closed.

That combined receipt predates the final effect-classification follow-up. Storage
already treated the inconsistent approved no-effect evidence as uncertain. The
Gateway now records the precise missing-receipt reason and emits concrete-owner
references only for concrete outcomes. A terminal approved trusted read can retain
its no-effect classification; a started approval or unknown effect potential
cannot. The targeted red receipt remains in
`.tmp/comparison-worker-resume-wiring-unproven-effect-red.log`. After correction,
27/27 effect-runtime tests passed in
`.tmp/comparison-worker-resume-wiring-approved-effect-projection-final.log` and
11/11 SQLite tool-projection/resume tests passed in
`.tmp/comparison-worker-resume-wiring-effect-projection-storage-final.log`.
Gateway and storage typechecks also passed. The first projection follow-up still
carried references forbidden for uncertain evidence; its failed receipt is kept
separately in `.tmp/comparison-worker-resume-wiring-approved-effect-final.log`.

The post-correction PostgreSQL follow-up passed all 18 tests with no skips in
`.tmp/comparison-worker-resume-wiring-postgres-final.log`. It includes the shared
approved-read projection checks and active-resume observation/recovery guards.
Its separately provisioned cluster stopped and the listener was confirmed closed.
Scoped final lint passed in `.tmp/comparison-worker-resume-wiring-final-lint.log`.

Fresh post-correction named lanes also passed:

- `2026-09-10T06-30-51-313Z-durable-recovery-785f2ee1`: 3/3 scenarios,
  including the real Gateway restart/dead-letter journey and approval wake tests.
- `2026-09-10T06-32-55-391Z-runtime-truth-4cd42d5e`: 2/2 scenarios,
  covering approval-restart truth and canonical Next-shell consistency.

Neither lane skipped a scenario. No Node processes associated with these
disposable verification runs remained at handoff. Final documentation and
whitespace checks passed; the checkout remains local and uncommitted.

At this checkpoint, remaining C5 work included recovery after another parent-owner replacement,
tool-side model spending, delegation/council, generic
Chat task admission, protected native execution/volume/custody, and the installed
Windows service. Automatic placement was still limited to task-bound text profiles then.
Physical two-machine acceptance, live Telegram delivery and provider-quality
comparison remain distinct unfinished acceptance work.

## Parked rejection and edited-decision continuation

Rejection and edit decisions now retain the exact declined pending request in the
immutable worker wake. They do not create an action-execution effect. Their
linked approval wake remains retryable until Chat has committed its first wait
and the matching finalizers have settled. A replacement approval processor can
claim that retry; a stale processor cannot materialize it. The inline display
uses the existing approval lifecycle's statuses, while canonical decisions and
native execution authority remain authoritative.

After rotation of the retained worker lease, a terminal refusal supplies a
bounded model-facing result. That result requires the exact approval digest,
scope and terminal effect receipt. Rejection alone, without the settled receipt,
cannot advance the model loop. Unknown external outcomes continue to require
reconciliation. The worker can replay a refusal without another tool invocation.

Local proof for this slice:

- `.tmp/comparison-worker-rejection-focused-final.log`: 90/90 focused Gateway
  cases passed after the final changes, covering handoff, early decisions,
  replacement approval claims, protected read projections and model continuation.
- `.tmp/comparison-worker-rejection-storage-tests-first.log`: all three shared
  SQLite cases passed for approve, reject and edit, including immutable evidence,
  changed authority, queue rollback and refusal of unprotected lease revival.
- `.tmp/comparison-worker-rejection-postgres-first.log`: 18/18 tests passed on a
  fresh real PostgreSQL cluster, with no skips. Its shared resume fixture exercised
  all three decisions, protected lease rotation and old-credential rejection.
  The owned cluster stopped and port 62600 was confirmed closed.
- `.tmp/comparison-worker-rejection-native-first.log`: the selected native
  worker process case passed; eight unrelated cases were intentionally filtered.
  It parked through the actual Chat finalizer, resumed a rejected decision through
  the canonical durable wake and lease binding, rotated the native lease and
  replayed the refusal on restart. Notification callbacks and the provider were
  controlled. It stopped before the next model request, at model continuation.

The first Gateway run passed 78 tests and failed eight because the new rejection
projection used the approval-record status in an inline field with a different
contract. That mismatch was corrected; the failed receipt remains in
`.tmp/comparison-worker-rejection-gateway-tests-first.log`. The corrected run
passed all 86 cases in `.tmp/comparison-worker-rejection-gateway-tests-projection.log`.
The subsequent model-facing refusal change passed 34 effect/sequence cases in
`.tmp/comparison-worker-rejection-model-result-first.log`. Its first typecheck
exposed two explicit storage interfaces missing the approval reader; those were
extended and `.tmp/comparison-worker-rejection-gateway-types-continuation.log`
passed. These receipts remain separate from earlier combined verification.

The named durable-recovery run `2026-09-10T07-04-28-295Z-durable-recovery-f25060c7`
passed all three scenarios with no skips, including the actual Gateway
restart/dead-letter journey and the full approval-resolution-effect owner suite.
The named runtime-truth run `2026-09-10T07-05-57-841Z-runtime-truth-91af1ff1`
also passed both scenarios with no skips: approval recovery and the canonical
Next-shell projection. Final scoped lint passed. Both disposable stacks stopped;
these lanes do not substitute for the worker-specific or physical-machine proof.

This proves the parked-decision behavior within the boundaries above. It does not prove another
Gateway parent-owner restart, a physical second machine, installation, live
channel delivery or live-model quality. At this checkpoint, automatic placement remained restricted
to task-bound text profiles; full C5/C6 completion remains open.

## Resumed Chat dispatcher continuity

The running parent dispatcher previously projected its already resolved approval
again after binding the wake, which could park Chat a second time. The wait owner
now suppresses only the exact resolved approval associated with that binding.
Pending or different approvals remain governed by their normal wait. No tool,
provider or lease authority is supplied by suppressing a display/wait projection.

The regression reproduced for approve, reject and edit in
`.tmp/comparison-worker-parent-recovery-repark-red.log`: all three selected cases
failed, with 11 unrelated cases filtered. After the fix, all 19 handoff/Chat-owner
cases passed in `.tmp/comparison-worker-parent-recovery-repark-first.log`.
Gateway typecheck passed in `.tmp/comparison-worker-parent-recovery-gateway-types-first.log`.
The final focused run passed all 49 handoff, dispatcher and effect-runtime tests
in `.tmp/comparison-worker-parent-recovery-focused-final.log`. Named recovery run
`2026-09-10T07-17-25-796Z-durable-recovery-05e5f542` passed all three scenarios with
no skips. Its disposable stack stopped; scoped lint, documentation and whitespace
checks also passed. Storage schema and migration behavior did not change in this
dispatcher follow-up, and PostgreSQL was not rerun for it.

The native proof was strengthened to keep the actual Chat dispatcher running
alongside the restarted worker. It now uses the real linked approval-effect
owner to wake Chat and lets the dispatcher bind its own lease. The worker rotates
its retained lease, consumes the refusal and replays it while Chat remains
running. `.tmp/comparison-worker-parent-recovery-native-first.log` passed the
selected Windows process case; eight other cases were filtered. Its provider and
notification callbacks remain controlled, and it stops at model continuation.
The earlier native receipt did not exercise that simultaneous parent dispatcher.

That follow-up still allowed only the first immutable parent binding. The
additional recovery records and current local proof are described below.

## Worker approval continuation after parent recovery

SQLite 212 / PostgreSQL 157 add append-only recovery records without changing
the historical approval wake or first binding. Each recovery retains its
predecessor hash, canonical parent attempt and claim, current worker lease
revision/request hash, and pending-action snapshot. Database guards select the
latest retained owner. A stale owner cannot regain authority by presenting a
matching run row, and an unbound newer approval never falls back to an older owner.

The durable owner requeues an expired parent without incrementing its attempt.
Protected native sync reports a parked continuation until the new Chat dispatcher
binds that claim. Only protected renewal can rotate the retained lease; stale
lease tokens and invalid credentials are rejected. A completed approved action may change its
terminal result/status fields, but recovery still verifies its original request
bytes and scope. This fixed a regression in which changed arguments could otherwise
be accepted into a new recovery snapshot.
Protected sync also permits a valid approved action to finish between binding and
renewal: it compares the original approved request after excluding terminal fields.
The effect owner still verifies the canonical execution/result evidence separately.
`.tmp/comparison-worker-rebinding-settlement-race-red.log` reproduced the stranded
renewal before this correction; the changed-argument case remains rejected.

Current local receipts:

- `.tmp/comparison-worker-rebinding-regression-first.log` reproduced the changed
  request defect for approve, reject and edit. The final shared SQLite fixture
  passed all three cases in `.tmp/comparison-worker-rebinding-regression-final.log`,
  each with three successive recoveries, immutable history, direct SQL owner
  probes, and rejection of request, approval, payload and attempt drift.
- `.tmp/comparison-worker-rebinding-parent-first.log` passed all 14 Gateway cases.
  Its three decision cases each exercise the actual expired-lease recovery owner
  and two replacement Chat dispatchers. Workflow recoverability is controlled;
  the recovery locks, queue transitions and dispatcher are real.
- `.tmp/comparison-worker-rebinding-wait-read-first.log` passed all 48 read-owner
  cases, including a terminal pending action, changed recovery snapshot, and
  rejection of a renewal instruction while recovery remains pending.
- After the settlement-timing correction,
  `.tmp/comparison-worker-rebinding-final-owners.log` passed all 93 combined
  handoff, wait-read and tool-effect cases. Gateway typecheck and focused lint
  passed again in the `comparison-worker-rebinding-settlement-*` logs.
- `.tmp/comparison-worker-rebinding-native-first.log` passed the selected native
  Windows process case; eight unrelated cases were filtered. After consuming a
  rejected tool result, the worker stays parked during parent recovery, rotates
  its lease under the replacement parent and resumes at model continuation.
  The tool/provider are not called again. This uses a real local mTLS listener
  and worker process, with controlled provider/notification callbacks. The
  Gateway process itself is not restarted in this fixture.
  The selected case passed again after the final read-owner correction in
  `.tmp/comparison-worker-rebinding-native-final.log`, with the same eight filters.
- `pnpm verify:storage:migration-parity` passed in
  `.tmp/comparison-worker-rebinding-migration-parity-second.log`. The manifest
  updater appended only SQLite 212 and PostgreSQL 157; historical entries remain
  unchanged. The first run stopped on the stale independent inventory counts.
- `.tmp/comparison-worker-rebinding-postgres-third.log` passed all 18 real
  PostgreSQL cases with no skips. The shared recovery fixture exercises all
  three decisions after native lease rotation, successive current-lease handoffs,
  exact renewal replay, and refusal of obsolete tokens/credentials. Its disposable
  PostgreSQL instance stopped, and its port was confirmed closed.
- Gateway typecheck passed in
  `.tmp/comparison-worker-rebinding-gateway-types-followup.log`; scoped lint passed.
  Durable-recovery run `2026-09-10T07-44-10-778Z-durable-recovery-0a6ad13f` passed
  all three scenarios without skips. Its actual Gateway restart scenario covers
  approval-wait/DLQ recovery separately from the native worker fixture above.
  The final correction was reverified by
  `2026-09-10T07-53-08-922Z-durable-recovery-40f30c10`, also 3/3 without skips.
- Runtime-truth run `2026-09-10T07-47-15-937Z-runtime-truth-bccc8c2a` passed
  both scenarios without skips. The final correction passed both scenarios again
  in `2026-09-10T07-55-13-209Z-runtime-truth-3b3d1e18`.
  These named subsystem receipts do not replace
  the outstanding full-workspace or release-candidate acceptance campaign.

The initial PostgreSQL run failed the new migration because fresh bootstrap had
already created its table. The new migration now handles that bootstrap path.
The next run passed 17/18 cases and exposed an extra field in the new test's renewal
command. That fixture now uses the exact command shape and asserts domain-level
authority rejection, so input-validation errors cannot count as fencing proof.
Those failed receipts remain in `comparison-worker-rebinding-postgres-first.log`
and `comparison-worker-rebinding-postgres-second.log` under `.tmp/`.

The pre-approval recovery and native approved-tool follow-ups are recorded below.
A Gateway process restart during that worker journey, installed service operation and physical
two-machine acceptance remained unproved at this checkpoint. Automatic placement still selected only
the admitted task-bound text profile with tools and delegation disabled.

## Worker parent recovery before an approval

SQLite 213 / PostgreSQL 158 add an immutable recovery chain rooted in the original
assignment generation. A current admitted Chat claim can bind its replacement
parent without creating an approval or replacing the assignment. Once an approval
wake exists, the approval continuation remains authoritative.

Protected sync distinguishes waiting for the new parent from readiness to renew.
The worker retains its assignment and secret while parked, then persists its
proposed rotation before sending. The Gateway rechecks task content, scope,
attempt, current credential and canonical claim. An expired worker lease with no
parent handoff cannot use this path to regain execution.

Local receipts for this addition:

- `.tmp/comparison-worker-initial-recovery-storage-second.log`: the SQLite fixture
  passes three successive parent replacements, immutable history, exact replay,
  direct SQL stale-owner rejection, and changed task/scope/attempt rejection.
- `.tmp/comparison-worker-initial-recovery-postgres-first.log`: 18/18 actual
  PostgreSQL cases pass without skips. Its shared parent fixture also proves
  protected renewal, rejection of obsolete tokens/credentials, and observation
  while the parent is expired, queued, or awaiting a fresh binding. The disposable
  database stopped after the run.
- `.tmp/comparison-worker-initial-recovery-gateway-third.log`: 36/36 Gateway cases
  pass, including the actual expired-parent recovery scan and two replacement
  Chat dispatchers before any approval. Workflow eligibility is controlled by
  the fixture; the recovery scan, queue CAS and Chat dispatcher are real.
- `.tmp/comparison-worker-initial-recovery-client-final.log`: 28/28 worker tests
  pass, including parked restart, lost renewal response, malformed recovery
  evidence, and serial foreground polling.
- Gateway/worker typechecks, scoped lint and `verify:storage:migration-parity` pass in
  the corresponding `comparison-worker-initial-recovery-*` logs. The manifest
  updater appended only the new migration pair.
- Named durable-recovery run `2026-09-10T08-22-24-428Z-durable-recovery-e73e86a4`
  and runtime-truth run `2026-09-10T08-24-22-007Z-runtime-truth-d11c6b15` pass.
  Docs checks and whitespace checks pass. These subsystem receipts remain
  separate from the outstanding full-workspace and release acceptance campaign.

The first shared SQLite check expected an ignored extra payload field to be
rejected; the corrected case changes actual admitted task content. The first
expanded Gateway run exposed incorrect fixture names for the mesh fence and
active-lease repository method. Those failed receipts remain separate from the
passing runs above.

The native-process follow-up below extends this owner proof through retained
inference, artifact publication and Chat completion. Actual Gateway-process
restart, installed Windows service operation and physical two-machine acceptance
remain open. This addition does not close C5 or the full implementation plan.

## Native worker completion across parent recovery

The connected Windows process fixture now covers two more complete journeys:

- `parent_recovery` lets ordinary task-bound Chat select an idle worker, retains
  its completed inference, and expires the parent. A restarted worker parks while
  the real durable recovery owner requeues the run. The replacement Chat
  dispatcher binds the same assignment generation; the worker rotates its lease
  and resumes the retained result. Artifact publication, terminal settlement,
  completed Chat, materialization rollback and replay all pass with one provider
  request and no duplicate output.
- `tool_approval_approve` retains the first canonical Chat approval wait, approves
  it, and transfers execution through the normal approval-effect handoff. After
  the worker rotates its lease, the parent expires again before the approved read.
  A new parent binding permits the native worker to execute that read through
  `executeApprovedExternalRuntimeSideEffect`, checking current execution authority
  before reading the fixture file. Its result replays without a second read;
  the follow-up model response, artifact, settlement and Chat finalizer complete.

The individual runs pass in `.tmp/comparison-worker-initial-native-first.log`
(one selected case, nine filters at that point) and
`.tmp/comparison-worker-approved-native-first.log` (one selected case, ten filters).
The expanded regression run in `.tmp/comparison-worker-native-recovery-matrix.log`
passes all five selected recovery, rejection and stale-parent cases; six other
cases are explicitly filtered. Scoped lint, docs checks and whitespace checks
pass. No production source or migration changed in this proof follow-up.
The transport, restarted worker processes, repository state, recovery/approval
owners, local file read, artifact verifier and Chat finalizer are real. Provider,
permission and notification callbacks are controlled. The Gateway process itself
is not restarted, and these receipts do not establish installed service behavior,
physical two-machine operation or live-model quality.

## Full Gateway worker wiring follow-up (incomplete)

`remote-worker-gateway-restart-e2e.test.ts` now launches the built Gateway,
an isolated SQLite runtime, a real native worker process and a loopback provider.
It uses normal HTTP Chat admission and a synthetic native admission signer;
it does not establish installed custody, a second physical host or live quality.
The shared native fixture is now under `apps/gateway/test/fixtures/` and remains
outside shipped Gateway source.

The integrated probe exposed two corrected wiring defects:

- Native assignment preflight rejected AsyncStorage's callable repository
  proxies. It now checks the required method on both object and callable ports;
  missing methods still fail closed. All eight composition tests passed in
  `.tmp/comparison-worker-gateway-restart-second.log` (the integrated case in
  that same run failed later during fixture setup).
- Budget creation and reload treated `auth:none` and the canonical
  `token:<16 hex fingerprint>` actor as secret material. Their exact forms now
  share a budget-specific normalizer; other credential-shaped fields remain
  rejected. Contracts/inference passed 33 tests in
  `.tmp/comparison-worker-gateway-budget-identities-final.log`; budget storage
  passed 12 tests, including creation/reload/replay/operator lookup, in
  `.tmp/comparison-worker-budget-actor-storage-second.log`.

The final probe of that wiring follow-up failed in
`.tmp/comparison-worker-gateway-restart-seventh.log`: the worker is admitted,
online and granted two requests, and the real Chat has a frozen context,
zero tools and subagents off, but its canonical `attemptCount` is zero.
Placement requires one, while the assignment repository also assumes positive
durable attempts. The resulting Chat ran locally with four loopback calls
(including completion follow-ups); it did not exercise worker inference or a
Gateway restart. The attempt representation and its persisted authority checks
must be reconciled without changing the retry semantics of ordinary Chat.
Do not count this probe as passing remote-worker acceptance.

A separate fixture setup failure exposed the SQLite join-authority TTL upper
boundary: its Julian-day CHECK can evaluate exactly 600 seconds as
`600.0000044703484`, exceeding the allowed maximum. The restart fixture uses
300 seconds at that point. The subsequent forward migration and proof below
correct both endpoint arithmetic and first-attempt admission.

The extracted native fixture passed both selected recovery journeys in
`.tmp/comparison-worker-native-fixture-extraction-regression-second.log`
(two passed, nine filtered). Gateway typecheck passed in
`.tmp/comparison-worker-gateway-restart-typecheck-final.log`. The named runtime
truth run `2026-09-10T09-10-44-219Z-runtime-truth-1011b2ba`, docs and scoped lint
also passed. These focused
receipts do not replace the failing integrated probe or the earlier broad run.

## Canonical attempts and full Gateway restart

Worker placement, dispatch contracts and repository fences now accept canonical
attempt zero. Positive historical attempts retain their exact authority bytes;
negative and fractional attempts remain invalid. A retry without an existing
placement remains local instead of changing runners.

SQLite 214 / PostgreSQL 159 are forward migrations. The SQLite upgrade preserves
populated assignment/lease records, triggers, indexes and historical ledger rows,
and uses integer milliseconds for the 1–600-second mesh-join lifetime. The new
PostgreSQL integrity hash was corrected before any successful migration run;
the failed hash-check receipt remains separate. Migration parity passed through
214/159. Fresh disposable PostgreSQL passed 18 tests without skips in
`.tmp/comparison-worker-zero-attempt-postgres-second.log`.

The full built-Gateway test passed in
`.tmp/comparison-worker-zero-attempt-gateway-assertions.log` (one test, 47.64 seconds).
Its result is retained in
`.tmp/worker-gateway-restart-fda92577-2b76-48a2-9172-29d2aec3ce30/result.json`.
Normal HTTP Chat selected a native worker at attempt zero. After its inference,
the actual Gateway process stopped and a new process resumed the same parent and
assignment generation. The worker renewed its lease, published its artifact,
settled its budget and completed one canonical Chat reply. Restarted-worker replay
made no new request and did not duplicate the reply. Both owned Gateway processes
and the disposable runtime were cleaned up.

This run used one worker inference and three normal Chat post-commit calls,
all against a loopback `gpt-5.4` fixture. The fixture requires the existing pinned
pricing entry and now explicitly reports zero cached tokens so model costs can
settle. The budget guard was not weakened. Earlier unpriced and incomplete-usage
fixtures failed before the final passing run; they are not live-provider evidence.
The synthetic native signer does not prove installed custody or a second host.

Other focused receipts: 16 contract checks, seven SQLite offer/migration/recovery
checks, 12 Gateway placement/offer checks, 14 deterministic-provider checks and two
selected native recovery journeys (nine cases filtered). The master C5/C6 work
and external acceptance remain open.

The named runtime-truth run
`2026-09-10T09-49-07-897Z-runtime-truth-cbea1c8d` and durable-recovery run
`2026-09-10T09-50-44-080Z-durable-recovery-b8bf0fcc` both passed after these changes.
Scoped lint, documentation and whitespace checks also passed. These receipts
do not replace the earlier failed whole-workspace fast run.

## Tool model spending and deferred stream authority

Tool-internal LlmService requests now inherit the immutable worker, workspace,
session, turn, parent run, task and routed-context identity. They retain independent
usage operation IDs. Attempts to substitute another execution fail before creating
an accounting intent. Every actual transport attempt, including retries, reserves
one request and its bounded worst-case price from the operator's existing grant
pool. The original inference's completed reservation does not fund later tools.

SQLite 215 / PostgreSQL 160 retain immutable tool dispatch holds, exact effect
intent and route hashes, and one-way settlement. Revoked grants cannot fund new
requests. Confirmed no-dispatch evidence releases a hold; incomplete or unpriced
usage remains held. Reconciliation also runs on terminal replay and Chat
materialization. Chat's usage totals include the tool's canonical model events.
The migration is forward-only: rollback disables tool model dispatch and retains
its history. Historical migration definitions remain unchanged.

The lifecycle regression found that the plain streaming entrypoint deferred its
entire body until iteration, losing a tool's creation scope. It now captures that
scope when the iterator is created. Iteration after tool completion, authority
revocation or budget exhaustion cannot invoke HTTP. The final Gateway accounting,
guard and effect suite passed 74 tests in
`.tmp/comparison-worker-tool-budget-gateway-regression-second.log`. The separate
Chat sequence/output suite passed 13 tests in
`.tmp/comparison-worker-tool-budget-output-tests.log`.

Both selected native Windows tool journeys passed in
`.tmp/comparison-worker-tool-budget-native-final.log` (two passed, nine filtered).
They cover direct tool execution and approved execution after parent recovery.
Each used two worker model calls and one tool helper call against controlled
provider responses, charged all three requests, replayed without extra dispatch,
and exposed the combined 30 input / 21 output tokens through canonical Chat.
These are same-host native-process and synthetic-custody tests, not installed
service, live-provider or two-machine acceptance.

The first PostgreSQL run exposed a dynamic-bootstrap collision with the new table.
The draft migration now preserves bootstrap-created tables/indexes and separately
installs its CHECK and immutable guards, matching the existing migration pattern.
Later failures were reused synthetic runtime/mesh credentials in the new two-worker
fixture. Its identities and catalog snapshot are now distinct; a SQLite check with
pre-existing worker and catalog state passed. Failed receipts remain in the
`comparison-worker-tool-budget-postgres-first/second/third` logs.

The final disposable PostgreSQL lane passed all 19 checks without skips in
`.tmp/comparison-worker-tool-budget-postgres-fourth.log`, including the shared
protected tool-budget assertions and the existing concurrent authority/budget
checks. Its exact owned database was stopped and removed. The SQLite fixture also
passed with an existing worker and a different immutable catalog in
`.tmp/comparison-worker-tool-budget-sqlite-existing-catalog.log`.

Migration parity passed through SQLite 215 / PostgreSQL 160 in
`.tmp/comparison-worker-tool-budget-migration-parity-final.log`; the existing
budget/related-call/upgrade suite passed 17 tests in
`.tmp/comparison-worker-tool-budget-storage-regression.log`. Runtime-truth run
`2026-09-10T10-29-11-546Z-runtime-truth-c700d6b1` and durable-recovery run
`2026-09-10T10-32-28-235Z-durable-recovery-ef039f1b` passed. These focused receipts
do not replace the whole-workspace failure below or close C5/C6.
Gateway typecheck, scoped lint, docs and whitespace checks also passed. All changes
remain local and uncommitted; no pre-existing dirty path was removed.

## Automatic placement for governed tool profiles

`RemoteWorkerChatPlacementService` now admits task-bound profiles whose selected
tools all have frozen runtime owners and effect classifications supported by
`RemoteWorkerEffectRuntime`. The worker must have the additional `governed_tool`
bootstrap capability. Requester-scoped MCP and mesh-published tool profiles remain
local in full; placement never filters out unsupported tools to change the task.
Delegation/council remain separate source work. Generic Chat admission was added
in the later slice recorded below.

The existing immutable placement transaction still makes one local/worker choice.
Placement does not issue a grant, reserve model usage, invoke tools or waive
approvals. Current catalog, execution lease, permissions and budgets remain
authoritative at dispatch. Withdrawn capabilities prevent offer creation.

The placement/offer suite passed 19 tests in
`.tmp/comparison-worker-tool-placement-unit-final.log`. Its new cases cover
governed-tool capability admission, missing owner/classification, mixed scoped
MCP/mesh profiles, withdrawn tools and retained placement after settings change.
The selected native suite passed five journeys with six filtered cases in
`.tmp/comparison-worker-tool-placement-native-first.log`. These now begin with
an idle native worker and ordinary placement, then exercise heartbeat, tool calls,
withdrawal, approval wait and approved continuation without repeated work.
Gateway typecheck and scoped lint passed. All providers and custody in this proof
remain controlled local fixtures.

## Full Gateway restart during approved worker execution

The real-process approval probe exposed a missing execution receipt: the approved
`fs.read` succeeded, but its frozen effect classification was `unknown` and no
canonical boundary had been recorded. The worker correctly stopped for
reconciliation. Failed receipts remain in the first three
`comparison-worker-approval-gateway` logs; the third retained the exact successful
pending action and uncertain tool evidence under
`.tmp/worker-gateway-restart-bc1d75d7-fd32-4c47-99aa-ab6db1bb87e6/tool-state.json`.

The Gateway now records that boundary after current policy/execution checks and
before entering an approval-sensitive builtin. Direct worker builtin dispatch
uses the same coordinator callback. A stale lease, rejected approval or failed
receipt cannot enter the tool, and an already-recorded boundary cannot be
downgraded by a later no-boundary callback. Missing receipts still produce
uncertain evidence; returned success alone cannot certify completion.

The final coordinator/effect suite passed 135 tests in
`.tmp/comparison-worker-execution-boundary-unit-final.log`, including preservation
of an existing builtin receipt when its executor reports no additional boundary.
The full built-Gateway
approval probe passed in `.tmp/comparison-worker-approval-gateway-fourth.log`
(one passed, one filtered). Its retained result is
`.tmp/worker-gateway-restart-3679a9e7-9fc7-457f-9235-25e9fbabc76a/result.json`:
Gateway PID 51648 changed to 34404, the original approval remained pending until
resolved through the normal HTTP API, and the same assignment generation and
Chat attempt zero completed. It made two worker model calls and three separate
normal Chat calls against the loopback stub. The approved file read and canonical
assistant message replayed without another execution or model request.

The combined final restart suite passed both cases without skips in
`.tmp/comparison-worker-placement-gateway-final.log` (82.48 seconds). The text
case retained one worker request and three normal Chat requests in
`.tmp/worker-gateway-restart-17123d40-26fe-4974-9554-246a483da2ca/result.json`.
The approval case retained two worker requests and three normal Chat requests in
`.tmp/worker-gateway-restart-bf20456b-b28c-40a9-928b-4f5ae64fc0d6/result.json`.
Both completed on attempt zero with the original assignment generation and
unchanged output on replay. All four recorded Gateway PIDs are stopped.

Gateway typecheck, scoped lint, docs and whitespace checks passed. The checkout
remains local and uncommitted on `main`; all 370 pre-existing dirty paths remain.

These are actual local Gateway/native worker processes with synthetic custody and
controlled model responses. No installed service, physical second host, external
channel, live model or final whole-workspace gate is certified by this result.

## Ordinary Chat worker task admission

Chat no longer needs a caller-supplied task ID to use an eligible worker.
`RemoteWorkerChatTaskRepository` creates a real workspace task and binds it to
the original admitted run, session, turn and payload hash. SQLite 216 /
PostgreSQL 161 retain that immutable binding. Creation, canonical parent-context
metadata, offer and placement share one transaction. Failed offers roll back the
task; local placement creates none. No task ID is inserted into the admitted
request, and replay cannot create a second task. Existing metadata and SQL parent
checks remain enforced alongside the new binding.

Generated tasks follow durable status in the same transaction: completion marks
them done, waits and interrupted outcomes mark them blocked. A failed task write
rolls back the run transition. Caller-selected task lifecycles are unchanged.
Generic input exceeding the worker context byte or message bound remains local;
the original history is preserved, and malformed admission still fails closed.

The first full Gateway run completed worker execution but failed Chat ingestion:
the canonical model usage named the generated task while the Chat writer still
expected the absent caller task. This failed four-case receipt (two passed, two
failed) remains in `.tmp/comparison-worker-generic-chat-native-first.log`.
The writer now takes the task owner from its internal verified worker-execution
port and rejects a conflicting caller-selected task. The usage ownership check
was preserved. Failure diagnostics now stop on terminal failure instead of
waiting for a success timeout.

The final full Gateway run passed all four cases without skips in
`.tmp/comparison-worker-generic-chat-native-second.log` (159.87 seconds):

| Admission | Restart point | Retained result | Worker / other Chat requests |
| --- | --- | --- | --- |
| Existing task | Inference | `.tmp/worker-gateway-restart-0a9e14df-fb05-489d-bf95-11140691ad4f/result.json` | 1 / 3 |
| Existing task | Approval | `.tmp/worker-gateway-restart-2782783b-b6fa-4b23-a423-b0963e5a8c34/result.json` | 2 / 3 |
| Generated task | Inference | `.tmp/worker-gateway-restart-7395f71d-e4c9-4c95-85f4-78cd3931b7c1/result.json` | 1 / 3 |
| Generated task | Approval | `.tmp/worker-gateway-restart-e770ef53-8fda-4d54-983f-1e6521afe533/result.json` | 2 / 3 |

Each retained the original assignment generation and attempt zero, then replayed
without another model request, tool invocation or assistant message. Both generated
tasks reached done without rewriting their requests. All eight Gateway PIDs were
confirmed stopped; the native subprocesses exited. These providers and native
custody are controlled local fixtures, not live models or installed-service proof.

The Gateway admission, placement, streaming and completion suite passed 131 tests
in `.tmp/comparison-worker-generic-chat-gateway-unit-final.log`; bounded-context
contracts passed five in `.tmp/comparison-worker-generic-chat-context-final.log`.
The SQLite offer/durable/task suite passed 49 in
`.tmp/comparison-worker-generic-chat-storage-third.log`. The disposable PostgreSQL
lane passed all 19 checks without skips in
`.tmp/comparison-worker-generic-chat-postgres-first.log`, including the same
ordinary-admission, rollback, immutable-binding and lifecycle assertions. Its
owned database on port 57768 was stopped and removed. Gateway typecheck and
scoped lint passed. The first SQLite probe lacked the canonical parent metadata
required by the existing SQL guards; the fix retains those guards and commits
that metadata through the versioned durable owner.

These focused results do not close C5/C6 or replace the whole-workspace receipt.

The named migration-parity lane passed through SQLite 216 / PostgreSQL 161 in
`.tmp/comparison-worker-generic-chat-migration-parity-second.log`. Its first run
found the independent inventory test still pinned to 215/160; only the new tail,
counts and dynamic-migration inventory were updated. Existing migration hashes
remain unchanged. Durable-recovery run
`2026-09-10T11-43-52-891Z-durable-recovery-1f22f9bc` passed, as did docs and whitespace
checks. The checkout contains 374 dirty paths; all 370 paths present at the start
of this slice remain. No changes were committed, published or applied to a live
channel/provider or a second machine.

## Generic MCP tool dispatch

The shared tool-invocation coordinator now routes an allowed `mcp.invoke` wrapper
through the MCP runtime owner. Previously the generic tool path sent that wrapper
to the ordinary built-in executor, which does not implement the MCP transport.
Policy retains the original arguments and Chat turn/tool-run correlation with
`externalRuntime: true`; approvals continue through the canonical approval-effect
owner. Denials and dry runs do not dispatch. A direct tool grant does not replace
MCP first-use consent, native-tool policy, auth or capability scope.

The MCP owner awaits the execution fence and durable effect receipt before entry
to the transport owner. The ordinary built-in receipt callback is not invoked.
Uncertain outcomes retain `unknown_after_send` and manual reconciliation truth.
Direct calls share approved MCP result normalization without claiming that a
direct call was approved. Request arguments cannot populate requester authority.

Fresh local evidence:

- `.tmp/comparison-mcp-tool-dispatch-unit-first.log`: all 122 coordinator and
  approval-adapter tests passed. New cases use the real policy engine and async
  SQLite owner for allow, deny, approval and dry-run behavior; other cases check
  first-use/scope/native-tool/requester gates, lost execution authority, durable
  receipt failure, uncertain outcomes and rejection of direct approval replay.
- `.tmp/comparison-mcp-tool-dispatch-scope-first.log`: all 45 Gateway requester
  composition, capability-scope and scoped-transport tests passed.
- `.tmp/comparison-mcp-tool-dispatch-typecheck-first.log` and
  `.tmp/comparison-mcp-tool-dispatch-lint-first.log`: Gateway typecheck and scoped
  lint passed.
- `.tmp/comparison-mcp-tool-dispatch-conformance-first.log`: the named
  `verify:mcp:conformance` lane passed all six tests.
- `.tmp/comparison-mcp-tool-dispatch-async-boundary-first.log`: the named async
  boundary lane passed its ten tests and scanned 966 production TypeScript files.

The first regression receipt retains the dispatch failures plus a test-harness
transaction error. The second passed three cases and retained that harness error;
the approval fixture was then corrected to use `createSqliteAsyncStorage`.
Neither failed receipt is presented as a passing run. All 374 pre-existing dirty
paths remain. No schema, credential, installed runtime or live provider/channel
state was changed.

This fixes the shared generic MCP prerequisite. It does not prove native-worker
MCP execution end to end. Frozen native-tool catalog/approval mapping still needs
integration; the following slice carries requester context through Chat and
approval continuation. Requester-scoped and mesh worker placement remain disabled.
The full C5/C6 source and live acceptance boundaries remain open.

## Chat requester identity through MCP approval

Ordinary Chat's generic MCP invocation now carries a process-local branded handle
from its frozen capability profile through both the effect-aware and legacy tool
ports. Worker effects use a Gateway-composed factory after loading and checking
the admitted profile. The same protected context reaches approved worker
continuation; the execution fence is awaited before the durable effect marker.
No handle enters the request DTO, transcript, pending action or provider payload.

For ordinary Chat approval replay, `mcp-approved-chat-context.ts` joins the exact
retained pending request, resolved approval, approval-linked tool run and stored
profile. Changed actor, source, session, workspace, turn, Citadel, run, selected
tool or approval linkage cannot restore requester identity. Missing legacy Chat
linkage leaves scoped dispatch closed. Reviewed argument edits retain the original
requester identity, while current policy and native MCP checks still govern the
invocation. The approval adapter also carries the canonical policy redaction
decision into MCP output processing.

The focused owner suite passed 185 tests in
`.tmp/comparison-mcp-context-owners-second.log`; the separate ward/brand selection
passed six in `.tmp/comparison-mcp-context-ward-brand-first.log`. The first worker
context probe correctly rejected a fixture approval still labeled `channel.send`;
the fixture now binds its actual selected tool and the production guard remains.
Gateway typecheck and scoped lint passed in the matching `typecheck-second` and
`lint-first` logs.

The named `verify:mcp:requester-scope` rerun passed all 15 scenarios in
`artifacts/verification/2026-09-10T12-32-48-047Z-mcp-requester-scope-061df0d0`.
Its Chat/approval group now includes the new context tests. Auth-matrix,
runtime-truth, MCP conformance, typechecks, formatting and hygiene passed. The
live-PostgreSQL sub-check explicitly skipped because no test URL was configured;
this slice adds no storage migration. The earlier
`2026-09-10T12-28-55-511Z-mcp-requester-scope-d58a7b22` receipt retains its sole
Gateway formatting failure; the reviewed worker/approval-method formatting was
corrected before the complete rerun.

This closes the context-forwarding prerequisite, not native-worker scoped MCP
acceptance. Native catalog exposure and policy/approval mapping remain unfinished,
alongside the other C5/C6 source and live gates above. The existing default-empty
Gateway resolver registry and credential boundaries remain unchanged.

## Named MCP policy identity

The policy engine now accepts a process-local mapping for a selected native MCP
tool. It retains the exact native name and arguments through policy decisions,
pending approvals and approved replay, while using the registered `mcp.invoke`
risk/security definition. Global and scoped deny patterns, permission ceilings,
and Citadel Wards remain enforced across native and policy identities. Registered
tool collisions, missing/forged/copied mappings, mismatched names, untrusted
escalation and attempts to enter the ordinary built-in executor are rejected.
The mapping does not provide credentials, requester authority or tool selection.

SQLite 217 / PostgreSQL 162 add an optional shared policy identity to access
decisions. MCP-wide grants count named calls against the same root limit; native
grants retain exact-name counts. Mutation counts stay conservative. Existing
grant selection and single-use consumption rules remain authoritative; inspection,
denial and dry-run evidence do not acquire new counting behavior. Historical
decisions keep their original bytes and NULL policy identity.

Fresh focused evidence:

- `.tmp/comparison-mcp-alias-policy-second.log`: 152 policy tests passed, including
  native/wrapper denies, scoped grants, permission ceilings, Wards, shared and
  native rate limits, mutation limits, one-time grant consumption and exact
  approval replay with current-policy rechecks.
- `.tmp/comparison-mcp-alias-storage-first.log`: 31 access-decision, SQLite upgrade
  and migration-integrity tests passed.
- `.tmp/comparison-mcp-alias-wards-first.log`: all 17 Ward contract tests passed.
- `.tmp/comparison-mcp-alias-postgres-third.log`: the disposable PostgreSQL test
  passed without skips. It executes the same five-scope accounting fixture,
  rejects invalid identities, and applies the real forward migration to retained
  legacy rows twice. Its owned server on port 52577 was stopped.
- `.tmp/comparison-mcp-alias-migration-parity-first.log`: the named migration
  parity lane passed through SQLite 217 / PostgreSQL 162. Every pre-existing
  migration entry through 216/161 was preserved. Only this turn's unshipped
  PostgreSQL 162 draft was corrected and re-pinned during validation.
- `.tmp/comparison-mcp-alias-typecheck-fifth.log` and
  `.tmp/comparison-mcp-alias-lint-first.log`: policy/storage/contracts typecheck
  and scoped lint passed.

The named `verify:mcp:requester-scope` run passed all 15 scenarios in
`artifacts/verification/2026-09-10T13-09-19-021Z-mcp-requester-scope-35ab8405`.
Its 19 checks include the new 26-test native-policy group and expanded SQLite
accounting group; auth-matrix, runtime-truth, MCP conformance, Gateway/policy
typechecks, formatting and hygiene passed. The optional general PostgreSQL
sub-check skipped because its URL was unset. The separate disposable PostgreSQL
receipt above covers this change without a skip. Docs checks passed as well.

The first PostgreSQL receipt found that fresh bootstrap already creates the new
column; the second found that its inline CHECK was not projected. The PostgreSQL
migration now handles the existing column/index and adds an explicit named
constraint. Both failed receipts remain. The first policy receipt retains a
fixture assertion that expected a permission-ceiling result before the stronger
heartbeat deny; the corrected fixture proves both gates without relaxing policy.

This implements the named-policy/accounting foundation. Native catalog exposure,
Gateway invocation/approval mapping, mesh and worker placement integration remain
unfinished, alongside the other C5/C6 source and live gates. No live provider,
channel, credential, installed runtime or user database was changed.
The following slice adds generic-wrapper target checks and accounting to this
named policy port. At this checkpoint all 378 pre-existing dirty paths remained in the
390-path worktree; nothing was staged, committed or published.

## MCP wrapper policy parity

Generic `mcp.invoke` requests now evaluate their exact native target as well as
the shared MCP policy name. Target projection uses the same trimmed server and
tool fields as transport; the nested arguments supplied to the native tool are
also the arguments checked by grant constraints. A plain wrapper projection
cannot mint the branded handle required to invoke a named tool.

Access decisions record the canonical target and shared MCP identity. Switching
between a named call and a generic wrapper cannot restart either counter.
Approvals, pending requests, returned invocation identity and audit retain the
original wrapper and exact arguments. Approved wrapper replay rechecks the
native target against current policy. Historical generic decisions retain their
original accounting; no native attribution is invented for them. No additional
storage migration was required.

The focused policy suite passed 160 tests in
`.tmp/comparison-mcp-wrapper-policy-third.log`. It covers mixed wrapper/named
limits, deny patterns, exact approval replay, argument normalization, nested host
constraints, and rejection of native targets that collide with registered tools.
The first receipt retains one older assertion that expected
the wrapper name in accounting; its replacement requires both canonical target
and shared identity while keeping the original-request assertions.

The Gateway coordinator and approval-adapter suite passed 126 tests in
`.tmp/comparison-mcp-wrapper-gateway-third.log`. Its real policy/SQLite fixture
executes both generic Chat and direct MCP calls through the same coordinator,
retains one transport call per invocation and shared totals, and blocks the
native deny before another transport call. A retained failing regression in
`.tmp/comparison-mcp-wrapper-citadel-regression.log` showed direct MCP policy
checks missing the Gateway context normalizer and its canonical Citadel Ward.
The direct path now uses that owner while preserving the exact transport target
and arguments; the Ward blocks dispatch. Transport responses are controlled local
fixtures. Final Gateway typecheck and scoped lint passed in
`.tmp/comparison-mcp-wrapper-gateway-typecheck-second-final.log` and
`.tmp/comparison-mcp-wrapper-lint-final.log`.

The final source passed all 15 scenarios in `verify:mcp:requester-scope`, receipt
`2026-09-10T13-34-26-313Z-mcp-requester-scope-6632ba11`. Its 19 checks include
34 native policy/binding tests, 176 invocation-seam tests, 168 Chat tests and
21 storage tests, along with auth, runtime truth, conformance and typechecks.
Eighteen checks passed; the conditional general PostgreSQL check explicitly
skipped because `GOATCITADEL_TEST_POSTGRES_URL` was unset. The earlier disposable
PostgreSQL migration proof remains separate. All 390 pre-existing dirty paths
remain; nothing was staged, committed or published.

At that checkpoint, native catalog exposure, named Gateway dispatch/approval
mapping, requester-scoped worker placement and the remaining C5/C6 source/live
work were still open. The following slice adds dispatch for selected requester
bindings; it does not complete catalog exposure or worker placement.

## Native MCP dispatch from a frozen Chat binding

The Gateway now resolves a selected native MCP target from the exact durable Chat
profile and its process-local requester context. It checks actor, scope, profile
and catalog hashes, unique selection and binding integrity before creating the
native policy mapping. It uses the explicit stored server ID rather than splitting
dotted names, and rejects missing or copied handles before reading storage.
Static/legacy profiles without a native binding stay closed.

Ordinary invocation, the last Chat policy probe and approved replay retain native
names and arguments. The transport conversion cannot reinterpret native arguments
as wrapper authority. Approved replay restores the original Chat linkage, retains
one context across fresh policy/profile checks, and refuses target, mode or runtime
owner drift. Unknown-after-send results still require manual reconciliation.

The integration work found that requester-scoped servers skipped their native
tool allowlist, deny patterns and first-use consent. Six controlled failing cases
are retained in `.tmp/comparison-native-mcp-server-policy-regression.log`. Static
and requester-scoped targets now share those checks; approval satisfies only the
reviewed invocation's first-use consent, never a current deny or changed owner.

The initial focused slice passed 215 tests in
`.tmp/comparison-native-mcp-second.log`. After the server-policy correction, the
coordinator and composed-runtime suite passed 147 tests in
`.tmp/comparison-native-mcp-composition-second.log`. The composed case uses a stored
profile fixture, real policy/SQLite accounting and the requester resolution and
transport owners against controlled MCP responses. It reaches one `tools/call`,
crosses each effect fence once, counts both native/shared identity, and blocks a
revoked requester before another wire call. This is not a complete production Chat
catalog or a live MCP provider acceptance run. Earlier receipts retain a malformed
test hash fixture and a test-only parsing error; neither is presented as green.

Final verification passed all 15 scenarios in `verify:mcp:requester-scope`, receipt
`2026-09-10T14-06-17-619Z-mcp-requester-scope-677b9d58`. The expanded lane includes
225 invocation-seam tests, 174 Chat/profile-context tests, 19 composition tests
and 34 native policy/binding tests. Eighteen checks passed; the conditional general
PostgreSQL sub-check skipped explicitly because its test URL was unset.
`verify:durable:recovery` passed all three checks in
`2026-09-10T14-06-25-535Z-durable-recovery-dd04be0e`. Those existing restart,
worker and approval-wake checks do not establish native MCP recovery after restart:
requester discovery outcomes remain process-local and still need a recovery path.
Gateway/policy typechecks, scoped lint, docs checks and `git diff --check` passed.
All 390 pre-existing dirty paths remain in the 393-path worktree; nothing was
staged, committed or published.

At that receipt, native catalog exposure, static native target bindings,
requester discovery recovery, requester-scoped worker placement, mesh/delegation
work and the remaining C5/C6 source/live gates were open. No provider, channel,
credential or installed runtime was changed.

## Requester-scoped native Chat catalog and discovery recovery

Chat admission now calls the existing authenticated resolution, transport and
secret-scanning owners to enumerate requester-specific native tools. It combines
their immutable descriptors with the base capability catalog and revalidates each
server's descriptors against the final catalog. One connection per server handles
each pass. Both passes bound concurrency to four and use a 30-second deadline;
enumeration selects at most 16 servers and distributes at most 256 candidate tools
across those servers. The runner retains its existing final tool/token limits.

The runner requires the registered shared MCP capability and a successful current
policy inspection. Native schemas and aliases are retained exactly; untrusted
effect hints cannot make them read-only. Cloned catalogs/schema handles, registered
name collisions and ambiguous dotted native names cannot enter the allow-map.
Policy handles remain app-private and cannot be serialized into profiles or DTOs.
Current-catalog validation checks the shared MCP capability plus the native
requester/server authority without publishing private tools in the global catalog.

New aliases encode the full SHA-256 digest in 48 characters. The previous prefix
plus hexadecimal digest required 69 characters, exceeding OpenAI's documented
[64-character function-name limit](https://platform.openai.com/docs/api-reference/chat/message-list?lang=ruby).
Retained full-hex aliases are accepted only when they represent the same exact
descriptor/binding digest; recovery preserves the stored alias and profile hash.

A replacement requester runtime can reconstruct a missing discovery outcome only
from the exact stored Chat profile and binding. It rechecks actor, workspace,
server configuration and current resolver registration before resolving new
credentials, then requires fresh discovery to reproduce the retained alias.
Concurrent reconstruction for the same profile/tool shares one attempt. The
existing invocation/effect owner still governs the actual tool call; discovery
recovery does not authorize replay of an uncertain side effect. No credentials or
process-local discovery outcomes are persisted.

The composed test now exercises actual discovery, Chat schema selection, policy
inspection, SQLite profile/snapshot persistence under a session-incarnation
admission, a replacement requester-runtime instance, and native execution through
the real policy/coordinator/transport owners. It retains one effect boundary and
the shared/native counters, and blocks server, schema, profile and requester
revocation drift before another tool call. This uses controlled MCP wire responses;
it is not a full Gateway process restart or live provider acceptance.

Focused receipts:

- `.tmp/comparison-native-catalog-tests-first.log`: 79 tests passed across native
  catalog admission, profile freeze, resolution orchestration and authority.
- `.tmp/comparison-native-catalog-contracts-first.log`: nine contract tests passed.
- `.tmp/comparison-native-catalog-runner-first.log`: 41 runner/profile/catalog tests
  passed, including policy denial/unavailability and missing shared capability.
- `.tmp/comparison-native-catalog-composition-recovery.log`: 17 composed tests
  passed, including the new persistence/recovery/execution case.
- `.tmp/comparison-native-catalog-alias-compat.log`: 45 authority/orchestration
  tests passed after adding exact retained-alias compatibility.

The first named MCP run passed all 15 scenarios in
`2026-09-10T14-56-06-439Z-mcp-requester-scope-a8d9885d`, before the small retained-alias
compatibility addition. It included 225 invocation, 190 Chat/profile, 22 composed
runtime/diagnostic and 34 native policy checks. The general PostgreSQL sub-check
explicitly skipped because its test URL was unset. The final named MCP run passed
all 15 scenarios after that compatibility addition in
`2026-09-10T15-02-54-844Z-mcp-requester-scope-eeb8d1ac`, with 18 passing checks and the
same explicitly skipped general PostgreSQL sub-check. It includes the expanded
native catalog and recovery tests, auth matrix, runtime truth, static MCP
conformance, typechecks, formatting and whitespace checks.

`verify:durable:recovery` passed three checks without skips in
`2026-09-10T14-57-43-211Z-durable-recovery-847e50f9`. That lane establishes its existing
approval-wait/restart/dead-letter and worker checks; the new native reconstruction
boundary is established by the composed test above. The final scoped lint passed
without warnings, and `pnpm docs:check` passed. Earlier typecheck receipts retain an omitted runtime forwarding
parameter and a TypeScript narrowing issue; the later typecheck passed.

At that receipt, static native bindings, requester-scoped/mesh worker placement, broader
delegation/council, protected native Windows execution/custody/service, full
Gateway native-MCP restart, physical two-machine and live C5/C6 acceptance remain
open. The resolver registry remains constructor-owned and empty by default; this
does not add a built-in requester credential provider. All 395 paths dirty at the
start of this continuation remain present in the 403-path worktree. Nothing was
staged, committed or pushed. No live provider/channel traffic,
user credentials, installed runtime, historical migration or publication changed.

## Requester-scoped native MCP in worker execution

Worker placement now admits requester-native MCP profiles when the Gateway's
requester authority is composed and the admitted worker has governed-tool support.
The shared worker profile owner revalidates each private tool through that
authority during offer creation, inference and effect execution. Retained native
bindings from catalogs without the newer private source marker also require the
current requester owner. The resolved policy actor must match the frozen actor.
Missing owners and withdrawn shared MCP capabilities cannot publish an offer.

The effect owner creates MCP context only from the verified retained profile and
checks its private brand, exact actor, profile, catalog and native target before
starting a Chat tool run. Requester checks run again at the effect fence. The
Gateway's worker approval continuation now supplies the canonical native policy
mapping and target to the existing approved-action adapter. It preserves the
native pending request and arguments, checks current authority before policy and
transport, and keeps the existing effect ledger and uncertain-outcome rules.
No requester credentials or private handles are sent to the worker.

The composed test now covers local Chat, worker effects, and an approved worker
continuation. It uses actual native discovery and schema selection, stored
profiles, policy accounting, Gateway approval execution, and MCP transport owners
against controlled wire responses. Each worker case records one effect and
replays its terminal result without another dispatch. The approved case rebuilds
the requester runtime after approval, preserving the original alias and tool.
Protected worker admission and approval handoff are fixtures; this does not prove
a spawned worker, full Gateway process restart, installed service, live provider
or second physical machine for native MCP.

Focused effect tests cover missing/revoked authority, missing/cloned/foreign
contexts, changed policy actor, revocation before send, successful replay and
unknown-after-send reconciliation. Placement tests cover private catalog
admission, missing authority, capability withdrawal and unchanged budget usage.
Mesh and unsupported static native MCP profiles remain on their local path.

The first focused receipt retained a malformed test-only requester scope material
(extra identity fields); the corrected effect suite passed all 42 tests in
`.tmp/comparison-worker-native-mcp-composed-first.log`. That aggregate still
failed its two new composed worker cases. Subsequent composed receipts retain
fixture activation, async-facade composition, hook binding and approval lifecycle
setup failures. The corrected targeted composed run passed all three selected
journeys in `.tmp/comparison-worker-native-mcp-composed-sixth.log`; the other 16
tests were explicitly filtered out. Gateway typecheck and scoped lint passed.
The named MCP lane now includes the worker placement and effect suites.

Final verification passed all 15 MCP scenarios in
`2026-09-10T15-33-43-994Z-mcp-requester-scope-68d845b5`: 18 checks passed and the
general PostgreSQL sub-check explicitly skipped because its test URL was unset.
This includes 87 composition/diagnostic/worker tests, 225 invocation-seam tests,
190 Chat/profile tests, native policy checks, auth matrix, runtime truth and the
Gateway/policy typechecks. The separate durable-recovery run
`2026-09-10T15-33-45-879Z-durable-recovery-570d2afd` passed all three checks without
skips. Its existing restart/approval-wake checks do not certify a full Gateway
native-MCP restart. Scoped lint, docs checks and `git diff --check` passed.

All 403 paths dirty at the start remain present; nothing is staged, committed or
published. No migration, live provider/channel traffic, user credential or installed
runtime changed. Static native MCP bindings, mesh/delegation/council execution,
protected native Windows execution/custody/service, spawned native-MCP worker
proof, full Gateway native-MCP restart and physical/live C5/C6 acceptance remained
open at that checkpoint. The next receipt closes the spawned-worker proof only.

## Native MCP through actual Windows worker processes

The connected-worker fixture now uses the real requester composition, native
catalog binding, policy engine, invocation coordinator and approved-action owner.
Actual Windows worker processes cross the protected TLS listener, persist tool
effects, resume after approval and requester-owner replacement, publish artifacts,
settle their grant, and materialize the final Chat result. The successful journeys
assert exactly one MCP call with the original arguments, no duplicate dispatch on
replay, and no synthetic credential in worker reports or persisted Chat tool runs.
Revoking the requester after the first model result prevents tool dispatch and
creates no tool effect, artifact or terminal settlement.

`.tmp/comparison-native-mcp-process-third.log` passed all five selected tests:
direct native MCP, approved native MCP, requester revocation, and both existing
file-tool journeys. Nine unrelated tests were filtered out. The first two attempts
retain fixture scope-binding and inherited effect-expectation failures; they are
not green aggregate receipts. Scoped ESLint passed in
`.tmp/comparison-native-mcp-process-lint-final.log`.

The model and MCP wire responses are controlled, with synthetic credentials. The
Gateway owners run inside the test process; replacing those owners and restarting
workers does not establish full built-Gateway process recovery. Static native MCP,
mesh/delegation/council execution, protected Windows execution/custody/service,
full Gateway native-MCP restart, and physical/live C5/C6 acceptance remained open
at that checkpoint. The following process receipt advances the restart boundary.

## Native MCP across a built Gateway application restart

Trusted application composition now forwards the resolver registry through
`buildApp`, the storage plugin and runtime factory to the Gateway constructor.
Stock startup registers no resolvers. No environment loader, route, skill or
add-on can replace that registry. The process fixture imports the built application
and starts its real native worker listener with a synthetic requester resolver.

Worker permission checks now re-resolve the current default or activated profile
before attempting caller selection. This fixes a Gateway-selected global profile
being rejected as a caller request. The shared worker authority still compares the
exact frozen profile and override; custom profiles must pass the existing caller
selection rules, and missing current authority fails closed.

Both selected native MCP restart journeys passed in
`.tmp/comparison-native-mcp-gateway-third.log` (four non-MCP cases filtered).
The direct journey changed Gateway PID 29276 to 13220; the approval journey changed
13608 to 67760. Their results are retained under
`.tmp/worker-gateway-restart-0763b3c3-af5b-40b3-bfd9-5033e695f048/result.json` and
`.tmp/worker-gateway-restart-7437975e-e1a6-4ca4-a4e1-5f017c113758/result.json`.
Each completed one generated task and one Chat turn, reconstructed discovery,
executed exactly one MCP call with the original arguments, and replayed without
another call. Each retained two worker model requests and three separate Chat
post-commit requests, all against the controlled provider.

The first run exposed the permission-selection bug and a copied fixture MCP deny;
the second confirmed deny-wins excluded both wrapper and native tool. The corrected
isolated fixture opts into only the controlled MCP tool and loopback destination.
The operator configuration was not changed. All 35 application, storage-plugin and
permission-owner tests passed in `.tmp/comparison-native-mcp-gateway-owners.log`;
the six verification-runtime and twelve worker-lane contract tests also passed.

The final unfiltered restart suite passed all six cases in
`.tmp/comparison-native-mcp-gateway-full.log`, with no skips: the four stock-entry
text/file-tool journeys and both constructor-resolver MCP journeys. Scoped ESLint
and `pnpm docs:check` passed. This is a fresh six-case process receipt, separate
from the whole-workspace verification below.

The named MCP lane passed all 15 scenarios in
`2026-09-10T16-19-11-144Z-mcp-requester-scope-774808a0`, including 91 composition/
worker tests, 225 invocation tests and 190 Chat/profile tests. Its conditional
general PostgreSQL check skipped because no test URL was set. The separate named
durable-recovery run `2026-09-10T16-19-19-513Z-durable-recovery-f783c51a` passed
all three scenarios with no skips. Typechecks, formatting and whitespace checks
also passed. All 403 pre-existing dirty status entries remain present; the
checkout now has 407 dirty entries and nothing staged.

These receipts establish built-application process recovery with controlled
transports and synthetic custody. They do not establish installed Windows service
behavior, protected native execution/custody, a physical second machine, or live
provider/channel quality. Static native MCP, mesh/delegation/council and other
C5/C6 source and live acceptance work remain unfinished.

## Whole-workspace verification

The broad run `2026-09-10T16-25-34-273Z-fast-99a2807f` completed with seventeen
checks passed and four failed groups: three Gateway shards and storage. Gateway
repairs began after its test scenarios finished, so this is a failed diagnostic
aggregate; its results do not cover one fixed working tree. Its Gateway portion found
two stale test inputs/assertions, three coverage timeouts and one native listener
startup failure. The startup-order guard now accepts the awaited plugin options form,
and the facade test supplies a complete tool-access request. Gateway coverage now
opts into the existing SQLite schema template; fresh databases still validate
their migration ledger and canonical schema. The fixture benchmark's raw samples
showed warmed copies at 66-72 ms versus 9.4-10.8 seconds for a fresh file migration.

The four affected test files passed all 137 tests under four-worker V8 coverage in
`.tmp/comparison-fast-repair-coverage.log`, without increasing their time limits.
The final typed facade request also passed all fifteen facade tests in
`.tmp/comparison-fast-repair-facade-final.log`.
Native listener startup errors now retain only fixed stage/reason diagnostics,
never upstream error text or causes. All twelve listener tests passed in
`.tmp/comparison-fast-repair-native-tls.log`, including a port conflict that leaves
the existing listener untouched. The verification harness's twelve tests, scoped
lint, formatting and whitespace checks passed as well.

The process fixture now chooses its native port after the initial workspace build
to avoid leaving a released probe port unused during compilation. The historical
startup failure had only a generic error; its underlying cause is not established.
These focused repairs do not replace that run's failed Gateway results or certify
a complete C5/C6 implementation.

The storage group passed 1,603 tests, failed five, and skipped 102. Its current
PostgreSQL manifest has 331 tables, 4,712 columns and 743 canonical indexes (755
declared indexes); the SQLite head is version 217, `tool_policy_identity`. Inventory
expectations now match those owners. The v213 upgrade fixture models the absence
of generated Chat tasks only while seeding historical rows and restores the current
lookup before upgrade. The sparse external-source proof now expects the later
required-authority migration to refuse missing guards, before final schema admission.
Historical migrations and runtime enforcement were not changed.

All ninety focused migration tests passed with no skips in
`.tmp/comparison-fast-repair-storage.log`. The Gateway typecheck passed after the
aggregate released its output lock in `.tmp/comparison-fast-repair-typecheck-final.log`.
The fresh built-process run in `.tmp/comparison-fast-repair-gateway-restart.log`
passed five of six cases. The approved native MCP case executed its one tool call
and two controlled model requests, then failed during completion with HTTP 403 on
`assignment.settlement.submit`. The exact rejected submission and authority fence
are not yet established. Its retained evidence is under
`.tmp/worker-gateway-restart-6cc61faa-bead-4063-b2f2-88c6c1b79225/`, including
`failure.json`, `completion.json` and `tool-state.json`. The earlier native listener
startup failure did not recur in this run. Worker completion remains an open C5
repair; the five successful cases do not make this six-case receipt green.

The broad fast run `2026-09-09T18-35-08-817Z-fast-e4efe0bb` passed 17 checks and
failed four. Smoke/exercise used an earlier compiled contracts export while source
was changing; both passed after rebuild in their `comparison-coverage-*-followup`
logs. Storage passed 1,589 tests but failed two stale schema inventory assertions;
the corrected inventory passed all 56 focused migrator tests in
`.tmp/comparison-postgres-inventory-followup.log`. A mock budget-dialog button lacked
an explicit type; the corrected docs lane passed in
`.tmp/comparison-docs-after-fast-fix.log`. These follow-ups do not replace the failed
aggregate receipt or certify an exact-revision release.

## Artifact publication across a worker heartbeat

A controlled six-second CAS delay reproduced a concrete completion race in
`.tmp/comparison-worker-slow-artifact-before.log`: `artifact.commit` submitted
lease revision 19 while the worker heartbeat advanced the current lease to 20.
No artifact manifest was committed. The evidence is retained under
`.tmp/worker-gateway-restart-e99b8c74-a307-4938-b4bc-446777dbeeb0/`.
This identifies the delayed reproduction; the earlier failure without a
submission label cannot be assigned the same cause conclusively.

The artifact owner now captures a server-owned continuation after the request's
exact lease check. Subsequent CAS and verification fences permit routine renewal
only for the same live upload, assignment generation, parent owner/attempt and
unchanged durable payload. Current admission, worker generation, lease expiry,
assignment deadline and cancellation checks remain authoritative. New requests
still require the current lease. Worker-supplied continuation fields are rejected
before nonce consumption. No migration or retry behavior was changed.

The approved native-MCP restart case now includes that six-second CAS delay.
It passed in `.tmp/comparison-worker-slow-artifact-after.log` and in the subsequent
full matrix. The matrix in `.tmp/comparison-artifact-continuation-gateway.log`
still failed overall: twenty-six tests passed and one failed across three files.
The twenty-one protocol/artifact-owner tests passed, while five of six restart
cases passed. The direct native-MCP case reached a recorded artifact manifest,
one MCP call and two controlled provider requests, then received HTTP 403 on the
distinct final `assignment.settle` operation. Its evidence is retained under
`.tmp/worker-gateway-restart-b3dc7543-c515-4f7c-bec0-a48706ee7844/`.
That snapshot predates the terminal settlement repair documented below; the
artifact repair alone did not close worker completion.

Further focused checks passed:

- Nine worker rejection-diagnostic tests in
  `.tmp/comparison-worker-rejection-diagnostics-final.log`; reports include only
  fixed submission labels and bounded lease revisions, never tool arguments,
  lease tokens or upstream response contents.
- Four SQLite/PostgreSQL authority tests, with no skips, in
  `.tmp/comparison-artifact-continuation-postgres.log`. Both dialects exercised
  heartbeat and token rotation, stale new requests, changed parent/payload,
  missing/quarantined uploads and cancellation. The disposable PostgreSQL cluster
  was stopped and removed by its owning harness.
- Gateway, storage and worker typechecks, scoped lint/formatting, and the named
  async-boundary lane (ten tests and 969 production TypeScript files).
- The named durable-recovery run
  `2026-09-10T18-19-41-333Z-durable-recovery-ec96184f` passed all three scenarios
  without skips. Final typechecks, documentation and whitespace checks passed.

The named runtime-truth run
`2026-09-10T18-16-27-231Z-runtime-truth-c6f784c5` failed its approval/restart
journey: the durable run reported that execution had been interrupted after a
tool began and could not safely replay. Its dependent shell check skipped because
there was no completed run to inspect. This is a separate open recovery failure;
no successful focused result replaces that failed acceptance receipt.

C5/C6 source work and live acceptance remain open. No live provider/channel
traffic, physical-device installation, staging, commit or publication occurred.

## Terminal settlement across a parent heartbeat

The six-second final-settlement reproduction in
`.tmp/comparison-terminal-heartbeat-before.log` failed with HTTP 403 after the
parent advanced from version 7 to 8 while the worker retained lease revision 17.
The fixed diagnostic identifies the parent-heartbeat fence in
`.tmp/worker-gateway-restart-9fbe7c31-0f64-4023-b71b-feff7147b956/`.

Completed and failed worker settlements now optionally bind a proposed lease
rotation to the canonical request hash. Under the current protected credential,
node, generation and lease fences, the storage owner rotates that lease and
records settlement in the same transaction. Invalid event chains or missing
artifact evidence roll back both writes. The terminal lease cannot authorize
further execution. Only its digest crosses into storage; the protected wire
continues to carry the raw token.

The worker persists its proposed token before sending a v2 terminal intent and
reuses that exact intent after response loss or restart. Existing v1 pending
intents retain their original request hash and replay behavior. Cancellation
never creates a new lease. SQLite 218 / PostgreSQL 163 let a recorded operator
cancellation close after a monotonic heartbeat under the same live parent owner
and attempt. Event, execution and non-cancelled settlement guards keep their
exact fences. Historical migration bodies and receipts remain unchanged.

Fresh local evidence:

- All six built-Gateway restart cases passed in
  `.tmp/comparison-terminal-gateway-restart-matrix.log`. That combined invocation
  still exited unsuccessfully because the new protocol-unit fixture used an
  identifier rejected as secret-like. The corrected protocol suite subsequently
  passed all seventeen tests in `.tmp/comparison-terminal-protocol-verified.log`;
  these are separate receipts, not one green combined invocation.
- The delayed final-settlement case retained its successful result and fixed
  delay marker in
  `.tmp/worker-gateway-restart-0c9ce165-749f-4a0c-acd7-ba2612b4ce33/`.
  It recorded one MCP effect, two worker provider requests, and three separate
  Chat post-commit provider requests, all over controlled loopback transports.
- Seventeen contract tests and seventeen worker tests passed in
  `.tmp/comparison-terminal-contract-vitest.log` and
  `.tmp/comparison-terminal-worker-vitest.log`.
- Five SQLite/PostgreSQL authority tests passed without skips in
  `.tmp/comparison-terminal-renewal-postgres.log`, including direct database
  guard checks, rollback, exact replay and cancellation without renewal. The
  owning harness stopped its disposable PostgreSQL cluster.
- Migration parity passed through SQLite 218 / PostgreSQL 163, including all
  twenty-seven manifest tests and sixty-nine migration integrity/runtime-schema
  tests. Final package/Gateway typechecks and scoped lint/format checks passed.

The separate named runtime-truth acceptance failure was still open at this boundary. Its retained
tool row is a seeded `shell.exec` approval with uncertain legacy effect evidence;
the resolved approval produced no `pending_action_execute` effect. The following
section replaces that synthetic execution setup with a real governed request.

C5 still has native execution/volume/custody, installed service, broader worker
placement and delegation work. C6 and physical-machine/live-channel acceptance
remain open. This evidence does not certify an installed Windows service, a
second machine, live provider quality, or publication.

## Real approval-restart acceptance

`runtime-truth-approval.mjs` now requests a real `fs.read` through Chat preflight
and the normal agent-send stream. Only the disposable runtime is configured to
approve all tools. The fixture waits for the canonical approval and durable wait,
keeps its stream owned until restart/cleanup, and approves through the public
Chat API after restarting the Gateway. It no longer manufactures a waiting tool
row without the corresponding pending action. Background provider traffic cannot
consume the synthetic tool-call dispatch reserved for requests offering `fs_read`.

That journey exposed a production intent bug: reading a `.txt` file and asking to
"report its contents" caused the runner to synthesize `documents.create` after
the approved read. The retained failure is
`2026-09-10T19-09-36-741Z-runtime-truth-be7ebcf1`. A shared inspection-intent guard
now prevents document/presentation creation, routing obligations, and capability
scouting based only on an input format. Explicit create/save/export requests
remain supported, including requests that first inspect a source file. Words
inside quoted or unquoted filenames do not become creation instructions.

The fresh named `pnpm verify:runtime:truth` run
`2026-09-10T19-14-34-745Z-runtime-truth-2fe85481` passed both scenarios without
skips in 30.4 seconds. Its evidence proves the same durable run transitions from
waiting to completed, the original approved read returns the fixture contents,
and a persisted assistant response belongs to the original turn. The canonical
Next shell shows the recovered completed run with zero browser console/page
errors. Its screenshot was produced and inspected. The provider-generated
approval summary remains outside this proof; the plain synthetic reply is not
a valid explainer JSON response.

Focused verification passed fifty-one Gateway artifact/routing/scout tests and
nineteen fixture/restart-verifier tests. Gateway typecheck, scoped lint/format,
documentation and whitespace checks passed. Earlier failed receipts remain
intact and are not relabeled. All provider traffic in these runs is synthetic
and local. Native Windows execution/service work, broader worker integration,
the C6 comparison benchmark and physical mini-PC/Telegram acceptance remain open.

## Protected TLS client signing

The Windows provisioner now exposes a fixed TLS 1.3 client CertificateVerify
operation through its authenticated local transport. The request binds the
authenticated caller, current custody state, generation, keyset receipt and
runtime public key to the exact client-purpose preimage. Only the SHA-256 and
SHA-384 transcript forms are accepted. The protected signing owner validates the
purpose again before reading a key, retaining its existing file-identity,
two-pass hash, deadline, stop, revocation and one-use lease checks. Rejections
return no signing authority. The TypeScript client verifies the returned
signature against its private snapshot of the exact request bytes.

The [wire and custody contract](../security/remote-worker-tls-client-signing.md)
documents the operation and its bounds. Native tests exercise both transcript
lengths, malformed/truncated frames, cross-purpose data, changed caller and
custody bindings, replacement/revoked keys, failed-write cleanup and exact
signatures after signer-state restart. Deterministic signing does not claim
durable replay accounting.

The fresh `pnpm verify:remote-worker:windows-provisioner` run passed package
typecheck, all seventy-eight TypeScript tests and all forty-five packaging/native
checks without skips. Its retained log is
`.tmp/comparison-native-tls-named-verification.log`. The built x64 executable was
supplied for the ordinary process/INSPECT tests; this does not imply successful
installed privileged-client authentication. The full packaging checks rebuilt
both targets, ran native x64 ASan tests, verified identical clean-build bytes and
checked the production symbol/import boundary. Earlier compile/source-fixture
and old-binary-pin failures remain separate; the refreshed complete run passed.
Scoped lint/format, `pnpm docs:check` and `git diff --check` also passed.

The separately retained x64 and ARM64 candidate summaries are
`.tmp/comparison-native-tls-windows-x64-candidate.summary.json` and
`.tmp/comparison-native-tls-windows-arm64-candidate.summary.json`. They record
native x64 ASan execution over the 65,536-case corpus and byte-identical clean
builds of the service, client and availability broker. ARM64 target test code
was built but not executed. Those candidates precede the packaging test's
client-pin refresh; their source-manifest hash identifies that earlier snapshot.

This checkpoint supplied the protected TLS signing operation. At that point
`WorkerWireClient` still used only a PEM private key. The native adapter section
below records its later transport integration. Protected admission/runtime integration,
native execution/volume support and the connected worker's installed service
remain source requirements. Broader worker routing/delegation, C6, physical
mini-PC and Telegram/live-provider acceptance remain open. These local checks
did not install or start a production SCM service, send external messages, or
make upstream provider requests.

## Protected worker signing lifecycle

The worker now awaits channel-bound admission evidence and request signatures
before sending HTTP bytes. It snapshots request authority and headers and gives
both callbacks a connection-owned cancellation signal. Shutdown, disconnect and
the absolute deadline abort preparation; late fulfillment or rejection cannot
send a request. Concurrent signatures remain bound to their original TLS
connections. The native client runner accepts that signal, avoids starting a
pre-cancelled process, closes a cancellation during spawn before writing stdin,
and waits for its owned child's close or the existing termination watchdog.
An uncertain native outcome remains subject to reconciliation.

Fresh verification:

- All 116 worker tests passed, including seven real mTLS asynchronous
  evidence/signature cases, in `.tmp/comparison-protected-worker-tests-full.log`.
- `pnpm verify:remote-worker:windows-provisioner` passed typecheck, all 83
  provisioner tests and all 45 packaging/native checks without skips in
  `.tmp/comparison-protected-worker-provisioner-full.log`. This includes five
  cancellation tests and fresh reproducible native builds; ARM64 remains
  build-only proof.
- Worker, provisioner and Gateway typechecks and scoped lint/format checks
  passed, as did `pnpm docs:check` and `git diff --check`. Earlier failing tests in the two `*-red.log` receipts establish the
  missing asynchronous/cancellation behavior and remain separate.
- The selected real Windows worker admission/claim/transcript/settlement journey
  passed across a process restart in
  `.tmp/comparison-protected-worker-connected-smoke.log` (one passed, thirteen
  unselected). This is a focused integration receipt, not a fresh run of all
  connected-worker or Gateway-restart scenarios.

The disposable native engine probe then completed two real mTLS handshakes on
Node 24.19.0 / OpenSSL 3.5.7, one for each supported transcript hash length. The
client process received only public certificate/key material; a separate Node
fixture held the client private key and supplied one signature per handshake.
Both peers accepted the connections. The receipt is
`.tmp/comparison-protected-tls-external-handshake.log`; the parent watchdog,
listeners and children were closed. This proves the public-only key adapter
approach on that runtime. It does not exercise the authenticated native custody
service and is not a shipped engine. The [security contract](../security/remote-worker-tls-client-signing.md#tls-adapter-compatibility-evidence)
records its runtime/deprecation and process-ownership boundaries.

Connected-worker configuration/admission and retained credentials still use PEM.
Protected runtime/admission integration,
availability/installer/service ownership, native execution/volume support,
broader routing/delegation and the C6/live acceptance gates remain unfinished.

## Native TLS adapter and worker transport

The public-only native adapter now calls the fixed GCPW TLS signing operation
through an image-pinned helper process. It retains per-key authority, directory
and image identity checks, explicit inherited handles, an empty child environment,
owned job termination and strict output bounds. The exact returned signature is
verified before TLS receives it. Its OpenSSL method/cleanup ownership is separate
for each engine/key. The [security contract](../security/remote-worker-tls-client-signing.md#native-tls-key-adapter)
describes the runtime pin, synchronous callback and local disk-I/O limitations.

`WorkerWireClient` can use an owner-supplied TLS context with no PEM private key.
The transport rejects two/missing key sources and checks the negotiated TLS 1.3
version before preparing HTTP. The acceptance child loaded the native adapter
and completed a real worker HTTP request whose body matched the server's TLS
exporter. It received only public inputs. The helper is a separate synthetic
native signer using the existing test-only cryptography owner.

The complete `pnpm verify:remote-worker:windows-tls` run passed both package
typechecks, 119 worker tests, 16 identifier tests and 13 native/integration checks
without skips in `.tmp/comparison-native-tls-adapter-final.log`.
Native evidence is retained in `.tmp/native-tls-acceptance-DdZkKH/acceptance.json`.
Both TLS transcript variants passed; incorrect helper output/receipts/signatures,
hash drift and a hung helper were rejected. The hung helper returned failure at
about five seconds. x64 codec tests ran under ASan, and two builds each of the x64
and ARM64 DLLs produced identical bytes. ARM64 was not executed. Earlier compile,
test-fixture import and TLS-version regression failures remain separate receipts.
After that full run, the identifier's control-character check moved from a regex
to its existing character loop to satisfy lint; its 16 focused tests and package
typecheck passed again. Scoped lint/format, docs checks and `git diff --check`
passed. No task helper remained running, all 450 earlier dirty paths remained,
and the checkout had no staged or vendor changes.

The adapter is not yet admitted by an installed worker owner. At this checkpoint,
connected-worker admission and the vault still used PEM. The following section
records their later protected-key integration. Authenticated installed custody,
availability/service, native volume/executor and broader routing/delegation remain
unfinished. C5/C6 and physical mini-PC/Telegram/live-provider acceptance are open.

## Protected worker admission and restart

The connected worker and foreground process host now accept an owner-supplied
native key reference alongside the TLS context. Bootstrap evidence and PoP-v2
use the existing fixed native commands. The worker verifies returned signatures
over its original bytes, binds admission receipts and permission ceilings to the
ticket, and rejects results after cancellation. Gateway bootstrap admission now
supplies the stored target worker generation to PoP-v2 verification. A mismatched
generation still fails before admission commits.

The vault retains the public key reference instead of a PEM signing key on this
path. Restart requires the matching live owner, TLS identity, registry, generation,
keyset receipt and admission signer. Missing owners or a previously retained PEM
credential cannot trigger a fallback. Bearer and lease secrets still use the
existing durable state port; this change does not encrypt them or supply native
volume protection. Lost first-response or persistence outcomes still require
reconciliation rather than inventing a returned credential.

Fresh local verification:

- `pnpm verify:remote-worker:windows-tls` passed both package typechecks, all
  149 worker tests, 16 identifier tests and 14 native/integration checks without
  skips in `.tmp/comparison-protected-native-gateway-final.log`.
- `.tmp/native-tls-acceptance-3Mxjmk/acceptance.json` retains the native outcomes.
  Its `protected-worker-gateway.log` records one passing Gateway integration test:
  a built foreground worker admitted with native TLS, admission evidence and
  bootstrap PoP-v2, then a separate process reopened its unchanged credential
  state and completed a credential-authorized offer poll. Canonical Gateway
  verification and repositories accepted both requests. The worker received no
  private signing key, and its persisted credential contained none.
- The existing native lane also rebuilt matching x64/ARM64 DLLs, ran x64 codec
  ASan checks and rejected malformed, forged and hung helpers. ARM64 was not run.
- The Gateway admission/protocol suites passed all 32 tests in
  `.tmp/comparison-protected-bootstrap-v2-focused.log`, including the stored
  generation regression and legacy admission coverage.

Earlier red tests and the first failed native/Gateway integration remain separate
receipts. The initial native helper lacked the admission/runtime fixture commands;
the subsequent integration exposed the missing Gateway bootstrap generation.
The refreshed complete named lane passed after both were corrected.

The key holder in this acceptance is a synthetic native helper. It does not prove
authenticated installed custody, trusted DLL loading, service availability or an
installed worker. At that checkpoint the environment-configured CLI still used
PEM; the next section records its guarded startup integration. Native volume/executor,
broader worker routing/delegation, C6 and physical mini-PC/Telegram/provider
acceptance remain required source and live work.

## Guarded normal Windows worker startup

The normal worker entrypoint now accepts a public key identifier file and
public admission signer. It constructs the protected owner through the fixed
package-relative native guard; neither an environment variable nor retained
credential JSON chooses another addon. Mixed key sources, private signer fields,
certificate/SPKI mismatches and native loading failures stop startup. Malformed
ticket errors omit ticket content.

The native guard embeds the adapter's build hash and retains verified helper,
adapter and ancestor handles before loading TLS. It refuses changed bytes,
reparse ancestors and already-open writers. The same lease stays reachable with
both runtime owners. Tests exercise replacement refusal and release after GC
while the process remains alive; the guard has no process-launch, network,
service-control or signing imports. Both x64 and ARM64 guard/adapter builds
reproduce, with execution on x64 only.

Fresh local verification:

- `pnpm verify:remote-worker:windows-tls` passed both package typechecks,
  all 166 worker tests, 16 identifier tests and 23 native/integration checks
  without skips in `.tmp/comparison-installed-worker-tls-final.log`.
- `.tmp/native-tls-acceptance-eHor0w/acceptance.json` retains the native outcomes
  and separate x64/ARM64 import evidence. `protected-worker-gateway.log` records
  one passing Gateway test using the normal built `main.js`: initial protected
  admission, process exit, fresh startup, unchanged saved public key reference
  and an accepted credential-authorized offer poll. No signing private key was
  passed to the worker or saved in its credential state.
- Gateway, worker and provisioner typechecks passed in
  `.tmp/comparison-installed-startup-types-final.log`; scoped lint passed in
  `.tmp/comparison-installed-startup-lint-final.log`. The selected existing PEM
  worker admission/claim/transcript/settlement journey passed across restart in
  `.tmp/comparison-installed-startup-pem-smoke.log` (one passed, thirteen
  unselected). Docs, scoped formatting and `git diff --check` also passed.
  The expanded final Git audit preserved all 480 prior dirty paths; the six
  additions were scoped to this startup work, with no staged or vendor changes.
  Earlier startup red tests,
  the first failed fixture attempt with an older input schema and the initial
  guard path-normalization failure remain separate receipts.

This is a staged test bundle with workspace dependency junctions and a synthetic
native signer. The native guard and JavaScript/runtime dependency tree still
require trusted installed package ownership. Installed custody, availability
and worker services, native volume/executor, broader placement/delegation,
mesh/static native MCP bindings, C6 operator journeys and live acceptance remain
unfinished. The bearer/lease state port remains file-backed. No service was
installed or started, no upstream provider was called, and no external message
was sent in this acceptance.

## Portable Windows worker package

The worker now has a [portable package builder and verifier](REMOTE_WORKER_WINDOWS_PACKAGE.md).
It copies the reachable production dependency graph, pins the Node release images,
builds the TLS guard/adapter and provisioner trio, and retains an exact file
inventory. The foreground PowerShell launcher clears the parent environment except
for admitted worker settings and the Windows system root. It requires a protected
key reference. Signing and installed-tree admission still use their existing owners;
this unsigned package inventory grants no runtime authority.

Fresh local proof:

- `pnpm package:remote-worker:windows` produced 1,047 files / 101,070,923 bytes
  in `.tmp/comparison-worker-package-9260373eda354f29a7134a54a7eb1314/payload`.
  `.tmp/comparison-worker-package-first.log` and the neighboring package/native
  result files retain the build evidence. The native provisioner builder passed
  its reproducibility and x64 runtime tests. No service was installed or started.
- The package was independently copied to a directory with spaces outside the
  repository. `.tmp/comparison-worker-package-relocation-result.json` retains
  its location and expected manifest hash. Its embedded Node 24.19.0 / OpenSSL
  3.5.7 loaded the worker and resolved all checked dependencies inside the copied
  package, with no workspace junction or inherited module path.
- The normal packaged PowerShell launcher admitted the protected worker through
  canonical Gateway owners, exited, and restarted from its saved public key
  reference. The test injected invalid Node options and a foreign module path
  into the parent; neither reached the worker. One Gateway integration test
  passed in `.tmp/comparison-worker-package-gateway.log`. This used the synthetic
  native signing fixture, not an installed custody service.
- After that journey, `pnpm verify:remote-worker:windows-package --probe` passed
  all 12 package-file tests, the relocated import probe, and unchanged inventory
  verification in `.tmp/comparison-worker-package-verify-final.log`.
- The refreshed `pnpm verify:remote-worker:windows-tls` lane passed both package
  typechecks, all 166 worker tests, 16 identifier tests and 23 native/integration
  checks without skips in `.tmp/comparison-worker-package-tls.log`. Its retained
  native receipt is `.tmp/native-tls-acceptance-Fd76Kf/acceptance.json`; the
  existing staged-worker Gateway fixture also passed after the harness gained
  the portable-package branch. This is separate from the packaged-launcher run
  above. Gateway, worker and provisioner typechecks passed in
  `.tmp/comparison-worker-package-types.log`; scoped lint and formatting passed
  in `.tmp/comparison-worker-package-lint-final.log` and
  `.tmp/comparison-worker-package-format.log`.

The first offline deployment attempt refused an unrelated unused workspace patch;
the builder now scopes the allowance to unused patches while retaining script/hook
suppression and ordinary applicable-patch failure checks. The earlier failed receipt
is retained separately. Package verification is not a signature, native installed
ACL scan, protected state volume, worker service or forced-parent-death containment
proof. Those C5 requirements, broader routing/delegation, mesh/static native MCP,
C6 operator journeys and mini-PC/Telegram/provider acceptance remain unfinished.

## Windows provisioner installation recipe

The package's administrator-owned recipe now places the native client beside the
signer and availability broker. Its pin input includes the complete trio and both
embedded image bindings. The client and provisioner directories use the exact
three-ACE descriptor required by `local_transport.cpp`; the old two-ACE directory
descriptor could not pass that owner. The service SID setting is corrected from
`3` (restricted) to `1` (unrestricted), matching the pinned Windows SDK and native
broker validation. A native regression rejects the former setting for both services.
Service-control ACLs and the first-boot `1077` acceptance gate are unchanged.

Installation now creates directories with explicit protection, retains ancestors
with directory-list access so the Windows share check actually prevents rename,
and refuses to adopt a root planted after preflight. Image copies use exclusive
creation, bounded held-source reads, protection before writer release, and retained
read handles. Partial copies remain in rollback ownership. File permission readback
normalizes only the historical auto-inherited DACL flag; owner, protected state and
every ACE still participate. Uninstall requires the retained client hash and refuses
client drift, reparse paths and unknown footprint content before service mutation.

`pnpm verify:remote-worker:windows-install` passed all 14 top-level checks in
`.tmp/comparison-worker-install-checks-verified.log`, including 28 behavioral scenarios
under each of Windows PowerShell 5.1 and PowerShell 7. Those scenarios perform real
Win32 directory creation, permission application, rename/writer exclusion, handle
release and task-owned temporary-file rollback. They validate package input and
uninstall refusal without any SCM or installed-path mutation. Scoped JavaScript lint
passed in `.tmp/comparison-worker-install-lint-verified.log`; the new test block and required
line endings use the repository style while unrelated existing formatting remains.

The rebuilt x64 candidate is retained at
`.tmp/comparison-worker-install-verified-package-bf55db4e34b54e47892d04950deaa95f`.
Its successful build log is `.tmp/comparison-worker-install-package-build-verified.log`.
The native build executed its tests with AddressSanitizer, retained 65,536 seeded
cases, and produced identical images across two clean builds. This is x64 runtime
proof; this tranche did not execute ARM64 binaries.

The candidate contains 1,048 inventory files totaling 101,092,141 bytes. Its manifest
SHA-256 is `d17265c429481459e000fcb910083f1478b85e7ffc257c434fa96460cefbfb8d`.
It now includes `app/provisioner/install-receipt.json`, a compact set of actual image
hashes and embedded bindings covered by that inventory. Full native diagnostics
remain beside the payload; their size exceeds the installer's bounded input limit.

The payload was copied outside the repository into a path containing spaces.
`.tmp/comparison-worker-install-preflight-verified.json` retains the location,
independently checked inventory, native evidence and both packaged installer runs.
Windows PowerShell 5.1 and PowerShell 7 each passed seven preflight steps and refused
only the elevation check because the process was not an administrator. The refusal
is recorded on that step; it is not an installation pass. Neither run entered
staging or service installation, and the package inventory was unchanged afterward.
`pnpm verify:remote-worker:windows-package --root ... --manifest-sha256 ... --probe`
then exited zero with all 12 package checks passing and the bundled Node 24.19.0 /
OpenSSL 3.5.7 runtime importing its production dependencies. That exact result is
retained in `.tmp/comparison-worker-install-package-verification-exit.log`.

The retained earlier failures exposed a byte-enum PowerShell cast issue, insufficient
metadata-only directory handles, module-dependent hashing and Windows' retained DACL
bookkeeping flag. Packaged preflight also exposed the oversized diagnostic receipt,
refused steps incorrectly labeled passed, and a single-stream result losing its
array shape in PowerShell. The fixes are included in the final candidate. Earlier
failed receipts remain separate from these passing checks. These source, package
and temporary-filesystem checks do not prove an installed service lifecycle,
authenticated custody, native volume/executor or worker host. C5/C6 source work and
physical-device, channel and provider acceptance remain open.

## Native Windows worker process host

`apps/remote-worker-windows-host-native` now owns the packaged worker's OS process
lifetime. It launches only the package-relative Node and `main.js` pinned into the
host build, retains no-follow directory and image handles, and forwards a closed
set of worker settings. The worker handles the host's stdin closure as shutdown,
without adding admission, signing or tool authority. The PowerShell launcher keeps
that control pipe open and delegates process ownership to the native host.

Windows assigns the worker to its unnamed Job Object at creation. The job handle
is not inherited; the host sets a 64-process and 4 GiB committed-memory ceiling,
refuses breakaway from its job, and verifies OS zero-process accounting after exit.
Shutdown allows ten seconds for durable worker cleanup, then five seconds for
forced termination. Normal exit allows one second for delayed job accounting.
These are host lifetime/resource limits, not per-assignment AppContainer, WFP,
quota-volume or hostile-code execution isolation.

The implementation follows Microsoft's [process-creation job attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
and [nested-job rules](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs).
The first native run exposed delayed job exit accounting and the first kernel probe
observed Node's separate inner job. The corrected tests independently check the
host's job and actual descendant lifetime after leaving Node's inner job. Those
failed receipts remain separate from the final lane.

Fresh proof:

- `.tmp/comparison-worker-host-lane-final.log`: the named host lane passed its
  worker typecheck, 28 focused TypeScript tests and all 18 native test records
  (17 behavioral scenarios plus their parent). These include actual forced host
  and PowerShell-parent death, detached descendants, nested-job breakaway, timed-out
  shutdown, path and environment refusal, AddressSanitizer execution and refusal
  when the service dispatcher is invoked outside SCM. The native receipt is at
  `%TEMP%\Goat Worker Host 1kfPbr\acceptance.json`.
  x64 and ARM64 builds were reproducible; only x64 binaries executed.
- `.tmp/comparison-worker-host-worker-suite.log`: all 173 worker tests passed.
- `.tmp/comparison-worker-host-package-build.log`: the x64 v2 package built with
  1,052 files and 101,287,442 bytes. Its manifest SHA-256 is
  `1769a9c12946bb8b4b3b0e4182d4c0fd9f6c9dc1d33f23d0b43ad064a4a87836`;
  native host SHA-256 is
  `84dba05e2f042e6cd4e4b0288236cc8d95a0945f63a783e375f5f868fced2ba0`.
- `.tmp/comparison-worker-host-relocation-result.json` retains the independent
  copy outside the checkout. `.tmp/comparison-worker-host-package-admission-first.log`
  passed the actual packaged launcher and built worker through canonical Gateway
  bootstrap admission and retained-credential restart (1/1 test, no skip). This
  uses the retained synthetic native signer and loopback transport. It is not
  installed service custody or live-provider acceptance.
- `.tmp/comparison-worker-host-package-files-final.log` passed all 15 inventory
  checks, including rejection of v1, missing-host and redirected-host manifests.
  `.tmp/comparison-worker-host-candidate-verification.log` rechecked unchanged
  inventory, packaged runtime imports and byte-identical current launcher output.
  `.tmp/comparison-worker-host-lint-final.log` and
  `.tmp/comparison-worker-host-hygiene.log` retain passing scoped lint/style checks.

The fixed-name SCM dispatcher shares the native lifecycle owner and grants no
service-install or service-start operation. The service identity guard below adds
startup account/configuration checks. Installed startup/stop/recovery, protected
signer caller identity, and custody are still unimplemented or unproven.
The signer still requires an elevated interactive
caller; its policy was not relaxed. The first-boot signer/broker status gate, native
volume/executor, broader placement/delegation, mesh/static native MCP bindings,
C6 journeys and physical-machine/channel/provider acceptance remain open. No live
service was installed or started, and no external provider or destination was used.

## Windows worker service identity guard

The SCM entry point now calls `service_identity.cpp` before creating its worker
process. The guard reads the local OS token, LSA logon session, service configuration
and service object permissions. It requires the distinct virtual account
`NT SERVICE\GoatCitadelRemoteWorker` and its Windows-derived SID
`S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905`.
It rejects SYSTEM/shared accounts, filtered administrator membership, non-service
logons, mismatched authentication sessions, impersonation, restricted/AppContainer
tokens and additional privileges. Its only admitted privilege is
`SeChangeNotifyPrivilege`.

SCM must name the exact quoted executable, own-process demand start and unrestricted
service SID, with no dependencies, triggers or failure actions. The service object
must be SYSTEM-owned with a protected DACL: SYSTEM and Administrators can control
it, while the worker can only query configuration/status and read its security.
No installation, service-start or signer access is granted by this guard. The
portable foreground entry point retains its existing behavior.

The real SCM read exposed `RPC_X_BAD_STUB_DATA` (1783) from an oversized configuration
buffer. The corrected collector uses Microsoft's documented
[8 KiB SCM query limit](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-queryserviceconfigw).
It does not trust the service PID during `START_PENDING`, when Windows
[does not guarantee its validity](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-queryservicestatusex).
The failing `.tmp/comparison-worker-service-identity-second.log` and
`.tmp/comparison-worker-service-identity-scm-read.log` remain separate from passing
evidence. The earlier red test deliberately rejected the valid policy projection
before the implementation existed.

Fresh proof:

- `.tmp/comparison-worker-service-identity-host-lane.log`: the named host lane
  passed worker typecheck, 28 focused TypeScript tests and 19 native test records
  (17 lifetime scenarios, their parent, and the identity suite). The lifetime
  receipt is `%TEMP%\Goat Worker Host 7JAmhc\acceptance.json`.
  x64 and ARM64 builds were reproducible; only x64 executed.
- The identity receipt at
  `%TEMP%\Goat Worker Identity CJUWHW\acceptance.json`
  records 74 checks in each normal and AddressSanitizer build. It includes the
  actual interactive process token, a temporary identification impersonation token
  with verified reversion, and read-only queries of the Windows EventLog service.
  Policy projections cover the accepted contract and broader account/configuration/
  permission refusal. This is not a successful installed worker service launch.
- `.tmp/comparison-worker-service-identity-lint.log` retains passing scoped lint.
- `.tmp/comparison-worker-service-identity-package-build.log`: the fresh x64
  package contains 1,052 files and 101,307,511 bytes. Its manifest SHA-256 is
  `c902a1dcd483aa9789c4d537cbd1c0783cc200a5878ce543c23060ad414550dd`;
  native host SHA-256 is
  `3ffa0db690b5f3404bbff600f337245ab9179908217d6cd15e6351531172b04c`.
  The host receipt now uses `goatcitadel.remote-worker.windows-host.v2` and records
  the service account/privilege contract. The package inventory remains v2.
- `.tmp/comparison-worker-service-identity-relocation.json` records the copy at
  `%TEMP%\Goat Worker Identity Package P9a7mV\payload`.
  `.tmp/comparison-worker-service-identity-package-probe.log` passed all 15 package
  inventory tests and loaded the relocated worker runtime and declared dependencies
  with Node 24.19.0 / OpenSSL 3.5.7. Inventory was checked again after that probe.
  This pass did not repeat the earlier synthetic-signer Gateway admission journey.
- `.tmp/comparison-worker-service-identity-docs.log` retains passing documentation
  checks. The final scoped hygiene log records formatting, diff and checkout checks.

At that checkpoint, worker service installation, installed dependency-tree ownership,
actual startup/stop/recovery and protected runtime signer access remained
source/acceptance gaps. The next section records the installer and file-owner source
work. Existing signer/client directory permissions and elevated-interactive caller
checks were not relaxed. The first-boot signer/broker gate, protected native
volume/executor, broader placement/delegation, mesh/static native MCP bindings and
C6 live journeys also remain open. No service was installed, started, stopped or
reconfigured; no provider request or external message was sent.

## Windows worker installation and configuration owner

`install-worker-service.ps1` now stages the independently pinned v3 worker package
under the OS-derived `ProgramData\GoatCitadel\RemoteWorker` root and creates the
dedicated virtual-account service in the stopped, demand-start state. It separates
SYSTEM-owned payload/configuration from worker-writable state, applies file owner
and DACL at creation, and verifies copied bytes and SCM settings before success.
An existing worker footprint is refused. Failure cleanup tracks this invocation's
files and original service handle; uncertain service ownership preserves the
footprint. A pre-existing shared GoatCitadel root retains its ACL with only the
exact worker read grant added.

`uninstall-worker-service.ps1` verifies the retained installation receipt, package
bytes, permissions and stopped service. It holds verified removal handles before
changing SCM and deletes payload files through those handles. Active host read
handles prevent removal. Configuration and state are retained; directory removal
is nonrecursive and the script never stops a process. A retained footprint requires
an explicit operator archive/migration before a subsequent fresh installation.

The native `InstalledWorkerFiles` owner checks fixed installed paths and their
permissions, pins the dependency tree and public configuration inputs, and parses
the installer-generated UTF-16 environment. It allows exactly the twelve supported
settings with fixed configuration/state references and continuous governed-inference
mode. Handles remain held until the child process exits. Portable foreground
startup retains its existing configuration path. The installed profile bounds
individual files at 256 MiB and the combined held files at 512 MiB; this is stricter
than the general portable inventory limit.

Fresh local proof:

- `.tmp/comparison-worker-install-owner-named-lane.log`: the named service-install
  lane passed all 21 top-level tests, including 20 package inventory tests and the
  Windows installer/configuration suite. Missing installer helpers and old v1/v2
  manifests are refused even when the modified inventory is freshly hashed.
- `%TEMP%\Goat Worker Install a1FkGJ\acceptance.json`
  records 28 temporary-file cases under each PowerShell 5.1.26100.9343 and 7.6.5
  engine, plus 37 native checks in each normal and AddressSanitizer run per engine.
  File checks cover atomic permissions, writer/rename exclusion, handle-bound
  removal, changed sources, alternate streams, hardlinks and reparse refusal.
  Actual install/uninstall preflight entrypoints refused the unelevated caller
  without SCM mutation. Positive file fixtures use the current user's ownership;
  SYSTEM ownership and installed-service success are not claimed.
- `.tmp/comparison-worker-install-owner-host-first.log`: the named host lane
  passed worker typecheck, 28 focused TypeScript tests and 19 native records after
  integrating the installed-file owner. x64 and ARM64 builds were reproducible;
  only x64 executed. The receipt is
  `%TEMP%\Goat Worker Host IR3RuL\acceptance.json`.
- `.tmp/comparison-worker-install-owner-scoped-lint.log` records passing scoped
  JavaScript lint; formatting and PowerShell CRLF checks also passed. The earlier
  `.tmp/comparison-worker-install-owner-behavior-first.log` fixture failure remains
  separate: PowerShell 5.1 rejected its alternate-stream test setup through
  `File.WriteAllText`; the fixture now uses `Set-Content -Stream`.
- `.tmp/comparison-worker-install-owner-package-build.log` records the fresh v3
  x64 package with 1,056 files and 101,378,687 bytes. Manifest SHA-256:
  `cbaee8c8ae78299378ca38947eb11816c1601b0d349288e701532195a0496840`.
  Host SHA-256: `010e213bdb183fee1a5dbd2e95e0cd12c3d406308440757cd4aa39b004a15af1`.
  Both the host receipt and package inventory now use v3; earlier v2 receipts
  remain historical evidence.
- `.tmp/comparison-worker-install-owner-relocation.json` records an independent
  copy at
  `%TEMP%\Goat Worker Service Install Package AEvdq4\payload`.
  The copied install/uninstall entrypoints ran with `-Preflight` under both
  PowerShell engines using synthetic public inputs. The installer checked the
  real package inventory and reported only the missing elevation; uninstall also
  refused without mutation. The inventory was unchanged afterward.
  `.tmp/comparison-worker-install-owner-package-probe.log` passed the named package
  lane and loaded the copied Node 24.19.0 / OpenSSL 3.5.7 runtime and declared
  dependencies. This does not repeat earlier synthetic-signer Gateway admission.
- `.tmp/comparison-worker-install-owner-docs.log` records passing documentation
  checks. No staged changes or Monocypher vendor changes were introduced.

At that checkpoint, the signer still required an elevated interactive caller.
The following sections record caller roles and their file/pipe/SCM permission
composition. The real SYSTEM-owned installation, service
start/stop/recovery and custody journey have not been run. The separate signer/
broker first-boot gate, protected native volume/executor, broader placement and
delegation, mesh/static native MCP bindings, second-machine acceptance and C6 live
comparison also remain open. No production service was installed, started, stopped
or reconfigured, and no provider request or external message was sent.

## Protected signer caller roles

The signing transport now classifies its OS-collected token projection as an
elevated interactive operator or the exact dedicated worker SID. Worker collection
requires session zero, an enabled service-logon group, no administrator/System
group, no contradictory interactive/network/batch groups, unrestricted non-
AppContainer primary identity, and only the enabled change-notify privilege.
The pipe's identification projection must match the primary token. The signer
checks LSA user, authentication ID, session and logon type: the operator remains
an active-console interactive caller, while the worker must have a service logon.

The worker's GCPA hello advertises exactly `Inspect`, `SignRuntimePopV2` and
`SignTlsClientCertificateVerify`. Both endpoints enforce that role before sending
or executing a request, and the client verifies the returned operation set.
Creation, admission signing and revocation remain operator-only. The signer now
refreshes process/token/path and logon authority immediately before custody
execution, in addition to its post-operation check. The frozen inspect payload
still describes binary capabilities; it does not replace the caller-specific
exchange authority. Existing request-binding bytes and operation-ID domains remain
unchanged, including binding runtime signatures to the authenticated caller SID.

This pass also fixed a pipe-descriptor lifetime defect. Windows
[retains the owner SID pointer](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-setsecuritydescriptorowner)
when setting an absolute security descriptor; the old code pointed into a local
`SidBuffer`. The descriptor now references the SYSTEM SID copied into the retained
ACL storage. A failing native containment check reproduced the old defect before
the fix, without installing or creating a production pipe.

Fresh evidence:

- `.tmp/comparison-worker-signer-caller-focused-final.log` and
  `%TEMP%\Goat Signer Caller MGiuZV` record 796 checks
  in each normal and AddressSanitizer run. They cover all byte-valued opcodes for
  both roles and refusal, malformed/substituted identity projections, role-specific
  hello roundtrips, an actual interactive process token and retained descriptor
  ownership. Positive service identity remains a policy projection, not an actual
  service logon or authenticated pipe exchange.
- `.tmp/comparison-worker-signer-caller-pipe-owner-failing.log` and
  `%TEMP%\Goat Signer Caller i9AlYp\normal.log` retain
  the reproduced owner-lifetime failure separately from the passing run.
- Independent native builds are retained under
  `.tmp/comparison-signer-caller-windows-x64-Oq1G2z` and
  `.tmp/comparison-signer-caller-windows-arm64-gn22LF`, each with
  `caller-build-result.json`. Both targets passed byte-identical clean builds and
  the x64 AddressSanitizer/native protocol campaign. ARM64 binaries were built,
  not executed. The explicit source inventory now contains 49 paths, including
  the caller-authority test. The client import closure adds only
  `LookupPrivilegeValueW` for exact privilege validation; it gains no service-start
  or impersonation API.
- The reviewed client image pins are
  `dde9424988ab3550c397e16bc6ef95fa2dd9f0352a708053101d86c2b6b2004c`
  (x64, 80,896 bytes) and
  `bcd866bf261d3fa3b30b632b519a9f4797fe2ed3061f4dfd616d2b308416aafe`
  (ARM64, 71,680 bytes). Older pinned-byte assertions and the 48-file source
  inventory failures remain in the first two named-lane logs; they are not passes.
- `.tmp/comparison-worker-signer-caller-actual-cli.log` records all four selected
  public production-executable tests passing against the new x64 signer image.
  Twenty-nine unrelated tests were deselected. This proves public inspect/EOF/
  refusal behavior and does not establish privileged service authentication.
- `.tmp/comparison-worker-signer-caller-lint.log` records passing scoped lint.
- `.tmp/comparison-worker-signer-caller-provisioner-final.log` records the complete
  named lane passing: package typecheck, 95 TypeScript tests (four native-executable
  tests skipped without their environment input), and all 45 packaging/native
  checks. The four selected executable tests above are a separate passing run,
  not one combined 99-test receipt. The final native campaign rebuilt both targets
  and checked the updated literal client pins, imports, mitigations and embedded
  signer/client/broker bindings. `.tmp/comparison-worker-signer-caller-docs.log`
  records passing documentation checks. The edited client-pin block passed its
  scoped formatting check; the large files were not broadly reformatted.

At this checkpoint the installer, protected layout validators, pipe ACL and
signer SCM descriptors still lacked coordinated worker-read/query grants. The
following section records that source work. Broker availability,
first-boot status handling, installed authentication/custody and actual service
start/stop/recovery remain open. This pass did not install, start, stop or
reconfigure services, dispatch provider requests, send messages, modify credentials
or publish changes. The remaining C5/C6 execution and live-acceptance rows remain
unchanged.

## Protected signer worker permissions

The signer installer and both native layout validators now require exactly four
non-inherited image/directory ACEs: SYSTEM full control, then signer,
Administrators and the dedicated worker read/execute. This applies to the signer
and fixed client images, provisioner root and `bin`; the broker image retains its
own existing three-ACE descriptor. The pipe adds the exact worker SID with the
existing `0x0012008B` read/write mask, excluding instance creation, deletion and
owner/DACL changes. Its retained SYSTEM owner remains covered by the native test.

The signer SCM object separately adds `0x00020005`: query configuration, query
status and read security. The broker SCM object retains its two SYSTEM/
Administrators ACEs. Signer startup and broker target validation require the exact
worker query ACE; broker self-validation refuses it. Installer readback checks
the two distinct descriptors and retains their separate authority in its evidence.
The worker receives no service start/stop or configuration rights. Existing
operator-only signing operations and token/LSA checks remain enforced.

Fresh local evidence:

- `.tmp/comparison-worker-signer-permissions-red.log` and
  `%TEMP%\Goat Signer Caller RyabI2\normal.log`
  retain the failing missing-worker pipe regression. The corrected focused run,
  `.tmp/comparison-worker-signer-permissions-focused.log`, passed all 809 checks
  in each normal and AddressSanitizer build, with evidence under
  `%TEMP%\Goat Signer Caller zu9Ldx`.
- `.tmp/comparison-worker-signer-permissions-install-final.log` passed all 15
  installer checks, including 30 actual filesystem/descriptor scenarios per
  PowerShell engine. The new fixture retains the worker's exact read/execute ACE
  on a copied file; only SYSTEM ownership/control is substituted with the test
  user. SYSTEM-owned production installation is not proved. Receipts are under
  `%TEMP%\goat-broker-recipe-ZErRaf\powershell` and
  `%TEMP%\goat-broker-recipe-0aleo9\pwsh`.
  The first installer run's outdated comment assertion remains a separate failure
  in `.tmp/comparison-worker-signer-permissions-install.log`.
- `.tmp/comparison-worker-signer-permissions-worker-install.log` passed all 21
  worker installation/package-file checks. Its retained Windows receipt is under
  `%TEMP%\Goat Worker Install Wx66Cb`.
- Independent native trios are retained under
  `.tmp/comparison-signer-permissions-windows-x64-gerFJt` and
  `.tmp/comparison-signer-permissions-windows-arm64-NNLrBi`, with
  `permissions-build-result.json` in each. Both targets rebuilt byte-identically;
  the x64 native/AddressSanitizer campaign passed with 65,536 seeded protocol
  cases plus the signer and broker permission regressions. ARM64 was built,
  not executed. All three binaries retain their preceding import closures.
  Client pins are `8dfcbef4f1f97ccacc14cc47b3fffcc86547cd540fb5b3f15543ac7dd43df31a`
  (x64, 80,896 bytes) and
  `2fd786609459ba7b23cbe4c85f91338c62fd263cbfdff3f77eece6471903af99`
  (ARM64, 71,680 bytes).
- `.tmp/comparison-worker-signer-permissions-actual-cli.log` passed all four
  selected public-executable inspect/EOF/refusal checks against the retained x64
  signer. Twenty-nine unrelated tests were deselected. These checks do not
  authenticate a worker or run any service operation.
- `.tmp/comparison-worker-signer-permissions-lint-final.log` records passing
  scoped JavaScript lint. PowerShell CRLF and `git diff --check` also passed.
- `.tmp/comparison-worker-signer-permissions-provisioner-final.log` passed the
  complete named lane: package typecheck, 95 TypeScript tests with four
  environment-dependent executable checks skipped, and all 45 packaging/native
  checks. The four selected public-executable checks above remain a separate
  receipt. `.tmp/comparison-worker-signer-permissions-docs-final.log` records
  passing documentation checks.

Process/token query access during server authentication, broker availability,
first-boot status, actual service logon, custody and installed recovery remain
open. This checkpoint builds native trios; it does not replace older full-worker
package receipts or establish an operational installed signing path. No installed
service, credential, provider, channel or publication action was performed.

## Signer inspection grants and fresh-install status

After its full service-identity check, signer startup adds only
`PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE` on its own process and
`TOKEN_QUERY` on its primary token for the dedicated worker SID. Existing ACL
entries, their order, owner and protection state are retained. Both descriptors
are validated before either write, and readback must match. Failure prevents
transport startup. The worker receives no token duplication, memory access,
process control or service-control grant.

The broker accepts status 1077 only for a stopped signer with no PID and clean
remaining status metadata. Broker startup and active signer states retain their
separate checks. Its configuration-query buffer now follows the Windows 8 KiB
limit. The source fence includes all three new inspection files (52 paths);
only the signer gains the three required ACL API imports.

Fresh local evidence:

- `.tmp/comparison-worker-signer-auth-focused-final.log` records 121 checks in
  each normal and AddressSanitizer build. Windows `AccessCheck` fixtures verify
  the exact allowed rights and existing deny rules; actual kernel-object
  readback uses the test process and an unassigned cloned token. This does not
  prove a real virtual-service logon or cross-account authentication.
- `.tmp/comparison-worker-signer-auth-install.log` passed all 15 installer
  checks, including 30 filesystem/descriptor scenarios per PowerShell engine.
- `.tmp/comparison-worker-signer-auth-contracts.log` retains the initial full
  native build failure: MSVC rejected unnecessary 16-byte structure alignment.
  The buffer now uses the alignment of `SECURITY_DESCRIPTOR_RELATIVE`.
- `.tmp/comparison-worker-signer-auth-provisioner-final.log` passed the complete
  named lane: typecheck, 95 TypeScript tests with four environment-dependent
  executable tests skipped, and all 46 packaging/native checks. Both targets
  rebuilt byte-identically. x64 native/AddressSanitizer execution passed;
  ARM64 was built, not executed.
- `.tmp/comparison-worker-signer-auth-lint.log` records passing scoped lint.

This source checkpoint does not replace the older full-worker package receipt.
Installed authentication, custody, availability, recovery and two-machine
acceptance remain open. No installed service, credential, provider, channel or
publication action was performed.

## Administrator-owned signer supervision

The availability broker now remains active after administrator startup and
supervises successive one-exchange signer instances. It verifies its starting
identity, publishes RUNNING before calling `StartServiceW`, and rechecks its
running identity before each bounded cycle. RUNNING means supervision is active,
not that an individual signing request succeeded. Clean signer completion permits
another cycle after a 250 ms pause. Failed status, invalid identity/configuration,
or startup/exit timeout stops supervision. The exact SCM bootstrap status
(START_PENDING, checkpoint zero, two-second wait hint) is accepted only for the
fixed signer target. Operator STOP is retained even during startup; a shared lock
protects the control handler's event lifetime. Existing signer instances retain
their own bounded lifecycle because the broker has no stop/control import.

The client now waits through a missing pipe between signer instances. Missing,
busy and timeout connection results may retry against one original ten-second
deadline. Other errors refuse immediately. No hello, operation, token or request
is sent during these retries; the fixed path and subsequent mutual authentication
are unchanged. This addresses the documented Windows behavior that
[pipe waiting returns immediately when no instance exists](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-waitnamedpipew).
Publishing the broker's RUNNING state first follows the Windows rule for
[starting another service after initialization](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-startservicew).

Fresh local evidence:

- `.tmp/comparison-worker-availability-focused.log` passed the supervision and
  exact-status policy cases in normal and AddressSanitizer builds. It exercises
  repeated cycles, fast completion, STOP, and failure without another start.
- `.tmp/comparison-worker-availability-pipe-behavior-red.log` retains three
  failing checks against the preceding immediate-refusal pipe behavior.
  `.tmp/comparison-worker-availability-pipe-focused.log` then passed all 817
  caller/pipe checks in each normal and sanitizer build, including an actual
  delayed named-pipe connection and a bounded missing-pipe wait.
- `.tmp/comparison-worker-availability-contracts-final.log` passed all 45
  selected source/package checks. The two native target-build cases were
  excluded from this particular run; their independent builds are below.
- `.tmp/comparison-worker-availability-install.log` passed all 15 installer
  checks, including both PowerShell engines and actual temporary-file fixtures.
- `.tmp/comparison-availability-windows-arm64-cO3S68/availability-build-result.json`
  and `.tmp/comparison-availability-windows-x64-wJQvg1/availability-build-result.json`
  retain reproducible native trios and passing x64 native/AddressSanitizer
  execution. ARM64 was built, not executed. The client import closure is unchanged;
  only the broker adds four SRW-lock imports to protect the STOP-event lifetime.
- `.tmp/comparison-worker-availability-x64-build.log` retains a failed earlier
  native run with six recovery handle-count assertions (162 expected, 163
  observed). The separate ARM64 build's shared x64 sanitizer run and the serial
  x64 build passed without changing recovery code or weakening its checks.
  The initial mismatch's cause remains unproven.
- `.tmp/comparison-worker-availability-actual-cli.log` passed all four selected
  public-executable inspect/EOF/refusal checks against the retained x64 signer;
  29 unrelated tests were deselected. This is a separate receipt.
- `.tmp/comparison-worker-availability-lint.log` records passing scoped lint.
- `.tmp/comparison-worker-availability-provisioner-final.log` passed the full
  named lane after the reviewed client pins were updated: typecheck, 95
  TypeScript tests with four environment-dependent executable cases skipped,
  and all 47 packaging/native checks. Both target builds and their x64 sanitizer
  runs passed in this campaign. The four public-executable checks above remain
  separate. Client pins are
  `463ce883a940dc8d72ec4aaabdccf5ec916a5465f507c05bd3010ae5f1b1a186`
  (x64, 81,408 bytes) and
  `e4b01ec5d8c5eee96c6974a95c852a8d3bdc167ae2c75bddbb792f52a1505913`
  (ARM64, 72,192 bytes). All six retained binary hashes/sizes were independently
  rechecked. The earlier failed handle-count receipt remains separate.

This remains local source/native proof. Installed supervision, authenticated
custody, actual STOP/restart races and two-machine execution remain unproved.
At this checkpoint, initial enrollment remained a source-composition gap: the worker's first
credential path calls admission signing, while its restricted runtime caller
correctly lacks that administrative operation. An operator-owned enrollment
handoff must supply retained authority before ordinary service startup. The next
source addition addresses that composition.

## Operator-owned initial enrollment

The Windows package now includes `enroll-worker-service.ps1` and its enrollment
helper. It verifies the independent manifest pin, full installed payload,
configuration bindings, stopped worker and running availability broker. It holds
file/directory leases while the native host runs with a closed environment,
administrator-only staging state, once, stopping immediately after admission.
The worker's native opcode rights are unchanged. This command changes no SCM
configuration and starts/stops no service.

The admission-only runtime report now records a digest of the canonical retained
credential without exposing its bearer or key material. The transfer requires a
fresh run ID, admission-only stages, matching credential generations and exact
bytes. A held file handle publishes into worker state atomically without replacing
an existing destination. Identical retained authority is accepted; different
authority is preserved and refused. This uses
[Windows FileRenameInfo with replacement disabled](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info).
The private staging credential and installation/input binding remain available
for retries; concurrent enrollment is excluded. Unknown or changed private state
requires reconciliation. A lost bootstrap reply with no retained credential is
not repaired by this transfer.

Fresh local evidence:

- `.tmp/comparison-worker-enrollment-report-red.log` retains the missing-receipt
  regression before implementation. Later first-admission fixture corrections
  fixed its expected idempotency key and operation spelling; production authority
  checks were not weakened.
- `.tmp/comparison-worker-enrollment-tls-lane.log` passed the full named
  `verify:remote-worker:windows-tls` lane: typecheck, all 175 worker tests, 16 TLS
  identifier tests and 23 native TLS checks. The native adapter used real TLS and
  a controlled canonical Gateway admission/reconnect journey. Native evidence is
  retained in `.tmp/native-tls-acceptance-N10Hew`. This uses controlled native
  custody fixtures, not installed signer services.
- `.tmp/comparison-worker-enrollment-service-install-lane.log` passed all 25
  checks in `verify:remote-worker:windows-service-install`, including both
  PowerShell engines, native configuration/ACL fixtures and sanitizer execution.
- `.tmp/comparison-worker-enrollment-handoff-final.log` separately passed both
  PowerShell engines after cleanup-finally hardening, with 40 cases per engine.
  Receipts are retained in `%TEMP%\Goat Worker Enrollment e8pGNC`
  (5.1) and `%TEMP%\Goat Worker Enrollment URaGcp` (7).
  The checks use actual
  temporary files and held Windows handles, synthetic credentials and isolated
  child processes. They cover exact report/hash binding, ambient setting
  exclusion, publication conflicts, lock/writer exclusion, directory escape,
  successful host exit, failed host exit and shutdown refusal. The actual
  enrollment preflight command also refused an uninstalled/unpinned candidate
  without network or SCM mutation.
- `.tmp/comparison-worker-enrollment-lint.log` records passing scoped lint.
- `.tmp/comparison-worker-enrollment-package-build.log` records a fresh complete
  x64 package at
  `.tmp/comparison-worker-enrollment-package-e8e1ba5f566447cfa20b09feb09e6872/payload`.
  Manifest SHA-256 is
  `006d9effc35a99965dd8e43398d66e0d19b5ab57e649132aa1cc17672688c89b`:
  1,058 files, 101,414,438 bytes. It includes the current native supervision/client
  changes and enrollment command. The host remains
  `010e213bdb183fee1a5dbd2e95e0cd12c3d406308440757cd4aa39b004a15af1`.
  `.tmp/comparison-worker-enrollment-package-verify.log` passed all 22 package
  checks plus an actual bundled Node 24.19.0/OpenSSL 3.5.7 import probe, followed by
  another inventory verification. This is an unsigned local x64 candidate.
- `.tmp/comparison-worker-enrollment-docs.log` records passing documentation
  checks; `.tmp/comparison-worker-enrollment-hygiene.json` confirms all 531
  pre-existing dirty paths remain, four enrollment files were added, and nothing
  is staged or changed under the pinned Monocypher vendor directory.

Installed administrator-to-worker handoff, authenticated native custody,
service lifecycle and physical mini-PC acceptance are still unproved. Protected
execution/storage, broader placement/delegation, mesh/static MCP bindings and C6
live journeys remain open. No live service, provider, channel or machine setup
was performed in this source campaign.

## Worker capacity admission and cleanup revisions

Capacity admission now loads the immutable reservation from the canonical cell.
A caller's expected reservation must match it; supplying larger limits cannot
expand the cell budget. Observations are captured before asynchronous calls,
assignment authority is checked before evaluation and before the write, and
repeated absolute snapshots do not add failed-cleanup or quarantine bytes twice.
Already retained bytes remain included when a later observation omits them.
Recorded disk high-water is at least the complete counted footprint.

An admission must commit against both the capacity and cleanup revisions that it
evaluated. Cleanup can retain additional bytes independently of capacity
telemetry. The two repository writers now compare those revisions in SQL and
check the affected row count before appending evidence. A concurrent loser rolls
back; it does not claim a successful admission or cleanup transition. The
immutable limits already existed in both database schemas, so no migration was
needed.

Fresh evidence:

- `.tmp/comparison-worker-cell-capacity-red.log` retains the four initial
  reproduced failures. `.tmp/comparison-worker-cell-capacity-cleanup-red.log`
  separately reproduces an accepted decision after cleanup retains more than the
  allocated budget. A later fixture assertion was corrected to the existing
  cleanup revision's one-based initial value.
- `.tmp/comparison-worker-cell-capacity-cleanup-gateway-final.log` passes all
  10 focused Gateway cases; `.tmp/comparison-worker-cell-capacity-cleanup-storage.log`
  passes 18 SQLite repository/schema cases. Scoped storage typecheck and lint also
  passed.
- The first integrated run, `2026-09-11T04-27-21-819Z-remote-workers-990aee36`,
  failed typecheck and PostgreSQL because the new test called `listEvidence`
  instead of the existing `listEvidenceAfter`. That failed receipt is retained.
- The fresh full `pnpm verify:remote-workers` rerun,
  `2026-09-11T04-42-59-335Z-remote-workers-dc62a0ba`, passed all twelve checks:
  seven-package typecheck, 126 contracts, 156 SQLite/schema, 778 Gateway, 14 worker
  process/recovery, 12 policy, 23 shared-client, 20 UI and 21 PostgreSQL tests,
  plus static scans, lint and whitespace checks. PostgreSQL executed all ten
  registered files on the first temporary cluster with zero skipped tests.
  Two independent connections produced exactly one capacity winner. A paused
  cleanup write also rejected an intervening capacity commit without adding
  cleanup evidence; its subsequent fresh retry preserved the retained bytes.
- `.tmp/comparison-worker-cell-capacity-source-snapshot.json` retains the four
  changed source/test hashes, verified unchanged through the successful lane.

The proof matrix reports 11 executed scenarios, one physical two-machine skip
and zero failures. This completes the capacity-owner correction, not C5. Native
volume/execution enforcement, installed service/custody, broader worker
integration, mini-PC/Telegram acceptance and C6 live comparison remain open.

## Native Windows cell Job Object component

`apps/remote-worker-windows-cell-native/src/cell_job.cpp` now provides an internal
resource-control primitive for the native executor. It creates a fresh private
named job, sets CPU/memory/process limits before launch and atomically associates
the suspended entry process through the Windows job-list creation attribute.
Only its three owned stdio handles are inherited. Arguments and the explicit
environment are captured before launch; ambient environment variables are not
forwarded. An existing job name is refused without attaching to or changing it.

The owner drains stdout/stderr continuously, counts raw bytes against one limit,
retains bounded prefix/tail bytes and stops on output pressure, wall deadline or
cancellation. Entry-process exit also terminates remaining descendants. Zero
processes is reported only from a successful query of the held job handle, and
output completion requires both pipes to reach EOF. A failed observation clears
previous zero-process evidence. Kill-on-close is the fallback for controller
death. Raw capture is internal; Gateway diagnostics must still redact it before
persistence or display.

CPU milli-cores are converted to the Windows CPU-rate units using the active
processor count and rounding down. An unrepresentable rate is rejected. A
processor-count change stops the invocation for reconciliation. Windows defines
the rate relative to the parent job when it has an active CPU cap; this can make
the child's allowance stricter. See Microsoft's
[CPU rate control contract](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information)
and [process creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

Fresh local proof:

- `.tmp/comparison-worker-native-cell-red.log` records the initial missing
  CPU-rate behavior. Subsequent memory and process fixture failures corrected
  assumptions about Windows accounting: refused allocations/process creation
  attempts can appear in the observed counters. Those OS values are retained;
  tests compare successful operations and actual refusal results. The same
  allocation succeeds in a separate, larger-budget control run.
- `pnpm verify:remote-worker:windows-cell-job` passed in
  `.tmp/comparison-worker-native-cell-named.log`. The named command builds actual
  Windows C++ binaries with the repository's pinned toolchain. Normal and
  AddressSanitizer executions each pass 65 checks, including kernel-reported
  limits, real memory/child-creation refusal, breakaway refusal, bounded capture,
  wall/cancellation termination, CPU load and successful process/output drain.
  Killing a separate task-owned controller also caused its still-running child
  to exit through the job's kill-on-close policy.
- Receipts, binaries, build logs and unchanged source hashes are retained in
  `%TEMP%\Goat Worker Cell Job UDF4GD`. Earlier normal
  and sanitizer evidence remains in `Goat Worker Cell Job cGnwUb` under the same
  temporary directory. Scoped JavaScript lint passed.

That 65-check receipt covered a trusted child under the caller's identity. The
AppContainer integration below supersedes that launch behavior. Neither receipt
certifies a packaged or installed worker or a complete protected executor.

## Native Windows cell AppContainer identity

The internal launcher now requires `GoatCitadel.Worker.` followed by the exact
canonical job suffix. It derives that AppContainer SID and sets a zero-capability
security attribute alongside the atomic job and explicit stdio-handle attributes.
Before resuming the suspended child it checks the actual token's AppContainer
flag, exact SID, empty capability set and low integrity. Missing or mismatched
identity fails before launch; API or token-verification failure never retries
under the caller's identity. Provisioning remains responsible for profile
lifecycle, executable/root verification and ACLs. The launcher does not create,
adopt, delete or modify profiles or their filesystem permissions.

Fresh component proof:

- `.tmp/comparison-worker-native-appcontainer-red-token.log` records the initial
  behavioral regression: the existing launcher lacked the AppContainer identity.
  Fixture compilation/setup failures are retained separately. The fixture now
  supplies explicit Windows runtime variables, including `LOCALAPPDATA`, while
  continuing to exclude the ambient environment.
- `pnpm verify:remote-worker:windows-cell-job` passed in
  `.tmp/comparison-worker-native-appcontainer-named.log`. Normal and
  AddressSanitizer builds each pass 87 resource/identity checks and six separate
  network checks. The child independently inspects its actual token, cannot read
  or write a private fixture readable by its parent, can read its explicitly
  granted executable, cannot reopen the private job for control, and cannot
  obtain parent-process injection, handle-duplication or termination rights.
- A real loopback listener receives successful runs of the same native network
  probe outside AppContainer before and after the isolated probes. Both isolated
  probes retain Windows error `10060` and `connected: false`; this is a bounded
  connection timeout, not an observed access-denied error. The listener accepts
  only the four native/JavaScript control connections. This does not certify all
  network destinations, protocols, firewall states or a complete WFP boundary.
- Killing the separate task-owned controller terminates its child. The fixture
  retains ownership of its newly created profile before launch and verifies
  parentage plus exact job membership before recording the child PID. Cleanup
  deletes only profiles created by the fixture. No native test profiles remained
  after validation. Existing profiles are never adopted on creation failure.
- Binaries, build logs, normal/sanitizer/network/crash receipts and unchanged
  native-source hashes are retained in
  `%TEMP%\Goat Worker Cell Job brPdPy`.
  The earlier passing controlled-network run remains in `Goat Worker Cell Job
  jAeuYJ` under the same temporary directory. Scoped JavaScript lint passed.

Windows AppContainer profiles provide their own writable profile storage;
see Microsoft's [AppContainer launch contract](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer).
Protecting and accounting for that storage, the assignment volume/quota and
filesystem boundary, complete network enforcement, canonical launch/recovery,
worker/service composition, packaging and installed/two-machine acceptance
remain open. The backend availability flags remain disabled. This component
does not close C5/C6 or establish hostile-code sandboxing.

## Native Windows launch filesystem verification

`cell_filesystem.cpp` now owns handle-based verification inside the native
launcher. Its input requires an expected executable SHA-256 and directory
volume serial plus 128-bit file ID. Those values must come from the admitted
owner; the launcher does not replace them with whatever happens to be on disk.
Current native tests bind their own freshly built fixture bytes and directory.

The guard walks every component without following reparse points, verifies
normalized names and NTFS volume identity, rejects hard links, named data streams,
sparse/compressed/encrypted/offline metadata and invalid DOS/device/UNC spellings,
and hashes the executable through its retained handle with a bounded buffer.
Image/root mismatches fail before process creation. Actual launch uses volume
GUID paths so it does not resolve a drive-letter mapping again. Handles retain
write/rename exclusion on launch components until the call completes. This is
read-only launch verification; mutable work and controller output need separate
broker-owned directories, with their own policy, quota and lifecycle enforcement.

Fresh proof:

- `.tmp/comparison-worker-native-storage-red.log` records the missing launch-file
  verification. Actual NTFS tests then exposed that metadata-only directory
  handles still allowed rename. Opening directory data access fixed that gap.
  The sharing and volume-name behavior follows Microsoft's
  [CreateFile contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
  and [handle-based final paths](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew).
- `pnpm verify:remote-worker:windows-cell-job` passed in
  `.tmp/comparison-worker-native-storage-named.log`. Normal and AddressSanitizer
  runs each passed 139 checks, including 41 filesystem checks. Real NTFS fixtures
  cover executable byte drift, directory replacement, executable/root rename
  attempts, competing write handles, release/retry, hard links, file/directory
  alternate streams, sparse files, compression and directory junctions.
  Invalid path spellings are rejected before opening. No EFS credential was
  created, so encrypted-file rejection has no corresponding live EFS fixture.
- Both builds also passed seven loopback checks each; the isolated probes retain
  timeout `10060`, and the same native probe connects outside AppContainer.
  The controller-crash test passed with its ownership/PID receipts written in
  a separate control directory. It still requires exact parentage/job membership
  and observes the child exit after terminating only its owned controller.
- Binaries, build logs, source hashes and normal/sanitizer/network/crash receipts
  are retained in `%TEMP%\Goat Worker Cell Job KvHfJP`.
  The earlier complete controlled-crash run is retained in `Goat Worker Cell Job
  VZP6mC` under the same temporary directory. Scoped JavaScript lint passed.

This closes the internal launch-image/root verification gap. Complete bundle
verification, protected volume and ACL provisioning, logical/physical/file-count
quotas, profile-storage accounting, network enforcement, canonical admission and
recovery wiring, worker/service packaging and installed/two-machine acceptance
remain open. The native backend remains unavailable; C5/C6 are not complete.

## Native workspace root permissions

`CellWorkspaceDirectories` now exclusively creates a cell root and its
`control`, `runtime`, and writable `work` directories relative to the admitted
parent handle. The caller supplies frozen owner/controller SIDs and the expected
parent volume/file identity. The helper derives the cell's AppContainer SID and
applies protected DACLs and explicit integrity labels during creation. It never
adopts an existing name, changes token privileges, or removes a failed creation.
The parent and its ancestors still require protected volume custody.

This uses the kernel's [relative, exclusive directory-creation contract](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile).
The initial fixture exposed that requesting protected audit-SACL inheritance
requires additional privilege. The implementation applies the integrity label
without requesting that protection; it verifies the resulting label and DACL.
The corresponding [Windows security-information rights](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-information)
distinguish label and audit-SACL operations.

Fresh `pnpm verify:remote-worker:windows-cell-job` evidence is retained in
`.tmp/comparison-worker-native-acl-named.log` and
`%TEMP%\Goat Worker Cell Job 92tfXx`:

- Normal and AddressSanitizer builds each passed 222 checks, including 41
  launch-filesystem and 83 workspace checks. Each build also passed the seven
  controlled loopback checks; the controller-crash child-lifetime test passed.
- The actual AppContainer creates, writes, flushes, reads, renames, and deletes
  work files and nested directories. It cannot read controller files, modify
  runtime inputs, list/write another cell's work root, change root ownership or
  DACLs, or acquire root deletion/metadata-write access. Ordinary inherited work
  files also refuse `WRITE_DAC` and `WRITE_OWNER`.
- A creator-supplied protected-descriptor probe was refused with access denied
  (`5`); reopening its absent file returned file not found (`2`). The same
  descriptor successfully created a writable, DACL-editable file from the
  controller. Receipts retain these separate outcomes rather than claiming
  every possible child creation path has been proved immutable.
- Actual DACL, integrity-label, and directory alternate-stream drift clears
  verification. Exact ACL/label restoration passes a fresh check. Existing
  names and mismatched parent identities fail without adoption. After a parent
  directory is renamed and its old path replaced, creation follows the original
  retained handle. Closing handles retains disk state for canonical recovery.

The source and fixtures implement root creation and verification, not native
volume quotas or complete mutable-tree mediation. This helper is not yet composed
into installed worker admission/recovery. Protected volume lifecycle, logical and
physical capacity/file-count enforcement, profile-storage accounting, full bundle
verification, complete network enforcement, service packaging, and installed and
two-machine acceptance remain open. The native backend remains unavailable;
C5/C6 are still in progress.

## Static MCP frozen-binding prerequisite

The shared contracts and immutable Chat capability-profile repository now accept
an explicit static MCP binding. It fixes the server and native tool identities,
transport, exact provider-facing tool definition, callable catalog, authenticated
actor and turn scope. Storage checks the binding digest and rejects mixed
requester/mesh modes, changed scope/schema/catalog, unsupported runtime ownership,
and extra endpoint or credential fields. Legacy omission grants no authority.

The production registry now issues opaque configuration UUIDs during creation
and configuration/policy edits, including removal/recreation of the same server
ID. Configuration writes require an expected registry snapshot. Stale edits and
deletes fail; concurrent status updates are preserved without changing the
configuration identity. Explicit legacy enrollment issues one persisted identity;
ordinary inventory reads remain read-only. These writes use a data-only atomic
storage compare-and-set operation that crosses the actual PostgreSQL worker
boundary and participates in enclosing transactions.

OAuth publication now invalidates configuration identity when credential authority
changes, as described below. Environment-backed credential invalidation, static
catalog production, current-configuration and schema checks, approval/dispatch
integration and worker placement remain unimplemented. Requester-specific
credential resolvers remain deliberately default-empty. These prerequisites do
not enable static native MCP execution.

Separate local receipts record 37 contract tests, three focused static-binding
tests including an actual PostgreSQL connection close/reopen, and passing
contracts/storage typechecks and scoped lint. The PostgreSQL run used and stopped
its own loopback cluster; its evidence remains in
`%TEMP%\gc-static-mcp-binding-pg-qYe0ON` and
`.tmp/comparison-static-mcp-postgres.log`. No migration was needed for this
optional metadata in the existing immutable profile envelope.

Registry proof separately passed 18 tests, including two actual PostgreSQL RPC
workers racing initial creation, preserving a later connection-status update,
rejecting stale authority, rolling back an enclosing transaction and reopening
persisted configuration after both workers close. The final owned PostgreSQL
cluster was stopped; receipts remain in `.tmp/comparison-mcp-registry-postgres-legacy.log`
and `%TEMP%\gc-mcp-registry-pg-CSJCJh`. Six storage tests
also passed, covering stale compare-and-set input, missing rows, competing initial
creation, readback failure and transaction rollback. Contracts/storage and Gateway
typechecks and scoped lint passed. The final six-file Gateway run passed 75 tests
and skipped its optional PostgreSQL case, which executed in the separate run
above. Status-update responses preserve normalized defaults for legacy records.
An earlier two-test failure exposed an incorrect error-constructor call; its red
receipt is retained separately.

`pnpm verify:gateway:async-boundary` passed ten scanner tests and scanned 970
production TypeScript files. The fresh `pnpm verify:runtime:truth` run
`2026-09-11T07-51-50-605Z-runtime-truth-309f7bea` passed both approval recovery
across a Gateway restart and the canonical shell cross-check, with no skips.
The earlier `2026-09-11T07-46-31-265Z-runtime-truth-4e1a6b82` run passed backend
recovery but skipped the UI after a navigation timeout while Vite reoptimized
dependencies; it remains a separate partial receipt.

## Static MCP OAuth publication

OAuth exchange and refresh stage credentials in fresh, server-scoped keychain
slots. Publication binds the result to the original server configuration and auth
row, then atomically writes the new references, rotates configuration identity
when authority changes, and clears that server's first-use approvals. Metadata-only
updates preserve identity. Superseded credentials are retired only after canonical
publication is acknowledged; an uncertain publication retains both
versions and does not issue a second diagnostic write. Failed staging removes
only its unpublished slots. A new authorization grant does not inherit the old
grant's refresh token or scopes.

Server deletion now removes its auth references, tool inventory and first-use
approvals in the same storage transaction. Stale auth publication cannot restore
a deleted or recreated server. Repeated legacy enrollment compares persisted JSON
material and performs no redundant write; the regression check verifies that
directly rather than depending on timestamp resolution.

Fresh receipts for this source boundary:

- `.tmp/comparison-mcp-credentials-gateway-verified.log`: all eight focused Gateway
  files passed, with 100 tests passed and the optional PostgreSQL case skipped.
- `.tmp/comparison-mcp-credentials-postgres-verified.log`: all 24 registry tests
  passed, including actual PostgreSQL workers racing OAuth publication, rollback
  after a remote configuration write, and auth/configuration persistence after
  both workers close and a fresh worker opens. The owned loopback cluster was
  stopped; its retained directory is
  `%TEMP%\gc-mcp-registry-pg-irpeP0`.
- Gateway typecheck and scoped lint passed. `verify:gateway:async-boundary`
  passed ten scanner tests and checked 970 production TypeScript files.
- `2026-09-11T08-29-01-738Z-auth-matrix-a169714d` passed both authentication
  scenarios. `2026-09-11T08-30-02-080Z-runtime-truth-e4ecc635` passed both durable
  approval recovery across restart and the canonical shell cross-check, with no
  skips. Earlier failed focused runs remain separate receipts.

Token tests use in-memory credentials and loopback token endpoints. These checks
do not exercise the OS keychain or a real OAuth provider. The following request
reservation work closes the concurrent-refresh dispatch gap. Reconciliation of
retained credential versions, catalog/current-binding checks, approval/dispatch
integration and worker placement remain open. Environment-backed authority is
covered by the later section below. C5/C6 and
physical mini-PC, Telegram and live-provider acceptance are unfinished.

## Durable OAuth request reservations

The OAuth owner now reserves an opaque request ID against canonical server/auth
state before invoking the token transport. It uses the existing external-effect
ledger and mutation claims, including a required durable boundary record and
ownership generation. Immediately before HTTP, it checks the reserved server and
auth snapshot again in the boundary transaction. No database transaction remains
open across HTTP. Token transports refuse network requests without an acknowledged
boundary callback. Usable current credentials follow a fenced read without a new
external request reservation.

Credential publication, configuration invalidation and both terminal ledger
writes commit together. Competing Gateways reuse the recorded reservation and
cannot dispatch a second request while the first claim owns it. A recorded failure
before dispatch permits retry through the shared ledger. An uncertain external
outcome remains blocked across restart. Explicit reconnect abandons the previous
grant and request, clears its callable credential references, and starts a fresh
handshake; an older in-flight request cannot publish over that handshake. The
uncertain ledger entry remains available for review. Abandoned pre-dispatch claims
also have this operator recovery path; no new automatic takeover worker is added.

Generic ledger payloads contain opaque request/configuration IDs and operation
metadata, never authorization codes, token values, keychain references or endpoint
URLs. New grants no longer persist an authorization-code preview. Pending requests
project as needing auth rather than ready.

Fresh validation passed 107 focused Gateway tests, with two optional PostgreSQL
cases skipped in that run (`.tmp/comparison-mcp-reservation-gateway.log`). The
separate PostgreSQL run passed all 25 tests across both files, including two actual
RPC workers sending one loopback refresh, refusing another send, and retaining an
uncertain result after both workers close and a fresh worker reopens. Its owned
cluster was stopped; evidence is in `.tmp/comparison-mcp-reservation-postgres.log`
and `%TEMP%\gc-mcp-registry-pg-qxklXd`.

SQLite/loopback tests additionally cover commit-acknowledgment loss, terminal-ledger
failure rolling back auth publication, redaction, pre-dispatch retry, changed
configuration at the boundary, and a late result losing to explicit reconnect.
Gateway typecheck and scoped lint passed. The async-boundary lane passed ten tests
and checked 970 production TypeScript files. Both auth-matrix scenarios passed in
`2026-09-11T08-56-32-610Z-auth-matrix-a6af3937`.
The fresh runtime-truth run `2026-09-11T08-58-15-907Z-runtime-truth-40e1deef`
passed both approval recovery across Gateway restart and the canonical shell
cross-check, without skips. Documentation checks and `git diff --check` passed.

## Static MCP environment authority

Static MCP connections now enroll the effective environment through an explicit
connect/reconnect action. Private keychain entries hold keyed proofs; canonical
settings retain only opaque references. Neither raw environment values nor their
digests enter public server records, catalogs or capability profiles. Enrollment
requires safe keychain write custody when effective variables are present.

Capture freezes the enrolled values and rejects missing, changed or stale
authority. It cannot silently enroll another Gateway's environment. Production
Gateway discovery and tool transports use the captured stdio environment or HTTP
bearer token; OAuth setup and token requests use captured client values. Checks
before process launch and before tools/call reject drift. Reconnect rotates the
configuration identity and atomically invalidates old OAuth grants and first-use
approvals. Canonical publication failure rolls everything back; uncertain
acknowledgment retains both immutable private proof versions. Corrupt proofs can
be repaired by explicit reconnect without suppressing keychain access failures or
deleting another server's credential entry.

Validation:

- `.tmp/comparison-mcp-environment-gateway-verified.log`: 138 tests passed across
  nine files; one optional PostgreSQL case was skipped in this run. Coverage
  includes a real stdio child, retained-process replacement after reconnect,
  loopback bearer and OAuth requests, drift before tool dispatch, and setup
  refusing to fall back to ambient client values.
- `.tmp/comparison-mcp-environment-postgres.log`: a separate 25-test run passed,
  including competing actual PostgreSQL RPC workers, atomic environment/auth
  rollback and invalidation, stale publication rejection, and close/reopen.
  The owned cluster was stopped; its evidence directory is
  `%TEMP%\gc-mcp-registry-pg-4KDwKX`.
- Gateway typecheck and scoped lint passed. The async-boundary lane passed ten
  tests and scanned 971 production TypeScript files.
- `2026-09-11T09-35-04-302Z-auth-matrix-ebf5a47e` passed both authentication
  scenarios. `2026-09-11T09-36-58-220Z-runtime-truth-bc059947` passed both durable
  approval recovery across restart and canonical shell consistency, without skips.

Credential tests use in-memory secret stores. They do not prove OS keychain or
installed-service custody, real OAuth providers, or physical two-machine behavior.
The next section covers static named-tool integration and worker placement.
Retained-credential reconciliation and C5/C6 acceptance remain unfinished.

## Static MCP Chat and worker execution

`McpStaticChatService` now owns static named-tool discovery, frozen bindings and
current-authority checks. Chat admission combines static and requester catalogs
under the existing shared candidate limit, rejects ambiguous names across modes,
and retains only secret-scanned native metadata plus opaque configuration identity.
The stored profile binds the exact provider definition, final catalog, actor,
workspace, session and turn. Dotted server/tool names cannot be redirected by
tool arguments. Manual turns skip metadata discovery.

The dispatch owner reads fresh metadata on the same connection used for the tool
call. Changed schema, shared capability, configuration, scope, actor or environment
fails before the effect marker. Authority is checked again after the asynchronous
marker; a later rejection remains conservative reconciliation evidence. One-use
call authority disables automatic redispatch, including a lost tool response.
Output and structured content are scrubbed independently, preserving the Gateway's
outcome fields and avoiding false redaction of shared object references. Connection
secret scanning excludes generated catalog fields so the public `mcp.` prefix does
not falsely match an endpoint path segment.

Worker placement, inference and approval continuation use the same owner and
durable profile. No credential or process-local handle enters the worker protocol.

Fresh proof:

- `.tmp/comparison-static-mcp-chat-worker-verified.log`: 308 tests passed across
  eight Gateway files, including 16 static-owner cases, worker placement/effects,
  approved replay, catalog admission, profile binding and transport regressions.
- `.tmp/comparison-static-mcp-mixed-catalog-tests.log`: a separate six-test run
  passed after adding cross-mode collision and forged-static-handle coverage.
- `.tmp/comparison-static-mcp-full-restart-selected.log`: both selected static
  cases passed; six unrelated cases were excluded by the filter. Each runs the
  stock built Gateway and a Windows worker, connects an actual loopback MCP server,
  restarts Gateway, settles one tool call and one Chat reply, then proves replay
  adds neither. The approval case resumes the retained approval after restart.
  Receipts are `.tmp/worker-gateway-restart-44bc7a89-8590-456d-a6e2-c7b60ecbc19b/result.json`
  and `.tmp/worker-gateway-restart-bf648e8b-c69c-462b-a2ae-f9d6e1dda691/result.json`.
- Gateway typecheck and scoped lint passed. The async-boundary lane passed ten
  tests and scanned 974 production TypeScript files. Authentication matrix run
  `2026-09-11T10-13-13-212Z-auth-matrix-1a0fdd00` passed both scenarios.
  Runtime-truth run `2026-09-11T10-14-12-957Z-runtime-truth-dcec1749` passed both
  durable approval recovery across restart and canonical shell consistency,
  without skips.

The restart cases use a deterministic local provider, an MCP server without
credentials, and synthetic worker TLS/signing custody. Credential regressions use
in-memory secret stores. These runs do not prove live-model quality, installed
Windows/keychain custody or a second physical machine. Retained-credential
reconciliation, mesh/delegation work, native execution/service completion and
the remaining C5/C6 acceptance gates remain open.

## Mesh catalog and current-authority prerequisite

Mesh tool and MCP-server profiles now bind their actual publication capability
IDs, rather than treating a local tool alias as a mesh entry. Shared catalog
validation checks publisher, manifest, entry, kind, activation projection and
remote-effect posture. Local/mesh name collisions fail regardless of entry order.
Profile preflight now performs the exact catalog check before returning a preview.

The shared Chat/worker gate requires the Gateway activation owner to revalidate
the full frozen mesh binding, including revision, health generation, permission
envelope and lease fence. Missing or withdrawn authority blocks model dispatch.
Worker policy resolution also preserves the admitted mesh actor identity. These
changes do not enable mesh worker placement: production mesh schema/policy
admission, per-call approval integration and worker dispatch remain unfinished.

Fresh proof:

- `.tmp/comparison-mesh-catalog-gateway-verified.log`: 96 tests passed across four
  Gateway files, including malformed preflight publication and missing/withdrawn
  authority before model dispatch.
- `.tmp/comparison-mesh-catalog-postgres-final.log`: all 21 storage tests passed
  with no skips. Both mesh kinds persisted and reopened on SQLite and actual
  PostgreSQL, with altered bindings rejected; the existing static MCP PostgreSQL
  case also passed. The earlier two PostgreSQL attempts exposed fixture session
  and memory-scope mismatches, which were corrected before this full rerun.
  The owned cluster was stopped and its evidence directory retained at
  `%TEMP%\gc-mesh-catalog-pg-KsrO7s`.
- Gateway typecheck and scoped lint passed. Runtime-truth run
  `2026-09-11T10-36-01-475Z-runtime-truth-a8947468` passed both durable approval
  recovery across restart and canonical shell consistency, without skips.

The PostgreSQL proof uses a temporary local cluster. It does not establish mesh
tool transport, installed Windows execution, a physical second machine, live
providers or Telegram acceptance. C5/C6 remain in progress.

## Mesh policy and accounting prerequisite

The policy engine now accepts a private, nonserializable mesh mapping bound to
one exact publication identity. Tools and MCP-server publications share the
internal `mesh.invoke` risk/limit identity while retaining their exact names in
policy, approvals and audit. The template is absent from the public tool registry;
unbound names, cloned handles, mixed MCP/mesh mappings, local registry collisions
and attempts to enter the built-in executor fail closed.

Deny-wins, scoped deny grants, active permission ceilings, untrusted-source
restrictions and Citadel Wards retain their existing owners. Approval replay
requires a fresh mapping and current policy. MCP allowances do not admit mesh
tools. Shared mesh limits count calls across nodes and publication kinds without
charging inspection or dry-run rows.

SQLite 219 / PostgreSQL 164 extend the constrained shared accounting identity.
SQLite replaces the constrained column transactionally; PostgreSQL replaces its
named constraint directly. Existing values and the policy-time index survive.
Historical migration definitions remain unchanged.

Fresh proof:

- `.tmp/comparison-mesh-policy-tests.log`: 187 tests passed across six policy
  files, covering mesh behavior and existing MCP, approval, dry-run and execution
  fence regressions. This proves the policy owner, not mesh transport execution.
- `.tmp/comparison-mesh-policy-postgres-verified.log`: all five tests passed,
  including actual PostgreSQL accounting and upgrades, retained MCP records,
  SQLite replay/preservation and transaction rollback. The first PostgreSQL
  attempt exposed an unsupported column-rename simulation in canonical shape
  validation; the final forward migration uses direct constraint replacement.
  The owned cluster was stopped and evidence retained at
  `%TEMP%\gc-mesh-policy-pg-VV8j9t`.
- `.tmp/comparison-mesh-policy-migrations.log`: the named migration-parity lane
  passed its 27 inventory/lineage tests, 24 PostgreSQL integrity tests and 45
  runtime-schema tests. Registry counts are 219 SQLite and 164 PostgreSQL.
  A separate selected SQLite registration test passed.
- Gateway typecheck and scoped lint passed. Runtime-truth run
  `2026-09-11T11-02-11-225Z-runtime-truth-7abb828c` passed.

Canonical Chat/worker approval dispatch and node execution integration remain
open, along with the other C5/C6 source and live-acceptance gates. No real
provider or external channel was used.

## Mesh Chat schema and current policy admission

The production profile resolver now passes Gateway-owned mesh schemas into the
Chat runtime. `gateway/mesh-chat-catalog.ts` loads exact publication bytes from
the digest-verifying repository, reads current activations in one batch, and
produces opaque schema handles with private mesh policy mappings. The bounded
inventory interleaves nodes and shares reads for entries from the same manifest.
Tool publications preserve their input schemas; MCP-server publications expose
the explicit advertised-tool selector envelope because they publish native
schema digests rather than native schemas. Skill descriptors remain excluded.

The runner applies canonical policy inspection before admitting each schema.
Aliases bind publication and activation identity and avoid provider naming
limitations. Profile freeze compares exact definitions and rechecks the selected
activation after inspection. Private handles never enter persisted profile JSON.
`gateway/mesh-chat-binding.ts` reconstructs current policy mappings only from a
private Chat context, the persisted profile/catalog join, exact actor/scope, and
the current manifest and activation owners. Both Gateway inspection and recorded
evaluation use that owner; body-supplied names and node fields do not select the
target.

Fresh proof:

- `.tmp/comparison-mesh-chat-binding-tests-verified.log`: 176 tests passed across
  eight files. Coverage includes schema/alias admission, context forgery and
  cross-scope rejection, profile/catalog/activation drift, real SQLite
  publication and approved-activation reads, revocation during descriptor
  loading, and existing MCP Chat/worker/approval composition. The initial wider
  run exposed a stale requester-specific error-message assertion; its correction
  preserves the existing missing-owner rejection and all eight files then passed.
- `.tmp/comparison-mesh-chat-binding-typecheck-verified.log`: Gateway typecheck
  passed through the output-lock wrapper.
- `.tmp/comparison-mesh-chat-binding-lint.log`: scoped lint passed.
- `.tmp/comparison-mesh-chat-binding-runtime-truth.log`: named runtime-truth run
  `2026-09-11T11-30-16-319Z-runtime-truth-8ed460e6` passed.

This completes the schema and current policy-inspection integration, not the
mesh execution journey. Canonical per-call approval/resume, coordinator dispatch,
worker effects, node execution, protected Windows hosting and the physical/live
acceptance gates remain open. No schema or user-data migration was needed. The
new runtime owner tests use local synthetic state; no live provider, external
channel, installed service or second machine was used.

## Mesh canonical Chat dispatch and approved-effect integration

Mesh Chat calls now enter `ToolInvocationCoordinatorService` through the same
effect-aware runner port as other tools. The coordinator requires an opaque
context, preserves the target across hooks, excludes plugin substitution and
evaluates the exact mesh policy mapping. Inline approval replay remains blocked;
approved calls use the canonical pending-action/effect owner and the shared exact
Chat approval/profile join. Approved and direct dispatch use the same adapter,
which rechecks profile/publication identity after the execution and effect fences
and applies the coordinator's Ward redaction. The runner preserves uncertain
delivery as a failed tool result requiring reconciliation, with no automatic
effect replay.

The invocation owner now rechecks activation and deadline after its fence, keeps
staged input unreadable before dispatch, and copies caller arguments/bindings
before asynchronous work. Pending and settled intent replay require exact
session, turn, run, approval, execution-profile and publication identity. The
stable invocation key and input hash alone cannot authorize reuse. Older mesh
and native MCP approval shapes also retain external-boundary truth when their
explicit external-runtime flag is absent.

Fresh focused proof:

- `.tmp/comparison-mesh-approval-final-tests.log`: 349 tests passed across
  seven files. This includes real local SQLite publication/activation, policy
  approval, mesh intent/envelope dispatch, authenticated node settlement and
  canonical effect replay without a second dispatch. Other cases cover current
  deny, missing/revoked authority, changed pending and settled identity, changed
  caller input, shared MCP/mesh approval linkage, and uncertain delivery.
- The initial run had three fixture failures: a nonexistent approval reference
  in the intent fixture, and an assertion that expected transient policy
  internals in the persisted replay projection. The full rerun above passed
  after those fixtures were corrected; no storage guard was weakened.
- Final fixture isolation routes audit/transcript writes into owned temporary
  directories and removes those directories after closing storage. The initial
  synthetic audit files were retained in
  `.tmp/comparison-mesh-approval-fixture-audit`; the final full run left no new
  checkout files.
- `.tmp/comparison-mesh-approval-typecheck.log`: Gateway typecheck passed through
  the output-lock wrapper. `.tmp/comparison-mesh-approval-lint.log`: scoped lint
  passed; the final fixture edits also passed scoped lint.
- `.tmp/comparison-mesh-approval-durable-recovery.log`: named durable-recovery
  run `2026-09-11T12-04-19-053Z-durable-recovery-5f023140` passed all three
  scenarios, with no skips.
- `.tmp/comparison-mesh-approval-runtime-truth.log`: named runtime-truth run
  `2026-09-11T12-06-06-851Z-runtime-truth-4e6be1e0` passed both approval/restart
  and canonical-shell scenarios, with no skips. These named checks cover the
  existing durable approval foundations, not a mesh destination-node journey.
- Docs checks passed. Both verification stacks stopped their owned processes.

This proves the local owners and coordinator wiring, not a destination-node
executor or a complete built-Gateway mesh approval/restart journey. The next
section records subsequent worker placement/effect integration. Destination
execution, protected Windows hosting and installed service, broader
delegation/council work and live acceptance remain open. No new migration,
real provider call, external message or installed service was used.

## Mesh tools in worker placement and effects

Worker placement now admits selected mesh tools only when both current activation
authority and Gateway effect execution are composed. It retains the existing
runtime activation, spending grant, immutable placement and governed-tool worker
capability requirements. Missing owners keep the local path; withdrawn authority
rejects admission before publishing an offer.

`RemoteWorkerEffectRuntime` derives a private mesh context from the verified
profile and resolves the exact actor, scope, schema and publication binding before
creating a Chat tool run. Direct and approved execution enter the canonical
coordinator and Gateway approval adapter. Each continuation retains protected
worker checks and the shared tool-model budget. Settled and uncertain outcomes
replay from retained evidence without issuing another tool dispatch; context
handles never enter the worker protocol or persisted results.

Fresh focused proof:

- `.tmp/comparison-worker-mesh-final-regression.log`: 102 tests passed across
  the effect, placement and Gateway MCP composition suites, with no skips. The
  mesh composition cases use real SQLite, policy, coordinator and Gateway
  approved-action owners with controlled protected authority and mesh transport.
  They verify the exact target, arguments, profile, approval boundary and
  model-facing result. Other cases reject missing/cloned authority, actor drift
  and revoked activation, and preserve completed or uncertain replay.
- The earlier 81-test run and two selected composition tests were separate
  receipts. The combined run above includes both plus existing MCP composition
  regression coverage. Initial composition assertions and an incomplete fixture
  storage port were corrected before that combined run.
- `.tmp/comparison-worker-mesh-final-lint.log`: scoped lint passed.
- `.tmp/comparison-worker-mesh-final-typecheck.log`: Gateway typecheck passed
  through the output-lock wrapper. `.tmp/comparison-worker-mesh-final-docs.log`:
  documentation checks passed.

These are controlled owner tests. They do not prove a mesh destination executor,
a native worker process making mesh calls, or a built-Gateway mesh restart
journey. Those source and integration steps remain open alongside protected
Windows service integration, broader delegation/council execution and live
acceptance. Existing named runtime/durable receipts are recorded above and were
not rerun for this focused slice. No migration, real provider call, external
message or installed-service action was used.

## Admitted-node mesh delivery discovery

The node-scoped pending-invocation API now projects only exact replication
deliveries for its authenticated workspace/node. It uses the existing bounded
transient input vault, with a maximum of 256 active entries. It exposes envelope
identities and hashes without arguments, credentials or unrelated replication
events. The public envelope and response shapes now live in contracts; existing
Gateway exports retain compatibility.

Input and pending delivery are withheld until the replication owner confirms the
exact source, event type, idempotency key and envelope bytes. Conflicting transport
replay becomes an uncertain outcome requiring reconciliation. Input reads check
the exact persisted intent, publisher admission/certificate, current activation,
health, lease, deadline and settlement before returning arguments. Lost transient
bytes after restart remain unavailable. Polling itself neither claims execution
nor authorizes retry; a destination consumer must still retain execution and
settlement evidence before effects.

Focused proof:

- `.tmp/comparison-mesh-node-delivery-tests.log`: 49 tests passed across the
  invocation owner and HTTP route suites. Added cases cover confirmed delivery,
  foreign node/workspace isolation, unrelated replication records, changed
  transport bytes, revocation, lease loss, offline state, changed admission and
  certificate, deadlines and lost process-local input. Route tests check node
  credentials with Gateway auth both enabled and disabled, strict query scope,
  no-store responses and disappearance after settlement.
- `.tmp/comparison-mesh-node-delivery-typecheck.log`: Gateway typecheck passed
  through the output-lock wrapper after moving the shared envelope projection.
- Scoped lint passed after the shared envelope projection was moved into its
  contracts owner, keeping the invocation service within its existing size limit.
- `.tmp/comparison-mesh-node-delivery-final-lane.log`: the named mesh publication
  lane passed all ten checks in run
  `2026-09-11T12-50-12-717Z-mesh-capability-publication-4be73b2e`. Nine packet
  proof rows executed; the physical two-node mTLS row remains explicitly skipped.
  The earlier storage phase's two environment-gated PostgreSQL race tests now
  execute in the hermetic phase: that phase passed 10 tests with no skips,
  including real publisher/admission-revocation and publisher/activation races.
  The lane's test selection is regression-checked and its live phase rejects
  self-skips. No task-owned PostgreSQL process remained after cleanup.
- `.tmp/comparison-mesh-node-delivery-docs.log` and
  `.tmp/comparison-mesh-node-delivery-final-lint.log`: documentation checks and
  scoped lint passed. Whitespace checks passed; existing dirty paths were preserved.

This HTTP proof did not compose the protected Windows listener; the subsequent
native bridge work is recorded below. The destination executor, retained
execution claims and complete mesh approval/restart journeys remain
implementation work. This HTTP proof uses controlled admission fixtures;
it does not certify physical two-machine or native mTLS execution. No real
provider call, external message, installed-service action or migration was used.

## Native mesh settlement authority

Native node result settlement now carries the authenticated M3 fence to a fixed
storage operation. Its transaction binds the canonical intent's publisher and
admission to current worker/credential/join authority before either inserting a
result or returning an identical replay. The Gateway shares publication's
identity validation and never falls back to legacy settlement after a native
authority failure. Failed authority checks emit no settlement success event.
Activation withdrawal still allows a currently admitted node to report an
already-dispatched outcome; worker and mesh-authority revocation reject both a
first submission and replay. Existing terminal evidence stays immutable.

Focused proof:

- `.tmp/comparison-native-mesh-settlement-gateway.log`: 53 tests passed in the
  invocation, native publication authentication and mesh route suites.
- `.tmp/comparison-native-mesh-settlement-postgres-tests.log`: four shared
  authority cases passed, two on SQLite and two on a task-owned PostgreSQL
  cluster, with no skips. They cover foreign identity/admission/credential
  fences, exact replay, changed bytes, activation withdrawal and canonical
  worker/mesh-authority revocation. The cluster stopped and its temporary data
  directory was removed; loopback port 55097 had no remaining listener.
- `pnpm verify:runtime:truth` passed both scenarios with no skips in run
  `2026-09-11T13-15-37-198Z-runtime-truth-3c5c1aea`, including approval restart
  and canonical shell consistency.
- Gateway typecheck, scoped lint, documentation and whitespace checks passed. No migration
  was added. This receipt predates the protected listener bridge below; the
  destination executor and full native mesh approval/restart journeys remain open.

This is local authority proof. It does not certify physical two-machine
execution, the installed Windows service or a real provider/channel outcome.

## Protected native mesh bridge

The fixed native protocol now includes PoP-v2 route 13 for a closed mesh
capability exchange. Six actions reach the existing publication and invocation
owners: publish, list own publications, discover pending deliveries, read
input, report progress and settle. The worker client fixes the path/operation
and checks response action, workspace and node identity. Canonical public
submission and response types live in contracts; Gateway compatibility exports
remain available.

The Gateway snapshots requests before asynchronous authority resolution and
derives node identity from the current M2 credential and exact M3 fence. It
requires governed-tool capability and workspace scope, checks certificate,
SPKI, CA, exporter-bound PoP-v2 and generations, then consumes the canonical
durable nonce. Reads recheck M3 after the owner returns; publication and
settlement preserve their transaction-level authority checks. Unknown actions,
caller node/activation fields, changed signed bytes and legacy proofs fail
closed. Responses remain bounded and secret-safe; the native listener owns
the mandatory no-store header.

Production composition supplies this bridge only behind the existing explicit
worker-runtime activation. Its owner is preflighted before listener startup;
an omitted bridge has no native route. No activation setting was changed.

Focused proof:

- `.tmp/comparison-native-mesh-bridge-gateway-final.log`: 29 tests passed in four
  suites, including six signed actions, nonce replay, scope/identity/proof drift,
  snapshot mutation, post-read revocation, malformed input, missing owners and
  exact route composition. A real Windows loopback native mTLS exchange uses
  the worker client with synthetic credentials and controlled authority and
  business-owner ports. It accepts the admission contract's 256-character node
  bound, rejects an oversized expected node before transport, and rejects a
  mismatched response node.
- `.tmp/comparison-native-mesh-bridge-contracts.log`: five protocol contract
  tests passed. `.tmp/comparison-native-mesh-bridge-worker.log`: four worker
  signing tests passed, including route 13.
- `.tmp/comparison-native-mesh-bridge-native-final.log`: the full named
  `verify:remote-worker:windows-provisioner` command passed. Provisioner
  typecheck passed; its six Vitest suites passed 95 tests and explicitly skipped
  four configured-executable checks because no provisioner executable was
  selected. The subsequent native builder suite passed all 47 checks with no
  skips, including byte-identical x64/ARM64 service/client/availability/test
  builds and x64 execution with ASan (65,536 cases). This is not live ARM64 or
  installed-service proof.
- The native decoder now accepts route 13 and rejects 14. The earlier native
  run stopped at the old binary pins after reproducibility and native execution
  checks passed. The final full run above validates the refreshed client pins:
  x64 81,408 bytes,
  `6d0c6d53272c1564b70906193be452358af0f30a81788d469599b125735c9469`;
  ARM64 72,192 bytes,
  `030d82606b3f3a5ab97b67d7f2e4cfd717bff3cf6ebb8429887e0f64384512fd`.
  The pinned Monocypher sources were unchanged.
- `pnpm verify:auth:matrix` passed two scenarios with no skips in run
  `2026-09-11T13-44-28-961Z-auth-matrix-f313b7f3`; `pnpm verify:runtime:truth`
  passed two scenarios with no skips in run
  `2026-09-11T13-45-53-509Z-runtime-truth-027c209d`. These verify principal
  boundaries, credential revocation, approval restart and canonical shell truth;
  they do not substitute for the pending complete native mesh journey.
- Gateway and worker typechecks, scoped lint, documentation and whitespace
  checks passed. Pre-existing dirty paths were preserved; nothing was staged.

This receipt covers local transport composition. The client itself does not
claim work, execute effects or authorize replay; the destination coordinator
added next is recorded below. Complete native mesh approval/Gateway-restart
journeys, installed protected custody and physical second-host proof remain
open. No real provider call, external message, service installation or storage
migration was used.

## Destination mesh execution and process recovery

`WorkerMeshCapabilityRuntime` now joins the worker process API through an
explicit local-owner dependency. Bindings come from the host's governed
tool/MCP owner, never executable fields in a manifest, admission ticket or
model response. The coordinator verifies the entire local manifest and its
nested hashes, exact delivery scope and binding, and immutable input bytes.
Skills remain non-callable. A new shared contract owns delivery validation and
the node settlement digest.

The worker's existing OS state lock owns a separate local journal. Its
execution marker is persisted before the local owner runs. After disk and
progress waits, another input read checks current origin admission and
activation; the local owner then checks its own policy. Requests and outputs
obey declared limits with transport ceilings of 256 KiB input and 64 KiB output.
The journal has a 4 MiB bound and retains at most 4,096 receipts, failing closed
at capacity instead of evicting duplicate-execution evidence.

Exact result/settlement bytes precede the first send. A verified canonical
receipt replaces transient output with an invocation/hash tombstone. A lost
response or failed acknowledgement write replays only settlement. If execution
started but no result was retained, recovery sends `unknown` and requires
reconciliation. An exception, output violation or timeout after entering the
owner also preserves uncertainty and stops new work in that runtime. No
automatic execution retry is inferred from a capability's idempotency label.

Fresh proof:

- `.tmp/comparison-mesh-destination-worker-suite-final.log`: the complete
  worker package passed 194 tests across 25 files, with no skips. The new
  coverage includes persistence failures before/after effects, lost/corrupt
  acknowledgements, exact replay, concurrent polling, changed scopes/hashes,
  local policy rejection, post-write input drift, corrupt journals, bounded
  payloads, accessors/cycles/custom array prototypes and execution timeouts.
- `.tmp/comparison-mesh-destination-native-e2e.log`: two Windows process-death
  cases passed with no skips against real native mTLS and the canonical SQLite
  admission, publication, activation, invocation and settlement owners. The
  operator fixture approves exact capability activation. A spawned worker uses
  the real foreground process API and an explicitly supplied local fixture
  capability that appends to a task-owned file. Killing it after that effect
  recovers an unknown result; killing it after Gateway settlement recovers the
  exact successful receipt. Each case proves one file append, one canonical
  terminal settlement and one retained worker receipt.
- Worker and Gateway typechecks and scoped lint passed. The named
  `verify:remote-workers` lane now includes these two process-death cases in
  its connected-worker check, whose no-skip guard remains active. Its selection
  tests passed 12/12. The full lane passed at
  `artifacts/verification/2026-09-11T14-15-12-596Z-remote-workers-9b298839`:
  all 12 checks passed, including 16 connected-worker tests with no skips,
  804 Gateway tests and 25 live PostgreSQL tests across 10 owner suites on the
  task-owned hermetic cluster. The proof matrix records 11 executed scenarios,
  zero failures and one declared physical two-machine skip. That skipped
  scenario remains an acceptance requirement; loopback mTLS does not close it.

This is a destination coordination and recovery implementation with real
single-host process/transport proof. The fixture's local tool is bounded to a
temporary proof directory; it is not a shipped native tool/MCP adapter. The
standard CLI does not manufacture these owners from configuration. Production
local-owner registration, permission/path/OS execution adapters, complete Chat
mesh approval and Gateway
restart journeys, installed protected custody and physical second-host
acceptance remain open. No real provider use or external message occurred.

## Mesh work alongside assignments

The connected worker now recovers retained mesh work before claiming an
assignment, then runs one assignment and one serialized mesh cycle together.
An assignment can wait for a mesh effect on the same worker without blocking
the destination poll. A busy mesh queue no longer takes precedence over every
assignment attempt. Normal assignment completion stops new polling and drains
the current mesh cycle. Transport failure, cancellation or an uncertain mesh
result cancels the other branch and awaits both coordinators before return.
Lease, transcript and settlement authority remain in their existing owners.

Unknown mesh receipts now stop fresh work even in a replacement process. A
second restart does not resolve the recorded uncertainty. Journals with an
active entry and no terminal-receipt capacity are rejected without modifying
evidence, and a stalled local policy check cannot bypass its invocation deadline.
The host adapter still owns native resource enforcement and process teardown.

Fresh proof:

- `.tmp/comparison-worker-mesh-pump-worker-suite-final.log`: 206 worker tests
  passed across 26 files, with no skips. Coverage includes self-targeted waits,
  busy mesh queues, orderly draining, cancellation of both branches, transport
  and reporting failures, persistent uncertainty, journal capacity and local
  preflight timeout.
- `.tmp/comparison-worker-mesh-pump-native-e2e-final.log`: three Windows process cases
  passed with no skips. The added case inserts a controlled mesh dependency
  after canonical assignment admission, claim and workload validation. The
  actual worker services the dependency while awaiting the workload response;
  restart resumes the assignment without another file append. The two earlier
  process-death cases also pass. After an interrupted effect settles as unknown,
  a third actual process refuses fresh work and exits with reconciliation still
  required. This proves native scheduling and recovery,
  not the complete Chat policy/approval loop or a shipped local tool adapter.
- `.tmp/comparison-worker-mesh-pump-connected-e2e.log`: the consolidated
  connected-worker and destination suites passed 17 tests across two files,
  with no skips. This includes the existing controlled inference, built-in and
  requester MCP, approval and restart journeys.
- `artifacts/verification/2026-09-11T14-38-32-815Z-runtime-truth-e78cca76`:
  both named runtime-truth scenarios passed, with no skips or degraded rows.
  Worker/Gateway typechecks, scoped lint and all 12 verification-lane selection
  tests passed. The lane-note guard initially required obsolete text-only
  limitations; the corrected 12/12 receipt is
  `.tmp/comparison-worker-mesh-pump-lane-tests-corrected.log`. It now checks the
  executed tool cases and the outstanding destination/native boundaries.
  The full `verify:remote-workers` lane was not repeated after
  this scheduling change; its preceding receipt is recorded above.

Production local-owner registration, native tool/MCP and protected execution
adapters, the full Chat mesh approval/restart journey, broader delegation and
installed/two-machine acceptance remain open. No live provider, external
message, installed service or user runtime state was changed.

## Native runtime bundle validation

The Windows cell now has an exact runtime-bundle verifier and a composed
`RunVerifiedRuntimeJob` entry point. The admitted owner supplies the expected
root identity, ordered relative paths, byte sizes, content hashes and manifest
digest. The verifier rejects missing/extra files and directories, changed
content, alternate streams, hardlinks, unsafe metadata, aliases, case collisions
and file/directory conflicts. It holds verified dependencies through the
existing AppContainer/job launch, output drain and process join. An entry
executable outside the declared bundle never reaches process creation.

The v1 shared contract and native implementation use the same domain-separated
binary digest. Inventory limits are enforced while parsing: 4,096 files and
implicit directories, 512 ASCII path characters, 64 components, 256 MiB per
file and 1 GiB total. An explicit empty-file hash is allowed for dependencies;
the existing executable-only primitive still refuses an empty image. Missing
or mismatched metadata does not fall back to that primitive.

Fresh proof:

- `.tmp/comparison-native-runtime-bundle-tests-corrected.log`: the named
  `verify:remote-worker:windows-cell-job` lane passed with no skips. Retained
  evidence is under `%TEMP%\Goat Worker Cell Job hLHEZt`.
  Normal and AddressSanitizer builds each passed 277 native checks, including
  55 bundle checks and a real AppContainer launch. Both passed seven loopback
  checks; the restricted probe retained its actual timeout while the same
  native probe connected outside AppContainer. The controller-crash case
  again proved its exact child exited. The earlier inventory-bound build
  stopped at a misplaced local declaration; this corrected receipt comes
  from a fresh full lane.
- `.tmp/comparison-native-runtime-bundle-contract-suite.log`: 738 contract
  tests passed across 71 files, with no skips, including the 22 new bundle
  cases. TypeScript, independently constructed Node bytes, normal native and
  AddressSanitizer native code agree on the fixed manifest digest vector.
  Contract typecheck and scoped lint passed.

The adapter requires an already protected runtime root. Holding existing files
does not grant package trust or prevent every possible addition by a privileged
writer. Protected volume/ACL custody, quotas, governed bundle publication,
worker/tool wiring, service integration and physical acceptance remain open;
the native backend is still disabled. No installed service, live provider,
external message or user runtime data was changed.

Windows API references: [handle metadata](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex)
and [directory enumeration](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-findfirstfileexw).

## Protected Windows cell-parent custody

`CellWorkspaceDirectories` now checks the supplied parent's exact owner/group,
protected DACL and integrity label before path traversal. It reopens and pins
every NTFS path component, verifies the admitted directory identity again and
creates the cell relative to that retained handle. Ordinary inherited parents,
broader permissions, mismatched principals, altered owner rights, low labels,
alternate streams and existing data-write handles are refused before creation.
The helper never repairs a refused parent or deletes retained cell state.

Reverification now covers the parent as well as the four cell roots. Changing
the parent's permissions or label clears readiness for affected cells; restoring
the original descriptor requires a fresh verification. The actual AppContainer
child still creates, edits and deletes its own work files, while parent listing,
parent permission changes and creating files or directories beside its cell are
denied. Independent controller controls retain their expected access.

Fresh proof:

- `.tmp/comparison-native-parent-custody-tests-final.log`: the complete named
  `verify:remote-worker:windows-cell-job` lane passed with no skips. Evidence is
  retained under `%TEMP%\Goat Worker Cell Job OG179q`.
  Normal and AddressSanitizer builds each passed 316 native checks, including
  122 workspace checks and the existing 41 filesystem and 55 runtime-bundle
  checks. Each also passed seven loopback checks; restricted probes timed out
  and unrestricted native controls connected. The controller-crash case retained
  proof that its exact child exited.
- Earlier runs stopped at rejection ordering and an old rename fixture whose
  direct parent was now intentionally pinned. The parent security check now
  precedes reopening as well as following it, and the rename fixture performs
  its move before custody of its own subtree. The passing receipt above is a
  fresh complete run after both corrections.
- Scoped verification-script lint and `git diff --check` passed. The worktree
  retains all 588 pre-existing dirty entries and has no staged changes.

This proves internal parent/root custody with task-owned current-user fixtures.
Protected volume provisioning, quotas and AppContainer profile storage,
governed bundle publication, installed LocalSystem/service-SID composition,
worker/tool integration and physical acceptance remain open. The native backend
remains disabled. No service, provider, channel or user runtime data was changed.

Windows API references: [security by retained handle](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo)
and [file security rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights).

## Durable retirement of published MCP credentials

OAuth/environment replacement, reconnect and server removal now record their
superseded credential references in the same transaction as canonical state.
The private retirement owner checks current auth and environment references
before deletion, retains failed/uncertain cleanup across restart, and permanently
rejects publication of a retired version. Cleanup is bounded to 32 entries by
default, with a 256-entry maximum per pass and a 4,096-entry pending index.
Completed tombstones remain in individually indexed storage records. A full
pending index refuses publication without losing the old canonical state.

The Gateway runs cleanup after critical startup and acknowledged credential
publication. Cleanup errors do not turn a completed OAuth request into a retry.
Public server projections, logs and generic effect ledgers receive no retirement
references or credential values. Corrupt cross-server prior bindings can still
be repaired without deleting the unrelated credential.

Windows credential deletion previously swallowed every PasswordVault exception.
It now accepts only the explicit missing-entry HRESULT or verified removal,
rejects access failures and retained entries, bounds its helper to ten seconds,
and returns a fixed private-error diagnostic. The exact PowerShell helper ran
against synthetic vault objects for absence, success, read denial, remove denial,
retained entries and verification denial. These tests never construct an OS vault.

Fresh proof:

- `.tmp/comparison-mcp-retirement-gateway-verified.log`: 138 tests passed across
  nine Gateway files. Its one optional PostgreSQL case was covered separately.
  Coverage includes SQLite close/reopen, lost publication and deletion
  acknowledgements, rollback, current/foreign binding protection, server
  recreation, bounded cleanup, failed cleanup after successful publication,
  six real PowerShell synthetic-vault cases and secret-store receipt handling.
- `.tmp/comparison-mcp-retirement-postgres.log`: all 25 tests passed across the
  registry and OAuth reservation suites. Two actual PostgreSQL RPC workers
  raced publication against cleanup; a fresh worker after both clients closed
  recovered retirement and preserved current environment authority. The owned
  loopback cluster was stopped, with evidence retained at
  `%TEMP%\gc-mcp-registry-pg-eBRQi6`.
- Gateway typecheck and scoped lint passed. `verify:gateway:async-boundary`
  passed ten scanner tests and checked 982 production TypeScript files. An
  existing mesh-catalog cached promise now uses an explicit awaited owner;
  its focused tests passed with caching unchanged.
- `2026-09-11T15-59-18-144Z-runtime-truth-46b34731` and
  `2026-09-11T15-59-51-383Z-auth-matrix-695ead70` passed their named lanes.
  Earlier fixture failures, the initial logger type error, scanner finding
  and output-lock refusal remain separate logs; the final receipts are fresh.

This establishes recovery of references retired by canonical state changes.
The following tranche adds staged-write inventory; older credentials without
records still need inventory and reconciliation authority. No operator keychain,
real OAuth provider, external channel, installed service or user runtime state
was exercised. Protected worker execution, broader integration and C5/C6 live
acceptance remain unfinished.

Windows API references: [PasswordVault lookup](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.passwordvault.retrieve?view=winrt-26100)
and [the Windows missing-element error](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1000-1299-).

## Unpublished MCP credential staging and recovery

OAuth and static environment enrollment now register fresh server-owned credential
references before their synchronous keychain writes. The private staging journal
stores opaque references and write status, never values, value hashes, OAuth codes
or environment proofs. Keychain writes run outside database transactions. An
acknowledged completed write becomes ready for a ten-minute publication window;
canonical auth/environment publication consumes its staging records atomically.
Stale publication fails, and failed writes or expired unreferenced ready versions
enter the existing retirement owner. A publication acknowledgement lost after
commit cannot leave a current credential eligible for cleanup.

Writers without a terminal acknowledgement remain quarantined across restart.
Elapsed time cannot establish that a suspended writer has stopped, so these
records remain unpublishable and are not automatically deleted. The bounded
staging index permits 4,096 entries and defaults to 32 inspected entries per pass
(maximum 256). Retained entries rotate behind the remaining queue. Current own
and cross-server credential references prevent cleanup. The Gateway composes
staging into both credential writers and revisits reconciliation through its
existing maintenance scheduler as well as startup/publication.

Fresh local proof:

- `.tmp/comparison-mcp-staging-gateway-verified.log`: 115 tests passed across seven
  Gateway files; its optional PostgreSQL case is a separate receipt. Coverage
  includes actual SQLite reopen, partial writes, lost registration/terminal/
  publication acknowledgements, publication rollback, expiry before cleanup, current-reference
  protection, bounded cleanup and OAuth/environment service composition.
- `.tmp/comparison-mcp-staging-postgres-direct.log`: all 26 tests passed across
  three files, including two actual PostgreSQL RPC owners, publication versus
  cleanup, lost deletion acknowledgement and restart with a quarantined writer.
  Current credentials survived while the exact retired reference remained fenced.
  The owned PostgreSQL process exited with code zero after explicit shutdown;
  its evidence remains at
  `%TEMP%\gc-mcp-registry-pg-TbWA4P`.
- Gateway typecheck, scoped lint and `verify:gateway:async-boundary` passed. The
  latter passed ten scanner tests and inspected 983 production TypeScript files.
- `2026-09-11T16-23-48-465Z-runtime-truth-10670009` and
  `2026-09-11T16-25-38-063Z-auth-matrix-8ec69d7b` passed their named lanes.

Earlier PostgreSQL attempts remain separate failed logs: the new fixture
initially returned a thenable storage proxy from an async helper and was changed
to return a containing object. Other attempts lost their Windows database host
or failed to launch its wrapper. The final harness directly launched the owned
PostgreSQL executable with a hidden window and verified its clean shutdown.
These failures are not combined with the final passing PostgreSQL receipt.

The following tranche adds custody binding; recovery of unacknowledged writers
and inventory of older unindexed secrets remain open. Age or absence in a
different vault is insufficient proof. Tests use synthetic secrets and controlled loopback
endpoints, without changing an operator keychain or requesting a live provider.
Native worker integration, installed custody and C5/C6 live acceptance remain open.

## Windows custodian binding for MCP credential cleanup

Fresh staging records retain an opaque custodian identifier derived inside the
Windows helper from the native machine registry identity, current Windows SID
and GoatCitadel credential resource. The identifier is carried unchanged into
retirement. It is not a credential/value hash, and the identity fields themselves
do not enter logs, settings projections or generic effect ledgers.

Writes and deletes verify their own current OS identity before opening
PasswordVault. Writes reject an occupied immutable slot and read back the saved
credential before returning success. Values are supplied on stdin; helpers are
hidden, time-bounded and return fixed diagnostics. A failed owner-bound write,
occupied slot or lost acknowledgement remains quarantined. Even repair of a
corrupt canonical reference cannot convert an unfinished writer into deletion
authority. Production cleanup requires the original custodian's acknowledged
absence/removal; another custodian or a version 1 record with unknown custody
remains pending. Retained retirement entries rotate through bounded passes.

Fresh proof:

- `.tmp/comparison-mcp-custody-gateway-verified.log`: 172 tests passed across ten
  Gateway files, with the optional PostgreSQL case covered separately. This
  includes 15 new Windows fixture tests (20 actual PowerShell invocations) for
  digest derivation, both mutation guards and immutable write verification;
  six existing Windows deletion fixture tests also passed. These fixtures
  replace identity discovery and vault access and never access an operator vault.
  SQLite proof covers restart, legacy records, wrong custodian, expiry, queue
  progress and refusal to retire a corrupt reference to an unfinished writer.
- `.tmp/comparison-mcp-custody-postgres.log`: all 26 tests passed. Actual RPC
  clients retained custody through expiry, refused the wrong custodian, replayed
  an uncertain deletion after database reopen and preserved the current token.
  The test used synthetic custodian IDs and credentials. The task-owned direct
  PostgreSQL process exited with code zero after explicit shutdown; evidence is
  retained at `%TEMP%\gc-mcp-registry-pg-kMbelz`.
- Gateway typecheck and scoped lint passed on the final production source.
  `verify:gateway:async-boundary` passed ten scanner tests and checked 984
  production TypeScript files.
- `2026-09-11T17-05-12-406Z-runtime-truth-4ad7098a` and
  `2026-09-11T17-08-09-253Z-auth-matrix-d0ecdbfc` each passed both scenarios
  in their named verification lanes, with no failures or skips.

This binds cleanup to a local Windows identity. It does not establish installed
service-SID custody, physical two-machine acceptance, hardware attestation or
identity isolation for cloned OS images. Version 1/unindexed credentials,
unacknowledged writers and custodian migration/rebinding still require recovery
authority. Non-Windows writes remain available through their existing adapters,
but automatic retirement stays blocked without supported custody. No actual
operator keychain, credential, registry identity or live provider was exercised.

Microsoft documents [user-specific Credential Lockers](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.passwordvault?view=winrt-26100)
and [credential roaming between devices](https://learn.microsoft.com/en-us/windows/apps/develop/security/credential-locker).
The local identity check avoids treating absence on another host as ownership proof.

## Mesh Chat restart and native runtime installation

The controlled native mesh fixture now joins the complete ordinary Chat journey:
native capability publication, separate operator activation, remote placement,
per-call tool approval, a built-Gateway restart while approval is pending,
destination execution, canonical Chat completion and replay. There are no
destination effects before approval, including after restart. The destination
owner is a test-owned local callback; this does not register a shipped tool/MCP
adapter or exercise operator credentials.

The internal native `InstallTo` operation copies an already verified and pinned
runtime bundle into an empty protected runtime root. Each name is created
exclusively relative to a held parent with the root's exact security descriptor.
It copies from retained source handles, flushes files, then verifies and pins the
complete installed inventory. Failure and cancellation preserve partial files
and exact counters. Retry refuses a nonempty root. The operation supplies no
publication approval, cleanup or recovery authority.

Integration exposed two defects: protected roots use literal volume-GUID paths
that the old file/job gates rejected, and ordinary NTFS directory index growth
was incorrectly treated as unsafe metadata. Filesystem admission and job launch
now use the same bounded path validator, and directory growth is allowed while
alternate streams remain rejected. Fixed-volume, ancestry, identity, reparse,
security-descriptor and content-hash checks remain in force.

Fresh proof:

- `.tmp/comparison-mesh-chat-restart-initial.log`: the selected mesh case passed;
  the other eight cases were not selected. The retained
  `.tmp/worker-gateway-restart-6ae06296-a3fd-4e23-ace9-e5a3efefe20e/result.json`
  records the replacement Gateway process, completed task and one destination
  effect. Replay produced neither another effect nor another Chat reply. There
  were five controlled model dispatches: two worker requests and three ordinary
  Chat requests after commit. No real provider or external channel was used.
- `.tmp/comparison-runtime-install-native-verified.log`: the full named
  `verify:remote-worker:windows-cell-job` lane passed without skips. Both normal
  and AddressSanitizer builds passed 352 checks, including 51 filesystem,
  148 workspace and 55 runtime-bundle checks. The suite verifies empty and nested
  files, exclusive creation, installed-image AppContainer launch, actual
  cancellation after file creation, counters matching retained disk state,
  refusal to adopt partial output and a complete 256-file installation whose
  directory index has grown. The seven controlled network checks passed in both
  builds, with the same probe connecting outside AppContainer. The controller
  crash probe confirmed its child exited. Evidence is retained at
  `%TEMP%\Goat Worker Cell Job 0pVqXA`.
- Gateway typecheck through its output-lock wrapper and focused lint passed in
  `.tmp/comparison-mesh-chat-typecheck.log` and
  `.tmp/comparison-mesh-chat-lint.log`.

Earlier native runs exposed the path and directory-growth failures. Those
receipts, including the failed `comparison-runtime-install-native-final.log`,
remain separate from the fresh `native-verified` result above. This is local
proof against task-owned fixtures. Protected volume provisioning, quotas,
governed bundle publication, native executor/worker/service composition,
destination tool/MCP adapters and the other C5/C6 source and live gates remain
unfinished. The native backend remains disabled behind its existing gates.

## Destination deadlines and worker control refresh

Destination execution now shares one deadline across initial input, durable
marker writes, progress, current input, local authority and the effect. Each
asynchronous boundary rechecks elapsed wall and monotonic time. Transport sees
the same abort signal. A slow first input read leaves no execution marker;
expiry after the marker but before the local owner records `timed_out`. A late
result after entering the owner remains `unknown`, including when a blocked
event loop or backwards wall clock delays the timer. Caller cancellation is
retained and may be reported on recovery without another effect. Reporting a
retained result uses the caller's transport authority rather than the expired
execution deadline.

The full Gateway restart probe then exposed a separate parent-heartbeat race:
the parent advanced between worker lease renewal and its subsequent control
read, causing the exact parent-version fence to reject that read. The worker
now permits at most two refreshes after the fixed authenticated control
rejection. Each refresh renews from the retained rotated secret and performs a
new control read. Revocation, persistent denial, mismatched receipts and
ambiguous renewal stop execution; no model/tool operation is retried. The same
helper governs terminal control reads and preserves cancellation settlement.

Evidence for this batch:

- `.tmp/comparison-mesh-deadline-regression-before-corrected.log` reproduced
  all ten new deadline failures against the prior runtime. The full worker
  suite passed 230 tests across 27 files in
  `.tmp/comparison-mesh-deadline-worker-suite-final.log`, including 34 destination
  cases and 12 new lease/control cases. A subsequent typecheck caught readonly
  test-response mutation; the fixture was corrected and the integrated lane
  below passed both typechecks and all 230 worker tests on that final source.
- `.tmp/comparison-mesh-deadline-native-process.log` passed all three existing
  Windows destination cases: death after effect, death after settlement, and an
  assignment waiting for mesh work on its own worker. These exercise controlled
  native mTLS and test-owned local effects.
- Two full Gateway restart attempts failed at the control read. The second
  retained its redacted child error in
  `.tmp/worker-gateway-restart-de235a79-c774-4f3d-8b82-bc83faa0316d/worker-completion-failure.json`.
  After the bounded refresh change,
  `.tmp/comparison-mesh-deadline-chat-restart-lease-refresh.log` passed the one
  selected mesh case; eight other cases were not selected. The retained
  `.tmp/worker-gateway-restart-8882860b-e43c-41b5-b1e9-a1bf5c1b6e11/result.json`
  confirms one destination effect, completed Chat and replay without additional
  effects or model calls. Its five model dispatches were controlled fixtures.
- `verify:remote-workers` now includes the complete worker package as an
  additional check with `requireAllExecuted`, alongside its existing native
  process checks. The final run passed all 13 checks and 1,413 tests, with no
  failed or skipped tests. Its manifest is
  `artifacts/verification/2026-09-11T18-10-11-599Z-remote-workers-9f4ac226/manifest.json`.
  This includes 17 native process tests and 25 PostgreSQL tests across ten
  owner suites on the first temporary cluster. The cluster stopped and its
  listener was absent after completion. The proof matrix records 11 executed
  scenarios and one declared skip for physical two-machine acceptance.
- The lane's 12 verification-harness tests, lint over 327 files, docs checks
  and whitespace checks passed. The separately selected built-Gateway mesh
  restart result above is additional evidence, not part of this lane's count.
  After the integrated run, its descriptive note and matching assertion were
  corrected to acknowledge that separate receipt; the lane harness and scoped
  lint were rerun. Runtime code and verification check selection were unchanged.

These changes do not complete the shipped destination tool/MCP adapters,
protected native volume/executor/service composition or C5/C6 live acceptance.
The existing backend gates remain in place. No operator credential, live
provider, external channel or installed service was changed.

## Bounded input for native cell execution

The shipped worker still needs its local tool/MCP registry and policy adapters.
Tracing that integration found a native prerequisite: the internal process
launcher always supplied empty stdin. `JobCommand.standard_input` and the explicit
`JobLimits.input_bytes` allowance now permit request bytes through the existing
AppContainer/job boundary. Zero remains the default allowance, and both launch
entrypoints reject input over their allowance or the internal 1 MiB ceiling before
copying it. Neither command-line arguments nor ambient environment carry it.

Nonempty input uses a private, first-instance, remote-client-refusing named pipe.
Both endpoints are verified as controller-owned before writing; only the read
handle enters the child handle allowlist. The controller pumps overlapped writes
while draining stdout/stderr. Cancellation, output limits, wall limits and early
closure terminate the exact job and join pending input before releasing its
buffers. This follows Windows' separate [overlapped pipe I/O](https://learn.microsoft.com/en-us/windows/win32/ipc/synchronous-and-overlapped-input-and-output)
and [cancellation completion](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelioex)
requirements. The result retains only byte counts and delivery completion;
delivery does not prove the tool consumed the request or completed an effect.

Evidence:

- The first native run passed 392 checks in normal and AddressSanitizer builds,
  including 40 new input checks. Its receipt is
  `.tmp/comparison-native-stdin-first.log`.
- The final run extended those cases through `RunVerifiedRuntimeJob` and passed
  398 checks in each build: 51 filesystem, 40 input, 148 workspace and 61 bundle
  checks, alongside the existing resource/token checks. Binary inputs of one
  byte, a complete pipe buffer and 1 MiB arrived exactly and reached EOF. A
  separate duplex-pressure case exceeded both output pipe buffers while consuming
  input. Early close, non-reading children, wall expiry, cancellation and output
  overflow retained incomplete delivery and verified zero remaining processes.
- `.tmp/comparison-native-stdin-bundle.log` records the final execution of the
  test entrypoint behind `verify:remote-worker:windows-cell-job`. Its retained
  native artifacts are under
  `%TEMP%\Goat Worker Cell Job KuvPbU`.
  Normal and sanitizer receipts each also passed seven loopback checks. The
  AppContainer probe retained a timeout while the same native control connected
  outside it. The task-owned controller-crash child exited, and source hashes
  remained unchanged throughout the run.

The previous 13-check TypeScript worker receipt is separate and was not rerun
for these native-only changes. Destination adapters, protected volume and quota
enforcement, governed runtime publication, installed custody/service composition,
two-machine acceptance and the live comparison remain unfinished. No installed
service, operator credential, live provider or external channel was changed.

## Protected native backing-file provisioning

The internal `CellVirtualDiskFile` owner now creates a fixed VHDX under the
verified workspace's controller directory. It uses the frozen controller
descriptor, retaining owner/group, protected access rights and medium no-write-up
integrity while removing inheritance flags appropriate only to directories.
The exact security verifier is shared with the existing workspace owner.
Creation requires a supplied nonzero disk identifier, aligned virtual capacity
and explicit file-byte reservation with metadata headroom. It verifies actual
NTFS identity, metadata, physical/allocated bytes, disk identifier, provider,
fixed subtype, sector size and unattached state. An existing file is refused;
there is no image adoption, attachment, formatting or deletion operation.

Creation uses the Windows [virtual-disk API](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-createvirtualdisk)
with an overlapped operation. Cancellation and wall expiry cancel and join that
operation before releasing its event/buffers. Failure retains the attempted
state for canonical reconciliation, including when the API returns no usable
handle. The internal reservation check occurs after allocation; it is not an
OS quota or a guarantee about transient host usage. Quotas, attached-volume
protection, profile storage confinement and installed service custody remain
required before backend activation.

Evidence for this batch:

- The initial API probe created and inspected a task-owned, unattached fixed
  16 MiB VHDX on this non-elevated host. Its observed backing allocation was
  20 MiB. No existing disk, installed service or operator runtime was attached
  or changed.
- Three initial native attempts failed: the invalid cancellation pseudo-handle
  case, the file label inheritance check, and exact DACL restoration after
  deliberate drift. Their separate logs are `.tmp/comparison-native-vhd-first.log`,
  `.tmp/comparison-native-vhd-control-fixed.log` and
  `.tmp/comparison-native-vhd-file-label.log`. Actual file/control descriptors
  showed Windows normalizing inheritance flags differently for files. The
  implementation now derives the file descriptor before creation and preserves
  all frozen principals, access masks and integrity policy. Pseudo-handles are
  refused before submission.
- `.tmp/comparison-native-vhd-file-security.log` then passed 439 checks in each
  of normal and AddressSanitizer builds. Additional deadline and ordinary-file
  collision coverage produced the final, separate 448-check run in
  `.tmp/comparison-native-vhd-final.log`, through the test entrypoint behind
  `verify:remote-worker:windows-cell-job`.
- The final native receipts are under
  `%TEMP%\Goat Worker Cell Job lTXVmt`.
  Both builds executed 47 backing-file checks and 151 workspace checks, alongside
  the existing filesystem/input/bundle/resource cases. They cover actual fixed
  allocation, cancellation after the file becomes visible, provisioning expiry,
  wrong workspace authority, descriptor drift, retained identity, refusal to
  overwrite exact existing bytes, and AppContainer denial of backing-file read,
  write and DACL access. Each build also passed the seven loopback checks with
  successful native controls outside AppContainer. The controller-crash child
  exited, and the lane verified unchanged native source hashes throughout.
- Docs checks, scoped lint and tracked whitespace checks passed. An additional
  read-only audit verified all 23 native source hashes against the final receipt
  and checked their LF/trailing-whitespace rules. The task-owned crash child and
  native test controllers were absent after completion. Git remained unstaged;
  the status-path inventory matched the turn's starting snapshot.

This completes a backing-file prerequisite, not the native volume/executor or
the overall C5/C6 sequence. The earlier 1,413-test worker receipt remains
separate. Destination registry/policy adapters, attachment/formatting/quotas,
runtime publication, service/custody integration and live acceptance are still
unfinished. There were no real-provider calls, external channel messages,
credential changes, installed service changes or publication operations.

## Native attachment authority and acceptance lane

An internal attachment owner now consumes an already-created, verified backing
file rather than an arbitrary path. It retains the file identity and frozen
descriptor while opening the SDK handle, checks effective-token privilege,
and invalidates prior unattached readiness before submitting attachment.
It requests [no drive letter and permanent lifetime](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ne-virtdisk-attach_virtual_disk_flag).
Closing controller handles therefore does not silently remove an uncertain
attachment. Cancellation/expiry joins a submitted attach; ambiguous outcomes
remain unknown. Detach is explicit, rechecks current identity and privilege,
and checks cancellation/deadline before and after the synchronous Windows API.
The outer service watchdog still owns a stalled driver. Canonical provisioning,
zero-workload authority and recovery admission remain caller integration work.

Proof is split explicitly:

- `.tmp/comparison-native-vhd-attachment-first.log` passed 461 checks in normal
  and AddressSanitizer builds. The final source, including detach control and
  invalidation of stale unattached readiness, passed the same 461-check local
  lane in `.tmp/comparison-native-vhd-attachment-final.log`. The final native
  evidence is under
  `%TEMP%\Goat Worker Cell Job rKcyYa`.
  Both receipts report 13 attachment-authority rejection checks and
  `volumeAttachmentExercised: false`. The existing 47 backing-file checks, 151
  workspace checks and filesystem/input/bundle/resource cases also executed.
  Each build passed the seven loopback checks, with successful controls outside
  AppContainer. Controller-crash cleanup passed, and native source hashes were
  unchanged throughout the run.
- `pnpm verify:remote-worker:windows-cell-attachment` was attempted separately.
  `.tmp/comparison-native-vhd-attachment-preflight.log` records its failed
  privilege preflight: this host token lacks `SeManageVolumePrivilege`.
  The retained output directory `Goat Worker Cell Job gWkRNV` contains no VHDX
  image. The command did not grant a user right, elevate a process, attach an
  image, or start a workload. This is a blocked acceptance lane, not a pass.
  The subsequent detach/source-readiness changes do not alter that preflight.
- Docs checks, scoped lint and tracked whitespace checks passed. A separate
  audit rechecked all 24 native source hashes against the final receipt and
  verified LF/trailing-whitespace rules. The final crash child and native test
  controllers were absent. Nothing was staged; the only new status-path entry
  relative to this turn's starting inventory was the attachment proof launcher.

For the physical attachment gate, use an Administrator PowerShell in the
prepared Windows test checkout and run
`pnpm verify:remote-worker:windows-cell-attachment`. The command uses a temporary
token to enable an already-held privilege and restores the prior thread token;
it does not grant the account new rights. It creates only its private fixture
images, does not format them or run workloads on them, and requires successful
exact attachment and detachment in both native builds. Any uncertain attachment
is retained for reconciliation; do not classify a failed run as cleaned merely
because its controller exited.

The attachment path is compiled but has not executed successfully here.
Formatting, protected-volume verification, quota enforcement, canonical recovery,
destination tool/MCP registry adapters, service/custody composition, and live
mini-PC/Telegram/comparison acceptance remain unfinished. The native backend
remains unavailable. No operator configuration, credential, installed service,
real provider, external channel or publication operation was changed.

## Published schemas at destination execution and Gateway settlement

Gateway input admission and destination execution now enforce the exact published
tool schema. Input validation precedes an execution marker or effect. The second
destination input read still rechecks current remote authority and the same input
hash. Output validation follows execution; invalid output becomes unknown and
prevents automatic replay. Gateway independently checks successful output and
requires its bytes. It captures the submitted metadata and content before awaits,
so a caller cannot replace either while validation is pending.

A missing immutable manifest now rejects settlement instead of falling back to a
larger response ceiling. The retained before-fix tests reproduced both destination
schema failures and all three Gateway schema/limit failures.

The shared validator is a Node-only contracts subpath. It uses the already
lockfile-pinned Ajv and format libraries, validates draft 2020-12 without changing
input, refuses external schema resolution, and bounds compilation/evaluation in
four temporary worker threads. Each has a five-second limit, V8 resource bounds
and joined cancellation. [Ajv's security guidance](https://ajv.js.org/security.html)
describes why schema compilation and regex evaluation need separate bounds.
Published MCP metadata has schema digests rather than native schema bytes: this
layer checks selector names and envelope shape, while native argument validation
remains a required destination-registry responsibility.

Fresh proof, with separate receipts:

- The final validator suite passed 15 tests in
  .tmp/comparison-mesh-schema-validator-final.log. It includes real pathological
  regex termination, responsive main-loop checks, concurrency/cancellation,
  schema references/composition/formats, unchanged input and MCP selector checks.
- The complete worker package passed 234 tests across 27 files in
  .tmp/comparison-mesh-schema-worker-full.log, including all 38 destination cases.
- .tmp/comparison-mesh-schema-gateway-native-final.log passed 42 tests:
  39 Gateway invocation cases and three actual Windows native-mTLS destination
  process/recovery cases. The owner suite includes caller mutation during
  validation, omitted successful output, schema violations and manifest failure.
- .tmp/comparison-mesh-schema-chat-restart.log passed the selected mesh approval
  case; eight other cases were unselected. The retained
  .tmp/worker-gateway-restart-6539a660-9b3c-4cf2-8711-c74f555d4f7b/result.json
  records one effect through built-Gateway restart and canonical Chat replay.
  The destination owner and provider are controlled fixtures with synthetic custody.
- Contracts, worker and Gateway typechecks, scoped ESLint and the named async
  Gateway boundary passed. Runtime-truth manifest
  artifacts/verification/2026-09-11T20-21-23-810Z-runtime-truth-21186cb6/manifest.json
  passed both durable approval/restart and canonical-shell browser scenarios.
- A fresh portable Windows package was built at
  .tmp/comparison-mesh-schema-package-c81e41f74d9e42848bdc04f225c119a6/payload.
  Its 1,612-file manifest hash is
  6c61913910c80739eaec6e83cfbc80989ba665d05e43df7009ed45e42d3c8acc.
  The named Windows-package verification passed 24 regression tests and ran
  positive/negative schema validation through its packaged Node 24.19.0 runtime.
  .tmp/comparison-mesh-schema-package-probe.log retains the result. The dependency
  graph permits only the reviewed exact versions and peer metadata; the lockfile
  update added six importer lines without resolving other package versions.

This closes schema enforcement at the existing mesh execution boundaries.
It does not complete the shipped destination tool/MCP adapters, native protected
volume/quotas/service integration, installed custody or C5/C6 live acceptance.
No operator configuration, credential, installed service, real provider, external
channel or publication operation was changed. The administrator-run attachment
test still requires the pending operator answer.

## Stock destination filesystem reader

The shipped worker entrypoint now loads an optional, independently digest-pinned
local registry and executes a real `fs.read` adapter. The registry selects only
compiled-in tool names and exact published native schemas. Local roots cannot be
chosen by a manifest or model arguments. The reader bounds UTF-8 file/output
bytes and checks literal paths, local ancestry, root/opened-file identity, link
count and read-time metadata. It rechecks the local registry before and during
execution; changed configuration or root replacement prevents disclosure.
Gateway activation, policy, grants, approval and invocation admission remain
authoritative. An empty local registry still recovers retained work and refuses
unknown outcomes, while never polling for new invocations.

Fresh proof for this change:

- The focused registry, startup and mesh execution suites passed 84 tests in
  `.tmp/comparison-destination-registry-focused.log`. The earlier complete worker
  suite passed 265 tests before the additional empty-registry recovery test;
  those are separate receipts.
- Four native destination cases passed in
  `.tmp/comparison-destination-registry-native-final.log`. The new case launches
  built `main.js`, reads an actual file over native mTLS, preserves one settlement
  across restart and refuses a changed registry.
- The selected full Chat activation/tool-approval/Gateway-restart case passed in
  `.tmp/comparison-destination-registry-chat-restart-passed.log`: one selected case
  passed, eight other cases were unselected. It now uses the built stock reader,
  checks exact file output in the canonical Chat tool result and Gateway
  settlement, and joins that settlement to the destination's retained receipt.
  The earlier simulated-destination receipt remains historical evidence.
- Worker/Gateway typechecks and scoped ESLint passed. Initial Chat fixture
  expectations were corrected to assert actual file output and the existing
  hash-only local receipt format. A separate build attempt was refused by the
  package build's live output lock; the passing run used the output-lock wrapper
  after the package build completed.
- A fresh 1,615-file Windows package at
  `.tmp/comparison-destination-registry-package-2820e219f0a44b6fa56202ac4f0e55b0/payload`
  has manifest hash
  `62a5968579096dd87fadb283a058515f29f6259fd859d82f8082785083877b2b`.
  Its named verification passed 24 tests and executed both schema validation and
  a real filesystem read using packaged Node 24.19.0. The receipt is
  `.tmp/comparison-destination-registry-package-probe.log`.
- `pnpm verify:remote-worker:windows-host` passed 29 worker tests and 19 native
  host/service-identity tests with no skips. The native host forwards the exact
  registry path/digest while still removing unlisted environment variables.
  Evidence: `.tmp/comparison-destination-registry-windows-host.log` and
  `%TEMP%\Goat Worker Host a3biBf`.
- The full Chat receipt is
  `.tmp/worker-gateway-restart-90ce38ba-83cb-41a1-a22c-e67c6a016f82/result.json`:
  one destination receipt, a Gateway restart from PID 46404 to 32228, and five
  controlled-provider dispatches. It does not contain live-provider evidence.
- Documentation and tracked/untracked whitespace checks passed.

[Foreground setup](REMOTE_WORKER_MESH_TOOLS.md) records the exact registry fields
and boundaries. The subsequent write implementation is recorded below.
Additional filesystem tools, destination MCP owners,
native cell/volume/quotas/custody/service integration, broader placement,
delegation/council and C5/C6 live acceptance remain unfinished. The registry is not
yet part of the installed service's closed configuration flow. No operator
configuration, credential, installed service, real provider, external channel or
publication operation was changed by this implementation work.

## Stock destination filesystem writer

The foreground registry now accepts `fs.write` only for its exact published
native contract and logical read/write root. It supports create-only writes and
replacement with exact previous-content matching, bounded to 32 KiB per value.
The native image guard pins a fixed sibling executable. That executable pins
NTFS directory ancestry, verifies the retained root identity, rejects reparse
points/hard links/streams and uses an exclusive file handle for comparison,
writing, truncation, flushing and final hash verification. The worker checks that
the known response fits the published budget before mutation. Failures after
mutation or a lost helper response retain an uncertain outcome for reconciliation.
Replacement is in-place, without an atomic rollback guarantee.

Current local proof:

- All 282 worker tests passed in 29 files:
  `.tmp/comparison-destination-write-worker-full.log`.
- `pnpm verify:remote-worker:windows-files` passed all nine tests, including
  real create/edit/stale-content/path-escape cases, native protocol bounds,
  AddressSanitizer and cancellation that joins the exact running helper PID.
  Evidence: `.tmp/comparison-destination-write-native-final-r2.log` and
  `%TEMP%\Goat Worker Files YRNwUQ`.
- The selected stock-worker write/settlement/restart case passed over native
  mTLS: `.tmp/comparison-destination-write-stock-worker.log` (one selected,
  four unselected). It verifies actual changed bytes, one retained settlement,
  preservation of a later operator edit after restart, and registry revocation.
- The full Chat activation/tool-approval/Gateway-restart write case passed:
  `.tmp/comparison-destination-write-chat-r2.log` (one selected, nine unselected).
  The file remains unchanged while approval is pending. The approved write,
  canonical Chat result and destination settlement agree. The result is
  `.tmp/worker-gateway-restart-5287edae-f76e-4653-a85f-d28176baab56/result.json`:
  one destination receipt and five controlled-provider dispatches. This receipt
  precedes the final response-budget preflight, which the complete worker suite
  above covers.
- Native TLS/image-guard regression passed 23 tests, including reproducible
  x64/arm64 builds, image replacement refusal and real mTLS admission/reconnect:
  `.tmp/comparison-destination-write-tls.log`. ARM64 execution was not run.
- Package contract tests passed 24 tests:
  `.tmp/comparison-destination-write-package-contract.log`.
- A fresh final Windows package contains 1,618 files at
  `.tmp/comparison-destination-write-final-package-95af07b8b8c14ffab753512da0227bb5/payload`,
  manifest SHA-256
  `0068a0a8c9179a420bd3e095a938db7b937ae77c19e08b60ecf8d94522867214`.
  Its probe passed actual reader/create/edit/stale-content checks using packaged
  Node 24.19.0 and the fixed native helper:
  `.tmp/comparison-destination-write-final-package-probe.log`.
  This includes the final response-budget check. It remains an unsigned portable
  candidate; installed service, protected custody and physical-worker acceptance
  are unproven.
- Worker/Gateway typechecks and scoped ESLint passed. Initial build-only failures
  from a missing staged header and a signed fixture comparison were corrected.
  The initial Chat name filter selected zero tests; only the subsequent selected
  run above is acceptance evidence.
- `pnpm docs:check`, tracked `git diff --check` and the new-source whitespace
  check passed. No changes are staged.

This completes the shipped foreground write adapter, not C5. Destination MCP
owners, broader placement/delegation, protected-cell volume/quotas/executor/custody
and installed-service registry integration remain source work. Physical mini-PC,
Telegram and live-provider comparison acceptance remain separate. Operator
configuration, credentials and installed services were not changed; no real model
calls, external messages or publication operations were performed.

## Stock destination HTTP MCP adapter

The foreground registry now accepts `mcp.http` for an exact published MCP-server
entry. It pins a normalized endpoint and selected native input/output schemas,
checks fresh discovery and enforces the existing Gateway authority immediately
before `tools/call`, including after the socket opens. The adapter supports
unauthenticated Streamable HTTP with JSON and SSE responses. It refuses redirects,
untrusted certificates, credentials/custom headers, protocol/schema drift and
server-initiated requests. Native schemas use the bounded contracts validator.

The server is independently operated. Its permissions are not a worker sandbox;
the publication retains an unknown effect posture and only the configured network
origin. Responses, deadlines and discovery are bounded. Errors after tool dispatch
remain unknown, and retained settlement prevents execution again after restart.

Current local proof:

- The full worker suite passed 310 tests in 30 files:
  `.tmp/comparison-destination-mcp-worker-final.log`. It includes the runtime-owned
  callback that rejects changed input or revoked authority after owner preflight.
- Two subsequent transport tests verify certificate refusal and revocation after
  socket connection. The resulting focused MCP suite passed all 27 tests:
  `.tmp/comparison-destination-mcp-transport-final.log`. This is a separate focused
  receipt, not a synthetic 312-test full-suite run.
- Both selected stock-worker MCP/native mTLS cases passed:
  `.tmp/comparison-destination-mcp-native-r2.log` (two selected, five unselected).
  Success/restart retains one invocation; a lost reply retains an unknown
  settlement and stops both the original worker and its replacement without
  calling the server again. The initial lost-reply test incorrectly expected a
  successful process exit; the corrected assertion matches the existing runtime
  stop-for-reconciliation behavior. No production relaxation was needed.
- The complete built-Gateway/stock-worker Chat activation, tool approval and
  Gateway restart case passed after the final authority check was added:
  `.tmp/comparison-destination-mcp-chat-final.log` (one selected, ten unselected).
  The server receives no tool call while approval is pending, then exactly one
  call and one destination settlement. The canonical Chat result survives replay.
  Receipt:
  `.tmp/worker-gateway-restart-74bf5adc-c2d3-4c75-bd50-93d777c76582/result.json`.
  Its five provider dispatches use a controlled loopback fixture, not a live model.
- A fresh Windows x64 package contains 1,620 files at
  `.tmp/comparison-destination-mcp-package-6658d2bdee0c4fc29910726014e31b84/payload`,
  manifest SHA-256
  `a319aa4f9b9d0fc2515e18362273879bf0183d19271382ce214086905ae928be`.
  Its probe executed a real MCP file-read exactly once using packaged Node
  24.19.0/OpenSSL 3.5.7, alongside schema and filesystem read/write checks:
  `.tmp/comparison-destination-mcp-package-probe.log`. Test modules are excluded
  from the package. This is an unsigned portable candidate, with installed
  service, protected custody and physical-worker acceptance still unproven.
- The named `verify:remote-worker:windows-package` lane passed all 24 package
  regression tests and repeated the packaged execution probe successfully:
  `.tmp/comparison-destination-mcp-package-lane.log`.
- Worker/Gateway typechecks, scoped ESLint, `pnpm docs:check`, tracked
  `git diff --check` and scoped new-file whitespace checks passed. Initial test
  setup failures from the registry optional-field declaration and a fixture
  outside the TypeScript source root were corrected before the passing receipts.
  No changes are staged.

Authenticated/stdio MCP, protected MCP process hosting, broader placement and
delegation/council, native protected volume/quotas/executor/custody composition,
and installed-service registry integration remain source work. C5 is still in
progress. No operator configuration, credentials or installed services were
changed, and no live-provider calls, external messages or publication occurred.

## Installed worker registry configuration

The installed native host can now derive its two mesh registry settings from a
SYSTEM-owned, worker-read-only selection file and an immutable registry named by
its SHA-256. The original twelve-setting service environment and initial enrollment
flow remain unchanged. Both selected files are pinned for the child lifetime;
invalid security, shape, size or a missing selected file refuses startup. The
worker still enforces the exact digest, scope, publication and adapter contracts.

The packaged `configure-worker-mesh-registry.ps1` supports preflight, initial
selection, updates and disabling new tools. It verifies the installed package and
receipt, source digest and ticket scope. An exclusive configuration lock, repeated
stopped-service checks and the expected previous selection govern publication.
The selection changes atomically only after the immutable registry is retained.
Running-host read handles prevent replacement. Old generations and interrupted
staging files are retained, and disabling does not delete runtime journals or
authorize uncertain work to run again. The command neither starts/stops services
nor changes destination directory permissions or capability activation.

Current proof:

- `pnpm verify:remote-worker:windows-service-install` passed all 29 tests:
  `.tmp/comparison-service-registry-install-final.log`. Retained evidence is
  `%TEMP%\Goat Worker Install 9RsaIm/acceptance.json`.
  PowerShell 5.1 and 7 each passed 46 real temporary-file behavior checks,
  including stale selection, concurrent writers, a service starting during
  staging, pinned-file replacement refusal, updates, disable and corrupt retained
  generations. Each engine's generated environment also passed 50 native checks
  in both normal and AddressSanitizer builds. Installer/enrollment regression and
  the new command's non-mutating preflight refusal passed. These fixtures do not
  claim SYSTEM-owned installation or live service execution.
- `pnpm verify:remote-worker:windows-host` passed: 29 worker lifecycle/configuration
  tests and 19 native host/service-identity tests, without skips.
  `.tmp/comparison-service-registry-host.log` retains the result. Native evidence:
  `%TEMP%\Goat Worker Host h1kyjC` and
  `%TEMP%\Goat Worker Identity yvvKrD`.
- A fresh Windows x64 package contains 1,622 files at
  `.tmp/comparison-service-registry-package-02e043462e664596894c79258cf7155c/payload`,
  manifest SHA-256
  `4ed6c9a819c5e399e5c28448eb2ddd0ccd6d29999bf9a8a70c3028c6a1dd9c6b`.
  The named package verifier passed all 26 inventory regressions and its actual
  packaged schema/file/MCP execution probe:
  `.tmp/comparison-service-registry-package-probe.log`. The inventory requires
  both registry configuration helpers; older candidates need rebuilding.

This closes the local source gap for installed registry configuration. It does
not complete C5: installed service/custody, protected-cell composition, additional
tools/transports, placement/delegation and physical/live acceptance remain open.
No real installation, service changes, registry configuration, credential changes,
live-provider calls, external messages or repository publication were performed.

## Native comparison permission evidence

The native probe now tests a real workspace read, a sibling read outside the
declared workspace, and a harmless script that creates one marker inside the
fresh fixture directory. No operator files are targets. Exact native call IDs
bind tool results; a separately read marker proves terminal execution. Auxiliary
requests and runtime/approval failures cannot become successful policy checks.
The provider accepts bounded text-only content arrays and returns fixed validation
reasons without echoing rejected request data. Modalities and spending bounds
remain enforced.

The pinned OpenClaw headless command merges a full-execution default. The original
legacy ask/security configuration did not override it, so a controlled diagnostic
actually executed the harmless script. The corrected profile uses canonical
`mode: ask` with empty safe-binary exemptions. Approval connections stay on the
owned rejecting comparison listener, preventing selection of an existing personal
Gateway. Native approval registration is unavailable in this headless profile;
it does not execute the command or certify approval/resume support. Hermes uses
risk-pattern approval checks and native host-user file access, so the two profiles
have different permissions.

Reports now require a permission policy backed by a retained operator review,
exact execution binding and native source-receipt hashes. Native launch review
supplies that evidence; supervised workflow receipts can attach it. The recorder
uses verified evidence rather than measurement assertions. Missing, unknown,
inconsistent or different policies prevent `comparable_live_results`, even when
all declared tool labels and task outcomes match.

Current proof:

- All 58 comparison tests passed after the final source changes:
  `.tmp/comparison-native-permissions-tests-r2.log`. Coverage includes provider
  limits, native launch policy, exact probe correlation, permission-review drift,
  workflow attachment, task verification and comparison classification. Probe
  conformance fails when observed access contradicts the configured policy.
- Final actual OpenClaw probe:
  `.tmp/native-permission-openclaw-r2-0329ae74c09c43e18f951dd29d5e9ea2/proof.json`.
  Four controlled provider calls; workspace read allowed, sibling read denied,
  terminal approval unavailable with no execution marker. The process exited
  successfully and normal cleanup settled. Tested policy conformance matched.
- Final actual Hermes probe:
  `.tmp/native-permission-hermes-r2-d3f94392dac74c4697188225b342c32c/proof.json`.
  Five controlled provider calls; both file reads and the harmless terminal script
  executed. The process exited successfully and normal cleanup settled. Tested
  policy conformance matched.
- Earlier failures remain separate: auxiliary requests initially confused probe
  state, OpenClaw's text-part arrays were rejected by the proxy, its tool-ID
  normalization prevented exact correlation, and the legacy full-mode execution
  run reported an upstream cleanup error. Those are not included in a synthetic
  passing run. The final receipts use the corrected harness and profile.
- Scoped ESLint, `pnpm docs:check` and tracked `git diff --check` passed. The final
  probes sent zero upstream model requests and
  no external messages. Native child processes and owned listeners terminated;
  arbitrary detached descendant cleanup is not certified.

This completes the local permission-probe and report-integrity work, not C6.
Supervised native approval/resume, equivalent campaign configuration review,
skill/channel journeys and live model acceptance remain open. C5's remaining
source work and mini-PC acceptance are unchanged. No credentials, operator
configuration, installed services or repository publication were changed.

## Destination MCP bearer authentication

The foreground destination MCP owner now supports a separately configured bearer
file, independent of Gateway enrollment and lease credentials. The local registry
stores its absolute path and exact SHA-256, never the token. Authenticated
descriptors use version `1.1.0` and an opaque configuration digest binding the
endpoint, selected native schemas and credential reference. A changed endpoint,
credential or schema cannot reuse the old published activation authority.

The existing bounded local-file reader rejects aliases, links, malformed paths,
oversized files and concurrent changes. Registry and credential checks run before
every HTTP request and again after connection, before sending headers. The registry
refuses credentials within any filesystem read/write root. Authentication failures
do not refresh or retry; a tool response echoing the raw token is withheld as an
uncertain post-dispatch result. OS file permissions remain operator-owned. Setup
and credential rotation requirements are in
[destination tool setup](REMOTE_WORKER_MESH_TOOLS.md#connecting-to-an-mcp-server).

Fresh, separate receipts:

- Full worker suite: **323 tests across 30 files passed** in
  `.tmp/comparison-mcp-bearer-worker-full.log`. The focused MCP suite includes
  JSON/SSE authentication, changed credential bytes, endpoint/reference drift,
  filesystem-root separation, revocation after socket connection, rejected
  authentication and token-echo refusal. The unit registry test substitutes the
  native writer's directory inspector; the package probe below uses the real one.
- Contracts: **7 tests passed** in `.tmp/comparison-mcp-bearer-contracts.log`,
  including the optional configuration digest and malformed-digest refusal.
- Worker, Gateway and their dependency typechecks passed under the output lock:
  `.tmp/comparison-mcp-bearer-typecheck.log`. Scoped ESLint also passed.
- Actual built-worker/native mTLS recovery: **2 selected bearer cases passed**,
  7 unrelated cases filtered, in `.tmp/comparison-mcp-bearer-native.log`.
  Successful execution settles once and does not repeat on restart. A lost reply
  retains one unknown settlement and stops execution across restart. Changed
  credential bytes refuse a later startup; all five MCP requests authenticated.
- Actual built Gateway/stock worker Chat: **1 selected bearer case passed**,
  11 unrelated cases filtered, in `.tmp/comparison-mcp-bearer-chat-r2.log`.
  Receipt `.tmp/worker-gateway-restart-a55f1ec0-2074-41c8-9aef-60afcffeddb7/result.json`
  records capability activation, tool approval, Gateway replacement, one actual
  MCP tool call, one settlement and five controlled provider dispatches. All five
  MCP session requests authenticated. Checked Chat/profile/settlement evidence
  contained no raw destination credential.
- Fresh Windows package:
  `.tmp/comparison-mcp-bearer-package-3b44df3ec145440d944e466408f60889/payload`.
  Manifest SHA-256
  `c6dde01e146ddb81e05026d84c7b79a6b18ee0f406fed2e32b4235206e006dad`;
  1,623 files, 102,998,351 bytes. The named package verifier passed its **26 tests**
  and actual packaged execution in `.tmp/comparison-mcp-bearer-package-probe.log`.
  Packaged Node 24.19.0/OpenSSL 3.5.7 performed schema validation, file read,
  native create/edit/stale-write refusal, and one bearer MCP file read. It proved
  credential separation from the real native writer and refused changed
  credential bytes without a second tool call.

Earlier diagnostic receipts remain separate: the first combined registry run
failed because its positive native-writer path lacked a test image, and the first
Chat selector selected no tests. The full worker and selected Chat receipts above
are the subsequent actual passing runs, not combined results.

This closes foreground bearer-file support, not C5/C6. OAuth/refresh, stdio,
protected MCP custody/process hosting, broader worker execution/placement and
supervised/live acceptance remain unfinished. The package is unsigned; installed
service, protected custody and physical-worker acceptance are unproven. These
checks used isolated fixtures, synthetic credentials and loopback providers;
no live provider requests, external messages, operator credential/configuration
changes or repository publication occurred.

## Supervised OpenClaw approval and resume

The optional `nativeApprovalGateway` profile now runs the actual pinned OpenClaw
Gateway and its Gateway-backed agent inside a fresh home. An independent token
and ephemeral loopback port separate approval authority from the model proxy.
Native ask mode, workspace reads and empty safe-bin exemptions remain in force.
The public native SDK event client retains approval events using the new
Gateway's `operator.admin` scope, which its visibility owner requires for
cross-requester requests. It never resolves approvals or impersonates a UI.

The campaign CLI requires an interactive terminal before setup. It polls native
pending requests and forwards only explicitly typed `allow-once` or `deny`
decisions through the native approval CLI. It retains intent before dispatch,
then the response or unconfirmed result; it does not retry uncertain decisions.
The launch binds the new driver files, and configuration drift prevents approval
dispatch. Gateway/event-client failure, operator interruption, normal agent exit
and the session deadline stop the owned processes. Approval events, decisions
and process results are hashed into the native execution evidence. The console
does not establish equivalent policies or a successful task outcome.

Fresh proof, retained separately:

- **66 tests passed**, no failures or skips, in
  `.tmp/comparison-native-approval-all-tests.log`. Coverage includes rejecting
  piped approval input, polling without granting, exact typed decisions,
  cancellation on input closure, uncertain decisions without retry, changed
  configuration refusal, source/profile binding, budgets and evidence integrity.
- Actual pinned OpenClaw campaign **allow-once**:
  `.tmp/native-approval-campaign-allow-once-final-de9732fc55f840989edfb2c7399e4e91/proof.json`.
  Four controlled model calls. The native request existed while the execution
  marker was absent; the one-time native decision resumed execution and created
  the marker. One intent/result pair was retained.
- Actual pinned OpenClaw campaign **deny**:
  `.tmp/native-approval-campaign-deny-final-e9b7945de3b94376b1a7873a3c9e2a25/proof.json`.
  Four controlled model calls. Native denial completed without executing the
  marker command. One intent/result pair was retained.
- Actual pinned OpenClaw campaign **abort**:
  `.tmp/native-approval-campaign-abort-final-2e0e23fc5b5b415bb573802cd7eda5f6/proof.json`.
  Three controlled model calls. Cancellation stopped the owned agent while its
  native request was pending; no decision or marker was produced.
- Scoped ESLint passed in `.tmp/comparison-native-approval-eslint-r2.log`.

The three campaign checks use the production comparison driver and budget owner,
but deterministic local responses and synthetic prices. Only their fixture
callback decides the generated harmless command; the campaign CLI uses typed
operator decisions. Their reviews are labeled as controlled fixtures, every
native process result stays `taskOutcome: unverified`, and manual intervention
counts are not invented. All final model dispatches stayed in the controlled
transport. No live provider requests or external channel messages were sent.
Fresh-state native authentication is distinct from installed/operator credentials.
Detached descendants, OS isolation and live interactive operator acceptance are
not certified by these receipts.

Earlier diagnostics remain separate: initial probes used an unsupported approval
CLI port argument; `agent exec` refused a running Gateway; and the first event
client lacked cross-requester visibility. The initial Gateway also fetched a
public model catalog. The supervised profile now disables catalog refresh along
with channels, cron, discovery and update checks. A subsequent helper-only
approval run passed before the final integrated campaign runs above. The initial
lint run found two intentionally omitted raw error causes; scoped suppression
comments now explain why credential-bearing native causes are not exposed.

This closes the local OpenClaw approval/resume adapter slice. C6 still needs the
other native approval flows, operator-run skill/channel journeys, equivalent
campaign review and live repeated outcomes. C5's source and physical-machine
requirements remain open. No publication or installed-service changes occurred.

## Supervised GoatCitadel approval and resume

The comparison profile now accepts `nativeApprovalGateway: true` for GoatCitadel.
The real terminal input reaches the isolated Gateway child; bounded output is
forwarded and retained by the supervisor. Headless behavior remains available.
The profile pins Git's executable and initializes only the fresh fixture's empty
repository with isolated configuration and empty templates. The Gateway receives
a relative project path under its workspace container, while tool jails remain
bound to the exact fixture directory. No files are staged or committed.

Before forwarding an explicitly typed decision, the adapter replays the native
approval and validates workspace, session, turn and Chat run. The approval-wait
run has a separate identity: both workflows must still be waiting for the exact
approval event. Intent is retained before native resolution; an uncertain reply
is retained without retry. Completion waits for terminal Chat and durable state,
then the canonical post-turn child runs. Console cancellation retains an
interruption receipt and exits the owned child with code 130.

Fresh evidence, with separate runs and limits:

- **75 tests passed**, no failures or skips, in
  `.tmp/comparison-goat-approval-final-r2-tests.log`. Regression coverage includes
  distinct wait owners, incorrect scope/correlation, uncertain decisions, active
  post-turn children, isolated Git setup and output-forwarding failure.
- Actual working-build **allow-once**:
  `.tmp/goat-approval-allow-once-final-3f0e6eff7d4d4c0d8648fd8fe349ed94/proof.json`.
  Five controlled model calls; the generated command's hash was checked while
  its marker was absent, then one typed native approval created the marker.
- Actual working-build **deny**:
  `.tmp/goat-approval-deny-final-36d317b3611c44039d3cb61ffeba30be/proof.json`.
  Five controlled model calls, one typed denial and no execution marker.
- Both allow/deny runs exited normally, with no warnings or stderr. The Chat
  run, approval-wait run and three post-turn child runs were completed in the
  retained fixture databases. `cleanupUnconfirmed` was false.
- Actual working-build **cancellation**:
  `.tmp/goat-approval-abort-r2-c1332a37714f41258585f3d0e53665ea/proof.json`.
  One controlled model call. Ctrl+C closed the console while native approval was
  pending; no decision or marker was produced. `interrupted.json` records the
  console cancellation, the child exited 130 and the conformance check exited 0.
- Scoped ESLint passed in `.tmp/comparison-goat-approval-final-r2-eslint.log`.

These checks exercise the actual built Gateway through public HTTP and the
interactive adapter, using synthetic responses and prices. They are explicitly
working-build fixtures, not clean-pinned campaign acceptance or live-model
quality evidence. The successful allow/deny runs precede the cancellation-only
receipt fix; the cancellation run and final test suite validate the later source.
Every native task outcome remains unverified for benchmark scoring. No upstream
model requests or external channel messages were sent. Detached descendants,
installed-service behavior and physical two-machine acceptance remain unverified.

Earlier diagnostics remain separate. The initial fixture needed an explicit tool
request and declared output budget; subsequent runs exposed missing Git identity,
an absolute project-path mismatch and confusion between the two durable owners.
An approval run then created its marker but stopped before post-turn work settled;
the completion check now waits for those native child runs. The first console
cancellation was safe but lacked a structured receipt and was incorrectly expected
to appear as a parent-process abort. The final cancellation retains the child's
actual exit and interruption evidence. These earlier checks are not reported as
one passing run. C5/C6 remain in progress.

## Supervised Hermes approval and resume

The optional `nativeInteractiveCli: true` profile launches the clean pinned
Hermes CLI with real terminal input and output, explicit file/terminal toolsets
and the ordinary native approval rules. It does not use automatic approval or
the broader ACP tool profile. The operator handles the native approval menu and
uses `/exit` after the turn. Piped stdout would change Hermes to single-query
behavior, so this mode deliberately inherits stdout: it is visible, but is not
captured or byte-limited. Stderr, the provider budget and the deadline remain
bounded. This limitation is retained in the launch review and process receipt.

After the owned process stops, the driver exports the fresh native session
database read-only. It checks the ordinary file path, bounds database/message
sizes, preserves native tool-call correlation and hashes the export with the
execution evidence. It does not infer approval votes or benchmark outcomes.
Process receipts are retained even if transcript export fails. Deadline closure
now retains `deadline` rather than incorrectly reporting `operator_abort`.

Separate retained evidence:

- **79 tests passed**, with no failures or skips, in
  `.tmp/comparison-hermes-interactive-final-tests.log`. Coverage includes the
  interactive profile, unsupported options, read-only native SQLite export,
  orphan/oversized evidence rejection and actual process deadline classification.
- Actual pinned Hermes **allow-once**:
  `.tmp/hermes-interactive-allow-once-r3-d025d562293741c7a3c35a226357063a/proof.json`.
  Three controlled model calls. The exact disposable file was inspected before
  selecting native Allow once; only then did the command remove it. The native
  tool result records approval and exit code 0.
- Actual pinned Hermes **deny**:
  `.tmp/hermes-interactive-deny-r3-57c0822c294b44158bdc3d6cc4a1877d/proof.json`.
  Three controlled model calls. Native Deny retained the file and returned a
  blocked tool result. Both allow/deny CLI processes exited normally via `/exit`.
- Actual pinned Hermes **turn cancellation**:
  `.tmp/hermes-interactive-abort-final-5496a4bd3deb494b8b608051bcd37ebf/proof.json`.
  Two controlled model calls. Ctrl+C denied the pending native command and
  retained `Operation interrupted.`; the file stayed unchanged. `/exit` then
  closed the CLI normally. This is a cancelled turn, not a killed process.
  The strengthened fixture rejects a mere timeout or missing execution result.
- All three process receipts report `cleanupUnconfirmed: false`; detached
  descendants remain `not_verified`. The allow/deny runs precede the final
  fixture assertion strengthening; cancellation and the final suite validate
  that later source. Scoped ESLint passed in
  `.tmp/comparison-hermes-interactive-final-eslint.log`.

These checks run the actual pinned Hermes CLI through the production comparison
driver, with synthetic provider responses and prices. No upstream model request
or external channel message was sent. Every benchmark task outcome remains
unverified. Real model quality, equivalent product policies, native skill/channel
journeys, clean-pinned GoatCitadel campaign proof and C5 acceptance remain open.

Earlier diagnostics remain distinct: the first approved command failed because
the native Bash terminal consumed Windows path separators. The fixture now uses
a forward-slash absolute executable path. The next approval run executed but
expired before CLI exit; its paired denial run expired before confirmation.
Neither is counted as passing acceptance. Their deadline receipts exposed the
shutdown-cause bug fixed above. No upstream checkout or installed service changed.

## GoatCitadel native skill workflow in progress

The experimental `nativeSkillWorkflow: true` option requires a GoatCitadel
`workflow_capture_reuse` cell, file/skill tools, and `nativeApprovalGateway: true`.
Its adapter uses public Chat capture, immutable artifact review, change-plan,
approval, journey and capability-profile APIs. It requires exact typed artifact
reviews and a separate native activation approval. The phase controller withholds
reuse inputs until activation evidence is validated. Reuse must use a new session
in the same workspace and load the reviewed module hash; rendered prompt hashes
are retained separately. This complete native path now passes a controlled
working-build run; it is not a clean-pinned campaign or live-model quality result.

The comparison runtime now configures its workspace root to the exact jailed
fixture directory and its project to `.`. Previously the safe-write probe used
a sibling directory outside the jail and hid document-writing tools. The jail
was not expanded. The controlled provider now supplies native line-range
arguments and document sections, and requests an output read after writing.
The fixture alone disables unsolicited autonomy so model calls belong to the
requested workflow; product defaults are unchanged.

Two runtime owners needed repair. `ApprovalResolutionEffectsService` now links
concrete tool completion only when the current claimed effect, persisted pending
action, approval, exact Chat scope, result and canonical execution event agree.
The effect and Chat evidence commit together; missing or inconsistent evidence
remains uncertain. Capture's settled-evidence requirement remains intact.

`SessionMutationAdmissionRepository` now recognizes completed post-commit
children whose write admissions were cancelled by a policy block. Parent release
requires the exact native `late_blocked` stage receipt and terminal idempotency
key, alongside the existing immutable identity, lineage and settlement guards.
This fixes a completed Chat retaining its active-turn claim and rejecting the
next message with HTTP 409. It does not enable the blocked writes.

The adapter now keeps one review reader across stage/artifact/confirmation input,
includes full session/turn scope on Change Plan reads, and uses the native resume
action only after the exact activation effect completes. It checks the canonical
operator-attributed Journey event against approval, candidate, version and observed
outcome. The conformance runner also retains the launch receipt referenced by its
permission review; the independent verifier's requirements are unchanged.

Evidence for the native run and runtime repairs:

- `.tmp/goat-workflow-native-r10-cf2a22aa0a17405d9a37b351a156326f/proof.json`
  records normal child exit 0, confirmed cleanup, nine synthetic model calls,
  zero upstream requests and no early release of held-out input. The separate
  `verification.json` passed all six checks: source workflow, captured skill,
  exact reviewed version loaded in a new session, output contract, separation of
  unsupported claims, and absence of unrequested activation. The reviewed and
  loaded `SKILL.md` hash is
  `460c39446ca04ddb0fcca06d59357537260b950b483e9a6f0f020131ac8be45d`.
- **87 comparison tests passed**, without failures or skips, in
  `.tmp/comparison-goat-workflow-final-r9-tests.log`. Coverage includes review
  reader lifetime, exact activation-effect and Journey projection, loaded-module
  identity, session scope, bounded HTTP failures and review cancellation.
- Approved-tool completion tests passed **119/119** across four files in
  `.tmp/approved-tool-completion-focused-r2.log`, including 17 completion-evidence
  regressions for wrong identity, missing/ambiguous evidence and transactional
  rollback/recovery.
- Post-commit integration/effect tests passed **32/32** in
  `.tmp/post-commit-skip-focused-r4.log`; the storage admission suite passed
  **25/25** in `.tmp/post-commit-skip-storage-tests.log`. Recovery accepts genuine
  policy skips, rejects malformed receipts, survives reopen/replay and admits
  the next Chat write.
- The integration suite separately passed **15/15 on real PostgreSQL**, with
  no skips, in `.tmp/post-commit-skip-postgres-r2.log`. Each fixture used its own
  schema and the local compatibility facade; this is not RPC-worker proof.
  The task-owned database stopped and its temporary evidence directory remains.
- Gateway typecheck passed in `.tmp/post-commit-skip-typecheck.log`. Scoped
  ESLint passed in `.tmp/comparison-goat-workflow-final-r9-lint.log` and
  `.tmp/comparison-goat-workflow-final-conformance-lint.log`; scoped formatting
  passed in `.tmp/comparison-goat-workflow-final-format.log`.
- Fresh named `verify:runtime:truth` passed **2/2**, including browser/restart
  proof, under `artifacts/verification/2026-09-12T02-59-12-470Z-runtime-truth-ffd02715`.
  `verify:durable:recovery` separately passed **3/3** under
  `artifacts/verification/2026-09-12T02-59-50-196Z-durable-recovery-336d4686`.
- `pnpm docs:check` passed in `.tmp/comparison-goat-workflow-completion-docs.log`;
  scoped `git diff --check` passed. The checkout has no staged changes.

Earlier diagnostics remain separate from that successful run. R3 stopped at
uncertain approved-tool evidence; r4 exposed review-input lifetime; r5 exposed
the post-commit policy-skip handoff. R6 omitted session scope on plan reads, r7
did not submit the native resume action, and r8 expected the wrong Journey actor.
R9 completed the product workflow and its child exited 0, but the conformance
runner exited 1 because its execution summary omitted the existing launch
receipt required by the permission review. These are retained failed diagnostic
attempts, not part of a synthesized green run. Their original evidence was not
rewritten. Earlier r1/r2 source-creation diagnostics remain non-acceptance runs.

Fresh approval-denial/cancellation regression against the adjusted workspace
profile, equivalent cross-product skill/channel campaigns, clean-pinned campaign
execution and live-model outcomes remain open. No external message, installed
configuration change, commit, push or deployment occurred. C5/C6 are still in progress.

## Bounded native workflow campaign evidence

The successful r10 native workflow retained 405 API snapshots. The campaign
driver previously added each one to its top-level receipt list, exceeding the
independent verifier's existing 100-receipt limit. Its separate conformance
runner used the three phase bundles and therefore did not expose that campaign
assembly defect.

`readNativeGoatWorkflowEvidence` now owns this assembly for both callers. It
verifies exact execution binding and source, distinct phase/permission references,
unchanged referenced bytes, and lossless coverage of the raw snapshot inventory.
It compares multisets of snapshot names and payloads so concurrent completion
order and repeated identical polls remain valid. Missing, changed or substituted
snapshots fail. Ordinary files are limited to 4 MiB each, all reads share a
32 MiB cap, and the inventory retains the workflow's 500-record limit. Linked
paths/files and cancellation also fail closed. The raw files remain on disk;
the campaign references the existing phase bundles and workflow summary. The
verifier's 100-receipt bound and task outcome checks are unchanged.

Validation:

- `.tmp/comparison-goat-evidence-all-tests-final.log` passed **96/96 comparison
  tests**, without skips. Nine new regressions cover oversized campaign receipt
  inventories, lossless bundling, changed/missing/extra snapshots, substitution
  despite an updated bundle hash, scope/source/phase mismatch, duplicate references,
  hard links, per-file and aggregate byte bounds, record limits and cancellation.
- Scoped ESLint passed in `.tmp/comparison-goat-evidence-lint-final.log`.
- `.tmp/goat-workflow-evidence-recheck-nChHBJ/revalidation.json` records a
  read-only revalidation of r10's retained working-build evidence. All 405 raw
  snapshots matched their phase bundles. A separate derived evidence directory
  passed the six independent workflow checks with six top-level references.
  The original evidence was not rewritten. This was **zero new native runs**
  and zero upstream requests, not a fresh campaign or a live-model result.

The clean-pinned campaign launch and cross-product skill/channel journeys remain
open. No product runtime, upstream checkout, credentials, installed configuration,
or external destination was changed in this evidence-assembly repair.

## OpenClaw native skill workflow

`nativeSkillWorkflow: true` now supports the pinned OpenClaw
`workflow_capture_reuse` cell with `nativeApprovalGateway: true` and the explicit
files/skills profile. The foreground child uses OpenClaw's public authenticated
Gateway client and its native agent, history, and Workshop RPC owners. It does
not write a skill into the product's filesystem itself. Terminal tools and
support-file bundles are outside this adapter's supported workflow.

The native model stages a pending proposal whose origin identifies its capture
run and source session. The terminal operator reviews the native proposal and a
derived preview of the exact installed instructions, then separately confirms
`skills.proposals.apply` with the native revision hash. Native apply removes
proposal-only metadata. Installed bytes and the single native activation event
must match the review before held-out input is released. A different session
must select `release-note` and actually read its complete instructions through
the native `skill_workshop` tool. Merely listing an available skill does not pass.
Post-reuse native inventory, events, and installed bytes are checked again.

The earlier comparison profile used an empty `skills.allowBundled`; the pinned
runtime treats that as unrestricted and its retained prompt contained 17 bundled
skills. The corrected profile uses the agent-level skill filter: empty for the
file/terminal cases, or only `release-note` for this workflow. No skill is seeded.
Workshop autonomy is explicitly off and lifecycle approval is pending. This
governs Workshop operations, not arbitrary edits through other filesystem owners.
It does not establish identical product policy or OS isolation.

The campaign evidence reader now supports the two native workflow owners while
preserving distinct phase names, product identity, raw directories, and all
existing hash, inventory, byte and cancellation limits. Normal process shutdown
no longer cancels final evidence assembly; operator cancellation still does.
Controlled callers retain that provenance from session start through execution
and independent verification, so synthetic-provider runs cannot become live
benchmark results.

Fresh native proof:

- `.tmp/openclaw-workflow-native-r3-869a6cb518d741779e3e8492300e1411/proof.json`
  and `verification.json`: process exit 0, normal shutdown, cleanup confirmed,
  **six independent checks passed**, 30 native snapshots, 11 top-level receipts,
  11 synthetic model calls, zero upstream requests, and no early held-out input.
  The reviewed and subsequently loaded instruction SHA-256 was
  `233e998b97a98d309e8a7a30ca3c16a97a6ce9548fcef14d31aca670e9036f68`.
- `.tmp/openclaw-profile-skill-filter-b704312fb81e4e50a58d163f10bbbf0d/proof.json`:
  separate controlled native denial passed. The exact native prompt report had
  zero skill entries; the denied marker command did not execute. Four synthetic
  calls, zero upstream requests, and confirmed process cleanup.

Diagnostics remain separate. R1 rejected the then-unsupported OpenClaw workflow
option before starting a native process or model call. R2 completed native
capture/apply/reuse but its adapter rejected history because it expected the
optional Workshop `details.contentIncluded` field. Native history omits that
field while retaining the complete tool-result text. The corrected check requires
the exact full-text hash and rejects explicit omission, errors, mismatched calls,
partial history, and a reused source session. R3 was a fresh successful execution;
neither earlier receipt was rewritten.

Local verification:

- `.tmp/comparison-openclaw-workflow-all-tests-final-r2.log`: **105/105 comparison
  tests passed**, with no skips. New regressions cover source/turn binding,
  pending proposal origin, review/activation identity, installed-byte substitution,
  absent/truncated/mismatched native tool results, held-out release order, new
  sessions, product-specific phase bundles, and controlled-source retention.
- `.tmp/comparison-openclaw-workflow-lint-final-r2.log`: scoped ESLint passed.
- `.tmp/comparison-openclaw-workflow-format-final.log`: touched scripts formatted.
- `.tmp/comparison-openclaw-workflow-docs-final.log`: `pnpm docs:check` passed.
  This slice did not rerun unrelated product build or installer lanes.

At that checkpoint, Hermes skill capture/reuse, cross-product channel journeys,
clean-pinned GoatCitadel campaign execution, repeated real-provider outcomes, and
the C5 source/physical-machine requirements remained open. This slice did not change the
upstream checkout, installed product, operator credentials, or external channels.
No commit, push, or deployment occurred.

## Hermes native skill workflow

The pinned Hermes adapter now runs the source task, capture in the resumed source
session, native operator review, and reuse in a new session. It uses the actual
CLI and its retained SQLite messages. The native `skills opt-out` command and
public startup sync retain only Hermes's mandatory operating manual as the
initial skill baseline; optional bundles and external/project discovery are off.
The runtime's `skills.write_approval` gate stages the model's `skill_manage`
create operation. Neither the adapter nor fixture calls the private apply bypass.

The operator reviews the pending payload, projected file bytes and instruction
text, then uses `/skills pending`, `/skills diff <id>`, `/skills approve <id>` and
`/exit` in the real Hermes terminal. Approval must leave one native ledger create
event with the exact installed file hash. The review session may not add model
turns. Only then does the shared controller release the reuse input. A different
session must return the full reviewed content through `skill_view`, and the skill
inventory/activation history must remain unchanged afterward.

Hermes binds approval to a pending ID without an expected hash argument. Its
ledger records the observed actor as `agent` even for this CLI-approved write.
The adapter preserves that native evidence and uses content-addressed comparison
references; it does not claim native version IDs, exact-version CAS approval, or
an operator-authored ledger identity. Native user-message keys identify the
source/capture/reuse turns. On Windows Python writes CRLF file bytes and reads
universal-newline LF text, so both hashes are reviewed and independently checked.
Host-user filesystem access and the essential manual remain explicit differences
from the other products' profiles. This controlled journey is not a claim of
equivalent policies or comparative live-model quality.

Fresh native proof:

- `.tmp/hermes-workflow-native-r4-1789188712969/proof.json` and `verification.json`:
  exit 0, normal process shutdown, no unconfirmed cleanup, **six independent
  checks passed**, 20 native snapshots, nine top-level receipts, 13 synthetic
  model calls, zero upstream requests and no early release of held-out input.
- Source/capture session `20260911_215158_04d1f9`; reuse session
  `20260911_215342_e9ae3d`. Pending write `e1de87da` produced native ledger event
  `8a559392f58e`.
- Reviewed/native file SHA-256:
  `672c2f3519a4feab8fec8226b7ea3aa427a8c547aed74b185f96b31ab1d7ba8f`.
  Reviewed and actually loaded instruction SHA-256:
  `bb2082c6255e1899332d75ea132a92a32df5e1c3be6e5d2babfc41c0afde4de2`.
- `.tmp/comparison-hermes-workflow-all-tests-r4.log`: **115/115** local comparison
  tests, no skips. New regressions cover native history/route binding, pending
  tool-call origin, ledger/install changes, Windows newline conversion, actual
  skill reads, withheld input on failed review, unexpected review model turns,
  bounded ordinary files and hard-link rejection.

Earlier diagnostics remain separate and unchanged: R1 exposed the native
`assistant_tool` origin label; R2's native apply rejected the fixture's oversized
description; R3 exposed the Windows file-versus-text hash difference after a real
successful approval. Each stopped with reuse input withheld. R4 is the fresh
successful campaign after those adapter/fixture corrections. These diagnostic
roots are `.tmp/hermes-workflow-native-r1-1789188207584`,
`.tmp/hermes-workflow-native-r2-1789188287572`, and
`.tmp/hermes-workflow-native-r3-1789188440047`.

The upstream checkout remains clean at
`bf53ff00a7360826ec2c9e2949533160068a8fc8`. Cross-product channel journeys,
clean-pinned GoatCitadel campaigns, equivalent reviewed campaign policies,
repeated live-provider outcomes, and the C5 source/physical-machine requirements
remain open. No installed product, operator credential, external channel, commit,
push or deployment was changed by this slice.

## Interactive native worker stdio

The destination stdio MCP gap requires an interactive process owner. The existing
Windows job owner accepted only a complete initial input payload. It now accepts
an optional `JobStdioChannel`, and `RunVerifiedRuntimeJob` forwards that channel
while retaining the entire admitted runtime bundle. The static input path remains
available and is covered by the same fresh verification run.

Source owners are `apps/remote-worker-windows-cell-native/src/cell_job.cpp`,
`cell_job_stdio.hpp`, `cell_job_stdio.cpp`, and `cell_runtime_bundle.cpp`.
The channel cannot select an image, command, directory, environment, permission,
approval or runtime bundle. It carries ephemeral bytes between the existing
native owner and its caller. A caller must join the job before destroying it.

- One channel can belong to only one job. Concurrent attachment, reuse after
  completion and input after EOF are refused. Static and interactive input cannot
  be combined.
- Input uses a 64 KiB queue and shares one cumulative admitted limit, at most
  1 MiB, across all frames. A full queue accepts none of a new chunk or its EOF.
  Waiting for the next frame does not imply EOF or stop output/cancellation.
- Stdout and stderr each have a fixed 64 KiB queue. Overflow fails the job and the
  protocol reader; it cannot produce a silently truncated successful response.
  Separately bounded diagnostic prefixes/tails retain their existing behavior.
- The AppContainer identity, zero capabilities, low integrity, exact image and
  directory checks, explicit environment, process/resource limits and retained
  job handle continue to govern launch and cleanup. Pending writes are joined
  before their buffers are released. Unconfirmed cleanup is not a normal EOF.
- The verified-bundle entrypoint pins the full reviewed inventory throughout an
  interactive exchange. Real native exchanges also run from the protected runtime
  directory populated by the internal bundle installer.

Fresh `pnpm verify:remote-worker:windows-cell-job` passed in
`.tmp/comparison-worker-interactive-stdio-r2.log`. Evidence is retained in
`%TEMP%\Goat Worker Cell Job L7Lp2m`:

- `normal.json` and `asan.json`: **532 checks each**, including 57 interactive
  channel checks, 40 static-input checks, 51 launch-filesystem checks, 158 workspace
  checks and 68 bundle checks. The interactive cases consume a fresh native child
  challenge before sending a response, preserve binary bytes through queue wrap,
  enforce cumulative input limits, handle idle/pending-write cancellation, enforce
  wall time, fail unread output, and reject channel reuse.
- `network.json`: seven checks in each build. The zero-capability AppContainer
  timed out against the controlled loopback listener; the same probe connected
  outside AppContainer. The timeout remains recorded as a timeout.
- `owner-crash-static.json` and `owner-crash-stdio.json`: both task-owned
  controllers were terminated after their exact child/profile ownership was
  recorded; the corresponding children exited. The interactive case had queued
  input and a non-reading child. Fixture profiles were cleaned up.
- `sources.json`: all **28** native source snapshots still match their current
  bytes after verification. The earlier R1 receipt is separate: it passed 518
  checks before the two bundle journeys and interactive crash case were added.

The file-executor build inventory includes the new transitive header. Separate
`pnpm verify:remote-worker:windows-files` passed **9 tests**, including native and
AddressSanitizer execution, in `.tmp/comparison-worker-interactive-stdio-files.log`.
Its retained root is `%TEMP%\Goat Worker Files aSikcN`.
Scoped script lint and `git diff --check` also passed.

This is an internal native prerequisite, not a completed destination stdio MCP
feature. At this stage, protocol/schema handling, a registry binding, the packaged
native bridge and the Gateway approval/restart journey remained source work. The
following section records the subsequent bridge implementation. Neither establishes
installed LocalSystem/service-SID custody, ARM64 execution, real two-machine
behavior or live provider quality. Existing C5/C6 and channel acceptance gates
remain open. No operator credential, installed product, provider request, external
message, commit, push or deployment was used by this slice.

## Packaged native stdio bridge

The Node worker can now exchange bytes with the verified-bundle job owner through
`GoatCitadelRemoteWorkerStdio.exe`. The native image guard exposes a zero-argument
`pinStdioExecutor()` that checks its compiled image digest and retains the native
file pins. The package builder includes the helper, its transitive native source
inventory and digest; package verification refuses an inventory missing it even
when the manifest is rehashed.

Source owners are `apps/remote-worker-windows-cell-native/src/cell_stdio_main.cpp`,
`cell_stdio_protocol.cpp`, `apps/remote-worker/src/worker-windows-stdio-codec.ts`
and `worker-windows-stdio-executor.ts`. The bridge accepts trusted local launch
composition. A model or registry entry cannot select the helper, provision a
profile, approve a command or infer installed-service custody through this API.

- Configuration is copied and validated before asynchronous work, including exact
  image, directory and runtime-bundle identities, explicit environment and limits.
  The native owner independently verifies actual files and process authority.
- The bounded binary protocol separates stdout, stderr, input EOF and cancellation.
  The parent control pipe stays open after child input completes. Output buffering
  is bounded; protocol errors and overflow stop the owned process.
- Current authority is checked before launch and each input write. The overall
  deadline also bounds a stalled prelaunch check or helper. Cancellation first
  requests native cleanup, then terminates the exact helper if it does not respond.
  Successful completion requires the native isolation/cleanup receipt and exact
  submitted-input and observed-output counters.

Fresh local proof is recorded in these separate receipts:

- `.tmp/comparison-worker-stdio-bridge-native-r3.log`: named
  `pnpm verify:remote-worker:windows-stdio` passed **8 tests**, with evidence in
  `%TEMP%\Goat Worker Stdio naIB3P`. Cases cover a fresh
  output-dependent challenge, binary exchange with simultaneous stdout/stderr,
  bundle drift before entry, authority revocation and confirmed child exit,
  malformed/incomplete configuration, cancellation of a stalled authority check,
  and native image-guard refusal. Its prerequisite package typechecks passed.
- `.tmp/comparison-worker-stdio-bridge-worker-full.log`: **340 worker tests** in
  31 files passed. The focused codec run separately passed 17 tests.
- `.tmp/comparison-worker-stdio-bridge-package-tests-r2.log`: **27 package inventory
  tests** passed, including the missing-helper rejection.
- `.tmp/comparison-worker-stdio-bridge-build-r1.log`: the existing named native
  file-executor lane passed **9 tests**, including its normal and AddressSanitizer
  checks, while compiling the updated helper/guard build inventory.

The fresh unsigned portable candidate is retained at
`.tmp/comparison-worker-stdio-bridge-package-aacb6c014b994f7f9bc2c22ecea9d320/payload`.
Its manifest SHA-256 is
`9e61fcffa95a4d4f7d37a6879d6bc41e70701e2b5e3a4c40bbe0c7ef27fc84dd`, covering
**1,626 files / 103,251,670 bytes**. The package-specific stdio run uses that
candidate's Node executable, worker modules, native helper and guard. Inventory
verification occurs before imports and again after the run. All **8 tests** passed
in `.tmp/comparison-worker-stdio-bridge-package-stdio.log`; native receipts and the
verified inventory are retained in
`%TEMP%\Goat Worker Stdio mqjvI4/results.json`.

Separate package `--probe` verification passed in
`.tmp/comparison-worker-stdio-bridge-package-probe.log`, exercising startup,
filesystem read/write, HTTP MCP bearer authentication and changed-credential
refusal. Its five authenticated requests and one tool call used a controlled local
fixture; no real provider requests or external messages were sent.

The earlier bridge R1 failure remains in
`.tmp/comparison-worker-stdio-bridge-native-r1.log`: its setup fixture exposed
`setup.json` before closing the exclusive writer. The fixture now signals readiness
only after closing that file; R2 and R3 are separate fresh passing runs. Do not
combine these receipts into one passing run. The native job primitive's earlier
AddressSanitizer and controller-crash results do not establish AddressSanitizer
coverage of this new bridge or an abrupt Node-controller crash test.

At this stage, destination stdio MCP protocol/schema handling, registry integration,
protected workspace/process composition and the Gateway approval/restart journey
remained source work. The following section records the subsequent protocol owner.
Server launch can itself cause effects, so the invocation must be journaled before
launch and loss of completion must remain uncertain.
This bridge does not complete C5/C6 or prove installed service/credential custody,
ARM64, physical Windows-to-Windows execution or live model quality.

## Stdio MCP execution and loaded-image verification

The internal worker now has a stdio MCP execution owner in
`apps/remote-worker/src/worker-mcp-stdio-execution.ts` and a bounded transport in
`worker-mcp-stdio-transport.ts`. HTTP and stdio share their tool catalog,
initialization, discovery and result-schema handling through
`worker-mcp-tool-protocol.ts`. The transport follows the pinned MCP
[stdio framing](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
and [lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle).

- Launch configuration, tools and arguments are copied before asynchronous
  admission. The caller must persist its canonical executing record before the
  prelaunch hook resolves. Once launch is attempted, interruption, schema drift or
  protocol failure remains uncertain, including failure before the first tool call.
- The one-call exchange negotiates the pinned protocol, checks the published
  input/output schemas against fresh discovery, validates arguments/results and
  joins input EOF, output drain and native cleanup before returning success.
- Split UTF-8 lines, reply identity, cumulative bytes and message counts are
  bounded. Diagnostics never become tool output. Server ping is answered;
  unadvertised client methods such as sampling receive a method-unavailable reply.
  Catalog changes invalidate the exchange. There is no reconnect or replay.
- Authority checks and the prelaunch journal hook are deadline-bound. The same
  current authority continues to govern native input writes and shutdown.

Real Node execution exposed a native launch defect. The exact copied Node image
ran through its drive-letter path, but Windows returned error 87 when the
executable locator was a volume-GUID or GLOBALROOT path. Controlled `--version`
diagnostics are retained in `.tmp/comparison-worker-mcp-stdio-volume-diagnostic.json`
and `.tmp/comparison-worker-mcp-stdio-device-diagnostic-r2.json`.

`PinnedCellLaunchFiles` now retains the original image/ancestry handles and native
image name, while supplying a handle-derived DOS locator when one is available.
The job still creates the child suspended. It queries the actual process's native
image name and compares it with the pinned image before any resume, alongside the
existing AppContainer, low-integrity, capability and job checks. A mismatched image
is refused. The new `processImageVerified` receipt is required by the stdio bridge
and MCP success path. Directory identity and bundle verification retain their
volume-based paths. This is not permission to execute through an unchecked alias.

The controlled Node fixture also needed `--preserve-symlinks` and
`--preserve-symlinks-main` to avoid its loader traversing unrelated ancestor
directories. The runtime-bundle verifier still rejects symlinks/reparse aliases.
The setup fixture grants read access only to its explicit script/data files and
uses a bounded larger image allowance for the copied Node runtime. It does not
change host-root permissions or installed profiles.

Fresh evidence:

- `.tmp/comparison-worker-mcp-stdio-worker-full-r2.log`: **367 worker tests** in
  32 files passed. The separate focused HTTP/stdio run passed **65 tests**.
  Two tests use the real file-backed worker journal and canonical execution owner:
  the executing marker is read back before the process owner runs, and a fresh
  runtime instance never replays either a retained success or an uncertain launch.
  These use controlled transport/process doubles, not live Gateway acceptance.
- `.tmp/comparison-worker-mcp-stdio-native-r7.log`: named
  `pnpm verify:remote-worker:windows-stdio` passed **12 tests**, including real
  Node MCP success, schema drift, malformed output and a stalled server. Evidence
  is in `%TEMP%\Goat Worker Stdio D8LQNF`.
  Each MCP case retains its actual input/output trace in `case-N/mcp-exchange.json`.
  The positive case reads a fresh fixture file, answers ping, refuses sampling,
  calls the tool exactly once and confirms native image/cleanup proof. Negative
  cases prove their actual server branch and contain no tool-call request.
- `.tmp/comparison-worker-mcp-stdio-cell-job.log`: the named native job lane passed
  **543 checks in each normal and AddressSanitizer build**, including 53 filesystem
  checks. It rejects a different real process image and verifies the image before
  successful job execution. Both builds passed eight loopback checks, retaining
  the in-AppContainer timeout and successful native controls outside it. Separate
  static-input and interactive controller-crash tests confirmed child exit.
  Evidence is in `%TEMP%\Goat Worker Cell Job VDQVkG`.
  All 28 recorded source hashes still matched after the run.

The failed R1-R4 native receipts remain separate: they exposed the fixture image
limit, the Windows executable-locator failure and Node's ancestor lookup. R5 first
passed after the native launch fix and loader configuration. R6's stronger trace
assertion incorrectly required a diagnostic-pipe marker after malformed stdout
had already stopped the session; the retained malformed stdout itself proves that
server branch. R7 verifies the corrected evidence rule in a fresh run. These are
not combined into a synthetic passing run. Native job AddressSanitizer proof is
not AddressSanitizer coverage of the new Node protocol adapter or native bridge.

The fresh unsigned Windows x64 package is retained at
`.tmp/comparison-worker-mcp-stdio-package-98ede13fbb344d4b8937268bc3ecde64/payload`.
Its manifest SHA-256 is
`81e91146c3c3f2728a910f3e759d02e4ad34abcce2b4c90d4a09122a4670856b`, covering
**1,629 files / 103,268,308 bytes**. All **12 stdio tests** passed using that
package's own Node runtime, worker modules, helper and guard, with inventory
verification before imports and after the run. The log is
`.tmp/comparison-worker-mcp-stdio-package-native.log`; the verified inventory and
actual MCP traces are retained in
`%TEMP%\Goat Worker Stdio YRXhFV`.

Separate package `--probe` verification passed in
`.tmp/comparison-worker-mcp-stdio-package-probe.log`, covering startup, actual
filesystem read/write, HTTP MCP bearer handling and changed-credential refusal.
Its five authenticated requests and one MCP call used the controlled local HTTP
fixture. No real-provider request, external message, installed service, operator
credential, commit, push or deployment was used. Scoped lint, documentation checks
and `git diff --check` also passed.

This completes the internal stdio protocol/execution slice. Stock `mcp.stdio`
registration, protected workspace/process and credential composition, and the
Gateway approval/restart journey remain unfinished source work. Installed-service
custody, ARM64, a physical second Windows host, Telegram and live-provider quality
remain unproven. C5/C6 stay in progress.

## Reopening recorded native workspaces

`CellWorkspaceDirectories` can now return a complete, freshly verified identity
record and reopen those exact parent/root objects through retained NTFS handles.
The caller must retain the record independently with the canonical cell name and
frozen owner/controller SIDs. The record is object identity evidence, not admission,
execution permission, quota accounting or authority to reconcile uncertain work.

`OpenRecorded` verifies the parent, opens each root relative to held handles,
compares every recorded identity and checks metadata, ownership, protected DACLs
and integrity labels. It creates no directories and never repairs descriptors or
adopts whichever object currently occupies a name. A failed reopen releases its
handles and exposes no usable partial workspace. Failed record capture clears the
output; an occupied owner retains its existing workspace when a second open is
refused.

Fresh `pnpm verify:remote-worker:windows-cell-job` evidence is retained in
`.tmp/comparison-worker-workspace-reopen-native-51161b3ab6244f47a3cca691e48dcaf8.log`
and `%TEMP%\Goat Worker Cell Job K8XW5K`.
Both normal and AddressSanitizer builds passed **611 checks**, including **226
workspace checks** and 53 launch-filesystem checks. The 68 additional checks cover
close/reopen identity preservation, invalid records, changed parent/root identities,
substituted principals, permission/integrity drift, alternate streams, absent roots,
same-name replacements, ordinary-file substitutions and a junction retaining the
original file identity. Original and replacement marker files remain intact after
refusal. The existing installed-bundle child execution also runs from the reopened
workspace. Each build passed eight controlled loopback checks; separate static and
interactive controller-crash checks confirmed child exit. All 28 source hashes
matched a fresh check after validation. Live volume attachment was not exercised.

This completes the native recorded-root reopen primitive. Persistent service-owned
records and their approval/reconciliation lifecycle, protected workspace/process
and credential composition, stock stdio registration and the Gateway restart
journey remain source work. The earlier portable-package receipt predates this
change. Installed-service and physical two-machine acceptance remain unproven;
C5/C6 stay in progress.

## Protected workspace stdio execution

The native runtime job owner now accepts an explicit protected workspace reference:
the admitted parent path, independently recorded parent/root identities and frozen
owner/controller SIDs. It reopens those roots, checks that the requested runtime
and working-directory identities belong to the record, and retains all workspace
handles while the complete bundle owner launches, drains and joins the child.
Exact workspace security is verified again before dispatch and after execution.
A changed root is refused before launch; drift after startup changes completion
to a control failure even when the child exits successfully. No failed protected
admission falls back to the bundle-only path.

The Node launcher carries this record in the separate `GCSTDIO2` native envelope.
Missing or extra record bytes are refused rather than interpreted as the existing
internal `GCSTDIO1` bundle-only mode. The immutable TypeScript snapshot rejects
ambiguous identities, cross-volume records, mismatched runtime/work roots and
substituted principals. Native completion includes `protectedWorkspaceVerified`;
a protected launch cannot report success without that proof.

Fresh source verification:

- Worker package: **369 tests / 32 files** in
  `.tmp/comparison-worker-protected-stdio-worker-096145a9b8954079aef74f146bd0bcd7.log`.
  The separate focused codec/MCP run passed **46 tests** in
  `.tmp/comparison-worker-protected-stdio-unit-2cba2b9fa20d4e92827e577cfa87fe29.log`.
- `pnpm verify:remote-worker:windows-cell-job`: **625 checks in each normal and
  AddressSanitizer build**, including 239 workspace and 69 runtime-bundle checks,
  in `.tmp/comparison-worker-protected-stdio-cell-c303db24e716473bb32be285e848c630.log`.
  Evidence is retained in `%TEMP%\Goat Worker Cell Job tXqwnS`.
  The actual interactive child finishes its protocol while the fixture changes
  work-root permissions; the protected owner then refuses success and still
  verifies child cleanup and pipe drain. Both builds also passed the eight
  loopback checks and the lane's static/interactive controller-crash cases.
  All 28 source hashes matched after validation; live volume attachment was off.
- `pnpm verify:remote-worker:windows-stdio`: dependency typechecks and **14 tests**
  passed in `.tmp/comparison-worker-protected-stdio-native-0166266351e846259b466957546b8007.log`.
  The protected fixture installs copied Node/script/data bytes into freshly
  provisioned roots, records their identities and releases its provisioning pins
  before the bridge starts. Actual MCP execution reads the fresh note and retains
  native protected-workspace/image/cleanup proof in
  `%TEMP%\Goat Worker Stdio blwZId\case-5\mcp-exchange.json`.
  Substituted identities and protocol downgrade produce no child process.

The first native-lane attempt remains separately recorded in
`.tmp/comparison-worker-protected-stdio-cell-3f50dbafc7d34fd4b35e6c55584b4153.log`:
a shared test helper's changed declaration was missing at one caller, causing a
link failure. The fresh passing run above includes the corrected declaration.

The fresh unsigned Windows x64 candidate is retained at
`.tmp/comparison-worker-protected-stdio-package-c64683e7d2454898bbfd99c94f791914/payload`.
Its manifest SHA-256 is
`29ffed4added2e855338f85843fa3f5df271ff955e91b804478e145506a1b057`, covering
**1,629 files / 103,322,219 bytes**. All **14 stdio tests** passed with the
candidate's own Node runtime, worker modules, native helper and image guard, with
inventory verification before and after. The log is
`.tmp/comparison-worker-protected-stdio-package-native-158278ad4b714a6f9d30544dd68395dc.log`;
actual traces and verified package inventory are retained in
`%TEMP%\Goat Worker Stdio vxyED3`.
Separate package startup/filesystem/HTTP MCP probe verification passed in
`.tmp/comparison-worker-protected-stdio-package-probe-b9a942e061b24c598709bd0be605dfb7.log`.
All endpoints and copied data belonged to controlled local fixtures.

This completes the internal protected workspace-to-stdio execution composition.
It does not complete service-owned provisioning and durable recovery records,
profile/volume quota enforcement, credential composition, stock `mcp.stdio`
registration or the Gateway approval/restart journey. No installed service,
physical second Windows host, Telegram destination or real provider was used.
C5/C6 remain in progress.

## Durable native workspace records

The existing worker execution journal now retains a bounded private workspace
record, bound to the exact invocation, envelope and frozen launch. The owner must
persist and read back that record before native entry. Pending writes finish
before settlement; failed or conflicting retention cannot produce a successful
receipt. Interrupted execution retains its metadata and recovers as unknown,
without invoking the tool again. Records contain workspace identities, principals,
job identity and hashes, excluding command lines, environment values, tool inputs
and outputs. They remain local and are omitted from Gateway settlement and public
receipts. They do not authorize provisioning, execution or cleanup.

Journal v2 carries the record through pending settlement and the local receipt.
Legacy v1 files remain readable without mutation; the next normal write uses v2.
Malformed, cross-invocation or modified records are refused.

Fresh verification:

- Worker suite: **376 tests / 32 files** in
  `.tmp/comparison-worker-workspace-journal-worker-f3ef89f6a80445b8be0e9fe95f856bf8.log`.
  The separate focused runtime, MCP and codec run passed **95 tests** in
  `.tmp/comparison-worker-workspace-journal-unit-4104a1e9734a45d7ae5c222f5537491e.log`.
- `pnpm verify:remote-worker:windows-stdio`: dependency typechecks and **14 tests**
  passed in `.tmp/comparison-worker-workspace-journal-native-601be363a76144349636852fd6b5e80d.log`.
  The protected Node MCP case uses the actual worker runtime and file-backed journal,
  verifies persistence before native entry, then restarts with a fresh journal
  adapter and confirms one invocation with no replay. Evidence is retained in
  `%TEMP%\Goat Worker Stdio CpXOxL\case-5\mcp-exchange.json`.
  Gateway transport and settlement are controlled fixtures.
- The fresh unsigned Windows x64 candidate is
  `.tmp/comparison-worker-workspace-journal-package-2597ac8bb37946f585ef774cf1d93005/payload`.
  Manifest SHA-256
  `f4b87145e21969a337332d449d6c1babceb2ff3315e3c86077a6727f45d4da04`
  covers **1,630 files / 103,329,166 bytes**. All **14 stdio tests** passed using its
  own Node runtime, worker modules, helper and image guard, with inventory checks
  before and after. The log is
  `.tmp/comparison-worker-workspace-journal-package-native-2597ac8b.log`; actual
  traces and the protected journal case are retained in
  `%TEMP%\Goat Worker Stdio szyWBf`.
- Separate package inventory, startup, filesystem and authenticated HTTP MCP
  probes passed in `.tmp/comparison-worker-workspace-journal-package-probe-2597ac8b.log`.
  All endpoints, directories and copied data were controlled local fixtures.

This closes private workspace retention in the existing worker journal. Installed
service provisioning and recovery reconciliation, profile/volume quotas,
credential composition, stock `mcp.stdio` registration, the live Gateway approval
and recovery journey, and physical-worker acceptance remain unfinished. No native
C++ source changed in this increment; the preceding 625-check native result is
separate evidence. No real provider or Telegram destination was used. C5/C6 remain
in progress.

## Reopening recorded virtual disks

The internal native backing-file owner now captures `CellVirtualDiskRecord` after
fresh verification and reopens a recorded, unattached disk using its exact control
and backing NTFS identities, disk GUID and frozen capacity. The workspace must
still pass its own recorded-root/security checks. File pins prevent replacement
while the SDK opens the path. Missing files, substituted objects, invalid records,
different disk metadata and security drift are refused without creation or repair.
Failed record capture clears its output. A recovered owner cannot be reinitialized
as a new creator.

The SDK handle uses information-only/read-only parameters and excludes differencing
parents, following the [Windows parameter contract](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ns-virtdisk-open_virtual_disk_parameters).
The synchronous open still requires the eventual service watchdog; late return
cannot report timely recovery. Object verification is not data-content integrity,
workload liveness, attachment, capacity-release or cleanup authority.

Fresh `pnpm verify:remote-worker:windows-cell-job` proof passed **686 checks in each
normal and AddressSanitizer build**, including **108 virtual-disk checks**, 239
workspace checks, 69 runtime-bundle checks and 13 attachment-authority rejection
checks. Separate loopback and static/interactive controller-crash checks also
passed. The log is
`.tmp/comparison-worker-disk-recovery-process-7a151c92d83b4a529be8861a2fc9b683.log`.
Evidence is retained in
`%TEMP%\Goat Worker Cell Job mx5hnr`.
Both native receipts report `virtualDiskRecoveryProcessVerified: true`: after
closing the recorded disk and workspace handles, the fixture starts an exact
native child without inherited handles, supplies the independent fixture records
and checks successful reopening. This is a fresh-process primitive test, not a
service-journal recovery journey. Full backing-file hashes match before and after
the successful and refused operations. A copy with identical bytes and exact
controller permissions is rejected because its NTFS object identity differs.
All **28 source hashes** matched the tested sources after completion.

The first attempt remains in
`.tmp/comparison-worker-disk-recovery-native-565931a9652d4a849bbb63214eb18d90.log`.
Windows gave the copied replacement fixture inherited permissions, causing its
permission check to reject it before the intended identity assertion. The fixture
now explicitly applies and verifies the expected permissions on its own copy.
The subsequent 680-check run in
`.tmp/comparison-worker-disk-recovery-native-48b13745ee5148d687a6fe67d61e75db.log`
preceded the final fresh-process addition; it is separate evidence.

Live attachment was disabled. Permanently attached disk recovery, protected volume
formatting/mounting, quotas, service provisioning records, credential composition,
assignment/registry wiring and installed-service acceptance remain unfinished.
The disk primitive is not exposed by the portable worker package or its stock
registry; the prior package receipt covers its unchanged stdio implementation.
No provider, external channel, installed service or physical second host was used.
C5/C6 remain in progress.

## Recorded attachment recovery source

The internal `CellVirtualDiskAttachment::OpenRecorded` path now reopens an existing
attachment using the independently retained disk and workspace records. It checks
effective-token volume privilege, pins the recorded backing file before SDK open,
verifies the disk GUID/capacity/fixed subtype/loaded state, and rechecks the current
physical-device observation before reporting attached. It issues no attach or
detach operation. Every failed recovery remains unknown, exposes no detach handle
and refuses implicit reinitialization. Closing releases handles without detaching
the permanent image. Explicit detach still needs canonical zero-workload authority
and rechecks current privilege and exact held identity.

Unattached file inspection retains its information-only/read-only handle mode.
The privileged attachment owner uses the V2 control-handle mode shown in
[Microsoft's detach sample](https://github.com/microsoft/Windows-classic-samples/blob/main/Samples/Hyper-V/Storage/cpp/DetachVirtualDisk.cpp).
Neither record content nor that SDK handle supplies Gateway or service authority.
The complete service journal and assignment composition remain unfinished.

`pnpm verify:remote-worker:windows-cell-job` passed **697 checks in each normal and
AddressSanitizer build**, including **24 attachment/recovery-authority checks**
and the prior 108 backing-file checks. Actual cancellation, malformed-record,
unknown-state, workspace and effective-thread privilege refusal paths passed.
Fresh-process unattached recovery, the loopback checks and static/interactive
controller-crash checks also passed. The log is
`.tmp/comparison-worker-attached-disk-recovery-native-d67603fb856f4bdebc37ed9f3ec93015.log`;
native receipts and traces are retained in
`%TEMP%\Goat Worker Cell Job hkdpU4`.
All **28 source hashes** matched after verification.

Both receipts explicitly retain `volumeAttachmentExercised: false` and
`volumeAttachmentRecoveryVerified: false`. Running that exact compiled fixture's
`--volume-preflight` returned exit 1 because this session lacks
`SeManageVolumePrivilege`; evidence is in
`.tmp/comparison-worker-attached-disk-recovery-privilege-d67603fb.log`.
No virtual disk was attached or detached by this run.

The opt-in administrator command `pnpm verify:remote-worker:windows-cell-attachment`
now requires the positive recovery receipt as well. Its native fixture closes all
original disk handles, refuses a substituted backing record, recovers the exact
permanent attachment, checks privilege again before detach, reopens the resulting
unattached record, and refuses recovery of the detached image. That positive path
has source and compile coverage only; it must run on a Windows host with the
required existing privilege before acceptance can close.

Installed-service custody, protected volume formatting/mounting, quotas, canonical
provisioning/recovery, registry integration and physical-worker/provider/channel
acceptance remain open. The portable worker package does not yet expose this disk owner.
C5/C6 remain in progress.

## Portable native cell acceptance bundle

`pnpm package:remote-worker:windows-cell-acceptance` now builds a separate private
Windows x64 test bundle from staged source snapshots. It includes the independently
pinned Node 24.19.0 image, normal and AddressSanitizer controllers, the native child
fixture, all 28 C++ inputs, the existing test runner, and the sanitizer/Visual C++
runtime DLLs and notices. The exact manifest requires all 47 files and rejects
changed, missing, linked or additional files. Its expected SHA-256 is supplied
independently. The worker installer and destination registry are unchanged by this
acceptance packaging path.

The bundled entry point uses its own Node image, strips inherited Node hooks,
provider/configuration environment and attachment flags from its child, and stages
verified native copies in a fresh temporary directory. It runs the same native
suite without invoking a compiler. The default mode does not attach a volume.
`--preflight` only checks the current token; `--attachment` explicitly selects the
existing privileged attachment/recovery/detach suite. Neither mode elevates or
grants a Windows user right. Package inventory is checked before and after the
run, and the native receipts retain the supplied manifest and source hashes.

Fresh candidate:

- Payload: `.tmp/comparison-worker-cell-acceptance-6ce6d6cfe32141cb800e8de7b4f593fc/payload`.
- ZIP: `.tmp/comparison-worker-cell-acceptance-6ce6d6cfe32141cb800e8de7b4f593fc.zip`
  (37,824,278 bytes).
- ZIP SHA-256: `4cf70a8c991ca41c94d2c2bd48dee1448633e182812b1fad417b81e45ab5c451`.
- Manifest SHA-256: `658dc0edce99b572d31f600040190a709f1d53fca68c3eee45af5c8670b13017`.
- Exact payload: 47 files / 103,522,920 bytes, excluding the manifest itself.
- Operator instructions: candidate-directory `MINI-PC-ACCEPTANCE.md`; the bundle
  also includes `app/README.txt`.

The ZIP was extracted into a fresh directory and that extracted copy's own Node
entry point passed **697 checks in each normal and AddressSanitizer run**, including
108 virtual-disk checks, 24 attachment-authority refusal checks and fresh-process
unattached recovery. Actual loopback controls and both controller-crash cases
passed. The source check matched all **36 packaged C++/JavaScript input hashes**
against the checkout. Log:
`.tmp/comparison-worker-cell-acceptance-6ce6d6cf-native.log`; native receipts:
`%TEMP%\Goat Worker Cell Job d4IwAI`.

The same extracted entry point's `--preflight` returned exit 1 for absent
`SeManageVolumePrivilege`. Its retained log is
`.tmp/comparison-worker-cell-acceptance-6ce6d6cf-preflight.log`, with native evidence
in `%TEMP%\Goat Cell Preflight SA9iZx`.
Both native receipts retain `volumeAttachmentExercised: false` and
`volumeAttachmentRecoveryVerified: false`. This run attached or detached no disk.

All **33 packaging/inventory tests** passed with no skips; log:
`.tmp/comparison-cell-acceptance-unit-55df681c702348578c007b2d337d20ae.log`.
Scoped lint, documentation checks and diff whitespace checks passed. Build output
and PE dependency inspection are retained beside the candidate, outside its
manifest. This is an unsigned local acceptance candidate. Privileged attached
recovery, the mini PC, installed services, volume formatting/mounting and quotas,
canonical provisioning/registry composition and live provider/Telegram journeys
remain unverified or unfinished; C5/C6 remain in progress.

## GoatCitadel native scheduled delivery

The supervised read-only observer in
`scripts/verification/lib/agent-comparison-goat-delivery.mjs` now collects one
bounded, independently authorized Telegram reminder. It checks native permission
sources, the frozen job revision/configuration, a scheduled canonical occurrence,
the exact completed Chat child, its connector-delivery child and checkpoint, and
one acknowledged channel row. Manual runs, legacy-only telemetry, changed scope,
truncated evidence and duplicate or unacknowledged sends fail closed. Cancellation
also stops an outstanding reconnect callback. Final evidence remains ungraded
until the independent verifier runs.

The Gateway exposes the existing cron owner's bounded lookup at
`GET /api/v1/cron/runs/:runId`, with public-secret projection. Its optional
`canonical` field comes only from the retained occurrence repository; legacy
last-run summaries cannot supply canonical linkage. The supervised workflow
controller now honors its intermediate execution filename for delivery phases,
allowing complete native permission-source evidence to join the final receipt.

The CLI requires a real terminal and retains typed reconnect confirmation as an
operator statement. The separate full-Gateway conformance driver owns fresh
SQLite/configuration and synthetic model/Telegram transports; its restart closes
and reopens the runtime in the same supervisor process. Neither kind is proof of
a new operating-system process or a live Telegram reconnect.

Native testing found three runtime defects:

- `computeNextCronRunAt` preserved creation-time seconds and milliseconds. It now
  searches whole minutes, preserving the existing catch-up window and applying
  `endAt` to the aligned occurrence. Six new cases failed before the fix and pass
  afterward, covering fixed/wildcard minutes, hour steps, timezones and end times.
- New scheduled Chat creation looked up the missing session before reaching its
  creation transaction. The real session owner throws `NotFoundError`, unlike the
  former test mock. Lookup now runs only when existing scheduler metadata is being
  reused. A real SQLite regression creates and reuses one stable session/child;
  unavailable storage still fails without dispatch.
- Admitted agent runs were reconciled only at startup. The normal due sweep now
  observes their attached Chat/delivery children and settles completed or failed
  runs, including paused/expired jobs, without creating another occurrence.
  Child admission and inline execution remain outside cadence recovery. Real
  SQLite cases cover successful/failed settlement and replay, alongside existing
  concurrent inline/admission checks. Settlement has its own summary count.

Fresh local checks:

- **124 comparison tests**, no skips:
  `.tmp/comparison-delivery-final-tests-e3b6f46e1a054a44b63c3a3e71e00de7.log`.
  This includes the controlled observer's real 30-second observation and its
  duplicate, provenance, scope and cancellation refusals.
- **64 cron route/owner/SQLite settlement tests**, no skips:
  `.tmp/comparison-cron-cadence-tests-c43b4d449bc64ba097e82fca36122533.log`.
- **32 autonomous admission/capability-profile tests**, no skips:
  `.tmp/comparison-cron-session-tests-7b93c2f77eb24303ad70e02ba185a06b.log`.
- Gateway typecheck passed after the runtime fixes:
  `.tmp/comparison-cron-cadence-typecheck-33bb41bd1e41498294d62903a67d6a87.log`.
- The new route passed the async-boundary lane (10 tests / 984 production files):
  `.tmp/comparison-delivery-closeout-async-9977bc9c8f27461089cf8629896b2342.log`.
- `verify:runtime:truth` passed both scenarios, with no skips, including native
  process restart/approval resume and the canonical shell browser check:
  `artifacts/verification/2026-09-12T09-12-01-067Z-runtime-truth-71a7f7bd/manifest.json`.
- `verify:durable:recovery` passed all three scenarios, with no skips, including
  orphan/dead-letter recovery and worker/approval-wake tests:
  `artifacts/verification/2026-09-12T09-13-00-147Z-durable-recovery-aa6077e7/manifest.json`.

Separate retained diagnostics remain failed runs, not combined green acceptance:
`.tmp/comparison-goat-delivery-native-210994a3a76240b2a49ce5fef63b7b61`
exposed minute drift;
`.tmp/comparison-goat-delivery-native-c53ec0f60878452bbe6fe4826debf12e`
timed out during child admission; the instrumented diagnostic
`.tmp/comparison-goat-delivery-diagnostic-0f562594c4f14e06a97f5171dabf3803`
confirmed the missing-session error in the due sweep. The next fresh run,
`.tmp/comparison-goat-delivery-native-4805ff724c3949b59c76e3576cbe9847`,
created the child but exposed a controlled reasoning-profile mismatch and absent
cadence settlement. The fixture now declares the scheduled Chat's standard/medium
reasoning setting consistently.

The fresh run
`.tmp/comparison-goat-delivery-native-a33a59b458004a5fac684e1be85904fb`
completed its Chat child and exercised normal-cadence settlement with six
synthetic model calls, but **did not deliver a message**. It remains a failed
acceptance run. The observer initially hit the Gateway's encoded-colon path
guard; native delivery ids use a literal colon. Its validated resource-id encoding
now preserves that character, with a colon-bearing fixture in the observer tests.
The Gateway path guard is unchanged.

That run's channel row ended in `manual_reconciliation_required` with one attempt
and no provider message id; the controlled Telegram transport recorded zero
acknowledgements. It remains a failed run.

Subsequent source work addressed the observed boundaries:

- `comms-service.ts` removes absent optional object fields, including normalized
  attachment fields, before policy admission. Present values remain intact. The
  policy engine's exact argument-identity guard is unchanged.
- `CommsDeliveryRepository.getById` reads the exact persisted delivery, including
  records outside the recent inventory. Cron now validates connector checkpoint,
  connection, channel, target and parent/session lineage against that record. A
  queued record remains waiting; failures and ambiguous outcomes cannot become
  success merely because the connector finished queue admission.
- `channel-delivery-helpers.ts` requires explicit provider send success. Empty,
  queued and contradictory transport results cannot produce a sent record. A
  partially sent multi-part message preserves its earlier acknowledgement and
  requires reconciliation. Providers without message ids can still acknowledge
  success through their explicit sent result.
- The earlier literal-colon encoding workaround did not fix the real Gateway:
  the path guard also rejected decoded colons as NTFS stream syntax. Its defined
  durable-run route parameters now accept bounded opaque database keys, including
  native connector ids. Other routes, encoded separators, traversal, NUL and
  reserved device names retain their checks. The observer uses standard URL
  encoding and checks the immutable queue-admission checkpoint against the
  eventual channel acknowledgement; it does not rewrite checkpoint evidence.
- The controlled driver reviews the exact schedule payload, then the native
  channel approval's destination, message, connector effect identity, parent,
  workspace/session, and current approval-wait owner before resolving it once.

Fresh verification after these changes:

- **85 Gateway cron/comms/route tests**, no skips:
  `.tmp/comparison-delivery-owner-tests-fc6f2780ab9046e6b214e948449e882b.log`.
- **64 channel transport/runtime/approval tests**, no skips:
  `.tmp/comparison-delivery-ack-tests-6b1ef189b5c84252b31089afa69abf86.log`.
- **10 SQLite delivery tests**, no skips, including lookup outside 200 newer rows:
  `.tmp/comparison-delivery-storage-green-b911378ede354253a6ae00cce680485d.log`.
- **One real PostgreSQL delivery test**, no skips, using a fresh owned instance
  which was stopped afterward:
  `.tmp/comparison-delivery-postgres-c369877992f84e6d879e9d2d0791b9ac.mjs.log`.
- **9 approval-creation guard tests**, no skips:
  `.tmp/comparison-delivery-policy-guard-33740637181a4ad5a385794d905d04b6.log`.
- **8 path-guard tests** passed. **127 comparison tests** passed with no skips:
  `.tmp/comparison-delivery-observer-tests-03c1efc547ad4595a436bc56aed1d1db.log`.
- Gateway typecheck passed:
  `.tmp/comparison-delivery-final-typecheck-45729b50cd654ffa8fb1143921520f7f.log`.
- `verify:runtime:truth` passed both scenarios with no skips, including a new
  Gateway process and canonical shell browser proof:
  `artifacts/verification/2026-09-12T09-49-59-209Z-runtime-truth-7e1f5cbe/manifest.json`.
- `verify:durable:recovery` passed all three scenarios with no skips:
  `artifacts/verification/2026-09-12T09-52-08-467Z-durable-recovery-20c1e2a8/manifest.json`.
  Scoped lint, documentation checks and diff whitespace checks also passed.

The failed native run
`.tmp/comparison-goat-delivery-native-49c9c4446ff54365847d0787f76b313a`
proved channel approval creation after the argument fix and exposed the decoded
colon path-guard issue. The next fresh run,
`.tmp/comparison-goat-delivery-native-2e6cd154a77a4d31b25e490672e8ff8b`,
read the exact native owners, approved the channel action and recorded **one
simulated Telegram acknowledgement** (`7300`) with six synthetic model calls.
It still failed canonical settlement and remains failed acceptance.

Its queued delivery `9b9a3eb0-5423-4d1f-9848-63503e8af906` stayed
`failed/blocked` after the original request entered approval. Executing the
approved action created a second provider delivery
`bc6f51d5-ab57-4b01-b997-12faf3aaf4af`, marked sent with that acknowledgement.
The pending approval's retained result contains the second id; the cron connector
checkpoint contains the first. This exposed the missing canonical handoff between
queue, approval and provider attempt. Cron needed to wait through approval and
reconcile the exact approved outcome without
guessing from recent messages, retrying an already-sent message, or accepting a
different delivery merely because its destination/text match.

All these runs used synthetic transports and sent zero real model or Telegram
requests. Full native delivery, equivalent cross-product schedule campaigns and
live acceptance remain open. These are local implementation gaps, separate from
the pending operator inputs below.

### Queued approval handoff and reconnect proof

The approved queue handoff is implemented in
`channel-delivery-part-service.ts`, `channel-delivery-runtime-service.ts`, the
policy engine's approval creation and comms executor, and the paired storage
`channel_delivery_parts` migration (SQLite 220 / PostgreSQL 165).
Each part retains its queue attempt, payload/request hashes, approval ID and
provider receipt ID. Approval registration and provider-receipt linking commit
before dispatch. Existing policy and approval checks remain authoritative;
removing the server-owned tool identity cannot reuse a part's approval, and
changed reviewed payloads cannot authorize the old message.

Approval polling keeps the same attempt. Restart reuses acknowledged parts and
their provider IDs, including reply threading for split messages. Rejection,
expiry, lost ownership and unknown provider outcomes preserve their distinct
failure boundaries. Provider attempt records remain readable by exact ID and
are excluded from the logical delivery queue. The operator UI names the approval
wait, and cold delivery reads preserve diagnostics from the persisted payload.

The earlier controlled run
`.tmp/comparison-goat-delivery-native-4b1c8c8f1bdc44319ab3328d4fc0161f`
settled the original queue successfully but failed reconnect because the API
dropped its persisted diagnostics. That failed run remains failed evidence.
The fresh run after the diagnostic fix passed:

`.tmp/comparison-goat-delivery-native-bb791e89f23749d891aa7abfbec87202/result.json`

- **4/4 independent scheduled-delivery checks passed.**
- **6 synthetic model calls, one simulated Telegram acknowledgement, zero
  upstream model requests and zero external channel requests.**
- Schedule `comparison-reminder-1cb3fc89`, occurrence
  `7dc3d6c0-c2c9-4524-b9fb-7455a1764b7a` and original queue
  `b3ca1229-5a4d-4fe9-aad9-e160500f4866` retain their canonical linkage.
- The part journal links approval `3aad9f0f-c466-4dd7-9df1-e41fc7f10add` to provider
  delivery `dbb35e25-592f-42f5-977d-119de2ada848`. Both queue and provider receipt
  are sent with acknowledgement `7300`, on queue attempt 1.
- The task-owned Gateway was closed and reopened over the same SQLite/config
  state; its supervisor process remained alive. The observer checked unchanged
  delivery evidence and no duplicates for at least 30 seconds. This specific
  receipt proves a runtime reopen, not a new operating-system process.

Fresh local verification, kept as separate runs:

- **76 Gateway tests** covering the real queue/policy/repository handoff, split
  messages, in-flight provider acknowledgement, restart, rejection, expiry,
  identity stripping, cron settlement and existing transport behavior:
  `.tmp/comparison-channel-handoff-tests-feaf9cd8afe64b42affe1a885862f94f.log`.
- **90 Gateway facade/route tests**:
  `.tmp/comparison-channel-handoff-facades-588f24cde1664cfcb8d4905aae52ae15.log`.
  The existing synthetic chunk tests now call their helper owner; the new handoff
  tests use real repositories and the canonical approved-action entrypoint.
- **133 policy tests**:
  `.tmp/comparison-channel-handoff-policy-b03f6d251a6a4d54a48bc643672954ea.log`.
- **20 SQLite delivery tests**:
  `.tmp/comparison-channel-handoff-storage-b2103cf566244295a7f0b836066bb4d0.log`.
  Earlier **69 storage/migration integrity tests** passed separately in
  `.tmp/comparison-channel-handoff-storage-2a4621524d63474da7936cc6f40d6909.log`.
- **3 actual PostgreSQL tests**, including both a new table and a bootstrap-created
  table, with the owned test server stopped afterward:
  `.tmp/comparison-channel-handoff-postgres-4b4f0279830b44afbcd6814722ad88cb.log`.
- **27 migration-manifest tests** and parity through SQLite 220 / PostgreSQL 165:
  `.tmp/comparison-channel-handoff-migrations-897ef600e36940d6ba6cbac8acc31205.log`.
- **127 comparison tests**:
  `.tmp/comparison-channel-handoff-comparison-169f7c80d1434fd6a2840b563ce13c8e.log`.
- **2 operator-visibility component tests** passed. Gateway dependency typecheck
  and scoped lint passed.
- **Runtime truth 2/2**, including a new Gateway process (PID 53736 to 47184),
  four controlled resumed provider dispatches and canonical shell browser proof:
  `artifacts/verification/2026-09-12T10-43-01-673Z-runtime-truth-a60c95a6/manifest.json`.
- **Durable recovery 3/3**:
  `artifacts/verification/2026-09-12T10-45-13-941Z-durable-recovery-a3014e8f/manifest.json`.

This closes the controlled GoatCitadel queue/approval/reconnect defect. C6 still
requires equivalent cross-product channel campaigns, clean-pinned GoatCitadel
campaign proof, reviewed equivalent policies and live provider/channel acceptance.
C5 service/volume integration and physical mini-PC acceptance remain unfinished.

## OpenClaw native scheduled delivery

The new `agent-comparison-openclaw-delivery-conformance.mjs` command runs the clean
pinned OpenClaw checkout through its public Gateway SDK, native `automations`
tool, scheduler and Telegram channel adapter. All model and Telegram traffic for
this run uses owned loopback simulators and synthetic credentials. The fixture
retains the effective configuration and disabled native startup-job inventory,
then creates exactly one reviewed one-shot reminder through the native agent.

`agent-comparison-openclaw-delivery.mjs` observes native cron APIs and opens the
existing SQLite database read-only. At simulated provider acknowledgement, one
read transaction captures the pending outbound queue, active cron task and
scheduler run receipt. This proves the exact native occurrence and send custody;
the public run history has no run ID, and the scheduler and inner delivery have
different start timestamps. The observer also requires the original send lease,
prepared message/account/target, completed queue, one wire receipt, unchanged
schedule and no retries or competing message-tool send. The native
`fallbackUsed` flag denotes the normal direct announcement path here; it is not
evidence of switching models or providers.

The fresh acceptance result is:

`.tmp/openclaw-delivery-native-9ebf4a08b6474a9c90229c07dc1c4f8c/result.json`

- **4/4 independent scheduled-delivery checks passed**, with controlled provenance.
- **3 synthetic model calls, one simulated Telegram acknowledgement (`8300`),
  zero upstream model requests and zero external channel requests.**
- Native schedule `44c76ced-fe2a-487e-b1c0-cd3aeb738a33` retains the same completed
  run and outbound queue across restart. The coordinator stopped its owned
  Gateway tree (PID 36592) and started PID 17940 over the same state/configuration.
- After reconnect, all four native inventories stayed unchanged from
  `2026-09-12T11:32:22.289Z` through `2026-09-12T11:32:52.432Z` (30.143 seconds).
  Both owned process trees have confirmed terminal cleanup; the command exited 0.
- The upstream checkout remained clean at
  `309ae03db2d45312d877e766f8f60731ad5971b7`.
- **147/147 local comparison tests passed**, including dispatch custody,
  wrong occurrence/target, duplicates, manual runs, readonly storage bounds,
  cancellation and restart identity:
  `.tmp/comparison-openclaw-delivery-final-tests.log`. Scoped lint passed.

Earlier startup and schema diagnostics remain separate failed runs. In
particular, `3fdfbfd817e44ff2b7da4aa35a80d993` and
`48e0c388bd184950a9de3e2db6236f9c` under `.tmp/openclaw-delivery-native-*`
each sent once to the simulator but failed the observer before restart
acceptance. The former exposed missing public run identity and different queue
timestamps; the latter established the native first-send bookkeeping and lease.
Rechecking retained data after a checker fix did not turn either into a passing
native campaign. The fresh run above is the passing receipt.

The observer accepts controlled evidence only. OpenClaw authorizes the declared
destination at schedule creation, whereas the GoatCitadel receipt exercises an
approval at send time. These runs do not establish equivalent policies or live
delivery. The subsequent Hermes slice below closes its controlled scheduled
delivery journey. Clean-pinned GoatCitadel campaign proof, reviewed equivalent
policies and repeated real-provider/channel acceptance remain open.
C5 service/volume integration and physical mini-PC acceptance remain
unfinished. No service installation, commit, push or deployment occurred.

## Hermes native scheduled delivery

`agent-comparison-hermes-delivery-conformance.mjs` now exercises the clean pinned
Hermes CLI, foreground Gateway, scheduler and Telegram adapter against owned
loopback model and channel simulators. Native `tool_search`, `tool_describe` and
`tool_call` create the one-shot schedule. The separate Chat-title request also
uses the combined request/cost ledger. The scheduled agent uses the declared
model with no tools; the stopped-runtime transcript verifies its one final
response and `cron_complete` outcome.

`agent-comparison-hermes-delivery.mjs` reads existing native stores without
importing repair or migration owners. It captures the active fire claim and
execution before the simulator acknowledges the send, then requires the exact
execution ID, scheduled instant, process ID and process birth time in the
completed record. It rejects manual runs, altered schedules, wrong recipients,
duplicate acknowledgements, uncertain outcomes and detached-worker queue
substitution. The current in-process native send path has no queue row; the
checker does not invent one.

Read-only SQLite connections wait briefly for native writers and retry the whole
snapshot a bounded number of times. Corrupt or incomplete stores still fail.
Windows readiness also verifies process ancestry because a virtual-environment
Python launcher has a different PID from the interpreter running the Gateway.
Configuration and code revision remain pinned across the owned process restart.

Fresh acceptance:

`.tmp/hermes-delivery-native-18610c9e8cc9481f8eae2a2a6500c4dd/result.json`

- **4/4 independent scheduled-delivery checks passed**, with controlled provenance.
- **6 synthetic model calls, one simulated Telegram acknowledgement (`9300`),
  zero upstream model requests and zero external channel requests.**
- Schedule `11502bf49ddd` and execution `e4f2b86d36c74936ac11b3f2e2f0819e`
  retain their native identities. The original native Gateway PID 62936 was
  replaced by PID 51824 over the same state and configuration.
- After reconnect, unchanged delivery evidence and no duplicates were observed
  from `2026-09-12T12:04:56.361Z` through `2026-09-12T12:05:27.433Z`
  (**31.072 seconds**). The 84 retained observations cover waiting, delivery and
  reconnect; the reconnect phase bundle is 339,336 bytes.
- All five owned process trees have confirmed terminal cleanup, and the command
  exited 0. The upstream checkout remained clean at
  `bf53ff00a7360826ec2c9e2949533160068a8fc8`.
- **174/174 comparison tests passed**:
  `.tmp/comparison-hermes-delivery-final-tests.log`. The 27 Hermes delivery tests
  include actual SQLite writer contention, readonly storage integrity and the
  identity/destination/duplicate negative cases. Scoped lint passed.

The isolated Python environment received the exact `python-telegram-bot` 22.8 and
Tornado 6.5.7 wheels from the pinned upstream lockfile, with their hashes checked.
No GoatCitadel dependency manifest changed. Dependency setup evidence is retained
in `.tmp/comparison-hermes-telegram-dependencies.log`.

Earlier diagnostics remain separate. The initial runs exposed the Windows
launcher PID difference, deferred native tool discovery and the auxiliary title
request. The preliminary
`.tmp/hermes-delivery-native-d70f0a77f05d4d96b07394cce20521e5/native-proof.json`
completed the native journey but was ungraded. The subsequent
`27ca01c5903049b99b50f8fbb6f9773a` run failed on a native SQLite writer collision.
The fresh result above includes the contention fix and shared verifier; those
earlier runs are not combined into its passing result.

All three runtimes now have controlled skill and scheduled-delivery receipts.
These prove the exercised local native paths. They do not prove equivalent
permissions, repeated model quality, real Telegram delivery or performance
comparability. Clean-pinned GoatCitadel campaign proof, reviewed equivalent
policies and live-provider/channel acceptance remain C6 gates. C5 service/volume
integration, broader worker integration and physical mini-PC acceptance remain
unfinished. No service was installed and no changes were committed, pushed or
deployed.

## Protected native provisioning journal

The internal `CellProvisioningJournal` now coordinates the existing protected
workspace and fixed-VHDX owners. A five-record journal retains the frozen
assignment binding, profile hash, disk identity/capacity, parent/journal NTFS
identities, canonical cell name and owner/controller SIDs. It flushes prepared
intent before either resource operation and records each independently verified
result afterward. Disk validation and controller-file descriptor conversion use
shared owners so the journal cannot silently accept a different disk policy.

The file is created exclusively relative to the pinned protected parent using
[the Windows native file API](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile).
Each phase uses write-through I/O and
[an explicit buffer flush](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).
The owner checks exact security, single-link ordinary-file metadata, absence of
alternate streams, at most 5,120 logical bytes and at most 64 KiB allocated bytes.
The allocation ceiling is a post-operation check, not an OS quota or a guarantee
about transient allocation. Partial files remain for canonical accounting.

`Create` returns a journal identity and prepared-record hash that the canonical
service must retain independently before authorizing provisioning. Recovery
requires that reference and the original frozen plan. It reopens only recorded
objects, verifies the complete bounded hash chain and rechecks workspace/disk
identity and security. A started operation without its completion record returns
`ERROR_IO_INCOMPLETE`; existing names never substitute for recorded completion.
Missing, replaced, overallocated or corrupted journals are not recreated or
repaired. Recovery cannot resume creation, including from a valid earlier prefix.
Canonical checkpoints must still detect rollback of a previously observed later
phase; the local hash chain is not independent anti-rollback authority.

Fresh `pnpm verify:remote-worker:windows-cell-job` proof passed **941 checks in
each normal and AddressSanitizer build**, including **244 provisioning-journal
checks**. Both receipts report `provisioningRecoveryProcessVerified: true`:
after closing the original owner, a new native process reads the real journal and
verifies its recorded workspace and backing disk. Only the independent plan and
journal reference are passed to that process. Complete journal and disk bytes
remain unchanged. Actual workspace/disk creation conflicts retain started intent
and preserve the conflicting marker bytes. Corruption, missing/replaced journals,
alternate streams, hard links, permission drift and live allocation drift are
refused. The allocation test uses the held native file handle because NTFS trims
spare allocation when the writer closes; rejection leaves its bytes and measured
allocation intact until the fixture explicitly restores them.

The final log is `.tmp/comparison-worker-provisioning-journal-verified.log`.
Native receipts, compile logs and source hashes are retained in
`%TEMP%\Goat Worker Cell Job UCbnPF`.
All **31 source hashes** matched a fresh post-run check. Each build also passed
eight controlled loopback checks; separate static and interactive controller-crash
receipts confirm owned child exit. These controller-crash cases remain distinct
from the journal's fresh-process recovery and creation-conflict cases.
All six acceptance-package inventory tests and scoped ESLint passed.

Earlier diagnostics remain separate: the first attempt had a C++ fixture type
error; the second held another workspace's parent pins during alias setup.
The 925-check run preceded the missing-file and shared-validation changes.
The next attempt exposed a substituted test file ID that accidentally equaled
the actual parent ID. The 931-check run preceded the allocation guard. The first
allocation fixture lost spare allocation on writer close. None of those runs is
combined with the fresh final result above. Both final native receipts retain
`volumeAttachmentExercised: false` and `volumeAttachmentRecoveryVerified: false`.

This is native source and process-recovery work, not installed-service proof.
The service still needs to bind and retain the journal reference through its
current assignment/profile/lease and capacity owners, reconcile uncertain state,
and compose protected volume, credential and runtime-bundle custody. No attachment,
format, mount, workload launch, cleanup, backend activation or service installation
is authorized by this journal. The earlier portable acceptance bundle predates it.
C5 and the complete implementation plan remain in progress.

## Canonical provisioning lease authority

`RemoteWorkerCellRepository` now takes provisioning time from the current database
clock. A caller's observed `now` remains a validated compatibility input and cannot
expire another controller's live lease or backdate a publication. Initial claims
must expire in the future. Reclaims compare the previous owner and exact lease and
recheck database expiry at the SQL mutation.

`persistPlatformIdentity` requires the exact `provisioningLeaseExpiresAt` returned
by the winning claim. It checks that binding, owner and current database time both
before and during the transition to `ready`. Reusing a controller name after a
restart does not authorize publication under its previous lease. Rejected writes
leave canonical state and execution evidence unchanged. No schema migration or
backend activation is part of this change.

The focused SQLite file passed **12/12 tests** and the actual PostgreSQL file
passed **3/3 tests with no skips**. Both execute the same regression against real
database time, including actual expiry, same-name reclaim and delaying the final
SQL publication until its previously valid lease expires inside the open
transaction. The existing independent-connection claim race retains one winner.
Evidence is retained in `.tmp/comparison-cell-lease-sqlite-verified.log` and
`.tmp/comparison-cell-lease-postgres-verified.log`. The isolated PostgreSQL
cluster is stopped by its owning harness after the run; its data and server log
are retained at the path printed in that receipt.

Locked storage typecheck and scoped ESLint passed. The earlier typecheck diagnostic
is retained separately in `.tmp/comparison-cell-lease-typecheck.log`; the final
`.tmp/comparison-cell-lease-typecheck-verified.log` verifies the explicit type guard
for a missing or non-string database clock. These checks prove repository lease
authority. The journal still needs canonical checkpoint persistence and service,
volume, credential and assignment integration before installed-worker acceptance.

## Canonical provisioning checkpoint coordination

SQLite **221** and PostgreSQL **166** add `remote_worker_cell_provisioning` and
`remote_worker_cell_provisioning_checkpoints`. The plan is committed before native
creation and freezes the cell profile, worker/assignment generation, winning claim,
parent identity, principals, cell name and reserved disk specification. Capacity
checks include the journal's 64 KiB reservation. Both databases retain the plan and
checkpoints with immutable/delete-refusing guards, exact ordering and lease checks
at insertion. The PostgreSQL migration integrity is
`dca75ec70136e4d34d9da116d4339db40386ce2ef901c405faf60909d653b121`.
The manifest update appends these migrations without rewriting earlier entries.

The shared contract checks the native 1,024-byte record format, hashes, zero padding,
phase-specific identities, same-volume/unique-object rules, bounded disk capacity,
canonical principals and frozen plan/chain continuity. It retains private native
metadata without paths, credentials or workload contents. These metadata checks
are distinct from native verification of actual Windows objects.

`RemoteWorkerCellProvisioningService` uses current assignment authority and the
repository owner. It acknowledges a serial native checkpoint only after its exact
record commits. Missing acknowledgements stop progress. A repeated plan invokes
recovery rather than creation; missing anchors, valid earlier prefixes and native
records ahead of canonical storage require reconciliation. The coordinator retains
independent immutable snapshots around asynchronous recovery checks. It does not
mark a platform ready or launch a workload.

The native journal now requires an explicit committer. Each flushed record must
receive its exact digest before the next operation. Refusal at each of the five
phases, and an incorrect acknowledgement digest, preserve the local journal and
prevent later creation. Failed completion acknowledgements retain the already
created resources for reconciliation. Verified checkpoint export and a new native
recovery process preserve the same recorded history.

Fresh evidence:

- Native normal and AddressSanitizer builds each pass **998 checks**, including
  **301 journal checks**. The final log is
  `.tmp/comparison-cell-checkpoints-native-required-ack.log`; native receipts and
  compile logs are in `%TEMP%\Goat Worker Cell Job 1didAC`.
  All **31 source hashes** still match, and both compile logs have no C warnings or
  errors. Both receipts retain `volumeAttachmentExercised: false` and
  `volumeAttachmentRecoveryVerified: false`.
- The actual five records from each build pass the shared TypeScript decoder and
  successor checks. `.tmp/comparison-cell-checkpoints-native-contract-proof.json`
  retains that separate cross-language result.
- SQLite cell and migration-versioning tests pass **40/40**, including **13 cell
  repository tests**, in `.tmp/comparison-cell-checkpoints-sqlite-final.log`.
  Actual PostgreSQL passes **3/3 with no skips** in
  `.tmp/comparison-cell-checkpoints-postgres-second.log`; the owned cluster was
  stopped and its evidence retained at the logged path.
- Contract tests pass **15/15**, coordinator/capacity service tests **13/13**, and
  acceptance inventory tests **6/6**. Their logs are
  `.tmp/comparison-cell-checkpoints-contract-tests-final.log`,
  `.tmp/comparison-cell-checkpoints-gateway-tests.log`, and
  `.tmp/comparison-cell-checkpoints-package-tests.log`.
- Locked Gateway typecheck, scoped ESLint and the named migration parity lane pass.
  `.tmp/comparison-cell-checkpoints-migration-parity-final.log` contains the fresh
  **27 manifest checks**, **24 integrity tests** and **45 runtime-schema tests**.
- The separate `verify:runtime:truth` lane passes **2/2 with no skips**, including
  approval recovery across a Gateway restart and the canonical browser projection.
  Its manifest is
  `artifacts/verification/2026-09-12T13-36-03-744Z-runtime-truth-c2150613/manifest.json`.
  It uses the deterministic provider fixture and does not exercise native cell
  provisioning. Documentation checks and `git diff --check` also pass.

Earlier diagnostics remain separate: the first SQLite fixture bound unused SQL
parameters; the first PostgreSQL receipt caught a missing migration-hash prefix.
The first native compile rejected a signed/unsigned test comparison. The first
parity attempts retained old migration-head literals, then found an unchecked
Buffer index in the new contract test. The final receipts above include their
corrections and are not assembled from those earlier failures.

These are separate component proofs. Coordinator tests use real repositories and
a controlled native port; native tests use a controlled acknowledgement sink.
The installed process bridge has not yet connected those owners in one live flow.
Protected volume setup, quota enforcement, credential custody, assignment/registry
composition, installed service proof and physical mini-PC acceptance remain open.
The older portable bundle predates these changes. The native backend remains
unavailable until its complete prerequisites and acceptance gates are satisfied.

## Native provisioning process bridge

The private `GoatCitadelRemoteWorkerCellProvisioning.exe` now drives the existing
protected journal, workspace and fixed VHDX owners through bounded binary pipes.
It flushes each exact record and waits for its matching sequence/digest
acknowledgement before the next operation. Both initial configuration and the full
operation have a native watchdog. A lost parent or stalled acknowledgement cannot
leave that helper waiting indefinitely. Interrupted resources remain retained;
the helper never retries creation, resumes a recovered journal, or deletes evidence.

`createWindowsWorkerCellProvisioning` connects that process to the Gateway
coordinator's private port. It freezes the plan, bounds protocol input/output,
checks the complete record chain and terminal receipt, and retains an image lease
until its exact child closes. Cancellation and failed canonical commits withhold
acknowledgement and join that child. Recovery receives only the frozen plan and
independently committed first record; the coordinator retains and compares its
complete canonical history separately. No storage package dependency is added to
the worker.

The installed image guard now compiles the provisioning executable's exact digest.
The package builder copies that image, and package inventory verification requires
it. Missing or modified images are refused. These source changes do not establish
that an installed service has been upgraded or that an older portable bundle
contains the new helper.

Fresh evidence:

- `pnpm verify:remote-worker:windows-cell-provisioning` passes **5/5 with no skips**
  in `.tmp/comparison-cell-bridge-proof-first.log`. Its retained directory is
  `%TEMP%\Goat Worker Provisioning Bridge 0TSRJc`.
- Within that lane, the Gateway service file passes **16/16 with no skips**.
  Three cases use actual protected Windows parents, the real compiled image guard,
  the real native helper and canonical SQLite repositories. Five committed records
  match the native journal exactly, and a new helper verifies the same history.
  A failed third commit retains two canonical records and three native records;
  replay reports their mismatch without creating the disk. Cancellation after the
  first commit retains one record and creates no workspace. The JSON receipts and
  `gateway-tests.json` retain these outcomes. Assignment/admission state is seeded
  and assignment authority is controlled; SQLite stays in the test process. This
  is not a stock Gateway service or database-restart acceptance run.
- The separate normal and AddressSanitizer helper checks reject truncated input,
  incorrect acknowledgement sequences/digests, and a stalled parent. Their six
  refusal/recovery receipts in `native-protocol.json` preserve the first record,
  create no workspace, and verify the unchanged journal in new processes. The
  stalled helpers end through their own watchdog, below the outer harness limit.
  AddressSanitizer checks invoke the helper directly; the compiled image guard and
  coordinator flow above use the normal build.
- Package inventory tests pass **28/28 with no skips** in
  `.tmp/comparison-cell-bridge-package-tests.log`. Locked Gateway/worker typecheck
  and scoped ESLint pass; their logs are `.tmp/comparison-cell-bridge-typecheck.log`
  and `.tmp/comparison-cell-bridge-lint.log`. The named lane repeats the locked
  typecheck after the final source edits.
- The existing real TLS/image-guard regression passes **23/23 with no skips**,
  including canonical Gateway admission/reconnect, in
  `.tmp/comparison-cell-bridge-tls-regression.log`. Its evidence is retained at
  `.tmp/native-tls-acceptance-2H0MPg`. All **29 native source hashes** from the bridge
  build still match. Documentation checks and `git diff --check` pass.

This closes the local coordinator/native process connection. It does not attach,
format or mount a volume, enforce its quotas, provision credentials, launch a
workload, establish installed service custody, activate the native backend, or
prove assignment/registry composition and physical mini-PC operation. Those C5
items and the remaining C6 comparative/live acceptance work stay open.

## Installer inventory parity and current worker package

The PowerShell `Get-WorkerPackage` reader omitted the file, stdio and provisioning
executables from its required component set. A newly hashed package omitting those
files could pass that reader while the JavaScript verifier refused it. The first
behavior regression reproduces the defect in
`.tmp/comparison-cell-installed-helper-regression-before.log`. The installer now
requires all three images. Its test creates independent complete and missing-image
packages and checks both readers, including every native worker image.

Fresh `pnpm verify:remote-worker:windows-service-install` passes **31/31 with no
skips** in `.tmp/comparison-cell-installer-named-lane.log`. The installer portion
passes **51 behavior checks** in each of Windows PowerShell 5.1.26100.9343 and
PowerShell 7.6.5, plus **50 native configuration checks** in each normal and
AddressSanitizer build for each engine. The final named-lane receipt is retained at
`%TEMP%\Goat Worker Install BI0KRl`; the earlier focused
corrected run is separate at `%TEMP%\Goat Worker Install VVbbS7`.
Both exercise preflight and file fixtures without changing SCM state. Scoped script
lint passes in `.tmp/comparison-cell-installer-lint-final.log`.

`pnpm package:remote-worker:windows` produced a fresh **unsigned Windows x64
candidate**, with Node 24.19.0 / OpenSSL 3.5.7 at the reviewed native image pin.
Its output root is
`.tmp/comparison-cell-bridge-current-package-ed2cd1c2b0524e10a3bebfff81db8207`:

- `GoatCitadelWorker-windows-x64-candidate.zip`: **38,957,108 bytes**, SHA-256
  `b9213596e0db86605ba0c59e34afade9c4751852c6de2149001a09a54e1a2938`.
- The package manifest SHA-256 is
  `53a9a59692dce76a15f5aa8fdc57de09b6d519e7e5217840a74cea69c08a212b`.
  Its **1,633 files / 103,570,359 bytes** match after a fresh ZIP extraction.
- Both PowerShell versions load the extracted package's own installer reader and
  accept that exact inventory. `powershell-5-readback.json` and
  `powershell-7-readback.json` retain their results; the copied installer bytes
  match the current source.
- `.tmp/comparison-cell-current-package-probe.log` records the bundled Node
  runtime loading only package-local dependencies, pinning the new provisioning
  image, reading/writing fixture files and executing the controlled bearer HTTP
  MCP journey. The changed credential is refused. The package probe now explicitly
  checks the provisioning module and compiled image pin; it does not report that
  an installed controller exists.
- The separate `provisioning-probe/result.json` records the extracted package's
  own Node, contracts, driver and image guard completing five native checkpoints
  and verifying the same journal in a new helper. Its acknowledgement sink is a
  set of flushed fixture files, not canonical Gateway storage. The source fixture
  creates a new current-user-owned protected parent. It records
  `canonicalStorage: false`, `installedService: false`, `volumeAttached: false`
  and `workloadLaunched: false`. The earlier coordinator/SQLite proof remains a
  separate receipt. The probe script and parent-fixture hash are retained.

The installed-account review identifies the next integration constraint.
`service_identity.cpp` and the worker installer require the dedicated worker
account and only `SeChangeNotifyPrivilege`; the native cell parent accepts SYSTEM
or a canonical user owner, with service SIDs allowed as controllers. Windows
requires volume-management privilege for attachment. See Microsoft's
[AttachVirtualDisk contract](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-attachvirtualdisk).
The implementation direction is a separate privileged cell controller with its
own authenticated control boundary. The existing worker and signing broker keep
their restricted roles. That controller's service/IPC composition is unfinished;
the current package does not activate the native cell backend.

The source changes and candidate above do not complete protected-volume setup,
quotas, credential custody, full assignment/registry integration, physical-host
testing or C6 comparative/live acceptance. No service was installed or started,
privileges changed, external message sent, provider called, or Git publication
performed by this work.

## Dedicated cell-controller identity admission

The internal native owner in
`apps/remote-worker-windows-cell-native/src/cell_controller_identity.{hpp,cpp}`
admits only the dedicated `GoatCitadelRemoteWorkerCellController` service. It
requires a LocalSystem primary process token in session zero, the exact service
SID, only the change-notify and volume-management privileges, and no ambient
impersonation or restricted/AppContainer substitute. Startup can inspect the
volume privilege while disabled; volume operations require it enabled. The only
enable operation targets the admitted process's existing token after all checks.
The worker's separate one-privilege policy remains unchanged.

Admission binds the actual SCM process ID, startup/running state, quoted fixed
image path, demand-start configuration and protected service permissions. Its
administrator-installed 120-byte custody record separately pins the controller
image, provisioning helper, native directory and cell parent. Retained NTFS
handles prevent file replacement; repeated verification checks ancestor, file
and parent permissions because retained handles alone do not freeze ACLs. The
caller must serialize owner operations and provide an outer lifecycle watchdog.
The existing workspace owner now exposes its exact parent-descriptor builder;
its accepted principals and security contract are unchanged.

The generic All Services SID does not identify a particular service, and the
LocalSystem context comes from SCM. Neither a generic group nor SYSTEM alone
can replace the exact dedicated SID and SCM process binding. These choices follow
Microsoft's [SID definitions](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-identifiers),
[LocalSystem context](https://learn.microsoft.com/en-us/windows/win32/services/localsystem-account),
and [required-privilege filtering](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_required_privileges_infow).

Fresh local evidence:

- `pnpm verify:remote-worker:windows-cell-controller-identity` passed 1/1 with no
  skips. Normal and AddressSanitizer builds each passed 248 checks. The lane
  snapshots and hashes all 15 native inputs, independently derives the service
  SID and compares it with read-only `sc.exe showsid` output. Token/configuration
  projections, bounded custody decoding, the exact parent descriptor, real
  interactive/impersonating caller refusal and unrelated SCM-service refusal are
  covered. The process's actual privilege bytes remain unchanged. Receipt:
  `%TEMP%\Goat Cell Controller Identity cm1QWP\acceptance.json`;
  log: `.tmp/comparison-cell-controller-identity-third.log`.
- The first controller run stopped at a narrowing warning in fixture byte fills.
  The second exposed a fixture assumption that an impersonating caller could
  still collect token facts. The final owner refuses that caller before fact
  collection and clears its output; its regression verifies capture and admission
  refusal. Those failed receipts remain separate from the final passing run.
- `pnpm verify:remote-worker:windows-cell-job` separately passed 1/1, with 998
  checks in each normal/AddressSanitizer build and 301 journal checks each. Both
  receipts retain `volumeAttachmentExercised: false` and
  `volumeAttachmentRecoveryVerified: false`. Evidence:
  `%TEMP%\Goat Worker Cell Job bhPSo3`;
  log: `.tmp/comparison-cell-controller-parent-regression.log`.
- Scoped JavaScript lint passed. Documentation and diff checks are recorded with
  this source change.

This is a compiled admission component, not an installed controller. No service
host, authenticated IPC/client, controller installer or assignment composition
is delivered by this change. Its positive installed custody and privilege-enable
paths have not been exercised. The current unsigned worker ZIP predates this
owner and does not include it. Protected volume setup, quotas, credential custody,
broader assignment/tool/delegation integration, physical two-machine acceptance
and C6 campaign/live proof remain required. The full plan stays in progress.

## Controller pipe identity and bounded I/O

The internal native transport owner in
`apps/remote-worker-windows-cell-native/src/cell_controller_transport.{hpp,cpp}`
adds the Windows pipe and caller primitives for the dedicated controller. A
connected client's PID is used only to open and retain its actual process handle;
creation time, session and primary token are checked independently. After a
bounded client message is read, the pipe's identification token must match that
process's user, logon, session, integrity, groups and privileges. Subsequent checks
retain the process object and reject an exited caller or changed token. Thread
identification is reverted before inspecting facts or doing other work; failed
reversion terminates the owner process. The installed-admission wrapper further
requires current controller custody, the unchanged worker-service token policy
and the pinned provisioning-helper image. Its positive installed path is unproved.

The source builds a protected pipe descriptor granting the worker individual
duplex rights without pipe-instance creation or descriptor-control rights. The
intended client uses `SECURITY_IDENTIFICATION`, which Microsoft documents as an
impersonation level that does not require granting `SeImpersonatePrivilege` to
the server. See [the Windows identification contract](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient)
and [pipe access rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights).

The low-level I/O owner handles fragmented reads and partial writes, limits each
transfer to 16 KiB and bounds its absolute deadline to ten minutes. Stop and timeout
cancel and drain the exact pending overlapped request before stack storage is
released. If the kernel request cannot be drained, the owner process terminates;
an uncertain write is never retried. Callers must serialize use, retain their
non-inheritable overlapped handles and close peer evidence before disconnecting.
This is not a provisioning request protocol or canonical lease authority.

Fresh local evidence:

- `pnpm verify:remote-worker:windows-cell-controller-transport` passed 1/1 without
  skips. Normal and AddressSanitizer builds each passed 121 checks, with six real
  task-owned client processes and seven pipe fixtures, including one unconnected
  listener. Cases cover fragmented hello/acknowledgement exchange, data larger
  than the kernel buffer, actual process/pipe identity agreement, repeated
  verification, exited-client refusal, anonymous/broader impersonation refusal,
  and pending read/write/connect cancellation or timeout. Caller token rights
  remain unchanged and all six clients are joined. Seventeen native source files
  are snapshotted and hashed. Receipt:
  `%TEMP%\Goat Cell Controller Transport AmHdTy\acceptance.json`;
  log: `.tmp/comparison-cell-controller-transport-final.log`.
- The worker token collector now accepts a retained process handle as a read-only
  input; the existing current-process entrypoint delegates to it. The combined
  worker/controller identity regression passed 2/2 with no skips: 74 worker checks
  and 248 controller checks in each normal/AddressSanitizer build. Evidence:
  `%TEMP%\Goat Worker Identity xH6VZZ` and
  `%TEMP%\Goat Cell Controller Identity MpoT9W`;
  log: `.tmp/comparison-cell-controller-peer-identity-regression.log`.
- Scoped lint passed. Documentation and whitespace checks accompany this change.

The real pipes above use task-owned current-user fixtures. They do not prove a
SYSTEM-owned installed pipe, positive worker-service admission, mutual service
authentication or a provisioning operation. Service startup/shutdown, the client,
request framing and canonical checkpoint transport still need composition with
these owners. No service was installed or started, token privilege enabled,
external provider called, message sent or Git publication performed. C5 and C6
remain in progress.

## Controller service and provisioning protocol

The new native `cell_controller_main.cpp` composes the dedicated service identity,
protected local-only pipe, peer admission and journal session. It has no foreground
override. SCM startup must match installed identity/custody before the owner enables
its existing volume privilege and opens the listener. Stop signals cancel pending
I/O; an independent watchdog bounds synchronous work and the stop interval. Forced
termination affects only this controller process and leaves uncertain journal/OS
resources for canonical reconciliation. SCM lifecycle behavior is implemented but
has not been exercised as an installed service.

`cell_controller_protocol.{hpp,cpp}` defines one hello/welcome/request exchange per
connection. A fresh server nonce binds the request, checkpoints, acknowledgements
and receipt. The 256-byte request contains operation, bounded wall time, cell name,
assignment/profile hashes, disk specification, expected parent identity and an
independent recovery anchor. Paths and owner/controller principals come from the
trusted host, never the request. The journal only advances after the exact
checkpoint sequence and digest are acknowledged. The current peer and deadline are
rechecked before resource stages and after acknowledgements. Recovery reads exact
recorded state and cannot resume creation. Canonical lease/capacity admission and
checkpoint persistence remain required responsibilities of the worker/Gateway
bridge; OS peer identity does not replace them.

The terminal receipt has its own bounded acknowledgement. Windows discards unread
buffered data on pipe disconnect, so a successful buffered write alone is not
reported as receipt acknowledgement. See the
[Windows disconnect contract](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-disconnectnamedpipe).
An absent or wrong final acknowledgement never changes the native operation outcome
or authorizes a retry. Neither this service nor the journal attaches, formats,
mounts, launches a workload or removes uncertain resources.

Fresh evidence:

- `pnpm verify:remote-worker:windows-cell-controller-protocol` passed 1/1 without
  skips. Both normal and AddressSanitizer builds compiled the production service
  and rejected this interactive process (exit 5) and `--foreground` (exit 160).
- Each native protocol fixture passed 205 checks across nine real local pipe
  sessions. A task-owned protected parent produced five actual journal checkpoints
  and an unattached fixed backing file. A new session read the same five records.
  The acknowledgement fixture flushes exact record files before acknowledging;
  this is not canonical Gateway storage. Wrong connection nonces and impossible
  frame sizes create no journal. Wrong acknowledgement digest/sequence/nonce and
  revoked authority preserve only the prepared record and create no workspace.
  A wrong final acknowledgement cannot claim delivery or replay effects.
- All 24 native inputs were snapshotted and hashed. Evidence:
  `%TEMP%\Goat Cell Controller Protocol qmN09R\acceptance.json`;
  log: `.tmp/comparison-cell-controller-protocol-final.log`.
- Scoped build/test-script lint passed. Documentation and whitespace checks
  accompany the change.

The fixture uses the current user's independently protected parent and actual OS
pipe identity. It does not establish SYSTEM-owned installed custody, a real worker
service client, SCM startup/stop behavior, watchdog termination of a hung installed
service, or canonical Gateway acknowledgement storage. The production client,
mutual server authentication, Gateway bridge, controller installer and worker ZIP
integration remain required. The previously built unsigned worker ZIP does not
contain this service. Protected volume/credential/assignment composition, physical
mini-PC testing and C6 campaign/live proof remain open. No service was installed or
started, OS privilege enabled, provider called, external message sent or Git
publication performed. The full plan remains in progress.

## Worker-side controller authentication

`cell_controller_client_identity.{hpp,cpp}` now owns the restricted helper's side
of controller authentication. `Prepare` requires the actual worker service token
and the independently installed provisioning-helper image. `Open` binds the OS
pipe server to a retained process handle and creation time, the current running
SCM instance, its protected service configuration, the dedicated controller token
and its installed executable. Revalidation checks the worker's own token and
image, controller process/pipe/token continuity, SCM state and installation
custody. Nothing in the client owner enables privileges or creates resources.

`CellPipeServerEvidence` reads the actual server PID/session from the connected
client end and retains its process. A server name, raw token projection or stale
PID cannot grant installed-service authority. The client refuses inherited
handles and ambient impersonation; an exited retained server cannot remain
authority. Windows supplies the process identifier through its
[pipe inspection API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid).

`CellControllerInstalledFiles` shares the existing fixed-layout custody checks
between the two sides. Both pin the administrator-owned record and executable
hashes and recheck their security descriptors. Only `CellControllerIdentity`
opens and verifies the protected cells parent. The worker gets its expected
identity from the independent record without receiving access to that directory.

The signer inspection implementation is extracted into
`apps/remote-worker-windows-host-native/src/service_inspection.{hpp,cpp}`. Its
signer-specific admission remains in place. The controller invokes the same
query-only grant after its complete startup identity validation. The shared
routine independently requires its own SYSTEM primary token in session zero
and preserves original ACL entries and protection. It grants the fixed worker
only process query/synchronization and token query; it adds no worker privilege,
control, memory, token-duplication or token-assignment access. Both native project
closures and the independently enumerated source manifest include the extraction
(54 source paths). The earlier 52-path evidence remains historical.

Fresh evidence:

- `pnpm verify:remote-worker:windows-cell-controller-client-identity` passes 1/1
  without skips. Normal/AddressSanitizer fixtures pass 80/82 checks respectively
  (bounded startup-wait assertions account for the difference). Each uses two
  separate server processes and proves new process evidence for the same pipe
  name, exact server birth time, handle/impersonation refusal, retained-process
  exit and actual interactive-worker refusal. Both builds pass 121 shared signer
  inspection checks, including Windows access decisions and descriptor readback
  on task-owned objects. Privileges remain unchanged.
- Its 31 snapshotted inputs and receipts are retained at
  `%TEMP%\Goat Cell Controller Client Identity GXicoU\acceptance.json`;
  log: `.tmp/comparison-controller-client-identity-final.log`.
- All 47 native signer packaging tests pass without skips, including actual
  reproducible x64 and ARM64 service/client/availability/test builds and x64 ASan
  proof. Log: `.tmp/comparison-controller-shared-inspection-packaging-fixed.log`.
  An initial inventory failure was corrected by explicitly adding and sorting the
  two shared files and updating the independent count; the 47/47 result is a new
  complete invocation.
- Controller identity passes 248 checks per native build at
  `%TEMP%\Goat Cell Controller Identity VqrmzP`.
  Transport passes 121 checks per build at
  `%TEMP%\Goat Cell Controller Transport vK8GY5`.
  The production controller recompiles and refuses interactive launch; protocol
  creation/recovery and refusal regressions pass 205 checks across nine sessions
  per build at
  `%TEMP%\Goat Cell Controller Protocol pHt03k`.
- Scoped script lint passes. Documentation and whitespace checks accompany this
  source change.

This is client identity and shared-component proof. It does not establish a
positive installed SYSTEM/worker connection, SCM lifecycle acceptance, native
helper request forwarding, canonical Gateway acknowledgements over this pipe,
controller package installation or volume/credential/assignment composition.
The existing provisioning helper and worker ZIP still use the prior direct
component path. The next integration step is to wire this identity owner into
that helper's controller mode while preserving exact checkpoint commits before
acknowledgement. No service was installed or started, privilege enabled, provider
called, external message sent or Git publication performed. C5/C6 and the full
plan remain in progress.

## Controller request and checkpoint forwarding

The trusted `createWindowsWorkerCellProvisioning` composition can now select
`controllerService: true`. It still normalizes the plan, checks current canonical
authority, pins the helper image until its child closes, validates every returned
checkpoint, commits its exact bytes and returns only the matching digest. The
option selects the helper's fixed `--controller` mode; a controller failure cannot
fall back to direct provisioning. No registry/model input selects a pipe or
executable. Existing component callers retain their separate direct path.

The helper's controller mode admits its actual worker token and installed image
before reading a request. It requires the installed parent identity/path and
fixed SYSTEM/controller principals, connects only to the fixed local controller
pipe, and verifies the live controller through the prior mutual-identity owner.
The restricted helper never opens the protected cells parent. Its stdin/stdout
protocol is unchanged, so canonical checkpoint acknowledgements pass through the
same Gateway-facing bridge. The fifth acknowledgement also requires the expected
stdin end before it is forwarded. Pipe evidence closes before its borrowed handle.

`cell_controller_client_protocol.{hpp,cpp}` uses fresh handshake and connection
nonces, fixed reply sizes and at most five ordered checkpoints. It checks the
request binding, native record hash chain, stable journal identity and independent
recovery anchor before calling the canonical checkpoint consumer. Creation
requires the exact committed digest; current endpoint identity is rechecked after
the possibly blocking commit callback and before sending the acknowledgement.
Recovery sends no creation acknowledgement and cannot resume effects. The
terminal receipt retains its native error/phase/count and has a separate bounded
delivery acknowledgement. A lost acknowledgement, transport error, cancellation
or timeout does not cause reconnection, resource adoption, cleanup or a retry.

Fresh evidence:

- `pnpm verify:remote-worker:windows-cell-controller-protocol` passes 1/1 without
  skips. Normal and AddressSanitizer fixtures each pass 419 checks across 26 local
  sessions, including 17 using the production client protocol. The client drives
  all five real journal/workspace/unattached-disk checkpoints and reads identical
  records in a new recovery session. Incorrect commit digests, revoked authority,
  cancellation and expired deadlines preserve only the prepared record. Invalid
  welcomes/nonces, valid-hash records with wrong bindings/order/anchors, bad
  digests, impossible frame lengths, unexpected frame kinds, premature success
  receipts and truncated replies never reach the checkpoint/receipt consumer.
  Evidence: `%TEMP%\Goat Cell Controller Protocol izYHPg\acceptance.json`;
  log: `.tmp/comparison-controller-client-protocol-final.log`.
- `pnpm verify:remote-worker:windows-cell-provisioning` passes 6/6 without skips,
  including locked worker/Gateway typechecks. Its real Gateway coordinator suite
  passes 16/16 with current-helper completion, recovery, lost acknowledgement and
  cancellation. The controller option refuses this interactive worker before
  emitting a checkpoint or creating a journal, with no direct fallback. Both
  native builds reject an interactive `--controller` invocation and extra mode
  arguments. Evidence: `%TEMP%\Goat Worker Provisioning Bridge GKWhke`;
  log: `.tmp/comparison-controller-helper-bridge-final.log`.
- The complete `pnpm verify:remote-worker:windows-tls` invocation passes: locked
  typechecks, 376 worker tests, 16 key-identifier tests and all 23 native TLS
  checks. The new helper and image guard build reproducibly for x64 and ARM64.
  ARM64 execution is not tested. The initial invocation exposed ARM64 warning
  C4324 in the aligned token buffer; explicit tail storage fixed its layout while
  preserving alignment and strict warnings. The passing lane is a new full
  invocation. Evidence: `.tmp/native-tls-acceptance-rToNRu`;
  log: `.tmp/comparison-controller-helper-tls-fixed.log`.
- Source/artifact auditing confirms all 28 protocol inputs and all 43 inputs per
  native payload match current source or the generated pin snapshot. The helper
  tested by Gateway is byte-identical to both fresh x64 builds. Receipt:
  `.tmp/comparison-controller-client-source-audit.json`. Scoped lint,
  documentation and whitespace checks accompany this change.

The protocol fixtures authenticate actual local OS peers but use current-user
principals and a flushed file acknowledgement sink. The canonical Gateway
positive cases use the updated helper's direct component mode. They do not
constitute one positive installed-controller/Gateway run. That run, controller
SCM lifecycle, installer/custody-record and worker ZIP integration, stock
assignment/provisioning composition, protected volume/credential execution and
physical mini-PC acceptance remain required. The earlier worker ZIP has not been
replaced with this payload. No installed service was started or changed, OS
privilege enabled, provider called, external message sent or Git publication
performed. The full plan remains in progress.

## Controller package and installation custody

The Windows package builder now compiles and inventories
`GoatCitadelRemoteWorkerCellController.exe`. Both JavaScript and PowerShell
package readers require it even when a manifest has been rehashed after omission.
The controller builder accepts the package target and emits a source/image
receipt. Normal production images reproduce across separate output directories
for x64 and ARM64; ARM64 execution remains untested.

The installer source creates separate demand-start worker and controller services
and leaves both stopped. The controller uses SYSTEM plus its fixed service SID,
with exactly ChangeNotify and ManageVolume privileges. Its protected SCM
descriptor gives the worker only query rights. A retained creation handle scopes
the privilege configuration to this invocation's controller. The worker remains
on its virtual account with only ChangeNotify; signer privileges are unchanged.

The source recipe creates the SYSTEM/controller-only cells parent with the native
runtime's owner/group, protected DACL, owner-rights restriction and integrity label.
Installer-only backup-intent reads allow an elevated administrator to inspect it.
The protected `configuration/cell-controller.identity` record binds the two image
hashes from the independent package inventory and the actual retained NTFS native
and cells directory IDs. Record encoding rejects missing/duplicate image pins,
image drift, empty/equal hashes, identical directories, foreign volumes and
unsupported directory metadata. Native admission still independently validates
installed custody and both process identities.

Existing worker/controller services and installation footprints are refused.
After parent creation, failed installation retains the cells and staged evidence;
only matching, stopped services created by this invocation can be removed during
cleanup. The paired uninstall checks both services and exact payload bytes,
retains cells/configuration/state and never stops a process or deletes cells.
This does not make native assignment placement active.

Fresh evidence:

- `pnpm verify:remote-worker:windows-service-install` passes 33/33 without skips.
  PowerShell 5.1.26100.9343 and 7.6.5 each pass 62 temporary-file/record cases.
  Both normal and AddressSanitizer native readers decode each PowerShell record,
  match both real NTFS directory IDs and compare the intended descriptor bytes
  with the production runtime builder. The preflight calls refuse installation
  in this unelevated context and report no service, parent or privilege mutation.
  Evidence: `%TEMP%\Goat Worker Install vLqMS8\acceptance.json`;
  log: `.tmp/comparison-controller-install-final.log`.
- Reproducible controller payload evidence:
  `%TEMP%\Goat Controller Payload oSnW6E\acceptance.json`.
  x64 is 292,864 bytes, SHA-256
  `3d79eb99eb0918d24787d6b48e1787aefac351f3202bd328dcf5eaf15cce2340`;
  ARM64 is 270,848 bytes, SHA-256
  `b7dfb2ac77318508194a851c782ffeb1b3b059689b2f6078890477931d8ad2b8`.
- The output-lock package command builds a fresh x64 candidate under
  `.tmp/comparison-controller-package-5e4fd365aeda452eb1727d54b06d1ec5`.
  Its ZIP is 39,142,749 bytes, SHA-256
  `fe608131bafb836a718d92cbda26cc6bbe4c1d497d0378b5f89f42ef9e4873d3`.
  Manifest SHA-256:
  `0fa926af32fdacbde64e29af158c3ee03c0de4ab05234ffed8a7d3a7cb44cddd`.
  The extracted inventory has 1,634 files / 103,950,835 bytes. Both packaged
  PowerShell readers agree on that exact inventory. The earlier candidate is
  preserved. Build log: `.tmp/comparison-controller-package-build.log`.
- `pnpm verify:remote-worker:windows-package --root <extracted> --manifest-sha256
  <independent-pin> --probe` passes 29/29 package regressions plus actual packaged
  Node/OpenSSL imports, filesystem read/write and bearer-authenticated loopback
  MCP. Both controller and helper controller mode refuse the interactive caller
  before emitting a record. Probe log: `.tmp/comparison-controller-package-probe.log`.
- `current-source-acceptance.json` in the candidate directory verifies the ZIP,
  extracted inventory, all 25 controller inputs, all 43 TLS/helper inputs and all
  11 packaged installer files against current source. The packaged helper matches
  the earlier Gateway-tested x64 helper exactly. Scoped lint and whitespace
  checks accompany this change.

These tests exercise current-user temporary files and pure/native compatibility;
they do not execute the elevated SCM creation, privilege assignment or SYSTEM
parent installation branch. Actual service install/start/stop, worker/controller
authentication under their installed identities, positive canonical Gateway
provisioning, stock assignment composition, protected volume/credential execution,
broader worker tools/delegation and mini-PC/live-channel/provider acceptance remain
unfinished. The full C0-C6 plan remains active; no Git publication or external
message was performed.

## Protected assignment provisioning exchange

The existing protected `assignment.settlement.submit` route now accepts only two
additional typed operations: `cell.provisioning.snapshot` and
`cell.provisioning.checkpoint`. Their shared contract rejects injected claim or
approval fields, malformed records, invalid sequence numbers and oversized or
broken returned journals. The private response carries the canonical plan/hash,
assignment/lease identity and at most five exact records. Credential authority,
raw lease material and provisioning-owner fields are not projected.

`RemoteWorkerCellProvisioningRepository.exchangeWithAssignment` resolves and
locks the active protected assignment before locking the cell. It requires a
pre-existing native profile, unexpired provisioning claim and prepared plan.
Checkpoint replay still checks current authority. After any append, it rechecks
the credential/mesh/parent authority, exact assignment lease and provisioning
claim before the outer transaction commits. Invalidated authority rolls back the
checkpoint. The Gateway composes this owner through `AsyncStorage`; cancellation
before the owner or after its commit prevents acknowledgement. A response lost
after commit leaves canonical records available for subsequent reconciliation.

The worker client uses the existing protected route signer/transport and freezes
its lease before sending. It verifies returned scope, generation, lease revision,
plan hash, full record chain and the exact submitted checkpoint before returning
an acknowledgement to its caller. This exchange does not issue creation permits,
call the helper, format or attach a volume, start a workload, mark a platform
ready, or enable native placement. Those stock assignment composition and native
execution steps remain required.

Evidence for this change:

- Contract suite: 16/16; `.tmp/comparison-cell-exchange-contracts.log`.
- Gateway protocol, runtime composition and cell service regression: 52/52;
  `.tmp/comparison-cell-exchange-gateway-regression.log`.
  After adding explicit cancellation-before-owner and cancellation-after-commit
  cases, the protocol suite passed separately at 33/33;
  `.tmp/comparison-cell-exchange-gateway-final.log`.
- Worker cell client and existing Chat tool client: 4/4;
  `.tmp/comparison-cell-exchange-worker-regression.log`.
- SQLite/PostgreSQL exchange cases: 6/6, no skips;
  `.tmp/comparison-cell-exchange-postgres.log`. These cover worker and mesh-authority
  revocation, parent cancellation, lease renewal, exact replay and rollback after
  an append but before commit. The disposable PostgreSQL instance was stopped
  after matching its data directory, PID, executable, command line and port.
  Retained evidence:
  `%TEMP%\gc-cell-exchange-pg-VHOMU4\acceptance.json`.
- Contracts, storage, remote-worker and Gateway typechecks passed together under
  the output lock; `.tmp/comparison-cell-exchange-verified-typecheck.log`.
  An earlier check caught a worker test importing storage source. The fixture
  now has a local encoder; all 96 compiler outputs created by that failed check
  were identified by creation time and archived outside source with matching
  hashes. No existing source or unrelated work was removed.
- `pnpm verify:runtime:truth`: both scenarios passed without skips, covering
  approval recovery across a Gateway restart and the canonical Next shell's
  browser projection. This uses the deterministic local provider, not a live
  model. Evidence: `artifacts/verification/2026-09-12T17-38-41-165Z-runtime-truth-3525c64e/manifest.json`.
- `pnpm verify:gateway:async-boundary`: 10/10 tests plus a successful scan of 988
  production Gateway files; `.tmp/comparison-cell-exchange-async-boundary-final.log`.
  `pnpm docs:check` and scoped whitespace checks pass. Scoped lint reports no
  errors and one `max-lines` warning in the execution protocol service (1,008
  counted lines against its 1,000-line guideline).

These are repository and protected-protocol tests, not installed service,
physical mini-PC or live-provider/channel proof. The existing worker ZIP predates
this TypeScript exchange and has not been repackaged for it. C5/C6 remain open.

## Installed custody startup query

The provisioning helper accepts the exact `--controller-custody` mode with empty
stdin. Its existing native identity owner first admits the current restricted
worker token, pins the fixed installation files and checks that the running
helper is the installed image. It verifies those facts before and after encoding
the installation's 120-byte custody record and fixed cells-parent path. The
response contains image hashes and directory identities, with no credentials,
caller-selected paths, controller pipe connection or resource creation. The
native watchdog bounds the complete read; mixed mode arguments are rejected.

`readWindowsWorkerCellControllerCustody` retains the image-guard lease until its
owned helper closes. It sends no input, limits stdout to 8,324 bytes, refuses any
stderr or nonzero exit, and rechecks current assignment authority before returning
metadata. The decoder checks exact magic bytes, length, UTF-8, canonical parent
path, nonzero distinct image/directory identities and matching volumes. Decoding
arbitrary bytes is a format operation and grants no installation or execution
authority. This reader is not yet called by normal assignment startup.

Evidence for this change:

- Focused worker codec and process-lifetime tests: 49/49;
  `.tmp/comparison-cell-custody-worker-final.log`. The first run caught a redundant
  kill attempt when the final authority check timed out after the helper had
  already closed. Shutdown now checks liveness and is idempotent; the regression
  verifies that it does not attempt to kill that exited process.
- `pnpm verify:remote-worker:windows-cell-controller-client-identity` passes
  without skips, including the output-locked worker typecheck. Native identity
  checks pass at 107 normal / 109 AddressSanitizer, each using two separate local
  server processes. The query-only signer regression passes 121 checks per build.
  Both actual C++ fixture outputs decode to the expected TypeScript hashes and
  little-endian directory IDs. Evidence:
  `%TEMP%\Goat Cell Controller Client Identity ldLRui\acceptance.json`;
  log: `.tmp/comparison-cell-custody-native-client.log`.
- `pnpm verify:remote-worker:windows-cell-provisioning` passes 7/7 without skips,
  with output-locked worker and Gateway typechecks. The real pinned helper and
  both normal/AddressSanitizer raw modes reject interactive custody reads without
  output. Existing actual helper/Gateway creation, checkpoint recovery, malformed
  input, acknowledgement and watchdog cases pass. Evidence directory:
  `%TEMP%\Goat Worker Provisioning Bridge 0ePl8h`;
  log: `.tmp/comparison-cell-custody-provisioning.log`. Its retained Gateway JSON
  report records 16/16 cases without skips.
- `pnpm verify:remote-worker:windows-tls` passes: all 427 worker tests, 16 key
  identifier tests and 23 native TLS/build cases, without skips. Both worker
  packages typecheck under the output lock. Reproducible x64/ARM64 builds include
  the updated provisioning helper and compiled image pins; actual execution is
  x64. Evidence: `.tmp/native-tls-acceptance-qrkAFw`;
  log: `.tmp/comparison-cell-custody-tls.log`.
- Scoped ESLint passes without warnings or errors;
  `.tmp/comparison-cell-custody-lint.log`. All 12 touched files pass whitespace
  inspection, including untracked content;
  `.tmp/comparison-cell-custody-whitespace.json`.

These prove the bounded codec, process lifecycle and interactive refusal. They
do not prove admission under installed worker/controller services or a running
controller, and they do not establish an attested runtime profile, canonical
capacity reservation, provisioning claim or one-time creation permit. Those
owners, first-create versus recovery startup, protected volume/executor and live
acceptance remain required. The existing worker ZIP predates these helper and
TypeScript changes. No installed payload, service, privilege or credential was
changed by these checks; the native backend remains inactive.

## Canonical native cell preparation

The protected assignment settlement route accepts `cell.provisioning.prepare`
with only the observed installed parent-directory ID. This observation grants
no attestation, permission, capacity or chosen path. The native helper continues
to require its independently verified, fixed installed parent and controller.

`prepareForAssignment` locks and rechecks the active protected assignment before
building a native profile from its manifest and current admitted Windows x64
generation. Runtime attestation uses the retained installed-tree attestation,
not the runtime-manifest hash. Launcher provenance binds the attested tree,
verification receipt, manifest and launcher digest. Names and disk identifiers
are deterministic per assignment/worker generation; the profile fixes deny-all
workload egress and hashes environment names without retaining their values.

The Gateway owns the resource policy. Its initial ceilings are 256 MiB logical
disk, 576 MiB total allocated reservation, 512 MiB memory, four processes, one
CPU equivalent and a ten-minute workload wall limit. Assignment limits narrow
output and artifact ceilings. The provisioning claim lasts at most two minutes
and cannot exceed the assignment deadline. These are canonical reservations and
planned limits; this operation does not create or enforce native resources.

Profile insertion, claim acquisition and plan preparation commit atomically.
The first successful plan insertion returns `create_once`. Every replay returns
`reconcile`, including an empty journal after a lost response. Changed profiles,
policy or parent identity cannot replace the retained plan. A cancelled parent
after plan insertion rolls back the whole transaction. Lease renewal preserves
the plan and replay decision; stale leases and revoked worker/mesh/parent
authority are rejected. An expired provisioning claim still requires explicit
reconciliation; this path does not silently extend it or reissue creation.

The Gateway asynchronous storage composition supplies its own fixed policy and
checks cancellation before the call and after commit. The protected response
and worker client validate the decision, exact scope/generation/lease, canonical
plan hash, observed parent identity and expiry. A creation decision with existing
checkpoints is rejected. No native helper is invoked by normal assignment
startup yet, and no cell is marked ready by preparation.

Validation completed for the source changes:

- Contracts: 17/17; `.tmp/comparison-cell-preparation-contracts.log`.
- Gateway protected execution protocol, runtime composition and cell service:
  68/68; `.tmp/comparison-cell-preparation-gateway.log`.
  The production factory's policy/cancellation checks pass separately at 3/3;
  `.tmp/comparison-cell-preparation-composition.log`.
- SQLite and disposable PostgreSQL: 13/13 without skips;
  `.tmp/comparison-cell-preparation-postgres-verified.log`. The concurrent case
  observes two independent repository workers blocked on the canonical
  assignment lock before releasing them together. Exactly one returns
  `create_once`, the other returns `reconcile`, and one cell/plan is retained.
  The earlier 13-case run failed in the fixture's final row-count query; the
  query now binds the assignment key, and the complete lane was rerun cleanly.
  Evidence: `%TEMP%\gc-cell-preparation-pg-Y7bjFZ\acceptance.json`.
  The task-owned cluster was stopped after checking its data directory, PID,
  executable, command line and port.
- Worker preparation/checkpoint clients and custody reader: 58/58;
  `.tmp/comparison-cell-preparation-worker.log`.
- Contracts, storage, worker and Gateway typechecks pass under the output lock;
  `.tmp/comparison-cell-preparation-typecheck-verified.log`.
- `pnpm verify:runtime:truth`: 2/2 without skips, with durable approval recovery
  across a Gateway restart and zero browser console/page errors. This uses the
  deterministic local provider, not a live model. Evidence:
  `artifacts/verification/2026-09-12T18-30-10-097Z-runtime-truth-a022b321/manifest.json`.
- `pnpm verify:gateway:async-boundary`: 10/10 and 989 production files scanned;
  `.tmp/comparison-cell-preparation-async-boundary.log`.
- Scoped lint has no errors and retains one execution-protocol `max-lines`
  warning (1,021 counted lines against the 1,000-line guideline).

The [worker startup owner below](#worker-native-provisioning-startup) now consumes
the decision, persists a local stop marker and composes creation/reconciliation.
Normal assignment activation and protected volume/executor/credential composition, broader
worker tools/delegation, installed Windows service acceptance and physical/live
acceptance remain unfinished. The earlier ZIP predates this source. No service,
installed payload, privilege, saved credential or external provider was changed.

## Worker native provisioning startup

`prepareWindowsWorkerAssignmentCell` composes the pinned installed-custody reader,
current protected assignment lease, Gateway preparation/checkpoint clients and
native helper. Each authority check renews the retained lease and reads current
assignment control; subsequent requests use that rotated lease. Expiry or
cancellation stops the owned native call. The owner drains an outstanding lease
check before returning. PEM startup, missing key ownership, changed workspace,
refused custody and cancelled assignments cannot enter native creation.

`provisionWorkerCell` retains a flushed local marker before creation. The marker
contains assignment, plan and custody hashes, without credentials or paths; it
can only veto creation. Gateway replay, lost responses and an existing marker
enter recovery. An empty canonical journal requires reconciliation without a
helper call. Creation requires five serial exact checkpoints and a final current
snapshot. An overlapping, premature, rejected or uncertain checkpoint cannot be
acknowledged or retried. Recovery compares the native journal with the complete
canonical chain and never resumes creation or marks an execution platform ready.

Validation for this source boundary:

- Four focused worker suites: 98/98, including 29 coordinator and 10 Windows
  composition cases; `.tmp/comparison-worker-cell-startup-focused.log`.
  The file-backed restart case retains its temporary marker for inspection.
- `pnpm verify:remote-worker:windows-cell-provisioning`: 8/8, zero skips;
  `.tmp/comparison-worker-cell-startup-native.log`. The contained Gateway cell
  service suite also passes 16/16. Worker/Gateway typechecks pass under the
  repository output lock.
- Real compiled-helper evidence:
  `%TEMP%\Goat Worker Provisioning Bridge ER8xzz`.
  `worker-native-complete.json` retains five native records and exact restart
  recovery; `worker-native-lost-ack.json` retains two records after a lost
  acknowledgement. Both prove one creation and an unchanged native journal
  after restart. This added worker case uses a controlled Gateway acknowledgement
  fixture and a temporary native parent, not an installed service or real
  authenticated Gateway. Normal/AddressSanitizer protocol regressions and
  interactive-user refusal checks pass separately inside the same lane.
- Scoped lint passes without warnings. Cancellation now kills only a still-live
  owned helper once, with a focused regression for repeated abort delivery.

The startup owner is exported for trusted installed-service composition. Normal
assignment startup does not invoke it automatically: protected volume formatting,
mount/attachment, quotas, executor/credential custody and platform readiness must
be established before that path can launch work. Expired provisioning claims
still need explicit recovery. Native backend activation, installed-service proof,
physical Mini PC/Telegram acceptance and the complete plan remain unfinished.
The earlier worker ZIP predates this source; no installed payload was changed.

## Bound virtual-disk device source

`CellVirtualDiskDevice` accepts a freshly verified `CellVirtualDiskAttachment`,
not a caller-selected path or disk number. It owns independent attachment and
backing-file pins, opens the locator obtained from that attachment, and checks
the opened handle's disk number, virtual length and host dependency against the
retained image. It rechecks attachment identity, exact controller file security
and current effective volume privilege before returning or verifying readiness.
Its readiness describes this device observation only. No raw device handle is
exposed and no partition, format, mount, detach or workload operation is added.

The bounded dependency decoder checks every pointer before reading strings,
requires one directly backed fixed Microsoft VHDX, and refuses unknown flags,
remote/differencing/removable disks, reserved flags, automatic drive-letter assignment or temporary
attachments, aliases, traversal and changed backing paths. Device numbers remain
locators; independent backing-file custody remains necessary. The Windows API
basis is [GetStorageDependencyInformation](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-getstoragedependencyinformation),
its [host-volume/disk-handle flags](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ne-virtdisk-get_storage_dependency_flag),
the [version-two dependency fields](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ns-virtdisk-storage_dependency_info_type_2)
and [device-number query](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-ioctl_storage_get_device_number).

Overlapped device queries cancel and join their exact operation before releasing
buffers or events. Synchronous driver calls still require the controller's outer
watchdog. `Close` releases only this owner's handles and leaves permanent
attachments for their canonical owner; an observation does not prove zero work.

Fresh source proof:

- `pnpm verify:remote-worker:windows-cell-job` passes the complete named lane;
  `.tmp/comparison-cell-device-binding-native-verified.log`.
- Normal and AddressSanitizer receipts each report 1,063 checks, including 65
  new dependency-metadata/device-refusal cases and 89 attachment-owner checks.
  Evidence: `%TEMP%\Goat Worker Cell Job kS1New`.
  Both explicitly report `volumeAttachmentExercised: false`,
  `volumeAttachmentRecoveryVerified: false` and `volumeDeviceBindingVerified: false`.
- Actual network denial and owner-crash/descendant shutdown checks also pass
  within that lane. All processes under its private evidence directory exited.
- The first compile stopped on an unavailable fixture macro (`MAXULONG`). The
  fixture now uses the supported 32-bit bound, and the entire native lane was
  rerun cleanly. Scoped JavaScript lint passes.
- Acceptance-package inventory/staging checks pass 6/6 with the pinned Node
  runtime, without skips; `.tmp/comparison-cell-device-acceptance-unit.log`.

The explicit attached-volume branch now checks the real device dependency,
independent pin lifetime after closing original owners, recovery and privilege
revocation. That branch has not run on this host. Formatting/protection, quotas,
controller protocol and canonical volume journal integration, installed service
and physical-machine acceptance remain unfinished. The native backend stays
inactive; neither these receipts nor a portable test bundle certify execution.

The portable acceptance bundle was rebuilt from the current 34 native source
inputs and its complete 53-file inventory verified. Its ZIP was extracted into
a fresh directory, then the extracted bundle's own pinned Node and prebuilt
normal/ASan fixtures ran the full lane without a compiler. Both receipts pass
1,063 checks, including the new 65 metadata/refusal cases, and retain attached
device binding as unverified. All test-owned processes exited.

- ZIP: `.tmp/comparison-cell-device-acceptance-8a8d4d9cf83640d59782091aab77ca0a/GoatCitadel-Windows-Cell-Acceptance-2026-09-12.zip`
  (37,946,053 bytes).
- ZIP SHA-256: `cdb7d4b5d43de356f37c1e90fce66edd1c518779f20ebf2d48cd1206c4d3ce89`.
- Independent manifest SHA-256: `f28ea65880fc86ca4fef49d456c0d251246016843e4bcedd1c24338e34d8b7d2`.
- Extraction/run receipt: `.tmp/comparison-cell-device-acceptance-8a8d4d9cf83640d59782091aab77ca0a/portable-evidence.json`.
- Native evidence: `%TEMP%\Goat Worker Cell Job SyBkz5`;
  `.tmp/comparison-cell-device-acceptance-portable.log`.

After extracting the ZIP on a Windows x64 test machine, the default component
lane runs from the extracted directory with:

```powershell
.\app\runtime\node.exe .\app\scripts\packaging\run-remote-worker-cell-acceptance.mjs --manifest-sha256 f28ea65880fc86ca4fef49d456c0d251246016843e4bcedd1c24338e34d8b7d2
```

The default command does not attach volumes. Explicit `--preflight` and
`--attachment` modes retain their documented operator-owned boundaries. This is
an unsigned private test bundle, not the Windows worker installer or evidence
that a second machine has passed.

## Native GPT layout source

`CellVirtualDiskLayout` adds an internal disk initialization/partitioning owner in
`apps/remote-worker-windows-cell-native/src/cell_virtual_disk_layout.{hpp,cpp}`.
It accepts only an independently bound `CellVirtualDiskDevice` and an exact
recorded VHDX/control/backing identity. The canonical caller must separately
freeze distinct GPT disk/data-partition identifiers, hold exclusive provisioning
and zero-workload authority, and supply both current authorization and durable
checkpoint acknowledgement callbacks. No public disk number or arbitrary device
path enters the owner.

Creation refuses an existing partition table, records initialization intent,
checks RAW again, initializes GPT, flushes the driver write, refreshes disk
properties and waits for Windows' volume readiness. It then verifies the planned
GPT identity, fixed 512-byte sectors and 128-entry geometry, retaining the exact
Microsoft reserved partition. The supported reserved lengths are 16, 32 and
128 MiB; geometry must still leave at least 16 MiB of aligned data space. The
layout owner requires a VHDX of at least 64 MiB, within the existing reservation
limits; the current canonical preparation profile reserves a 256 MiB image.

A second retained intent precedes partitioning. The owner rechecks the observed
reserved partition after acknowledgement and adds one aligned basic-data
partition with `NO_DRIVE_LETTER`, preserving the reserved partition's identity,
extent, attributes and name. It flushes and refreshes the device again, then
compares fresh readback before and after the final acknowledgement. Driver SET
responses are bounded but do not supply replacement identity or layout authority.
`NO_DRIVE_LETTER` prevents automatic assignment; it does not prove that an
administrator has never assigned a mount point.

Four canonical 512-byte `GCCGPT01` records bind phase, predecessor digest, backing
and GPT identities, reservation, observed reserved partition and planned data
extent. Each callback must acknowledge the exact record SHA-256. A lost or wrong
acknowledgement, changed layout, lost authority, cancellation or uncertain driver
result keeps the owner unknown and stops subsequent writes. `OpenRecorded`
requires an independently retained complete chain, opens only for verification,
and cannot turn an interrupted prefix into creation or repair authority.

The component tests execute the production sequence through internal fixture
ports. They use independent SDK-shaped layout responses, verify both native
write requests, inject failure at every I/O/verification/authorization step,
cover lost acknowledgements at all four phases, and reject layout drift and
corrupt or inconsistently rehashed records. The JavaScript harness independently
checks exported checkpoint bytes, chaining, fixed identity and aligned extents.
These fixture acknowledgements are not installed Gateway/controller persistence.

Validation for the initial GPT component revision:

- `pnpm verify:remote-worker:windows-cell-job` passed the complete named lane;
  `.tmp/comparison-cell-layout-native-final-v3.log`.
- Evidence root: `%TEMP%\Goat Worker Cell Job mNMPEd`.
  Normal and AddressSanitizer receipts each pass 1,235 checks, including 172 layout
  component cases and four exported fixture checkpoints. Both explicitly retain
  `volumeLayoutExercised: false`, `volumeAttachmentExercised: false` and
  `volumeDeviceBindingVerified: false`.
- The named lane also passes its separate eight-check network cases in both
  builds, successful control connections before/after, and static/stdio owner
  crash checks with observed child exit. All 37 native source hashes matched that
  revision, and no executable from that evidence directory remained running.
  Compact receipt: `.tmp/comparison-cell-layout-proof.json`.
- Scoped JavaScript ESLint and `pnpm docs:check` pass. Ten scoped whitespace checks
  have no issues. Logs: `.tmp/comparison-cell-layout-lint.log`,
  `.tmp/comparison-cell-layout-docs.log`, `.tmp/comparison-cell-layout-whitespace.json`.

Earlier compile attempts exposed signed/unsigned and byte-fill warnings in the
test fixtures; these were corrected. The complete final lane above ran after the
driver-output/flush and RAW-union fixes, rather than combining earlier receipts.

The implementation follows Microsoft's documented
[GPT initialization order](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-ioctl_disk_create_disk),
[volume readiness control](https://learn.microsoft.com/en-us/windows/win32/fileio/ioctl-disk-are-volumes-ready),
[partition layout driver contract](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntdddisk/ni-ntdddisk-ioctl_disk_set_drive_layout_ex),
[partition fields](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-partition_information_ex),
[GPT attributes](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-partition_information_gpt),
and [buffer flushing API](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).

The installed controller does not yet invoke layout writes. GPT identifier
derivation and native journal composition are covered below; the Gateway/controller
checkpoint bridge remains source work. Native
layout writes and flushes have not been exercised on an attached disk. Formatting,
mounting, quotas, workload execution, service installation and Mini PC/Telegram
acceptance remain unfinished. The native backend remains inactive. The earlier
53-file portable ZIP covers device binding and predates this layout source; it
was not rebuilt in this slice. No privileged service, external channel or
provider operation was performed.

## Canonical GPT identity and checkpoint contracts

`CellProvisioningJournal::RecordDiskLayoutPlan` derives the two GPT identifiers
from the original assignment binding, profile hash and independently reverified
VHDX identifier. The shared contract uses the same domain-separated derivation.
The read does not attach or partition a disk and leaves the five acknowledged
`GCCELLP1` records, provisioning plan hash and recovery behavior unchanged.

The private provisioning exchange now emits version 2 and accepts version 1
input. It computes `diskLayoutPlan` only from an exact complete five-record chain
with at least 64 MiB of virtual capacity. A supplied projection must match that
independent result; incomplete, forged or explicitly undefined projections are
rejected. Older 16 MiB records remain recoverable without a layout projection.
The existing protected assignment envelope still owns lease, credential,
worker/mesh admission and durable-parent authority. This projection does not
grant permission to initialize GPT or start a workload.

The shared 512-byte `GCCGPT01` decoder verifies the record digest, frozen disk and
file identities, fixed geometry, reserved partition, data extent, attributes and
name. Successor validation separately enforces phase order, predecessor digest
and unchanged observed layout. That slice added no attachment/layout checkpoint
mutation; native journal continuation is covered in the following section.

Fresh evidence:

- `verify:remote-worker:windows-cell-job` passed; normal and AddressSanitizer
  builds each execute 1,241 checks, including 175 layout and 304 provisioning
  journal checks. Evidence: `%TEMP%\Goat Worker Cell Job 9gyNiQ`;
  log: `.tmp/comparison-cell-layout-binding-native.log`.
- The shared TypeScript decoder accepts each build's four native layout records,
  and the exchange computes the same GPT identifiers as its recovered native
  journal. All 37 native source hashes matched that revision. Compact evidence:
  `.tmp/comparison-cell-layout-binding-proof.json`.
- The 23 focused contract, 48 worker and 47 Gateway protocol tests pass. The
  contract negative fixture was corrected to distinguish valid phase/attribute
  values from invalid values; runtime validation was not relaxed.
- `verify:remote-worker:windows-cell-provisioning` passes worker/Gateway
  typechecks and all eight native bridge cases, including its 16-test Gateway
  coordinator subprocess. Evidence:
  `%TEMP%\Goat Worker Provisioning Bridge 5mMab8`;
  log: `.tmp/comparison-cell-layout-provisioning-v2.log`.
- Three SQLite and three fresh PostgreSQL protected-exchange cases pass,
  including full-chain projection/replay, lease rotation, transaction rollback,
  and worker/mesh/parent revocation. The final PostgreSQL run exited successfully
  and stopped its verified temporary database. Logs:
  `.tmp/comparison-cell-layout-sqlite.log` and
  `.tmp/comparison-cell-layout-postgres-tests-v2.log`.
- Scoped ESLint and `pnpm docs:check` pass. Logs:
  `.tmp/comparison-cell-layout-binding-lint.log` and
  `.tmp/comparison-cell-layout-binding-docs.log`.

The component receipts explicitly retain `volumeLayoutExercised: false`,
`volumeAttachmentExercised: false` and `volumeDeviceBindingVerified: false`.
Installed controller attachment/layout persistence, interrupted-layout recovery,
formatting, mounting, quotas, executor/custody composition and ordinary assignment
startup remain open. The native backend stays inactive, and the earlier portable
ZIP was not rebuilt. This evidence does not close C5 or live acceptance.

## Durable native volume journal

`CellProvisioningJournal::ProvisionVolume` now composes the existing attachment,
bound-device and GPT layout owners. Only the original uninterrupted creator may
enter it after the five acknowledged creation records. It requires a matching
prepared anchor, bounded deadline/cancellation, current volume privilege and a
separate callback for current provisioning/zero-workload authority. The journal
continues to use its exclusive protected file and existing 64 KiB allocation
ceiling; the complete history is eleven 1,024-byte records.

The six `GCCVOL01` records retain attachment intent/completion and the four exact
nested `GCCGPT01` layout records. Each outer record binds the original
`disk_recorded` digest, assignment/profile, journal/control/backing identities,
capacity and derived GPT identifiers. The first volume record chains from the
fifth creation record; later records chain from their volume predecessor.
Unobserved layout payloads and reserved bytes must be zero. The original five
records are never rewritten.

Every record is validated, written, flushed and reread before the independent
committer receives it. Only its exact acknowledged outer digest permits the next
operation. The layout bridge acknowledges the nested digest only after that
outer commit succeeds. Missing/wrong acknowledgement, lost authority, late
completion, corruption or cancellation stops the creator. Final native readback
is followed by another authority/deadline check. Refusal keeps the live callback
stack and owned handles intact until `Close`; closing never detaches an uncertain
permanent attachment.

`OpenRecorded` requires all six exact independently retained volume records to
verify a completed volume journal. Legacy calls without that history refuse it
instead of silently projecting only the original creation records. Every
interrupted volume prefix returns incomplete without performing another write.
The caller still needs canonical reconciliation for unknown outcomes. Complete
metadata alone cannot replace actual attachment, backing dependency and layout
verification, and recovery never restores creation authority.

The new shared `remote-worker-cell-volume` contract independently checks the same
outer format, frozen anchor, phase order, hashes and nested layout chain. It does
not add a Gateway mutation or confer an execution permission. The native fixtures
use actual protected journal files and created VHDX files, with controlled
attachment and SDK driver replies for the volume operations. They cover each
lost acknowledgement, a wrong digest, authority loss after final observation,
every retained prefix, corrupt/rehashed metadata and preservation of the original
creation bytes. Real attached-disk layout writes remain unverified.

Fresh evidence for the final recovery and authority checks:

- `pnpm verify:remote-worker:windows-cell-job` passed. Normal and AddressSanitizer
  builds each execute 1,523 checks, including 586 journal and 175 layout cases.
  Evidence: `%TEMP%\Goat Worker Cell Job aKdSe5`;
  log: `.tmp/comparison-cell-volume-journal-native-final.log`.
- The shared decoder verifies each build's five creation records, six volume
  records and four nested layout records. All 37 native source hashes match the
  final files. Compact evidence: `.tmp/comparison-cell-volume-proof-final.json`.
- `pnpm verify:remote-worker:windows-cell-provisioning` passes worker/Gateway
  typechecks and all eight bridge cases, including the 16-test real Gateway
  coordinator subprocess. Evidence:
  `%TEMP%\Goat Worker Provisioning Bridge tMgYFr`;
  log: `.tmp/comparison-cell-volume-provisioning-final.log`.
- All 28 focused contract tests and scoped ESLint pass. Logs:
  `.tmp/comparison-cell-volume-contracts.log` and `.tmp/comparison-cell-volume-lint.log`.
  Documentation checks pass in `.tmp/comparison-cell-volume-docs.log`.
- No executable from this turn's retained native evidence directories remains
  running. These receipts follow the complete-history recovery fence and final
  authority check; earlier 1,504/1,506-check receipts are superseded. The first
  compile attempt caught a shadowed fixture variable, which was corrected.

The controller's private protocol and protected Gateway exchange still carry the
original five creation records. Persisting/transporting the volume continuation
through those owners is next source work. Formatting, mounting, quotas,
executor/custody composition, normal startup, service installation and two-machine
acceptance remain unfinished. The native backend is inactive and the portable
acceptance ZIP has not been rebuilt for these changes.

## Canonical volume checkpoint exchange

Provisioning exchange v3 carries a separate bounded `volumeRecords` chain and
accepts `cell.volume.checkpoint` through the existing protected settlement route.
Legacy v1/v2 inputs remain readable for creation records but cannot label volume
history. Complete creation records derive the volume anchor; nested layout bytes,
phase ordering, every hash and the exact acknowledged record are checked before
returning an exchange. Metadata does not grant native write or workload authority.

SQLite migration 222 and PostgreSQL migration 167 add an append-only volume table.
Each row binds the original fifth creation digest. Database guards require the
current native provisioning claim, matching plan/profile, no cleanup, and the next
sequence/hash. Repository and protected exchange transactions also verify the
worker credential, mesh admission, parent run and current assignment lease. A
parent cancellation after insertion rolls back the checkpoint; an exact retry
remains readable only while authority is current. Expired or revoked authority
cannot append or acknowledge a replay. Retained records remain inspectable.
The manifest update appends one row per database without changing any prior row.

Both the worker creation coordinator and Gateway creation service explicitly
refuse to certify volume recovery through their five-record native ports. The
Gateway returns `volume_verification_unavailable` with retained evidence. No
native volume invocation, platform-ready transition or assignment activation was
added in this step.

Fresh local evidence for this source:

- 29 focused contract tests, 62 Gateway tests and 50 worker tests pass. Logs:
  `.tmp/comparison-cell-volume-exchange-contracts.log`,
  `.tmp/comparison-cell-volume-exchange-gateway.log`, and
  `.tmp/comparison-cell-volume-exchange-worker.log`.
- Three protected SQLite exchange cases and the claim-expiry case pass in
  `.tmp/comparison-cell-volume-exchange-sqlite.log` and
  `.tmp/comparison-cell-volume-exchange-expiry.log`. All 27 SQLite migration tests
  pass in `.tmp/comparison-cell-volume-exchange-sqlite-migrations.log`.
- Four actual PostgreSQL cases pass, including protected revocation, expiry and
  independent connection races. The owned loopback cluster was stopped and its
  evidence retained at
  `%TEMP%\gc-cell-volume-exchange-pg-3iqz2y4g.qy2`.
  Log: `.tmp/comparison-cell-volume-exchange-postgres-run-v2.log`.
- `pnpm verify:storage:migration-parity` passes all 27 manifest tests, 24 integrity
  tests and 45 runtime-schema tests for SQLite 222/PostgreSQL 167. Log:
  `.tmp/comparison-cell-volume-exchange-migrations-v4.log`. Earlier attempts caught
  a copied checksum character and stale reviewed version/count assertions; those
  were corrected before the passing run.
- Storage, Gateway and worker typechecks pass. Scoped ESLint reports no errors
  and the existing Gateway protocol-file length warning. The asynchronous Gateway
  boundary lane passes its 10 tests and scan of 989 production files. Logs:
  `.tmp/comparison-cell-volume-exchange-typecheck-v2.log`,
  `.tmp/comparison-cell-volume-exchange-lint.log`, and
  `.tmp/comparison-cell-volume-exchange-async-boundary.log`.
- `pnpm verify:remote-worker:windows-cell-provisioning` passes all eight bridge
  cases and its 17-test Gateway subprocess, with no failures or pending tests.
  Evidence: `%TEMP%\Goat Worker Provisioning Bridge vRffj5`;
  log: `.tmp/comparison-cell-volume-exchange-provisioning-v2.log`. The first attempt
  respected the active migration output lock; verification ran after it released.
  The task-owned native processes are stopped. This proves creation/recovery
  compatibility and the new refusal path, not native volume execution.

At this step the controller's private protocol still carried only the original
creation sequence. The subsequent continuation is recorded below. Real
attached-disk operations, formatting, mounting, quotas, protected execution,
installed services, two-machine and Telegram/provider acceptance remain open.
The native backend is inactive; C5/C6 and the full plan remain in progress.

## Controller volume continuation

The controller protocol now has separate operations for uninterrupted creation
through volume layout and read-only recovery of all eleven records. Existing
creation-only operations retain their original wire bytes. The volume recovery
request carries six fixed-size canonical records, bound to the connection nonce,
creation anchor and plan. The native client validates the outer volume chain and
its nested GPT checkpoints before forwarding a record.

Each current-authority challenge carries a monotonically increasing ordinal,
the global checkpoint count and the last retained digest. The helper forwards
this bounded challenge through its existing pinned controller connection. The
worker refreshes the protected Gateway snapshot, verifies unchanged creation and
volume history, and returns the exact challenge only after current authority
passes. Every checkpoint still requires its own canonical acknowledgement. A
single native deadline bounds the conversation, with at most 256 authority
checks and eleven checkpoints; controller identity is rechecked after callbacks.

The trusted Windows startup composition requires volume preparation. Its
coordinator commits the five creation and six volume records in order, refuses
partial-history restart without invoking creation, and compares both complete
chains during recovery. Legacy creation-only callers continue to refuse volume
history. A missing installed controller or volume owner cannot fall back to
direct creation, and a recovered native journal cannot resume writes.

New private-stream tests exposed a missing consumer-side authority fence: the
worker could forward another volume checkpoint or accept a success receipt
without an authority challenge for the latest retained state. The worker and
native client now reject both cases. Stdin remains open after checkpoint eleven
so final native verification can obtain fresh authority before the receipt.

Fresh evidence for this source:

- All 132 focused worker tests pass across the provisioning client, coordinator,
  installed startup, custody and private volume stream files. They cover stale or
  replayed authority, missing authority before/between/after volume records,
  callback cancellation, wrong commit digests, bounded conversations, full
  recovery and refusal of partial history. Log:
  `.tmp/comparison-cell-volume-controller-worker-tests-v4.log`.
- All 29 focused contract tests pass, including deriving the volume anchor from
  the exact complete creation chain and rejecting sparse/accessor/extra-key,
  mismatched-plan and insufficient-capacity input. Log:
  `.tmp/comparison-cell-volume-controller-contract-tests-v2.log`.
- `pnpm verify:remote-worker:windows-cell-controller-protocol` passes 2,476 checks
  in each normal and AddressSanitizer build, with 46 sessions and 37 production
  native-client sessions. Its successful volume journal flow obtains 42 current
  authority acknowledgements and independently flushes all eleven records. It
  also checks lost authority, incorrect acknowledgements, malformed challenges,
  missing owner composition and unchanged retained bytes after refused recovery.
  Evidence: `%TEMP%\Goat Cell Controller Protocol ANbfIU`;
  log: `.tmp/comparison-cell-volume-controller-protocol-v3.log`.
- The controller fixture uses real pipe identity, journal files, VHDX creation
  and flushed acknowledgement files with controlled attachment/layout replies.
  Exact full-history client recovery is tested against controlled server frames;
  real native recovery correctly refuses the unattached fixture. These are
  separate component boundaries, without installed services or physical layout
  operations.
- Current TypeScript contracts decode all eleven actual controller fixture
  records from each native build and validate both chains. The receipt retains
  hashes for 49 source/build inputs:
  `.tmp/comparison-cell-volume-controller-cross-language.json`.
- `pnpm verify:remote-worker:windows-cell-provisioning` passes all eight cases,
  including its 17-test Gateway subprocess and explicit refusal of volume
  operations through direct or uninstalled controller paths. Worker and Gateway
  typechecks pass in the same invocation. Evidence:
  `%TEMP%\Goat Worker Provisioning Bridge xc4ZXa`;
  log: `.tmp/comparison-cell-volume-controller-provisioning-v4.log`.
- `pnpm verify:remote-worker:windows-cell-job` passes its full component lane,
  including 1,523 checks in each native build. Evidence:
  `%TEMP%\Goat Worker Cell Job z6zfKG`;
  log: `.tmp/comparison-cell-volume-controller-native-job-v3.log`.
- The controller payload test passes two byte-identical builds for each of
  Windows x64 and ARM64, with the reviewed 29-file source inventory. Evidence:
  `%TEMP%\Goat Controller Payload Y3aHxM`;
  log: `.tmp/comparison-cell-volume-controller-payload-v4.log`. This proves
  compilation/reproducibility; ARM64 execution and installation were not run.
- Scoped ESLint, documentation checks and whitespace checks pass. Earlier
  attempts caught the coordinator fixture's shadowed exchange value, missing
  device/layout build inputs, the three authority-fence regressions and a mock
  callback type mismatch. The packaging check also updated the reviewed source
  inventory count for those four added inputs. The passing runs above follow
  their respective fixes. All task-owned proof processes have exited.

This completes the source transport/coordinator connection to the native volume
journal. It does not establish installed-controller authority or physical volume
acceptance. Formatting, mounting, quotas, protected runtime/executor custody,
normal assignment activation, interrupted-claim reconciliation, two-machine
testing and Telegram/provider acceptance remain unfinished. The native backend
stays inactive; C5/C6 and the full C0-C6 plan remain in progress.

## Worker assignment runtime read API

The read-only operator route is
`GET /api/v1/ops/workspaces/:workspaceId/remote-worker-assignments/:assignmentId/runtime`.
Its public contract is `RemoteWorkerAssignmentRuntime` in
`packages/contracts/src/remote-worker-runtime-read.ts`; the storage owner is
`RemoteWorkerRuntimeReadRepository`. Production composition reaches that owner
through asynchronous Gateway storage. The existing registry and assignment v1
projections are unchanged; their consumers can adopt this separate endpoint.

- The response selects the current assignment generation on the server and
  rechecks its manifest and worker bindings after reading the owners. A changed
  generation returns 409 instead of mixing generations. An unknown assignment
  returns 404; an unstarted assignment has null generation and null summaries.
- Canonical model-usage aggregation preserves known zero, missing metrics,
  partially known cost and uncertain dispatches. Exact inference operation and
  dispatch references scope attribution; unrelated operations are excluded.
- Outstanding request and cost reservations are separate from provider usage.
  The read includes the interval between reservation commit and receipt
  attachment. Missing or ambiguous usage keeps its hold visible. Reservations
  are not charges and must not be added to recorded cost as a final bill.
- Cell execution, cleanup, backup, capacity and retained footprint values are
  stored observations with their revisions and update time. They do not establish
  current OS/process health. Live connection health remains unavailable.
- Artifact counts distinguish uploads and committed manifests. Effect counts
  include receipts requiring manual reconciliation. Responses omit artifact
  paths, effect arguments, native identities, credentials and raw owner records.
- Reads use pure usage aggregation, without constructing the usage recovery
  owner. Independent owner updates can appear on a subsequent read; this is not
  a transactionally atomic or live-health snapshot.
- Operator authentication, rate limits, no-store headers, strict query validation
  and redacted errors apply. Callers cannot select an assignment generation or
  request raw data through query parameters.

Validation:

- `.tmp/comparison-worker-runtime-read-sqlite-v4.log`: four scenarios pass,
  including read-only execution, unattached holds, partial/uncertain usage,
  unstarted assignments, committed artifacts, cell capacity, manual effect
  reconciliation, scope isolation and a changed-generation observation.
- `.tmp/comparison-worker-runtime-read-postgres-tests-v1.log`: the same four
  scenarios pass against PostgreSQL 16 in a task-owned disposable cluster.
  The cluster was stopped after checking process/data-directory/port ownership;
  retained evidence is under
  `%TEMP%\gc-worker-runtime-read-pg-cmcvndmu.vbn`.
- `.tmp/comparison-worker-runtime-read-contracts-v1.log`: 13 tests pass, including
  identity/truth validation and rejection of executable accessors in cell data.
- `.tmp/comparison-worker-runtime-read-gateway-v1.log`: 45 route/service tests
  pass, including operator-access refusals, scope binding, missing owner/record,
  conflict responses and secret-safe errors.
- `.tmp/comparison-worker-runtime-read-usage-regression-v1.log`: all 29 existing
  model-usage tests pass after sharing the pure summary query.
- `.tmp/comparison-worker-runtime-read-typecheck-v3.log`: Gateway and its ten
  dependency packages pass typechecking using the output lock.
- `.tmp/comparison-worker-runtime-read-async-boundary-v1.log`: ten verifier
  tests and the production asynchronous-boundary scan pass.
- `.tmp/comparison-worker-runtime-read-lint-v1.log`: the 14 edited source/test
  files pass ESLint with zero warnings.

This supplies the stored-record read API for the separate UI implementation.
It does not activate the native worker, prove live connection health, or complete
Windows installation/execution, two-machine, Telegram or provider acceptance.
C1-C6 and the full implementation plan remain in progress.

## Authenticated worker contact

The assignment-runtime endpoint's `connectionHealth` descriptor now supports a
`derived_projection` owned by `storage.remoteWorkerNonces`. Its
`RemoteWorkerContactProjection` is a bounded authentication observation:

- `freshness` is `recent`, `stale` or `not_observed`.
- `lastAuthenticatedAt` comes from the database-written `consumed_at` of retained
  credential-request nonces for the exact registry workspace, worker ID and worker
  generation. Bootstrap nonces and client-authored request timestamps are excluded.
- `evaluatedAt` is the database clock, and `staleAfter` is acceptance plus exactly
  60 seconds. Equality with that deadline is stale. A database-clock rollback
  before the observed acceptance time is rejected rather than labeled recent.
- `retention` is `replay_window`. Existing nonce maintenance can remove evidence;
  the following read becomes `not_observed`, with null timestamps. It does not
  establish that the worker is offline or has never contacted the Gateway.
- `connectionStatus` remains `unavailable`. The native listener deliberately
  closes each request's connection, and a prior authenticated request does not
  prove a currently open socket, successful work, execution readiness or current
  authorization. UI copy should say "authenticated contact" and retain the
  canonical admission/control/lease and cell-state sections separately.
- The read does not consume, refresh or prune nonces. Replaying an already
  consumed nonce cannot advance contact time. No nonce hashes, credential IDs,
  client timestamps, certificates or transport secrets enter the response.
- Unstarted assignments and older unavailable responses remain supported by the
  same runtime-read normalizer. The previous registry/assignment v1 endpoints
  still keep their unavailable fields; consumers use the runtime endpoint.

Fresh proof for this extension:

- `.tmp/comparison-worker-contact-sqlite-v1.log`: all six runtime-read scenarios
  pass, including future client timestamps, exact freshness boundaries, clock
  rollback through an injected read clock, replay, generation/workspace isolation
  and actual expiry/pruning.
- `.tmp/comparison-worker-contact-postgres-tests-v1.log`: the same six scenarios
  pass on PostgreSQL 16. The task-owned cluster at
  `%TEMP%\gc-worker-contact-pg-p2nhirft.hm5`
  was stopped after checking process/data-directory/port ownership.
- `.tmp/comparison-worker-contact-contracts-v1.log`: 15 contract tests pass.
- `.tmp/comparison-worker-contact-gateway-v1.log`: 45 Gateway route/service tests
  pass with the extended contract.
- `.tmp/comparison-worker-contact-nonce-regression-v1.log`: all 13 existing nonce
  security tests pass, including revoked/rotated authorities, restart replay,
  malformed writes, early deletion and bounded maintenance.
- `.tmp/comparison-worker-contact-typecheck-v1.log`: Gateway and its ten
  dependency packages pass typechecking under the output lock.
- `.tmp/comparison-worker-contact-lint-v1.log`: the six changed source/test files
  pass ESLint with zero warnings.
- `.tmp/comparison-worker-contact-async-boundary-v1.log`: all ten verifier tests
  pass and the production scan passes across 989 TypeScript files.
- `.tmp/comparison-worker-contact-docs-v1.log`: `pnpm docs:check` passes.
- The eight changed source/test/documentation files pass scoped whitespace
  checks, including untracked files. Their SHA-256 values are recorded in
  `.tmp/comparison-worker-contact-source-hashes-v1.json`.

This adds an honest last-contact signal for UI integration without changing
admission, replay protection, execution authority or the native activation gate.
Installed Windows execution, two-machine and Telegram/provider acceptance,
comparable live benchmarks and the full C1-C6 completion gates remain open.

## Native volume binding

`CellVirtualDiskVolume` in `apps/remote-worker-windows-cell-native/src/` now finds
the volume belonging to an independently verified, completely journaled GPT data
partition. This closes the source gap between the existing physical-device/layout
owners and the formatter that is still required:

- The caller supplies the existing layout owner and protected workspace, never a
  disk number, drive letter, volume path or raw device handle.
- Binding retains its own layout, attachment and backing-file handles. It queries
  the device number from that owned VHDX, bounds discovery to 4,096 volumes, and
  accepts one exact data extent. Matching candidates must also have the expected
  storage-device type, partition number, GPT partition ID/type, extent, name and
  no-drive-letter attribute. Missing, inaccessible and multi-extent volumes cannot
  be selected; duplicate matching names and failures after a match are rejected.
- Verification checks the current layout before and after each identity read,
  and separately checks the held volume handle and a fresh open of its GUID name.
  Changed identity clears the bound state. Signed-length overflow, truncated or
  oversized driver replies and nonliteral paths fail closed.
- Binding uses zero-access volume-device handles and query IOCTLs. The formatter's
  NTFS query opens the same GUID root with attribute access and no-follow flags.
  Closing these handles does not detach or remove the VHDX.
  Pending overlapped queries are cancelled and joined on timeout. Synchronous
  enumeration/open calls still require the controller's outer watchdog.

The Windows API basis is Microsoft's
[volume extent query](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-ioctl_volume_get_volume_disk_extents),
[extent buffer contract](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-volume_disk_extents)
and [volume enumeration](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-findfirstvolumew).
SDK-shaped component replies exercise the real selection and validation sequence;
they do not establish that an attached RAW volume was discovered on this host.

Fresh proof:

- `pnpm verify:remote-worker:windows-cell-volume` passes 348 component checks in
  each normal/AddressSanitizer build and compiles the same source for ARM64.
  ARM64 was not executed. Evidence:
  `.tmp/comparison-cell-volume-binding-v2.log` and
  `%TEMP%\Goat Worker Volume Binding gNgWfG`.
- `pnpm verify:remote-worker:windows-cell-job` passes 1,871 checks in each native
  normal/AddressSanitizer run, including these 348 new checks. The receipt reports
  `volumeBindingExercised`, `volumeLayoutExercised` and
  `volumeAttachmentExercised` as false. Evidence:
  `.tmp/comparison-cell-volume-binding-job-v1.log` and
  `%TEMP%\Goat Worker Cell Job QRGz1h`.
- Portable acceptance source inventories include the new owner and test. All six
  inventory/staging checks pass in
  `.tmp/comparison-cell-volume-binding-acceptance-files-v1.log`.
- ESLint passes for the three changed packaging modules in
  `.tmp/comparison-cell-volume-binding-lint-v1.log`.

The binding primitive does not format, mount, apply quotas, launch work or activate
the native backend. The formatter primitive below extends this source; its
controller/canonical-journal integration remains required. Actual attached-volume
binding, installed services, physical two-machine tests, Telegram/provider
acceptance and comparable live benchmarks remain open. All task-owned proof
processes were absent at cleanup verification; no pre-existing service was stopped.

## Native NTFS formatter

`CellNtfsFormat` and its private `CellNtfsFormatWmi` adapter add the native source
operation following GPT/volume binding. The public primitive takes an existing
layout, protected workspace and canonical commit/authorization callbacks. It does
not accept a caller-chosen path, filesystem, force flag, command or raw handle.

- The Windows adapter selects the exact bound GUID volume through local
  `MSFT_Volume` metadata. RAW metadata must agree with the kernel probe. A known
  filesystem, inconsistent identity or existing mount path stops creation.
- The fixed operation is quick NTFS formatting with a 4,096-byte allocation unit
  and the `GoatCitadel cell` label. Force, compression, short-name support and
  large FRS are disabled. `DisableHeatGathering` stays false, and the ReFS-only
  integrity parameter is omitted. There is no retry with force or a different
  filesystem.
- Two 512-byte `GCCNTF01` checkpoints bind the exact retained layout hash, volume
  GUID, partition capacity and format settings. The completion also records the
  NTFS serial, sector count and cluster count. Exact order, zero padding and
  SHA-256 chaining are checked; the format is independently reconstructed by the
  JavaScript proof harness.
- The intent must be independently acknowledged before Windows receives the
  format. Authority, bound volume identity and RAW state are rechecked after the
  acknowledgement and after WMI preparation, immediately before submission.
- Completion requires fresh NTFS geometry/identity readback, renewed authority,
  an exact completion acknowledgement and another identity read after that wait.
  Lost acknowledgements, provider errors/timeouts, cancellation and identity or
  authority changes leave the operation unknown and preserve submitted records.
- `OpenRecorded` verifies a complete two-record history without a format, commit
  or authorization callback. An incomplete intent cannot resume writes, and a
  changed filesystem cannot satisfy the earlier completion.
- WMI result polling and driver queries use the bounded deadline. Synchronous
  provider calls still require the controller watchdog; terminating the client
  does not prove that a submitted Windows format has stopped. Such work requires
  reconciliation, not automatic retry or resource removal.

A read-only host probe found that a zero-access volume-device handle can inspect
partition metadata but does not service NTFS filesystem queries. The production
NTFS probe now opens the exact GUID filesystem root with attribute access and
no-follow flags, checks its directory/reparse attributes, and queries NTFS data.
The final tests exercise that production query on an existing Windows filesystem.
They do not treat the system volume as an admitted cell or format it.

API references:
[MSFT_Volume.Format](https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/format-msft-volume),
[MSFT_Volume metadata](https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-volume),
[semisynchronous WMI invocation](https://learn.microsoft.com/en-us/windows/win32/api/wbemcli/nf-wbemcli-iwbemservices-execmethod)
and [NTFS volume data](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_get_ntfs_volume_data).

Fresh proof:

- `pnpm verify:remote-worker:windows-cell-format`: 1,262 component checks and 24
  read-only Windows schema/query checks pass in each normal/AddressSanitizer
  build. The same source compiles for ARM64, which was not executed. Evidence:
  `.tmp/comparison-cell-ntfs-format-v4.log` and
  `%TEMP%\Goat Worker NTFS Format qTfHbX`.
- `pnpm verify:remote-worker:windows-cell-job`: 3,133 checks pass in each native
  normal/AddressSanitizer run, including all 1,262 formatter checks. Its
  `ntfsFormatExercised`, `volumeBindingExercised` and `volumeLayoutExercised`
  fields remain false. Evidence: `.tmp/comparison-cell-ntfs-format-job-v1.log`
  and `%TEMP%\Goat Worker Cell Job HtImB5`.
- The portable acceptance inventory includes the new owner, adapter and tests;
  all six inventory/staging checks pass in
  `.tmp/comparison-cell-ntfs-format-inventory-v1.log`.
- The changed packaging modules pass ESLint with zero warnings in
  `.tmp/comparison-cell-ntfs-format-lint-v1.log`.

The native journal integration is recorded below. The production controller
protocol and canonical Gateway storage do not yet invoke or retain formatting.
That integration, actual VHDX formatting and recovery, root protection, mounting,
quotas, executor/custody composition, installer and physical two-machine acceptance
remain required. No format or privileged installation was performed on this host.

## Durable native format journal

`CellProvisioningJournal::ProvisionFormat` now composes the bound NTFS formatter
after complete volume provisioning. Only the original uninterrupted creator can
enter, using the same independently retained anchor and current exclusive
provisioning/zero-workload authority.

- Two 1,024-byte `GCCFMT01` records append to the same protected file. All five
  `GCCELLP1` and six `GCCVOL01` records stay byte-for-byte intact, and the existing
  64 KiB post-operation allocation ceiling stays unchanged. This is not a quota
  or a transient allocation guarantee.
- Each outer record binds the assignment, profile, VHDX capacity/identity,
  journal/control/backing identities, GPT identifiers, final volume-record hash
  and exact 512-byte `GCCNTF01` checkpoint. Nested format geometry and layout
  hashes are checked against the complete retained GPT chain.
- The journal flushes, rereads and independently acknowledges the exact outer
  bytes before acknowledging the formatter's nested digest. Authority is checked
  before and after that wait, around formatting and after final native readback.
- Lost/wrong acknowledgements, revoked authority, cancellation, malformed nested
  bindings and provider timeouts stop the owner and retain its local evidence.
  An intent-only history never resumes formatting.
- Complete recovery requires the exact six canonical volume records and both
  canonical format records before reopening the volume. It verifies the recorded
  NTFS identity without writing. Legacy recovery cannot silently ignore formatting;
  incomplete, torn, extended or rolled-back histories require reconciliation.
- The provisioning helper and controller source inventories include the formatter,
  WMI adapter and volume owner. Their existing protocol does not yet expose a
  format operation or transport the new records to canonical Gateway storage.

Fresh proof:

- `pnpm verify:remote-worker:windows-cell-job`: 3,641 checks in each normal and
  AddressSanitizer build, including 1,094 journal and 1,262 formatter checks.
  Twelve new journal scenarios use real protected journal files and unattached
  VHDX creation with controlled attachment/GPT/format responses. Fresh readers
  verify persisted histories, and independent JavaScript reconstructs both full
  formatting records. Evidence: `.tmp/comparison-cell-format-journal-job-v2.log`
  and `%TEMP%\Goat Worker Cell Job V0X0aO`.
  The initial v1 compile caught a signed/unsigned test comparison, fixed before
  the passing v2 run.
- `pnpm verify:remote-worker:windows-cell-controller-protocol`: 2,476 checks and
  46 sessions in each normal/AddressSanitizer build. Existing creation/volume
  transport and interactive service refusal still pass. Evidence:
  `.tmp/comparison-cell-format-journal-controller-v1.log` and
  `%TEMP%\Goat Cell Controller Protocol 305Knc`.
- `pnpm verify:remote-worker:windows-cell-provisioning`: worker/Gateway typechecks
  and all eight helper/Gateway bridge checks pass, including real creation,
  recovery, lost acknowledgements and custody refusal. Evidence:
  `.tmp/comparison-cell-format-journal-provisioning-v1.log` and
  `%TEMP%\Goat Worker Provisioning Bridge ys1j1h`.
- The controller payload builds reproducibly twice for both x64 and ARM64 with
  all 35 retained source inputs. This is build evidence; ARM64 was not executed
  and no service was installed. Evidence:
  `.tmp/comparison-cell-format-journal-payload-v1.log` and
  `%TEMP%\Goat Controller Payload OfpjtX`.
- All six portable inventory/staging checks pass in
  `.tmp/comparison-cell-format-journal-inventory-v1.log`.
- Changed packaging modules pass ESLint with zero warnings in
  `.tmp/comparison-cell-format-journal-lint-v1.log`.

The formatting proof is component-level: no volume was attached, partitioned or
formatted by these tests. Controller/Gateway format transport, canonical storage,
physical NTFS formatting/recovery, protection, mounting, quotas, executor/custody
composition, installed-service acceptance and normal assignment activation remain
required. The native backend remains inactive.

## Canonical format checkpoint exchange

Shared format contracts now decode the fixed outer journal and nested NTFS
records. They bind the complete six-record volume history, both hash chains,
volume identity, layout and filesystem geometry. The unsigned NTFS serial stays
as exact bytes. Bounded, frozen exchange v4 preserves the earlier creation and
volume histories; older v1-v3 inputs cannot smuggle format history into recovery.

SQLite 223 and PostgreSQL 168 add immutable format checkpoint storage. The
repository requires the current provisioning claim and complete volume history,
accepts exact replay, and refuses replacement or out-of-order completion. The
protected exchange checks assignment, worker, mesh and parent authority before
and after persistence; a post-write authority change rolls the transaction back.
Raw inserts use database-clock expiry and cannot backdate authority through a
caller timestamp. Existing format evidence remains readable after revocation.

Gateway and worker acknowledgements must contain the exact submitted format
record. The existing native coordinator explicitly refuses retained format
history before entering its creation/volume-only native port. Format-capable
controller/helper transport is still required; the new metadata does not grant
platform readiness or permission to format a volume.

Fresh proof:

- Four contract files / 38 tests pass, covering format records, chain validation,
  invalid geometry, malformed arrays and exchange-version compatibility:
  `.tmp/comparison-cell-format-exchange-contracts-v1.log`.
- Four SQLite scenarios and four real PostgreSQL scenarios pass, with no skips.
  They cover retained facts, exact replay, stale assignment/credential/claim
  rejection, worker/mesh/parent revocation, post-write rollback, database-clock
  expiry and database immutability. The PostgreSQL lane also repeats the existing
  two-connection provisioning/capacity races. Evidence:
  `.tmp/comparison-cell-format-exchange-sqlite-v2.log` and
  `.tmp/comparison-cell-format-exchange-postgres-tests-v2.log`.
  Its isolated PostgreSQL cluster was verified and stopped; evidence remains at
  `%TEMP%\gc-cell-format-exchange-pg-pggcujj0.ui0`.
- Worker client/coordinator tests: 51 passed. Protected Gateway protocol tests:
  49 passed. Evidence: `.tmp/comparison-cell-format-exchange-worker-v1.log` and
  `.tmp/comparison-cell-format-exchange-gateway-v1.log`.
- The shared decoder accepts all 13 exact records from each previously generated
  native normal/AddressSanitizer journal fixture:
  `.tmp/comparison-cell-format-exchange-native-bytes-v1.log`. This reuses retained
  component evidence and does not perform physical formatting.
- `pnpm verify:storage:migration-parity` passes 27 manifest, 24 integrity and
  45 runtime-schema tests, with 223 SQLite / 168 PostgreSQL migrations. The new
  SQLite migration-version assertion also passes. Evidence:
  `.tmp/comparison-cell-format-exchange-migrations-v2.log` and
  `.tmp/comparison-cell-format-exchange-sqlite-versions-v1.log`.
  The initial PostgreSQL run caught the new migration's raw-SQL checksum where
  the runtime requires its normalized atomic payload checksum. Only this
  unreleased migration and its manifest entry were corrected; all other
  manifest entries were verified unchanged before the passing rerun.
- `pnpm verify:gateway:async-boundary` passes ten tests and scans 989 production
  files: `.tmp/comparison-cell-format-exchange-async-boundary-v1.log`.
- `pnpm verify:remote-worker:windows-cell-provisioning` passes all eight native
  helper/Gateway bridge checks and worker/Gateway typechecks. Contracts/storage
  typechecks also pass. Evidence:
  `.tmp/comparison-cell-format-exchange-provisioning-v1.log` and
  `.tmp/comparison-cell-format-exchange-types-v2.log`.
  The bridge uses temporary native fixtures retained at
  `%TEMP%\Goat Worker Provisioning Bridge CjNEhN`;
  it does not certify an installed service or exercise physical formatting.
- ESLint reports zero errors across the 22 checked source/test files. Strict
  zero-warning lint remains nonzero for the protocol service's existing
  1,023-line / 1,000-line warning, verified identical without the new format
  branches; the other 21 files have zero warnings. Evidence:
  `.tmp/comparison-cell-format-exchange-lint-v2.log` and
  `.tmp/comparison-cell-format-exchange-lint-review-v1.log`.

Controller/helper format continuation, physical NTFS formatting/recovery,
protection, mounting, quotas, executor/custody composition, installed-service
acceptance and normal assignment activation remain required. C5 stays in progress
and the native backend remains inactive.

## Controller format continuation

The native controller and its client now have explicit format-aware creation and
recovery operations. Existing creation-only and volume-only wire operations keep
their earlier record shapes. Format creation uses the original live journal and
refuses a missing formatter owner before creating any resources. The controller
retains and acknowledges all thirteen ordered records, with fresh authority
checks at the formatting boundaries and after completion before a success
receipt. Numbered challenges bind the connection nonce, canonical record count
and exact retained head; creation, volume and format share one deadline and the
same 256-check ceiling.

Format recovery transports the complete six-record volume history plus both
format records. The native client validates each chain and compares every
recovered volume/format record with its independently retained bytes. Incomplete
history, changed metadata, stale authority, a lost acknowledgement or uncertain
formatting never authorizes another write. Legacy recovery cannot silently
discard format evidence.

The pinned helper forwards these operations only through the installed
controller path. Worker startup now requires the complete format stage and uses
the current rotated lease for its canonical exchanges. A consumed creation
decision remains consumed across restart; a partial format prefix returns
reconciliation. The ordinary assignment executor and backend activation still
require the protected runtime described in the remaining work below.

Fresh proof:

- `pnpm verify:remote-worker:windows-cell-controller-protocol` passes 5,602 checks
  across 67 sessions in each normal/AddressSanitizer build, including 58 sessions
  using the production native client. A complete formatted fixture performs 66
  authority checks. Tests retain actual journal files and unattached VHDX files,
  while attachment, layout and NTFS responses are controlled. The client accepts
  exact thirteen-record recovery frames; real recovery refuses the unattached
  fixture and preserves its bytes. Evidence:
  `.tmp/comparison-cell-format-controller-native-v2.log` and
  `%TEMP%\Goat Cell Controller Protocol PnJHEG`.
  The initial run exposed the test reader's earlier eleven-record size limit;
  it was updated to the new bounded thirteen-record history before this rerun.
- All 152 focused worker tests pass, including binary format transport, exact
  acknowledgements, interrupted formatting, retained-history recovery, rotated
  leases, cancellation, custody and refusal of fallback:
  `.tmp/comparison-cell-format-controller-worker-v1.log`.
- `pnpm verify:remote-worker:windows-cell-provisioning` passes all eight existing
  helper/Gateway regression checks and worker/Gateway typechecks. This proves
  the creation bridge remains intact; it is not physical formatting acceptance.
  Evidence: `.tmp/comparison-cell-format-controller-provisioning-v1.log` and
  `%TEMP%\Goat Worker Provisioning Bridge QrK80t`.
- Controller payloads build reproducibly twice for both x64 and ARM64 with all
  35 retained production source inputs. ARM64 was compiled, not executed.
  Evidence: `.tmp/comparison-cell-format-controller-payload-v1.log` and
  `%TEMP%\Goat Controller Payload ftKeQz`.
- The worker typecheck and all seven changed TypeScript/test/packaging modules
  pass ESLint with zero warnings:
  `.tmp/comparison-cell-format-controller-types-v2.log` and
  `.tmp/comparison-cell-format-controller-lint-v1.log`.

No volume was physically attached, partitioned or formatted in these tests.
Physical NTFS formatting/recovery, root protection, mounting, quotas, protected
executor/custody composition, installed-service acceptance and normal assignment
activation remain required. C5 stays in progress and the native backend remains
inactive.

## Native volume root protection

`CellVolumeProtection` accepts an original successful `CellNtfsFormat` owner and
the already verified controller workspace. It accepts no drive letter, caller
volume path, raw disk handle, arbitrary descriptor or repair flag. Its security
descriptor must match the workspace's frozen owner/controller descriptor. The
original formatter can be consumed once; reopened history cannot authorize a
protection write, and an uncertain attempt cannot be retried through a new owner.

The component independently reopens the complete format history and checks the
volume GUID, exact NTFS serial/geometry, root file identity, normalized name,
directory attributes and alternate streams. It pins a root handle that excludes
data-write and delete/rename opens. Its intent/completion checkpoints bind the
format digest, security digest and root identity. Exact acknowledgements and
current authority precede progress. Read-only recovery requires both records
and verifies current permissions without repairing them. The root permission
write uses the handle-based Windows API; ownership, group, protected DACL and
mandatory integrity label are checked afterward. API references:
[SetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo),
[FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)
and [SECURITY_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-information).

Review also reproduced two timing gaps in controlled fixtures. Root permissions
could change during the last authorization exchange, and the formatter could
miss a filesystem created during its final pre-submission exchange. Native
identity, RAW state and completion readback now follow the relevant authority
exchanges. The formatter retains both existing authorization fences and checks
mount paths again after its send guard. These changes preserve its checkpoint
bytes and prohibit certification after a changed completion identity.

Fresh proof:

- `pnpm verify:remote-worker:windows-cell-protection` passes 1,193 component
  checks and 40 actual NTFS temporary-directory checks in each normal and
  AddressSanitizer build. It exercises exact native permission application,
  readback, competing data/delete handles, read-only reopen, extra-grant drift,
  alternate streams, unchanged sibling identity/security, partial recovery,
  revoked authority and lost/mismatched acknowledgements. An independent Node
  encoder matches both 512-byte records. ARM64 compiles without execution.
  Evidence: `.tmp/comparison-cell-root-protection-native-v4.log` and
  `%TEMP%\Goat Worker Volume Protection dWCxIW`.
- `pnpm verify:remote-worker:windows-cell-format` passes 1,277 component checks
  and 24 read-only Windows checks in each normal/AddressSanitizer build. The new
  regression refuses a newly detected filesystem before any controlled format
  submission and refuses identity drift during final authorization. ARM64
  compiles. Evidence: `.tmp/comparison-cell-root-protection-format-v2.log` and
  `%TEMP%\Goat Worker NTFS Format mv4B0s`.
- The reproduced failures are retained in
  `.tmp/comparison-cell-root-protection-authority-race-v1.log` and
  `.tmp/comparison-cell-root-protection-format-race-v1.log`. An initial compile
  also caught a signed/unsigned comparison in the new test fixture; it was fixed
  before the passing runs.
- `pnpm verify:remote-worker:windows-cell-controller-protocol` passes 5,602 checks
  across 67 sessions, including 58 native-client sessions, in each normal and
  AddressSanitizer build. The formatted sequence retains its 66 authority
  checks and unchanged thirteen-record wire history. Its journal/VHDX fixtures
  remain unattached. Evidence:
  `.tmp/comparison-cell-root-protection-controller-v2.log` and
  `%TEMP%\Goat Cell Controller Protocol Tmoxd7`.
- Controller payloads build reproducibly twice for both x64 and ARM64, with
  37 production inputs including the new protection component. Evidence:
  `.tmp/comparison-cell-root-protection-payload-v2.log` and
  `%TEMP%\Goat Controller Payload UpX9ZT`.
- The three changed packaging modules pass strict ESLint with zero warnings,
  and `pnpm docs:check` passes. Logs:
  `.tmp/comparison-cell-root-protection-lint-v1.log` and
  `.tmp/comparison-cell-root-protection-docs-v2.log`.

No drive was physically attached, partitioned or formatted. The root-permission
tests changed only exclusively created task-owned temporary directories. The
new protection owner is compiled in the controller payload, but durable journal
and canonical exchange integration remain required before it can be invoked by
the installed controller. It does not attest mutable children, quotas, mounting,
runtime-bundle custody, protected assignment execution or two-machine behavior.
C5 and the full program remain in progress; the native backend stays inactive.

## Durable native protection journal

`CellProvisioningJournal` now composes `CellVolumeProtection` after the complete
creation, volume and NTFS histories. Two additional 1,024-byte `GCCPRV01` records
contain the component's exact 512-byte `GCCPRT01` intent/completion records.
Every record binds the assignment, profile, journal, controller directory,
backing VHDX, GPT identities and format completion digest. The original thirteen
records and 64 KiB journal allocation ceiling remain unchanged. Exporting the
format checkpoints still returns only their two records.

The protection policy digest is now portable across native and shared-contract
implementations: SHA-256 over the versioned ASCII domain
`goatcitadel.native-cell-volume-root-security.v1`, its terminating zero, and each
canonical owner/controller SID prefixed by its two-byte little-endian byte
length. Native SID validation and exact generated descriptor comparison remain
required; the digest does not substitute for Windows permission readback.
Protection also binds the completed NTFS geometry/serial and observed root file
identity. A later record cannot change any of those facts.

Only the original uninterrupted creator with a successful formatter may advance.
Each protection record is validated, written, flushed and reread before the
independent committer can acknowledge its exact digest. Current authority,
deadline and cancellation checks bound progress. Native state is reverified
after the final authority exchange. Lost or wrong acknowledgements, revocation,
cancellation and uncertain permission writes leave incomplete or unhealthy
history; none authorize a repeated write. Recovery requires both independently
retained protection records and all earlier records. It rejects omitted or
mismatched canonical bytes before physical probing, then verifies current volume,
format and root protection read-only. It cannot repair permissions.

Fresh proof:

- `pnpm verify:remote-worker:windows-cell-job` passes 4,109 checks, including
  1,547 journal checks, in each normal/AddressSanitizer build. Twelve controlled
  protection scenarios compose the real journal with unattached VHDX files and
  controlled volume/format/permission operations. Tests cover exact flushed
  acknowledgements, unchanged earlier stages, revoked authority, cancellation,
  uncertain writes, wrong policy, partial recovery, rollback, torn/extra records
  and rehashed binding drift. An independent Node encoder reconstructs both
  protection records byte-for-byte from the actual fifteen-record receipts.
  Evidence: `.tmp/comparison-cell-protection-journal-native-v3.log` and
  `%TEMP%\Goat Worker Cell Job y8CF6M`.
- `pnpm verify:remote-worker:windows-cell-protection` passes 1,197 component
  checks and 40 actual temporary-directory checks in each normal/AddressSanitizer
  build, including portable policy-hash checks. ARM64 compiles without execution.
  Evidence: `.tmp/comparison-cell-protection-journal-root-v1.log` and
  `%TEMP%\Goat Worker Volume Protection 2dfQss`.
- `pnpm verify:remote-worker:windows-cell-controller-protocol` passes 5,602
  checks across 67 sessions, including 58 native-client sessions, in each normal
  and AddressSanitizer build. Its existing thirteen-record transport and 66
  format-authority checks remain unchanged; no installed service or physical
  volume operation ran. Evidence:
  `.tmp/comparison-cell-protection-journal-controller-v1.log` and
  `%TEMP%\Goat Cell Controller Protocol 4XIoZr`.
- `pnpm verify:remote-worker:windows-cell-provisioning` passes both worker/Gateway
  typechecks under the repository output lock and all eight helper/Gateway
  tests. The native helper now includes the protection component in its pinned
  source inventory. Exact journal recovery, lost-acknowledgement refusal,
  modified-image refusal and interactive custody refusal still pass. Evidence:
  `.tmp/comparison-cell-protection-journal-provisioning-v1.log` and
  `%TEMP%\Goat Worker Provisioning Bridge sYoWmB`.
- Controller payloads build reproducibly twice for each x64/ARM64 target from
  all 37 production inputs. ARM64 is compile-only. Evidence:
  `.tmp/comparison-cell-protection-journal-payload-v1.log` and
  `%TEMP%\Goat Controller Payload pvBj2V`.
- The five changed packaging modules pass strict ESLint with zero warnings.
  Evidence: `.tmp/comparison-cell-protection-journal-lint-v1.log`.

No drive was attached, partitioned or formatted, and the journal proof did not
change any actual volume-root permissions. The separate root-component checks
changed only exclusively created task-owned ordinary temporary directories.
Canonical storage and the controller/helper/worker protocol still retain only
the earlier thirteen records. Protection contracts, paired immutable persistence,
protected exchange and transport/startup integration remain required, followed by
mounting, quotas, runtime custody, protected execution and installed acceptance.
The native backend remains inactive. C5 and the full plan remain in progress.

## Canonical protection checkpoint exchange

The shared contract validates exact 1,024-byte `GCCPRV01` protection records and
their nested 512-byte `GCCPRT01` records against the complete canonical format
pair. It checks every earlier assignment, profile, journal, VHDX and GPT binding,
the frozen owner/controller policy digest, NTFS identity/geometry, root identity,
sequence, predecessor, checksum and reserved bytes. The root identity cannot
change between intent and completion. Shared provisioning and protection now
use the same bounded canonical SID validator; the portable digest matches the
native implementation without depending on Windows descriptor serialization.

Provisioning exchange v5 carries up to two separate `protectionRecords`. Earlier
v1-v4 exchanges retain their supported histories but cannot carry protection
records. Protection requires all five creation, six volume and two format
records. Strict own-field checks reject paths, readiness claims, sparse arrays,
accessors, unknown fields and oversized/reordered history. These are retained
resource facts, not workload permission or live OS readiness.

SQLite migration 224 and PostgreSQL migration 169 append immutable protection
tables. Existing migration records are unchanged. Database guards require the
matching completed format checkpoint, current provisioning ownership, profile,
lease time and contiguous predecessor. They reject updates/deletion and do not
trust a client-supplied timestamp for expiry. The repository locks the existing
canonical assignment/cell owners, validates exact bytes, permits only exact
replay and rechecks outer authority before commit. A changed parent or admission
after append rolls the transaction back. Snapshot reads preserve all four
checkpoint stages independently.

The protected Gateway settlement route and worker client now accept protection
submissions and refuse missing, altered or foreign acknowledgements. The native
controller/helper wire still handles only the earlier thirteen records. Until
that transport gains protection recovery, the worker coordinator refuses any
retained protection history before launching a native helper; it cannot claim
recovery from an unverified thirteen-record prefix.

Fresh proof:

- Four contract files pass 41 tests. An independent check accepts both actual
  normal/AddressSanitizer native fifteen-record receipts, compares all retained
  native source hashes and confirms both historical migration prefixes are
  unchanged. Evidence: `.tmp/comparison-cell-protection-exchange-contracts-v1.log`
  and `.tmp/comparison-cell-protection-exchange-native-bytes-v1.json`.
- Four SQLite scenarios and four actual PostgreSQL scenarios pass. They cover
  exact replay/reopen, partial history, immutable records, wrong binding,
  out-of-order writes, parent-change rollback, worker/mesh/parent revocation and
  database-clock expiry. The PostgreSQL claim/capacity race lane also passes.
  Evidence: `.tmp/comparison-cell-protection-exchange-sqlite-v2.log` and
  `.tmp/comparison-cell-protection-exchange-postgres-tests-v1.log`. The exclusively
  created cluster at
  `%TEMP%\gc-cell-protection-exchange-pg-kd3y4nwu.eib`
  used loopback port 54319 and was verified stopped afterward.
- The worker client/coordinator passes 59 tests, and the Gateway execution
  protocol passes 50. Evidence: `.tmp/comparison-cell-protection-exchange-worker-v1.log`
  and `.tmp/comparison-cell-protection-exchange-gateway-v1.log`.
- Contracts, storage, worker and Gateway typechecks pass under the repository
  output lock. `verify:storage:migration-parity` passes 27 manifest, 24 integrity
  and 45 schema-generation tests with 224 SQLite / 169 PostgreSQL migrations.
  `verify:gateway:async-boundary` passes ten checks. Evidence:
  `.tmp/comparison-cell-protection-exchange-typecheck-v1.log`,
  `.tmp/comparison-cell-protection-exchange-migrations-v2.log` and
  `.tmp/comparison-cell-protection-exchange-async-boundary-v1.log`.
- All 27 SQLite migration/versioning tests pass. The named
  `verify:remote-worker:windows-cell-provisioning` lane repeats worker/Gateway
  typechecks and passes all eight native helper/Gateway cases with the updated
  exchange contract. Evidence:
  `.tmp/comparison-cell-protection-exchange-versioning-v1.log`,
  `.tmp/comparison-cell-protection-exchange-provisioning-v1.log` and
  `%TEMP%\Goat Worker Provisioning Bridge MAC8SU`.
- Twenty-two changed source/test files pass strict ESLint without warnings. The
  separately checked execution-protocol owner has no errors and retains its
  existing 1,023/1,000-line warning. Evidence:
  `.tmp/comparison-cell-protection-exchange-lint-v1.log` and
  `.tmp/comparison-cell-protection-exchange-protocol-lint-v1.log`.

No drive was attached, partitioned, formatted or given new root permissions.
No installed service, external provider, messaging destination or user database
was used. Controller/helper protection transport, startup integration, mounting,
quotas, protected execution/custody, installed lifecycle, mini-PC acceptance and
the remaining C5/C6 work are still required. The native backend remains inactive.

## Native protection transport and startup

Controller operations 7/8 extend creation/read-only recovery through the two
root-protection records. Operations 1-6 and their earlier wire bytes retain
their meanings. Recovery sends separate nonce-bound volume, format and
protection histories. Both endpoints validate the complete chain, frozen
policy, exact NTFS/volume/root identity, record ordering, hashes and reserved
bytes. The client receives owner/controller SIDs from trusted local custody;
the service independently resolves its own principals. They are not new
peer-selectable request fields.

Creation requires the original journal/formatter and all three native stage
owners before the first journal write. Exact canonical acknowledgements and
fresh authority checks bind every stage to the retained head and count. The
shared limits remain fifteen records, 256 authority checks and one deadline.
The protection journal's final authority exchange is followed by native
readback; the controller does not insert another blocking canonical exchange
after that readback. Recovery verifies all recorded bytes without granting
permission to reformat, repair permissions or resume an interrupted creator.

The pinned helper and TypeScript transport now encode and validate both new
operations and all fifteen records. They reject omitted/reordered history,
rehashed foreign bindings, unknown trailing records, stale authority and
inexact acknowledgements. Direct component execution refuses all volume,
format and protection operations. Installed startup requires protection, which
includes the full volume and format histories. The coordinator never falls
back to a shorter native port; partial histories require reconciliation and
complete recovery must return the exact canonical records from every stage.
`recorded` and `recovery_verified` still do not activate a protected executor.

Fresh proof:

- Compiled controller tests pass in both normal and AddressSanitizer builds:
  9,442 checks, 90 sessions, 81 native-client sessions, and 84 authority checks
  for the complete controlled creation flow. Tests cover missing stage owners,
  interrupted acknowledgements at both protection records, authority loss,
  cancellation, rehashed format/policy/volume/root drift, foreign principals,
  exact recovery transport and refusal of real recovery for the unattached
  fixture. Evidence: `.tmp/comparison-cell-protection-transport-controller-v1.log`
  and `%TEMP%\Goat Cell Controller Protocol FTHF1p`.
- Five focused worker files pass 181 tests. This includes exact binary recovery,
  checkpoint acknowledgements, creation/recovery separation, partial evidence,
  changed canonical history, helper custody and rotated-lease startup. Evidence:
  `.tmp/comparison-cell-protection-transport-worker-v3.log`. The initial run
  caught an incorrectly constructed test fixture and a five-second timeout.
  The fixture was corrected; the complete creation-plus-recovery startup case
  independently completed in about six seconds and now has a bounded
  fifteen-second test timeout. Runtime deadlines and authority checks were not
  relaxed. The earlier failed logs remain available as v1/v2.
- The controller payload builds twice with identical receipts and bytes for
  each of x64 and ARM64, retaining all 37 production source inputs. ARM64
  compilation is not ARM64 execution. Evidence:
  `.tmp/comparison-cell-protection-transport-payload-v1.log` and
  `%TEMP%\Goat Controller Payload kO1eck`.
- Worker/Gateway typechecks pass under the repository output lock. The named
  helper/Gateway regression lane passes eight tests with the new transport
  source, including explicit refusal of operations 3-8 from direct component
  execution or an interactive caller without installed controller custody.
  Evidence: `.tmp/comparison-cell-protection-transport-provisioning-v2.log` and
  `%TEMP%\Goat Worker Provisioning Bridge Rsu4xu`.
- Eight changed TypeScript/JavaScript source and test files pass strict ESLint
  with no warnings: `.tmp/comparison-cell-protection-transport-lint-v2.log`.

These native fixtures create only task-owned ordinary directories, checkpoint
files and unattached VHDX files. Attachment, partitioning, NTFS formatting and
root permission changes use controlled driver replies. No real drive was
attached, partitioned, formatted or given new root permissions; no installed
service, external provider, messaging destination or user database was used.
Installed physical recovery, mounting, quotas, protected execution/custody,
installed lifecycle, mini-PC acceptance and the remaining C5/C6 work are still
required. The native backend remains inactive and the full plan is incomplete.

## Mount target inspection

The next mount owner now has a read-only native inspection primitive in
`cell_volume_mount_target.hpp/.cpp`. Its binding separates the installed cell's
host parent/leaf identities from the protected VHDX root identity. The host
identities must be distinct objects on the same volume, and the VHDX root must
be on a different volume. Native host probes require the literal `volume`
child, exact file IDs, ordinary NTFS metadata and no alternate streams; mounted
probes additionally require the exact mount-point tag and target. A separate
resolved-root probe checks the expected root identity and complete volume-GUID
path, so neither a sibling nor a matching file ID below the root is sufficient.

The bounded SDK decoders validate reparse lengths, offsets, UTF-16, disjoint
name ranges, reserved bytes and the exact volume-GUID substitute name. Display
names never select a target. Alias decoding requires either an empty list or
the single expected mounted-folder path; a drive letter, extra alias or partial
multi-string response fails. The layouts follow Microsoft's
[reparse buffer contract](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_reparse_data_buffer)
and [volume path-name contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumepathnamesforvolumenamew).
The future mount operation must also enforce the empty-folder requirement in
[SetVolumeMountPointW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setvolumemountpointw).

`pnpm verify:remote-worker:windows-cell-mount-target` passes normal and
AddressSanitizer builds, each with 359 checks including 17 actual temporary NTFS
directory checks. It also compiles ARM64 without executing it. The tests cover
every truncated response and single-byte corruption of the canonical reparse
fixture, foreign GUIDs, UTF-16/offset errors, second aliases, wrong parents,
sibling names, ordinary-directory substitution and alternate streams. Evidence:
`.tmp/comparison-cell-mount-target-native-v2.log` and
`%TEMP%\Goat Worker Mount Target P0of81`.
The packaging test passes strict ESLint without warnings.

This primitive creates no mount or authority. Its caller must still own retained
handles with appropriate sharing, exact permissions, the full VHDX/protection
history, fresh canonical authority, a watchdog and durable acknowledgements.
No installed controller or assignment path calls the future mount operation
yet. The governed mount owner, durable journal/transport, quotas, protected
execution and physical installed acceptance remain required. Tests created
only ordinary task-owned directories and one alternate-stream fixture; no
drive attachment, partitioning, formatting, mounting or volume-root permission
change occurred. C5 and the full plan remain in progress.

## Governed native mount owner

`cell_volume_mount.hpp/.cpp` owns one attempt to mount the original successfully
protected volume. Its public interface accepts no destination path, drive
letter, disk number, replacement flag, descriptor or format operation. The
source must be the original fresh protection owner; recovered or previously
consumed sources cannot start a mount. The attempt is consumed before fallible
binding work, and closing the owner neither removes resources nor enables retry.

The mount directory is exclusively created as the literal `volume` child of the
already pinned host cell root, with the frozen controller descriptor applied by
the kernel at creation. The native SDK locator is derived from that parent
handle and rechecked against the recorded identity. The target is the protected
volume's exact GUID path. Both directory creation and `SetVolumeMountPointW`
recheck authority, cancellation, deadline and native state after argument
preparation, immediately before submission. There is no arbitrary-volume
selection, formatting or replacement path in this owner.

The four 512-byte `GCCMNT01` checkpoints record preparation, directory identity,
mount intent and verified completion. Each contains its phase, predecessor
digest, protection completion digest, frozen security-policy digest, volume GUID,
host parent and protected NTFS-root identities. The directory identity is zero
in preparation and immutable thereafter; reserved bytes must remain zero. Every
record is retained before its callback, and its exact SHA-256 must be acknowledged
before progress. Missing or mismatched acknowledgements leave unknown state.

Native checks require the full earlier VHDX/protection history, exact root and
host permissions, no existing alias before mounting, an empty destination
including hidden/system entries, and the sole expected folder alias afterward.
Readback separately checks the no-follow mount point and the resolved protected
NTFS root. After the final acknowledgement and authority exchange, native
identity/permission/mount readback must still pass. Recovery requires all four
exact records before opening the recorded leaf, performs only reads and cannot
repair or retry an interrupted mount.

`pnpm verify:remote-worker:windows-cell-mount` passes normal and AddressSanitizer
builds, each with 2,378 checks including nine ordinary NTFS-directory checks.
ARM64 compiles without execution. The tests exercise every acknowledgement and
authority boundary, revocation during both mutation preparations, identity drift,
uncertain SDK errors, cancellation, incomplete/reordered/foreign records and
every single-byte corruption. Node independently reconstructs all four records.
Evidence: `.tmp/comparison-cell-mount-native-v3.log` and
`%TEMP%\Goat Worker Volume Mount uIk7ax`.
The first compile exposed a signed/unsigned fixture warning; the corrected lane
passes with warnings treated as errors. The packaging test passes strict ESLint.

The existing protection and native cell Job Object lanes also pass on the final
shared headers/workspace source. Protection executes 1,197 component and 40
ordinary-directory checks in each normal/AddressSanitizer build. The job lane
executes 4,109 checks per build, including 239 workspace and 1,547 provisioning
journal checks. Its live-attachment environment option and installed-payload
overrides were explicitly required to be absent before dispatch. Evidence:
`.tmp/comparison-cell-mount-protection-regression-v1.log`,
`.tmp/comparison-cell-mount-job-regression-v1.log`,
`%TEMP%\Goat Worker Volume Protection 9CzfPn` and
`%TEMP%\Goat Worker Cell Job 6DaKBd`.
The job lane creates unattached VHDX fixtures; its attachment, layout, formatting
and volume-root protection execution flags all remain false.

Successful mount operations are controlled callbacks, not physical mounts. The
ordinary-directory fixture checks emptiness and hidden/system-file refusal; it
does not prove Windows mount sharing behavior or installed recovery. No real
drive was attached, partitioned, formatted, mounted or given new root permissions.
The component is not wired into the native journal, canonical checkpoint
exchange, controller transport or startup. Those integrations, mounted workspace
contents, quotas, protected execution and installed acceptance remain required.
C5 and the full comparison plan remain in progress.

## Durable native mount journal

`CellProvisioningJournal` now owns the optional mount continuation after
acknowledged root protection. It appends four 1,024-byte `GCCMNV01` records,
embedding the mount owner's original 512-byte `GCCMNT01` checkpoints. The fifteen
earlier records remain unchanged; the maximum logical length becomes nineteen
records and the existing 64 KiB allocation inspection ceiling remains. This is
an inspection bound, not a filesystem quota.

The nested mount history binds the completed protection digest, frozen
controller policy, volume GUID, protected NTFS root and the host cell root from
the creation records. Outer records bind the assignment/profile/VHDX, journal,
control and backing identities, derived GPT identifiers and protection-stage
completion. The newly observed mount-directory identity must remain stable and
cannot reuse the parent, journal, backing file or another workspace root. A
separate pure validator checks this complete metadata relationship for later
authenticated transport integration; it does not establish OS readiness.

Before acknowledgement, each record is appended, flushed and read back from the
exclusive journal file. The final blocking authority exchange before append is
followed by another held-file read and deadline check. The mount owner still
checks current authority and native identities immediately before its directory
and mount SDK submissions. Missing/inexact acknowledgements, cancellation,
revocation and uncertain outcomes leave retained evidence and prohibit retry.
The journal's final authority exchange is followed by native readback.

Recovery rejects any partial mount stage. A mounted journal requires all four
independently retained mount records as well as the complete preceding stages;
older callers cannot omit the mount suffix and report a shorter successful
recovery. Exact canonical comparison precedes physical recovery, which only
reopens and verifies the recorded resources. It never creates a missing mount
directory, remounts, formats, repairs or truncates evidence. Recovered owners
cannot resume provisioning.

`pnpm verify:remote-worker:windows-cell-job` passes normal and AddressSanitizer
builds with 4,892 checks each, including 2,330 journal checks. The new 24 mount
scenarios cover every acknowledgement boundary, revocation, cancellation,
uncertain directory/mount outcomes, final-readback failure and foreign bindings.
Recovery tests cover omitted/partial/torn/extended records, independent canonical
mismatches and consistently rehashed attempts to substitute protected host
objects. Node independently verifies the complete chain and reconstructs the
four mount records. Evidence:
`.tmp/comparison-cell-mount-journal-native-v3.log` and
`%TEMP%\Goat Worker Cell Job Czjp6s`.

The first compile exposed a shadowed fixture variable. After correction, the
normal lane passed but the larger AddressSanitizer build exceeded the compiler's
60-second timeout. The final lane uses a bounded 120-second compiler timeout for
the large cell test builds and a 240-second outer test deadline; runtime and
Windows-operation limits remain unchanged. All JavaScript changes pass strict
ESLint without warnings.

Controller regression passes 90 sessions, including 81 native-client sessions,
in each normal/AddressSanitizer build. The named helper/Gateway lane passes both
locked package typechecks and all eight cases. Reproducible controller payload
builds pass for x64 and ARM64 with 41 recorded source inputs; ARM64 is compiled,
not executed. Evidence: `.tmp/comparison-cell-mount-journal-controller-v1.log`,
`.tmp/comparison-cell-mount-journal-provisioning-v1.log` and
`.tmp/comparison-cell-mount-journal-payload-v1.log`, with retained directories
`%TEMP%\Goat Cell Controller Protocol 6H6awR`,
`%TEMP%\Goat Worker Provisioning Bridge fwSutf` and
`%TEMP%\Goat Controller Payload 6BbTL4`.
These verify existing transport compatibility and build inputs; mount-aware
controller/helper operations have not been exposed or activated.

The standalone mount owner also passes its normal/AddressSanitizer regression
with 2,378 checks per build, including nine ordinary-directory checks, and ARM64
compilation. Evidence: `.tmp/comparison-cell-mount-journal-owner-v1.log` and
`%TEMP%\Goat Worker Volume Mount wtCYzU`.

These tests create ordinary task-owned directories, protected journal files and
unattached VHDX fixtures. Layout, formatting, root protection and mounting use
controlled drivers; no real drive was attached, partitioned, formatted, mounted
or given new root permissions. Canonical mount contracts/storage/exchange,
controller transport/startup and installed physical recovery remain unfinished,
as do mounted workspace contents, quotas and protected execution. C5 and the
full comparison plan remain in progress.

## Canonical mount checkpoint exchange

The Gateway and worker can now retain and acknowledge the four mount phases
(`prepared`, `directory_recorded`, `mount_intent`, `mounted`) after the fifteen
unchanged creation/volume/format/protection records. The v6 exchange keeps older
versions readable within their supported fields; a v1-v5 envelope cannot carry
mount records. These are retained resource facts, not current OS readiness.

Implemented owners:

- `packages/contracts/src/remote-worker-cell-mount.ts` validates both fixed byte
  layers and their hash chains, the complete protected history, frozen policy,
  volume/root identity, recorded host parent and four workspace identities. The
  mount directory must remain the same distinct host-volume object after its
  first recorded identity. Paths, extra fields, getters and malformed arrays do
  not grant authority. The independent fixture encoder matches the native format.
- `packages/storage/src/remote-worker-cell-provisioning-repo.ts` derives anchors
  from canonical records, returns exact replays and rejects replacement, skipped
  stages and authority drift. SQLite migration 225 and PostgreSQL migration 170
  add immutable, retained mount tables with claim, database-clock, predecessor
  and completed-protection guards. All 393 earlier migration records and hashes
  remain unchanged. PostgreSQL 170's runtime hash is
  `709413752b789f8080d2cbfee17c856727bcc0f99091c4c55c07e1e3a177649a`.
- The existing protected assignment settlement handles `cell.mount.checkpoint`.
  Gateway and worker require the exact acknowledged record and matching scope,
  generation and lease. No platform-ready transition is added.
- The worker coordinator compares mount history as well as all earlier stages.
  Its current native port cannot recover mounts, so any retained mount prefix
  returns `mount_verification_unavailable` before native invocation. Mount facts
  appearing during a protection-only refresh fail closed.
- Private weak caches reuse only deeply frozen metadata validated by the owning
  contract module. Caller-frozen copies still receive full validation. Current
  authority, leases and native OS state are never cached. This removes repeated
  decoding that initially caused aggregate tests and a ten-second fixture lease
  to expire; no lease or test timeout was increased.

Validation on 2026-09-13:

- Locked contracts/storage/worker/Gateway typechecks pass:
  `.tmp/comparison-cell-mount-exchange-typecheck-v4.log`.
- 43 contract tests, 73 worker tests and 51 Gateway tests pass:
  `.tmp/comparison-cell-mount-exchange-contracts-v3.log`,
  `.tmp/comparison-cell-mount-exchange-worker-v3.log` and
  `.tmp/comparison-cell-mount-exchange-gateway-v2.log`.
- Four SQLite and four actual PostgreSQL scenarios pass, including exact replay,
  rollback after append, worker/mesh/parent revocation, database-time expiry,
  immutable evidence and concurrent canonical claim/capacity guards:
  `.tmp/comparison-cell-mount-exchange-sqlite-v2.log` and
  `.tmp/comparison-cell-mount-exchange-postgres-v2.log`. The fresh PostgreSQL
  cluster `gc-cell-mount-exchange-pg-pt3h40ey.c3w` used loopback port 61766 and was
  stopped after ownership verification. The earlier failed-run cluster
  `gc-cell-mount-exchange-pg-gfsp3c22.5tm` on port 58044 was also stopped; logs and
  temporary cluster data were retained.
- The named storage migration parity lane passes: 225 SQLite / 170 PostgreSQL,
  27 manifest tests, 24 PostgreSQL integrity tests and 45 schema tests. Another
  27 SQLite migration/versioning tests pass. Logs:
  `.tmp/comparison-cell-mount-exchange-migrations-v1.log` and
  `.tmp/comparison-cell-mount-exchange-versioning-v1.log`.
- The shared decoder accepts the actual normal/AddressSanitizer nineteen-record
  histories and all four mount prefixes from `Goat Worker Cell Job Czjp6s`.
  Native source hashes still match those retained receipts. This is a new decoder
  check against existing native evidence, not a new native execution:
  `.tmp/comparison-cell-mount-exchange-native-bytes-v2.json`.
- The named `verify:remote-worker:windows-cell-provisioning` lane passes all eight
  helper/Gateway tests, including exact commit/recovery and lost-acknowledgement
  behavior. Evidence is retained in `Goat Worker Provisioning Bridge DKIsoy` and
  `.tmp/comparison-cell-mount-exchange-provisioning-v1.log`. This lane uses
  unattached VHDX fixtures; it does not expose mount operations.
- ESLint reports zero errors and one pre-existing `max-lines` warning in the
  assignment protocol owner (1,023 lines before these two dispatch changes,
  1,024 after). The strict lint command therefore exits nonzero; its baseline
  reconstruction confirms the warning predates this change. Logs:
  `.tmp/comparison-cell-mount-exchange-lint-v1.log` and
  `.tmp/comparison-cell-mount-exchange-lint-baseline-v1.log`. No lint rule was
  disabled and no unrelated formatting cleanup was performed.

No real drive was attached, partitioned, formatted, mounted or given new root
permissions. No installed controller/service, provider, credential, external
channel or user database was changed. Native mount controller/helper transport,
startup, mounted workspace contents, quotas, protected execution and installed
two-machine acceptance remain unfinished. C5 and the full plan remain in progress.

## Native mount transport and startup

This C5 increment connects the existing mount journal and canonical v6 exchange
to the native controller/helper and installed worker startup. It does not enable
the protected execution backend or establish physical mount recovery.

- Controller operations 9/10 extend creation and read-only recovery through all
  nineteen records. Operations 1-8 retain their earlier wire formats. Recovery
  sends the original five creation records with the four mount records in a
  nonce-bound, 9,248-byte frame after the earlier stage histories. Before
  recovering the recorded resources, the controller checks those original
  workspace identities, principals, journal anchor and disk-completion hash
  against the complete mount chain.
- Every creation checkpoint requires the exact canonical acknowledgement and
  current authority. Mount completion uses 114 authority checks, within the
  unchanged 256-check bound. Both helper and worker stream tests accept the full
  256-check transcript within the unchanged 32 KiB output cap.
- The compiled helper test exposed and closes an older forwarding gap: its
  authority callback accepted only the eleven/thirteen-record stages, and its
  commit callback did not recognize mount records. The helper now carries
  protection and mount stages and rejects bad acknowledgements before forwarding
  any further progress. Its test invokes the production stream callbacks without
  invoking installed custody, connecting a controller or operating a volume.
- Installed startup requires the mount port. It cannot fall back to shorter
  protection/format/creation success. Partial journals require reconciliation;
  native recovery must return every mount record independently. Gateway history
  cannot fill omissions in the native result. A restart never repeats creation,
  formatting or mounting to complete an interrupted journal.

Validation:

- `verify:remote-worker:windows-cell-controller-protocol`: normal and
  AddressSanitizer builds each pass 14,893 checks across 121 sessions, including
  108 production-client sessions. Malformed recovery frames, nonce mismatches,
  substituted identities, lost acknowledgements and revoked authority refuse
  progress. Evidence: `Goat Cell Controller Protocol a5a58E`,
  `.tmp/comparison-cell-mount-transport-controller-v2.log`.
- `verify:remote-worker:windows-cell-helper-protocol`: 33 scenarios per normal
  and AddressSanitizer build, covering every legacy/new stage, recovery, bad
  acknowledgements, authority field substitution and the 256-check bound.
  Evidence: `Goat Cell Helper Protocol 83tZ6h`,
  `.tmp/comparison-cell-mount-transport-helper-v1.log`.
- `verify:remote-worker:windows-cell-job`: normal and AddressSanitizer builds
  each pass 4,939 checks including 2,377 journal checks. New core-history tests
  reject partial, excess and rehashed substituted records without returning
  recovery identities. Evidence: `Goat Worker Cell Job 169Ra7`,
  `.tmp/comparison-cell-mount-transport-native-v1.log`. The shared TypeScript
  decoder also accepts both fresh nineteen-record histories and every mount
  prefix, with current native source hashes verified:
  `.tmp/comparison-cell-mount-transport-native-bytes-v1.json`.
- 162 focused worker tests pass across the protocol/startup run and coordinator
  rerun. An omitted-field fixture was corrected to actually omit the field;
  explicitly malformed `undefined` metadata had already been rejected. Logs:
  `.tmp/comparison-cell-mount-transport-worker-v2.log` and
  `.tmp/comparison-cell-mount-transport-coordinator-v3.log`.
- Contracts, provisioner and worker typechecks pass through the repository
  output-lock wrapper after waiting for the separate UI verification owner.
  Strict scoped ESLint passes with zero warnings. Logs:
  `.tmp/comparison-cell-mount-transport-typecheck-v3.log` and
  `.tmp/comparison-cell-mount-transport-lint-v1.log`.
- The controller payload builds twice identically for each of x64 and ARM64,
  retaining all 41 source inputs. ARM64 was compiled, not executed. Evidence:
  `Goat Controller Payload jVyNQU`,
  `.tmp/comparison-cell-mount-transport-payload-v1.log`.
- `verify:remote-worker:windows-cell-provisioning` passes all eight native
  helper/Gateway regression tests, including actual unattached VHDX creation,
  exact canonical commits, read-only recovery, lost acknowledgements, modified
  helper refusal and stalled input. Gateway typechecking also passes. Evidence:
  `Goat Worker Provisioning Bridge FdF7ol`,
  `.tmp/comparison-cell-mount-transport-provisioning-v1.log`. This bridge lane
  exercises creation-only native operations, not physical mounting.

No real drive was attached, partitioned, formatted, mounted or given new root
permissions. The native journal/controller fixtures use unattached VHDX files
and controlled volume drivers; actual recovery correctly refuses their simulated
mount state without writes. No service was installed or started, and no provider,
credential, external channel or user database was changed. Mounted workspace
contents, quotas, protected execution, backend activation and installed
two-machine acceptance remain unfinished. C5 and the full plan remain in progress.

## Mounted workspace directory owner

The native `CellMountedWorkspace` component creates `root`, `control`, `runtime`
and `work` directories through the protected volume's original pinned root
handle. Its binding includes the completed mount digest, exact security-policy
digest, volume-root identity and canonical cell name. It does not follow the
host mount alias to choose a write destination.

Only the original successful fresh mount permits one creation attempt. The
component retains an intent before invoking its exact acknowledgement callback,
then checks current authority before each directory creation. After each
callback, the filesystem owner rechecks the parent and all previously created
directory identities and security. The complete identity record needs a second
exact acknowledgement and final readback. Lost acknowledgements, revocation,
cancellation and identity/security drift leave an unknown state. Closing an
owner never retries, repairs or deletes a partially created workspace.

Complete recorded recovery opens the four independently recorded directories
and rechecks their identities and security. Partial records cannot create
missing directories. These component records are not yet connected to the
canonical provisioning journal, Gateway exchange, helper/controller transport
or worker startup; this does not activate the native execution backend.

Validation:

- `pnpm verify:remote-worker:windows-cell-mounted-workspace` passes 324 checks
  in each normal and AddressSanitizer build, including 89 actual ordinary NTFS
  directory checks. ARM64 compilation passes; ARM64 execution is unproven.
- Node independently reconstructs both complete 512-byte records and their
  hash chain. Source hashes match before and after the proof.
- The tests cover exact/missing/wrong acknowledgements, each creation guard,
  permission drift inside callbacks, changed identities, cancellation including
  invalid pseudo-handles, and complete read-only recovery. The cancellation test
  exposed an invalid-handle case that was fixed and passed on retry.
- Evidence is retained in
  `.tmp/comparison-mounted-workspace-component-v4.log` and
  `%TEMP%\Goat Mounted Workspace vgARmR\acceptance.json`.
  Earlier failed attempts remain recorded separately; they are not passing proof.
- The existing `verify:remote-worker:windows-cell-job` lane also passes: 4,939
  checks per normal/AddressSanitizer build, including 239 workspace and 2,377
  journal checks. Evidence: `.tmp/comparison-mounted-workspace-native-v1.log`
  and `Goat Worker Cell Job f8gtWj`. Every attachment/layout/format/protection/
  mount execution flag is false. The lane uses unattached VHDX fixtures.
- The existing mount-owner regression passes 2,378 checks per normal/ASAN build,
  with nine ordinary directory checks; ARM64 compiles. Mount SDK operations are
  simulated. Evidence: `.tmp/comparison-mounted-workspace-mount-regression-v1.log`
  and `Goat Worker Volume Mount sjkIv6`.
- Controller payloads reproduce for x64 and ARM64 with all 43 source inputs
  recorded. No installed service runs. Evidence:
  `.tmp/comparison-mounted-workspace-payload-v1.log`, `Goat Controller Payload TrAqOQ`.
- Scoped packaging lint and whitespace checks pass. Governance-document
  validation passes, but the full `pnpm docs:check` stops at two missing explicit
  button types in the separately owned UI test
  `apps/mission-control-next/src/components/DetailInspector.test.tsx:17-18`.
  Those files were preserved. Evidence: `.tmp/comparison-mounted-workspace-docs-v1.log`.

The proof uses controlled volume operations and newly created ordinary folders.
It never attaches, partitions, formats or mounts a drive, changes volume-root
permissions, starts an installed controller or changes a user database.
Quota/file-count enforcement, runtime publication, AppContainer profile
confinement, protected execution and installed/two-machine acceptance remain
separate unfinished requirements. C5 and the overall plan remain in progress.

## Durable mounted workspace journal

`CellProvisioningJournal` now appends two `GCCMWP01` records after the complete
nineteen-record mount history. Each wraps the directory owner's `GCCWRK01`
checkpoint and binds the original assignment, profile, VHDX, journal identity,
canonical cell name, frozen security policy and completed mount. Earlier records
retain their exact bytes and stage counts. The logical maximum is twenty-one
KiB within the unchanged 64 KiB allocated-journal ceiling.

Every appended record is flushed and read back before its exact canonical
acknowledgement. Current authority also triggers a fresh held-journal read, so
journal corruption during a callback stops before directory creation. Missing
or wrong acknowledgements, cancellation, revocation, partial creation and final
readback failure retain uncertain state; neither closure nor metadata recovery
restores the original creation authority.

Complete recovery requires all twenty-one independently retained records.
Legacy mount-only callers refuse the extended history. A partial, rolled-back,
torn, rehashed or substituted journal cannot create missing directories, repair
permissions, truncate evidence or bypass native source readback. Host workspace
identities remain distinct from mounted execution-root evidence.

Validation:

- `pnpm verify:remote-worker:windows-cell-job` passes in normal and
  AddressSanitizer builds: 4,939 existing checks per build plus 679 dedicated
  mounted workspace journal checks per build. The new cases run in separate
  invocations with the existing 40-second process watchdog; the overall
  240-second lane bound also remains unchanged.
- The two retained twenty-one-record receipts pass independent Node
  reconstruction of both the nested and outer hash chains, original ownership,
  completed mount, policy and all four directory identities.
- The proof covers each acknowledgement boundary, revoked authority,
  uncertain directory creation, cancellation, modified source bindings, journal
  corruption inside an authorization callback, missing canonical records,
  suffixes, torn writes, rehashed substitutions and refusal to resume recovery.
- Evidence: `.tmp/comparison-mounted-workspace-journal-native-v3.log` and
  `%TEMP%\Goat Worker Cell Job 3GSgm6`, including
  `mounted-workspace-normal.json` and `mounted-workspace-asan.json`.
  The prior compiler-warning and combined-ASAN-timeout attempts are retained
  separately; they are not passing proof. The timeout led to the separate
  invocation layout, without increasing any timeout.
- `pnpm verify:remote-worker:windows-cell-controller-protocol` passes with
  14,893 checks across 121 sessions per normal/AddressSanitizer build, including
  108 native client sessions. This preserves the existing nineteen-record
  protocol; it does not establish transport for the two new workspace records.
  Evidence: `.tmp/comparison-mounted-workspace-journal-controller-v1.log` and
  `%TEMP%\Goat Cell Controller Protocol BdiGMI`.
- The controller payload test passes reproducible x64 and ARM64 builds from
  all 43 source inputs. ARM64 was compiled, not executed, and no installed
  service was started. Evidence:
  `.tmp/comparison-mounted-workspace-journal-payload-v1.log` and
  `%TEMP%\Goat Controller Payload sMMTnK`.
- Scoped strict ESLint and governance document validation pass. The full
  `pnpm docs:check` stops at two missing button types in the separate UI task's
  `DetailInspector.test.tsx:17-18`; that file remains untouched here. Evidence:
  `.tmp/comparison-mounted-workspace-journal-lint-v1.log`,
  `.tmp/comparison-mounted-workspace-journal-lint-v2.log` and
  `.tmp/comparison-mounted-workspace-journal-docs-v1.log`.

This proof uses real exclusive temporary journal files and unattached VHDX
fixtures with controlled volume and workspace drivers. Native physical recovery
correctly refuses the deliberately unattached source. No drive was attached,
partitioned, formatted, mounted or given new root permissions. No installed
service, live provider, external channel, credential or user database was changed.
Gateway exchange, controller/helper transport and startup do not yet consume
the two new records. Quotas, protected execution, backend activation and installed
two-machine acceptance remain unfinished. C5 and the full plan remain in progress.

## Canonical mounted workspace exchange

Shared exchange v7 carries `mountedWorkspaceRecords` separately from the original
five creation, six volume, two format, two protection and four mount records.
The new `GCCMWP01` validator checks both inner and outer hash chains, completed
mount, frozen security policy, canonical cell name, protected root and the four
distinct execution-root identities. Prefixes are retained truthfully; complete
mount history is required before any workspace record. Earlier exchange versions
retain their existing admission rules and cannot carry the new field.

SQLite 226 and PostgreSQL 171 add an immutable, retained checkpoint table. Both
require the complete mount, current native provisioning claim and ordered exact
predecessors. Repository reads revalidate retained bytes and stored metadata;
protected settlement checks the active assignment, worker generation, mesh
authority and parent before and after mutation. Lost-response replay returns
the exact canonical history without granting another creation attempt.

The Gateway and worker client require an acknowledgement containing the exact
submitted workspace bytes. The coordinator can consume all twenty-one records
through a workspace-capable native port, with fresh authority/history checks
and independently returned recovery bytes. A shorter-stage or missing native
port reports reconciliation; partial histories never resume directory creation.
The concrete controller/helper transport and installed startup remain on the
nineteen-record path and are not enabled by these contracts or fixtures.

Validation:

- Contracts: 47 tests across provisioning, format, protection and mount.
  Worker: 183 tests across client, coordinator, current native volume protocol
  and installed-startup composition. Gateway: 52 protected protocol tests.
  Evidence: `.tmp/comparison-workspace-exchange-contracts-v2.log`,
  `.tmp/comparison-workspace-exchange-worker-v2.log` and
  `.tmp/comparison-workspace-exchange-gateway-v2.log`.
- Four SQLite tests and four actual PostgreSQL tests pass. These include
  worker, mesh-authority and parent revocation, missing predecessors, exact
  replay, substitutions, rollback after parent cancellation, immutable evidence
  and the existing two-connection capacity/provisioning race. Both task-owned
  PostgreSQL clusters were stopped, with evidence retained. Latest evidence:
  `.tmp/comparison-workspace-exchange-sqlite-v2.log`,
  `.tmp/comparison-workspace-exchange-postgres-v2.log` and
  `%TEMP%\gc-workspace-exchange-pg-ooy1wqho.2bg`.
- `pnpm verify:storage:migration-parity` passes for SQLite 226 / PostgreSQL 171.
  The append-only manifest update preserves every earlier migration record.
  Evidence: `.tmp/comparison-workspace-exchange-migration-v1.log`.
- Locked contracts, storage, worker and Gateway typechecks pass. The first
  attempt found a duplicate fixture variable, corrected before the passing
  `.tmp/comparison-workspace-exchange-typecheck-v3.log`.
- Both retained native twenty-one-record receipts are accepted by the compiled
  contracts, and an independent TypeScript encoder reproduces the final two
  records exactly. Evidence:
  `.tmp/comparison-workspace-exchange-native-bytes-v2.json`.
- The first worker run had three five-second timeouts. Repeated volume-history
  validation inside formatting metadata was reduced by reusing only anchors
  fully validated and deeply frozen inside the format owner. Caller-frozen
  copies and changed input still undergo full validation. The same 183-test
  selection then passes in 24.63 seconds with the original timeout unchanged;
  this is local fixture evidence, not a general live-runtime latency claim.
- Seventeen focused files pass strict ESLint, including the format-history
  optimization, in `.tmp/comparison-workspace-exchange-lint-v2.log`. The broader
  first selection reports no code errors but fails on the existing 1,024-line
  Gateway protocol file exceeding its 1,000-line limit. This batch only extends
  two existing admission conditions in that file. Its warning remains visible
  in `.tmp/comparison-workspace-exchange-lint-v1.log`.
- Full `pnpm docs:check` passes in
  `.tmp/comparison-workspace-exchange-docs-v2.log`. The first attempt stopped at
  four missing button types in `DetailInspector.test.tsx`; the separate UI task
  fixed its own test markup before this passing rerun. The initial failure is
  retained in `.tmp/comparison-workspace-exchange-docs-v1.log`.

All new acceptance uses bounded record fixtures and task-owned temporary
databases. Native journal evidence comes from the earlier unattached-VHDX run;
no fresh physical volume operation or installed service operation occurred.
No live provider, channel message, credential or user database was changed.
Native transport/startup integration, quotas, protected execution, activation,
installed/two-machine acceptance and fair live comparison remain unfinished.
C5 and the overall plan remain in progress.

## Mounted workspace transport and startup

The Windows controller adds operations 11/12 for creation through the mounted
workspace stage and complete read-only recovery. Earlier operations retain their
record limits and encodings. Recovery supplies a separate nonce-bound frame with
both workspace records, following the independently retained creation, volume,
format, protection and mount histories. Missing or altered history is refused
before opening the parent. Creation requires every stage owner before writing
the first journal record, exact checkpoint acknowledgements, current authority
and the original operation deadline. Recovery never resumes interrupted writes.

The pinned helper and TypeScript driver carry the final pair through the same
protocol. The helper's 256-challenge authority bound is unchanged. The new
operation has an exact 33,150-byte output ceiling: twenty-one checkpoint frames,
256 authority frames and one receipt. Older operations retain their existing
ceilings. The driver refuses reordered, substituted, incomplete and extra
records, missing authority, conflicting acknowledgements and shorter recovery
operations that would discard the workspace history.

Installed-worker source composition now selects `requireMountedWorkspace` and
uses the concrete create/recover methods. Rotated leases, cancellation and the
canonical Gateway acknowledgements still govern progress. Recorded provisioning
does not activate a backend or claim execution readiness.

Validation:

- Controller protocol: normal and AddressSanitizer builds each pass 14,894
  existing checks across 121 sessions and 5,373 workspace checks across 27
  separate sessions. The original 40-second per-process watchdog remains in
  place for both groups. These use actual pipe identity, retained journal bytes
  and flushed acknowledgements, with controlled volume/directory drivers and
  unattached VHDX fixtures. Evidence: `.tmp/comparison-workspace-transport-controller-v1.log`
  and `%TEMP%\Goat Cell Controller Protocol qCfgTb`.
- Compiled helper callbacks: 48 scenarios pass in each build, including the
  complete 33,150-byte stream and rejection of a 257th authority challenge.
  The first run found an old 19-record guard that refused the new operation;
  that guard was extended and the same test passed. Both receipts are retained:
  `.tmp/comparison-workspace-transport-helper-v1.log` and
  `.tmp/comparison-workspace-transport-helper-v2.log`. Successful native evidence:
  `%TEMP%\Goat Cell Helper Protocol ERHtw7`.
- Worker protocol/startup: 110 tests pass; coordinator/client regression: 94
  tests pass. Logs: `.tmp/comparison-workspace-transport-worker-v1.log` and
  `.tmp/comparison-workspace-transport-coordinator-v1.log`.
- Locked worker typecheck and strict ESLint pass in
  `.tmp/comparison-workspace-transport-typecheck-v1.log` and
  `.tmp/comparison-workspace-transport-lint-v1.log`.
- Reproducible controller payloads pass for x64 and ARM64, with all 43 source
  inputs checked against the current files. ARM64 is compile-only. Evidence:
  `.tmp/comparison-workspace-transport-payload-v1.log` and
  `%TEMP%\Goat Controller Payload HHsMnW`.
- Six complete retained native histories pass shared TypeScript decoding and
  independent reconstruction of both workspace records. This includes failure
  scenarios with complete bytes; retained bytes do not override failed authority
  or acknowledgement outcomes. Receipt:
  `.tmp/comparison-workspace-transport-native-bytes-v1.json`.

No installed service was installed or started. No real drive was attached,
partitioned, formatted, mounted or given new root permissions. No live provider,
external message, credential or user database was changed. Physical recovery,
quotas, protected execution, activation, installed/two-machine acceptance and
fair live comparison remain unfinished. C5 and the overall plan remain active.

The separate UI task reports its final production build and 416 visual checks
passed, with its output lock released. Its `external-gates.json` still requires
Memory continuation, atomic revision preconditions, real worker/provider/channel
evidence and installed desktop acceptance. It also records a canonical C2 case
where a rejected child approval has completed rejection effects and an inactive
candidate, while the parent plan remains `awaiting_approval`. The Change Plan and
capability lifecycle owners must verify the documented resume/reconciliation and
expiry behavior before this gate is closed; frontend fixture success does not
resolve it.

## Canonical approval refusal settlement

The UI acceptance handoff identified a C2 parent still in `awaiting_approval`
after its child approval was rejected and rejection effects had completed. The
candidate remained inactive. The original captured records were left unchanged;
the failure was reproduced in isolated fixtures and repaired in the runtime owner.

`EvolutionControlPlaneService` now reconciles the exact current approval binding
on durable resolution delivery, startup and explicit resume. It also rechecks
after persisting a wait to cover resolution arriving before that write. Denial
settles initial apply as `cancelled`; approval expiry settles it as `failed`.
Both clear the one-time action, retain the approval and event evidence, and
release the target claim. Existing cleanup owners discard temporary setup inputs
before release; unavailable cleanup remains retryable. Refusing rollback instead
records `manual_required`, retaining the prior effect and recovery references.
No apply or rollback operation is invoked by refusal settlement, and pending or
approved decisions never auto-apply through reconciliation. Read projections stay
read-only.

The durable `approval_resolution_signals` callback uses the canonical approval
owner. Pending approval expiry uses database time, including when the Gateway
clock is ahead; a completed rejection retains its recorded resolution timestamp.
Its bounded storage lookup matches the current required action rather than
historical links. SQLite and PostgreSQL use their native JSON expressions; no
schema migration or user-data edit is required. Revision checks preserve competing
terminal transitions. A full batch asks the existing durable signal worker to
retry rather than silently omit additional waiting parents.

Fresh local evidence:

- Four Gateway test files pass all 36 tests, including real workflow capture,
  immutable candidate staging, artifact review, child approval creation, rejection,
  durable effect execution, repeat delivery and a new service instance recovering
  the older completed-effect/still-waiting-parent state. The candidate stays
  non-callable; a fresh plan can claim the released target. Additional cases cover
  expiry, Gateway clock skew, foreign scope, mismatched approval, unavailable
  owners, temporary-input cleanup and preserved rollback effects. Receipt:
  `.tmp/comparison-plan-approval-unit-v6.log`.
- The initial refusal regression and the temporary-input cleanup regression were
  both observed failing before their fixes. Their receipts are
  `.tmp/comparison-plan-approval-reproduce-v1.log` and
  `.tmp/comparison-plan-approval-cleanup-reproduce-v1.log`.
- Six SQLite repository tests pass. An actual PostgreSQL test uses separate
  connections to prove exact current binding, ignored historical references,
  rejection of a stale competing revision, one terminal event and preserved
  unrelated waits. This is a stale-witness CAS test, not a simultaneous race.
  Receipts: `.tmp/comparison-plan-approval-storage-v1.log` and
  `.tmp/comparison-plan-approval-postgres-v1.log`. The task-owned loopback cluster
  was stopped after verifying its exact data directory, PID, executable and port.
- Storage/Gateway typecheck and strict scoped lint pass. The asynchronous Gateway
  boundary lane passes its ten scanner tests and scans 991 production files.
  Receipts: `.tmp/comparison-plan-approval-typecheck-v4.log`,
  `.tmp/comparison-plan-approval-lint-v7.log` and
  `.tmp/comparison-plan-approval-async-boundary-v1.log`.
- The runtime verifier now opens the canonical shell's collapsed Recovery
  disclosure. It verifies the exact approval-wait run and its linkage to the
  resumed Chat run, whose separate identity remains the backend resume authority.
  Five verifier unit tests pass, including rejection of mismatched identities or
  incomplete outcomes. Receipt:
  `.tmp/comparison-plan-approval-runtime-verifier-unit-v2.log`.
- The final `verify:runtime:truth` run passes both backend restart/resume and
  browser recovery checks without skips. Evidence:
  `artifacts/verification/2026-09-13T11-20-12-493Z-runtime-truth-2ff51bfe/manifest.json`.
  The retained browser screenshot was inspected. The deterministic stub does not
  supply an approval-explainer JSON response, so this is recovery-state proof,
  not approval-summary quality proof.
- The final `verify:durable:recovery` run passes all three stack, worker and
  approval-wake scenarios without skips. Evidence:
  `artifacts/verification/2026-09-13T11-20-54-253Z-durable-recovery-4cc29e66/manifest.json`.
  Earlier failed browser-verifier receipts are retained; the current disclosure
  and exact canonical run assertions were verified by real reruns.

These checks use synthetic completed-turn evidence, task-owned storage and local
provider stubs. They do not prove live provider quality, Telegram delivery,
installed desktop behavior or Mini PC acceptance. No drive was attached,
partitioned, formatted, mounted or given new root permissions. No installed
service, credential, external message or user database was changed. C1-C6 and
the overall plan remain open.

## Complete memory enumeration

The local GATE-01 follow-up is implemented across contracts, storage,
`MemoryLifecycleService`, the operator route, shared client/hook and canonical
Memory page. The additive SQLite 227 / PostgreSQL 172 migrations maintain a
transactional mutation generation and deterministic keyset order. Signed
cursors reject changed filters, scope, committed writes, expiry and owner
replacement. Canonical workspace/global visibility remains unchanged.

The UI appends bounded pages, displays the complete search total and labels
namespace/lifecycle counts as counts of loaded records. It suppresses duplicate
requests and superseded responses, retains stale results with a warning, and
offers Reload memory without exposing raw error JSON. The internal bounded
array reader remains available for existing lifecycle collaborators.

Verified locally:

- 54 focused Gateway tests pass across pagination integration, Memory routes,
  lifecycle and route facades: `.tmp/comparison-memory-enumeration-gateway-v1.log`.
- 40 shared-client/hook tests and 38 canonical UI tests pass:
  `.tmp/comparison-memory-enumeration-shared-final-v2.log` and
  `.tmp/comparison-memory-enumeration-ui-v1.log`.
- The SQLite repository and versioning run passes 28 tests; the final repository
  rerun and actual PostgreSQL run both enumerate 1,211 items in three pages with
  five mutation invalidations, expiry and schema preservation:
  `.tmp/comparison-memory-enumeration-sqlite-v2.log`,
  `.tmp/comparison-memory-enumeration-sqlite-v3.log`, and
  `.tmp/comparison-memory-enumeration-postgres-v3.log`.
- The named migration-parity lane passes: 227 SQLite / 172 PostgreSQL migrations,
  immutable lineage, explicit integrity digests and runtime schema checks.
  Evidence: `.tmp/comparison-memory-enumeration-migration-parity-v3.log`.
- The async Gateway boundary passes all ten scanner tests and scans 992 production
  TypeScript files: `.tmp/comparison-memory-enumeration-async-boundary-v1.log`.
- Final locked contracts/storage/Gateway/shared/Next typechecking, strict scoped
  lint and docs checks pass: `.tmp/comparison-memory-enumeration-typecheck-v4.log`,
  `.tmp/comparison-memory-enumeration-lint-v4.log` and
  `.tmp/comparison-memory-enumeration-docs-v1.log`.
- The final named Memory lane passes 2/2 scenarios:
  `artifacts/verification/2026-09-13T12-09-40-173Z-memory-truth-714d04de/manifest.json`.
  The browser enumerates 503 matching records, rejects a continuation after a real
  inserted fixture item, then reloads to all 504. TTL expiry remains visible in
  both the list and detail inspector. Screenshots were visually inspected.

Earlier named runs retain fixture-minimum, outdated lifecycle-label and
search-debounce race failures. The verifier now waits for the matching search
and commits the real test mutation after the browser selects its continuation,
before forwarding that request to the Gateway. No response is substituted.
The final stale-page screenshot uses the corrected plain-language warning.

The global generation deliberately invalidates cursors even for unrelated
workspace writes; busy installations may need more reloads. This work uses only
owned temporary storage, loopback provider fixtures and local embeddings. No
real drive, installed service, credentials, external destination or user database
was changed. Other local/source work and live acceptance in C1-C6 remain open.

## Memory maintenance save revisions

The Memory portion of GATE-02 now has canonical compare-and-save through
`MemoryLifecycleService`, `MemoryMaintenanceService`, the storage repository,
HTTP schemas, shared clients and the canonical Library editor. Policy records
and recommendation records carry opaque revisions. Missing preconditions fail
closed; a stale revision or another workspace's policy returns a conflict.
Query/body workspace disagreement is rejected instead of silently patching the
default workspace. First-read initialization cannot replace an existing policy.

Policy updates lock and compare inside SQLite immediate transactions and actual
PostgreSQL row locks. Revisions advance even for identical writes and backward
clocks. Recommendation acceptance compares the reviewed proposal and policy,
then commits the policy and terminal decision together. A second-write failure
rolls back both. Applied/rejected decisions cannot be overwritten. The policy
write no longer depends on a fallible scheduler-state refresh after commit.
The routes mark canonical commit before delivering their response.

The editor preserves conflict drafts, shows the current policy for review and
uses the selected revision when saving again. A pending save cannot clear edits
typed after submission. Older API clients must supply the new preconditions;
there is no unguarded fallback. No schema migration was required. See the
[API and operator guide](../MEMORY_MAINTENANCE_REVISIONS.md).

Retained verification:

- Existing storage tests: 7 passed in `.tmp/comparison-memory-policy-storage-v1.log`.
- Real independent SQLite writers, wrong-scope/stale/ABA checks and injected
  transaction rollback passed in `.tmp/comparison-memory-policy-atomic-sqlite-v1.log`.
- The same tests on actual PostgreSQL passed in
  `.tmp/comparison-memory-policy-postgres-v1.log`; the owned loopback cluster
  stopped and was retained as `gc-memory-policy-pg-uqtemw0o.zxi`.
- Gateway maintenance/lifecycle/facade/route and real HTTP-to-storage
  integration tests: 53 passed across five files in
  `.tmp/comparison-memory-policy-gateway-v3.log`.
- Shared API/hook/wrapper tests: 37 passed in
  `.tmp/comparison-memory-policy-shared-v4.log`.
- Named Memory truth passed 3/3 in
  `artifacts/verification/2026-09-13T12-44-34-782Z-memory-truth-dafb338a/manifest.json`.
  The new browser scenario races an actual Gateway write after preflight,
  observes `409`, preserves the winner and local draft, then saves after review.
  The conflict and successful-save screenshots were visually inspected.
  Existing TTL and complete-enumeration browser scenarios also pass.
- The five affected TypeScript projects passed through the output-lock wrapper
  (`.tmp/comparison-memory-policy-typecheck-v3.log`). Strict scoped lint passed
  (`.tmp/comparison-memory-policy-lint-v3.log`). The named asynchronous Gateway
  boundary check passed ten tests and scanned 993 production TypeScript files
  (`.tmp/comparison-memory-policy-async-boundary-v1.log`). Documentation checks
  passed (`.tmp/comparison-memory-policy-docs-v1.log`).

Earlier failures remain recorded: initial route tests reproduced the missing
revision and ignored workspace; the first shared run caught missing initial
draft revision wiring; scheduler fixtures were adjusted to explicitly read
scheduler state; initial strict lint required schema extraction and removal of
a stale hook dependency. They are not counted as passing evidence.

This closes the local Memory policy/recommendation portion of GATE-02. At that
checkpoint, Workbench file/path saves and Citadel, personality, permission profile, integration and
MCP mutation owners still need individual revision acceptance. No real disk was
attached, partitioned, formatted or mounted. No installed service, user database,
credential or external destination was changed. The overall C1-C6 plan remains
in progress.

## Workbench file save revisions

The content-save portion of GATE-02 now has required scoped revisions through
the Gateway owner, shared contract and editor. Existing-file saves compare the
reviewed bytes and physical identity while holding the project's exclusive
write lock. Independent Gateway processes cannot both save the same revision.
Explicit null permits creation only while the path remains absent. Existing
file identity and permissions are preserved; linked-file writes are rejected.

Workbench file actions, patches, reverts and commands share the write lock.
The reserved lock is excluded from tree/change projections and guarded against
file, patch and revert access. Locks are never stolen on a timeout. A saved
response acknowledges its captured file snapshot, even if another writer changes
the file during follow-up validation. Post-write failures retain non-retryable
mutation truth. The editor preserves the draft, fetches the conflicting version
for review and sends only the explicitly selected revision on the next save.

Retained verification:

- 87 Gateway tests passed across five files, including two independent writer
  processes, stale/wrong-scope/ABA/replacement checks, path-jail regressions,
  ambiguous post-write errors and HTTP preconditions:
  `.tmp/comparison-workbench-revisions-gateway-v3.log`.
- 22 editor-hook tests and 16 shared-client tests passed:
  `.tmp/comparison-workbench-revisions-hook-v1.log` and
  `.tmp/comparison-workbench-revisions-client-v1.log`.
- The named Workbench lane passed 2/2 scenarios:
  `artifacts/verification/2026-09-13T13-40-19-438Z-agentic-workbench-loop-57716bcf/manifest.json`.
  Its owner profile also includes the independent-process and route guard tests.
  The production UI browser journey inserts an actual Gateway save after browser
  preflight, observes `409`, preserves the winner and draft, then saves with the
  reviewed revision. Desktop conflict/save and 390px screenshots were inspected.
- Locked contracts/shared/threaded-core/Gateway/Next typechecking passed in
  `.tmp/comparison-workbench-revisions-typecheck-v2.log`. Strict scoped lint passed
  in `.tmp/comparison-workbench-revisions-lint-v3.log`. The asynchronous Gateway
  boundary passed all ten tests in
  `.tmp/comparison-workbench-revisions-async-boundary-v1.log`.
- Documentation checks passed in `.tmp/comparison-workbench-revisions-docs-v1.log`.
  The scoped audit records hashes for 19 source/test/documentation files and
  confirms clean whitespace/line endings and no staged changes:
  `.tmp/comparison-workbench-revisions-audit-v1.json`.

The baseline test reproduced the unconditional overwrite. Initial test failures
retained missing-revision fixtures and a cleanup-prefix omission; both were
corrected and rerun. Earlier browser runs targeted the hidden toolbar shortcut,
then an outdated Monaco textarea selector. The final verifier follows Activity
to Open build editor and edits through the visible code surface. No navigation
or editor-rendering change was needed.

This is cooperative Workbench coordination, not a filesystem transaction or
hostile-process sandbox. External tools that do not use this owner can still
race I/O, and interrupted in-place writes can be partial. Directory/path action
review preconditions remain open; their serialization alone does not close that
acceptance item. See the [operator/API guide](../WORKBENCH_FILE_REVISIONS.md).
No schema migration or user database change was needed. All Git repositories,
runtime writes and processes used for acceptance were task-owned fixtures.
No drive was attached, partitioned, formatted or mounted. Other GATE-02 owners
and remaining C1-C6 source/live acceptance work remain in progress.

## Workbench file action reviews

This completes the local file-action precondition slice of GATE-02. Create file,
create folder, rename, move, duplicate and delete now require a review revision;
they cannot fall back to an unconditional legacy request. This is source and
isolated-runtime proof, with the broader plan still in progress.

The Gateway owns a bounded, recursive review that binds the canonical session,
project, physical root, normalized action and initial content, exact source
bytes/identity, folder membership and destination-parent identity. Review and
apply use the existing cross-process project lock, shared with content saves.
Changed sources or destinations fail with 409 before the operation starts.
Unavailable/protected or oversized scopes fail closed instead of truncating the
review. Windows device/stream names and aliases of protected paths are rejected.

The shared API and Chat build editor expose **Review file action** followed by
**Apply reviewed action**. Inputs survive failed/uncertain applications, and
editing any input clears its review. Pending replies cannot replace later edits;
changing the session/project/worktree discards the earlier review. A post-write
validation/publication failure retains committed mutation truth.

Local evidence:

| Proof | Result | Evidence |
| --- | --- | --- |
| Gateway owner, path snapshot, shared file lock, route and composition checks | 103 passed / 7 files | `.tmp/comparison-workbench-path-gateway-v2.log` |
| Shared hooks, stale session responses and conflict handling | 26 passed / 2 files | `.tmp/comparison-workbench-path-hook-v2.log` |
| Shared API and required revision transport | 17 passed | `.tmp/comparison-workbench-path-client-v2.log` |
| Workbench/Workflow UI plus isolated action-form tests | 33 + 5 passed | `.tmp/comparison-workbench-path-ui-v1.log`, `.tmp/comparison-workbench-path-form-v1.log` |
| Locked five-project typecheck | Passed | `.tmp/comparison-workbench-path-typecheck-final.log` |
| Strict scoped lint | Passed | `.tmp/comparison-workbench-path-lint-v2.log` |
| Documentation and owner-boundary checks | Passed, including 9 Docker-secret source tests | `.tmp/comparison-workbench-path-docs-v1.log` |
| Async Gateway boundary | 10 scanner tests passed; 995 production TypeScript files scanned | `.tmp/comparison-workbench-path-async-boundary-v1.log` |
| Named Workbench owner + real Gateway/browser lane | 2/2 passed | `artifacts/verification/2026-09-13T14-16-55-720Z-agentic-workbench-loop-b54e8187/manifest.json` |

The browser inserts a real Gateway content write after the file-action review.
The stale rename returns 409 and leaves the winning source intact and destination
absent. A fresh explicit review supplies a different revision; the accepted
rename preserves the exact winning bytes. The final run opens **Browse files**
at 390 px, displays the reviewed scope and applies the rename at that width.
Desktop conflict/success and narrow review screenshots were visually inspected.
The browser's original content-save conflict/review journey also passes. An initial path scenario failed because its
Action dropdown selector did not match; that failure was retained and corrected
using the rendered combobox. No production behavior was changed for that selector.

The review bounds are 500 paths, 32 MiB and 32 folder levels. This does not create
an OS transaction or prevent uncooperative filesystem writers. Full settings
owner preconditions, native-worker quotas/protected execution/installation,
mini-PC and Telegram acceptance, and the comparable live outcomes remain open.
No drive was attached, partitioned, formatted or mounted; no root ACL, installed
service, user database, live-provider credential or external channel was changed.
The scoped audit records 32 file hashes and zero staged changes. The final
cleanup audit found no acceptance listeners, owned process matches or retained
runtime roots, and stopped no additional process. Receipts are
`.tmp/comparison-workbench-path-audit-v1.json` and
`.tmp/comparison-workbench-path-cleanup-v1.json`.
See the [operator and API contract](../WORKBENCH_FILE_REVISIONS.md).

## Permission profile save and archive revisions

The profile-record portion of GATE-02 now enforces reviewed revisions in the
storage owner, Gateway routes and canonical Settings editor. List/create/update
snapshots return a revision; update and archive require the caller's reviewed
token. SQLite immediate transactions and PostgreSQL row locks protect the
comparison and mutation. A monotonic timestamp prevents same-value and
restore-to-previous-value edits from reviving an old revision. Built-ins remain
immutable, ownership restrictions remain authoritative and failed outer
transactions roll back the update.

The editor preserves conflicting drafts and shows readable current rules.
It does not permit a rejected save to retry against the same returned token.
Explicit review and rebase are required before saving again. Archive confirmation
captures the selected profile revision; a conflict closes the stale confirmation
and retains the draft so the operator can review and open a new one. Ordinary
profile edits also no longer reassert unchanged default policy contexts.

Local evidence:

| Proof | Result | Evidence |
| --- | --- | --- |
| SQLite repository and independent update/update, update/archive writers | 12 passed | `.tmp/comparison-permission-profile-storage-v1.log` |
| Actual temporary PostgreSQL with both independent-writer races and rollback | 1 passed | `.tmp/comparison-permission-profile-postgres-v1.log` |
| Existing Gateway permission, commit-truth and default policy suites | 22 passed / 3 files | `.tmp/comparison-permission-profile-gateway-v1.log` |
| New route preconditions, ownership, 409/commit state and unchanged-default regressions | 23 passed / 2 files | `.tmp/comparison-permission-profile-focused-gateway-v1.log` |
| Shared API revision transport | 2 passed | `.tmp/comparison-permission-profile-client-v1.log` |
| Settings UI, including retained drafts when reload still returns the rejected revision | 117 passed / 2 files | `.tmp/comparison-permission-profile-ui-v3.log` |
| Locked contracts/storage/shared/Gateway/Next typecheck | Passed | `.tmp/comparison-permission-profile-typecheck-final.log` |
| Strict scoped lint | Passed | `.tmp/comparison-permission-profile-lint-v2.log` |
| Documentation and owner-boundary checks, including 9 Docker-secret source tests | Passed | `.tmp/comparison-permission-profile-docs-v1.log` |
| Async Gateway boundary | 10 tests; 995 production TypeScript files scanned | `.tmp/comparison-permission-profile-async-boundary-v1.log` |
| Named real Gateway/browser permission revision lane | 1/1 passed | `artifacts/verification/2026-09-13T14-57-46-467Z-permission-profile-revisions-3c26de9e/manifest.json` |

The browser races each mutation with a separate actual Gateway write after
review. Both stale requests return 409, preserve the winning record and retain
the draft. Fresh reviewed save and archive requests succeed. The final lane
captures readable desktop/narrow conflict review and a 390 px archive dialog;
screenshots were visually inspected. Its asserted 409s remain in the conflict
logs. An intermediate rerun failed because its text selector also matched the
hidden profile list; the final verifier scopes the lookup to Current saved
profile. The first screenshot inspection also found clipped JSON on narrow
screens, replaced with the readable current-rule fields in the final proof.

This completes the local profile save/archive slice, not the full permission
profile gate. Competing activation/default-selection changes still need a
reviewed selection-generation contract and atomic cross-profile coordination.
Citadel, personality, integration and MCP mutation preconditions, C5/C6 source
work, and external acceptance remain open. No schema migration, installed service
change, user database mutation, live-provider request or external message was
required. No drive was attached, partitioned, formatted or mounted.
The cleanup receipt confirms no remaining acceptance listeners, owned process
matches or runtime roots; the PostgreSQL PID file is absent. It stopped no
additional processes: `.tmp/comparison-permission-profile-cleanup-v1.json`.
See the [operator and API contract](../PERMISSION_PROFILE_REVISIONS.md).

## Permission activation and default-selection revisions

This completes the local permission-profile revision slice of GATE-02, following
the record save/archive work above. Activating a profile, creating with defaults
or changing a default set now requires an explicit selection review. The Gateway
binds that review to its authenticated actor and normalized context. The storage
owner compares the reviewed generation under a shared transaction guard before
any write, including competing profiles and initially empty contexts. Default
creation and updates commit the profile and its activation changes together.

SQLite migration 228 and PostgreSQL migration 173 add the selection-generation
table. The append-only manifest updater accepted only the new suffix. Tests
reconstruct the pre-addition shape in disposable databases and verify existing
profile rows and activation history remain identical after installing the table.
Reapplication preserves its generation and current selections. Same-context
activation/deactivation sequences cannot revive an earlier token. Ordinary
record edits and unchanged default sets do not reassert a selection.

Settings now presents a readable review before **Apply reviewed selection**.
Default changes require **Review default selection** before create/save. A
conflict clears the review, preserves the draft and winning state, and requires
fresh explicit review. Draft/context changes and out-of-order responses cannot
restore an earlier review. The panel shows filesystem reads, approval behavior,
tool rules and current selections; defaults identify the currently saved rules
separately from the draft being edited.

Local evidence:

| Proof | Result | Evidence |
| --- | --- | --- |
| SQLite record regressions after introducing the selection guard | 12 passed | `.tmp/comparison-permission-selection-storage-regression-v1.log` |
| SQLite selection conflicts, three independent-writer races, rollback and additive preservation | 1 comprehensive test passed | `.tmp/comparison-permission-selection-storage-v2.log` |
| Actual temporary PostgreSQL with the same independent-writer and preservation checks | 1 comprehensive test passed | `.tmp/comparison-permission-selection-postgres-v2.log` |
| Gateway routes, atomic owner delegation, commit truth and existing permission flows | 55 passed / 6 files | `.tmp/comparison-permission-selection-gateway-v2.log` |
| Shared API review and exact revision transport | 3 passed | `.tmp/comparison-permission-selection-client-v1.log` |
| Settings UI with reviewed activation/default actions | 117 passed / 2 files | `.tmp/comparison-permission-selection-ui-v2.log` |
| Review hook context changes, out-of-order replies and failed refresh | 3 passed | `.tmp/comparison-permission-selection-hook-v1.log` |
| Locked contracts/storage/shared/Gateway/Next typecheck | Passed | `.tmp/comparison-permission-selection-typecheck-final.log` |
| Strict scoped lint and final review component lint | Passed | `.tmp/comparison-permission-selection-lint-v2.log`, `.tmp/comparison-permission-selection-review-lint-final.log` |
| Named migration parity, integrity and runtime-schema lane | 27 + 24 + 45 tests passed; SQLite 228 / PostgreSQL 173 | `.tmp/comparison-permission-selection-migration-parity-v2.log` |
| Documentation and owner-boundary checks, including 9 Docker-secret source tests | Passed | `.tmp/comparison-permission-selection-docs-v1.log` |
| Async Gateway boundary | 10 tests; 995 production TypeScript files scanned | `.tmp/comparison-permission-selection-async-boundary-v1.log` |
| Named real Gateway/browser permission revision lane | 2/2 passed | `artifacts/verification/2026-09-13T15-44-15-987Z-permission-profile-revisions-3e7204db/manifest.json` |

The final browser lane retains the record save/archive scenario and adds actual
Gateway peers racing browser activation, default edit and default creation.
All three stale selection requests return 409; the winning selections and both
drafts survive, and a rejected create leaves no extra profile. Fresh reviews
then apply successfully. Desktop activation review and 390 px default/create
review screenshots were visually inspected, including the apply/save controls.
The first captures missed the review panel; the verifier now scrolls to it and
dismisses ordinary notification overlays before capturing. Expected 409s remain
in conflict logs. Existing integration-route fixtures were updated to supply
their now-required record revisions, and the migration registry assertions were
advanced to the reviewed new versions.

Selection review invalidation is deliberately conservative: any repository
profile/activation change invalidates outstanding selection reviews across the
permission domain. Reviews fail closed above 1,000 explicit activations in their
exact scope. This does not change inherited-policy resolution, the separate
runtime activation-enumeration limit, local-operator-override lifecycle or raw
database-writer guarantees. Citadel, personality, integration and MCP mutation
preconditions, C5/C6 source work and full C1-C6 acceptance remain open.

No drive was attached, partitioned, formatted or mounted. No root ACL, installed
service, user database, live-provider credential or external channel was changed.
Both task-owned PostgreSQL instances stopped after their checks. The final
read-only cleanup audit found zero acceptance listeners, matching owned
processes, temporary runtime roots or PostgreSQL PID files, and stopped no
additional process: `.tmp/comparison-permission-selection-cleanup-v1.json`.
The scoped audit covers 33 source/document/manifest files with zero staged
changes: `.tmp/comparison-permission-selection-audit-v1.json`. See the
[operator and API contract](../PERMISSION_PROFILE_REVISIONS.md).

## Personality catalog revisions

The local personality portion of GATE-02 now has an end-to-end revision contract.
All catalog writers require the same reviewed catalog revision: create, edit,
rename, reset, remove and Work-default selection. `PersonalityCatalogService`
projects one settings snapshot and uses the existing data-only settings CAS.
SQLite immediate transactions and PostgreSQL row locks protect concurrent
writers, including first insertion. Accepted writes advance the row timestamp;
same-value and change/revert sequences cannot revive old tokens. Responses
retain their own committed snapshot even if a peer commits before they return.
No schema migration or initialization on catalog reads is required.

Settings preserves stale drafts and displays the current saved instructions or
catalog before explicit rebase. A refresh that still returns the rejected token
cannot enable rebase/save. Default/reset/remove dialogs capture the saved label
and revision when opened; conflicts close those dialogs and require new review.
Text typed during creation or rename follows the committed ID without another
create. If a peer removes a personality, its draft remains readable and is not
silently recreated. The Chat command forwards its catalog read and never
refreshes/retries a conflicting mutation.

Local evidence:

| Proof | Result | Evidence |
| --- | --- | --- |
| SQLite owner, legacy/ABA/acknowledgement checks and six independent-writer races | 1 comprehensive test passed; PostgreSQL skipped in this invocation | `.tmp/comparison-personality-sqlite-v2.log` |
| Same SQLite proof and actual temporary PostgreSQL owner/race proof | 2 passed | `.tmp/comparison-personality-postgres-v1.log` |
| Gateway routes, commit truth, command and channel personality regressions | 73 passed / 6 files | `.tmp/comparison-personality-gateway-v2.log` |
| Shared client exact mutation bodies | 4 passed | `.tmp/comparison-personality-client-v1.log` |
| Settings UI including conflict retention, deleted source and in-flight creation/rename | 121 passed / 2 files | `.tmp/comparison-personality-ui-v4.log` |
| Locked contracts/storage/shared/Gateway/Next typecheck and final helper check | Passed | `.tmp/comparison-personality-typecheck-v5.log`, `.tmp/comparison-personality-typecheck-final.log` |
| Strict scoped lint and final helper lint | Passed | `.tmp/comparison-personality-lint-v1.log`, `.tmp/comparison-personality-final-helper-lint.log` |
| Documentation and owner checks, including Docker-secret source tests | Passed; 9 tests | `.tmp/comparison-personality-docs-v1.log` |
| Async Gateway boundary | 10 tests passed; 996 production TypeScript files scanned | `.tmp/comparison-personality-async-boundary-v2.log` |
| Named real Gateway/browser personality lane | 1/1 passed; 5 conflicts and 5 explicitly reviewed successes | `artifacts/verification/2026-09-13T16-29-57-570Z-personality-catalog-revisions-20314c5d/manifest.json` |

The browser lane uses real competing Gateway writes for creation, editing,
default selection, reset and removal. Every rejected request preserves the
whole winning catalog and the pending draft. It also rejects four mutation
shapes without review tokens. Desktop retained-draft/default captures and
390 px creation/removal captures were visually inspected. Expected 409s remain
in their conflict logs. The first browser run reached the reset check but failed
because the verifier incorrectly expected reset to retain the default; it now
asserts the existing reset behavior, which clears the selected default.

Catalog invalidation is deliberately conservative across all personalities.
These checks do not establish raw-database-writer protection, installed desktop,
live inference, external channels, second-machine readiness or a comparative
benchmark result. Citadel, integration and MCP mutation preconditions, C5/C6
source work and full C1-C6 acceptance remain open.

No drive was attached, partitioned, formatted or mounted. No root ACL, installed
service, user database, live-provider credential or external channel was changed.
The task-owned PostgreSQL cluster stopped after ownership verification. The
read-only cleanup audit found zero acceptance listeners, matching owned
processes, runtime roots or PostgreSQL PID files; it stopped no additional
process: `.tmp/comparison-personality-cleanup-v1.json`. The scoped audit records
28 source/document files and zero staged paths while preserving existing work:
`.tmp/comparison-personality-audit-v1.json`. See the
[operator and API contract](../PERSONALITY_CATALOG_REVISIONS.md).

## Citadel profile record revisions

The local profile-record portion of GATE-02 now has a required review contract
for edits, archive and restore. The record token excludes derived Charter
presence; directory and detail reads agree. SQLite immediate transactions and
PostgreSQL row locks protect comparison, mutation and the returned acknowledgement
together. Timestamps advance for same-value saves and backdated clocks, so ABA
edits cannot revive old reviews. Creation preserves unique identity and cannot
overwrite an existing id or slug. No schema migration is required.

Settings retains stale and in-flight drafts, requires explicit rebase, and keeps
a rejected token latched while refresh still returns that token. Duplicate-slug
errors remain distinct from revision conflicts. Empty descriptions can be
cleared. Both Settings and Library capture archive confirmation identity and
revision and require fresh review after conflict. Library refreshes the profile
without replacing an unsaved Charter. Lifecycle buttons require a loaded review.

Current evidence:

- SQLite revision/concurrency and existing Citadel repository tests: 16 passed
  (`.tmp/comparison-citadel-record-sqlite-v1.log`). Five independent writer pairs
  cover edit/edit, edit/archive, edit/restore, archive/archive and restore/restore.
- Actual PostgreSQL owner and the same five races passed with no skips
  (`.tmp/comparison-citadel-record-postgres-v1.log`). The owned temporary cluster
  on port 58313 stopped after data-directory, PID, executable and port checks.
- Gateway existing routes/services: 57 passed; new mutation validation,
  forwarding, conflict and commit-truth tests: 27 passed. Shared client: 17 passed.
- Canonical UI: 73 tests passed across Settings and Citadel Overview, including
  retained drafts, explicit review, stale-refresh latching, in-flight typing,
  duplicate-slug distinction, archive confirmation and restore retry.
- `pnpm verify:citadels:revisions`: 1/1 passed in
  `artifacts/verification/2026-09-13T17-20-15-553Z-citadel-record-revisions-13efc67f/manifest.json`.
  Three missing-review requests were rejected; five actual competing API writes
  caused browser 409s, followed by five reviewed successful mutations. Desktop
  and 390 px screenshots record Settings edits and Library lifecycle review.
- Async Gateway boundary: 10 tests passed; 996 production TypeScript files scanned.
- Final contracts/storage/shared/Gateway/UI typecheck, scoped strict lint,
  `pnpm docs:check` (including nine Docker-secret source tests), and diff checks
  passed. The newly tracked sidebar fallback comment now states its intentional
  in-memory behavior in the repository's required rationale form.

The first two browser attempts failed on verifier-only heading and tab selectors;
their artifacts remain available. The successful run used the actual accessible
roles and completed every planned profile conflict and recovery assertion.

This completes the local profile-record slice, not all Citadel revisions or the
overall comparison program. Charter/template/blueprint and mutable access-rule
owners, integration/MCP revisions, Windows worker source work, matched comparison
benchmarks and full C1-C6 live acceptance remain open. No drive was attached,
partitioned, formatted or mounted. No installed service, user database, provider
credential or external channel was changed. See the
[operator and API contract](../CITADEL_RECORD_REVISIONS.md).

The read-only cleanup audit found zero remaining owned listeners, matching
processes, verification runtime roots or PostgreSQL PID files and stopped no
additional process (`.tmp/comparison-citadel-record-cleanup-v1.json`). A scoped
18-file source audit and separate local backup follow the operator-requested
GitHub preservation checkpoint `a15fdb851`. The program remains active.

## GitHub preservation and CI recovery

The operator-requested combined comparison/UI checkpoint is on GitHub `main` as
`a15fdb851`, followed by the verified Citadel profile slice `136494173`. The
follow-up [CI recovery report](CHECKPOINT_CI_RECOVERY_2026_09_13.md) records the
full-repository lint fixes, local validation, dependency review and remaining
hosted test failures. Publication preserves the work; the comparison program
and drive-formatting pause remain active.

## Remaining acceptance inputs

Telegram is the initial channel. The operator has a mini PC available, but its
Windows version, connection method, test chat ID, and combined provider-request
and dollar caps are still pending. Credentials must be entered through their
dedicated local setup flow. These inputs do not account for the unfinished C5/C6
source work listed above.
