import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { spawnSync, fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:tls";
import { test } from "node:test";
import { buildWindowsTlsKeyAdapter, compileTlsNative } from "./build-remote-worker-windows-tls.mjs";
import { validateMonocypherSourceSnapshot } from "./build-remote-worker-provisioner-windows-native.mjs";
import { resolveExactWindowsToolchain } from "./lib/remote-worker-windows-toolchain.mjs";
import { encodeWindowsTlsKeyIdentifier } from "../../apps/remote-worker-provisioner/src/windows-tls-key-identifier.ts";
import {
  CA_PEM,
  CLIENT_CERT_PEM,
  CLIENT_KEY_PEM,
  SERVER_CERT_PEM,
  SERVER_KEY_PEM,
} from "../../apps/remote-worker/src/worker-wire-client-tls.test-fixture.ts";

const root = path.resolve(import.meta.dirname, "../..");
const nativeSource = path.join(root, "apps/remote-worker-windows-tls-native/src");
const nativeTests = path.join(root, "apps/remote-worker-windows-tls-native/tests");
const provisionerSource = path.join(root, "apps/remote-worker-provisioner-windows-native/src");
const spki = new X509Certificate(CLIENT_CERT_PEM).publicKey.export({ type: "spki", format: "der" });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inputFor = (helper) => ({
  keysetGeneration: 7,
  stateSha256: "11".repeat(32),
  keysetReceiptSha256: "22".repeat(32),
  workerPublicKeySpkiBase64Url: spki.toString("base64url"),
  helperExecutablePath: helper,
  helperExecutableSha256: hash(fs.readFileSync(helper)),
});

test("TLS native builder rejects unknown targets and existing output", { skip: process.platform !== "win32" }, () => {
  assert.throws(() => buildWindowsTlsKeyAdapter({ target: "other", outputDirectory: root }), /Unsupported/);
  assert.throws(() => buildWindowsTlsKeyAdapter({ target: "windows-x64", outputDirectory: root }), /EEXIST/);
});

test(
  "native TLS adapter builds reproducibly and authenticates public-only clients",
  { skip: process.platform !== "win32", timeout: 240000 },
  async (t) => {
    assert.equal(process.version, "v24.19.0", "This acceptance lane pins the host Node engine ABI.");
    assert.equal(process.versions.openssl, "3.5.7");
    const output = fs.mkdtempSync(path.join(root, ".tmp/native-tls-acceptance-"));
    const first = buildWindowsTlsKeyAdapter({ target: "windows-x64", outputDirectory: path.join(output, "x64-first") });
    const second = buildWindowsTlsKeyAdapter({
      target: "windows-x64",
      outputDirectory: path.join(output, "x64-second"),
    });
    assert.equal(first.receipt.artifact.sha256, second.receipt.artifact.sha256);
    assert.equal(first.receipt.guardAddon.sha256, second.receipt.guardAddon.sha256);
    assert.equal(first.receipt.cellProvisioningExecutor.sha256, second.receipt.cellProvisioningExecutor.sha256);
    const armFirst = buildWindowsTlsKeyAdapter({
      target: "windows-arm64",
      outputDirectory: path.join(output, "arm64-first"),
    });
    const armSecond = buildWindowsTlsKeyAdapter({
      target: "windows-arm64",
      outputDirectory: path.join(output, "arm64-second"),
    });
    assert.equal(armFirst.receipt.artifact.sha256, armSecond.receipt.artifact.sha256);
    assert.equal(armFirst.receipt.guardAddon.sha256, armSecond.receipt.guardAddon.sha256);
    assert.equal(armFirst.receipt.cellProvisioningExecutor.sha256, armSecond.receipt.cellProvisioningExecutor.sha256);
    t.diagnostic(`Retained native evidence: ${output}`);

    const fixtureOutput = path.join(output, "fixtures");
    fs.mkdirSync(fixtureOutput);
    const vendor = path.join(root, "vendor/monocypher/4.0.3");
    validateMonocypherSourceSnapshot(vendor);
    const seed = createPrivateKey(CLIENT_KEY_PEM).export({ type: "pkcs8", format: "der" }).subarray(16);
    assert.equal(seed.length, 32);
    fs.writeFileSync(
      path.join(fixtureOutput, "fixture_seed.hpp"),
      `#pragma once\n#include <array>\n#include <cstdint>\nconstexpr std::array<std::uint8_t,32> kFixtureSeed{${[...seed].join(",")}};\n`,
      { flag: "wx" },
    );
    const helper = compileTlsNative({
      target: "windows-x64",
      outputDirectory: fixtureOutput,
      outputName: "helper-ok.exe",
      sources: [
        path.join(nativeTests, "helper_fixture.cpp"),
        path.join(nativeSource, "tls_key_codec.cpp"),
        path.join(provisionerSource, "ed25519_runtime.cpp"),
        path.join(provisionerSource, "protocol.cpp"),
        path.join(vendor, "src/monocypher.c"),
        path.join(vendor, "src/optional/monocypher-ed25519.c"),
      ],
      includes: [
        nativeSource,
        provisionerSource,
        fixtureOutput,
        path.join(vendor, "src"),
        path.join(vendor, "src/optional"),
      ],
      defines: ["GOATCITADEL_PROVISIONER_TESTING"],
    });
    const codecTest = compileTlsNative({
      target: "windows-x64",
      outputDirectory: fixtureOutput,
      outputName: "codec-test.exe",
      asan: true,
      sources: [path.join(nativeTests, "tls_key.test.cpp"), path.join(nativeSource, "tls_key_codec.cpp")],
      includes: [nativeSource],
    });
    const toolchain = resolveExactWindowsToolchain("windows-x64");
    const checked = spawnSync(codecTest, [encodeWindowsTlsKeyIdentifier(inputFor(helper))], {
      cwd: fixtureOutput,
      windowsHide: true,
      timeout: 15000,
      encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(toolchain.compilerPath) },
    });
    fs.writeFileSync(path.join(output, "codec-test.log"), `${checked.stdout ?? ""}${checked.stderr ?? ""}`, {
      flag: "wx",
    });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);

    const outcomes = [];
    await t.test("native image guard has no process-launch, socket, service-control or signing imports", () => {
      for (const built of [first, armFirst]) {
        const dumpbin = path.join(path.dirname(toolchain.compilerPath), "dumpbin.exe");
        const imports = spawnSync(dumpbin, ["/imports", built.guardAddon], {
          cwd: output,
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 128 * 1024,
          encoding: "utf8",
          env: { SystemRoot: process.env.SystemRoot },
        });
        assert.equal(imports.status, 0, imports.stderr);
        fs.writeFileSync(path.join(output, `image-guard-${built.receipt.target}-imports.log`), imports.stdout, {
          flag: "wx",
        });
        const dlls = [...imports.stdout.matchAll(/^\s+([a-z0-9_.-]+\.dll)\s*$/gimu)]
          .map((match) => match[1].toLowerCase())
          .sort();
        assert.deepEqual(dlls, ["bcrypt.dll", "kernel32.dll"]);
        const names = [...imports.stdout.matchAll(/^\s+[0-9a-f]+\s+(\w+)\s*$/gimu)].map((match) => match[1]);
        assert.ok(names.includes("GetFinalPathNameByHandleW") && names.includes("BCryptHashData"));
        assert.deepEqual(
          names.filter((name) =>
            /^(CreateProcess|CreateThread|CreateRemoteThread|OpenSCManager|OpenService|StartService|ControlService|BCryptSign|BCryptImport|NCrypt|WinHttp|WSA|connect$|send$|recv$)/u.test(
              name,
            ),
          ),
          [],
        );
      }
      outcomes.push({ mode: "image-guard-import-boundary", targets: [first.receipt.target, armFirst.receipt.target] });
    });
    for (const mode of [
      "retained",
      "released",
      "adapter-drift",
      "helper-drift",
      "helper-junction",
      "invalid-identifier",
      "helper-write-open",
      "adapter-write-open",
    ]) {
      await t.test(`native image guard ${mode}`, async () => {
        const guarded = path.join(output, `guard-${mode}`);
        fs.mkdirSync(guarded);
        const addon = path.join(guarded, path.basename(first.guardAddon));
        const adapter = path.join(guarded, path.basename(first.dll));
        const helperDirectory = path.join(guarded, "helper");
        fs.mkdirSync(helperDirectory);
        const copiedHelper = path.join(helperDirectory, "helper-ok.exe");
        for (const [source, destination] of [
          [first.guardAddon, addon],
          [first.dll, adapter],
          [helper, copiedHelper],
        ])
          fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        let authority = inputFor(copiedHelper);
        if (mode === "adapter-drift") fs.appendFileSync(adapter, Buffer.from([1]));
        if (mode === "helper-drift") fs.appendFileSync(copiedHelper, Buffer.from([1]));
        if (mode === "helper-junction") {
          const alias = path.join(guarded, "junction");
          fs.symlinkSync(fixtureOutput, alias, "junction");
          authority = { ...inputFor(helper), helperExecutablePath: path.join(alias, path.basename(helper)) };
        }
        const existingWriter =
          mode === "helper-write-open"
            ? fs.openSync(copiedHelper, "r+")
            : mode === "adapter-write-open"
              ? fs.openSync(adapter, "r+")
              : undefined;
        const child = fork(path.join(nativeTests, "image_guard_fixture.mjs"), [], {
          cwd: guarded,
          windowsHide: true,
          silent: true,
          execArgv: ["--expose-gc"],
          env: { SystemRoot: process.env.SystemRoot },
        });
        const closed = once(child, "close");
        const firstMessage = once(child, "message");
        let stderr = "";
        child.stdout.on("data", () => {});
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
          if (stderr.length > 4096) child.kill();
        });
        const timeout = setTimeout(() => child.kill(), 10000);
        try {
          child.send({
            guard: addon,
            identifier: mode === "invalid-identifier" ? "invalid" : encodeWindowsTlsKeyIdentifier(authority),
          });
          const [result] = await Promise.race([
            firstMessage,
            closed.then(() => {
              throw new Error(`Image guard closed before readiness: ${stderr}`);
            }),
          ]);
          assert.equal(result.ready, mode === "retained" || mode === "released", JSON.stringify(result));
          if (result.ready) {
            assert.equal(result.frozen, true);
            assert.equal(result.adapterPath, adapter);
            // The adapter is not loaded yet: its lease alone must prevent replacement.
            for (const pinned of [adapter, copiedHelper]) {
              assert.throws(() => fs.openSync(pinned, "r+"), /EPERM|EACCES|EBUSY/);
              assert.throws(() => fs.renameSync(pinned, `${pinned}.moved`), /EPERM|EACCES|EBUSY/);
            }
            assert.throws(() => fs.renameSync(guarded, `${guarded}-moved`), /EPERM|EACCES|EBUSY/);
            assert.throws(() => fs.renameSync(helperDirectory, `${helperDirectory}-moved`), /EPERM|EACCES|EBUSY/);
            if (mode === "released") {
              const releaseMessage = once(child, "message");
              child.send({ release: true });
              const [released] = await Promise.race([
                releaseMessage,
                closed.then(() => {
                  throw new Error("Image guard closed before releasing");
                }),
              ]);
              assert.equal(released.released, true);
              assert.equal(child.exitCode, null);
              // The child remains alive: these must be released by GC, not process exit.
              for (const pinned of [adapter, copiedHelper]) fs.closeSync(fs.openSync(pinned, "r+"));
              fs.renameSync(helperDirectory, `${helperDirectory}-moved`);
              fs.renameSync(`${helperDirectory}-moved`, helperDirectory);
            }
            const lastMessage = once(child, "message");
            child.send({ finish: true });
            const [last] = await Promise.race([
              lastMessage,
              closed.then(() => {
                throw new Error("Image guard closed before finishing");
              }),
            ]);
            assert.equal(last.completed, true);
          }
          const [code, signal] = await closed;
          assert.equal(code, 0, stderr);
          assert.equal(signal, null);
          if (result.ready) {
            for (const pinned of [adapter, copiedHelper]) fs.closeSync(fs.openSync(pinned, "r+"));
          }
          outcomes.push({ mode: `image-guard-${mode}`, accepted: result.ready });
        } finally {
          clearTimeout(timeout);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill();
            await closed;
          }
          if (existingWriter !== undefined) fs.closeSync(existingWriter);
        }
      });
    }
    async function handshake(mode, cipher = "TLS_AES_128_GCM_SHA256", override = {}, wire = false) {
      const helperPath = mode === "ok" ? helper : path.join(fixtureOutput, `helper-${mode}.exe`);
      if (!fs.existsSync(helperPath)) fs.copyFileSync(helper, helperPath, fs.constants.COPYFILE_EXCL);
      const authority = { ...inputFor(helperPath), ...override };
      const sockets = new Set();
      let serverAccepted = 0;
      const server = createServer(
        {
          ca: CA_PEM,
          cert: SERVER_CERT_PEM,
          key: SERVER_KEY_PEM,
          requestCert: true,
          rejectUnauthorized: true,
          minVersion: "TLSv1.3",
          maxVersion: "TLSv1.3",
          ciphers: cipher,
        },
        (socket) => {
          serverAccepted++;
          if (!wire) {
            socket.end("accepted");
            return;
          }
          let request = Buffer.alloc(0);
          socket.on("data", (chunk) => {
            request = Buffer.concat([request, chunk]);
            if (request.length > 4096) {
              socket.destroy();
              return;
            }
            const split = request.indexOf("\r\n\r\n");
            if (split < 0) return;
            const head = request.subarray(0, split).toString("ascii");
            const size = Number(/Content-Length: (\d+)/u.exec(head)?.[1]);
            if (request.length < split + 4 + size) return;
            const exporter = socket.exportKeyingMaterial(32, "EXPORTER-GoatCitadel-Remote-Worker-v1", Buffer.alloc(0));
            const expected = JSON.stringify({ tlsExporterSha256: hash(exporter) });
            const ok =
              head.startsWith("POST /fixture HTTP/1.1\r\n") &&
              request.subarray(split + 4).toString("utf8") === expected;
            const body = JSON.stringify({ ok });
            socket.end(
              `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
            );
          });
        },
      );
      server.on("tlsClientError", () => {});
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const child = fork(path.join(nativeTests, "tls_client_fixture.mjs"), [], {
        windowsHide: true,
        silent: true,
        execArgv: [],
        env: { SystemRoot: process.env.SystemRoot, GOATCITADEL_TLS_TEST_CANARY: "fixture-parent-only" },
        cwd: fixtureOutput,
      });
      const exit = once(child, "exit");
      const start = performance.now();
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 4096) child.kill();
      });
      const watchdog = setTimeout(() => child.kill(), 12000);
      let result;
      child.on("message", (message) => {
        if (!message.ready) result = message;
      });
      try {
        child.send({
          ca: CA_PEM,
          cert: CLIENT_CERT_PEM,
          engine: first.dll,
          identifier: encodeWindowsTlsKeyIdentifier(authority),
          port: server.address().port,
          cipher,
          wire,
        });
        const [code, signal] = await exit;
        assert.equal(code, 0, `${mode}: ${stderr}; signal ${signal}`);
        assert.ok(result, `${mode}: child returned no result`);
        const elapsedMs = Math.round(performance.now() - start);
        outcomes.push({ mode, cipher, elapsedMs, serverAccepted, result });
        return { ...result, serverAccepted, elapsedMs };
      } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await exit;
        }
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    }
    for (const cipher of ["TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384"]) {
      await t.test(`real TLS accepts ${cipher} without private key in client`, async () => {
        const result = await handshake("ok", cipher);
        assert.equal(result.ok, true);
        assert.equal(result.serverAccepted, 1);
      });
    }
    await t.test("WorkerWireClient sends a channel-bound HTTP request through the native key context", async () => {
      const result = await handshake("ok", undefined, {}, true);
      assert.equal(result.ok, true);
      assert.equal(result.wire, true);
      assert.equal(result.serverAccepted, 1);
    });
    await t.test("native signing admits and reconnects a worker through the canonical Gateway", () => {
      const inputPath = path.join(output, "protected-worker-input.json");
      fs.writeFileSync(
        inputPath,
        JSON.stringify({ engine: first.dll, guardAddon: first.guardAddon, ...inputFor(helper) }),
        { flag: "wx" },
      );
      const checked = spawnSync(
        process.execPath,
        [
          path.join(root, "node_modules/vitest/vitest.mjs"),
          "run",
          "--root",
          "apps/gateway",
          "src/services/remote-worker-protected-worker-e2e.test.ts",
        ],
        {
          cwd: root,
          windowsHide: true,
          timeout: 90000,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          env: { ...process.env, GOATCITADEL_NATIVE_TLS_ACCEPTANCE_INPUT: inputPath },
        },
      );
      fs.writeFileSync(
        path.join(output, "protected-worker-gateway.log"),
        `${checked.stdout ?? ""}${checked.stderr ?? ""}`,
        { flag: "wx" },
      );
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
      outcomes.push({ mode: "protected-worker-admission-restart", gatewayTestExit: checked.status });
    });
    for (const mode of ["exit", "stderr", "overflow", "short", "receipt", "signature", "hang"]) {
      await t.test(`rejects helper ${mode}`, async () => {
        const result = await handshake(mode);
        assert.equal(result.ok, false);
        assert.equal(result.serverAccepted, 0);
        assert.notEqual(result.phase, "watchdog");
        assert.ok(result.elapsedMs < 8000);
        if (mode === "hang") assert.ok(result.elapsedMs >= 4900);
      });
    }
    await t.test("rejects helper image hash drift before starting TLS", async () => {
      const result = await handshake("ok", undefined, { helperExecutableSha256: "44".repeat(32) });
      assert.equal(result.ok, false);
      assert.equal(result.phase, "context");
      assert.equal(result.serverAccepted, 0);
    });
    fs.writeFileSync(
      path.join(output, "acceptance.json"),
      `${JSON.stringify(
        {
          node: process.version,
          openssl: process.versions.openssl,
          outcomes,
          x64Sha256: first.receipt.artifact.sha256,
          arm64Sha256: armFirst.receipt.artifact.sha256,
          arm64Execution: "not run",
          signer: "synthetic test helper; installed protected custody not tested",
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
  },
);
