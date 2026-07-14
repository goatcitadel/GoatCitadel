import { createHmac, createPrivateKey, createSign, randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BoundedResponseReadError, readBoundedResponseText } from "./bounded-response-reader.js";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const METADATA_ROOT = "http://169.254.169.254/computeMetadata/v1";
const MAX_CREDENTIAL_BYTES = 128 * 1024;
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_ACCESS_TOKEN_CHARS = 32 * 1024;
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const METADATA_AUTH_TIMEOUT_MS = 1_500;
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
const READINESS_SUCCESS_TTL_MS = 30_000;
const READINESS_FAILURE_TTL_MS = 5_000;

export type GoogleCloudCredentialMode = "service-account" | "adc";
export type GoogleCloudCredentialType = "service_account" | "adc";
export type GoogleCloudCredentialSource = "keychain" | "env" | "adc_file" | "metadata";

export interface GoogleCloudAuthRequest {
  providerId: string;
  credentialMode: GoogleCloudCredentialMode;
  /** Service-account JSON supplied by the Gateway secret owner, never provider config or a public route. */
  serviceAccountJson?: string;
  serviceAccountSource?: "keychain" | "env";
  projectId?: string;
  location?: string;
  endpointId?: string;
}

export interface GoogleCloudAuthResolution {
  accessToken: string;
  expiresAt: string;
  projectId: string;
  location: string;
  endpointId: string;
  baseUrl: string;
  credentialType: GoogleCloudCredentialType;
  credentialSource: GoogleCloudCredentialSource;
}

export interface GoogleCloudCredentialReadiness {
  status: "configured" | "ready" | "missing" | "invalid" | "unknown" | "unavailable";
  source: GoogleCloudCredentialSource | "none";
  liveVerified: boolean;
  reasonCode: string;
  credentialKind?: "service_account" | "authorized_user" | "attached_service_account";
}

export interface GoogleCloudAuthServiceOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  homedir?: () => string;
  platform?: NodeJS.Platform;
}

interface CachedGoogleToken extends GoogleCloudAuthResolution {
  providerId: string;
  cacheIdentity: string;
}

interface ServiceAccountCredential {
  type: "service_account";
  project_id?: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface AuthorizedUserCredential {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
  quota_project_id?: string;
}

type SupportedGoogleCredential = ServiceAccountCredential | AuthorizedUserCredential;

interface AdcCredentialSnapshot {
  credential: SupportedGoogleCredential;
  cacheIdentity: string;
}

interface GoogleCloudReadinessCacheEntry {
  identity: string;
  readiness: GoogleCloudCredentialReadiness;
  expiresAtMs: number;
}

interface GoogleCloudCredentialInspection {
  providerId: string;
  location: string;
  endpointId: string;
  source: GoogleCloudCredentialReadiness["source"];
  credentialKind: NonNullable<GoogleCloudCredentialReadiness["credentialKind"]>;
  cacheIdentity: string;
  credential?: SupportedGoogleCredential;
  adcSnapshot?: AdcCredentialSnapshot;
}

class GoogleCloudAuthAttemptError extends Error {
  public constructor(
    public readonly original: unknown,
    public readonly inspection: GoogleCloudCredentialInspection,
  ) {
    super("Google Cloud credential resolution attempt failed.");
    this.name = "GoogleCloudAuthAttemptError";
  }
}

/**
 * Gateway-owned Google Cloud credential resolver.
 *
 * The implementation deliberately supports only credential shapes that can be
 * verified without executing external helpers or following credential-supplied
 * URLs: service-account JWT exchange, authorized-user ADC refresh, and the
 * fixed Compute metadata endpoint. Workload/external-account ADC fails closed.
 */
export class GoogleCloudAuthService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly homedir: () => string;
  private readonly platform: NodeJS.Platform;
  private readonly credentialFingerprintKey = randomBytes(32);
  private readonly cache = new Map<string, CachedGoogleToken>();
  private readonly readiness = new Map<string, GoogleCloudReadinessCacheEntry>();

  public constructor(options: GoogleCloudAuthServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.homedir = options.homedir ?? os.homedir;
    this.platform = options.platform ?? process.platform;
  }

  public invalidate(providerId?: string): void {
    const normalized = providerId?.trim().toLowerCase();
    if (!normalized) {
      this.cache.clear();
      this.readiness.clear();
      return;
    }
    this.cache.delete(normalized);
    this.readiness.delete(normalized);
  }

