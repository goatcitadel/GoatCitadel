import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderDoctorReport, runDoctor, __doctorEngineInternals } from "./engine.js";

const TEMP_ROOTS: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.MISSION_CONTROL_ORIGIN;
  delete process.env.GOATCITADEL_ROOT_DIR;
  delete process.env.GATEWAY_HOST;

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

  it("repairs missing runtime directories and policy jail roots when guarded repair is approved", async () => {
    const rootDir = await createDoctorFixture();
    await rm(path.join(rootDir, "workspace"), { recursive: true, force: true });
    await rm(path.join(rootDir, "data"), { recursive: true, force: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ) as typeof fetch,
    );

    const report = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://127.0.0.1:8787",
      yes: true,
    });

    expect(report.checks.find((check) => check.id === "policy.paths")).toMatchObject({
      status: "fixed",
      repairable: true,
    });
    expect(report.checks.find((check) => check.id === "storage.paths")).toMatchObject({
      status: "fixed",
      repairable: true,
    });
    expect(report.repairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "policy.paths",
          applied: true,
        }),
        expect.objectContaining({
          checkId: "storage.paths",
          applied: true,
        }),
      ]),
    );
    await expect(readFile(path.join(rootDir, "workspace", ".doctor-write-test"), "utf8")).rejects.toThrow();
  });

  it("hardens weak auth on non-loopback hosts when guarded repair is approved", async () => {
    const rootDir = await createDoctorFixture();
    const assistantPath = path.join(rootDir, "config", "assistant.config.json");
    const assistant = JSON.parse(await readFile(assistantPath, "utf8")) as Record<string, unknown>;
    assistant.auth = {
      mode: "none",
      allowLoopbackBypass: true,
      token: {},
      basic: {},
    };
    await writeJson(assistantPath, assistant);
    process.env.GATEWAY_HOST = "0.0.0.0";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ) as typeof fetch,
    );

    const report = await runDoctor({
      rootDir,
      gatewayBaseUrl: "http://127.0.0.1:8787",
      yes: true,
    });

    expect(report.checks.find((check) => check.id === "security.auth-host-posture")).toMatchObject({
      status: "fixed",
      repairable: true,
    });
    const repairedAssistant = JSON.parse(await readFile(assistantPath, "utf8")) as {
      auth: { mode: string; allowLoopbackBypass: boolean; token: { value?: string } };
    };
    expect(repairedAssistant.auth.mode).toBe("token");
    expect(repairedAssistant.auth.allowLoopbackBypass).toBe(false);
    expect(repairedAssistant.auth.token.value).toMatch(/^gc_/);
  });
});

