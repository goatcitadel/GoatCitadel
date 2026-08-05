import os from "node:os";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderDoctorReport, runDoctor } from "./engine.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.GATEWAY_HOST;
  delete process.env.GOATCITADEL_AUTH_TOKEN;
  delete process.env.GOATCITADEL_ROOT_DIR;
  delete process.env.MISSION_CONTROL_ORIGIN;

  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("doctor engine loop24 diagnostics coverage", () => {
  it("renders profile, repair changes, operator notes, and nonzero summaries", () => {
    const report = renderDoctorReport({
      startedAt: "2026-05-14T20:00:00.000Z",
      finishedAt: "2026-05-14T20:00:05.000Z",
      rootDir: "F:/code/personal-ai",
      gatewayBaseUrl: "http://127.0.0.1:8787",
      profileName: "local",
      profilePath: "F:/code/personal-ai/.goatcitadel/profile.json",
      options: {
        deep: true,
        repairEnabled: false,
        autoRepair: false,
        readOnly: true,
      },
      checks: [
        {
          id: "gateway.health",
          group: "runtime",
          title: "Gateway reachability",
          status: "fail",
          severity: "error",
          detail: "Gateway returned HTTP 500.",
          repairable: true,
          repairAction: "Restart the gateway and rerun doctor.",
        },
      ],
      repairs: [
        {
          checkId: "gateway.health",
          applied: false,
          skipped: true,
          reason: "No automatic repair for gateway runtime state.",
          changes: ["Captured failed health probe for the operator report."],
        },
      ],
      operatorLinks: {
        notes: ["Remote Mission Control link omitted in read-only mode."],
      },
      summary: {
        totalChecks: 1,
        ok: 0,
        warn: 0,
        fail: 1,
        fixed: 0,
        skipped: 0,
        unresolvedWarnings: 0,
        hardFailures: 1,
        repairedCount: 0,
        exitCode: 2,
      },
    });

    expect(report).toContain("Profile: local");
    expect(report).toContain("Profile path: F:/code/personal-ai/.goatcitadel/profile.json");
    expect(report).toContain("Repair: Restart the gateway and rerun doctor.");
    expect(report).toContain("gateway.health: skipped (No automatic repair for gateway runtime state.)");
    expect(report).toContain("Captured failed health probe for the operator report.");
    expect(report).toContain("Note: Remote Mission Control link omitted in read-only mode.");
    expect(report).toContain("Exit code: 2");
  });

  it("reports operator-link omissions for invalid origins and non-token auth modes", async () => {
    const rootDir = await createDoctorFixture();
    vi.stubGlobal("fetch", healthOkFetch());

    process.env.MISSION_CONTROL_ORIGIN = "not a url";
    const invalidOriginReport = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://127.0.0.1:8787",
      auditOnly: true,
      authToken: "token-1",
    });
    expect(invalidOriginReport.operatorLinks?.remoteMissionControlUrl).toBeUndefined();
    expect(invalidOriginReport.operatorLinks?.notes).toEqual([
      "MISSION_CONTROL_ORIGIN is invalid (not a url), so the remote Mission Control link was omitted.",
    ]);

    process.env.MISSION_CONTROL_ORIGIN = "http://mission.local/app";
    const basicReport = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://127.0.0.1:8787",
      auditOnly: true,
      authMode: "basic",
    });
    expect(basicReport.operatorLinks?.remoteMissionControlUrl).toBeUndefined();
    expect(basicReport.operatorLinks?.notes).toEqual([
      "Gateway auth mode is basic, so a token bootstrap link was not emitted.",
    ]);
  });

  it("marks missing local loopback gateway health as skipped instead of a hard failure", async () => {
    const rootDir = await createDoctorFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
      }) as typeof fetch,
    );

    const report = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://127.0.0.1:8787",
      auditOnly: true,
    });

    expect(report.checks.find((check) => check.id === "gateway.health")).toMatchObject({
      status: "skipped",
      severity: "info",
      repairable: false,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.exitCode).toBe(0);
  });

  it("warns when deep runtime settings cannot be loaded without leaking bearer auth into the query", async () => {
    const rootDir = await createDoctorFixture();
    const seenUrls: string[] = [];
    const seenAuthorizationHeaders: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        seenUrls.push(url);
        const authorization = new Headers(init?.headers).get("Authorization");
        if (authorization) {
          seenAuthorizationHeaders.push(authorization);
        }
        if (url.includes("/health")) {
          return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        }
        if (url.includes("/api/v1/settings")) {
          return new Response("settings unavailable", { status: 503 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch,
    );

    const report = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://127.0.0.1:8787/",
      auditOnly: true,
      deep: true,
      authToken: "token with spaces",
      tokenQueryParam: "gateway_token",
    });

    expect(seenUrls).toContain("http://127.0.0.1:8787/api/v1/settings");
    expect(seenUrls.some((url) => url.includes("gateway_token"))).toBe(false);
    expect(seenAuthorizationHeaders).toContain("Bearer token with spaces");
    expect(report.checks.find((check) => check.id === "gateway.deep-runtime")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("Deep check could not load /api/v1/settings: HTTP 503"),
    });
    expect(report.repairs).toContainEqual(
      expect.objectContaining({
        checkId: "gateway.deep-runtime",
        reason: "Unable to query runtime settings for deep check.",
      }),
    );
  });

  it("reports onboarding follow-up and voice endpoint/runtime repair paths during deep checks", async () => {
    const rootDir = await createDoctorFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        }
        if (url.includes("/api/v1/settings")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.includes("/api/v1/onboarding/state")) {
          return new Response(JSON.stringify({ checklist: [{ status: "needs_input" }, { status: "complete" }] }), {
            status: 200,
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch,
    );

    const onboardingReport = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://127.0.0.1:8787",
      auditOnly: true,
      deep: true,
    });
    expect(onboardingReport.checks.find((check) => check.id === "gateway.deep-runtime")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("1 onboarding checklist item(s) still need input."),
    });

    let voiceRuntimeReady = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        if (url.includes("/api/v1/settings")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        if (url.includes("/api/v1/onboarding/state"))
          return new Response(JSON.stringify({ checklist: [] }), { status: 200 });
        if (url.includes("/api/v1/voice/status"))
          return new Response(JSON.stringify({ readiness: "ready" }), { status: 200 });
        if (url.includes("/api/v1/voice/runtime")) {
          return new Response(
            JSON.stringify(
              voiceRuntimeReady ? { readiness: "ready" } : { readiness: "missing", selectedModelId: "base.en" },
            ),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch,
    );
    const voiceRepairReport = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://127.0.0.1:8787",
      auditOnly: true,
      deep: true,
    });
    expect(voiceRepairReport.checks.find((check) => check.id === "gateway.deep-runtime")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("Voice runtime readiness is missing."),
      repairAction: expect.stringContaining("base.en"),
    });

    voiceRuntimeReady = true;
    const okReport = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://127.0.0.1:8787",
      auditOnly: true,
      deep: true,
    });
    expect(okReport.checks.find((check) => check.id === "gateway.deep-runtime")).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("Managed voice runtime is ready."),
    });
  });
});

