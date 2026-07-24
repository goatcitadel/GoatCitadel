import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const SIGSTORE_TUF_MIRROR = "https://tuf-repo-cdn.sigstore.dev";
const PINNED_SIGSTORE_TUF_BOOTSTRAP_ROOT_SHA256 = "c8c41ec13f06ccabf5b48541ee2550098b4c7b5349e1d180390c29a7d5c2642c";
const PINNED_SIGSTORE_TRUSTED_ROOT_SHA256 = "6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66";
const MAX_SIGSTORE_TUF_SEEDS_BYTES = 2 * 1024 * 1024;
const ONLINE_TUF_TIMEOUT_MS = 5_000;
const ONLINE_TUF_OVERALL_TIMEOUT_MS = 20_000;
const ABANDONED_CACHE_SHUTDOWN_TRACKING_MS = 100;
let pinnedSigstoreTrustMaterialPromise: Promise<PinnedSigstoreTrustMaterial> | undefined;
let defaultSigstoreRuntimePromise: Promise<SigstoreVerificationRuntime> | undefined;

interface PinnedSigstoreTrustMaterial {
  trustedRootJson: unknown;
  tufBootstrapRootBytes: Buffer;
}

interface OnlineTufCache {
  cachePath: string;
  bootstrapRootPath: string;
  bootstrapRootSha256: string;
}

interface OnlineRefreshAttempt {
  task?: Promise<unknown>;
}

export interface SigstoreVerificationResult {
  trustRootSource: "pinned" | "online";
  onlineRefresh: "not_requested" | "succeeded" | "unavailable";
}

export interface SigstoreVerificationPort {
  verify(input: {
    bundle: unknown;
    certificateBytes: Buffer;
    certificateIssuer: string;
    certificateIdentityURI: string;
    certificateOIDs: Readonly<Record<string, string>>;
    tufCachePath: string;
    refreshTrustRoot: boolean;
    signal?: AbortSignal;
  }): Promise<SigstoreVerificationResult | void>;
}

export interface SigstoreVerificationRuntime {
  parseTrustedRoot(json: unknown): unknown;
  verifyBundle(input: {
    bundle: unknown;
    certificateBytes: Buffer;
    trustedRoot: unknown;
    certificateIssuer: string;
    certificateIdentityPattern: string;
    certificateOIDs: Readonly<Record<string, string>>;
    ctLogThreshold: number;
    tlogThreshold: number;
  }): void;
  fetchOnlineTrustedRoot(input: {
    cachePath: string;
    bootstrapRootPath: string;
    mirrorUrl: string;
    timeoutMs: number;
    retries: number;
  }): Promise<unknown>;
}

interface SigstoreBundleModule {
  bundleFromJSON(bundle: unknown): unknown;
}

interface SigstoreProtobufModule {
  TrustedRoot: { fromJSON(json: unknown): unknown };
}

interface SigstoreVerifyModule {
  toSignedEntity(bundle: unknown, certificateBytes: Buffer): unknown;
  toTrustMaterial(trustedRoot: unknown): unknown;
  Verifier: new (
    trustMaterial: unknown,
    thresholds: { ctlogThreshold: number; tlogThreshold: number },
  ) => { verify(signedEntity: unknown, policy: unknown): void };
}

interface SigstoreTufModule {
  getTrustedRoot(input: {
    cachePath: string;
    rootPath: string;
    mirrorURL: string;
    forceCache: boolean;
    retry: { retries: number };
    timeout: number;
  }): Promise<unknown>;
}

export class SigstoreVerificationUnavailableError extends Error {
  public constructor(message = "Sigstore verifier is unavailable.", options?: ErrorOptions) {
    super(message, options);
    this.name = "SigstoreVerificationUnavailableError";
  }
}

export class SigstoreVerificationInvalidError extends Error {
  public readonly verificationResult?: SigstoreVerificationResult;

  public constructor(
    message = "Sigstore verification failed.",
    options?: ErrorOptions & { verificationResult?: SigstoreVerificationResult },
  ) {
    super(message, options);
    this.name = "SigstoreVerificationInvalidError";
    this.verificationResult = options?.verificationResult;
  }
}

