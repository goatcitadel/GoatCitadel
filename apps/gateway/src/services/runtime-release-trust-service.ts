import path from "node:path";
import { createHash } from "node:crypto";
import type { CertificateAttestationStatus, RuntimePayloadIntegrityStatus } from "@goatcitadel/contracts";
import {
  MAX_RELEASE_CERTIFICATE_BYTES,
  MAX_RELEASE_MANIFEST_BYTES,
  MAX_SIGSTORE_BUNDLE_BYTES,
  ReleaseTrustFilesystemError,
  hashStableRuntimePayloadFile,
  readStableReleaseTrustFile,
  resolveRuntimeReleaseBindingPaths,
  snapshotRuntimePayloadTree,
  type RuntimePayloadTreeSnapshot,
  type RuntimeReleaseBindingPaths,
  type StableReleaseTrustFile,
} from "./runtime-release-trust-filesystem.js";
export { resolvePackagedRuntimeAppDir } from "./runtime-release-trust-filesystem.js";
export type { RuntimeReleaseBindingPaths } from "./runtime-release-trust-filesystem.js";
import {
  buildReleaseWorkflowIdentity,
  readUntrustedReleaseCertificateIdentity,
  resolveAuthenticatedRuntimePayloadManifest,
  type AuthenticatedRuntimePayloadManifest,
} from "./runtime-release-trust-manifest.js";
import {
  DefaultSigstoreVerificationPort,
  SigstoreVerificationInvalidError,
  SigstoreVerificationUnavailableError,
  type SigstoreVerificationResult,
  type SigstoreVerificationPort,
} from "./runtime-release-trust-sigstore.js";
export {
  SigstoreVerificationInvalidError,
  SigstoreVerificationUnavailableError,
  type SigstoreVerificationPort,
} from "./runtime-release-trust-sigstore.js";

const SIGSTORE_ISSUER = "https://token.actions.githubusercontent.com";
const SIGSTORE_FULCIO_OID_ROOT = "1.3.6.1.4.1.57264.1";
const FIXED_REPOSITORY_URI = "https://github.com/goatcitadel/GoatCitadel";
const FIXED_REPOSITORY_ID = "1169096639";
const FIXED_REPOSITORY_OWNER_URI = "https://github.com/goatcitadel";
const FIXED_REPOSITORY_OWNER_ID = "267233079";
const MAX_VERIFICATION_AGE_MS = 5 * 60 * 1000;
const ONLINE_TUF_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;
const ONLINE_TUF_REFRESH_RETRY_MS = 5 * 60 * 1000;
const PERIODIC_CHECK_MS = 60 * 1000;
const HASH_CONCURRENCY = 4;

export interface RuntimeReleaseTrustSnapshot {
  revision: number;
  checkedAt?: string;
  verifiedAt?: string;
  inputFingerprint?: string;
  certificate: {
    status: CertificateAttestationStatus;
    certificateSha256?: string;
    bundleSha256?: string;
    issuer?: string;
    identity?: string;
    failureCode?: string;
  };
  payload: {
    status: RuntimePayloadIntegrityStatus;
    target?: string;
    manifestSha256?: string;
    fileCount?: number;
    totalBytes?: number;
    failureCode?: string;
  };
  /** Exact parsed bytes that passed Sigstore verification; never serialized directly. */
  authenticatedCertificate?: Readonly<Record<string, unknown>>;
}

export interface RuntimeReleaseTrustReader {
  getSnapshot(): RuntimeReleaseTrustSnapshot;
  requestRefresh(input?: {
    force?: boolean;
    reason?: "startup" | "input_changed" | "periodic" | "operator";
  }): Promise<RuntimeReleaseTrustSnapshot>;
}

export interface RuntimeReleaseTrustServiceDependencies {
  mutableRootDir: string;
  packagedAppDir?: string;
  runtimeBindingPaths?: RuntimeReleaseBindingPaths;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => Date;
  sigstore?: SigstoreVerificationPort;
  registerBackgroundTask?: (task: Promise<void>) => void;
  checkIntervalMs?: number;
}

interface ReleaseTrustInputs {
  certificate: StableReleaseTrustFile;
  bundle: StableReleaseTrustFile;
  manifest?: StableReleaseTrustFile;
  manifestFailure?: ReleaseTrustFilesystemError;
  payloadTree?: RuntimePayloadTreeSnapshot;
  payloadTreeFailure?: ReleaseTrustFilesystemError;
  bundleJson: unknown;
  fingerprint: string;
}

