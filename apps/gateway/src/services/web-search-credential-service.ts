import {
  ExternalServiceError,
  ValidationError,
  isWebSearchCredentialTargetId,
  type FirecrawlConnectionCheck,
  type ResearchSearchOfficialProvider,
  type WebSearchCredentialStatus,
  type WebSearchCredentialTargetId,
} from "@goatcitadel/contracts";
import {
  fetchAllowlisted,
  getOfficialSearchCredentialEnvAliases,
  isHostAllowed,
  normalizeFirecrawlApiKeyEnvName,
} from "@goatcitadel/policy-engine";
import type { FirecrawlRuntimeConfig } from "../config.js";
import { isFirecrawlBaseUrlAllowlisted } from "./runtime-browser-backend-defaults.js";
import { describeOfficialSearchTarget, runtimeConfigurationAccount } from "./runtime-configuration-service.js";
import { readBoundedResponseJson } from "./bounded-response-reader.js";
import type { SecretStoreService } from "./secret-store-service.js";

const MAX_SECRET_LENGTH = 8_192;
const FIRECRAWL_PROBE_PATH = "/v2/team/credit-usage";
/**
 * Asked when the credit probe is neither accepted nor rejected. A self-hosted server has no billing data, so
 * its credit route fails, but this team-scoped route still goes through the same key check.
 */
const FIRECRAWL_FALLBACK_PROBE_PATH = "/v2/team/queue-status";
const FIRECRAWL_PROBE_TIMEOUT_MS = 10_000;
const FIRECRAWL_ACCOUNT_SUFFIX = "search.firecrawl";
const FIRECRAWL_ACQUISITION_URL = "https://www.firecrawl.dev/app/api-keys";
const CANONICAL_LOCAL_FIRECRAWL_HOSTS = ["127.0.0.1:3002", "localhost:3002"];

type OfficialTargetId = Exclude<WebSearchCredentialTargetId, "search.firecrawl">;

export interface WebSearchCredentialServiceOptions {
  readonly secretStore: Pick<SecretStoreService, "isAvailable" | "getSecret" | "setSecret" | "deleteSecret">;
  readonly installationScopeId: string;
  readonly getNetworkAllowlist: () => readonly string[];
  readonly getFirecrawlConfig: () => FirecrawlRuntimeConfig;
  /** Live probe for Brave and Parallel; reuses the Chat configuration probe. */
  readonly probeOfficial: (
    provider: ResearchSearchOfficialProvider,
    secret: string,
    networkAllowlist: readonly string[],
  ) => Promise<{ ok: boolean; status?: string; httpStatus?: number }>;
  /**
   * Runs a Brave or Parallel keychain change under the Chat owner's target lock and fences
   * (keychain, allowlist, deployment profile, preparing, pending settlement, durable reservation).
   */
  readonly withOfficialTargetChange: <T>(
    targetId: OfficialTargetId,
    work: () => Promise<T>,
    options: { action: "store" | "remove" },
  ) => Promise<T>;
  readonly appendAudit?: (payload: Record<string, unknown>) => Promise<void>;
  /** Called when the keychain changed but its audit record could not be written. */
  readonly reportAuditFailure?: (event: string, targetId: WebSearchCredentialTargetId, error: unknown) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetchAllowlisted;
  readonly now?: () => Date;
}

/**
 * Settings owner for web-search API keys. Keys are live-checked, stored only in the OS keychain
 * under the same installation accounts the Chat `runtime.configure` flow uses, and never
 * returned: status, audit, and errors carry presence and source only.
 */
