import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJsonString, hashRemoteWorkerControllerPublicKey, createRemoteWorkerNativeCapacityDelivery, REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES,
  type RemoteWorkerNativeCapacityPage } from "@goatcitadel/contracts";
import { nativeCapacityCompositionFixture } from "../../contracts/src/remote-worker-native-capacity-composition-test-fixture.js";
import { verifyCellProvisioningExchange } from "./remote-worker-cell-exchange-fixture.js";
import { RemoteWorkerNativeCapacityPagesRepository } from "./remote-worker-native-capacity-pages-repo.js";
import { RemoteWorkerNativePoolRepository } from "./remote-worker-native-pool-repo.js";
import { createRemoteWorkerNativePoolCapacityDelivery, remoteWorkerCellCanonicalSha256 } from "@goatcitadel/contracts";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { createDatabase } from "./sqlite.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { ApprovalRepository } from "./approval-repo.js";
import { RemoteWorkerRuntimeInstallRepository } from "./remote-worker-runtime-install-repo.js";
import { snapshotRuntimeInstallPoolCapture, validateRuntimeInstallPoolCapture } from "./remote-worker-runtime-install-capture.js";
import { hashRemoteWorkerInstallCapacityCapture } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import type { RemoteWorkerCellCapacityAuthority } from "./remote-worker-cell-capacity-admission-repo.js";
import { REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION,
  readRemoteWorkerCellProvisioningCheckpoint, remoteWorkerRuntimeInstallRequestSha256,
  type RemoteWorkerCellProvisioningExchange } from "@goatcitadel/contracts";

