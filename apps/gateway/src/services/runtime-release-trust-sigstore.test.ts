import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultSigstoreVerificationPort,
  encodeDerUtf8String,
  SigstoreVerificationInvalidError,
  SigstoreVerificationUnavailableError,
  type SigstoreVerificationRuntime,
} from "./runtime-release-trust-sigstore.js";

const ISSUER = "https://token.actions.githubusercontent.com";
const IDENTITY = "https://github.com/goatcitadel/GoatCitadel/.github/workflows/release-installers.yml@refs/tags/v1.0.0";
const EXPECTED_OIDS = Object.freeze({
  "1.3.6.1.4.1.57264.1.11": "github-hosted",
  "1.3.6.1.4.1.57264.1.12": "https://github.com/goatcitadel/GoatCitadel",
  "1.3.6.1.4.1.57264.1.13": "a".repeat(40),
  "1.3.6.1.4.1.57264.1.14": "refs/tags/v1.0.0",
  "1.3.6.1.4.1.57264.1.15": "1169096639",
  "1.3.6.1.4.1.57264.1.16": "https://github.com/goatcitadel",
  "1.3.6.1.4.1.57264.1.17": "267233079",
  "1.3.6.1.4.1.57264.1.18": IDENTITY,
  "1.3.6.1.4.1.57264.1.19": "a".repeat(40),
  "1.3.6.1.4.1.57264.1.20": "push",
});