  public async resolve(request: GoogleCloudAuthRequest): Promise<GoogleCloudAuthResolution> {
    try {
      const attempt = await this.resolveCredential(request);
      const resolved = attempt.resolution;
      this.setReadiness(
        attempt.inspection.providerId,
        attempt.inspection.cacheIdentity,
        {
          status: "ready",
          source: resolved.credentialSource,
          liveVerified: true,
          reasonCode: "credential_resolved",
          credentialKind: attempt.inspection.credentialKind,
        },
        Math.min(READINESS_SUCCESS_TTL_MS, Math.max(0, Date.parse(resolved.expiresAt) - this.now())),
      );
      return resolved;
    } catch (error) {
      if (error instanceof GoogleCloudAuthAttemptError) {
        this.setReadiness(
          error.inspection.providerId,
          error.inspection.cacheIdentity,
          readinessFromError(error.original, error.inspection.source, error.inspection.credentialKind),
          READINESS_FAILURE_TTL_MS,
        );
        throw error.original;
      }
      throw error;
    }
  }

  /**
   * Synchronous, secret-free configuration inspection for route admission.
   * It never exchanges or refreshes a token. Metadata ADC is ready only after
   * a prior successful live resolution; an unprobed metadata chain stays unknown.
   */
  public inspectReadiness(request: GoogleCloudAuthRequest): GoogleCloudCredentialReadiness {
    try {
      const inspection = this.inspectCredentialSource(request);
      const cached = this.getReadiness(inspection.providerId, inspection.cacheIdentity);
      if (cached) return cached;
      if (inspection.source === "metadata") {
        return {
          status: "unknown",
          source: "metadata",
          liveVerified: false,
          reasonCode: "metadata_not_probed",
          credentialKind: "attached_service_account",
        };
      }
      return {
        status: "configured",
        source: inspection.source,
        liveVerified: false,
        reasonCode: request.credentialMode === "adc" ? "adc_file_configured" : "service_account_configured",
        credentialKind: inspection.credentialKind,
      };
    } catch (error) {
      const adcPath =
        request.credentialMode === "adc"
          ? resolveAdcCredentialPath(this.env, this.homedir(), this.platform)
          : undefined;
      return readinessFromError(error, adcPath ? "adc_file" : (request.serviceAccountSource ?? "none"));
    }
  }

  private setReadiness(
    providerId: string,
    identity: string,
    readiness: GoogleCloudCredentialReadiness,
    ttlMs: number,
  ): void {
    if (ttlMs <= 0) {
      this.readiness.delete(providerId);
      return;
    }
    this.readiness.set(providerId, { identity, readiness, expiresAtMs: this.now() + ttlMs });
  }

  private getReadiness(providerId: string, identity: string): GoogleCloudCredentialReadiness | undefined {
    const cached = this.readiness.get(providerId);
    if (!cached) return undefined;
    if (cached.identity !== identity || cached.expiresAtMs <= this.now()) {
      this.readiness.delete(providerId);
      return undefined;
    }
    return cached.readiness;
  }