describe("doctor internal helpers", () => {
  it("normalizes links, host checks, path boundaries, and warning-only summaries", () => {
    expect(__doctorEngineInternals.normalizeBaseUrl("http://127.0.0.1:8787///")).toBe("http://127.0.0.1:8787");
    expect(__doctorEngineInternals.buildRemoteMissionControlUrl("http://mc.local/app", "token with spaces")).toBe(
      "http://mc.local/app?tab=dashboard#access_token=token%20with%20spaces",
    );
    expect(__doctorEngineInternals.isLoopbackHost("[::1]")).toBe(true);
    expect(__doctorEngineInternals.isLoopbackHost("0.0.0.0")).toBe(false);
    expect(__doctorEngineInternals.isPathInsideRoot("C:/workspace", "C:/workspace/config/file.json")).toBe(true);
    expect(__doctorEngineInternals.isPathInsideRoot("C:/workspace", "C:/other/file.json")).toBe(false);

    expect(
      __doctorEngineInternals.summarizeDoctor(
        [
          {
            id: "warning",
            group: "runtime",
            title: "Warning",
            status: "warn",
            severity: "warning",
            detail: "operator attention needed",
            repairable: false,
          },
        ],
        [{ checkId: "warning", applied: false, skipped: true }],
      ),
    ).toMatchObject({
      warn: 1,
      hardFailures: 0,
      exitCode: 0,
      repairedCount: 0,
    });
  });

  it("resolves the doctor root from explicit input and environment fallback", async () => {
    const rootDir = await createDoctorFixture();
    const nestedDir = path.join(rootDir, "apps", "gateway");
    await mkdir(nestedDir, { recursive: true });

    expect(__doctorEngineInternals.resolveDoctorRootDir(` ${nestedDir} `)).toBe(path.resolve(nestedDir));

    process.env.GOATCITADEL_ROOT_DIR = rootDir;
    expect(__doctorEngineInternals.resolveDoctorRootDir()).toBe(path.resolve(rootDir));
  });

  it("detects repo roots, generates repair tokens, and gates guarded repairs", async () => {
    const rootDir = await createDoctorFixture();
    const nonRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-not-root-"));
    TEMP_ROOTS.push(nonRoot);

    expect(__doctorEngineInternals.commandLooksLikeRepoRoot(rootDir)).toBe(true);
    expect(__doctorEngineInternals.commandLooksLikeRepoRoot(nonRoot)).toBe(false);
    expect(__doctorEngineInternals.cryptoRandomHex(8)).toMatch(/^[a-f0-9]{16}$/);
    await expect(__doctorEngineInternals.requestGuardedRepairApproval({ yes: true } as never, "repair?")).resolves.toBe(
      true,
    );
    await expect(__doctorEngineInternals.requestGuardedRepairApproval({} as never, "repair?")).resolves.toBe(false);

    const promptConfirm = vi.fn(async () => true);
    await expect(
      __doctorEngineInternals.requestGuardedRepairApproval({ promptConfirm } as never, "repair?"),
    ).resolves.toBe(true);
    expect(promptConfirm).toHaveBeenCalledWith("repair?");
  });

  it("collects config issues and rebuilds unified config from valid split files", async () => {
    const rootDir = await createDoctorFixture();
    const configDir = path.join(rootDir, "config");
    const unifiedPath = path.join(configDir, "goatcitadel.json");
    await writeFile(unifiedPath, "{not-json", "utf8");

    const issues = __doctorEngineInternals.collectConfigIssues(
      {
        path: unifiedPath,
        exists: true,
        valid: false,
        error: "Unexpected token",
      },
      [
        {
          path: path.join(configDir, "assistant.config.json"),
          exists: false,
          valid: false,
          error: "file not found",
        },
      ],
    );
    expect(issues).toEqual(["Unified config is invalid JSON (Unexpected token).", "assistant.config.json is missing."]);

    const rebuilt = await __doctorEngineInternals.rebuildUnifiedFromSplit({
      rootDir,
      configDir,
    } as never);
    expect(rebuilt).toEqual({
      rebuilt: true,
      message: "Rebuilt unified config from split config files.",
    });

    const rootConfig = JSON.parse(await readFile(unifiedPath, "utf8"));
    expect(rootConfig).toMatchObject({
      version: 1,
      assistant: {
        auth: {
          mode: "token",
        },
      },
      cronJobs: {
        jobs: [],
      },
    });
  });

  it("detects managed workspace tooling presence and missing binaries", async () => {
    const rootDir = await createDoctorFixture();
    expect(__doctorEngineInternals.inspectManagedWorkspaceTooling(path.join(rootDir, "missing"))).toEqual({
      isWorkspace: false,
      missing: [],
    });

    let tooling = __doctorEngineInternals.inspectManagedWorkspaceTooling(rootDir);
    expect(tooling.isWorkspace).toBe(true);
    expect(tooling.missing.map((item) => item.label)).toContain("workspace dependencies");

    const binDir = path.join(rootDir, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    const extension = process.platform === "win32" ? ".cmd" : "";
    await writeFile(path.join(binDir, `tsc${extension}`), "", "utf8");
    await writeFile(path.join(binDir, `tsx${extension}`), "", "utf8");
    await writeFile(path.join(binDir, `vitest${extension}`), "", "utf8");

    tooling = __doctorEngineInternals.inspectManagedWorkspaceTooling(rootDir);
    expect(tooling).toEqual({
      isWorkspace: true,
      missing: [],
    });
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

describe("state validation quarantine check", () => {
  it("passes when quarantine is empty", async () => {
    const rootDir = await createDoctorFixture();
    const report = await runDoctor({ rootDir, gatewayBaseUrl: "http://127.0.0.1:8787", auditOnly: true });
    const check = report.checks.find((c) => c.id === "state.validation.quarantine");
    expect(check).toBeDefined();
    expect(check?.status).toBe("pass");
  });

  it("warns when 1-99 quarantine entries exist", async () => {
    const rootDir = await createDoctorFixture();
    await seedQuarantine(rootDir, 5);
    const report = await runDoctor({ rootDir, gatewayBaseUrl: "http://127.0.0.1:8787", auditOnly: true });
    const check = report.checks.find((c) => c.id === "state.validation.quarantine");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("5");
  });

  it("fails when 100+ entries exist", async () => {
    const rootDir = await createDoctorFixture();
    await seedQuarantine(rootDir, 105);
    const report = await runDoctor({ rootDir, gatewayBaseUrl: "http://127.0.0.1:8787", auditOnly: true });
    const check = report.checks.find((c) => c.id === "state.validation.quarantine");
    expect(check?.status).toBe("fail");
  });
});

async function seedQuarantine(rootDir: string, count: number): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = path.join(rootDir, "data", "goatcitadel.db");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_validation_quarantine (
      quarantine_id TEXT PRIMARY KEY,
      store TEXT NOT NULL,
      row_id TEXT NOT NULL,
      raw_value TEXT,
      schema_error TEXT NOT NULL,
      observed_at TEXT NOT NULL
    )
  `);
  const stmt = db.prepare(
    "INSERT INTO state_validation_quarantine (quarantine_id, store, row_id, raw_value, schema_error, observed_at) VALUES (?,?,?,?,?,?)",
  );
  for (let i = 0; i < count; i += 1) {
    stmt.run(`q-${i}`, "test", `r-${i}`, null, "schema: x", "2026-05-15T00:00:00.000Z");
  }
  db.close();
}
