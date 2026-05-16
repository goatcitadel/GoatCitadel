import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "./engine.js";

const TEMP_ROOTS: string[] = [];
const DOCTOR_TEST_TIMEOUT_MS = 15_000;

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.MISSION_CONTROL_ORIGIN;
  delete process.env.GATEWAY_HOST;
  delete process.env.GOATCITADEL_ROOT_DIR;
  while (TEMP_ROOTS.length > 0) {
    const next = TEMP_ROOTS.pop();
    if (next) {
      await fs.rm(next, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }
});

describe("doctor cron-row repair", () => {
  it(
    "flags malformed cron rows as a check warning when running audit-only",
    async () => {
      const rootDir = await createDoctorFixture();
      const cronFile = path.join(rootDir, "config", "cron-jobs.json");
      await writeJson(cronFile, {
        jobs: [
          { jobId: "good", name: "Good", schedule: "0 9 * * *", enabled: true, action: "task" },
          { jobId: "", name: null, schedule: "" },
          { jobId: "missing-name", name: "  ", schedule: "* * * * *" },
        ],
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch,
      );

      const report = await runDoctor({ rootDir, auditOnly: true });
      const cronCheck = report.checks.find((c) => c.id === "config.cron-rows");

      expect(cronCheck).toBeDefined();
      expect(cronCheck?.status).toBe("warn");
      expect(cronCheck?.detail).toMatch(/malformed|invalid|garbage/i);
      expect(cronCheck?.repairable).toBe(true);

      // Audit-only should NOT rewrite the file
      const afterRaw = await fs.readFile(cronFile, "utf8");
      const after = JSON.parse(afterRaw) as { jobs: Array<{ jobId: string }> };
      expect(after.jobs).toHaveLength(3);
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );

  it(
    "removes unrepairable rows under --fix (auto-repair)",
    async () => {
      const rootDir = await createDoctorFixture();
      const cronFile = path.join(rootDir, "config", "cron-jobs.json");
      await writeJson(cronFile, {
        jobs: [
          { jobId: "good", name: "Good", schedule: "0 9 * * *", enabled: true, action: "task" },
          { jobId: "", name: null, schedule: "" },
          { jobId: "missing-name", name: "  ", schedule: "* * * * *" },
        ],
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch,
      );

      const report = await runDoctor({ rootDir, yes: true });

      const cronCheck = report.checks.find((c) => c.id === "config.cron-rows");
      expect(cronCheck?.status).toBe("fixed");

      const afterRaw = await fs.readFile(cronFile, "utf8");
      const after = JSON.parse(afterRaw) as { jobs: Array<{ jobId: string }> };
      expect(after.jobs).toHaveLength(1);
      expect(after.jobs[0]?.jobId).toBe("good");

      const repair = report.repairs.find((r) => r.checkId === "config.cron-rows");
      expect(repair?.applied).toBe(true);
      expect(repair?.changes?.some((change) => /pruned|removed|2/.test(change))).toBe(true);
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );

  it(
    "reports ok when cron-jobs.json is missing",
    async () => {
      const rootDir = await createDoctorFixture();
      const cronFile = path.join(rootDir, "config", "cron-jobs.json");
      await fs.rm(cronFile, { force: true });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch,
      );

      const report = await runDoctor({ rootDir, auditOnly: true });
      const cronCheck = report.checks.find((c) => c.id === "config.cron-rows");
      expect(cronCheck?.status).toBe("ok");
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );

  it(
    "reports ok when all rows are valid",
    async () => {
      const rootDir = await createDoctorFixture();
      const cronFile = path.join(rootDir, "config", "cron-jobs.json");
      await writeJson(cronFile, {
        jobs: [
          { jobId: "a", name: "A", schedule: "0 9 * * *", enabled: true, action: "task" },
          { jobId: "b", name: "B", schedule: "0 10 * * *", enabled: false, action: "task" },
        ],
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch,
      );

      const report = await runDoctor({ rootDir, auditOnly: true });
      const cronCheck = report.checks.find((c) => c.id === "config.cron-rows");
      expect(cronCheck?.status).toBe("ok");
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );

  it(
    "preserves top-level array shape when --fix prunes rows",
    async () => {
      const rootDir = await createDoctorFixture();
      const cronFile = path.join(rootDir, "config", "cron-jobs.json");
      // Top-level array (legacy shape) — overwrite the fixture's { jobs: [] } payload.
      await writeJson(cronFile, [
        { jobId: "good", name: "Good", schedule: "0 9 * * *", enabled: true, action: "task" },
        { jobId: "", name: null, schedule: "" },
      ]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch,
      );

      await runDoctor({ rootDir, yes: true });

      const after = JSON.parse(await fs.readFile(cronFile, "utf8"));
      expect(Array.isArray(after)).toBe(true);
      expect(after).toHaveLength(1);
      expect(after[0].jobId).toBe("good");
    },
    DOCTOR_TEST_TIMEOUT_MS,
  );
});

async function createDoctorFixture(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-doctor-cron-repair-"));
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
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