  private inspectCredentialSource(request: GoogleCloudAuthRequest): GoogleCloudCredentialInspection {
    if (request.credentialMode !== "service-account" && request.credentialMode !== "adc") {
      throw googleAuthError("invalid_credential_mode", "Google Cloud credential mode is not supported.");
    }
    if (
      request.serviceAccountSource !== undefined &&
      request.serviceAccountSource !== "keychain" &&
      request.serviceAccountSource !== "env"
    ) {
      throw googleAuthError("invalid_credential_source", "Google Cloud service-account source is not supported.");
    }
    const providerId = requireBoundedIdentifier("providerId", request.providerId, 128).toLowerCase();
    const location = normalizeVertexLocation(request.location ?? this.env.GOOGLE_CLOUD_LOCATION ?? "us-central1");
    const endpointId = normalizeVertexEndpointId(request.endpointId ?? "openapi");
    if (request.credentialMode === "service-account") {
      if (!request.serviceAccountJson?.trim()) {
        throw googleAuthError("missing_service_account_secret", "Vertex AI service-account credentials are missing.");
      }
      const credential = parseCredentialJson(request.serviceAccountJson, "provider secret");
      if (credential.type !== "service_account") {
        throw googleAuthError(
          "invalid_service_account_secret",
          "Vertex AI service-account mode requires a service_account credential JSON document.",
        );
      }
      validateServiceAccountCredential(credential);
      normalizeGoogleTokenUrl(credential.token_uri);
      resolveProjectId(request.projectId, credential.project_id, this.env);
      const source = request.serviceAccountSource ?? "none";
      return {
        providerId,
        location,
        endpointId,
        source,
        credentialKind: "service_account",
        credential,
        cacheIdentity: this.buildCredentialCacheIdentity(
          request,
          source,
          fingerprintCredential(request.serviceAccountJson, this.credentialFingerprintKey),
          location,
          endpointId,
        ),
      };
    }

    const adcCredentialPath = resolveAdcCredentialPath(this.env, this.homedir(), this.platform);
    const adcSnapshot = adcCredentialPath
      ? readCredentialFileSnapshot(adcCredentialPath, this.credentialFingerprintKey)
      : undefined;
    if (!adcSnapshot) {
      return {
        providerId,
        location,
        endpointId,
        source: "metadata",
        credentialKind: "attached_service_account",
        cacheIdentity: this.buildCredentialCacheIdentity(request, "metadata", "metadata", location, endpointId),
      };
    }
    if (adcSnapshot.credential.type === "service_account") {
      validateServiceAccountCredential(adcSnapshot.credential);
      normalizeGoogleTokenUrl(adcSnapshot.credential.token_uri);
      resolveProjectId(request.projectId, adcSnapshot.credential.project_id, this.env);
    } else {
      resolveProjectId(request.projectId, adcSnapshot.credential.quota_project_id, this.env);
    }
    return {
      providerId,
      location,
      endpointId,
      source: "adc_file",
      credentialKind: adcSnapshot.credential.type,
      credential: adcSnapshot.credential,
      adcSnapshot,
      cacheIdentity: this.buildCredentialCacheIdentity(
        request,
        "adc_file",
        adcSnapshot.cacheIdentity,
        location,
        endpointId,
      ),
    };
  }

  private buildCredentialCacheIdentity(
    request: GoogleCloudAuthRequest,
    source: GoogleCloudCredentialReadiness["source"],
    credentialIdentity: string,
    location: string,
    endpointId: string,
  ): string {
    return fingerprintCredential(
      JSON.stringify([
        request.credentialMode,
        source,
        credentialIdentity,
        location,
        endpointId,
        request.projectId?.trim() ?? "",
        this.env.GOOGLE_CLOUD_PROJECT?.trim() ?? "",
        this.env.GCLOUD_PROJECT?.trim() ?? "",
      ]),
      this.credentialFingerprintKey,
    );
  }

  private async resolveCredential(request: GoogleCloudAuthRequest): Promise<{
    resolution: GoogleCloudAuthResolution;
    inspection: GoogleCloudCredentialInspection;
  }> {
    const inspection = this.inspectCredentialSource(request);
    const { providerId, location, endpointId, cacheIdentity } = inspection;
    const cached = this.cache.get(providerId);
    if (
      cached &&
      cached.cacheIdentity === cacheIdentity &&
      Date.parse(cached.expiresAt) - this.now() > TOKEN_REFRESH_SKEW_MS
    ) {
      return { resolution: stripCacheFields(cached), inspection };
    }

    try {
      const resolved =
        request.credentialMode === "service-account"
          ? await this.resolveServiceAccount(request, location, endpointId, inspection.credential)
          : await this.resolveApplicationDefault(request, location, endpointId, inspection.adcSnapshot);
      this.cache.set(providerId, { ...resolved, providerId, cacheIdentity });
      return { resolution: resolved, inspection };
    } catch (error) {
      throw new GoogleCloudAuthAttemptError(error, inspection);
    }
  }

