import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { encodeRemoteWorkerControllerAttestation, hashRemoteWorkerControllerPublicKey } from "../../packages/contracts/dist/remote-worker-controller-attestation.js";
import { remoteWorkerCellCanonicalSha256 } from "../../packages/contracts/dist/remote-worker-cell.js";

test("native non-exportable controller signatures match the Gateway wire and P-256 verifier", { skip: process.platform !== "win32", timeout: 120000 }, t => {
  const repo = path.resolve(import.meta.dirname, "../..");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Controller Attestation "));
  t.diagnostic(`Retained controller attestation proof: ${root}`);
  const inputs = ["apps/remote-worker-windows-cell-native/src/cell_controller_attestation.hpp",
    "apps/remote-worker-windows-cell-native/src/cell_controller_attestation.cpp",
    "apps/remote-worker-windows-cell-native/tests/cell_controller_attestation_test.cpp",
    "packages/contracts/src/remote-worker-controller-attestation.ts"];
  const manifest = inputs.map(name => {
    const bytes = fs.readFileSync(path.join(repo, name)), target = path.join(root, "source", path.basename(name));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: "wx" });
    return { name, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const outcomes = [];
  for (const asan of [false, true]) {
    const output = path.join(root, asan ? "asan" : "normal"); fs.mkdirSync(output);
    const executable = compileTlsNative({ target: "windows-x64", outputDirectory: output, asan,
      outputName: "controller-attestation-test.exe", includes: [path.join(root, "source")],
      sources: inputs.filter(name => name.endsWith(".cpp")).map(name => path.join(root, "source", path.basename(name))) });
    const run = spawnSync(executable, [], { windowsHide: true, encoding: "utf8", timeout: 10000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(resolveExactWindowsToolchain("windows-x64").compilerPath),
        ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } });
    fs.writeFileSync(path.join(output, "run.log"), `${run.stdout ?? ""}${run.stderr ?? ""}`, { flag: "wx" });
    assert.equal(run.error, undefined); assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.passed, true); assert.ok(receipt.checks >= 20);
    assert.equal(receipt.persistedKeys, false); assert.equal(receipt.volumeOperations, false);
    assert.equal(hashRemoteWorkerControllerPublicKey(receipt.publicPointHex), receipt.keySha256);
    const hex = n => n.toString(16).padStart(2, "0").repeat(32);
    const host = Buffer.alloc(888); host.write("GCCAP001"); host.fill(7, 8, 40);
    const members = [0, 1].map(member => ({
      guestObservationHex: Buffer.alloc(352, 20 + member).toString("hex"),
      backingObservationHex: Buffer.alloc(424, 30 + member).toString("hex"),
      guestChunkHex: Array.from({ length: member + 1 }, (_, chunk) => Buffer.alloc(1000, 40 + member + chunk).toString("hex")),
    }));
    assert.deepEqual(receipt.derivedWindow, [hex(7), hex(8), hex(9),
      createHash("sha256").update("goatcitadel.native-capacity-capture.v1\0").update(host).digest("hex"),
      remoteWorkerCellCanonicalSha256(members), hex(12)]);
    const expected = encodeRemoteWorkerControllerAttestation({ keySha256: receipt.keySha256,
      controllerInstanceHex: hex(2), authoritySha256: hex(3), challengeNonceHex: hex(4), installationNonce: hex(5), requestSha256: hex(6), ordinal: 1,
      window: { nonce: hex(7), connectionNonceHex: hex(8), poolSnapshotSha256: hex(9), hostCaptureSha256: hex(10), membersSha256: hex(11), referencesSha256: hex(12) } });
    const statement = Buffer.from(receipt.statementHex, "hex"), point = Buffer.from(receipt.publicPointHex, "hex");
    assert.deepEqual(statement, Buffer.from(expected));
    const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") } });
    const signature = Buffer.from(receipt.signatureHex, "hex");
    assert.equal(verify("sha256", statement, { key, dsaEncoding: "ieee-p1363" }, signature), true);
    for (let index = 0; index < statement.length; index++) {
      const changed = Buffer.from(statement); changed[index] ^= 1;
      assert.equal(verify("sha256", changed, { key, dsaEncoding: "ieee-p1363" }, signature), false);
    }
    outcomes.push({ asan, ...receipt });
  }
  for (const input of manifest) assert.equal(createHash("sha256").update(fs.readFileSync(path.join(repo, input.name))).digest("hex"), input.sha256);
  fs.writeFileSync(path.join(root, "acceptance.json"), JSON.stringify({ manifest, outcomes,
    boundary: "Ephemeral CNG signing/guard and cross-language verification only. No persisted enrollment, installed service, workload or volume operation." }, null, 2), { flag: "wx" });
});