export class DefaultSigstoreVerificationPort implements SigstoreVerificationPort {
  private onlineCacheBase?: string;
  private onlineTrustedRoot?: unknown;
  private onlineRefreshAttempt?: OnlineRefreshAttempt;
  private readonly abandonedCleanupTasks = new Set<Promise<void>>();

  public constructor(
    private readonly runtimeLoader: () => Promise<SigstoreVerificationRuntime> = loadDefaultSigstoreRuntime,
    private readonly registerBackgroundTask?: (task: Promise<void>) => void,
    private readonly onlineRefreshTimeoutMs = ONLINE_TUF_OVERALL_TIMEOUT_MS,
  ) {}

  public async verify(input: Parameters<SigstoreVerificationPort["verify"]>[0]): Promise<SigstoreVerificationResult> {
    throwIfAborted(input.signal);
    let runtime: SigstoreVerificationRuntime;
    let pinnedTrustedRoot: unknown;
    let pinnedTrustMaterial: PinnedSigstoreTrustMaterial;
    try {
      runtime = await this.runtimeLoader();
      pinnedTrustMaterial = await loadPinnedSigstoreTrustMaterial();
      pinnedTrustedRoot = runtime.parseTrustedRoot(pinnedTrustMaterial.trustedRootJson);
    } catch (error) {
      throw new SigstoreVerificationUnavailableError(undefined, { cause: error });
    }

    const identityPattern = `^${escapeRegExp(input.certificateIdentityURI)}$`;
    const activeTrustedRoot = this.onlineTrustedRoot ?? pinnedTrustedRoot;
    const activeTrustRootSource = this.onlineTrustedRoot === undefined ? "pinned" : "online";
    let activeAccepted = false;
    let activeFailure: SigstoreVerificationInvalidError | undefined;
    try {
      verifyWithTrustedRoot(runtime, activeTrustedRoot, input, identityPattern);
      activeAccepted = true;
    } catch (error) {
      activeFailure = normalizeInvalidVerification(error);
    }

    if (!input.refreshTrustRoot) {
      if (activeFailure) throw activeFailure;
      return { trustRootSource: activeTrustRootSource, onlineRefresh: "not_requested" };
    }

    // @sigstore/tuf does not accept an AbortSignal. Once an attempt times out
    // or its caller aborts, keep that exact request quarantined and never start
    // another mutable-cache generation until the unresolved fetch settles.
    if (this.onlineRefreshAttempt) {
      if (!activeAccepted) {
        throw new SigstoreVerificationUnavailableError(
          "A prior Sigstore online trust refresh is still pending after its caller stopped waiting.",
          { cause: activeFailure },
        );
      }
      return { trustRootSource: activeTrustRootSource, onlineRefresh: "unavailable" };
    }
    // Reserve synchronously before the first cache-setup await. Without this
    // reservation, concurrent callers can both pass the guard and create two
    // mutable TUF generations before either fetch is visible as pending.
    const onlineRefreshAttempt: OnlineRefreshAttempt = {};
    this.onlineRefreshAttempt = onlineRefreshAttempt;

    let onlineTrustedRoot: unknown;
    let onlineCache: OnlineTufCache | undefined;
    let onlineRefreshTask: Promise<unknown> | undefined;
    try {
      throwIfAborted(input.signal);
      onlineCache = await this.resolveOnlineCachePath(input.tufCachePath, pinnedTrustMaterial.tufBootstrapRootBytes);
      await assertSafeDirectoryTree(onlineCache.cachePath);
      await assertPinnedBootstrapRoot(onlineCache);
      const canonicalBefore = await fs.realpath(onlineCache.cachePath);
      throwIfAborted(input.signal);
      onlineRefreshTask = runtime.fetchOnlineTrustedRoot({
        cachePath: onlineCache.cachePath,
        bootstrapRootPath: onlineCache.bootstrapRootPath,
        mirrorUrl: SIGSTORE_TUF_MIRROR,
        timeoutMs: ONLINE_TUF_TIMEOUT_MS,
        retries: 1,
      });
      this.trackOnlineRefresh(onlineRefreshAttempt, onlineRefreshTask);
      onlineTrustedRoot = await withOverallDeadline(onlineRefreshTask, this.onlineRefreshTimeoutMs, input.signal);
      if (onlineTrustedRoot === undefined || onlineTrustedRoot === null) {
        throw new Error("Sigstore online trust refresh returned no trusted root.");
      }
      throwIfAborted(input.signal);
      await assertSafeDirectoryTree(onlineCache.cachePath);
      await assertPinnedBootstrapRoot(onlineCache);
      const canonicalAfter = await fs.realpath(onlineCache.cachePath);
      if (!sameCanonicalPath(canonicalBefore, canonicalAfter)) {
        throw new Error("Sigstore online trust cache changed canonical identity during refresh.");
      }
    } catch (error) {
      if (!onlineRefreshTask) this.releaseOnlineRefreshAttempt(onlineRefreshAttempt);
      if (onlineCache) this.abandonOnlineCache(onlineCache, onlineRefreshTask);
      if (!activeAccepted) {
        throw new SigstoreVerificationUnavailableError(
          "Sigstore online trust refresh was unavailable after active verification failed.",
          { cause: activeFailure ?? error },
        );
      }
      return { trustRootSource: activeTrustRootSource, onlineRefresh: "unavailable" };
    }

    // A successfully TUF-authenticated current root is authoritative for this
    // attempt. Falling back after it rejects would preserve revoked/rotated
    // trust from the older pinned snapshot.
    this.onlineTrustedRoot = onlineTrustedRoot;
    try {
      verifyWithTrustedRoot(runtime, onlineTrustedRoot, input, identityPattern);
    } catch (error) {
      throw normalizeInvalidVerification(error, {
        trustRootSource: "online",
        onlineRefresh: "succeeded",
      });
    } finally {
      if (onlineCache) this.retireOnlineCache(onlineCache);
    }
    return { trustRootSource: "online", onlineRefresh: "succeeded" };
  }

