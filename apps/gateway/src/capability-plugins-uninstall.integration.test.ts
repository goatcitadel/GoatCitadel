import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CapabilityPluginDetail,
  CapabilityPluginInspection,
  CapabilityPluginListResponse,
  CapabilitySkillItem,
  McpServerRecord,
  PluginActionOutcome,
} from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import { CapabilityPluginStore } from "./services/capability-plugin-store.js";
import { GatewayService } from "./services/gateway-service.js";
import { resolvePromptPackExportPath } from "./services/prompt-pack/import-export.js";

/**
 * Uninstalling a plugin over the real Gateway: its route, the real Change Plan control plane and the real owner of every
 * piece. The SDK's reference plugin (one skill and one prompt pack) ships as a built-in plugin here, beside one plugin
 * with a connector, a tool group hold, a hook and a prompt pack. The OS key store is replaced by a map, as this
 * machine's key store is off in tests.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REFERENCE_PLUGIN = path.join(REPO_ROOT, "packages", "extensions-sdk", "templates", "plugins", "reference-plugin");
const TOKEN = "capability-plugins-uninstall-test-operator-1234567890";
const WORKSPACE_ID = "default";
const INSPECTIONS_URL = "/api/v1/capabilities/plugins/inspections";
const INSTALL_URL = "/api/v1/capabilities/plugins/install";
const UNINSTALL_URL = "/api/v1/capabilities/plugins/uninstall";
const SKILL_STEPS_URL = "/api/v1/capabilities/skills/operations";
const STEP_WAIT = { timeout: 120_000, interval: 250 } as const;
const HOOK_SECRET = "whsec-meeting-tools-uninstall-0123456789";
const REMOVED_EARLIER =
  "This skill was removed with an earlier install. It can't come back until skills can be removed.";
const PROMPT_PACK_MD = [
  "# Meeting checks",
  "",
  "Pack-Version: Meeting checks",
  "",
  "# Chat",
  "",
  "## No Tools",
  "",
  "### TEST-C901: Summary",
  "",
  "Summarize the meeting in two lines.",
  "",
].join("\n");
const MEETING_TOOLS = {
  schemaVersion: 1,
  pluginId: "meeting-tools",
  name: "Meeting tools",
  description: "Notes and checks for meetings.",
  version: "1.0.0",
  pieces: [
    { kind: "connector", id: "issues", templateId: "linear" },
    { kind: "tool_group_off", id: "no-browser", groupId: "browser" },
    // A public address as a literal, so neither the check nor the hook needs DNS.
    { kind: "hook", id: "tool-watch", trigger: "tool.call.after", url: "https://1.1.1.1/goatcitadel" },
    { kind: "prompt_pack", id: "checks", path: "prompt-packs/checks.md" },
  ],
};

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
  GOATCITADEL_DATABASE_DRIVER: "sqlite",
  GOATCITADEL_DISABLE_SECRET_STORE: "true",
  GOATCITADEL_LLAMACPP_AUTOSTART: "false",
  GOATCITADEL_LLAMACPP_ENABLED: "false",
  GOATCITADEL_NPU_AUTOSTART: "false",
  GOATCITADEL_NPU_ENABLED: "false",
  GOATCITADEL_RATE_LIMIT_ENABLED: "false",
};

describe("uninstalling a plugin over the real Gateway", { timeout: 300_000 }, () => {
  const originalEnv = new Map<string, string | undefined>();
  const keychain = new Map<string, string>();
  let root = "";
  let app: FastifyInstance | undefined;
  let gateway: GatewayService | undefined;
  let sequence = 0;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-plugin-uninstall-"));
    writeConfig(path.join(root, "config"));
    fs.cpSync(REFERENCE_PLUGIN, path.join(root, "plugins", "reference-plugin"), { recursive: true });
    writePlugin(path.join(root, "plugins", "meeting-tools"), MEETING_TOOLS, {
      "prompt-packs/checks.md": PROMPT_PACK_MD,
    });
    for (const [key, value] of Object.entries({ ...ENV, GOATCITADEL_ROOT_DIR: root })) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    const caught = vi.spyOn(GatewayService.prototype, "initCritical");
    try {
      app = await buildApp();
      await app.ready();
      gateway = caught.mock.contexts[0] as GatewayService | undefined;
    } finally {
      caught.mockRestore();
    }
    expect(gateway).toBeDefined();
    // The key store this machine's tests run without, as a map: the hooks owner and the plugins share the instance.
    const store = gateway!.secretStore;
    vi.spyOn(store, "setSecret").mockImplementation((account, secret) => void keychain.set(account, secret));
    vi.spyOn(store, "getSecret").mockImplementation((account) => keychain.get(account));
    vi.spyOn(store, "deleteSecret").mockImplementation((account) => void keychain.delete(account));
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

  async function inject(method: "GET" | "POST", url: string, payload?: Record<string, unknown>, key?: string) {
    return await app!.inject({
      method,
      url,
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": key ?? `plugin-uninstall-${++sequence}` },
      ...(payload ? { payload } : {}),
    });
  }

  async function inspect(pluginId: string): Promise<CapabilityPluginInspection> {
    const created = await inject("POST", INSPECTIONS_URL, {
      workspaceId: WORKSPACE_ID,
      source: { kind: "built_in", pluginId },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json<CapabilityPluginInspection>();
  }

  async function install(pluginId: string, hookSecrets?: Record<string, string>): Promise<PluginActionOutcome> {
    const inspection = await inspect(pluginId);
    expect(inspection.installable, JSON.stringify(inspection.pieces)).toBe(true);
    const installed = await inject("POST", INSTALL_URL, {
      workspaceId: WORKSPACE_ID,
      inspectionId: inspection.inspectionId,
      ...(hookSecrets ? { hookSecrets } : {}),
    });
    expect(installed.statusCode, installed.body).toBe(202);
    const outcome = installed.json<PluginActionOutcome>();
    expect(outcome.outcome, outcome.summary).toBe("applied");
    return outcome;
  }

  async function uninstall(pluginId: string, key?: string) {
    return await inject("POST", UNINSTALL_URL, { workspaceId: WORKSPACE_ID, pluginId }, key);
  }

  async function readSkills(): Promise<CapabilitySkillItem[]> {
    return (await inject("GET", `/api/v1/capabilities/skills?workspaceId=${WORKSPACE_ID}`)).json<{
      items: CapabilitySkillItem[];
    }>().items;
  }

  it("removes exactly what a plugin added, and keeps the hosts it allowed", async () => {
    const live = gateway!;
    await install("meeting-tools", { "tool-watch": HOOK_SECRET });
    await vi.waitFor(() => expect(live.policyEngine.listSwitchedOffToolNames().has("browser.navigate")).toBe(true));
    const allowed = (await inject("GET", "/api/v1/settings")).json<{ networkAllowlist: string[] }>().networkAllowlist;
    const hookHostsFile = path.join(root, "config", "tool-policy.json");
    const hookHosts = JSON.parse(fs.readFileSync(hookHostsFile, "utf8")).hooks.networkAllowlist;
    expect(hookHosts).toEqual(["alerts.example.org", "1.1.1.1"]);
    const pack = await live.storage.promptPacks.getPack("plugin-meeting-tools-checks");
    const exportFile = resolvePromptPackExportPath(root, pack);
    expect(fs.existsSync(exportFile)).toBe(true);
    expect(keychain.size).toBe(1);

    const removed = await uninstall("meeting-tools", "uninstall-meeting-tools");

    expect(removed.statusCode, removed.body).toBe(202);
    const outcome = removed.json<PluginActionOutcome>();
    expect(outcome).toEqual({
      planId: expect.any(String),
      outcome: "applied",
      summary: "Removed 4 pieces. Hosts it allowed stay in your allowlist.",
    });
    // Each piece is gone from its own owner.
    const servers = (await inject("GET", "/api/v1/mcp/servers")).json<{ items: McpServerRecord[] }>().items;
    expect(servers.find((server) => server.label === "Linear")).toBeUndefined();
    const hooks = (await inject("GET", `/api/v1/workspaces/${WORKSPACE_ID}/hooks`)).json<{ items: unknown[] }>().items;
    expect(hooks).toEqual([]);
    expect(keychain.size).toBe(0);
    await vi.waitFor(() => expect(live.policyEngine.listSwitchedOffToolNames().has("browser.navigate")).toBe(false));
    expect(live.policyEngine.listPluginToolGroupHolds()).toEqual([]);
    const packs = (await inject("GET", "/api/v1/prompt-packs")).json<{ items: Array<{ packId: string }> }>().items;
    expect(packs.map((item) => item.packId)).not.toContain("plugin-meeting-tools-checks");
    expect(fs.existsSync(exportFile)).toBe(false);
    // The hosts it allowed stay in both allowlists.
    expect((await inject("GET", "/api/v1/settings")).json<{ networkAllowlist: string[] }>().networkAllowlist).toEqual(
      allowed,
    );
    expect(JSON.parse(fs.readFileSync(hookHostsFile, "utf8")).hooks.networkAllowlist).toEqual(hookHosts);
    // The plugin is gone, and ships again as an available one.
    await expect(new CapabilityPluginStore(live.storage.systemSettings).get("meeting-tools")).resolves.toBeUndefined();
    const listed = (
      await inject("GET", `/api/v1/capabilities/plugins?workspaceId=${WORKSPACE_ID}`)
    ).json<CapabilityPluginListResponse>();
    expect(listed.installed.map((item) => item.pluginId)).not.toContain("meeting-tools");
    expect(listed.builtIn.find((item) => item.pluginId === "meeting-tools")?.state).toBe("available");
    const detail = await inject(
      "GET",
      `/api/v1/capabilities/plugins/detail?pluginId=meeting-tools&workspaceId=${WORKSPACE_ID}`,
    );
    expect(detail.statusCode).toBe(404);

    // A retry gets the first answer; an uninstall is undone by installing again, never by a rollback.
    const retried = await uninstall("meeting-tools", "uninstall-meeting-tools");
    expect(retried.json()).toEqual(outcome);
    const plan = await live.storage.changePlans.get(outcome.planId);
    expect(plan).toMatchObject({ kind: "plugin_uninstall", risk: "caution", status: "completed" });
    const rollback = await inject("POST", `/api/v1/change-plans/${outcome.planId}/rollback-requests`, {
      workspaceId: WORKSPACE_ID,
      expectedRevision: plan.revision,
    });
    expect(rollback.statusCode, rollback.body).toBe(409);
    expect(rollback.json()).toMatchObject({ error: "Install the plugin again instead." });
    // Uninstalling it again is a plain 404.
    const again = await uninstall("meeting-tools");
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ error: "This plugin isn't installed." });
  });

  it("revokes a plugin's switched-on skill without asking, names it after the plugin, and blocks a reinstall", async () => {
    await install("reference-plugin");
    const detailUrl = `/api/v1/capabilities/plugins/detail?pluginId=reference-plugin&workspaceId=${WORKSPACE_ID}`;
    const readDetail = async () => (await inject("GET", detailUrl)).json<CapabilityPluginDetail>();
    const snapshotId = (await readDetail()).pieces[0]!.skillSnapshotId!;
    for (const [operationKind, settled] of [
      ["install_inactive", "installed_off"],
      ["activate", "added"],
    ] as const) {
      const step = await inject("POST", SKILL_STEPS_URL, { workspaceId: WORKSPACE_ID, snapshotId, operationKind });
      expect(step.statusCode, step.body).toBe(202);
      await vi.waitFor(async () => expect((await readDetail()).pieces[0]?.state).toBe(settled), STEP_WAIT);
    }
    // The skills list loads it shortly after its switch-on settles.
    await vi.waitFor(async () => {
      expect((await readSkills()).find((item) => item.skillId === "extra:meeting-notes")).toMatchObject({
        callable: true,
        fromPlugin: { pluginId: "reference-plugin", name: "Reference plugin" },
      });
    }, STEP_WAIT);

    const removed = await uninstall("reference-plugin");

    expect(removed.statusCode, removed.body).toBe(202);
    expect(removed.json<PluginActionOutcome>()).toMatchObject({
      outcome: "applied",
      summary: "Removed 2 pieces. Hosts it allowed stay in your allowlist.",
    });
    // Its revoke's own effect applies it; the skill then reads as removed with the plugin, and the AI can't use it.
    await vi.waitFor(async () => {
      const skill = (await readSkills()).find((item) => item.skillId === "extra:meeting-notes");
      expect(skill).toMatchObject({ callable: false, removedWithPlugin: { name: "Reference plugin" } });
      expect(skill).not.toHaveProperty("fromPlugin");
    }, STEP_WAIT);
    const approvals = await gateway!.storage.approvals.list(undefined, 50, WORKSPACE_ID);
    expect(
      approvals.find((approval) => approval.resolutionNote?.startsWith("Applied without asking: you uninstalled")),
    ).toMatchObject({
      kind: "skill_hub.lifecycle",
      status: "approved",
    });

    // Checking the same copy again replays the same check, whose skill can't come back yet.
    const again = await inspect("reference-plugin");
    expect(again.installable).toBe(false);
    expect(again.pieces.find((piece) => piece.kind === "skill")?.check).toEqual({
      status: "blocked",
      code: expect.stringMatching(/^(SOURCE_ALREADY_INSTALLED|CANDIDATE_ALREADY_EXISTS|RUNTIME_ALREADY_EXISTS)$/u),
      message: REMOVED_EARLIER,
    });
  });

  it("can't be created from Chat or the generic plan route", async () => {
    const plans = (await gateway!.storage.changePlans.list({ workspaceId: WORKSPACE_ID, limit: 200 })).length;
    const request = { kind: "plugin_uninstall", pluginId: "meeting-tools", installPlanId: "plan-1" };
    for (const surface of ["chat", "settings"]) {
      const generic = await inject("POST", "/api/v1/change-plans", { surface, request });
      expect(generic.statusCode, generic.body).toBe(400);
    }
    await expect(
      gateway!.evolutionControlPlaneService.create({
        actor: { workspaceId: WORKSPACE_ID, actorId: "model", surface: "chat", sessionId: "s-1", turnId: "t-1" },
        request: request as never,
      }),
    ).rejects.toMatchObject({ httpStatus: 403, details: { diagnosticCode: "plugin_uninstall_untrusted_origin" } });
    expect((await gateway!.storage.changePlans.list({ workspaceId: WORKSPACE_ID, limit: 200 })).length).toBe(plans);
  });
});

function writePlugin(pluginDir: string, manifest: object, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries({
    ...files,
    "goatcitadel-plugin.json": JSON.stringify(manifest, null, 2),
  })) {
    const target = path.join(pluginDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
}

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
  // A hooks allowlist that lists another host, so installing a hook has to add its own.
  config.toolPolicy.hooks = { networkAllowlist: ["alerts.example.org"] };
  fs.writeFileSync(path.join(configDir, "goatcitadel.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(configDir, "llm-model-metadata.json"), JSON.stringify({ version: 1, entries: {} }));
}