  private async resolveServiceAccount(
    request: GoogleCloudAuthRequest,
    location: string,
    endpointId: string,
    inspectedCredential?: SupportedGoogleCredential,
  ): Promise<GoogleCloudAuthResolution> {
    if (!request.serviceAccountJson?.trim()) {
      throw googleAuthError(
        "missing_service_account_secret",
        "Vertex AI service-account mode requires credentials stored through the Gateway provider-secret owner.",
      );
    }
    const credential = inspectedCredential ?? parseCredentialJson(request.serviceAccountJson, "provider secret");
    if (credential.type !== "service_account") {
      throw googleAuthError(
        "invalid_service_account_secret",
        "Vertex AI service-account mode requires a service_account credential JSON document.",
      );
    }
    const projectId = resolveProjectId(request.projectId, credential.project_id, this.env);
    const token = await this.exchangeServiceAccountJwt(credential);
    return buildResolution({
      token,
      nowMs: this.now(),
      projectId,
      location,
      endpointId,
      credentialType: "service_account",
      credentialSource: request.serviceAccountSource ?? "keychain",
    });
  }

  private async resolveApplicationDefault(
    request: GoogleCloudAuthRequest,
    location: string,
    endpointId: string,
    adcSnapshot: AdcCredentialSnapshot | undefined,
  ): Promise<GoogleCloudAuthResolution> {
    if (adcSnapshot) {
      const credential = adcSnapshot.credential;
      if (credential.type === "service_account") {
        const projectId = resolveProjectId(request.projectId, credential.project_id, this.env);
        const token = await this.exchangeServiceAccountJwt(credential);
        return buildResolution({
          token,
          nowMs: this.now(),
          projectId,
          location,
          endpointId,
          credentialType: "adc",
          credentialSource: "adc_file",
        });
      }
      const projectId = resolveProjectId(request.projectId, credential.quota_project_id, this.env);
      const token = await this.refreshAuthorizedUser(credential);
      return buildResolution({
        token,
        nowMs: this.now(),
        projectId,
        location,
        endpointId,
        credentialType: "adc",
        credentialSource: "adc_file",
      });
    }

    const metadataProjectId = request.projectId?.trim() || (await this.readMetadataProjectId());
    const projectId = normalizeProjectId(metadataProjectId);
    const token = await this.readMetadataAccessToken();
    return buildResolution({
      token,
      nowMs: this.now(),
      projectId,
      location,
      endpointId,
      credentialType: "adc",
      credentialSource: "metadata",
    });
  }