export class WebSearchCredentialService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetchAllowlisted;
  private readonly now: () => Date;
  private readonly targetLocks = new Map<WebSearchCredentialTargetId, Promise<void>>();

  public constructor(private readonly options: WebSearchCredentialServiceOptions) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetchAllowlisted;
    this.now = options.now ?? (() => new Date());
  }

  public listStatuses(): WebSearchCredentialStatus[] {
    return (["search.firecrawl", "search.brave", "search.parallel"] as const).map((targetId) => this.status(targetId));
  }

  public status(targetId: WebSearchCredentialTargetId): WebSearchCredentialStatus {
    const keychainAvailable = this.keychainAvailable();
    const keychainConfigured = keychainAvailable && Boolean(this.readKeychain(targetId));
    const envNames = this.envNames(targetId);
    const envConfigured = envNames.some((name) => Boolean(this.env[name]?.trim()));
    const endpoint = this.endpointFor(targetId);
    return {
      targetId,
      label: this.labelFor(targetId),
      endpointHost: endpoint.host,
      endpointAllowlisted: endpoint.allowlisted,
      keychainAvailable,
      keychainConfigured,
      envNames,
      envConfigured,
      activeSource: keychainConfigured ? "keychain" : envConfigured ? "env" : "none",
      acquisitionUrl:
        targetId === "search.firecrawl"
          ? FIRECRAWL_ACQUISITION_URL
          : describeOfficialSearchTarget(targetId).acquisitionUrl,
    };
  }

  /** Execution-time lookup for browser tools. The environment fallback stays in the policy engine. */
  public async resolveFirecrawlCredential(requestedBaseUrl?: string): Promise<string | undefined> {
    // The saved key belongs to the configured endpoint only; a caller-supplied base URL never receives it.
    if (
      requestedBaseUrl !== undefined &&
      !sameFirecrawlEndpoint(requestedBaseUrl, this.options.getFirecrawlConfig().baseUrl)
    ) {
      return undefined;
    }
    return this.keychainAvailable() ? this.readKeychain("search.firecrawl") : undefined;
  }

  /** Read-only reachability and key check against the configured Firecrawl base URL. */
  public async checkFirecrawl(candidateKey?: string): Promise<FirecrawlConnectionCheck> {
    const firecrawl = this.options.getFirecrawlConfig();
    const baseUrl = firecrawl.baseUrl.replace(/\/+$/u, "");
    const keySource = candidateKey ? "keychain" : this.status("search.firecrawl").activeSource;
    const apiKey = candidateKey ?? (await this.resolveFirecrawlCredential()) ?? this.firecrawlEnvKey();
    const result = (status: FirecrawlConnectionCheck["status"], message: string, extra = {}) => ({
      status,
      baseUrl,
      checkedAt: this.now().toISOString(),
      keySource,
      message,
      ...extra,
    });
    const endpoint = this.endpointFor("search.firecrawl");
    if (!endpoint.allowlisted) {
      return result("blocked", `${endpoint.host} is not in the outbound allowlist, so tools cannot reach it.`);
    }
    const probe = (path: string) =>
      this.fetchImpl(`${baseUrl}${path}`, {
        allowlist: isCanonicalLocalFirecrawlBaseUrl(baseUrl)
          ? CANONICAL_LOCAL_FIRECRAWL_HOSTS
          : [...this.options.getNetworkAllowlist()],
        timeoutMs: Math.min(firecrawl.timeoutMs, FIRECRAWL_PROBE_TIMEOUT_MS),
        init: { method: "GET", headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
      });
    const unauthorized = (httpStatus: number) =>
      result("unauthorized", apiKey ? "Firecrawl rejected the API key." : "Firecrawl needs an API key.", {
        httpStatus,
      });
    let response: Response;
    try {
      response = await probe(FIRECRAWL_PROBE_PATH);
    } catch {
      return result("unreachable", `Nothing answered at ${baseUrl}. Tools fall back to native search when allowed.`);
    }
    if (isKeyRejection(response.status)) {
      return unauthorized(response.status);
    }
    if (response.ok) {
      const remainingCredits = await readRemainingCredits(response);
      return result("ok", "Firecrawl answered and accepted the request.", {
        httpStatus: response.status,
        ...(remainingCredits !== undefined ? { remainingCredits } : {}),
      });
    }
    // The server already answered, so a failed fallback probe leaves the check at "reachable" below.
    const fallback = await probe(FIRECRAWL_FALLBACK_PROBE_PATH).catch(() => undefined);
    if (fallback && isKeyRejection(fallback.status)) {
      return unauthorized(fallback.status);
    }
    if (fallback?.ok) {
      return result("ok", "Firecrawl answered and accepted the request. This server does not report credit usage.", {
        httpStatus: fallback.status,
      });
    }
    return result("reachable", `Firecrawl answered with HTTP ${response.status}; the key could not be confirmed.`, {
      httpStatus: response.status,
    });
  }

  public async store(targetId: WebSearchCredentialTargetId, rawSecret: string): Promise<WebSearchCredentialStatus> {
    const secret = normalizeSecret(rawSecret);
    return await this.withOwnerLocks(targetId, "store", async () => {
      this.assertKeychainAvailable(targetId);
      await this.assertSecretAccepted(targetId, secret);
      try {
        this.options.secretStore.setSecret(this.accountFor(targetId), secret);
      } catch {
        throw new ExternalServiceError(`Could not store the ${this.labelFor(targetId)} key in the OS keychain.`, {
          targetId,
          diagnosticCode: "keychain_write_failed",
        });
      }
      await this.audit("web_search_credential.stored", targetId);
      return this.status(targetId);
    });
  }

  public async clear(targetId: WebSearchCredentialTargetId): Promise<WebSearchCredentialStatus> {
    // Removal never contacts the provider, so it works even after the host leaves the allowlist.
    return await this.withOwnerLocks(targetId, "remove", async () => {
      if (!this.keychainAvailable()) {
        throw new ExternalServiceError("The OS keychain is unavailable.", {
          targetId,
          diagnosticCode: "keychain_unavailable",
        });
      }
      this.options.secretStore.deleteSecret(this.accountFor(targetId));
      await this.audit("web_search_credential.cleared", targetId);
      return this.status(targetId);
    });
  }

  /** Temporary custody between the secure-input step and the confirmed Change Plan apply. */
  public holdTemporary(planId: string, rawSecret: string): void {
    this.options.secretStore.setSecret(temporaryAccount(planId), normalizeSecret(rawSecret));
  }

  public hasTemporary(planId: string): boolean {
    return Boolean(this.options.secretStore.getSecret(temporaryAccount(planId))?.trim());
  }

  public consumeTemporary(planId: string): string {
    const account = temporaryAccount(planId);
    const secret = this.options.secretStore.getSecret(account)?.trim();
    this.options.secretStore.deleteSecret(account);
    if (!secret) throw new ValidationError({ message: "The temporary web-search key is unavailable. Enter it again." });
    return secret;
  }

  public discardTemporary(planId: string): void {
    this.options.secretStore.deleteSecret(temporaryAccount(planId));
  }

  private async assertSecretAccepted(targetId: WebSearchCredentialTargetId, secret: string): Promise<void> {
    if (targetId === "search.firecrawl") {
      const check = await this.checkFirecrawl(secret);
      if (check.status === "ok" || check.status === "reachable") return;
      throw new ExternalServiceError(
        check.status === "unauthorized"
          ? "Firecrawl rejected this API key."
          : `The key was not saved because Firecrawl could not be checked: ${check.message}`,
        { targetId, diagnosticCode: "credential_probe_failed", checkStatus: check.status },
      );
    }
    const target = describeOfficialSearchTarget(targetId);
    const probe = await this.options.probeOfficial(target.provider, secret, this.options.getNetworkAllowlist());
    if (!probe.ok) {
      throw new ExternalServiceError(`${target.targetLabel} rejected the key or did not pass its live check.`, {
        targetId,
        diagnosticCode: "credential_probe_failed",
        ...(probe.status ? { providerStatus: probe.status } : {}),
        ...(probe.httpStatus ? { httpStatus: probe.httpStatus } : {}),
      });
    }
  }

  private assertKeychainAvailable(targetId: WebSearchCredentialTargetId): void {
    if (!this.keychainAvailable()) {
      throw new ExternalServiceError("Saving a web-search key requires an available OS keychain.", {
        targetId,
        diagnosticCode: "keychain_unavailable",
      });
    }
  }

  private keychainAvailable(): boolean {
    try {
      return this.options.secretStore.isAvailable();
    } catch {
      return false;
    }
  }

  private readKeychain(targetId: WebSearchCredentialTargetId): string | undefined {
    try {
      return this.options.secretStore.getSecret(this.accountFor(targetId))?.trim() || undefined;
    } catch {
      // A keychain read failure reports "not configured"; it never leaks into diagnostics.
      return undefined;
    }
  }

  private firecrawlEnvKey(): string | undefined {
    for (const name of this.envNames("search.firecrawl")) {
      const value = this.env[name]?.trim();
      if (value) return value;
    }
    return undefined;
  }

  private envNames(targetId: WebSearchCredentialTargetId): string[] {
    if (targetId === "search.firecrawl") {
      const configured = normalizeFirecrawlApiKeyEnvName(this.options.getFirecrawlConfig().apiKeyEnv);
      return [configured ?? "FIRECRAWL_API_KEY"];
    }
    return [...getOfficialSearchCredentialEnvAliases(describeOfficialSearchTarget(targetId).provider)];
  }

  private endpointFor(targetId: WebSearchCredentialTargetId): { host: string; allowlisted: boolean } {
    const allowlist = [...this.options.getNetworkAllowlist()];
    if (targetId !== "search.firecrawl") {
      const host = describeOfficialSearchTarget(targetId).endpointHost;
      return { host, allowlisted: isHostAllowed(`https://${host}`, allowlist) };
    }
    const baseUrl = this.options.getFirecrawlConfig().baseUrl;
    let host = baseUrl;
    try {
      host = new URL(baseUrl).host;
    } catch {
      return { host, allowlisted: false };
    }
    return { host, allowlisted: isFirecrawlBaseUrlAllowlisted(baseUrl, allowlist) };
  }

  private labelFor(targetId: WebSearchCredentialTargetId): string {
    return targetId === "search.firecrawl" ? "Firecrawl" : describeOfficialSearchTarget(targetId).targetLabel;
  }

  private accountFor(targetId: WebSearchCredentialTargetId): string {
    const suffix =
      targetId === "search.firecrawl" ? FIRECRAWL_ACCOUNT_SUFFIX : describeOfficialSearchTarget(targetId).accountSuffix;
    return runtimeConfigurationAccount(this.options.installationScopeId, suffix);
  }

  /**
   * Runs after the keychain changed, so a failed audit write must not report the change as
   * uncommitted: the owner reports the gap and the committed status stands.
   */
  private async audit(event: string, targetId: WebSearchCredentialTargetId): Promise<void> {
    try {
      await this.options.appendAudit?.({
        event,
        targetId,
        storage: "os_keychain",
        scope: "installation",
        surface: "settings",
        at: this.now().toISOString(),
      });
    } catch (error) {
      this.options.reportAuditFailure?.(event, targetId, error);
    }
  }

  private async withOwnerLocks<T>(
    targetId: WebSearchCredentialTargetId,
    action: "store" | "remove",
    work: () => Promise<T>,
  ): Promise<T> {
    return await this.withTargetLock(targetId, () =>
      targetId === "search.firecrawl" ? work() : this.options.withOfficialTargetChange(targetId, work, { action }),
    );
  }

  private async withTargetLock<T>(targetId: WebSearchCredentialTargetId, work: () => Promise<T>): Promise<T> {
    const previous = this.targetLocks.get(targetId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.targetLocks.set(targetId, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.targetLocks.get(targetId) === tail) this.targetLocks.delete(targetId);
    }
  }
}