/** Real canonical rows and durable pages, controlled native source frames only. */
function verifyNativeCapacityPagesForPhase(phase: "ready" | "provisioning", fullPool = false): typeof verifyCellProvisioningExchange {
  return (db, key, token, fence, revoke) => {
  verifyCellProvisioningExchange(db, key, token, fence, revoke, (authority, history) => {
    const owner = new RemoteWorkerNativeCapacityPagesRepository(db), cells = new RemoteWorkerCellRepository(db);
    const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    const readAdmission = phase === "ready" ? owner.readAdmissionForAssignment.bind(owner) : owner.readInstallationCapacityForAssignment.bind(owner);
    const provisioning = cells.getCell(key)!;
    assert.equal(provisioning.executionState, "provisioning");
    assert.throws(() => owner.readAdmissionForAssignment({ ...authority, expectedCapacityRevision: provisioning.capacityRevision,
      expectedExecutionRevision: provisioning.executionRevision, expectedCleanupRevision: provisioning.cleanupRevision, expectedBackupRevision: provisioning.backupRevision }));
    // Controlled platform evidence uses the actual provisioning -> ready owner;
    // no disk or native process is created by this database fixture.
    if (phase === "ready") cells.persistPlatformIdentity({ ...key, provisioningOwner: provisioning.provisioningOwner!, provisioningLeaseExpiresAt: provisioning.provisioningLeaseExpiresAt!,
      platformIdentity: { schemaVersion: "goatcitadel.remote-worker-cell-platform.v2", backend: "windows_native", jobName: history.plan.cellName,
        appContainerName: `GoatCitadel.Worker.${history.plan.cellName.slice(8)}`, volumeIdentitySha256: hash("controlled-volume"),
        runtimeBundleSha256: hash("controlled-runtime"), launcherSha256: hash("controlled-launcher"), networkPolicy: "deny_all" },
      detailSha256: hash("controlled-ready-platform"), now: new DurableRunRepository(db).readDatabaseNow() });
    const f = nativeCapacityCompositionFixture({ history, ...(phase === "provisioning" ? { guestLogicalBytes: 9000 } : {}) });
    const capture = (() => {
      if (!fullPool) {
        const delivery = createRemoteWorkerNativeCapacityDelivery(canonicalJsonString({ layout: f.layout, window: f.window, source: f.source }), history, f.window.nonce);
        return { delivery, retained: { history, layout: delivery.layout, window: f.window } };
      }
      const pool = new RemoteWorkerNativePoolRepository(db).readSnapshotForAssignment(authority);
      const { hostCaptureHex, guestObservationHex, guestChunkHex, backingObservationHex, references } = f.source;
      const source = { hostCaptureHex, members: [{ guestObservationHex, guestChunkHex, backingObservationHex }], references };
      const window = { nonce: f.window.nonce, connectionNonceHex: "71".repeat(32), poolSnapshotSha256: remoteWorkerCellCanonicalSha256(pool),
        hostCaptureSha256: f.window.hostCaptureSha256, membersSha256: remoteWorkerCellCanonicalSha256(source.members), referencesSha256: f.window.referencesSha256 };
      const delivery = createRemoteWorkerNativePoolCapacityDelivery(canonicalJsonString({ layout: f.layout, window, source }), pool, window.nonce);
      return { delivery, retained: { pool, layout: delivery.layout, window } };
    })();
    const { delivery } = capture;
    const json = canonicalJsonString(delivery), bytes = Buffer.from(json, "utf8"), before = cells.getCell(key)!;
    const prepared = { ...authority, retained: capture.retained,
      bundleSha256: delivery.bundleSha256, deliverySha256: hash(bytes), byteLength: bytes.length,
      expectedCapacityRevision: before.capacityRevision, expectedExecutionRevision: before.executionRevision,
      expectedCleanupRevision: before.cleanupRevision, expectedBackupRevision: before.backupRevision,
      observation: { reservation: before.capacity, incomingBytes: 0, peakDiskBytes: 0, peakMemoryBytes: 0, peakFileCount: 0, peakProcessCount: 0, rawOutputBytes: 0 } };
    const prepareCapture = (input: typeof prepared) => input.retained.pool
      ? owner.preparePoolForAssignment({ ...input, retained: input.retained })
      : owner.prepareForAssignment({ ...input, retained: input.retained });
    const pages: RemoteWorkerNativeCapacityPage[] = [];
    for (let offset = 0; offset < bytes.length; offset += REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES) pages.push({ kind: "cell.native_capacity.page",
      nonce: f.window.nonce, bundleSha256: delivery.bundleSha256, deliverySha256: prepared.deliverySha256, byteLength: bytes.length,
      offset, bytesHex: bytes.subarray(offset, offset + REMOTE_WORKER_NATIVE_CAPACITY_PAGE_BYTES).toString("hex") });
    assert.ok(pages.length >= 2);
    const lookup = { kind: "cell.native_capacity.lookup" as const, nonce: f.window.nonce, bundleSha256: delivery.bundleSha256 };
    const reviewed = { ...authority, expectedCapacityRevision: before.capacityRevision + 1, expectedExecutionRevision: before.executionRevision,
      expectedCleanupRevision: before.cleanupRevision, expectedBackupRevision: before.backupRevision };
    assert.throws(() => readAdmission(reviewed));
    const count = (table: "remote_worker_native_capacity_captures" | "remote_worker_native_capacity_pages" | "remote_worker_native_capacity_deliveries") =>
      Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number | string }>()!.count);
    const exchange = (submission = pages[0]!, live = authority) => owner.exchangeWithAssignment({ ...live, submission });
    assert.throws(() => exchange(), /independently registered/u);
    assert.throws(() => owner.exchangeWithAssignment({ ...authority, submission: lookup }), /independently registered/u);
    assert.throws(() => prepareCapture({ ...prepared, expectedCapacityRevision: before.capacityRevision + 1 }), /revisions/u);
    assert.equal(count("remote_worker_native_capacity_captures"), 0);
    // Controlled membership-reader fault injection around real canonical
    // authority/page rows. This is not physical multi-cell collection proof.
    const assertLegacyPoolRefusal = (operation: () => unknown) => {
      if (fullPool) return;
      const prototype = RemoteWorkerCellRepository.prototype;
      const read = prototype.listRetainedNativeCellsForWorker;
      for (const shape of ["missing", "extra", "foreign"] as const) {
        prototype.listRetainedNativeCellsForWorker = function (scope) {
          const members = read.call(this, scope);
          assert.equal(members.length, 1);
          const foreign = { ...members[0]!, assignmentId: "retained-other-assignment", cellId: "retained-other-cell" };
          return shape === "missing" ? [] : shape === "extra" ? [...members, foreign] : [foreign];
        };
        try { assert.throws(operation, /complete pool/u); }
        finally { prototype.listRetainedNativeCellsForWorker = read; }
      }
    };
    assertLegacyPoolRefusal(() => prepareCapture(prepared));
    assert.equal(count("remote_worker_native_capacity_captures"), 0);
    const expectation = prepareCapture(prepared);
    assert.deepEqual(prepareCapture(prepared), expectation);
    assert.throws(() => prepareCapture({ ...prepared, deliverySha256: "ee".repeat(32) }), /immutable/u);
    const raw = db.prepare("SELECT specification_json FROM remote_worker_native_capacity_captures").get<{ specification_json: string }>()!.specification_json;
    assert.equal(raw.includes(authority.leaseTokenSha256), false); assert.equal(raw.includes("credentialAuthority"), false);
    if (fullPool) {
      assert.ok(Buffer.byteLength(raw) < 8192, "Pool expectation stores a compact independent fingerprint, not repeated member history");
      assert.equal(raw.includes("mountedWorkspaceRecords"), false);
    }
    assert.throws(() => exchange(pages[1]!), /in order/u);
    assert.equal(count("remote_worker_native_capacity_pages"), 0);
    assert.equal(owner.exchangeWithAssignment({ ...authority, submission: lookup }).record, null);
    const partial = exchange();
    assert.equal(partial.record, null); assert.equal(partial.accepted?.nextOffset, 32768);
    assert.deepEqual(new RemoteWorkerNativeCapacityPagesRepository(db).exchangeWithAssignment({ ...authority, submission: pages[0]! }), partial);
    assert.throws(() => exchange({ ...pages[0]!, bytesHex: "00".repeat(32768) }), /retained page/u);
    assert.equal(count("remote_worker_native_capacity_pages"), 1); assert.equal(count("remote_worker_native_capacity_deliveries"), 0);
    assert.deepEqual(cells.getCell(key), before);
    assert.throws(() => readAdmission({ ...reviewed, expectedCapacityRevision: before.capacityRevision }));

    const prepare = db.prepare.bind(db); let interrupted = false;
    db.prepare = sql => {
      const statement = prepare(sql);
      if (/^INSERT INTO remote_worker_native_capacity_pages/u.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = params => { const result = run(params); interrupted = true; revoke(); return result; };
      }
      return statement;
    };
    try { assert.throws(() => exchange(pages[1]!)); } finally { db.prepare = prepare; }
    assert.equal(interrupted, true); assert.equal(count("remote_worker_native_capacity_pages"), 1);
    assert.equal(count("remote_worker_native_capacity_deliveries"), 0); assert.deepEqual(cells.getCell(key), before);

    const renewedToken = hash(`${key.assignmentId}:page-renewed`);
    new RemoteWorkerAssignmentRepository(db).renewLease({ registryWorkspaceId: key.registryWorkspaceId, assignmentId: key.assignmentId,
      expectedAssignmentGeneration: key.assignmentGeneration, expectedLeaseRevision: authority.leaseRevision,
      expectedLeaseTokenSha256: authority.leaseTokenSha256, leaseTokenSha256: renewedToken, workerSentThrough: 0, idempotencyKey: "native-page-renewed" }, fence);
    const renewed = { ...authority, leaseRevision: authority.leaseRevision + 1, leaseTokenSha256: renewedToken };
    assert.throws(() => exchange());
    assert.equal(exchange(pages[0]!, renewed).accepted?.nextOffset, 32768);
    if (db.dialect === "sqlite") {
      const file = db.prepare("PRAGMA database_list").all<{ name: string; file: string }>().find(row => row.name === "main")?.file;
      assert.ok(file, "SQLite staging proof must use its own file-backed database");
      const reopened = createDatabase({ dbPath: file });
      try {
        const recovered = new RemoteWorkerNativeCapacityPagesRepository(reopened).exchangeWithAssignment({ ...renewed, submission: pages[0]! });
        assert.equal(recovered.accepted?.nextOffset, 32768); assert.equal(recovered.record, null);
      } finally { reopened.close(); }
    }
    for (let index = 1; index < pages.length - 1; index++) assert.equal(exchange(pages[index]!, renewed).record, null);
    const last = pages.at(-1)!;
    assert.throws(() => exchange({ ...last, bytesHex: last.bytesHex.slice(0, -2) + (last.bytesHex.endsWith("00") ? "01" : "00") }, renewed), /assembled source/u);
    assert.equal(count("remote_worker_native_capacity_pages"), pages.length - 1);
    assert.equal(count("remote_worker_native_capacity_deliveries"), 0);
    const complete = exchange(last, renewed);
    assert.equal(complete.record?.bundleSha256, delivery.bundleSha256); assert.equal(complete.record?.deliverySha256, hash(bytes));
    assert.equal(complete.record?.revision, before.capacityRevision + 1); assert.equal(complete.record?.decision, "accept");
    assert.equal(complete.accepted?.nextOffset, bytes.length); assert.equal(count("remote_worker_native_capacity_pages"), pages.length);
    assert.equal(count("remote_worker_native_capacity_deliveries"), 1);
    const admissionInput = { ...reviewed, ...renewed };
    const material = readAdmission(admissionInput);
    assert.deepEqual(material.inventory, delivery.inventory);
    assert.deepEqual(material.inventoryBinding, delivery.inventoryBinding);
    assert.deepEqual(material.observation, prepared.observation);
    assert.equal(material.expectedCapacityRevision, complete.record!.revision);
    assertLegacyPoolRefusal(() => readAdmission(admissionInput));
    assertLegacyPoolRefusal(() => owner.exchangeWithAssignment({ ...renewed, submission: lookup }));
    assertLegacyPoolRefusal(() => exchange(pages[0]!, renewed));
    const admissionState = cells.getCell(key);
    assert.deepEqual((phase === "ready" ? new RemoteWorkerNativeCapacityPagesRepository(db).readAdmissionForAssignment(admissionInput) : new RemoteWorkerNativeCapacityPagesRepository(db).readInstallationCapacityForAssignment(admissionInput)), material);
    for (const field of ["expectedCapacityRevision", "expectedExecutionRevision", "expectedCleanupRevision", "expectedBackupRevision"] as const)
      assert.throws(() => readAdmission({ ...admissionInput, [field]: admissionInput[field] + 1 }));
    assert.throws(() => readAdmission({ ...admissionInput, assignmentId: "foreign" }));
    assert.throws(() => readAdmission({ ...admissionInput, assignmentGeneration: 2 }));
    assert.throws(() => readAdmission(reviewed));
    assert.deepEqual(cells.getCell(key), admissionState, "reading admission material must not admit or advance the cell");
    assert.equal(admissionState!.executionState, phase);
    const otherReader = phase === "ready" ? owner.readInstallationCapacityForAssignment.bind(owner) : owner.readAdmissionForAssignment.bind(owner);
    assert.throws(() => otherReader(admissionInput), "Workload and installation phases cannot substitute for each other");
    const verifyInstallationRevoked = phase === "provisioning" ? verifyInstallationMaterial(db, renewed, history, material, fullPool, prepared.retained.layout) : undefined;
    const replay = new RemoteWorkerNativeCapacityPagesRepository(db).exchangeWithAssignment({ ...renewed, submission: lookup });
    assert.deepEqual(replay.record, complete.record); assert.equal(replay.accepted, null);
    assert.deepEqual(exchange(pages[0]!, renewed).record, complete.record);
    assert.deepEqual(prepareCapture({ ...prepared, ...renewed }), expectation);
    for (const table of ["remote_worker_native_capacity_captures", "remote_worker_native_capacity_pages"]) {
      assert.throws(() => db.prepare(`UPDATE ${table} SET recorded_at=recorded_at`).run(), /immutable/u);
      assert.throws(() => db.prepare(`DELETE FROM ${table}`).run(), /retained/u);
    }
    return () => {
      assert.throws(() => readAdmission(admissionInput));
      verifyInstallationRevoked?.();
      assert.throws(() => owner.exchangeWithAssignment({ ...renewed, submission: lookup }));
      assert.throws(() => exchange(last, renewed));
      assert.equal(count("remote_worker_native_capacity_pages"), pages.length); assert.equal(count("remote_worker_native_capacity_deliveries"), 1);
    };
  }, 240_000);
};
}
export const verifyNativeCapacityPages = verifyNativeCapacityPagesForPhase("ready");
export const verifyInstallationCapacityPages = verifyNativeCapacityPagesForPhase("provisioning");
export const verifyNativePoolCapacityPages = verifyNativeCapacityPagesForPhase("ready", true);
export const verifyPoolInstallationCapacityPages = verifyNativeCapacityPagesForPhase("provisioning", true);