  private async resolveOnlineCachePath(basePath: string, bootstrapRootBytes: Buffer): Promise<OnlineTufCache> {
    const resolvedBase = path.resolve(basePath);
    if (this.onlineCacheBase && !sameCanonicalPath(this.onlineCacheBase, resolvedBase)) {
      return Promise.reject(new Error("Sigstore verification port cannot change its mutable cache root."));
    }
    this.onlineCacheBase = resolvedBase;
    // Every online refresh starts in a new generation rooted in the immutable
    // bootstrap. No mutable TUF root is carried into a later attempt.
    return createFreshOnlineCache(resolvedBase, bootstrapRootBytes);
  }

  private abandonOnlineCache(cache: OnlineTufCache, pendingTask?: Promise<unknown>): void {
    if (!pendingTask) {
      this.retireOnlineCache(cache);
      return;
    }
    const settled = pendingTask.then(
      () => undefined,
      () => undefined,
    );
    const cleanupWhenSettled = settled.then(() => cleanupAbandonedOnlineCache(cache.cachePath, this.onlineCacheBase));
    // @sigstore/tuf does not currently accept an AbortSignal. Keep eventual
    // cleanup attached to an abort-ignorant request, but register only a
    // bounded view with Gateway shutdown so an upstream hang cannot block an
    // update/restart forever. A still-active generation remains quarantined.
    const boundedTracking = withOverallDeadline(
      cleanupWhenSettled,
      Math.max(1, Math.min(this.onlineRefreshTimeoutMs, ABANDONED_CACHE_SHUTDOWN_TRACKING_MS)),
    ).then(
      () => undefined,
      () => undefined,
    );
    this.trackCacheCleanup(boundedTracking);
  }

  private trackOnlineRefresh(attempt: OnlineRefreshAttempt, task: Promise<unknown>): void {
    attempt.task = task;
    void task.then(
      () => {
        this.releaseOnlineRefreshAttempt(attempt, task);
      },
      () => {
        this.releaseOnlineRefreshAttempt(attempt, task);
      },
    );
  }

  private releaseOnlineRefreshAttempt(attempt: OnlineRefreshAttempt, task?: Promise<unknown>): void {
    if (this.onlineRefreshAttempt !== attempt) return;
    if (task && attempt.task !== task) return;
    this.onlineRefreshAttempt = undefined;
  }