export class RuntimeReleaseTrustService implements RuntimeReleaseTrustReader {
  private readonly appDir?: string;
  private readonly bundleRoot?: string;
  private readonly runtimeBindingRelativePaths: readonly string[];
  private readonly now: () => Date;
  private readonly sigstore: SigstoreVerificationPort;
  private readonly abortController = new AbortController();
  private snapshot: RuntimeReleaseTrustSnapshot;
  private inFlight?: Promise<RuntimeReleaseTrustSnapshot>;
  private refreshAgainRequested = false;
  private forceRefreshRequested = false;
  private timer?: NodeJS.Timeout;
  private lastOnlineTrustRootSuccessMs = 0;
  private lastOnlineTrustRootFailureMs = 0;
  private closed = false;

  public constructor(private readonly deps: RuntimeReleaseTrustServiceDependencies) {
    let appDir: string | undefined;
    let runtimeBindingRelativePaths: string[] = [];
    if (deps.packagedAppDir && deps.runtimeBindingPaths) {
      try {
        appDir = path.resolve(deps.packagedAppDir);
        runtimeBindingRelativePaths = resolveRuntimeReleaseBindingPaths(appDir, deps.runtimeBindingPaths);
      } catch {
        appDir = undefined;
      }
    }
    this.appDir = appDir;
    this.bundleRoot = this.appDir ? path.dirname(this.appDir) : undefined;
    this.runtimeBindingRelativePaths = runtimeBindingRelativePaths;
    this.now = deps.now ?? (() => new Date());
    this.sigstore = deps.sigstore ?? new DefaultSigstoreVerificationPort(undefined, deps.registerBackgroundTask);
    this.snapshot = freezeReleaseTrustSnapshot(
      this.appDir
        ? this.buildSnapshot("pending", "pending", { failureCode: "startup" })
        : this.buildSnapshot("not_applicable", "not_applicable"),
    );
  }

  public start(): void {
    if (!this.appDir || this.closed || this.timer) return;
    this.track(this.requestRefresh({ reason: "startup" }));
    this.timer = setInterval(() => {
      this.track(this.requestRefresh({ reason: "periodic" }));
    }, this.deps.checkIntervalMs ?? PERIODIC_CHECK_MS);
    this.timer.unref?.();
  }

  public getSnapshot(): RuntimeReleaseTrustSnapshot {
    // Synchronous readiness projections never touch disk or invoke Sigstore.
    // Startup, periodic, and explicit refreshes own all asynchronous proof work.
    return this.snapshot;
  }

