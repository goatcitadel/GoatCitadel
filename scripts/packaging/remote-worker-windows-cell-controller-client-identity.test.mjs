import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { CELL_CONTROLLER_SERVICE_INPUTS, snapshotCellControllerSources } from "./build-remote-worker-windows-cell-controller.mjs";
import { compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { decodeWindowsWorkerCellControllerCustody } from "../../apps/remote-worker/dist/worker-windows-cell-provisioning.js";

async function inheritedParentExchange(image, environment, name) {
  const server = createServer();
  let socket, child, stdout = "", stderr = "", received = Buffer.alloc(0), failure;
  const refuse = (error) => { failure ??= error; socket?.destroy(); child?.kill(); };
  server.on("error", refuse);
  server.on("connection", (connected) => {
    if (socket) { connected.destroy(); refuse(new Error("Unexpected second parent connection.")); return; }
    socket = connected;
    socket.on("error", refuse);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > 2) refuse(new Error("Unexpected parent response tail."));
    });
    socket.write(Buffer.from([0x11]));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(name, () => { server.off("error", reject); resolve(); });
  });
  const timer = setTimeout(() => refuse(new Error("Inherited parent exchange timed out.")), 10000);
  try {
    child = spawn(image, ["--parent-stdio", name], { windowsHide: true, shell: false, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", refuse); child.stdin.on("error", refuse);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 4096) refuse(new Error("Unbounded child stdout.")); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 4096) refuse(new Error("Unbounded child stderr.")); });
    const code = await new Promise((resolve) => child.once("close", resolve));
    if (failure) throw failure;
    assert.equal(code, 0, `${stdout}${stderr}`); assert.equal(stderr, "");
    assert.deepEqual(received, Buffer.from([0x12, 0x13]));
    const evidence = JSON.parse(stdout);
    assert.equal(evidence.passed, true); assert.equal(evidence.parentProcessId, process.pid);
    assert.equal(evidence.borrowedPipePreserved, true);
    return evidence;
  } finally {
    clearTimeout(timer); socket?.destroy(); child?.stdin.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("worker inspects a retained pipe server without acquiring controller privileges", { skip: process.platform !== "win32" }, async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Cell Controller Client Identity "));
  console.log(`Retained controller client identity evidence: ${output}`);
  const cell = "apps/remote-worker-windows-cell-native", host = "apps/remote-worker-windows-host-native";
  const signer = "apps/remote-worker-provisioner-windows-native";
  const clientSources = [`${cell}/src/cell_controller_client_identity.cpp`, `${cell}/src/cell_controller_client_identity.hpp`,
    `${cell}/tests/cell_controller_client_identity_test.cpp`];
  const signerSources = ["cpp", "hpp", "test.cpp"].map((extension) => `${signer}/src/signer_inspection.${extension}`);
  const snapshot = snapshotCellControllerSources(output, [...clientSources, ...signerSources]);
  const toolchain = resolveExactWindowsToolchain("windows-x64");
  const outcomes = [];
  for (const asan of [false, true]) {
    const suffix = asan ? "asan" : "normal";
    const build = (name, sources, defines = []) => compileTlsNative({
      target: "windows-x64", outputDirectory: output, outputName: `${name}-${suffix}.exe`, asan,
      sourceBatchSize: 8,
      sources: sources.map((source) => path.join(snapshot.root, source)),
      includes: [path.join(snapshot.root, cell, "src"), path.join(snapshot.root, host, "src")], defines,
    });
    const run = (image, name) => {
      const result = spawnSync(image, [], { encoding: "utf8", windowsHide: true, timeout: 30000,
        env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } });
      fs.writeFileSync(path.join(output, `${name}-${suffix}.log`), (result.stdout ?? "") + (result.stderr ?? ""), { flag: "wx" });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, `${output}\n${result.stdout}${result.stderr}`);
      return JSON.parse(result.stdout);
    };
    const clientImage = build("client-identity", [...CELL_CONTROLLER_SERVICE_INPUTS, ...clientSources]
      .filter((source) => source.endsWith(".cpp") && !source.endsWith("/cell_controller_main.cpp")));
    const client = run(clientImage, "client");
    assert.equal(client.passed, true);
    assert.ok(client.checks >= 115);
    assert.equal(client.serverProcesses, 2);
    assert.equal(client.privilegesUnchanged, true);
    assert.equal(client.installedService, false);
    const inheritedParent = await inheritedParentExchange(clientImage,
      { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" },
      `\\\\.\\pipe\\LOCAL\\GoatCellParent-${process.pid}-${path.basename(output)}-${suffix}`);
    fs.writeFileSync(path.join(output, `inherited-parent-${suffix}.json`), JSON.stringify(inheritedParent, null, 2), { flag: "wx" });
    const encoded = spawnSync(clientImage, ["--custody-fixture"], { windowsHide: true, timeout: 10000,
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath), ASAN_OPTIONS: "halt_on_error=1:detect_leaks=0" } });
    assert.equal(encoded.error, undefined); assert.equal(encoded.status, 0); assert.equal(encoded.stderr.length, 0);
    const custody = decodeWindowsWorkerCellControllerCustody(encoded.stdout);
    assert.equal(custody.parentPath, "C:\\ProgramData\\GoatCitadel\\RemoteWorker\\cells");
    assert.equal(custody.controllerSha256, "11".repeat(32)); assert.equal(custody.provisioningSha256, "22".repeat(32));
    assert.equal(custody.parentIdentityHex, "0807060504030201" + "44".repeat(16));
    assert.equal(custody.nativeDirectoryIdentityHex, "0807060504030201" + "33".repeat(16));
    fs.writeFileSync(path.join(output, `custody-codec-${suffix}.json`), JSON.stringify(custody, null, 2), { flag: "wx" });
    const inspection = run(build("signer-inspection", [`${host}/src/service_inspection.cpp`,
      ...signerSources.filter((source) => source.endsWith(".cpp"))],
    ["GOATCITADEL_PROVISIONER_TESTING", "GOATCITADEL_SIGNER_INSPECTION_STANDALONE"]), "inspection");
    assert.equal(inspection.failures, 0);
    assert.ok(inspection.signerInspectionChecks >= 50);
    assert.equal(inspection.installedService, false);
    outcomes.push({ asan, client, inspection, inheritedParent, custodyCodecMatched: true });
  }
  const repository = path.resolve(import.meta.dirname, "../..");
  for (const item of snapshot.sourceManifest) assert.equal(
    createHash("sha256").update(fs.readFileSync(path.join(repository, item.name))).digest("hex"), item.sha256,
    `Source changed during proof: ${item.name}`,
  );
  fs.writeFileSync(path.join(output, "acceptance.json"), JSON.stringify({ sourceManifest: snapshot.sourceManifest, outcomes,
    boundary: "Actual local pipe server processes and query-only ACL/OS refusal checks. No installed worker/controller admission, provisioning client dispatch, canonical Gateway acknowledgements or privileged volume operations." }, null, 2), { flag: "wx" });
});
