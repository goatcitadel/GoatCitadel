import assert from "node:assert/strict";
import { test } from "node:test";
import { REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES } from "@goatcitadel/contracts";
import { snapshotRuntimeInstallPoolCapture } from "./remote-worker-runtime-install-capture.js";

test("installation capture snapshots preserve the existing delivery byte bound", () => {
  const digest = "11".repeat(32);
  const input = { responseHex: "00".repeat(1312), referencesJson: " ".repeat(1024 * 1024) + "[]",
    window: { nonce: digest, connectionNonceHex: digest, poolSnapshotSha256: digest,
      hostCaptureSha256: digest, membersSha256: digest, referencesSha256: digest },
    binding: { connectionNonceHex: digest, installationNonce: digest, requestSha256: digest, captureSha256: digest, byteLength: 1312 } };
  const frozen = snapshotRuntimeInstallPoolCapture(input);
  assert.equal(frozen.referencesJson, input.referencesJson);
  input.binding.installationNonce = "22".repeat(32);
  assert.equal(frozen.binding.installationNonce, digest);
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.binding));
  assert.ok(Object.isFrozen(frozen.window));
  assert.throws(() => snapshotRuntimeInstallPoolCapture({ ...input, referencesJson: "x".repeat(REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES + 1) }));
  assert.throws(() => snapshotRuntimeInstallPoolCapture({ ...input, referencesJson: "é".repeat(REMOTE_WORKER_NATIVE_CAPACITY_DELIVERY_MAXIMUM_BYTES / 2 + 1) }));
});