  private async exchangeServiceAccountJwt(credential: ServiceAccountCredential): Promise<GoogleToken> {
    const tokenUrl = normalizeGoogleTokenUrl(credential.token_uri);
    const nowSeconds = Math.floor(this.now() / 1000);
    const encodedHeader = base64UrlJson({ alg: "RS256", typ: "JWT" });
    const encodedClaims = base64UrlJson({
      iss: requireBoundedText("service account client_email", credential.client_email, 320),
      scope: CLOUD_PLATFORM_SCOPE,
      aud: tokenUrl,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    });
    const signingInput = `${encodedHeader}.${encodedClaims}`;
    let signature: string;
    try {
      const signer = createSign("RSA-SHA256");
      signer.update(signingInput);
      signer.end();
      signature = signer.sign(credential.private_key, "base64url");
    } catch (error) {
      throw googleAuthError(
        "invalid_service_account_key",
        "The Vertex AI service-account private key is invalid.",
        error,
      );
    }
    return await this.postTokenForm(
      tokenUrl,
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${signingInput}.${signature}`,
      }),
    );
  }

  private async refreshAuthorizedUser(credential: AuthorizedUserCredential): Promise<GoogleToken> {
    return await this.postTokenForm(
      GOOGLE_OAUTH_TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: requireBoundedText("authorized-user client_id", credential.client_id, 1024),
        client_secret: requireBoundedText("authorized-user client_secret", credential.client_secret, 1024),
        refresh_token: requireBoundedText("authorized-user refresh_token", credential.refresh_token, 8192),
      }),
    );
  }

  private async postTokenForm(url: string, body: URLSearchParams): Promise<GoogleToken> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetchImpl,
        url,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          redirect: "error",
        },
        DEFAULT_AUTH_TIMEOUT_MS,
      );
    } catch (error) {
      throw googleAuthError(
        "token_exchange_unavailable",
        "Google OAuth token exchange was temporarily unavailable.",
        error,
      );
    }
    const raw = await readBoundedResponse(response, MAX_AUTH_RESPONSE_BYTES, DEFAULT_AUTH_TIMEOUT_MS);
    if (!response.ok) {
      const transient = response.status === 408 || response.status === 429 || response.status >= 500;
      throw googleAuthError(
        transient ? "token_exchange_unavailable" : "token_exchange_failed",
        `Google OAuth token exchange failed (${response.status}).`,
      );
    }
    const payload = parseJsonRecord(raw, "Google OAuth token response");
    return parseGoogleToken(payload);
  }

  private async readMetadataProjectId(): Promise<string> {
    const response = await this.metadataFetch(`${METADATA_ROOT}/project/project-id`);
    const projectId = (await readBoundedResponse(response, 1024, METADATA_AUTH_TIMEOUT_MS)).trim();
    if (!response.ok || !projectId) {
      throw googleAuthError("adc_unavailable", "Google Cloud metadata did not provide a project id.");
    }
    return projectId;
  }

  private async readMetadataAccessToken(): Promise<GoogleToken> {
    const response = await this.metadataFetch(`${METADATA_ROOT}/instance/service-accounts/default/token`);
    const raw = await readBoundedResponse(response, MAX_AUTH_RESPONSE_BYTES, METADATA_AUTH_TIMEOUT_MS);
    if (!response.ok) {
      throw googleAuthError("adc_unavailable", `Google Cloud metadata token request failed (${response.status}).`);
    }
    return parseGoogleToken(parseJsonRecord(raw, "Google Cloud metadata token response"));
  }

  private async metadataFetch(url: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.fetchImpl,
        url,
        {
          method: "GET",
          headers: { "metadata-flavor": "Google" },
          redirect: "error",
        },
        METADATA_AUTH_TIMEOUT_MS,
      );
    } catch (error) {
      throw googleAuthError(
        "adc_unavailable",
        "Application Default Credentials were not found in a supported file and the attached-service-account metadata endpoint was unavailable.",
        error,
      );
    }
    if (response.headers.get("metadata-flavor")?.toLowerCase() !== "google") {
      throw googleAuthError(
        "invalid_metadata_response",
        "Google Cloud metadata response identity could not be verified.",
      );
    }
    return response;
  }
}

interface GoogleToken {
  accessToken: string;
  expiresInSeconds: number;
}

function buildResolution(input: {
  token: GoogleToken;
  nowMs: number;
  projectId: string;
  location: string;
  endpointId: string;
  credentialType: GoogleCloudCredentialType;
  credentialSource: GoogleCloudCredentialSource;
}): GoogleCloudAuthResolution {
  const expiresAt = new Date(input.nowMs + input.token.expiresInSeconds * 1000).toISOString();
  return {
    accessToken: input.token.accessToken,
    expiresAt,
    projectId: input.projectId,
    location: input.location,
    endpointId: input.endpointId,
    baseUrl: buildVertexOpenAiBaseUrl(input.projectId, input.location, input.endpointId),
    credentialType: input.credentialType,
    credentialSource: input.credentialSource,
  };
}

export function buildVertexOpenAiBaseUrl(projectId: string, location: string, endpointId = "openapi"): string {
  const normalizedProjectId = normalizeProjectId(projectId);
  const normalizedLocation = normalizeVertexLocation(location);
  const normalizedEndpointId = normalizeVertexEndpointId(endpointId);
  return (
    `https://${normalizedLocation}-aiplatform.googleapis.com/v1/projects/` +
    `${encodeURIComponent(normalizedProjectId)}/locations/${encodeURIComponent(normalizedLocation)}/` +
    `endpoints/${encodeURIComponent(normalizedEndpointId)}`
  );
}

function stripCacheFields(cached: CachedGoogleToken): GoogleCloudAuthResolution {
  const { providerId: _providerId, cacheIdentity: _cacheIdentity, ...resolution } = cached;
  return resolution;
}

function resolveAdcCredentialPath(
  env: NodeJS.ProcessEnv,
  homedir: string,
  platform: NodeJS.Platform,
): string | undefined {
  const explicit = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (explicit) return path.resolve(explicit);
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    const candidate = appData ? path.join(appData, "gcloud", "application_default_credentials.json") : undefined;
    return candidate && existsSync(candidate) ? candidate : undefined;
  }
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(homedir, ".config");
  const candidate = path.join(configHome, "gcloud", "application_default_credentials.json");
  return existsSync(candidate) ? candidate : undefined;
}

