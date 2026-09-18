import assert from "node:assert/strict";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { prepareWindowsRuntimeDispatch } from "../../../packages/contracts/dist/remote-worker-runtime-node.js";
import { encodeWindowsRuntimeHelperBootstrap } from "../../../apps/remote-worker/dist/worker-windows-runtime-helper.js";
import { remoteWorkerRuntimeBundleManifestSha256 } from "../../../packages/contracts/dist/index.js";

function requestFixture() {
  const jobName = `gc-cell-${"1".repeat(32)}`, root = `C:\\cells\\${jobName}`;
  const identity = digit => "1".repeat(16) + digit.repeat(32);
  const runtimeBundle = { schemaVersion: "goatcitadel.worker-runtime-bundle.v1", files: [{ relativePath: "entry.exe", bytes: 3, sha256: "a".repeat(64) }] };
  const runtimeBundleSha256 = remoteWorkerRuntimeBundleManifestSha256(runtimeBundle);
  const result = prepareWindowsRuntimeDispatch({ nonce: "9".repeat(64),
    anchor: { fileIdentity: identity("6"), preparedSha256: "7".repeat(64) }, checkpointSha256: "8".repeat(64),
    inventoryLimits: { maxEntries: 20000, maxDepth: 64, wallMs: 10000 },
    launch: { jobName, appContainerName: `GoatCitadel.Worker.${"1".repeat(32)}`, image: `${root}\\runtime\\entry.exe`,
      commandLine: `"${root}\\runtime\\entry.exe" serve`, directory: `${root}\\work`, runtimeRoot: `${root}\\runtime`,
      imageSha256: "a".repeat(64), directoryIdentity: identity("5"), runtimeRootIdentity: identity("4"), runtimeBundle,
      runtimeBundleSha256, environment: { SystemRoot: "C:\\Windows" },
      limits: { processLimit: 1, memoryBytes: 64 * 1024 * 1024, cpuMilli: 1000, wallMs: 150000, rawOutputBytes: 65536, diagnosticBytes: 1024, inputBytes: 4096 },
      protectedWorkspace: { parentPath: "C:\\cells", parentIdentity: identity("1"), rootIdentity: identity("2"), controlIdentity: identity("3"),
        runtimeIdentity: identity("4"), workIdentity: identity("5"), ownerSid: "S-1-5-21-1-2-3-1001", controllerSid: "S-1-5-80-1-2-3-4-5" } } });
  return { ...result, expected: result.expectation };
}
export async function helperRuntimeHandshakeCase(image, env, mode) {
  const f = requestFixture(), locator = randomBytes(32), secret = randomBytes(32);
  const control = mode === "control-accepted" || mode === "control-wrong-role";
  const name = `\\\\.\\pipe\\LOCAL\\GoatCitadelRuntimeParent.v1.${locator.toString("hex")}${control ? ".control" : ""}`;
  const bootstrap = encodeWindowsRuntimeHelperBootstrap(f.bytes, f.expected, locator, secret);
  const expectedHello = Buffer.alloc(136); expectedHello.write(control ? "GCRPC001" : "GCRPA001"); bootstrap.copy(expectedHello, 8, 40, 168); secret.fill(0);
  if (mode === "changed-request") bootstrap[bootstrap.length - 1] ^= 1;
  if (mode === "reserved") bootstrap[172] = 1;
  if (mode === "zero-secret") bootstrap.fill(0, 40, 72);
  if (mode === "public-secret") bootstrap.copy(bootstrap, 40, 8, 40);
  if (mode === "oversized") bootstrap.writeUInt32LE(144 + 12 + 512 * 1024 + 1, 168);
  const server = createServer(); let socket, child, failure, received = Buffer.alloc(0), stdout = "", stderr = "";
  const fail = error => { failure ??= error; socket?.destroy(); child?.kill(); };
  server.on("error", fail);
  server.on("connection", connected => {
    if (socket) { connected.destroy(); fail(new Error("Unexpected helper peer.")); return; }
    socket = connected; socket.on("error", fail);
    socket.on("data", bytes => {
      try {
        received = Buffer.concat([received, bytes]); assert.ok(received.length <= 136);
        if (received.length !== 136) return;
        assert.ok(received.equals(expectedHello), "Exact private helper hello matches.");
        const reply = Buffer.from(received); reply[7] = 0x32;
        if (mode === "wrong-ack") reply[104] ^= 1;
        if (mode === "wrong-magic") reply[7] = 0x31;
        if (mode === "control-wrong-role") reply[4] = 0x41;
        socket.write(reply, () => reply.fill(0));
      } catch (error) { fail(error); }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(name, resolve); });
  const timer = setTimeout(() => fail(new Error("Native helper handshake fixture timed out.")), 10000);
  try {
    child = spawn(image, [control ? "--runtime-control" : mode === "cancelled" || mode === "expired" ? `--runtime-parent-${mode}` : "--runtime-parent"],
      { windowsHide: true, shell: false, env, stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", fail); child.stdin.on("error", error => { if (error.code !== "EPIPE") fail(error); });
    child.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 4096) fail(new Error("Unbounded fixture output.")); });
    child.stderr.on("data", bytes => { stderr += bytes; if (stderr.length > 4096) fail(new Error("Unbounded fixture diagnostic.")); });
    child.stdin.write(bootstrap, () => bootstrap.fill(0));
    const code = await new Promise(resolve => child.once("close", resolve));
    if (failure) throw failure;
    assert.equal(code, 0, `${stdout}${stderr}`); assert.equal(stderr, "");
    const result = JSON.parse(stdout), parsed = control || ["accepted", "wrong-ack", "wrong-magic", "cancelled", "expired"].includes(mode);
    const accepted = mode === "accepted" || mode === "control-accepted";
    assert.equal(result.decoded, parsed); assert.equal(result.authenticationError === 0, accepted);
    assert.equal(result.runtimeRefused, true); assert.equal(result.installedService, false);
    assert.equal(result.secretErased, true);
    if (parsed) { assert.equal(result.peerChecks, accepted ? 2 : mode === "cancelled" || mode === "expired" ? 0 : 1); }
    else assert.equal(result.peerChecks, 0);
    return { mode, ...result };
  } finally {
    clearTimeout(timer); bootstrap.fill(0); expectedHello.fill(0); received.fill(0); socket?.destroy(); child?.stdin.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
