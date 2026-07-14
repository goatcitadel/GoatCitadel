import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVertexOpenAiBaseUrl, GoogleCloudAuthError, GoogleCloudAuthService } from "./google-cloud-auth-service.js";

const NOW = Date.parse("2026-07-13T12:00:00.000Z");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GoogleCloudAuthService", () => {
  it("exchanges a Gateway-owned service account secret for a bounded Vertex bearer token", async () => {
    const credential = serviceAccountCredential();
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://oauth2.googleapis.com/token");
      expect(init?.redirect).toBe("error");
      const form = init?.body as URLSearchParams;
      const assertion = form.get("assertion") ?? "";
      const [header, claims] = assertion.split(".");
      expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"))).toEqual({
        alg: "RS256",
        typ: "JWT",
      });
      expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString("utf8"))).toMatchObject({
        iss: credential.client_email,
        aud: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/cloud-platform",
        iat: NOW / 1000,
        exp: NOW / 1000 + 3600,
      });
      return jsonResponse({ access_token: "ya29.service-account", expires_in: 3600 });
    });
    const service = new GoogleCloudAuthService({ fetch: fetchMock, now: () => NOW, env: {} });

    const resolved = await service.resolve({
      providerId: "vertex",
      credentialMode: "service-account",
      serviceAccountJson: JSON.stringify(credential),
      serviceAccountSource: "keychain",
      projectId: "goat-project-123",
      location: "us-central1",
    });

    expect(resolved).toEqual({
      accessToken: "ya29.service-account",
      expiresAt: "2026-07-13T13:00:00.000Z",
      projectId: "goat-project-123",
      location: "us-central1",
      endpointId: "openapi",
      baseUrl:
        "https://us-central1-aiplatform.googleapis.com/v1/projects/goat-project-123/locations/us-central1/endpoints/openapi",
      credentialType: "service_account",
      credentialSource: "keychain",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pins service-account exchange to Google's canonical token endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = new GoogleCloudAuthService({ fetch: fetchMock, now: () => NOW, env: {} });
    const credential = { ...serviceAccountCredential(), token_uri: "https://attacker.example/token" };

    await expect(
      service.resolve({
        providerId: "vertex",
        credentialMode: "service-account",
        serviceAccountJson: JSON.stringify(credential),
        projectId: "goat-project-123",
      }),
    ).rejects.toMatchObject({ code: "untrusted_token_uri" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes supported authorized-user ADC without exposing it as a service-account secret", async () => {
    const root = makeTempRoot();
    const credentialPath = path.join(root, "adc.json");
    writeFileSync(
      credentialPath,
      JSON.stringify({
        type: "authorized_user",
        client_id: "client.apps.googleusercontent.com",
        client_secret: "client-secret",
        refresh_token: "refresh-token",
        quota_project_id: "quota-project-123",
      }),
      "utf8",
    );
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://oauth2.googleapis.com/token");
      const form = init?.body as URLSearchParams;
      expect(Object.fromEntries(form.entries())).toEqual({
        grant_type: "refresh_token",
        client_id: "client.apps.googleusercontent.com",
        client_secret: "client-secret",
        refresh_token: "refresh-token",
      });
      return jsonResponse({ access_token: "ya29.authorized-user", expires_in: 1800 });
    });
    const service = new GoogleCloudAuthService({
      fetch: fetchMock,
      now: () => NOW,
      env: { GOOGLE_APPLICATION_CREDENTIALS: credentialPath },
    });

    const resolved = await service.resolve({ providerId: "vertex", credentialMode: "adc" });

    expect(resolved).toMatchObject({
      projectId: "quota-project-123",
      credentialType: "adc",
      credentialSource: "adc_file",
      accessToken: "ya29.authorized-user",
    });
  });

  it("inspects ADC files without token exchange and fails closed on missing, malformed, or rotated content", () => {
    const root = makeTempRoot();
    const credentialPath = path.join(root, "adc-readiness.json");
    const env = { GOOGLE_APPLICATION_CREDENTIALS: credentialPath };
    const service = new GoogleCloudAuthService({ env, fetch: vi.fn<typeof fetch>(), now: () => NOW });

    expect(service.inspectReadiness({ providerId: "vertex", credentialMode: "adc" })).toEqual({
      status: "missing",
      source: "adc_file",
      liveVerified: false,
      reasonCode: "adc_unavailable",
    });

    writeFileSync(credentialPath, "{not-json", "utf8");
    expect(service.inspectReadiness({ providerId: "vertex", credentialMode: "adc" })).toEqual({
      status: "invalid",
      source: "adc_file",
      liveVerified: false,
      reasonCode: "invalid_json",
    });

    writeFileSync(
      credentialPath,
      JSON.stringify({
        type: "authorized_user",
        client_id: "client.apps.googleusercontent.com",
        client_secret: "client-secret",
        refresh_token: "refresh-token",
        quota_project_id: "quota-project-123",
      }),
      "utf8",
    );
    const authorizedUser = service.inspectReadiness({ providerId: "vertex", credentialMode: "adc" });
    expect(authorizedUser).toEqual({
      status: "configured",
      source: "adc_file",
      liveVerified: false,
      reasonCode: "adc_file_configured",
      credentialKind: "authorized_user",
    });

    writeFileSync(credentialPath, JSON.stringify(serviceAccountCredential()), "utf8");
    const serviceAccount = service.inspectReadiness({ providerId: "vertex", credentialMode: "adc" });
    expect(serviceAccount).toEqual({
      status: "configured",
      source: "adc_file",
      liveVerified: false,
      reasonCode: "adc_file_configured",
      credentialKind: "service_account",
    });
    expect(JSON.stringify([authorizedUser, serviceAccount])).not.toMatch(/client-secret|refresh-token|private_key/u);
  });

  it("keeps metadata ADC unknown until live proof and expires success and transient failure readiness", async () => {
    let now = NOW;
    const successfulFetch = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/project/project-id")
        ? new Response("metadata-project-123", { headers: { "metadata-flavor": "Google" } })
        : jsonResponse({ access_token: "ya29.metadata-short", expires_in: 3600 }, { "metadata-flavor": "Google" }),
    );
    const successful = new GoogleCloudAuthService({
      env: {},
      fetch: successfulFetch,
      now: () => now,
      platform: "win32",
      homedir: () => "C:\\Users\\goat",
    });
    expect(successful.inspectReadiness({ providerId: "vertex", credentialMode: "adc" })).toMatchObject({
      status: "unknown",
      source: "metadata",
      liveVerified: false,
    });
    await successful.resolve({ providerId: "vertex", credentialMode: "adc" });
    expect(successful.inspectReadiness({ providerId: "vertex", credentialMode: "adc" })).toMatchObject({
      status: "ready",
      source: "metadata",
      liveVerified: true,
    });
    now += 30_001;
    expect(successful.inspectReadiness({ providerId: "vertex", credentialMode: "adc" })).toMatchObject({
      status: "unknown",
      source: "metadata",
      liveVerified: false,
    });

    now = NOW;
    const unreachable = new GoogleCloudAuthService({
      env: {},
      fetch: async () => {
        throw new Error("metadata network detail must not escape");
      },
      now: () => now,
      platform: "win32",
      homedir: () => "C:\\Users\\goat",
    });
    await expect(unreachable.resolve({ providerId: "vertex", credentialMode: "adc" })).rejects.toMatchObject({
      code: "adc_unavailable",
    });
    const failed = unreachable.inspectReadiness({ providerId: "vertex", credentialMode: "adc" });
    expect(failed).toEqual({
      status: "unavailable",
      source: "metadata",
      liveVerified: false,
      reasonCode: "adc_unavailable",
      credentialKind: "attached_service_account",
    });
    expect(JSON.stringify(failed)).not.toContain("metadata network detail");
    now += 5_001;
    expect(unreachable.inspectReadiness({ providerId: "vertex", credentialMode: "adc" })).toMatchObject({
      status: "unknown",
      reasonCode: "metadata_not_probed",
    });
  });

  it("binds ADC-file live readiness to exact source bytes and stat identity, then expires to configured", async () => {
    const root = makeTempRoot();
    const credentialPath = path.join(root, "adc-readiness-identity.json");
    let now = NOW;
    const writeCredential = (refreshToken: string) =>
      writeFileSync(
        credentialPath,
        JSON.stringify({
          type: "authorized_user",
          client_id: "client-id",
          client_secret: "client-secret",
          refresh_token: refreshToken,
          quota_project_id: "quota-project-123",
        }),
        "utf8",
      );
    writeCredential("refresh-a");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ access_token: `ya29.${fetchMock.mock.calls.length}`, expires_in: 3600 }),
    );
    const service = new GoogleCloudAuthService({
      env: { GOOGLE_APPLICATION_CREDENTIALS: credentialPath },
      fetch: fetchMock,
      now: () => now,
    });
    const request = { providerId: "vertex", credentialMode: "adc" as const };

    await service.resolve(request);
    expect(service.inspectReadiness(request)).toEqual({
      status: "ready",
      source: "adc_file",
      liveVerified: true,
      reasonCode: "credential_resolved",
      credentialKind: "authorized_user",
    });

    writeCredential("refresh-b");
    expect(service.inspectReadiness(request)).toMatchObject({
      status: "configured",
      source: "adc_file",
      liveVerified: false,
    });
    await service.resolve(request);
    expect(service.inspectReadiness(request).status).toBe("ready");

    const changedStat = new Date(NOW + 10_000);
    utimesSync(credentialPath, changedStat, changedStat);
    expect(service.inspectReadiness(request)).toMatchObject({
      status: "configured",
      source: "adc_file",
      liveVerified: false,
    });

    await service.resolve(request);
    expect(service.inspectReadiness(request).status).toBe("ready");
    now += 30_001;
    expect(service.inspectReadiness(request)).toMatchObject({
      status: "configured",
      source: "adc_file",
      liveVerified: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("projects transient ADC-file failure as bounded unavailable state and recovers after its TTL", async () => {
    const root = makeTempRoot();
    const credentialPath = path.join(root, "adc-transient.json");
    writeFileSync(
      credentialPath,
      JSON.stringify({
        type: "authorized_user",
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: "refresh-token",
        quota_project_id: "quota-project-123",
      }),
      "utf8",
    );
    let now = NOW;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("private network topology detail"))
      .mockResolvedValueOnce(jsonResponse({ access_token: "ya29.recovered", expires_in: 3600 }));
    const service = new GoogleCloudAuthService({
      env: { GOOGLE_APPLICATION_CREDENTIALS: credentialPath },
      fetch: fetchMock,
      now: () => now,
    });
    const request = { providerId: "vertex", credentialMode: "adc" as const };

    await expect(service.resolve(request)).rejects.toMatchObject({
      code: "token_exchange_unavailable",
      message: "Google OAuth token exchange was temporarily unavailable.",
    });
    const unavailable = service.inspectReadiness(request);
    expect(unavailable).toEqual({
      status: "unavailable",
      source: "adc_file",
      liveVerified: false,
      reasonCode: "token_exchange_unavailable",
      credentialKind: "authorized_user",
    });
    expect(JSON.stringify(unavailable)).not.toContain("private network topology detail");

    now += 5_001;
    expect(service.inspectReadiness(request)).toMatchObject({
      status: "configured",
      liveVerified: false,
    });
    await service.resolve(request);
    expect(service.inspectReadiness(request)).toMatchObject({ status: "ready", liveVerified: true });
  });

  it("does not project a structurally present but invalid service-account key as configured", () => {
    const service = new GoogleCloudAuthService({ env: {}, fetch: vi.fn<typeof fetch>(), now: () => NOW });
    const readiness = service.inspectReadiness({
      providerId: "vertex",
      credentialMode: "service-account",
      serviceAccountJson: JSON.stringify({
        type: "service_account",
        project_id: "quota-project-123",
        client_email: "goat@quota-project-123.iam.gserviceaccount.com",
        private_key: "private credential bytes must never escape",
        token_uri: "https://oauth2.googleapis.com/token",
      }),
      serviceAccountSource: "keychain",
    });

    expect(readiness).toEqual({
      status: "invalid",
      source: "keychain",
      liveVerified: false,
      reasonCode: "invalid_service_account_key",
    });
    expect(JSON.stringify(readiness)).not.toContain("private credential bytes");
  });

  it("fails closed on external-account and workload-identity ADC files", async () => {
    const root = makeTempRoot();
    const credentialPath = path.join(root, "external.json");
    writeFileSync(
      credentialPath,
      JSON.stringify({
        type: "external_account",
        audience: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/provider",
        credential_source: { executable: { command: "malicious-helper" } },
      }),
      "utf8",
    );
    const fetchMock = vi.fn<typeof fetch>();
    const service = new GoogleCloudAuthService({
      fetch: fetchMock,
      now: () => NOW,
      env: { GOOGLE_APPLICATION_CREDENTIALS: credentialPath },
    });

    await expect(service.resolve({ providerId: "vertex", credentialMode: "adc" })).rejects.toMatchObject({
      code: "unsupported_external_account",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses only the fixed attached-service-account metadata endpoint and verifies its identity header", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/project/project-id")) {
        return new Response("metadata-project-123", {
          headers: { "metadata-flavor": "Google" },
        });
      }
      return jsonResponse({ access_token: "ya29.metadata", expires_in: 3600 }, { "metadata-flavor": "Google" });
    });
    const service = new GoogleCloudAuthService({
      fetch: fetchMock,
      now: () => NOW,
      env: {},
      platform: "win32",
      homedir: () => "C:\\Users\\goat",
    });

    const resolved = await service.resolve({ providerId: "vertex", credentialMode: "adc" });

    expect(requests.map((item) => item.url)).toEqual([
      "http://169.254.169.254/computeMetadata/v1/project/project-id",
      "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token",
    ]);
    expect(requests.every((item) => new Headers(item.init?.headers).get("metadata-flavor") === "Google")).toBe(true);
    expect(resolved).toMatchObject({
      accessToken: "ya29.metadata",
      projectId: "metadata-project-123",
      credentialType: "adc",
      credentialSource: "metadata",
    });
  });

  it("rejects metadata responses that do not prove Google metadata identity", async () => {
    const service = new GoogleCloudAuthService({
      fetch: async () => new Response("spoofed"),
      now: () => NOW,
      env: {},
      platform: "win32",
      homedir: () => "C:\\Users\\goat",
    });

    await expect(service.resolve({ providerId: "vertex", credentialMode: "adc" })).rejects.toMatchObject({
      code: "invalid_metadata_response",
    });
  });

  it("caches short-lived access tokens without retaining secret bytes in the cache key", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ access_token: "ya29.cached", expires_in: 3600 }));
    const service = new GoogleCloudAuthService({ fetch: fetchMock, now: () => NOW, env: {} });
    const request = {
      providerId: "vertex",
      credentialMode: "service-account" as const,
      serviceAccountJson: JSON.stringify(serviceAccountCredential()),
      projectId: "goat-project-123",
    };

    await service.resolve(request);
    await service.resolve(request);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    service.invalidate("vertex");
    await service.resolve(request);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a token after a service-account secret rotates", async () => {
    const credential = serviceAccountCredential();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "ya29.before-rotation", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "ya29.after-rotation", expires_in: 3600 }));
    const service = new GoogleCloudAuthService({ fetch: fetchMock, now: () => NOW, env: {} });
    const baseRequest = {
      providerId: "vertex",
      credentialMode: "service-account" as const,
      projectId: "goat-project-123",
    };

    const before = await service.resolve({ ...baseRequest, serviceAccountJson: JSON.stringify(credential) });
    const after = await service.resolve({
      ...baseRequest,
      serviceAccountJson: JSON.stringify({ ...credential, client_email: `rotated-${credential.client_email}` }),
    });

    expect(before.accessToken).toBe("ya29.before-rotation");
    expect(after.accessToken).toBe("ya29.after-rotation");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a token after an ADC file changes", async () => {
    const root = makeTempRoot();
    const credentialPath = path.join(root, "adc-rotation.json");
    const writeCredential = (refreshToken: string) =>
      writeFileSync(
        credentialPath,
        JSON.stringify({
          type: "authorized_user",
          client_id: "client-id",
          client_secret: "client-secret",
          refresh_token: refreshToken,
          quota_project_id: "quota-project-123",
        }),
      );
    writeCredential("refresh-before");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "ya29.adc-before", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "ya29.adc-after", expires_in: 3600 }));
    const service = new GoogleCloudAuthService({
      fetch: fetchMock,
      now: () => NOW,
      env: { GOOGLE_APPLICATION_CREDENTIALS: credentialPath },
    });

    const before = await service.resolve({ providerId: "vertex", credentialMode: "adc" });
    writeCredential("refresh-after");
    const after = await service.resolve({ providerId: "vertex", credentialMode: "adc" });

    expect(before.accessToken).toBe("ya29.adc-before");
    expect(after.accessToken).toBe("ya29.adc-after");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown credential modes and service-account sources", async () => {
    const service = new GoogleCloudAuthService({ fetch: vi.fn<typeof fetch>(), now: () => NOW, env: {} });
    await expect(service.resolve({ providerId: "vertex", credentialMode: "unknown" as never })).rejects.toMatchObject({
      code: "invalid_credential_mode",
    });
    await expect(
      service.resolve({
        providerId: "vertex",
        credentialMode: "service-account",
        serviceAccountJson: "{}",
        serviceAccountSource: "file" as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_credential_source" });
  });

  it("rejects an oversized access token even when the response is within its byte cap", async () => {
    const service = new GoogleCloudAuthService({
      fetch: async () => jsonResponse({ access_token: "a".repeat(32 * 1024 + 1), expires_in: 3600 }),
      now: () => NOW,
      env: {},
    });
    await expect(
      service.resolve({
        providerId: "vertex",
        credentialMode: "service-account",
        serviceAccountJson: JSON.stringify(serviceAccountCredential()),
        projectId: "goat-project-123",
      }),
    ).rejects.toMatchObject({ code: "invalid_credential_field" });
  });

  it("rejects an oversized authentication response through the shared bounded reader", async () => {
    const service = new GoogleCloudAuthService({
      fetch: async () => new Response("sensitive-response-byte".repeat(4_000)),
      now: () => NOW,
      env: {},
    });

    const resolution = service.resolve({
      providerId: "vertex",
      credentialMode: "service-account",
      serviceAccountJson: JSON.stringify(serviceAccountCredential()),
      projectId: "goat-project-123",
    });
    await expect(resolution).rejects.toMatchObject({
      code: "auth_response_too_large",
      message: "Google authentication response exceeded its size limit.",
    });
    await expect(resolution).rejects.not.toThrow(/sensitive-response-byte/u);
  });

  it("rejects path and host injection in Vertex resource components", () => {
    expect(() => buildVertexOpenAiBaseUrl("project/../other", "us-central1")).toThrow(GoogleCloudAuthError);
    expect(() => buildVertexOpenAiBaseUrl("goat-project-123", "us-central1.evil.example")).toThrow(
      GoogleCloudAuthError,
    );
    expect(() => buildVertexOpenAiBaseUrl("goat-project-123", "us-central1", "openapi/../victim")).toThrow(
      GoogleCloudAuthError,
    );
  });
});

function serviceAccountCredential() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    type: "service_account" as const,
    project_id: "credential-project-123",
    client_email: "goat@credential-project-123.iam.gserviceaccount.com",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    token_uri: "https://oauth2.googleapis.com/token",
  };
}

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "goatcitadel-google-auth-"));
  tempRoots.push(root);
  return root;
}

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}
