import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderDoctorReport, runDoctor } from "./engine.js";

const TEMP_ROOTS: string[] = [];
const DOCTOR_TEST_TIMEOUT_MS = 15_000;

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.MISSION_CONTROL_ORIGIN;
  delete process.env.GATEWAY_HOST;
  while (TEMP_ROOTS.length > 0) {
    await fs.rm(TEMP_ROOTS.pop()!, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("doctor edge behavior", () => {
  it(
    "reports invalid Mission Control origins and non-token auth without emitting bootstrap URLs",
    async () => {
      const rootDir = await createDoctorFixture();
      const assistantPath = path.join(rootDir, "config", "assistant.config.json");
      const assistant = JSON.parse(await fs.readFile(assistantPath, "utf8"));
      assistant.auth.mode = "basic";
      assistant.auth.basic = { username: "operator", password: "secret" };
      await writeJson(assistantPath, assistant);
      process.env.MISSION_CONTROL_ORIGIN = "not a url";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })),
      );

      const invalidOriginReport = await runDoctor({ rootDir, auditOnly: true });

      expect(invalidOriginReport.operatorLinks).toEqual({
        notes: ["MISSION_CONTROL_ORIGIN is invalid (not a url), so the remote Mission Control link was omitted."],
      });
      expect(renderDoctorReport(invalidOriginReport)).toContain("MISSION_CONTROL_ORIGIN is invalid");

      process.env.MISSION_CONTROL_ORIGIN = "http://mission.local";
      const basicAuthReport = await runDoctor({ rootDir, auditOnly: true });

      expect(basicAuthReport.operatorLinks).toEqual({
        notes: ["Gateway auth mode is basic, so a token bootstrap link was not emitted."],
      });
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );

  it(
    "keeps weak non-loopback auth in warning state when guarded repair is declined",
    async () => {
      const rootDir = await createDoctorFixture();
      const assistantPath = path.join(rootDir, "config", "assistant.config.json");
      const assistant = JSON.parse(await fs.readFile(assistantPath, "utf8"));
      assistant.auth = { mode: "none", allowLoopbackBypass: true, token: {}, basic: {} };
      await writeJson(assistantPath, assistant);
      process.env.GATEWAY_HOST = "0.0.0.0";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })),
      );

      const report = await runDoctor({
        rootDir,
        promptConfirm: vi.fn(async () => false),
      });

      expect(report.checks.find((check) => check.id === "security.auth-host-posture")).toMatchObject({
        status: "warn",
        detail: expect.stringContaining("Non-loopback host 0.0.0.0"),
        repairable: true,
      });
      expect(report.repairs.find((repair) => repair.checkId === "security.auth-host-posture")).toMatchObject({
        applied: false,
        skipped: true,
        guarded: true,
        reason: "Guarded repair skipped or not approved.",
      });
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );

  it(
    "surfaces deep runtime voice endpoint failures and onboarding follow-up counts",
    async () => {
      const rootDir = await createDoctorFixture();
      const voiceFetch = vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        }
        if (url.includes("/api/v1/settings")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.includes("/api/v1/onboarding/state")) {
          return new Response(JSON.stringify({ checklist: [] }), { status: 200 });
        }
        if (url.includes("/api/v1/voice/status")) {
          return new Response(JSON.stringify({ error: "voice disabled" }), { status: 503 });
        }
        throw new Error(`unexpected URL ${url}`);
      });
      vi.stubGlobal("fetch", voiceFetch as typeof fetch);

      const voiceReport = await runDoctor({ rootDir, deep: true, auditOnly: true });

      expect(voiceReport.checks.find((check) => check.id === "gateway.deep-runtime")).toMatchObject({
        status: "warn",
        detail: expect.stringContaining("Voice status unavailable: HTTP 503"),
        repairAction: "Run `goatcitadel voice status` after the gateway starts.",
      });

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (url.endsWith("/health") || url.includes("/api/v1/settings")) {
            return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
          }
          if (url.includes("/api/v1/onboarding/state")) {
            return new Response(JSON.stringify({ checklist: [{ status: "needs_input" }, { status: "done" }] }), {
              status: 200,
            });
          }
          throw new Error(`unexpected URL ${url}`);
        }) as typeof fetch,
      );

      const onboardingReport = await runDoctor({ rootDir, deep: true, auditOnly: true });
      expect(onboardingReport.checks.find((check) => check.id === "gateway.deep-runtime")).toMatchObject({
        status: "warn",
        detail: expect.stringContaining("1 onboarding checklist item(s) still need input"),
      });
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );
});

async function createDoctorFixture(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-doctor-loop19-"));
  TEMP_ROOTS.push(rootDir);
  const configDir = path.join(rootDir, "config");
  await fs.mkdir(path.join(rootDir, "data", "transcripts"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "data", "audit"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "workspace"), { recursive: true });
  await fs.mkdir(path.join(rootDir, ".worktrees"), { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(rootDir, "package.json"), '{"private":true}\n', "utf8");
  await fs.writeFile(path.join(rootDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");

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
      basic: {},
    },
  };
  const toolPolicy = {
    profiles: { standard: [] },
    sandbox: {
      writeJailRoots: ["./workspace"],
      readOnlyRoots: ["./config"],
    },
  };
  const budgets = { mode: "balanced" };
  const llm = { activeProviderId: "openai", providers: [] };
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
