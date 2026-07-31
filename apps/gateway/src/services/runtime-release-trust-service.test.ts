import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultSigstoreVerificationPort, type SigstoreVerificationRuntime } from "./runtime-release-trust-sigstore.js";
import {
  resolvePackagedRuntimeAppDir,
  runWithConcurrency,
  RuntimeReleaseTrustService,
  SigstoreVerificationInvalidError,
  SigstoreVerificationUnavailableError,
  type SigstoreVerificationPort,
} from "./runtime-release-trust-service.js";

const COMMIT = "a".repeat(40);
const ISSUER = "https://token.actions.githubusercontent.com";
const IDENTITY = "https://github.com/goatcitadel/GoatCitadel/.github/workflows/release-installers.yml@refs/tags/v1.0.0";

describe("RuntimeReleaseTrustService", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stops claiming hash work after the first error and drains workers that are already active", async () => {
    const claimed: number[] = [];
    const firstError = new Error("first digest mismatch");
    let releaseActiveWorker!: () => void;
    const activeWorker = new Promise<void>((resolve) => {
      releaseActiveWorker = resolve;
    });
    let settled = false;
    const result = runWithConcurrency([0, 1, 2, 3], 2, async (value) => {
      claimed.push(value);
      if (value === 0) throw firstError;
      if (value === 1) await activeWorker;
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    void result.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(claimed).toEqual([0, 1]));
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseActiveWorker();
    await expect(result).resolves.toBe(firstError);
    expect(claimed).toEqual([0, 1]);
  });

  it("lets service close abort a never-settling online TUF wait without waiting for the long port deadline", async () => {
    const fixture = createFixture(tempDirs);
    const fetchOnlineTrustedRoot = vi.fn(() => new Promise<unknown>(() => undefined));
    const runtime = {
      parseTrustedRoot: vi.fn(() => ({ source: "pinned" })),
      verifyBundle: vi.fn(() => undefined),
      fetchOnlineTrustedRoot,
    } satisfies SigstoreVerificationRuntime;
    const trackedTasks: Promise<void>[] = [];
    const port = new DefaultSigstoreVerificationPort(
      async () => runtime,
      (task) => trackedTasks.push(task),
      30_000,
    );
    const service = createService(fixture, port);
    const refresh = service.requestRefresh({ reason: "startup" });
    // Reaching the online fetch is this case's precondition, not its assertion. A
    // loaded host needs more than vi.waitFor's one-second default to schedule the
    // background task; the close/refresh deadlines asserted below stay untouched.
    await vi.waitFor(() => expect(fetchOnlineTrustedRoot).toHaveBeenCalledTimes(1), { timeout: 15_000 });

    await expect(settlesWithin(service.close(), 500)).resolves.toBeUndefined();
    await expect(settlesWithin(refresh, 500)).resolves.toBeUndefined();
    await expect(settlesWithin(Promise.allSettled(trackedTasks), 250)).resolves.toBeUndefined();
    expect(fetchOnlineTrustedRoot).toHaveBeenCalledTimes(1);
  });

  it("verifies exact publisher identity and all immutable files, including a zero-byte file", async () => {
    const fixture = createFixture(tempDirs);
    const verify = vi.fn(async (input: Parameters<SigstoreVerificationPort["verify"]>[0]) => {
      expect(input.certificateIssuer).toBe(ISSUER);
      expect(input.certificateIdentityURI).toBe(IDENTITY);
      expect(input.certificateBytes).toEqual(fixture.certificateBytes);
      expect(input.refreshTrustRoot).toBe(true);
      expect(input.certificateOIDs).toMatchObject({
        "1.3.6.1.4.1.57264.1.11": "github-hosted",
        "1.3.6.1.4.1.57264.1.12": "https://github.com/goatcitadel/GoatCitadel",
        "1.3.6.1.4.1.57264.1.13": COMMIT,
        "1.3.6.1.4.1.57264.1.14": "refs/tags/v1.0.0",
        "1.3.6.1.4.1.57264.1.15": "1169096639",
        "1.3.6.1.4.1.57264.1.16": "https://github.com/goatcitadel",
        "1.3.6.1.4.1.57264.1.17": "267233079",
        "1.3.6.1.4.1.57264.1.18": IDENTITY,
        "1.3.6.1.4.1.57264.1.19": COMMIT,
        "1.3.6.1.4.1.57264.1.20": "push",
      });
    });
    const service = createService(fixture, { verify });

    const snapshot = await service.requestRefresh({ reason: "startup" });

    expect(snapshot).toMatchObject({
      certificate: { status: "verified", issuer: ISSUER, identity: IDENTITY },
      payload: {
        status: "verified",
        target: "windows-x64",
        fileCount: 5,
        totalBytes: fixture.totalBytes,
      },
    });
    expect(snapshot.authenticatedCertificate).toMatchObject({ schemaVersion: 2, tag: "v1.0.0" });
    expect(snapshot.verifiedAt).toBeTruthy();
    expect(verify).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("keeps the same-input refresh single-flight", async () => {
    const fixture = createFixture(tempDirs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verify = vi.fn(async () => gate);
    const service = createService(fixture, { verify });

    const first = service.requestRefresh({ reason: "startup" });
    const second = service.requestRefresh({ reason: "periodic" });
    expect(second).toBe(first);
    release();
    await expect(first).resolves.toMatchObject({ payload: { status: "verified" } });
    expect(verify).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("does not allow consumers to mutate cached trust or its authenticated certificate", async () => {
    const fixture = createFixture(tempDirs);
    const service = createService(fixture, { verify: vi.fn(async () => undefined) });
    const snapshot = await service.requestRefresh();

    expect(() => {
      (snapshot.certificate as { status: string }).status = "invalid";
    }).toThrow();
    expect(() => {
      (snapshot.authenticatedCertificate as Record<string, unknown>).tag = "attacker";
    }).toThrow();
    expect(service.getSnapshot()).toMatchObject({
      certificate: { status: "verified" },
      payload: { status: "verified" },
      authenticatedCertificate: { tag: "v1.0.0" },
    });
    await service.close();
  });

  it("fails closed when the Sigstore trust root is unavailable", async () => {
    const fixture = createFixture(tempDirs);
    const service = createService(fixture, {
      verify: vi.fn(async () => {
        throw new SigstoreVerificationUnavailableError();
      }),
    });

    await expect(service.requestRefresh()).resolves.toMatchObject({
      certificate: { status: "unavailable", failureCode: "sigstore_verifier_unavailable" },
      payload: { status: "unverified" },
    });
    await service.close();
  });

  it("fails closed when the exact issuer, workflow identity, or certificate bytes are rejected", async () => {
    const fixture = createFixture(tempDirs);
    const verify = vi.fn(async (input: Parameters<SigstoreVerificationPort["verify"]>[0]) => {
      expect(input.certificateIssuer).toBe(ISSUER);
      expect(input.certificateIdentityURI).toBe(IDENTITY);
      throw new SigstoreVerificationInvalidError();
    });
    const service = createService(fixture, { verify });

    await expect(service.requestRefresh()).resolves.toMatchObject({
      certificate: { status: "invalid", failureCode: "sigstore_verification_invalid" },
      payload: { status: "unverified" },
    });
    await service.close();
  });

  it("rejects an unsafe tag before invoking Sigstore", async () => {
    const fixture = createFixture(tempDirs);
    fixture.certificate.tag = "v1.0.0/refs/heads/main";
    writeCertificate(fixture);
    const verify = vi.fn(async () => undefined);
    const service = createService(fixture, { verify });

    await expect(service.requestRefresh()).resolves.toMatchObject({
      certificate: { status: "invalid", failureCode: "certificate_schema_invalid" },
      payload: { status: "unverified" },
    });
    expect(verify).not.toHaveBeenCalled();
    await service.close();
  });

  it("rejects a certificate tag that does not exactly match its declared version", async () => {
    const fixture = createFixture(tempDirs);
    fixture.certificate.version = "0.9.0";
    fixture.manifest.version = "0.9.0";
    rewriteManifestAndRebind(fixture);
    const verify = vi.fn(async () => undefined);
    const service = createService(fixture, { verify });

    await expect(service.requestRefresh()).resolves.toMatchObject({
      certificate: { status: "invalid", failureCode: "certificate_schema_invalid" },
      payload: { status: "unverified" },
    });
    expect(verify).not.toHaveBeenCalled();
    await service.close();
  });

  it("rejects a malformed or renamed bundle as missing or invalid attestation", async () => {
    const malformed = createFixture(tempDirs);
    fs.writeFileSync(malformed.bundlePath, "[]");
    const malformedService = createService(malformed, { verify: vi.fn() });
    await expect(malformedService.requestRefresh()).resolves.toMatchObject({
      certificate: { status: "invalid", failureCode: "sigstore_bundle_invalid" },
    });
    await malformedService.close();

    const missing = createFixture(tempDirs);
    fs.renameSync(missing.bundlePath, `${missing.bundlePath}.renamed`);
    const missingService = createService(missing, { verify: vi.fn() });
    await expect(missingService.requestRefresh()).resolves.toMatchObject({
      certificate: { status: "missing", failureCode: "attestation_missing" },
    });
    await missingService.close();
  });

  it("rejects a certificate-bound manifest whose exact bytes changed", async () => {
    const fixture = createFixture(tempDirs);
    fs.appendFileSync(fixture.manifestPath, "\n");
    const service = createService(fixture, { verify: vi.fn(async () => undefined) });

    await expect(service.requestRefresh()).resolves.toMatchObject({
      certificate: { status: "verified" },
      payload: { status: "mismatch" },
    });
    await service.close();
  });

  it.each([
    ["changed same-size file", (fixture: Fixture) => fs.writeFileSync(fixture.payloadPath, "altered-runtime\n")],
    ["missing file", (fixture: Fixture) => fs.rmSync(path.join(fixture.appDir, "empty.dat"))],
    ["extra file", (fixture: Fixture) => fs.writeFileSync(path.join(fixture.appDir, "unexpected.js"), "unexpected")],
  ])("rejects an installed payload with a %s", async (_label, mutate) => {
    const fixture = createFixture(tempDirs);
    mutate(fixture);
    const service = createService(fixture, { verify: vi.fn(async () => undefined) });

    await expect(service.requestRefresh()).resolves.toMatchObject({
      certificate: { status: "verified" },
      payload: { status: "mismatch" },
    });
    await service.close();
  });

  it("rejects a symlink or Windows junction inside the immutable roots", async () => {
    const fixture = createFixture(tempDirs);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "goat-release-outside-"));
    tempDirs.push(outside);
    fs.writeFileSync(path.join(outside, "outside.js"), "outside");
    fs.symlinkSync(outside, path.join(fixture.appDir, "linked"), process.platform === "win32" ? "junction" : "dir");
    const service = createService(fixture, { verify: vi.fn(async () => undefined) });

    await expect(service.requestRefresh()).resolves.toMatchObject({
      certificate: { status: "verified" },
      payload: { status: "mismatch" },
    });
    await service.close();
  });

  it("rejects a hard-linked immutable file", async () => {
    const fixture = createFixture(tempDirs);
    fs.linkSync(fixture.payloadPath, path.join(fixture.appDir, "hardlink.js"));
    const service = createService(fixture, { verify: vi.fn(async () => undefined) });

    await expect(service.requestRefresh()).resolves.toMatchObject({
      certificate: { status: "verified" },
      payload: { status: "mismatch" },
    });
    await service.close();
  });

  it("rejects traversal, unsorted, and Windows case-colliding manifest paths", async () => {
    for (const mutate of [
      (fixture: Fixture) => {
        fixture.manifest.payload.files[0].path = "app/../escape.js";
      },
      (fixture: Fixture) => {
        fixture.manifest.payload.files.reverse();
      },
      (fixture: Fixture) => {
        fixture.manifest.payload.files[1].path = fixture.manifest.payload.files[0].path.toUpperCase();
      },
      (fixture: Fixture) => {
        fixture.manifest.payload.files[0].path = "APP/RELEASE-MANIFEST.JSON";
      },
      (fixture: Fixture) => {
        fixture.manifest.payload.files[0].path = "APP/RELEASE-EVIDENCE/runner.js";
      },
    ]) {
      const fixture = createFixture(tempDirs);
      mutate(fixture);
      rewriteManifestAndRebind(fixture);
      const service = createService(fixture, { verify: vi.fn(async () => undefined) });
      await expect(service.requestRefresh()).resolves.toMatchObject({
        certificate: { status: "verified" },
        payload: { status: "mismatch" },
      });
      await service.close();
    }
  });

  it("keeps synchronous snapshot projection O(1) and detects metadata drift on asynchronous refresh", async () => {
    const fixture = createFixture(tempDirs);
    const verify = vi.fn(async () => undefined);
    const service = createService(fixture, { verify });
    await service.requestRefresh();
    expect(verify).toHaveBeenCalledTimes(1);

    fs.renameSync(fixture.certificatePath, `${fixture.certificatePath}.renamed`);
    expect(service.getSnapshot()).toMatchObject({
      certificate: { status: "verified" },
      payload: { status: "verified" },
    });
    expect(verify).toHaveBeenCalledTimes(1);

    await expect(service.requestRefresh({ reason: "operator" })).resolves.toMatchObject({
      certificate: { status: "missing", failureCode: "certificate_missing" },
      payload: { status: "unverified" },
    });
    expect(verify).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("invalidates a fresh green snapshot on the next periodic metadata-tree refresh", async () => {
    const fixture = createFixture(tempDirs);
    const verify = vi.fn(async () => undefined);
    const service = createService(fixture, { verify });
    await service.requestRefresh({ reason: "startup" });
    expect(verify).toHaveBeenCalledTimes(1);

    fs.writeFileSync(fixture.payloadPath, "altered-runtime\n");
    await expect(service.requestRefresh({ reason: "periodic" })).resolves.toMatchObject({
      certificate: { status: "verified" },
      payload: { status: "mismatch" },
    });
    expect(verify).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it("ages unchanged metadata into a full hash scan and makes operator refreshes full scans", async () => {
    const fixture = createFixture(tempDirs);
    let nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const verify = vi.fn(async () => undefined);
    const service = createService(fixture, { verify }, { now: () => new Date(nowMs) });
    await service.requestRefresh({ reason: "startup" });

    nowMs += 4 * 60 * 1000;
    await service.requestRefresh({ reason: "periodic" });
    expect(verify).toHaveBeenCalledTimes(1);

    nowMs += 60 * 1000;
    await service.requestRefresh({ reason: "periodic" });
    expect(verify).toHaveBeenCalledTimes(2);

    nowMs += 1;
    await service.requestRefresh({ reason: "operator" });
    expect(verify).toHaveBeenCalledTimes(3);
    await service.close();
  });

  it("retries a failed online trust refresh after a short bound instead of suppressing it for a day", async () => {
    const fixture = createFixture(tempDirs);
    let nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const verify = vi
      .fn()
      .mockRejectedValueOnce(new SigstoreVerificationUnavailableError("online trust refresh unavailable"))
      .mockResolvedValueOnce({ trustRootSource: "pinned", onlineRefresh: "not_requested" })
      .mockResolvedValueOnce({ trustRootSource: "online", onlineRefresh: "succeeded" });
    const service = createService(fixture, { verify }, { now: () => new Date(nowMs) });

    await service.requestRefresh({ reason: "startup" });
    nowMs += 60 * 1000;
    await service.requestRefresh({ reason: "operator" });
    nowMs += 4 * 60 * 1000;
    await service.requestRefresh({ reason: "operator" });

    expect(verify.mock.calls.map(([input]) => input.refreshTrustRoot)).toEqual([true, false, true]);
    await service.close();
  });

  it("backs off for a day after TUF authenticates a current root even when that root rejects the bundle", async () => {
    const fixture = createFixture(tempDirs);
    let nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const verify = vi
      .fn()
      .mockRejectedValueOnce(
        new SigstoreVerificationInvalidError("current online root rejected the bundle", {
          verificationResult: { trustRootSource: "online", onlineRefresh: "succeeded" },
        }),
      )
      .mockRejectedValueOnce(new SigstoreVerificationInvalidError("retained online root rejected the bundle"));
    const service = createService(fixture, { verify }, { now: () => new Date(nowMs) });

    await service.requestRefresh({ reason: "startup" });
    nowMs += 5 * 60 * 1000;
    await service.requestRefresh({ reason: "operator" });

    expect(verify.mock.calls.map(([input]) => input.refreshTrustRoot)).toEqual([true, false]);
    await service.close();
  });

  it("discards an in-flight result when immutable payload bytes change", async () => {
    const fixture = createFixture(tempDirs);
    let release!: () => void;
    const verify = vi.fn(async () => {
      if (verify.mock.calls.length > 1) return;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const service = createService(fixture, { verify });
    const refresh = service.requestRefresh();
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    fs.writeFileSync(fixture.payloadPath, "tampered-runtime\n");
    release();

    await expect(refresh).resolves.toMatchObject({
      certificate: { status: "verified" },
      payload: { status: "mismatch" },
    });
    await service.close();
  });

  it("does not verify an unlisted or detached runtime entry wrapper", async () => {
    const unlisted = createFixture(tempDirs);
    const wrapperPath = path.join(unlisted.appDir, "wrapper.js");
    fs.writeFileSync(wrapperPath, "unlisted wrapper\n");
    const unlistedService = new RuntimeReleaseTrustService({
      mutableRootDir: path.join(unlisted.rootDir, "runtime-root"),
      packagedAppDir: unlisted.appDir,
      runtimeBindingPaths: {
        gatewayModulePath: unlisted.modulePath,
        entryPath: wrapperPath,
        executablePath: unlisted.executablePath,
      },
      platform: "win32",
      arch: "x64",
      sigstore: { verify: vi.fn(async () => undefined) },
    });
    await expect(unlistedService.requestRefresh()).resolves.toMatchObject({
      certificate: { status: "verified" },
      payload: { status: "mismatch" },
    });
    await unlistedService.close();

    const detached = createFixture(tempDirs);
    const detachedEntry = path.join(detached.appDir, "release-evidence", "runner.js");
    fs.writeFileSync(detachedEntry, "detached wrapper\n");
    const detachedService = new RuntimeReleaseTrustService({
      mutableRootDir: path.join(detached.rootDir, "runtime-root"),
      packagedAppDir: detached.appDir,
      runtimeBindingPaths: {
        gatewayModulePath: detached.modulePath,
        entryPath: detachedEntry,
        executablePath: detached.executablePath,
      },
      platform: "win32",
      arch: "x64",
      sigstore: { verify: vi.fn(async () => undefined) },
    });
    expect(detachedService.getSnapshot()).toMatchObject({
      certificate: { status: "not_applicable" },
      payload: { status: "not_applicable" },
    });
    await detachedService.close();
  });

  it("does not let a separate genuine app directory lend verified status to an outside modified runner", async () => {
    const genuine = createFixture(tempDirs);
    const modifiedRunner = createFixture(tempDirs);
    fs.writeFileSync(modifiedRunner.modulePath, "modified outside gateway module\n");
    const outsideRuntimePaths = {
      gatewayModulePath: modifiedRunner.modulePath,
      entryPath: modifiedRunner.payloadPath,
      executablePath: modifiedRunner.executablePath,
    };

    expect(resolvePackagedRuntimeAppDir([genuine.appDir], outsideRuntimePaths)).toBeUndefined();
    const service = new RuntimeReleaseTrustService({
      mutableRootDir: path.join(genuine.rootDir, "runtime-root"),
      packagedAppDir: genuine.appDir,
      runtimeBindingPaths: outsideRuntimePaths,
      platform: "win32",
      arch: "x64",
      sigstore: { verify: vi.fn(async () => undefined) },
    });
    expect(service.getSnapshot()).toMatchObject({
      certificate: { status: "not_applicable" },
      payload: { status: "not_applicable" },
    });
    await service.close();
  });
});

interface Fixture {
  rootDir: string;
  appDir: string;
  payloadPath: string;
  modulePath: string;
  executablePath: string;
  manifestPath: string;
  certificatePath: string;
  bundlePath: string;
  totalBytes: number;
  manifest: Record<string, any>;
  certificate: Record<string, any>;
  certificateBytes: Buffer;
}

function createFixture(tempDirs: string[]): Fixture {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "goat-runtime-release-trust-"));
  tempDirs.push(rootDir);
  const appDir = path.join(rootDir, "app");
  const binDir = path.join(rootDir, "bin");
  const evidenceDir = path.join(appDir, "release-evidence");
  fs.mkdirSync(path.join(appDir, "gateway", "dist", "services"), { recursive: true });
  fs.mkdirSync(path.join(appDir, "runtime", "node"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  const payloadPath = path.join(appDir, "gateway", "dist", "main.js");
  const modulePath = path.join(appDir, "gateway", "dist", "services", "gateway-service.js");
  const executablePath = path.join(appDir, "runtime", "node", "node.exe");
  fs.writeFileSync(payloadPath, "trusted-runtime\n");
  fs.writeFileSync(modulePath, "trusted-service-module\n");
  fs.writeFileSync(executablePath, "trusted-node-runtime\n");
  fs.writeFileSync(path.join(appDir, "empty.dat"), "");
  fs.writeFileSync(path.join(binDir, "goat.cmd"), "@echo off\r\n");
  const files = [
    buildFileRecord(rootDir, "app/empty.dat"),
    buildFileRecord(rootDir, "app/gateway/dist/main.js"),
    buildFileRecord(rootDir, "app/gateway/dist/services/gateway-service.js"),
    buildFileRecord(rootDir, "app/runtime/node/node.exe"),
    buildFileRecord(rootDir, "bin/goat.cmd"),
  ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const manifest: Record<string, any> = {
    schemaVersion: 2,
    product: "GoatCitadel",
    version: "1.0.0",
    sourceCommit: COMMIT,
    sourceModified: false,
    target: "windows-x64",
    platform: "windows",
    arch: "x64",
    payload: {
      algorithm: "sha256",
      roots: ["app", "bin"],
      detachedMetadataFiles: ["app/release-manifest.json"],
      detachedMetadataTrees: ["app/release-evidence"],
      fileCount: files.length,
      totalBytes,
      files,
    },
  };
  const manifestPath = path.join(appDir, "release-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  const runtimePayloads = ["windows-x64", "windows-arm64"].map((target) => ({
    target,
    platform: "windows",
    arch: target.slice("windows-".length),
    installLayout: "goatcitadel-bundle-v1",
    immutableRoots: ["app", "bin"],
    detachedMetadataFiles: ["app/release-manifest.json"],
    detachedMetadataTrees: ["app/release-evidence"],
    manifest: {
      relativePath: `${target}-release-assets/app/release-manifest.json`,
      installedPath: "app/release-manifest.json",
      sha256: manifestSha256,
      sizeBytes: manifestBytes.byteLength,
    },
  }));
  const certificate: Record<string, any> = {
    schemaVersion: 2,
    product: "GoatCitadel",
    version: "1.0.0",
    tag: "v1.0.0",
    commit: COMMIT,
    targetCommit: COMMIT,
    repository: "goatcitadel/GoatCitadel",
    releaseWorkflow: {
      name: "Release Installers and Bundles",
      workflowFile: ".github/workflows/release-installers.yml",
      eventName: "push",
      ref: "refs/tags/v1.0.0",
      sha: COMMIT,
      workflowRef: "goatcitadel/GoatCitadel/.github/workflows/release-installers.yml@refs/tags/v1.0.0",
      trustEligible: true,
    },
    runtimePayloads,
  };
  const certificatePath = path.join(evidenceDir, "release-certificate.json");
  const bundlePath = path.join(evidenceDir, "release-certificate.sigstore.json");
  fs.writeFileSync(certificatePath, JSON.stringify(certificate));
  fs.writeFileSync(bundlePath, JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" }));
  return {
    rootDir,
    appDir,
    payloadPath,
    modulePath,
    executablePath,
    manifestPath,
    certificatePath,
    bundlePath,
    totalBytes,
    manifest,
    certificate,
    certificateBytes: fs.readFileSync(certificatePath),
  };
}

function createService(
  fixture: Fixture,
  sigstore: SigstoreVerificationPort,
  extra: { now?: () => Date } = {},
): RuntimeReleaseTrustService {
  return new RuntimeReleaseTrustService({
    mutableRootDir: path.join(fixture.rootDir, "runtime-root"),
    packagedAppDir: fixture.appDir,
    runtimeBindingPaths: {
      gatewayModulePath: fixture.modulePath,
      entryPath: fixture.payloadPath,
      executablePath: fixture.executablePath,
    },
    platform: "win32",
    arch: "x64",
    sigstore,
    now: extra.now,
  });
}

function rewriteManifestAndRebind(fixture: Fixture): void {
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
  const bytes = fs.readFileSync(fixture.manifestPath);
  const binding = fixture.certificate.runtimePayloads[0].manifest;
  binding.sha256 = sha256(bytes);
  binding.sizeBytes = bytes.byteLength;
  writeCertificate(fixture);
}

function writeCertificate(fixture: Fixture): void {
  fs.writeFileSync(fixture.certificatePath, JSON.stringify(fixture.certificate));
  fixture.certificateBytes = fs.readFileSync(fixture.certificatePath);
}

function buildFileRecord(rootDir: string, relativePath: string): { path: string; sha256: string; sizeBytes: number } {
  const bytes = fs.readFileSync(path.resolve(rootDir, ...relativePath.split("/")));
  return { path: relativePath, sha256: sha256(bytes), sizeBytes: bytes.byteLength };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function settlesWithin(task: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Task did not settle within ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
