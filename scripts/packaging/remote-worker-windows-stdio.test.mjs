import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { buildWindowsTlsKeyAdapter, compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { remoteWorkerRuntimeBundleManifestSha256 } from "../../packages/contracts/dist/index.js";
import { verifyRemoteWorkerWindowsPackage } from "./lib/remote-worker-package-files.mjs";
import { runJournaledMcpFixture } from "./fixtures/worker-mcp-journal.mjs";

const requireNative = createRequire(import.meta.url);
const packageRoot = process.env.GOATCITADEL_STDIO_PACKAGE_ROOT;
const packageSha256 = process.env.GOATCITADEL_STDIO_PACKAGE_SHA256;
if (Boolean(packageRoot) !== Boolean(packageSha256))
  throw new Error("Both stdio package root and its independent manifest hash are required.");
const packageProof = packageRoot
  ? verifyRemoteWorkerWindowsPackage({ root: packageRoot, expectedManifestSha256: packageSha256 })
  : undefined;
if (
  packageRoot &&
  fs.realpathSync.native(process.execPath).toLowerCase() !==
    fs.realpathSync.native(path.join(packageRoot, "app/runtime/node.exe")).toLowerCase()
)
  throw new Error("Package stdio proof must use the candidate's own Node executable.");
const workerDist = packageRoot
  ? path.join(packageRoot, "app/worker/dist")
  : path.resolve(import.meta.dirname, "../../apps/remote-worker/dist");
const { startWindowsWorkerStdio } = await import(
  pathToFileURL(path.join(workerDist, "worker-windows-stdio-executor.js"))
);
const { encodeWindowsWorkerStdioLaunch, decodeWindowsWorkerStdioCompletion } = await import(
  pathToFileURL(path.join(workerDist, "worker-windows-stdio-codec.js"))
);
const { executeWorkerMcpStdioTool } = await import(
  pathToFileURL(path.join(workerDist, "worker-mcp-stdio-execution.js"))
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = path.resolve(import.meta.dirname, "../../apps/remote-worker-windows-cell-native");
async function until(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function line(session, pending, stream = "stdout") {
  while (!pending[stream].includes("\n")) {
    const chunk = await session.read();
    assert.ok(chunk, "The native child must produce the expected complete line.");
    pending[chunk.stream] += chunk.bytes.toString("utf8");
    assert.ok(pending.stdout.length + pending.stderr.length < 8192);
  }
  const end = pending[stream].indexOf("\n");
  const value = pending[stream].slice(0, end);
  pending[stream] = pending[stream].slice(end + 1);
  return value;
}
test(
  "pinned native stdio helper exchanges bytes through a verified AppContainer bundle",
  { skip: process.platform !== "win32", timeout: 180000 },
  async (t) => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "Goat Worker Stdio "));
    t.diagnostic(`Retained native stdio bridge evidence: ${output}`);
    const built = packageRoot
      ? {
          guardAddon: path.join(packageRoot, "app/worker/native/GoatCitadelRemoteWorkerImageGuard.node"),
          stdioExecutor: path.join(packageRoot, "app/worker/native/GoatCitadelRemoteWorkerStdio.exe"),
        }
      : buildWindowsTlsKeyAdapter({ target: "windows-x64", outputDirectory: path.join(output, "native") });
    const guard = requireNative(built.guardAddon);
    const options = {
      target: "windows-x64",
      outputDirectory: output,
      includes: [path.join(source, "src"), path.join(source, "tests")],
    };
    const fixture = compileTlsNative({
      ...options,
      outputName: "job-fixture.exe",
      sources: ["tests/job_fixture.cpp", "tests/workspace_fixture.cpp"].map((name) => path.join(source, name)),
    });
    const setup = compileTlsNative({
      ...options,
      outputName: "stdio-setup.exe",
      sources: ["tests/stdio_setup_fixture.cpp", "tests/appcontainer_fixture.cpp", "src/cell_filesystem.cpp",
        "src/cell_workspace.cpp", "src/cell_security.cpp", "src/cell_runtime_bundle_install.cpp"].map(
        (name) => path.join(source, name),
      ),
    });
    let sequence = 0;
    const receipts = [];
    async function runCase(mode, run, mcp = false, protectedWorkspace = false) {
      const root = path.join(output, `case-${++sequence}`), metadata = path.join(root, "setup.json");
      let runtime = path.join(root, "runtime");
      fs.mkdirSync(root);
      fs.mkdirSync(runtime);
      let image = path.join(runtime, "entry.exe");
      fs.copyFileSync(mcp ? process.execPath : fixture, image, fs.constants.COPYFILE_EXCL);
      const note = `Native MCP proof 🐐 ${randomUUID()}`;
      if (mcp) {
        fs.copyFileSync(
          path.join(import.meta.dirname, "fixtures/worker-mcp-stdio.mjs"),
          path.join(runtime, "mcp-fixture.mjs"),
          fs.constants.COPYFILE_EXCL,
        );
        fs.writeFileSync(path.join(runtime, "note.txt"), note, { flag: "wx" });
      }
      const keeper = spawn(
        setup,
        [image, metadata, ...(mcp ? [path.join(runtime, "mcp-fixture.mjs"), path.join(runtime, "note.txt")] : []),
          ...(protectedWorkspace ? ["--protected"] : [])],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: { SystemRoot: process.env.SystemRoot },
        },
      );
      const keeperExit = once(keeper, "exit");
      void keeperExit.catch(() => undefined);
      let setupError = "",
        ready = "",
        session;
      keeper.stdout.on("data", (bytes) => {
        ready += bytes.toString("utf8");
        assert.ok(ready.length <= 6);
      });
      keeper.stderr.on("data", (bytes) => {
        setupError += bytes.toString("utf8");
        assert.ok(setupError.length <= 8192);
      });
      keeper.stdin.on("error", () => undefined);
      try {
        await until(
          () => ready === "ready\n" || keeper.exitCode !== null || keeper.signalCode !== null,
          "Native fixture did not prepare its profile.",
        );
        assert.equal(ready, "ready\n", setupError);
        const frozen = JSON.parse(fs.readFileSync(metadata, "utf8"));
        assert.equal(frozen.imageSha256, hash(fs.readFileSync(image)));
        if (protectedWorkspace) {
          frozen.protectedWorkspace.parentPath = path.join(root, "cells");
          runtime = path.join(root, "cells", frozen.jobName, "runtime");
          image = path.join(runtime, "entry.exe");
          assert.equal(frozen.imageSha256, hash(fs.readFileSync(image)));
        }
        const directory = protectedWorkspace ? path.join(root, "cells", frozen.jobName, "work") : runtime;
        const runtimeBundle = {
          schemaVersion: "goatcitadel.worker-runtime-bundle.v1",
          files: (mcp ? ["entry.exe", "mcp-fixture.mjs", "note.txt"] : ["entry.exe"]).map((relativePath) => ({
            relativePath,
            bytes: fs.statSync(path.join(runtime, relativePath)).size,
            sha256: hash(fs.readFileSync(path.join(runtime, relativePath))),
          })),
        };
        const launch = {
          ...frozen,
          image,
          commandLine: `"${image}" ${mcp ? `--preserve-symlinks --preserve-symlinks-main "${path.join(runtime, "mcp-fixture.mjs")}" ` : ""}${mode}`,
          directory,
          runtimeRoot: runtime,
          runtimeRootIdentity: frozen.runtimeRootIdentity ?? frozen.directoryIdentity,
          runtimeBundle,
          runtimeBundleSha256: remoteWorkerRuntimeBundleManifestSha256(runtimeBundle),
          environment: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: directory, TEMP: directory, TMP: directory },
          limits: {
            processLimit: 3,
            memoryBytes: (mcp ? 512 : 64) * 1024 * 1024,
            cpuMilli: 1000,
            wallMs: mcp ? 12000 : 5000,
            rawOutputBytes: 2 * 1024 * 1024,
            diagnosticBytes: 1024,
            inputBytes: 1024 * 1024,
          },
        };
        const start = async (changes = {}, current = async () => undefined, signal = new AbortController().signal) => {
          session = await startWindowsWorkerStdio(
            { ...launch, ...changes },
            { signal, assertCurrent: current, imageGuard: guard },
          );
          return session;
        };
        await run({ launch, start, root, runtime, note });
      } finally {
        await session?.stop();
        keeper.stdin.end();
        await until(
          () => keeper.exitCode !== null || keeper.signalCode !== null,
          "Native fixture did not clean up its profile.",
          10000,
        );
        await keeperExit;
        assert.equal(keeper.exitCode, 0, setupError);
      }
    }
    for (const [mode, protectedWorkspace] of [["normal", false], ["schema-drift", false], ["malformed", false], ["hang", false], ["normal", true]]) {
      await t.test(`actual Node MCP in AppContainer: ${mode}${protectedWorkspace ? " with recorded protected workspace" : ""}`, () =>
        runCase(
          mode,
          async ({ launch, note, root }) => {
            const captured = { input: [], stdout: [], stderr: [] };
            let capturedBytes = 0,
              nativeCompletion;
            const capture = (stream, bytes) => {
              capturedBytes += bytes.length;
              assert.ok(capturedBytes <= 128 * 1024);
              captured[stream].push(Buffer.from(bytes));
            };
            const signal = AbortSignal.timeout(mode === "hang" ? 2000 : 15000);
            let journalReady = false,
              checks = 0;
            const invocation = {
                launch,
                tools: [
                  {
                    name: "note.read",
                    inputSchema: {
                      type: "object",
                      properties: { path: { type: "string", enum: ["note.txt"] } },
                      required: ["path"],
                      additionalProperties: false,
                    },
                    outputSchema: {
                      type: "object",
                      properties: { content: { type: "string" } },
                      required: ["content"],
                      additionalProperties: false,
                    },
                  },
                ],
                toolName: "note.read",
                arguments: { path: "note.txt" },
                maxResponseBytes: 65536,
                signal,
                imageGuard: guard,
            };
            const execute = async (request) => executeWorkerMcpStdioTool(
              {
                ...invocation,
                signal: request ? AbortSignal.any([signal, request.signal]) : signal,
                beforeLaunch: async (_signal, frozenLaunch) => {
                  if (request) await request.retainNativeWorkspace(frozenLaunch);
                  journalReady = true;
                },
                assertCurrent: async () => {
                  if (++checks > 1) assert.equal(journalReady, true);
                  if (request) await request.assertRemoteCurrent();
                },
              },
              async (configuration, options) => {
                if (request) await request.beforeNative(configuration);
                const actual = await startWindowsWorkerStdio(configuration, options);
                void actual.completion.then(
                  (value) => {
                    nativeCompletion = value;
                  },
                  () => {
                    nativeCompletion = "interrupted";
                  },
                );
                return {
                  ...actual,
                  write: async (bytes) => {
                    capture("input", bytes);
                    await actual.write(bytes);
                  },
                  read: async () => {
                    const chunk = await actual.read();
                    if (chunk) capture(chunk.stream, chunk.bytes);
                    return chunk;
                  },
                };
              },
            );
            const { outcome, journalProof } = protectedWorkspace
              ? await runJournaledMcpFixture({ root, workerDist, invocation, execute })
              : { outcome: await execute() };
            const trace = Object.fromEntries(
              Object.entries(captured).map(([key, chunks]) => [key, Buffer.concat(chunks).toString("utf8")]),
            );
            fs.writeFileSync(
              path.join(root, "mcp-exchange.json"),
              JSON.stringify({ ...trace, nativeCompletion, outcome, ...(journalProof ? { journalProof } : {}) }, null, 2),
            );
            // Malformed stdout stops the session immediately; its unique bytes
            // prove that branch even if the separate diagnostic pipe is not read.
            if (mode !== "malformed")
              assert.ok(trace.stderr.includes(`fixture-mode:${mode}\n`), "The intended server branch must actually run.");
            const calls = trace.input
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
              .filter((rpc) => rpc.method === "tools/call");
            receipts.push({
              case: `mcp-${mode}${protectedWorkspace ? "-protected-journal" : ""}`,
              outcome,
              currentChecks: checks,
              runtimeBundleSha256: launch.runtimeBundleSha256,
              ...(journalProof ? { journalProof } : {}),
            });
            if (mode === "normal") {
              assert.deepEqual(outcome, {
                disposition: "succeeded",
                output: {
                  content: [{ type: "text", text: note }],
                  structuredContent: { content: note },
                  isError: false,
                },
              });
              assert.ok(checks >= 8);
              assert.equal(calls.length, 1);
              assert.equal(nativeCompletion.processImageVerified, true);
              assert.equal(nativeCompletion.protectedWorkspaceVerified, protectedWorkspace);
              assert.equal(nativeCompletion.zeroProcessesVerified, true);
            } else {
              assert.deepEqual(outcome, { disposition: "unknown", errorCode: "destination_mcp_outcome_uncertain" });
              assert.equal(calls.length, 0);
              if (mode === "malformed") assert.equal(trace.stdout, "not a protocol response\n");
              if (mode === "schema-drift") assert.ok(trace.stdout.includes('"inputSchema":{"type":"object"}'));
              if (mode === "hang") assert.equal(signal.aborted, true);
            }
          },
          true,
          protectedWorkspace,
        ),
      );
    }
    await t.test("protected workspace substitution and protocol downgrade refuse before child launch", () =>
      runCase("duplex", async ({ start, launch }) => {
        const identity = Buffer.from(launch.protectedWorkspace.rootIdentity, "hex");
        identity[identity.length - 1] ^= 0x80;
        const session = await start({ protectedWorkspace: { ...launch.protectedWorkspace, rootIdentity: identity.toString("hex") } });
        const result = await session.completion;
        assert.equal(result.processId, 0);
        assert.equal(result.runtimeBundleVerified, false);
        assert.equal(result.protectedWorkspaceVerified, false);
        assert.notEqual(result.error, 0);
        assert.equal(await session.read(), null);
        const downgrade = encodeWindowsWorkerStdioLaunch(launch);
        downgrade.write("GCSTDIO1", "ascii");
        const refused = spawnSync(built.stdioExecutor, [], {
          input: downgrade, timeout: 10000, windowsHide: true, env: { SystemRoot: process.env.SystemRoot },
        });
        assert.equal(refused.error, undefined);
        assert.equal(refused.status, 0);
        assert.equal(refused.stdout[0], 3);
        assert.equal(refused.stdout.readUInt32LE(1), refused.stdout.length - 5);
        const receipt = decodeWindowsWorkerStdioCompletion(refused.stdout.subarray(5));
        assert.notEqual(receipt.bridgeError, 0);
        assert.equal(receipt.processId, 0);
        assert.equal(receipt.protectedWorkspaceVerified, false);
        receipts.push({ case: "protected-workspace-substitution", result, downgrade: receipt });
      }, false, true),
    );
    await t.test("actual output-dependent exchange and exact native completion", () =>
      runCase("duplex", async ({ start, launch }) => {
        let checks = 0;
        const session = await start({}, async () => {
          checks++;
        });
        const pending = { stdout: "", stderr: "" };
        const challenge = await line(session, pending);
        assert.match(challenge, /^challenge:[0-9]+:[0-9]+$/u);
        await session.write(Buffer.from(`answer:${challenge.slice(10)}\n`));
        assert.equal(await line(session, pending), "accepted");
        await session.write(Buffer.from("finish\n"));
        await session.endInput();
        assert.equal(await line(session, pending), "complete");
        assert.equal(await line(session, pending, "stderr"), "diagnostic");
        const result = await session.completion;
        assert.equal(result.error, 0);
        assert.equal(result.bridgeError, 0);
        assert.equal(result.end, 0);
        assert.equal(result.processExitCode, 0);
        assert.equal(result.runtimeBundleSha256, launch.runtimeBundleSha256);
        assert.equal(result.zeroProcessesVerified, true);
        assert.equal(result.outputDrained, true);
        assert.ok(checks >= 4);
        assert.equal(alive(result.processId), false);
        receipts.push({ case: "exchange", checks, result });
      }),
    );
    await t.test("binary input and both output streams survive pressure", () =>
      runCase("duplex-echo", async ({ start }) => {
        const session = await start();
        assert.equal(await line(session, { stdout: "", stderr: "" }), "ready");
        const payload = Buffer.alloc(257 * 1024 + 31);
        for (let index = 0; index < payload.length; index++)
          payload[index] = (index * 17 + Math.floor(index / 251)) % 256;
        const chunks = { stdout: [], stderr: [] };
        await Promise.all([
          (async () => {
            for (let offset = 0; offset < payload.length; offset += 4093)
              await session.write(payload.subarray(offset, offset + 4093));
            await session.endInput();
          })(),
          (async () => {
            for (;;) {
              const chunk = await session.read();
              if (!chunk) break;
              chunks[chunk.stream].push(chunk.bytes);
            }
          })(),
        ]);
        assert.deepEqual(Buffer.concat(chunks.stdout), payload);
        assert.deepEqual(Buffer.concat(chunks.stderr), payload);
        const result = await session.completion;
        assert.equal(result.error, 0);
        assert.equal(result.standardInputBytesWritten, payload.length);
        receipts.push({ case: "binary", result });
      }),
    );
    await t.test("bundle drift refuses before native entry", () =>
      runCase("duplex", async ({ start, runtime }) => {
        fs.writeFileSync(path.join(runtime, "unreviewed.txt"), "unreviewed", { flag: "wx" });
        const session = await start();
        const result = await session.completion;
        assert.equal(result.processId, 0);
        assert.equal(result.runtimeBundleVerified, false);
        assert.notEqual(result.error, 0);
        receipts.push({ case: "bundle-drift", result });
      }),
    );
    await t.test("current-authority rejection stops the owned child", () =>
      runCase("duplex", async ({ start }) => {
        let allowed = true;
        const session = await start({}, async () => {
          if (!allowed) throw new Error("Revoked.");
        });
        const challenge = await line(session, { stdout: "", stderr: "" });
        const pid = Number(challenge.split(":")[1]);
        assert.ok(alive(pid));
        allowed = false;
        await assert.rejects(session.write(Buffer.from("revoked\n")));
        await session.stop();
        await assert.rejects(session.completion);
        await until(() => !alive(pid), "The owned child survived authority cancellation.");
        receipts.push({ case: "revocation", childExited: true });
      }),
    );
    await t.test("native parser rejects incomplete, extra and invalid configuration bytes", () =>
      runCase("duplex", async ({ launch }) => {
        const valid = encodeWindowsWorkerStdioLaunch(launch);
        const extra = Buffer.concat([valid, Buffer.from([0])]);
        extra.writeUInt32LE(valid.length - 12 + 1, 8);
        const changed = Buffer.from(valid);
        changed[12] = 255;
        const missingWorkspace = Buffer.from(valid);
        missingWorkspace.write("GCSTDIO2", "ascii");
        for (const input of [valid.subarray(0, 10), extra, changed, missingWorkspace]) {
          const result = spawnSync(built.stdioExecutor, [], {
            input,
            timeout: 10000,
            windowsHide: true,
            env: { SystemRoot: process.env.SystemRoot },
          });
          assert.equal(result.error, undefined);
          assert.equal(result.status, 0);
          assert.equal(result.stderr.length, 0);
          assert.equal(result.stdout[0], 3);
          assert.equal(result.stdout.readUInt32LE(1), result.stdout.length - 5);
          const receipt = decodeWindowsWorkerStdioCompletion(result.stdout.subarray(5));
          assert.notEqual(receipt.bridgeError, 0);
          assert.equal(receipt.processId, 0);
        }
      }),
    );
    await t.test("cancellation bounds a stalled prelaunch authority check", () =>
      runCase("duplex", async ({ start }) => {
        const cancellation = new AbortController();
        const timer = setTimeout(() => cancellation.abort(), 50);
        const started = Date.now();
        try {
          await assert.rejects(start({}, () => new Promise(() => undefined), cancellation.signal));
        } finally {
          clearTimeout(timer);
        }
        assert.ok(Date.now() - started < 2000);
      }),
    );
    await t.test("stdio image guard rejects arguments and changed installed bytes", () => {
      assert.throws(() => guard.pinStdioExecutor("unreviewed"));
      const corrupt = path.join(output, "corrupt");
      fs.mkdirSync(corrupt);
      const changed = path.join(corrupt, path.basename(built.stdioExecutor));
      fs.copyFileSync(built.stdioExecutor, changed);
      fs.appendFileSync(changed, "changed");
      const addon = path.join(corrupt, path.basename(built.guardAddon));
      fs.copyFileSync(built.guardAddon, addon);
      assert.throws(() => requireNative(addon).pinStdioExecutor());
    });
    if (packageRoot)
      assert.deepEqual(
        verifyRemoteWorkerWindowsPackage({ root: packageRoot, expectedManifestSha256: packageSha256 }),
        packageProof,
      );
    fs.writeFileSync(
      path.join(output, "results.json"),
      JSON.stringify(
        { target: "windows-x64", upstreamRequests: 0, ...(packageProof ? { packageProof } : {}), receipts },
        null,
        2,
      ),
      { flag: "wx" },
    );
  },
);