function healthOkFetch(): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch;
}

async function createDoctorFixture(): Promise<string> {
  const rootDir = await fsTempRoot();
  const configDir = path.join(rootDir, "config");
  await mkdir(configDir, { recursive: true });
  await mkdir(path.join(rootDir, "data", "transcripts"), { recursive: true });
  await mkdir(path.join(rootDir, "data", "audit"), { recursive: true });
  await mkdir(path.join(rootDir, "workspace"), { recursive: true });
  await mkdir(path.join(rootDir, ".worktrees"), { recursive: true });
  await writeJson(path.join(rootDir, "package.json"), { name: "doctor-loop24", private: true });
  await writeFile(path.join(rootDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");

  const assistant = {
    environment: "local",
    defaultToolProfile: "standard",
    dataDir: "./data",
    transcriptsDir: "./data/transcripts",
    auditDir: "./data/audit",
    workspaceDir: "./workspace",
    worktreesDir: "./.worktrees",
    auth: {
      mode: "token",
      allowLoopbackBypass: false,
      token: {
        queryParam: "access_token",
        value: "fixture-token",
      },
      basic: {
        username: "operator",
        password: "secret",
      },
    },
    features: {
      durableKernelV1Enabled: false,
    },
  };
  const toolPolicy = {
    profiles: {
      standard: [],
    },
    tools: {
      profile: "standard",
      allow: [],
      deny: [],
    },
    agents: {},
    sandbox: {
      writeJailRoots: ["./workspace"],
      readOnlyRoots: ["./config"],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
  const budgets = {
    mode: "balanced",
    daily: {
      tokensWarning: 1000,
      tokensHardCap: 2000,
      usdWarning: 1,
      usdHardCap: 2,
    },
    session: {
      tokensHardCap: 1000,
      turnMaxInputTokens: 500,
      turnMaxOutputTokens: 500,
    },
  };
  const llm = {
    activeProviderId: "local",
    providers: [
      {
        providerId: "local",
        label: "Local",
        apiStyle: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:1234/v1",
        defaultModel: "local-model",
      },
    ],
  };
  const cronJobs = { jobs: [] };

  await writeJson(path.join(configDir, "assistant.config.json"), assistant);
  await writeJson(path.join(configDir, "tool-policy.json"), toolPolicy);
  await writeJson(path.join(configDir, "budgets.json"), budgets);
  await writeJson(path.join(configDir, "llm-providers.json"), llm);
  await writeJson(path.join(configDir, "cron-jobs.json"), cronJobs);
  await writeJson(path.join(configDir, "goatcitadel.json"), {
    version: 1,
    assistant,
    toolPolicy,
    budgets,
    llm,
    cronJobs,
  });

  return rootDir;
}

async function fsTempRoot(): Promise<string> {
  const root = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-doctor-loop24-")),
  );
  tempRoots.push(root);
  return root;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