  public requestRefresh(
    input: {
      force?: boolean;
      reason?: "startup" | "input_changed" | "periodic" | "operator";
    } = {},
  ): Promise<RuntimeReleaseTrustSnapshot> {
    if (!this.appDir || this.closed) return Promise.resolve(this.snapshot);
    this.refreshAgainRequested = true;
    // An explicit operator refresh is a full cryptographic/hash scan. Normal
    // periodic refreshes still perform the cheap metadata-tree fingerprint on
    // every pass and age into a full scan on MAX_VERIFICATION_AGE_MS.
    this.forceRefreshRequested ||= input.force === true || input.reason === "operator";
    if (!this.inFlight) {
      this.inFlight = this.runRefreshLoop().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.abortController.abort(new Error("Runtime release trust service is closing."));
    if (this.inFlight) await Promise.allSettled([this.inFlight]);
  }

  private async runRefreshLoop(): Promise<RuntimeReleaseTrustSnapshot> {
    while (!this.closed && this.refreshAgainRequested) {
      this.refreshAgainRequested = false;
      const force = this.forceRefreshRequested;
      this.forceRefreshRequested = false;
      const inputs = await this.tryReadInputs();
      if (!inputs) continue;
      const alreadyFresh =
        !force &&
        inputs.fingerprint === this.snapshot.inputFingerprint &&
        this.snapshot.certificate.status === "verified" &&
        this.snapshot.payload.status === "verified" &&
        this.snapshot.verifiedAt !== undefined &&
        this.now().getTime() - Date.parse(this.snapshot.verifiedAt) < MAX_VERIFICATION_AGE_MS;
      if (alreadyFresh) {
        // Distinguish the cheap metadata-tree check time from verifiedAt,
        // which remains the time of the last complete payload hash pass.
        this.publish({
          ...this.snapshot,
          revision: 0,
          checkedAt: this.now().toISOString(),
          inputFingerprint: inputs.fingerprint,
        });
        continue;
      }
      this.markPending(
        inputs.fingerprint,
        inputs.fingerprint === this.snapshot.inputFingerprint ? "periodic" : "input_changed",
      );
      const result = await this.verifyInputs(inputs);
      if (this.closed) return this.snapshot;
      const finalInputs = await this.tryReadInputs();
      if (!finalInputs) continue;
      if (finalInputs.fingerprint !== inputs.fingerprint) {
        this.markPending(finalInputs.fingerprint, "input_changed");
        this.refreshAgainRequested = true;
        continue;
      }
      this.publish(result);
    }
    return this.snapshot;
  }

  private async verifyInputs(inputs: ReleaseTrustInputs): Promise<RuntimeReleaseTrustSnapshot> {
    let tag: string;
    let commit: string;
    let identity: string;
    try {
      const certificateIdentity = readUntrustedReleaseCertificateIdentity(inputs.certificate.bytes);
      tag = certificateIdentity.tag;
      commit = certificateIdentity.commit;
      identity = buildReleaseWorkflowIdentity(tag);
    } catch {
      return this.buildSnapshot("invalid", "unverified", {
        checkedAt: this.now().toISOString(),
        inputFingerprint: inputs.fingerprint,
        certificateSha256: inputs.certificate.sha256,
        bundleSha256: inputs.bundle.sha256,
        failureCode: "certificate_schema_invalid",
      });
    }

    const nowMs = this.now().getTime();
    const refreshTrustRoot =
      nowMs - this.lastOnlineTrustRootSuccessMs >= ONLINE_TUF_REFRESH_AGE_MS &&
      nowMs - this.lastOnlineTrustRootFailureMs >= ONLINE_TUF_REFRESH_RETRY_MS;
    try {
      const verification = await this.sigstore.verify({
        bundle: inputs.bundleJson,
        certificateBytes: inputs.certificate.bytes,
        certificateIssuer: SIGSTORE_ISSUER,
        certificateIdentityURI: identity,
        certificateOIDs: buildFulcioCertificateOidPolicy({ tag, commit, workflowIdentity: identity }),
        tufCachePath: path.join(this.deps.mutableRootDir, "cache", "release-trust", "sigstore-tuf"),
        refreshTrustRoot,
        signal: this.abortController.signal,
      });
      this.recordOnlineRefreshResult(refreshTrustRoot, verification, nowMs);
    } catch (error) {
      if (refreshTrustRoot && error instanceof SigstoreVerificationInvalidError && error.verificationResult) {
        this.recordOnlineRefreshResult(true, error.verificationResult, nowMs);
      } else if (refreshTrustRoot && error instanceof SigstoreVerificationUnavailableError) {
        this.lastOnlineTrustRootFailureMs = nowMs;
      }
      const unavailable = error instanceof SigstoreVerificationUnavailableError;
      return this.buildSnapshot(unavailable ? "unavailable" : "invalid", "unverified", {
        checkedAt: this.now().toISOString(),
        inputFingerprint: inputs.fingerprint,
        certificateSha256: inputs.certificate.sha256,
        bundleSha256: inputs.bundle.sha256,
        failureCode: unavailable ? "sigstore_verifier_unavailable" : "sigstore_verification_invalid",
      });
    }

    if (!inputs.manifest || inputs.manifestFailure) {
      return this.buildSnapshot("verified", "mismatch", {
        checkedAt: this.now().toISOString(),
        inputFingerprint: inputs.fingerprint,
        certificateSha256: inputs.certificate.sha256,
        bundleSha256: inputs.bundle.sha256,
        issuer: SIGSTORE_ISSUER,
        identity,
        failureCode: "installed_manifest_unavailable",
      });
    }

    if (!inputs.payloadTree || inputs.payloadTreeFailure) {
      return this.buildSnapshot("verified", "mismatch", {
        checkedAt: this.now().toISOString(),
        inputFingerprint: inputs.fingerprint,
        certificateSha256: inputs.certificate.sha256,
        bundleSha256: inputs.bundle.sha256,
        issuer: SIGSTORE_ISSUER,
        identity,
        manifestSha256: inputs.manifest.sha256,
        failureCode: inputs.payloadTreeFailure?.failureCode ?? "payload_tree_unavailable",
      });
    }

    let manifest: AuthenticatedRuntimePayloadManifest | undefined;
    try {
      manifest = resolveAuthenticatedRuntimePayloadManifest({
        certificateBytes: inputs.certificate.bytes,
        manifestBytes: inputs.manifest.bytes,
        runtimePlatform: this.deps.platform ?? process.platform,
        runtimeArch: this.deps.arch ?? process.arch,
      });
      await this.verifyRuntimePayload(manifest);
    } catch (error) {
      return this.buildSnapshot("verified", "mismatch", {
        checkedAt: this.now().toISOString(),
        inputFingerprint: inputs.fingerprint,
        certificateSha256: inputs.certificate.sha256,
        bundleSha256: inputs.bundle.sha256,
        issuer: SIGSTORE_ISSUER,
        identity,
        target: manifest?.target,
        manifestSha256: manifest?.manifestSha256 ?? inputs.manifest.sha256,
        fileCount: manifest?.fileCount,
        totalBytes: manifest?.totalBytes,
        failureCode: error instanceof ReleaseTrustFilesystemError ? error.failureCode : "payload_verification_error",
        authenticatedCertificate: manifest?.certificate,
      });
    }

    const verifiedAt = this.now().toISOString();
    if (!manifest) {
      return this.buildSnapshot("verified", "mismatch", {
        checkedAt: verifiedAt,
        inputFingerprint: inputs.fingerprint,
        failureCode: "payload_manifest_unavailable",
      });
    }
    return this.buildSnapshot("verified", "verified", {
      checkedAt: verifiedAt,
      verifiedAt,
      inputFingerprint: inputs.fingerprint,
      certificateSha256: inputs.certificate.sha256,
      bundleSha256: inputs.bundle.sha256,
      issuer: manifest.issuer,
      identity: manifest.identity,
      target: manifest.target,
      manifestSha256: manifest.manifestSha256,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      authenticatedCertificate: manifest.certificate,
    });
  }

  private async verifyRuntimePayload(manifest: AuthenticatedRuntimePayloadManifest): Promise<void> {
    if (!this.bundleRoot) throw new ReleaseTrustFilesystemError("invalid", "Bundle root is unavailable.");
    const manifestPaths = new Set(manifest.files.map((file) => file.path));
    if (
      this.runtimeBindingRelativePaths.length !== 3 ||
      this.runtimeBindingRelativePaths.some((relativePath) => !manifestPaths.has(relativePath))
    ) {
      throw new ReleaseTrustFilesystemError(
        "mismatch",
        "The executing Gateway runtime is not bound by the authenticated payload manifest.",
      );
    }
    let lastRace: ReleaseTrustFilesystemError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const before = await snapshotRuntimePayloadTree(this.bundleRoot, this.abortController.signal);
        if (before.fileCount !== manifest.fileCount || before.totalBytes !== manifest.totalBytes) {
          throw new ReleaseTrustFilesystemError("mismatch", "Installed payload file set does not match the manifest.");
        }
        const expectedByPath = new Map(manifest.files.map((file) => [file.path, file]));
        for (const file of before.files) {
          const expected = expectedByPath.get(file.relativePath);
          if (!expected || expected.sizeBytes !== file.sizeBytes) {
            throw new ReleaseTrustFilesystemError(
              "mismatch",
              "Installed payload metadata does not match the manifest.",
            );
          }
        }
        await runWithConcurrency(before.files, HASH_CONCURRENCY, async (file) => {
          const expected = expectedByPath.get(file.relativePath)!;
          const sha256 = await hashStableRuntimePayloadFile({
            bundleRoot: this.bundleRoot!,
            file,
            expectedSizeBytes: expected.sizeBytes,
            signal: this.abortController.signal,
          });
          if (sha256 !== expected.sha256) {
            throw new ReleaseTrustFilesystemError("mismatch", "Installed payload digest does not match the manifest.");
          }
        });
        const after = await snapshotRuntimePayloadTree(this.bundleRoot, this.abortController.signal);
        if (after.fingerprint !== before.fingerprint) {
          throw new ReleaseTrustFilesystemError("race", "Installed payload changed during verification.");
        }
        return;
      } catch (error) {
        if (!(error instanceof ReleaseTrustFilesystemError) || error.failureCode !== "race" || attempt === 1) {
          throw error;
        }
        lastRace = error;
      }
    }
    throw lastRace ?? new ReleaseTrustFilesystemError("race", "Installed payload changed during verification.");
  }

  private async tryReadInputs(): Promise<ReleaseTrustInputs | undefined> {
    if (!this.appDir) return undefined;
    let certificate: StableReleaseTrustFile;
    let bundle: StableReleaseTrustFile;
    try {
      certificate = await readStableReleaseTrustFile({
        filePath: path.join(this.appDir, "release-evidence", "release-certificate.json"),
        trustedRoot: this.appDir,
        maxBytes: MAX_RELEASE_CERTIFICATE_BYTES,
      });
    } catch (error) {
      this.publishInputFailure(error, "certificate");
      return undefined;
    }
    try {
      bundle = await readStableReleaseTrustFile({
        filePath: path.join(this.appDir, "release-evidence", "release-certificate.sigstore.json"),
        trustedRoot: this.appDir,
        maxBytes: MAX_SIGSTORE_BUNDLE_BYTES,
      });
    } catch (error) {
      this.publishInputFailure(error, "bundle");
      return undefined;
    }
    let bundleJson: unknown;
    try {
      bundleJson = JSON.parse(bundle.bytes.toString("utf8"));
      if (!bundleJson || typeof bundleJson !== "object" || Array.isArray(bundleJson)) throw new Error("not object");
    } catch {
      this.publish(
        this.buildSnapshot("invalid", "unverified", {
          checkedAt: this.now().toISOString(),
          certificateSha256: certificate.sha256,
          bundleSha256: bundle.sha256,
          failureCode: "sigstore_bundle_invalid",
        }),
      );
      return undefined;
    }
    let manifest: StableReleaseTrustFile | undefined;
    let manifestFailure: ReleaseTrustFilesystemError | undefined;
    try {
      manifest = await readStableReleaseTrustFile({
        filePath: path.join(this.appDir, "release-manifest.json"),
        trustedRoot: this.appDir,
        maxBytes: MAX_RELEASE_MANIFEST_BYTES,
      });
    } catch (error) {
      manifestFailure = normalizeFilesystemError(error);
    }
    let payloadTree: RuntimePayloadTreeSnapshot | undefined;
    let payloadTreeFailure: ReleaseTrustFilesystemError | undefined;
    try {
      if (!this.bundleRoot) {
        throw new ReleaseTrustFilesystemError("invalid", "Bundle root is unavailable.");
      }
      // This metadata-only walk runs on every periodic/operator refresh. It
      // catches normal payload mutations immediately without putting hashes or
      // synchronous filesystem work on the readiness request path.
      payloadTree = await snapshotRuntimePayloadTree(this.bundleRoot, this.abortController.signal);
    } catch (error) {
      payloadTreeFailure = normalizeFilesystemError(error);
    }
    const fingerprint = createHash("sha256")
      .update(`certificate:${certificate.sha256}:${certificate.sizeBytes}\n`)
      .update(`bundle:${bundle.sha256}:${bundle.sizeBytes}\n`)
      .update(
        manifest
          ? `manifest:${manifest.sha256}:${manifest.sizeBytes}`
          : `manifest:${manifestFailure?.failureCode ?? "unavailable"}`,
      )
      .update("\n")
      .update(
        payloadTree
          ? `payload-tree:${payloadTree.fingerprint}:${payloadTree.fileCount}:${payloadTree.totalBytes}`
          : `payload-tree:${payloadTreeFailure?.failureCode ?? "unavailable"}`,
      )
      .digest("hex");
    return {
      certificate,
      bundle,
      manifest,
      manifestFailure,
      payloadTree,
      payloadTreeFailure,
      bundleJson,
      fingerprint,
    };
  }

  private recordOnlineRefreshResult(
    requested: boolean,
    result: SigstoreVerificationResult | void,
    nowMs: number,
  ): void {
    if (!requested) return;
    // Custom verification ports predating the result contract returned void;
    // successful completion remains a successful refresh for compatibility.
    if (!result || result.onlineRefresh === "succeeded") {
      this.lastOnlineTrustRootSuccessMs = nowMs;
      this.lastOnlineTrustRootFailureMs = 0;
      return;
    }
    if (result.onlineRefresh === "unavailable") {
      this.lastOnlineTrustRootFailureMs = nowMs;
    }
  }

  private publishInputFailure(error: unknown, input: "certificate" | "bundle"): void {
    const failure = normalizeFilesystemError(error);
    const missing = failure.failureCode === "missing";
    this.publish(
      this.buildSnapshot(missing ? "missing" : "invalid", "unverified", {
        checkedAt: this.now().toISOString(),
        failureCode:
          input === "certificate" ? `certificate_${failure.failureCode}` : `attestation_${failure.failureCode}`,
      }),
    );
  }

  private markPending(inputFingerprint: string | undefined, failureCode: string): void {
    this.publish(this.buildSnapshot("pending", "pending", { inputFingerprint, failureCode }));
  }

  private publish(snapshot: RuntimeReleaseTrustSnapshot): void {
    this.snapshot = freezeReleaseTrustSnapshot({ ...snapshot, revision: this.snapshot.revision + 1 });
  }

  private buildSnapshot(
    certificateStatus: CertificateAttestationStatus,
    payloadStatus: RuntimePayloadIntegrityStatus,
    details: {
      checkedAt?: string;
      verifiedAt?: string;
      inputFingerprint?: string;
      certificateSha256?: string;
      bundleSha256?: string;
      issuer?: string;
      identity?: string;
      target?: string;
      manifestSha256?: string;
      fileCount?: number;
      totalBytes?: number;
      failureCode?: string;
      authenticatedCertificate?: Readonly<Record<string, unknown>>;
    } = {},
  ): RuntimeReleaseTrustSnapshot {
    return {
      revision: 0,
      checkedAt: details.checkedAt,
      verifiedAt: details.verifiedAt,
      inputFingerprint: details.inputFingerprint,
      certificate: {
        status: certificateStatus,
        certificateSha256: details.certificateSha256,
        bundleSha256: details.bundleSha256,
        issuer: details.issuer,
        identity: details.identity,
        failureCode: details.failureCode,
      },
      payload: {
        status: payloadStatus,
        target: details.target,
        manifestSha256: details.manifestSha256,
        fileCount: details.fileCount,
        totalBytes: details.totalBytes,
        failureCode: details.failureCode,
      },
      authenticatedCertificate: details.authenticatedCertificate,
    };
  }

  private track(task: Promise<RuntimeReleaseTrustSnapshot>): void {
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.deps.registerBackgroundTask?.(tracked);
  }
}