function verifyInstallationMaterial(db: DatabaseClient, authority: RemoteWorkerCellCapacityAuthority, history: RemoteWorkerCellProvisioningExchange,
  capacity: ReturnType<RemoteWorkerNativeCapacityPagesRepository["readInstallationCapacityForAssignment"]>, fullPool: boolean,
  layout: ReturnType<RemoteWorkerNativeCapacityPagesRepository["readInstallationPoolBaselineForAssignment"]>["layout"]) {
  const repo = new RemoteWorkerRuntimeInstallRepository(db), approvals = new ApprovalRepository(db), cells = new RemoteWorkerCellRepository(db);
  let verifyCaptureRevoked: (() => void) | undefined;
  const first = readRemoteWorkerCellProvisioningCheckpoint(history.records[0]!);
  const expectedRequest = { schemaVersion: REMOTE_WORKER_RUNTIME_INSTALL_SCHEMA_VERSION, nonce: "18".repeat(32), journalIdentityHex: first.journalIdentityHex,
    preparedSha256: first.recordSha256, checkpointSha256: history.mountedWorkspaceRecords![1]!.slice(-64), packageSha256: "55".repeat(32),
    runtimeBundle: { schemaVersion: REMOTE_WORKER_RUNTIME_BUNDLE_SCHEMA_VERSION, files: [
      { relativePath: "node.exe", bytes: 100, sha256: "66".repeat(32) }, { relativePath: "worker-host-receipt.json", bytes: 20, sha256: "77".repeat(32) },
    ] } };
  const key = { registryWorkspaceId: authority.registryWorkspaceId, assignmentId: authority.assignmentId, assignmentGeneration: authority.assignmentGeneration };
  const before = cells.getCell(key)!, manifest = new RemoteWorkerAssignmentRepository(db).resolveActiveAuthorityByLeaseTokenHash(authority.leaseTokenSha256, authority.protectedAuthority)!.assignment.manifest;
  const revisions = { expectedExecutionRevision: before.executionRevision, expectedCleanupRevision: before.cleanupRevision,
    expectedCapacityRevision: before.capacityRevision, expectedBackupRevision: before.backupRevision };
  const preparationInput = { ...authority, packageSha256: expectedRequest.packageSha256, runtimeBundle: expectedRequest.runtimeBundle };
  const count = (table: string) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number | string }>()!.count);
  const priorCounts = [count("approvals"), count("remote_worker_runtime_install_requests"), count("remote_worker_runtime_install_outcomes")];
  const oversizedBundle = { ...preparationInput.runtimeBundle, files: preparationInput.runtimeBundle.files.map((file, index) =>
    ({ ...file, bytes: index === 0 ? history.plan.virtualDiskBytes : file.bytes })) };
  assert.throws(() => repo.prepareRequestForAssignment({ ...preparationInput, runtimeBundle: oversizedBundle }), /captured guest capacity/u);
  assert.deepEqual([count("approvals"), count("remote_worker_runtime_install_requests"), count("remote_worker_runtime_install_outcomes")], priorCounts);
  const prepared = repo.prepareRequestForAssignment(preparationInput), request = prepared.request;
  assert.equal(prepared.decision, "review_required");
  assert.deepEqual({ ...request, nonce: expectedRequest.nonce }, expectedRequest);
  assert.match(request.nonce, /^[a-f0-9]{64}$/u); assert.notEqual(request.nonce, expectedRequest.nonce);
  assert.equal(prepared.requestSha256, remoteWorkerRuntimeInstallRequestSha256(request));
  assert.deepEqual(prepared.revisions, revisions);
  assert.deepEqual(prepared.approvalDraft.payload.nativeRuntimeInstall, { schemaVersion: "goatcitadel.native-runtime-install-approval.v1",
    ...key, profileSha256: before.profileSha256, request, ...revisions });
  assert.deepEqual(prepared.approvalDraft.linkage, { workspaceId: manifest.executionWorkspaceId, taskId: manifest.taskId,
    durableRunId: manifest.durableRunId, sessionId: manifest.sessionId, turnId: manifest.turnId, actionType: "remote_worker.native_runtime_install" });
  assert.equal(prepared.approvalDraft.preview?.totalBytes, 120);
  assert.deepEqual([count("approvals"), count("remote_worker_runtime_install_requests"), count("remote_worker_runtime_install_outcomes")], priorCounts,
    "Preparation does not create an approval, request or outcome");
  for (const patch of [{ protectedAuthority: undefined }, { leaseRevision: 999 }, { packageSha256: "00".repeat(32) }])
    assert.throws(() => repo.prepareRequestForAssignment({ ...preparationInput, ...patch } as typeof preparationInput));
  const selection = { ...authority, nonce: request.nonce, requestSha256: remoteWorkerRuntimeInstallRequestSha256(request) };
  assert.throws(() => repo.readAdmissionMaterialForAssignment(selection), "Capacity alone is not an installation review");
  assert.throws(() => repo.readPoolAdmissionMaterialForAssignment(selection), "Pool baseline alone is not an installation review");
  const publicPointHex = `04${"12".repeat(64)}`;
  const enrollment = { publicPointHex, keySha256: hashRemoteWorkerControllerPublicKey(publicPointHex) };
  const approval = approvals.createWithTtlDuration({ ...prepared.approvalDraft,
    payload: { ...prepared.approvalDraft.payload, controllerEnrollment: enrollment } }, 300000);
  const input = { ...authority, request, approvalId: approval.approvalId, ...revisions };
  repo.validatePendingReviewForAssignment(input);
  for (const patch of [{ request: { ...request, packageSha256: "99".repeat(32) } }, { leaseRevision: 999 }, { protectedAuthority: undefined }])
    assert.throws(() => repo.validatePendingReviewForAssignment({ ...input, ...patch } as typeof input));
  const pendingCount = count("approvals");
  for (const patch of [
    { kind: "remote_worker.native_runtime" },
    { linkage: { ...prepared.approvalDraft.linkage, taskId: "foreign" } },
    { payload: { nativeRuntimeInstall: { ...(prepared.approvalDraft.payload.nativeRuntimeInstall as object), expectedCapacityRevision: revisions.expectedCapacityRevision + 1 } } },
  ]) {
    assert.throws(() => db.transaction("immediate", () => {
      const wrong = approvals.createWithTtlDuration({ ...prepared.approvalDraft, ...patch }, 300000);
      repo.validatePendingReviewForAssignment({ ...input, approvalId: wrong.approvalId });
    }), "A failed creation hook must roll back the pending approval");
    assert.equal(count("approvals"), pendingCount);
  }
  assert.throws(() => db.transaction("immediate", () => {
    const expired = approvals.createWithTtlDuration(prepared.approvalDraft, 300000);
    db.prepare("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE approval_id = @approvalId").run({ approvalId: expired.approvalId });
    repo.validatePendingReviewForAssignment({ ...input, approvalId: expired.approvalId });
  }));
  assert.equal(count("approvals"), pendingCount);
  assert.throws(() => repo.retainRequestForAssignment(input));
  approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "fixture" });
  assert.throws(() => repo.validatePendingReviewForAssignment(input), "Creation hook cannot accept a resolved approval");
  repo.retainRequestForAssignment(input);
  assert.throws(() => repo.prepareRequestForAssignment(preparationInput), "A retained attempt cannot receive a fresh installation nonce");
  assert.deepEqual(repo.readAdmissionMaterialForAssignment(selection), { request, requestSha256: selection.requestSha256, capacity });
  if (fullPool) {
    const baseline = repo.readPoolAdmissionMaterialForAssignment(selection);
    assert.deepEqual(baseline, { request, requestSha256: selection.requestSha256, capacity, history: { ...history, leaseRevision: authority.leaseRevision },
      pool: new RemoteWorkerNativePoolRepository(db).readSnapshotForAssignment(authority), layout });
    assert.equal(baseline.pool.leaseRevision, authority.leaseRevision, "Baseline uses the current renewed lease, not the review capture lease");
    assert.equal("window" in baseline, false, "No old capture window is promoted to live authority");
    assert.equal("protectedAuthority" in baseline, false, "Transport baseline does not expose protected credentials");
    assert.ok(Object.isFrozen(baseline));
    const context = repo.readControllerCaptureContextForAssignment(selection);
    assert.deepEqual(context.baseline, baseline); assert.deepEqual(context.enrollment, enrollment);
    assert.ok(Array.isArray(JSON.parse(context.referencesJson)));
    assert.throws(() => repo.readControllerCaptureContextForAssignment({ ...selection, leaseRevision: 999 }));
    assert.throws(() => repo.readPoolAdmissionMaterialForAssignment({ ...selection, requestSha256: "ff".repeat(32) }));
    assert.throws(() => repo.readPoolAdmissionMaterialForAssignment({ ...selection, assignmentGeneration: selection.assignmentGeneration + 1 }));
    const captureFixture = (guestLogicalBytes = 9000) => {
      const f = nativeCapacityCompositionFixture({ history: baseline.history, nonce: "42".repeat(32), guestLogicalBytes });
      const { hostCaptureHex, guestObservationHex, guestChunkHex, backingObservationHex, references } = f.source;
      const members = [{ guestObservationHex, guestChunkHex, backingObservationHex }];
      const window = { nonce: f.window.nonce, connectionNonceHex: "71".repeat(32), poolSnapshotSha256: remoteWorkerCellCanonicalSha256(baseline.pool),
        hostCaptureSha256: f.window.hostCaptureSha256, membersSha256: remoteWorkerCellCanonicalSha256(members), referencesSha256: f.window.referencesSha256 };
      const header = Buffer.alloc(88), host = Buffer.from(hostCaptureHex, "hex"), member = Buffer.alloc(8);
      header.write("GCPRESP1"); header.writeUInt32LE(1, 8); header.writeUInt32LE(1, 12); header.writeUInt32LE(host.length, 16);
      Buffer.from(window.connectionNonceHex, "hex").copy(header, 24); Buffer.from(window.poolSnapshotSha256, "hex").copy(header, 56);
      member.writeUInt32LE(guestChunkHex.length, 4);
      const bytes = Buffer.concat([header, host.subarray(40, 424), host, member, Buffer.from(guestObservationHex, "hex"),
        Buffer.from(backingObservationHex, "hex"), ...guestChunkHex.map(hex => Buffer.from(hex, "hex"))]);
      return snapshotRuntimeInstallPoolCapture({ responseHex: bytes.toString("hex"), referencesJson: canonicalJsonString(references), window,
        binding: { connectionNonceHex: window.connectionNonceHex, installationNonce: request.nonce, requestSha256: selection.requestSha256,
          captureSha256: hashRemoteWorkerInstallCapacityCapture(bytes), byteLength: bytes.length } });
    };
    const capture = captureFixture(), currentCell = cells.getCell(key)!;
    const validated = repo.validatePoolCaptureForAssignment({ ...selection, capture });
    assert.deepEqual(validated.binding, capture.binding);
    assert.equal(validated.baselineSha256, remoteWorkerCellCanonicalSha256(baseline));
    assert.equal(validated.evaluation.decision, "accept");
    assert.notEqual(validated.inventoryBinding.captureSha256, capacity.inventoryBinding.captureSha256, "New window is validated independently of the retained review capture");
    const validate = (input = capture, cell = currentCell) => validateRuntimeInstallPoolCapture(baseline, cell, snapshotRuntimeInstallPoolCapture(input));
    for (const field of ["connectionNonceHex", "installationNonce", "requestSha256", "captureSha256"] as const)
      assert.throws(() => validate({ ...capture, binding: { ...capture.binding, [field]: "fa".repeat(32) } }));
    assert.throws(() => validate({ ...capture, binding: { ...capture.binding, byteLength: capture.binding.byteLength - 1 } }));
    assert.throws(() => validate({ ...capture, referencesJson: "[]" }));
    assert.throws(() => validate({ ...capture, window: { ...capture.window, poolSnapshotSha256: "fa".repeat(32) } }));
    assert.throws(() => validate(captureFixture(baseline.history.plan.virtualDiskBytes)), "Fresh logical usage plus the reviewed copy cannot exceed guest capacity");
    assert.throws(() => validate(capture, { ...currentCell, peakMemoryBytes: currentCell.capacity.memoryLimitBytes + 1 }),
      "Canonical high-water pressure still refuses an otherwise valid capture");
    assert.throws(() => repo.validatePoolCaptureForAssignment({ ...selection, requestSha256: "ff".repeat(32), capture }));
    verifyCaptureRevoked = () => assert.throws(() => repo.validatePoolCaptureForAssignment({ ...selection, capture }));
  } else {
    assert.throws(() => repo.readPoolAdmissionMaterialForAssignment(selection), /complete-pool/u,
      "Legacy single-cell acceptance cannot masquerade as a full-pool installation baseline");
  }
  assert.throws(() => repo.readAdmissionMaterialForAssignment({ ...selection, requestSha256: "ff".repeat(32) }));
  assert.deepEqual(cells.getCell(key), before, "Joining review and capacity does not fabricate readiness or reserve capacity");
  return () => { assert.throws(() => repo.readAdmissionMaterialForAssignment(selection)); assert.throws(() => repo.readPoolAdmissionMaterialForAssignment(selection));
    verifyCaptureRevoked?.();
    assert.throws(() => repo.prepareRequestForAssignment(preparationInput)); };
}