  private retireOnlineCache(cache: OnlineTufCache): void {
    this.trackCacheCleanup(cleanupAbandonedOnlineCache(cache.cachePath, this.onlineCacheBase));
  }

  private trackCacheCleanup(cleanup: Promise<void>): void {
    const tracked = cleanup.then(
      () => undefined,
      () => undefined,
    );
    this.abandonedCleanupTasks.add(tracked);
    void tracked.then(() => {
      this.abandonedCleanupTasks.delete(tracked);
    });
    this.registerBackgroundTask?.(tracked);
  }
}

async function loadDefaultSigstoreRuntime(): Promise<SigstoreVerificationRuntime> {
  defaultSigstoreRuntimePromise ??= (async () => {
    const [bundleModule, protobufModule, verifyModule, tufModule] = await Promise.all([
      loadModule<SigstoreBundleModule>("@sigstore/bundle"),
      loadModule<SigstoreProtobufModule>("@sigstore/protobuf-specs"),
      loadModule<SigstoreVerifyModule>("@sigstore/verify"),
      loadModule<SigstoreTufModule>("@sigstore/tuf"),
    ]);
    return {
      parseTrustedRoot: (json) => protobufModule.TrustedRoot.fromJSON(json),
      verifyBundle: (input) => {
        const bundle = bundleModule.bundleFromJSON(input.bundle);
        const signedEntity = verifyModule.toSignedEntity(bundle, input.certificateBytes);
        const verifier = new verifyModule.Verifier(verifyModule.toTrustMaterial(input.trustedRoot), {
          ctlogThreshold: input.ctLogThreshold,
          tlogThreshold: input.tlogThreshold,
        });
        verifier.verify(signedEntity, {
          subjectAlternativeName: input.certificateIdentityPattern,
          extensions: { issuer: input.certificateIssuer },
          oids: Object.entries(input.certificateOIDs).map(([oid, value]) => ({
            oid: { id: oid.split(".").map(Number) },
            // Fulcio's GitHub workflow extensions (.8-.24) wrap each value in
            // a DER UTF8String inside the X.509 extension OCTET STRING. The
            // verifier exposes those inner DER bytes verbatim, so comparing
            // raw UTF-8 would reject every genuine GitHub-issued certificate.
            value: encodeDerUtf8String(value),
          })),
        });
      },
      fetchOnlineTrustedRoot: (input) =>
        tufModule.getTrustedRoot({
          cachePath: input.cachePath,
          rootPath: input.bootstrapRootPath,
          mirrorURL: input.mirrorUrl,
          forceCache: false,
          retry: { retries: input.retries },
          timeout: input.timeoutMs,
        }),
    } satisfies SigstoreVerificationRuntime;
  })();
  return defaultSigstoreRuntimePromise;
}

export function encodeDerUtf8String(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength < 0x80) {
    return Buffer.concat([Buffer.from([0x0c, bytes.byteLength]), bytes]);
  }
  if (bytes.byteLength <= 0xff) {
    return Buffer.concat([Buffer.from([0x0c, 0x81, bytes.byteLength]), bytes]);
  }
  if (bytes.byteLength <= 0xffff) {
    return Buffer.concat([Buffer.from([0x0c, 0x82, (bytes.byteLength >>> 8) & 0xff, bytes.byteLength & 0xff]), bytes]);
  }
  throw new SigstoreVerificationInvalidError("Fulcio certificate policy value exceeds its DER bound.");
}

async function loadModule<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

