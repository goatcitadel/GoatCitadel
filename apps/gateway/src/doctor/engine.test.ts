import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderDoctorReport, runDoctor } from "./engine.js";

const TEMP_ROOTS: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.MISSION_CONTROL_ORIGIN;

  while (TEMP_ROOTS.length > 0) {
    const next = TEMP_ROOTS.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

describe("doctor operator links", () => {
  it("emits a remote Mission Control bootstrap URL when token auth and origin are configured", async () => {
    const rootDir = await createDoctorFixture();
    process.env.MISSION_CONTROL_ORIGIN = "http://bld:5173";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
      ) as typeof fetch,
    );

    const report = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://127.0.0.1:8787",
      auditOnly: true,
    });

    expect(report.operatorLinks?.remoteMissionControlUrl).toBe(
      "http://bld:5173/?tab=dashboard#access_token=tailnet-token",
    );
    expect(renderDoctorReport(report)).toContain(
      "Mission Control: http://bld:5173/?tab=dashboard#access_token=tailnet-token",
    );
  });

  it("omits the bootstrap URL and reports a note when Mission Control origin is missing", async () => {
    const rootDir = await createDoctorFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
      ) as typeof fetch,
    );

    const report = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://127.0.0.1:8787",
      auditOnly: true,
    });

    expect(report.operatorLinks?.remoteMissionControlUrl).toBeUndefined();
    expect(report.operatorLinks?.notes).toContain(
      "MISSION_CONTROL_ORIGIN is not set, so the remote Mission Control link was omitted.",
    );
    expect(renderDoctorReport(report)).toContain("MISSION_CONTROL_ORIGIN is not set");
  });
});

describe("doctor summary behavior", () => {
  it("reports missing managed workspace tooling in audit-only mode", async () => {
    const rootDir = await createDoctorFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
    );

    const report = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://127.0.0.1:8787",
      auditOnly: true,
    });

    const toolingCheck = report.checks.find((check) => check.id === "runtime.managed-workspace-tooling");
    expect(toolingCheck?.status).toBe("warn");
    expect(toolingCheck?.detail).toContain("Missing local workspace tooling");
  });

  it("does not fail when the report only contains warnings", async () => {
    const rootDir = await createDoctorFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
    );

    const report = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://192.168.0.77:8787",
      auditOnly: true,
    });

    expect(report.summary.warn).toBeGreaterThan(0);
    expect(report.summary.fail).toBe(0);
    expect(report.summary.exitCode).toBe(0);
  });

  it("retries an aborted deep-runtime settings probe before warning", async () => {
    const rootDir = await createDoctorFixture();
    let settingsAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/v1/settings")) {
        settingsAttempts += 1;
        if (settingsAttempts === 1) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/v1/onboarding/state")) {
        return new Response(JSON.stringify({ checklist: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/v1/voice/status")) {
        return new Response(JSON.stringify({ provider: "whisper.cpp", readiness: "ready" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/v1/voice/runtime")) {
        return new Response(JSON.stringify({ readiness: "ready", selectedModelId: "base.en" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const report = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://127.0.0.1:8787",
      auditOnly: true,
      deep: true,
    });

    expect(settingsAttempts).toBe(2);
    expect(report.checks.find((check) => check.id === "gateway.deep-runtime")?.status).toBe("ok");
  });
});

async function createDoctorFixture(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-doctor-"));
  TEMP_ROOTS.push(rootDir);

  const configDir = path.join(rootDir, "config");
  await mkdir(configDir, { recursive: true });
  await mkdir(path.join(rootDir, "data", "transcripts"), { recursive: true });
  await mkdir(path.join(rootDir, "data", "audit"), { recursive: true });
  await mkdir(path.join(rootDir, "workspace"), { recursive: true });
  await mkdir(path.join(rootDir, ".worktrees"), { recursive: true });
  await writeJson(path.join(rootDir, "package.json"), {
    name: "doctor-fixture",
    private: true,
  });
  await writeFile(path.join(rootDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n", "utf8");

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
        value: "tailnet-token",
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
    activeProviderId: "glm",
    providers: [
      {
        providerId: "glm",
        label: "GLM",
        apiStyle: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:1234/v1",
        defaultModel: "glm-5",
      },
    ],
  };
  const cronJobs = {
    jobs: [],
  };

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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