export function requireWebSearchCredentialTargetId(value: unknown): WebSearchCredentialTargetId {
  if (!isWebSearchCredentialTargetId(value)) {
    throw new ValidationError({ field: "targetId", message: "Unknown web-search credential target." });
  }
  return value;
}

function temporaryAccount(planId: string): string {
  return `evolution:web-search-credential:${planId}`;
}

function normalizeSecret(value: string): string {
  const secret = value.trim();
  if (!secret) throw new ValidationError({ field: "apiKey", message: "API key must not be empty." });
  if (secret.length > MAX_SECRET_LENGTH)
    throw new ValidationError({ field: "apiKey", message: "API key is too long." });
  return secret;
}

function sameFirecrawlEndpoint(left: string, right: string): boolean {
  const normalize = (value: string) => {
    try {
      const parsed = new URL(value.trim());
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`.toLowerCase();
    } catch {
      return undefined;
    }
  };
  const normalized = normalize(left);
  return normalized !== undefined && normalized === normalize(right);
}

function isCanonicalLocalFirecrawlBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === "3002";
  } catch {
    return false;
  }
}

function isKeyRejection(httpStatus: number): boolean {
  return httpStatus === 401 || httpStatus === 403;
}

async function readRemainingCredits(response: Response): Promise<number | undefined> {
  try {
    const body = await readBoundedResponseJson<{ data?: { remainingCredits?: unknown } }>(response, {
      maxBytes: 64 * 1_024,
      timeoutMs: FIRECRAWL_PROBE_TIMEOUT_MS,
      label: "Firecrawl credit usage response",
    });
    const credits = body?.data?.remainingCredits;
    return typeof credits === "number" && Number.isFinite(credits) ? credits : undefined;
  } catch {
    // Credits are optional detail: an oversized or malformed body leaves the "ok" status unchanged.
    return undefined;
  }
}