function readCredentialFileSnapshot(credentialPath: string, fingerprintKey: Buffer): AdcCredentialSnapshot {
  let fd: number | undefined;
  try {
    fd = openSync(credentialPath, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw googleAuthError("invalid_adc_file", "The Application Default Credentials path is not a regular file.");
    }
    if (stat.size <= 0 || stat.size > MAX_CREDENTIAL_BYTES) {
      throw googleAuthError(
        "invalid_adc_file",
        `The Application Default Credentials file must be between 1 and ${MAX_CREDENTIAL_BYTES} bytes.`,
      );
    }
    const raw = readFileSync(fd, "utf8");
    return {
      credential: parseCredentialJson(raw, "Application Default Credentials file"),
      cacheIdentity: fingerprintCredential(
        JSON.stringify([
          path.resolve(credentialPath),
          stat.dev,
          stat.ino,
          stat.mode,
          stat.size,
          stat.mtimeMs,
          stat.ctimeMs,
          fingerprintCredential(raw, fingerprintKey),
        ]),
        fingerprintKey,
      ),
    };
  } catch (error) {
    if (isGoogleCloudAuthError(error)) throw error;
    throw googleAuthError("adc_unavailable", "Application Default Credentials could not be read.", error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseCredentialJson(raw: string, source: string): SupportedGoogleCredential {
  if (Buffer.byteLength(raw, "utf8") > MAX_CREDENTIAL_BYTES) {
    throw googleAuthError("invalid_credential_json", `${source} exceeds the credential size limit.`);
  }
  const payload = parseJsonRecord(raw, source);
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type === "external_account" || type === "external_account_authorized_user") {
    throw googleAuthError(
      "unsupported_external_account",
      "External-account and workload-identity ADC require the official Google authentication library and are not enabled in this dependency-free runtime.",
    );
  }
  if (type === "service_account") {
    const clientEmail = requireBoundedText(
      "service account client_email",
      readRequiredString(payload, "client_email", source),
      320,
    );
    const privateKey = requireBoundedText(
      "service account private_key",
      readRequiredString(payload, "private_key", source),
      MAX_CREDENTIAL_BYTES,
    );
    return {
      type,
      client_email: clientEmail,
      private_key: privateKey,
      ...(typeof payload.project_id === "string" ? { project_id: payload.project_id } : {}),
      ...(typeof payload.token_uri === "string" ? { token_uri: payload.token_uri } : {}),
    };
  }
  if (type === "authorized_user") {
    return {
      type,
      client_id: requireBoundedText(
        "authorized-user client_id",
        readRequiredString(payload, "client_id", source),
        1024,
      ),
      client_secret: requireBoundedText(
        "authorized-user client_secret",
        readRequiredString(payload, "client_secret", source),
        1024,
      ),
      refresh_token: requireBoundedText(
        "authorized-user refresh_token",
        readRequiredString(payload, "refresh_token", source),
        8192,
      ),
      ...(typeof payload.quota_project_id === "string" ? { quota_project_id: payload.quota_project_id } : {}),
    };
  }
  throw googleAuthError(
    "unsupported_adc_credential",
    `${source} must contain a service_account or authorized_user credential.`,
  );
}

function validateServiceAccountCredential(credential: ServiceAccountCredential): void {
  try {
    const key = createPrivateKey(credential.private_key);
    if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "rsa-pss") {
      throw new Error("not an RSA key");
    }
  } catch (error) {
    throw googleAuthError(
      "invalid_service_account_key",
      "The Vertex AI service-account private key is invalid.",
      error,
    );
  }
}

function resolveProjectId(
  configured: string | undefined,
  credentialProjectId: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const value =
    configured?.trim() || env.GOOGLE_CLOUD_PROJECT?.trim() || env.GCLOUD_PROJECT?.trim() || credentialProjectId?.trim();
  if (!value) {
    throw googleAuthError(
      "missing_project_id",
      "Vertex AI requires a project id in provider config, GOOGLE_CLOUD_PROJECT, or the Google credential.",
    );
  }
  return normalizeProjectId(value);
}

function normalizeProjectId(value: string): string {
  const normalized = requireBoundedIdentifier("Google Cloud project id", value, 128).toLowerCase();
  if (!/^[a-z0-9][a-z0-9.:-]{0,126}[a-z0-9]$/u.test(normalized) && !/^[a-z0-9]$/u.test(normalized)) {
    throw googleAuthError("invalid_project_id", "Google Cloud project id contains unsupported characters.");
  }
  return normalized;
}

function normalizeVertexLocation(value: string): string {
  const normalized = requireBoundedIdentifier("Vertex AI location", value, 64).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized)) {
    throw googleAuthError("invalid_location", "Vertex AI location contains unsupported characters.");
  }
  return normalized;
}