describe("DefaultSigstoreVerificationPort", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("verifies fresh offline bundles only against the immutable pinned trusted-root snapshot", async () => {
    const runtime = createRuntime();
    const input = createInput(tempDirs, false);
    const port = new DefaultSigstoreVerificationPort(async () => runtime);

    await expect(port.verify(input)).resolves.toEqual({
      trustRootSource: "pinned",
      onlineRefresh: "not_requested",
    });

    expect(runtime.parseTrustedRoot).toHaveBeenCalledTimes(1);
    expect(runtime.parseTrustedRoot.mock.calls[0]?.[0]).toMatchObject({
      mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    });
    expect(runtime.verifyBundle).toHaveBeenCalledWith({
      bundle: input.bundle,
      certificateBytes: input.certificateBytes,
      trustedRoot: { source: "pinned" },
      certificateIssuer: ISSUER,
      certificateIdentityPattern:
        "^https://github\\.com/goatcitadel/GoatCitadel/\\.github/workflows/release-installers\\.yml@refs/tags/v1\\.0\\.0$",
      certificateOIDs: EXPECTED_OIDS,
      ctLogThreshold: 1,
      tlogThreshold: 1,
    });
    expect(runtime.fetchOnlineTrustedRoot).not.toHaveBeenCalled();
    expect(fs.existsSync(input.tufCachePath)).toBe(false);
  });

  it("uses the installed verifier's exact DER UTF8String semantics for Fulcio workflow OIDs", () => {
    const requireFromTest = createRequire(import.meta.url);
    const verifierPackagePath = requireFromTest.resolve("@sigstore/verify/package.json");
    const { verifyOIDs } = requireFromTest(path.join(path.dirname(verifierPackagePath), "dist", "policy.js")) as {
      verifyOIDs(
        policyOids: Array<{ oid: { id: number[] }; value: Buffer }>,
        signerOids: Array<{ oid: { id: number[] }; value: Buffer }>,
      ): void;
    };
    const oid = { id: [1, 3, 6, 1, 4, 1, 57_264, 1, 18] };
    const signerOids = [{ oid, value: encodeDerUtf8String(IDENTITY) }];

    expect(() => verifyOIDs([{ oid, value: Buffer.from(IDENTITY, "utf8") }], signerOids)).toThrow();
    expect(() => verifyOIDs([{ oid, value: encodeDerUtf8String(IDENTITY) }], signerOids)).not.toThrow();

    const longWorkflowIdentity = `${IDENTITY}${"/delegated-workflow".repeat(3)}`;
    const longBytes = Buffer.from(longWorkflowIdentity, "utf8");
    expect(longBytes.byteLength).toBeGreaterThanOrEqual(0x80);
    expect(longBytes.byteLength).toBeLessThanOrEqual(0xff);
    const longDerValue = encodeDerUtf8String(longWorkflowIdentity);
    expect(longDerValue.subarray(0, 3)).toEqual(Buffer.from([0x0c, 0x81, longBytes.byteLength]));
    const longSignerOids = [{ oid, value: longDerValue }];
    expect(() => verifyOIDs([{ oid, value: Buffer.from(longWorkflowIdentity, "utf8") }], longSignerOids)).toThrow();
    expect(() => verifyOIDs([{ oid, value: longDerValue }], longSignerOids)).not.toThrow();
  });

  it("ignores a poisoned persistent root and uses a fresh per-process cache for bounded online rotation", async () => {
    const runtime = createRuntime();
    runtime.fetchOnlineTrustedRoot.mockResolvedValue({ source: "online" });
    const input = createInput(tempDirs, true);
    const poisonedRepository = path.join(input.tufCachePath, "process-old", "tuf-repo-cdn.sigstore.dev");
    fs.mkdirSync(poisonedRepository, { recursive: true });
    fs.writeFileSync(path.join(poisonedRepository, "root.json"), JSON.stringify({ attacker: true }));
    const port = new DefaultSigstoreVerificationPort(async () => runtime);

    await expect(port.verify(input)).resolves.toEqual({
      trustRootSource: "online",
      onlineRefresh: "succeeded",
    });

    const onlineInput = runtime.fetchOnlineTrustedRoot.mock.calls[0]?.[0];
    expect(onlineInput).toMatchObject({
      mirrorUrl: "https://tuf-repo-cdn.sigstore.dev",
      timeoutMs: 5_000,
      retries: 1,
    });
    expect(path.basename(onlineInput!.bootstrapRootPath)).toBe("bootstrap-root.json");
    expect(JSON.parse(fs.readFileSync(onlineInput!.bootstrapRootPath, "utf8"))).toMatchObject({
      signed: { _type: "root", version: 14 },
    });
    expect(path.relative(input.tufCachePath, onlineInput!.cachePath)).toMatch(/^process-/);
    expect(onlineInput!.cachePath).not.toContain("process-old");
    expect(runtime.verifyBundle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        trustedRoot: { source: "pinned" },
      }),
    );
    expect(runtime.verifyBundle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        trustedRoot: { source: "online" },
      }),
    );
    expect(JSON.parse(fs.readFileSync(path.join(poisonedRepository, "root.json"), "utf8"))).toEqual({ attacker: true });
  });

  it("does not promote an online root into the offline anchor across a restart", async () => {
    const firstRuntime = createRuntime();
    firstRuntime.fetchOnlineTrustedRoot.mockResolvedValue({ source: "rotated-online" });
    const input = createInput(tempDirs, true);
    await new DefaultSigstoreVerificationPort(async () => firstRuntime).verify(input);

    const restartedRuntime = createRuntime();
    await new DefaultSigstoreVerificationPort(async () => restartedRuntime).verify({
      ...input,
      refreshTrustRoot: false,
    });

    expect(restartedRuntime.fetchOnlineTrustedRoot).not.toHaveBeenCalled();
    expect(restartedRuntime.verifyBundle).toHaveBeenCalledTimes(1);
    expect(restartedRuntime.verifyBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedRoot: { source: "pinned" },
      }),
    );
  });

  it("retains an authenticated rotated online root for later no-refresh verification in the same process", async () => {
    const runtime = createRuntime();
    runtime.fetchOnlineTrustedRoot.mockResolvedValue({ source: "rotated-online" });
    runtime.verifyBundle.mockImplementation(({ trustedRoot }) => {
      if ((trustedRoot as { source?: string }).source === "pinned") {
        const error = new Error("pinned root rejected rotated certificate");
        error.name = "VerificationError";
        throw error;
      }
    });
    const input = createInput(tempDirs, true);
    const port = new DefaultSigstoreVerificationPort(async () => runtime);

    await expect(port.verify(input)).resolves.toEqual({
      trustRootSource: "online",
      onlineRefresh: "succeeded",
    });
    await expect(port.verify({ ...input, refreshTrustRoot: false })).resolves.toEqual({
      trustRootSource: "online",
      onlineRefresh: "not_requested",
    });

    expect(runtime.fetchOnlineTrustedRoot).toHaveBeenCalledTimes(1);
    expect(runtime.verifyBundle.mock.calls.map(([call]) => (call.trustedRoot as { source: string }).source)).toEqual([
      "pinned",
      "rotated-online",
      "rotated-online",
    ]);
  });

  it("uses a fresh immutable-bootstrap cache generation for every online refresh", async () => {
    const runtime = createRuntime();
    const generationPaths: string[] = [];
    runtime.fetchOnlineTrustedRoot.mockImplementation(async ({ cachePath, bootstrapRootPath }) => {
      generationPaths.push(cachePath);
      expect(JSON.parse(fs.readFileSync(bootstrapRootPath, "utf8"))).toMatchObject({ signed: { version: 14 } });
      const repository = path.join(cachePath, "tuf-repo-cdn.sigstore.dev");
      fs.mkdirSync(repository, { recursive: true });
      const evolvedRootPath = path.join(repository, "root.json");
      expect(fs.existsSync(evolvedRootPath)).toBe(false);
      fs.writeFileSync(evolvedRootPath, JSON.stringify({ signed: { version: 15 } }));
      return { source: "online" };
    });
    const input = createInput(tempDirs, true);
    const port = new DefaultSigstoreVerificationPort(async () => runtime);

    await port.verify(input);
    await port.verify(input);

    expect(runtime.fetchOnlineTrustedRoot).toHaveBeenCalledTimes(2);
    expect(generationPaths[1]).not.toBe(generationPaths[0]);
  });

  it("uses pinned verification when online refresh is unavailable and reports the retry signal", async () => {
    const runtime = createRuntime();
    runtime.fetchOnlineTrustedRoot.mockRejectedValue(new Error("network unavailable"));
    const input = createInput(tempDirs, true);

    await expect(new DefaultSigstoreVerificationPort(async () => runtime).verify(input)).resolves.toEqual({
      trustRootSource: "pinned",
      onlineRefresh: "unavailable",
    });
    expect(runtime.verifyBundle).toHaveBeenCalledTimes(1);
  });

  it("classifies trust as unavailable when pinned verification fails and no current online root can be obtained", async () => {
    const runtime = createRuntime();
    runtime.verifyBundle.mockImplementationOnce(() => {
      const error = new Error("pinned root rejected a possibly rotated certificate");
      error.name = "VerificationError";
      throw error;
    });
    runtime.fetchOnlineTrustedRoot.mockRejectedValue(new Error("network unavailable"));

    await expect(
      new DefaultSigstoreVerificationPort(async () => runtime).verify(createInput(tempDirs, true)),
    ).rejects.toMatchObject({
      name: "SigstoreVerificationUnavailableError",
      cause: expect.any(SigstoreVerificationInvalidError),
    });
  });

  it("allows only one unresolved timed-out online refresh and starts a new generation only after it settles", async () => {
    const runtime = createRuntime();
    let settleLateRefresh!: (value: unknown) => void;
    const lateRefresh = new Promise<unknown>((resolve) => {
      settleLateRefresh = resolve;
    });
    runtime.fetchOnlineTrustedRoot.mockReturnValueOnce(lateRefresh).mockResolvedValueOnce({ source: "online" });
    const trackedTasks: Promise<void>[] = [];
    const port = new DefaultSigstoreVerificationPort(
      async () => runtime,
      (task) => trackedTasks.push(task),
      20,
    );
    const input = createInput(tempDirs, true);

    await expect(port.verify(input)).resolves.toEqual({
      trustRootSource: "pinned",
      onlineRefresh: "unavailable",
    });
    const abandonedPath = runtime.fetchOnlineTrustedRoot.mock.calls[0]![0].cachePath;

    runtime.verifyBundle.mockImplementationOnce(() => {
      const error = new Error("active root rejected while the prior refresh remained pending");
      error.name = "VerificationError";
      throw error;
    });
    await expect(port.verify(input)).rejects.toBeInstanceOf(SigstoreVerificationUnavailableError);
    await expect(port.verify(input)).resolves.toEqual({
      trustRootSource: "pinned",
      onlineRefresh: "unavailable",
    });
    expect(runtime.fetchOnlineTrustedRoot).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(input.tufCachePath).filter((entry) => entry.startsWith("process-"))).toHaveLength(1);

    settleLateRefresh({ source: "too-late" });
    await vi.waitFor(() => {
      expect(fs.existsSync(abandonedPath)).toBe(false);
    });

    await expect(port.verify(input)).resolves.toEqual({
      trustRootSource: "online",
      onlineRefresh: "succeeded",
    });
    expect(runtime.fetchOnlineTrustedRoot).toHaveBeenCalledTimes(2);
    const replacementPath = runtime.fetchOnlineTrustedRoot.mock.calls[1]![0].cachePath;
    expect(replacementPath).not.toBe(abandonedPath);
    await Promise.all(trackedTasks);
    await vi.waitFor(() => {
      expect(fs.existsSync(replacementPath)).toBe(false);
    });
  });

  it("reserves cache setup synchronously so concurrent verification starts only one online fetch", async () => {
    const runtime = createRuntime();
    let settleFirstRefresh!: (value: unknown) => void;
    const firstRefresh = new Promise<unknown>((resolve) => {
      settleFirstRefresh = resolve;
    });
    runtime.fetchOnlineTrustedRoot.mockReturnValueOnce(firstRefresh).mockResolvedValueOnce({ source: "online" });
    const port = new DefaultSigstoreVerificationPort(async () => runtime, undefined, 20);
    const input = createInput(tempDirs, true);

    const first = port.verify(input);
    const concurrent = port.verify(input);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      { trustRootSource: "pinned", onlineRefresh: "unavailable" },
      { trustRootSource: "pinned", onlineRefresh: "unavailable" },
    ]);

    expect(runtime.fetchOnlineTrustedRoot).toHaveBeenCalledTimes(1);
    const firstGeneration = runtime.fetchOnlineTrustedRoot.mock.calls[0]![0].cachePath;
    expect(fs.readdirSync(input.tufCachePath).filter((entry) => entry.startsWith("process-"))).toEqual([
      path.basename(firstGeneration),
    ]);

    settleFirstRefresh({ source: "too-late" });
    await vi.waitFor(() => expect(fs.existsSync(firstGeneration)).toBe(false));

    await expect(port.verify(input)).resolves.toEqual({
      trustRootSource: "online",
      onlineRefresh: "succeeded",
    });
    expect(runtime.fetchOnlineTrustedRoot).toHaveBeenCalledTimes(2);
    expect(runtime.fetchOnlineTrustedRoot.mock.calls[1]![0].cachePath).not.toBe(firstGeneration);
  });

  it("bounds Gateway shutdown tracking when an abort-ignorant online refresh never settles", async () => {
    const runtime = createRuntime();
    runtime.fetchOnlineTrustedRoot.mockReturnValue(new Promise<unknown>(() => undefined));
    const trackedTasks: Promise<void>[] = [];
    const port = new DefaultSigstoreVerificationPort(
      async () => runtime,
      (task) => trackedTasks.push(task),
      20,
    );
    const input = createInput(tempDirs, true);

    await expect(port.verify(input)).resolves.toEqual({
      trustRootSource: "pinned",
      onlineRefresh: "unavailable",
    });
    const quarantinedPath = runtime.fetchOnlineTrustedRoot.mock.calls[0]![0].cachePath;
    expect(fs.existsSync(quarantinedPath)).toBe(true);
    expect(trackedTasks).toHaveLength(1);

    await expect(settlesWithin(Promise.allSettled(trackedTasks), 250)).resolves.toBeUndefined();
    expect(fs.existsSync(quarantinedPath)).toBe(true);
  });

  it("stops waiting promptly when the caller aborts an unresolved online refresh", async () => {
    const runtime = createRuntime();
    runtime.fetchOnlineTrustedRoot.mockReturnValue(new Promise<unknown>(() => undefined));
    const trackedTasks: Promise<void>[] = [];
    const port = new DefaultSigstoreVerificationPort(
      async () => runtime,
      (task) => trackedTasks.push(task),
      30_000,
    );
    const controller = new AbortController();
    const input = { ...createInput(tempDirs, true), signal: controller.signal };
    const verification = port.verify(input).then((result) => {
      expect(result).toEqual({ trustRootSource: "pinned", onlineRefresh: "unavailable" });
    });
    await vi.waitFor(() => expect(runtime.fetchOnlineTrustedRoot).toHaveBeenCalledTimes(1));
    const quarantinedPath = runtime.fetchOnlineTrustedRoot.mock.calls[0]![0].cachePath;

    controller.abort(new Error("Gateway is closing"));

    await expect(settlesWithin(verification, 250)).resolves.toBeUndefined();
    await expect(settlesWithin(Promise.allSettled(trackedTasks), 250)).resolves.toBeUndefined();
    expect(fs.existsSync(quarantinedPath)).toBe(true);
    expect(runtime.fetchOnlineTrustedRoot).toHaveBeenCalledTimes(1);
  });

  it.each(["ValidationError", "VerificationError", "PolicyError"])(
    "classifies %s bundle verification failures as invalid",
    async (errorName) => {
      const runtime = createRuntime();
      runtime.verifyBundle.mockImplementation(() => {
        const error = new Error(errorName);
        error.name = errorName;
        throw error;
      });
      await expect(
        new DefaultSigstoreVerificationPort(async () => runtime).verify(createInput(tempDirs, false)),
      ).rejects.toBeInstanceOf(SigstoreVerificationInvalidError);
      expect(runtime.fetchOnlineTrustedRoot).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["wrong source SHA", "1.3.6.1.4.1.57264.1.13", "b".repeat(40)],
    ["wrong source ref", "1.3.6.1.4.1.57264.1.14", "refs/heads/main"],
    ["repository URI case mismatch", "1.3.6.1.4.1.57264.1.12", "https://github.com/GoatCitadel/goatcitadel"],
    ["same-name replacement repository", "1.3.6.1.4.1.57264.1.15", "9999999999"],
    ["same-name replacement owner", "1.3.6.1.4.1.57264.1.17", "9999999999"],
    ["wrong build-config SHA", "1.3.6.1.4.1.57264.1.19", "b".repeat(40)],
  ])("classifies a certificate with %s OID evidence as invalid", async (_label, oid, actualValue) => {
    const runtime = createRuntime();
    const actualOids = { ...EXPECTED_OIDS, [oid]: actualValue };
    runtime.verifyBundle.mockImplementation((input) => {
      for (const [expectedOid, expectedValue] of Object.entries(input.certificateOIDs)) {
        if (actualOids[expectedOid as keyof typeof actualOids] !== expectedValue) {
          const error = new Error("certificate OID policy mismatch");
          error.name = "PolicyError";
          throw error;
        }
      }
    });

    await expect(
      new DefaultSigstoreVerificationPort(async () => runtime).verify(createInput(tempDirs, false)),
    ).rejects.toBeInstanceOf(SigstoreVerificationInvalidError);
  });

  it("classifies missing verifier modules as unavailable", async () => {
    const input = createInput(tempDirs, false);
    const port = new DefaultSigstoreVerificationPort(async () => {
      throw new Error("module unavailable");
    });
    await expect(port.verify(input)).rejects.toBeInstanceOf(SigstoreVerificationUnavailableError);
  });

  it("lets an authenticated current online root rejection override stale pinned acceptance", async () => {
    const runtime = createRuntime();
    runtime.fetchOnlineTrustedRoot.mockResolvedValue({ source: "online" });
    runtime.verifyBundle
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("online policy rejected bundle");
      });
    const error = await new DefaultSigstoreVerificationPort(async () => runtime)
      .verify(createInput(tempDirs, true))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SigstoreVerificationInvalidError);
    expect(error).toMatchObject({
      verificationResult: { trustRootSource: "online", onlineRefresh: "succeeded" },
    });
    expect(runtime.fetchOnlineTrustedRoot).toHaveBeenCalledTimes(1);
    expect(runtime.verifyBundle).toHaveBeenCalledTimes(2);
  });

  it("rejects a poisoned parent junction before online TUF mutates or reads it", async () => {
    const runtime = createRuntime();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goat-sigstore-junction-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "goat-sigstore-junction-outside-"));
    tempDirs.push(root, outside);
    const junction = path.join(root, "poisoned");
    fs.symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir");
    const input = {
      ...createInput(tempDirs, true),
      tufCachePath: path.join(junction, "release-trust"),
    };

    await expect(new DefaultSigstoreVerificationPort(async () => runtime).verify(input)).resolves.toEqual({
      trustRootSource: "pinned",
      onlineRefresh: "unavailable",
    });
    expect(runtime.fetchOnlineTrustedRoot).not.toHaveBeenCalled();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("loads the exact direct Sigstore verifier dependencies offline", async () => {
    const input = createInput(tempDirs, false);
    input.bundle = { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" };
    await expect(new DefaultSigstoreVerificationPort().verify(input)).rejects.toBeInstanceOf(
      SigstoreVerificationInvalidError,
    );
    expect(fs.existsSync(input.tufCachePath)).toBe(false);
  });
});

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

function createRuntime() {
  return {
    parseTrustedRoot: vi.fn((_json: unknown) => ({ source: "pinned" })),
    verifyBundle: vi.fn((_input: Parameters<SigstoreVerificationRuntime["verifyBundle"]>[0]) => undefined),
    fetchOnlineTrustedRoot: vi.fn(
      async (_input: Parameters<SigstoreVerificationRuntime["fetchOnlineTrustedRoot"]>[0]) => ({ source: "online" }),
    ),
  } satisfies SigstoreVerificationRuntime;
}

function createInput(tempDirs: string[], refreshTrustRoot: boolean) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "goat-sigstore-port-"));
  tempDirs.push(parent);
  return {
    bundle: { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", verificationMaterial: {} },
    certificateBytes: Buffer.from("exact certificate bytes"),
    certificateIssuer: ISSUER,
    certificateIdentityURI: IDENTITY,
    certificateOIDs: EXPECTED_OIDS,
    tufCachePath: path.join(parent, "cache", "release-trust", "sigstore-tuf"),
    refreshTrustRoot,
  };
}