function buildFulcioCertificateOidPolicy(input: {
  tag: string;
  commit: string;
  workflowIdentity: string;
}): Readonly<Record<string, string>> {
  return Object.freeze({
    [`${SIGSTORE_FULCIO_OID_ROOT}.11`]: "github-hosted",
    [`${SIGSTORE_FULCIO_OID_ROOT}.12`]: FIXED_REPOSITORY_URI,
    [`${SIGSTORE_FULCIO_OID_ROOT}.13`]: input.commit,
    [`${SIGSTORE_FULCIO_OID_ROOT}.14`]: `refs/tags/${input.tag}`,
    [`${SIGSTORE_FULCIO_OID_ROOT}.15`]: FIXED_REPOSITORY_ID,
    [`${SIGSTORE_FULCIO_OID_ROOT}.16`]: FIXED_REPOSITORY_OWNER_URI,
    [`${SIGSTORE_FULCIO_OID_ROOT}.17`]: FIXED_REPOSITORY_OWNER_ID,
    [`${SIGSTORE_FULCIO_OID_ROOT}.18`]: input.workflowIdentity,
    [`${SIGSTORE_FULCIO_OID_ROOT}.19`]: input.commit,
    [`${SIGSTORE_FULCIO_OID_ROOT}.20`]: "push",
  });
}

export async function runWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new RangeError("Concurrency must be a positive safe integer.");
  }
  let cursor = 0;
  let failed = false;
  let firstError: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (!failed && cursor < values.length) {
        const index = cursor;
        cursor += 1;
        try {
          await worker(values[index]!);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }
    }),
  );
  if (failed) throw firstError;
}

function normalizeFilesystemError(error: unknown): ReleaseTrustFilesystemError {
  return error instanceof ReleaseTrustFilesystemError
    ? error
    : new ReleaseTrustFilesystemError("invalid", "Release trust filesystem inspection failed.", { cause: error });
}

function freezeReleaseTrustSnapshot(snapshot: RuntimeReleaseTrustSnapshot): RuntimeReleaseTrustSnapshot {
  return deepFreeze(snapshot);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