function normalizeVertexEndpointId(value: string): string {
  const normalized = requireBoundedIdentifier("Vertex AI endpoint id", value, 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(normalized)) {
    throw googleAuthError("invalid_endpoint_id", "Vertex AI endpoint id contains unsupported characters.");
  }
  return normalized;
}

function normalizeGoogleTokenUrl(value: string | undefined): string {
  const normalized = value?.trim() || GOOGLE_OAUTH_TOKEN_URL;
  if (normalized !== GOOGLE_OAUTH_TOKEN_URL) {
    throw googleAuthError(
      "untrusted_token_uri",
      "Google service-account token_uri must be the canonical oauth2.googleapis.com endpoint.",
    );
  }
  return normalized;
}

function parseGoogleToken(payload: Record<string, unknown>): GoogleToken {
  const accessToken = requireBoundedText(
    "Google access token",
    readRequiredString(payload, "access_token", "Google token response"),
    MAX_ACCESS_TOKEN_CHARS,
  );
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 86_400) {
    throw googleAuthError("invalid_token_response", "Google token response contained an invalid expiry.");
  }
  return { accessToken, expiresInSeconds: Math.trunc(expiresIn) };
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Google authentication request timed out.")), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponse(response: Response, maxBytes: number, timeoutMs: number): Promise<string> {
  try {
    return await readBoundedResponseText(response, {
      maxBytes,
      timeoutMs,
      label: "Google authentication",
    });
  } catch (error) {
    if (error instanceof BoundedResponseReadError) {
      if (error.code === "body_limit") {
        throw googleAuthError("auth_response_too_large", "Google authentication response exceeded its size limit.");
      }
      if (error.code === "body_timeout") {
        throw googleAuthError("auth_response_timeout", "Google authentication response body timed out.");
      }
    }
    throw googleAuthError("auth_response_read_failed", "Google authentication response could not be read.");
  }
}

function parseJsonRecord(raw: string, source: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw googleAuthError("invalid_json", `${source} is not a valid JSON object.`, error);
  }
}

function readRequiredString(payload: Record<string, unknown>, key: string, source: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw googleAuthError("missing_credential_field", `${source} is missing ${key}.`);
  }
  return value;
}

function requireBoundedText(label: string, value: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw googleAuthError("invalid_credential_field", `${label} must be between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function requireBoundedIdentifier(label: string, value: string, maxLength: number): string {
  return requireBoundedText(label, value, maxLength);
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function fingerprintCredential(value: string, key: Buffer): string {
  return createHmac("sha256", key).update(value, "utf8").digest("base64url");
}

function readinessFromError(
  error: unknown,
  source: GoogleCloudCredentialReadiness["source"],
  credentialKind?: GoogleCloudCredentialReadiness["credentialKind"],
): GoogleCloudCredentialReadiness {
  const reasonCode = isGoogleCloudAuthError(error) ? error.code : "credential_inspection_failed";
  const missing =
    reasonCode === "missing_service_account_secret" || (source === "adc_file" && reasonCode === "adc_unavailable");
  const metadataUnavailable = source === "metadata";
  const transient = new Set([
    "token_exchange_unavailable",
    "auth_response_timeout",
    "auth_response_read_failed",
    "auth_response_too_large",
  ]).has(reasonCode);
  return {
    status: missing ? "missing" : metadataUnavailable || transient ? "unavailable" : "invalid",
    source,
    liveVerified: false,
    reasonCode,
    ...(credentialKind
      ? { credentialKind }
      : source === "metadata"
        ? { credentialKind: "attached_service_account" as const }
        : {}),
  };
}

export class GoogleCloudAuthError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GoogleCloudAuthError";
    this.code = code;
  }
}

function googleAuthError(code: string, message: string, cause?: unknown): GoogleCloudAuthError {
  return new GoogleCloudAuthError(code, message, cause === undefined ? undefined : { cause });
}

function isGoogleCloudAuthError(error: unknown): error is GoogleCloudAuthError {
  return error instanceof GoogleCloudAuthError;
}
