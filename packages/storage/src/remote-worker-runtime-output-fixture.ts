import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRemoteWorkerNativeFileExportSelection, normalizeRemoteWorkerRuntimeResultExpectation, REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA,
  type RemoteWorkerRuntimeOutputEvidence } from "@goatcitadel/contracts";
import { objectInventoryFixture } from "../../contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { verifyRuntimeAdmission, verifyRuntimeAdmissionWithDisclosure } from "./remote-worker-runtime-admission-fixture.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";
import { RemoteWorkerRuntimeReadRepository } from "./remote-worker-runtime-read-repo.js";
import { verifyNativeFileReceipt } from "./remote-worker-native-file-receipt-fixture.js";

/** Controlled native bytes with real protected assignment/approval database fences. */
export const verifyRuntimeOutputRetention: typeof verifyRuntimeAdmission = (...args) => verifyOutput(false, ...args);
export const verifyNativeFileDisclosure: typeof verifyRuntimeAdmission = (...args) => verifyOutput(true, ...args);
const verifyOutput = (disclosed: boolean, ...[db, key, token, fence, revoke]: Parameters<typeof verifyRuntimeAdmission>) => {
  const fileStaging = { paths: ["artifacts/empty.txt"], maximumFileBytes: 1024, maximumTotalBytes: 2048 };
  verifyRuntimeAdmissionWithDisclosure(disclosed ? fileStaging : undefined, db, key, token, fence, revoke, (authority, history) => {
    const repo = new RemoteWorkerRuntimeResultRepository(db);
    const raw = db.prepare("SELECT expectation_json FROM remote_worker_runtime_expectations WHERE assignment_id = @assignmentId")
      .get<{ expectation_json: string }>({ assignmentId: key.assignmentId })!;
    const expected = normalizeRemoteWorkerRuntimeResultExpectation(JSON.parse(raw.expectation_json));
    const lookup = { ...authority, nonce: expected.nonce };
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const { summary, chunks } = objectInventoryFixture(history, 2);
    for (const buffer of [summary, ...chunks]) Buffer.from(expected.nonce, "hex").copy(buffer, 0);
    const header = Buffer.alloc(256); header.write("GCRRS001");
    for (const [offset, value] of [[8, expected.nonce], [40, expected.requestSha256], [72, expected.checkpointSha256], [184, expected.runtimeBundleSha256]] as const)
      Buffer.from(value, "hex").copy(header, offset);
    header.writeUInt32LE(0x1fef, 104); header.writeUInt32LE(23, 116); header.writeUInt32LE(777, 120);
    header.writeBigUInt64LE(5n, 168); header.writeUInt32LE(6, 216);
    const resultHex = Buffer.concat([header, summary, ...chunks]).toString("hex");
    const evidence: RemoteWorkerRuntimeOutputEvidence = { schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA,
      nonce: expected.nonce, requestSha256: expected.requestSha256,
      resultSha256: createHash("sha256").update("goatcitadel.worker-runtime-result.v1\0").update(Buffer.from(resultHex, "hex")).digest("hex"),
      streams: { stdout: { bytes: 5, sha256: digest("hello"), text: "hello", truncated: false, provenance: "native_stream_local_diagnostic" },
        stderr: { bytes: 0, sha256: digest(""), text: "", truncated: false, provenance: "native_stream_local_diagnostic" } } };
    const submit = { ...authority, evidence };
    const count = () => db.prepare("SELECT COUNT(*) AS count FROM remote_worker_runtime_output_evidence WHERE assignment_id = @assignmentId")
      .get<{ count: number }>({ assignmentId: key.assignmentId })!.count;
    assert.equal(repo.findOutputForAssignment(lookup), null);
    assert.throws(() => repo.retainOutputForAssignment(submit), "output cannot precede its binary result");
    const native = repo.retainForAssignment({ ...lookup, resultHex });
    assert.equal(native.result.resultSha256, evidence.resultSha256);
    const selectedFile = native.result.inventory!.entries.find(entry => !entry.directory && entry.logicalFileBytes === 0)!;
    assert.ok(selectedFile);
    const selection = createRemoteWorkerNativeFileExportSelection({ fileIdentityHex: selectedFile.identityHex,
      logicalPath: "artifacts/empty.txt" }, expected, resultHex, history, 1024);
    const select = { ...authority, selection };
    assert.deepEqual(repo.authorizeFileSelectionForAssignment(select, 1024), selection);
    const fileRecord = Buffer.alloc(200); fileRecord.write("GCRFA001");
    for (const [offset, value] of [[8, selection.nonce], [40, selection.requestSha256], [72, selection.resultSha256],
      [104, selection.workDirectoryIdentityHex], [128, selection.fileIdentityHex]] as const) Buffer.from(value, "hex").copy(fileRecord, offset);
    fileRecord.writeBigUInt64LE(BigInt(selection.allocatedBytes), 160);
    createHash("sha256").update(Buffer.alloc(0)).digest().copy(fileRecord, 168);
    const delivery = { ...select, recordHex: fileRecord.toString("hex") };
    const disclosureInput = { ...delivery, fileStaging };
    const afterReceiptRevoke = verifyNativeFileReceipt(db, authority, fileStaging, selection, delivery.recordHex, disclosed, revoke);
    if (disclosed) {
      const grant = repo.authorizeFileDisclosureForAssignment(disclosureInput);
      assert.equal(grant.disclosure.destination, "gateway_artifacts"); assert.deepEqual(grant.selection, selection);
      assert.equal(JSON.stringify(grant.disclosure).includes("artifacts/empty.txt"), false);
      assert.equal(repo.verifyDisclosedFileContentForAssignment(disclosureInput).content.byteLength, 0);
      for (const plan of [{ ...fileStaging, paths: ["private.txt"] }, { ...fileStaging, maximumFileBytes: 2048 },
        { ...fileStaging, maximumTotalBytes: 4096 }]) {
        assert.throws(() => repo.authorizeFileDisclosureForAssignment({ ...disclosureInput, fileStaging: plan }));
        assert.throws(() => repo.verifyDisclosedFileContentForAssignment({ ...disclosureInput, fileStaging: plan }));
      }
      assert.throws(() => repo.verifyDisclosedFileContentForAssignment({ ...disclosureInput, recordHex: disclosureInput.recordHex + "00" }));
    } else {
      assert.throws(() => repo.authorizeFileDisclosureForAssignment(disclosureInput), "collection/launch authority cannot grant disclosure");
      assert.throws(() => repo.verifyDisclosedFileContentForAssignment(disclosureInput));
    }
    const verifiedFile = repo.verifyFileContentForAssignment(delivery, 1024);
    assert.equal(verifiedFile.contentHex, ""); assert.equal(verifiedFile.byteLength, 0);
    assert.equal(verifiedFile.contentSha256, digest(""));
    assert.equal(verifiedFile.recordSha256, createHash("sha256").update(fileRecord).digest("hex"));
    for (const offset of [0, 8, 40, 72, 104, 128, 152, 160, 168]) {
      const changed = Buffer.from(fileRecord); changed[offset] = changed[offset]! ^ 1;
      assert.throws(() => repo.verifyFileContentForAssignment({ ...delivery, recordHex: changed.toString("hex") }, 1024));
    }
    assert.throws(() => repo.verifyFileContentForAssignment({ ...delivery, recordHex: delivery.recordHex + "00" }, 1024));
    for (const patch of [{ resultSha256: digest("foreign") }, { requestSha256: digest("foreign") },
      { assignmentGeneration: key.assignmentGeneration + 1 }, { logicalFileBytes: 1 }, { maximumBytes: 2048 },
      { workDirectoryIdentityHex: native.result.inventory!.directoryIdentityHex[0]! }]) {
      assert.throws(() => repo.authorizeFileSelectionForAssignment({ ...select, selection: { ...selection, ...patch } }, 1024));
    }
    assert.throws(() => repo.authorizeFileSelectionForAssignment(select, 512), "caller ceiling must match the exact selection");
    for (const patch of [{ resultSha256: digest("foreign") }, { nonce: digest("foreign") },
      { streams: { ...evidence.streams, stdout: { ...evidence.streams.stdout, bytes: 4 } } },
      { streams: { ...evidence.streams, stdout: { ...evidence.streams.stdout, text: "API_KEY=very-secret-output-value" } } }]) {
      assert.throws(() => repo.retainOutputForAssignment({ ...submit, evidence: { ...evidence, ...patch } }));
      assert.equal(count(), 0);
    }
    // A mid-write authority change must roll back the output and the mutation.
    const prepare = db.prepare.bind(db); let interrupted = false;
    db.prepare = sql => {
      const statement = prepare(sql);
      if (/^INSERT INTO remote_worker_runtime_output_evidence/u.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = params => { const result = run(params); interrupted = true; revoke(); return result; };
      }
      return statement;
    };
    try { assert.throws(() => repo.retainOutputForAssignment(submit)); } finally { db.prepare = prepare; }
    assert.equal(interrupted, true); assert.equal(count(), 0);
    const retained = repo.retainOutputForAssignment(submit);
    assert.equal(count(), 1); assert.deepEqual(retained.evidence, evidence);
    assert.deepEqual(new RemoteWorkerRuntimeResultRepository(db).findOutputForAssignment(lookup), retained);
    assert.deepEqual(repo.retainOutputForAssignment(submit), retained);
    const artifactKey = { ...key, nonce: expected.nonce };
    const artifact = repo.readOutputArtifactForOperator(artifactKey)!;
    assert.deepEqual(artifact.output, evidence);
    assert.equal(artifact.evidenceSha256, retained.evidenceSha256);
    assert.deepEqual(repo.listOutputArtifactNoncesForOperator(key), { nonces: [expected.nonce], truncated: false });
    assert.deepEqual(new RemoteWorkerRuntimeReadRepository(db).findAssignmentRuntime({ registryWorkspaceId: key.registryWorkspaceId, assignmentId: key.assignmentId })!
      .artifactAndEffects.value!.nativeOutputArtifacts, { nonces: [expected.nonce], truncated: false });
    for (const patch of [{ registryWorkspaceId: "foreign" }, { assignmentId: "foreign" }, { assignmentGeneration: 999 }, { nonce: digest("foreign") }]) {
      assert.equal(repo.readOutputArtifactForOperator({ ...artifactKey, ...patch }), null);
    }
    assert.throws(() => repo.retainOutputForAssignment({ ...submit,
      evidence: { ...evidence, streams: { ...evidence.streams, stdout: { ...evidence.streams.stdout, text: "other" } } } }));
    for (const patch of [{ protectedAuthority: undefined }, { leaseRevision: 999 }, { leaseTokenSha256: digest("foreign") }, { assignmentGeneration: 999 }]) {
      assert.throws(() => repo.retainOutputForAssignment({ ...submit, ...patch } as typeof submit));
      assert.throws(() => repo.findOutputForAssignment({ ...lookup, ...patch } as typeof lookup));
      assert.throws(() => repo.authorizeFileSelectionForAssignment({ ...select, ...patch } as typeof select, 1024));
      assert.throws(() => repo.verifyFileContentForAssignment({ ...delivery, ...patch } as typeof delivery, 1024));
    }
    assert.throws(() => db.prepare("UPDATE remote_worker_runtime_output_evidence SET evidence_json = evidence_json WHERE assignment_id = @assignmentId")
      .run({ assignmentId: key.assignmentId }), /immutable/u);
    assert.throws(() => db.prepare("DELETE FROM remote_worker_runtime_output_evidence WHERE assignment_id = @assignmentId")
      .run({ assignmentId: key.assignmentId }), /retained/u);
    assert.equal(JSON.stringify(retained).includes(token), false);
    return () => {
      afterReceiptRevoke();
      assert.throws(() => repo.authorizeFileDisclosureForAssignment(disclosureInput));
      assert.throws(() => repo.verifyDisclosedFileContentForAssignment(disclosureInput));
      assert.throws(() => repo.verifyFileContentForAssignment(delivery, 1024));
      assert.throws(() => repo.authorizeFileSelectionForAssignment(select, 1024));
      assert.throws(() => repo.retainOutputForAssignment(submit));
      assert.throws(() => repo.findOutputForAssignment(lookup));
      assert.equal(count(), 1);
      assert.deepEqual(repo.readOutputArtifactForOperator(artifactKey), artifact,
        "operator historical evidence remains readable after worker authority is revoked");
    };
  });
};