function withOverallDeadline<T>(task: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      fail(signal?.reason instanceof Error ? signal.reason : new Error("Sigstore online trust refresh was aborted."));
    };
    const timer = setTimeout(() => {
      fail(new Error(`Sigstore online trust refresh exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    task.then(
      (value) => {
        settle(resolve, value);
      },
      (error: unknown) => {
        fail(error);
      },
    );
  });
}

function verifyWithTrustedRoot(
  runtime: SigstoreVerificationRuntime,
  trustedRoot: unknown,
  input: Parameters<SigstoreVerificationPort["verify"]>[0],
  identityPattern: string,
): void {
  runtime.verifyBundle({
    bundle: input.bundle,
    certificateBytes: input.certificateBytes,
    trustedRoot,
    certificateIssuer: input.certificateIssuer,
    certificateIdentityPattern: identityPattern,
    certificateOIDs: input.certificateOIDs,
    ctLogThreshold: 1,
    tlogThreshold: 1,
  });
}

async function loadPinnedSigstoreTrustMaterial(): Promise<PinnedSigstoreTrustMaterial> {
  pinnedSigstoreTrustMaterialPromise ??= (async () => {
    const requireFromGateway = createRequire(import.meta.url);
    const tufPackagePath = requireFromGateway.resolve("@sigstore/tuf/package.json");
    const seedsPath = path.join(path.dirname(tufPackagePath), "seeds.json");
    const stats = await fs.lstat(seedsPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > MAX_SIGSTORE_TUF_SEEDS_BYTES) {
      throw new Error("Pinned Sigstore trusted-root package is unavailable or unsafe.");
    }
    const seedsBytes = await fs.readFile(seedsPath);
    const seeds = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(seedsBytes)) as unknown;
    const mirrorSeed = isRecord(seeds) ? seeds[SIGSTORE_TUF_MIRROR] : undefined;
    const targets = isRecord(mirrorSeed) ? mirrorSeed.targets : undefined;
    const encodedBootstrapRoot =
      isRecord(mirrorSeed) && typeof mirrorSeed["root.json"] === "string" ? mirrorSeed["root.json"] : undefined;
    const encodedTrustedRoot =
      isRecord(targets) && typeof targets["trusted_root.json"] === "string" ? targets["trusted_root.json"] : undefined;
    if (!encodedBootstrapRoot || !encodedTrustedRoot) {
      throw new Error("Pinned Sigstore trust material is missing.");
    }
    const bootstrapRootBytes = Buffer.from(encodedBootstrapRoot, "base64");
    if (createHash("sha256").update(bootstrapRootBytes).digest("hex") !== PINNED_SIGSTORE_TUF_BOOTSTRAP_ROOT_SHA256) {
      throw new Error("Pinned Sigstore TUF bootstrap-root digest is unexpected.");
    }
    const bootstrapRoot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bootstrapRootBytes)) as unknown;
    if (
      !isRecord(bootstrapRoot) ||
      !isRecord(bootstrapRoot.signed) ||
      bootstrapRoot.signed._type !== "root" ||
      bootstrapRoot.signed.version !== 14
    ) {
      throw new Error("Pinned Sigstore TUF bootstrap root is malformed.");
    }
    const trustedRootBytes = Buffer.from(encodedTrustedRoot, "base64");
    if (createHash("sha256").update(trustedRootBytes).digest("hex") !== PINNED_SIGSTORE_TRUSTED_ROOT_SHA256) {
      throw new Error("Pinned Sigstore trusted-root snapshot digest is unexpected.");
    }
    const trustedRoot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(trustedRootBytes)) as unknown;
    if (
      !isRecord(trustedRoot) ||
      typeof trustedRoot.mediaType !== "string" ||
      !Array.isArray(trustedRoot.tlogs) ||
      !Array.isArray(trustedRoot.certificateAuthorities) ||
      !Array.isArray(trustedRoot.ctlogs)
    ) {
      throw new Error("Pinned Sigstore trusted-root snapshot is malformed.");
    }
    return {
      trustedRootJson: deepFreezeJson(trustedRoot),
      tufBootstrapRootBytes: Buffer.from(bootstrapRootBytes),
    };
  })();
  return pinnedSigstoreTrustMaterialPromise;
}

async function createFreshOnlineCache(basePath: string, bootstrapRootBytes: Buffer): Promise<OnlineTufCache> {
  // No write occurs until every existing ancestor has been checked for a
  // link/reparse-point or canonical redirection. The post-create checks close
  // ordinary poisoned-parent and replacement races before TUF consumes data.
  await assertSafeExistingAncestors(basePath);
  await fs.mkdir(basePath, { recursive: true, mode: 0o700 });
  await assertSafeDirectoryTree(basePath);
  const processCache = path.join(basePath, `process-${process.pid}-${randomUUID()}`);
  await fs.mkdir(processCache, { mode: 0o700 });
  await assertSafeDirectoryTree(processCache);
  const bootstrapRootPath = path.join(processCache, "bootstrap-root.json");
  const handle = await fs.open(
    bootstrapRootPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(bootstrapRootBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const onlineCache = {
    cachePath: processCache,
    bootstrapRootPath,
    bootstrapRootSha256: PINNED_SIGSTORE_TUF_BOOTSTRAP_ROOT_SHA256,
  };
  await assertPinnedBootstrapRoot(onlineCache);
  return onlineCache;
}

async function cleanupAbandonedOnlineCache(cachePath: string, basePath?: string): Promise<void> {
  if (!basePath || !isStrictPathDescendant(basePath, cachePath)) return;
  try {
    await assertSafeDirectoryTree(cachePath);
    await assertSafeDirectorySubtree(cachePath);
    await fs.rm(cachePath, { recursive: true, force: true });
  } catch {
    // A replaced/unsafe quarantine is left isolated for operator cleanup.
  }
}

async function assertSafeDirectorySubtree(directoryPath: string): Promise<void> {
  for (const entry of await fs.readdir(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error("Sigstore abandoned cache contains a link or reparse point.");
    }
    if (stats.isDirectory()) {
      await assertSafeDirectory(entryPath, false);
      await assertSafeDirectorySubtree(entryPath);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error("Sigstore abandoned cache contains an unsupported filesystem entry.");
    }
  }
}

async function assertPinnedBootstrapRoot(cache: OnlineTufCache): Promise<void> {
  await assertSafeDirectoryTree(path.dirname(cache.bootstrapRootPath));
  const before = await fs.lstat(cache.bootstrapRootPath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size <= 0 ||
    before.size > MAX_SIGSTORE_TUF_SEEDS_BYTES
  ) {
    throw new Error("Sigstore TUF bootstrap root is unsafe.");
  }
  const canonicalPath = await fs.realpath(cache.bootstrapRootPath);
  if (!sameCanonicalPath(canonicalPath, cache.bootstrapRootPath)) {
    throw new Error("Sigstore TUF bootstrap root is canonically redirected.");
  }
  const bytes = await fs.readFile(cache.bootstrapRootPath);
  const after = await fs.lstat(cache.bootstrapRootPath);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    createHash("sha256").update(bytes).digest("hex") !== cache.bootstrapRootSha256
  ) {
    throw new Error("Sigstore TUF bootstrap root changed or failed its immutable digest.");
  }
}

async function assertSafeExistingAncestors(targetPath: string): Promise<void> {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  await assertSafeDirectory(cursor, true);
  const relative = path.relative(parsed.root, resolved);
  for (const segment of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, segment);
    try {
      await assertSafeDirectory(cursor, false);
    } catch (error) {
      if (isMissingError(error)) return;
      throw error;
    }
  }
}

async function assertSafeDirectoryTree(targetPath: string): Promise<void> {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  await assertSafeDirectory(cursor, true);
  const relative = path.relative(parsed.root, resolved);
  for (const segment of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, segment);
    await assertSafeDirectory(cursor, false);
  }
}

async function assertSafeDirectory(directoryPath: string, filesystemRoot: boolean): Promise<void> {
  const stats = await fs.lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Sigstore mutable cache path traverses a link, reparse point, or non-directory.");
  }
  if (!filesystemRoot) {
    const canonical = await fs.realpath(directoryPath);
    if (!sameCanonicalPath(canonical, path.resolve(directoryPath))) {
      throw new Error("Sigstore mutable cache path is canonically redirected.");
    }
  }
}

function normalizeInvalidVerification(
  error: unknown,
  verificationResult?: SigstoreVerificationResult,
): SigstoreVerificationInvalidError {
  if (error instanceof SigstoreVerificationInvalidError && !verificationResult) return error;
  return new SigstoreVerificationInvalidError(undefined, {
    cause: error,
    verificationResult:
      verificationResult ?? (error instanceof SigstoreVerificationInvalidError ? error.verificationResult : undefined),
  });
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.normalize(path.resolve(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function isStrictPathDescendant(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return Boolean(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepFreezeJson<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return Object.freeze(value);
}

function isMissingError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR"),
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Runtime release trust verification aborted.");
  }
}
