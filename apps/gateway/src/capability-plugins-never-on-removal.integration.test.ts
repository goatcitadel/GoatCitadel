import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CapabilityPluginDetail,
  CapabilityPluginInspection,
  CapabilitySkillRemovalOutcome,
  CapabilitySkillRemovalRead,
  PluginActionOutcome,
} from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import { GatewayService } from "./services/gateway-service.js";

/**
 * A skill a plugin's earlier install left behind and never switched on, removed through the governed path, over the
 * real Gateway: install the reference plugin with its skill only installed (never switched on), uninstall it, check it
 * again (the left-over is offered for removal), remove it with its own danger approval (asked for even with the skip
 * setting on), then check and install the same plugin again. SQLite always; PostgreSQL too when
 * `GOATCITADEL_TEST_POSTGRES_GATEWAY_URL` names an empty database the test may migrate.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REFERENCE_PLUGIN = path.join(REPO_ROOT, "packages", "extensions-sdk", "templates", "plugins", "reference-plugin");
const TOKEN = "capability-plugins-never-on-removal-operator-1234567890";
const WORKSPACE_ID = "default";
const SKILL_ID = "extra:meeting-notes";
const STEP_WAIT = { timeout: 120_000, interval: 250 } as const;
const LEFT_OVER =
  "This skill was left behind by an earlier install and was never switched on. Remove it here, then this plugin can be installed.";
const POSTGRES_URL = process.env.GOATCITADEL_TEST_POSTGRES_GATEWAY_URL?.trim();

const ENV: Record<string, string> = {
  GATEWAY_HOST: "127.0.0.1",
  NODE_ENV: "test",
  GOATCITADEL_ALLOWED_ORIGINS: "http://localhost:5173",
  GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS: "false",
  GOATCITADEL_AUTH_MODE: "token",
  GOATCITADEL_AUTH_TOKEN: TOKEN,
  GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "false",
  GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART: "false",
  GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
  GOATCITADEL_DISABLE_SECRET_STORE: "true",
  GOATCITADEL_LLAMACPP_AUTOSTART: "false",
  GOATCITADEL_LLAMACPP_ENABLED: "false",
  GOATCITADEL_NPU_AUTOSTART: "false",
  GOATCITADEL_NPU_ENABLED: "false",
  GOATCITADEL_RATE_LIMIT_ENABLED: "false",
};

const DRIVERS: Array<{ driver: "sqlite" | "postgres"; env: Record<string, string> }> = [
  { driver: "sqlite", env: { GOATCITADEL_DATABASE_DRIVER: "sqlite" } },
  ...(POSTGRES_URL
    ? [
        {
          driver: "postgres" as const,
          env: {
            GOATCITADEL_DATABASE_DRIVER: "postgres",
            GOATCITADEL_POSTGRES_MODE: "managed",
            GOATCITADEL_POSTGRES_CONNECTION_STRING: POSTGRES_URL,
          },
        },
      ]
    : []),
];

describe.each(DRIVERS)("removing a never-switched-on left-over skill ($driver)", ({ env }) => {
  const originalEnv = new Map<string, string | undefined>();
  let root = "";
  let app: FastifyInstance | undefined;
  let sequence = 0;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-never-on-removal-"));
    writeConfig(path.join(root, "config"));
    fs.cpSync(REFERENCE_PLUGIN, path.join(root, "plugins", "reference-plugin"), { recursive: true });
    for (const [key, value] of Object.entries({ ...ENV, ...env, GOATCITADEL_ROOT_DIR: root })) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    const caught = vi.spyOn(GatewayService.prototype, "initCritical");
    try {
      app = await buildApp();
      await app.ready();
    } finally {
      caught.mockRestore();
    }
  }, 300_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = String((error as NodeJS.ErrnoException).code);
        if (attempt >= 5 || !["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"].includes(code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  });

  async function inject(method: "GET" | "POST", url: string, payload?: Record<string, unknown>) {
    return await app!.inject({
      method,
      url,
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": `never-on-removal-${++sequence}` },
      ...(payload ? { payload } : {}),
    });
  }

  async function inspect(): Promise<CapabilityPluginInspection> {
    const created = await inject("POST", "/api/v1/capabilities/plugins/inspections", {
      workspaceId: WORKSPACE_ID,
      source: { kind: "built_in", pluginId: "reference-plugin" },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json<CapabilityPluginInspection>();
  }

  async function installPlugin(): Promise<void> {
    const inspection = await inspect();
    expect(inspection.installable, JSON.stringify(inspection.pieces)).toBe(true);
    const installed = await inject("POST", "/api/v1/capabilities/plugins/install", {
      workspaceId: WORKSPACE_ID,
      inspectionId: inspection.inspectionId,
    });
    expect(installed.statusCode, installed.body).toBe(202);
    expect(installed.json<PluginActionOutcome>().outcome).toBe("applied");
  }

  /** Installs the plugin's skill and leaves it switched off: its first step only. */
  async function installSkillOnly(): Promise<void> {
    const detailUrl = `/api/v1/capabilities/plugins/detail?pluginId=reference-plugin&workspaceId=${WORKSPACE_ID}`;
    const readDetail = async () => (await inject("GET", detailUrl)).json<CapabilityPluginDetail>();
    const snapshotId = (await readDetail()).pieces[0]!.skillSnapshotId!;
    const step = await inject("POST", "/api/v1/capabilities/skills/operations", {
      workspaceId: WORKSPACE_ID,
      snapshotId,
      operationKind: "install_inactive",
    });
    expect(step.statusCode, step.body).toBe(202);
    await vi.waitFor(async () => expect((await readDetail()).pieces[0]?.state).toBe("installed_off"), STEP_WAIT);
  }

  it(
    "removes it through its own approval, and the same plugin can be installed again",
    { timeout: 600_000 },
    async () => {
      await installPlugin();
      await installSkillOnly();
      const uninstalled = await inject("POST", "/api/v1/capabilities/plugins/uninstall", {
        workspaceId: WORKSPACE_ID,
        pluginId: "reference-plugin",
      });
      expect(uninstalled.statusCode, uninstalled.body).toBe(202);
      expect(uninstalled.json<PluginActionOutcome>().outcome).toBe("applied");

      // The new check lists the left-over and offers its removal, by its skill id.
      const blocked = await inspect();
      expect(blocked.installable).toBe(false);
      expect(blocked.pieces.find((piece) => piece.kind === "skill")?.check).toEqual({
        status: "blocked",
        code: expect.stringMatching(/^(SOURCE_ALREADY_INSTALLED|CANDIDATE_ALREADY_EXISTS)$/u),
        message: LEFT_OVER,
        removableSkillId: SKILL_ID,
      });

      // Asked for with the operator's skip setting on: it still waits for its own danger approval.
      const asked = await inject("POST", "/api/v1/capabilities/skills/removals", {
        workspaceId: WORKSPACE_ID,
        skillId: SKILL_ID,
      });
      expect(asked.statusCode, asked.body).toBe(202);
      const removal = asked.json<CapabilitySkillRemovalOutcome>();
      expect(removal.status).toBe("waiting");
      const readUrl = `/api/v1/capabilities/skills/removals/${encodeURIComponent(removal.approvalId)}?workspaceId=${WORKSPACE_ID}`;
      expect((await inject("GET", readUrl)).json<CapabilitySkillRemovalRead>()).toEqual({
        approvalId: removal.approvalId,
        approvalStatus: "pending",
      });
      const approved = await inject("POST", `/api/v1/approvals/${removal.approvalId}/resolve`, { decision: "approve" });
      expect(approved.statusCode, approved.body).toBe(200);
      await vi.waitFor(async () => {
        expect((await inject("GET", readUrl)).json<CapabilitySkillRemovalRead>().settlement).toMatchObject({
          disposition: "applied",
        });
      }, STEP_WAIT);
      // Nothing was ever in the skills folder for it, and nothing appears there.
      expect(fs.existsSync(path.join(root, "skills", "extra", "meeting-notes"))).toBe(false);

      // Checked again, the same plugin installs, and its skill takes its first step as a new lineage.
      await installPlugin();
      await installSkillOnly();
    },
  );
});

function writeConfig(configDir: string): void {
  fs.mkdirSync(configDir, { recursive: true });
  const repoConfig = path.join(REPO_ROOT, "config");
  for (const name of [
    "assistant.config.example.json",
    "tool-policy.example.json",
    "budgets.example.json",
    "cron-jobs.example.json",
  ]) {
    fs.copyFileSync(path.join(repoConfig, name), path.join(configDir, name));
  }
  const config = JSON.parse(fs.readFileSync(path.join(repoConfig, "goatcitadel.example.json"), "utf8"));
  config.assistant.approvalExplainer.enabled = false;
  config.assistant.features = {
    ...config.assistant.features,
    evolutionControlPlaneV1Enabled: true,
    settingsApprovalSkipEnabled: true,
  };
  fs.writeFileSync(path.join(configDir, "goatcitadel.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(configDir, "llm-model-metadata.json"), JSON.stringify({ version: 1, entries: {} }));
}
