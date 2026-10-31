import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CapabilityPluginInspection,
  CapabilityPluginListResponse,
  McpServerRecord,
  PluginActionOutcome,
} from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import { CapabilityPluginStore } from "./services/capability-plugin-store.js";
import { GatewayService } from "./services/gateway-service.js";

/**
 * Installing a plugin over the real Gateway: its route, the real Change Plan control plane and the real owners of every
 * piece. The SDK's reference plugin ships as a built-in plugin here, beside one plugin with a connector, a tool group
 * hold, a hook and a prompt pack. The OS key store is replaced by a map, as this machine's key store is off in tests.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REFERENCE_PLUGIN = path.join(REPO_ROOT, "packages", "extensions-sdk", "templates", "plugins", "reference-plugin");
const TOKEN = "capability-plugins-install-test-operator-1234567890";
const WORKSPACE_ID = "default";
const INSPECTIONS_URL = "/api/v1/capabilities/plugins/inspections";
const INSTALL_URL = "/api/v1/capabilities/plugins/install";
const HOOK_SECRET = "whsec-meeting-tools-integration-0123456789";
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

describe("installing a plugin over the real Gateway", { timeout: 300_000 }, () => {
  const originalEnv = new Map<string, string | undefined>();
  const keychain = new Map<string, string>();
  let root = "";
  let app: FastifyInstance | undefined;
  let gateway: GatewayService | undefined;
  let sequence = 0;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-plugin-install-"));
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
    // The key store this machine's tests run without, as a map: the hooks owner and the install share the instance.
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
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": key ?? `plugin-install-${++sequence}` },
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

  it("installs the inspected bytes even when the source changed after inspection", async () => {
    const inspection = await inspect("reference-plugin");
    expect(inspection.installable).toBe(true);
    // The shipped folder changes after the check: the install still reads the copy that was checked.
    const shipped = path.join(root, "plugins", "reference-plugin", "prompt-packs", "meeting-notes-check.md");
    const inspected = fs.readFileSync(shipped, "utf8");
    fs.writeFileSync(shipped, inspected.replace("Keeps the decisions", "Something else entirely"));

    const installed = await inject("POST", INSTALL_URL, {
      workspaceId: WORKSPACE_ID,
      inspectionId: inspection.inspectionId,
    });

    expect(installed.statusCode, installed.body).toBe(202);
    const outcome = installed.json<PluginActionOutcome>();
    expect(outcome).toMatchObject({
      outcome: "applied",
      summary: expect.stringMatching(/^Installed Reference plugin\. /u),
    });
    const packs = await inject("GET", "/api/v1/prompt-packs");
    const pack = packs
      .json<{ items: Array<{ packId: string; name: string; sourceLabel: string }> }>()
      .items.find((item) => item.packId === "plugin-reference-plugin-meeting-notes-check");
    expect(pack).toMatchObject({ name: "Meeting notes check 1.0", sourceLabel: "Plugin Reference plugin" });
    const tests = await inject("GET", "/api/v1/prompt-packs/plugin-reference-plugin-meeting-notes-check/tests");
    expect(tests.body).toContain("Keeps the decisions");
    expect(tests.body).not.toContain("Something else entirely");

    // The plugin is listed; its skill still needs its own steps, so the install reads as not finished.
    const listed = (
      await inject("GET", `/api/v1/capabilities/plugins?workspaceId=${WORKSPACE_ID}`)
    ).json<CapabilityPluginListResponse>();
    expect(listed.installed).toEqual([
      expect.objectContaining({ pluginId: "reference-plugin", state: "install_not_finished" }),
    ]);
    const record = await new CapabilityPluginStore(gateway!.storage.systemSettings).get("reference-plugin");
    expect(record).toMatchObject({
      state: "installed",
      installPlanId: outcome.planId,
      pieces: [
        {
          pieceId: "meeting-notes",
          kind: "skill",
          owned: true,
          skillSnapshotId: inspection.pieces[0]?.skillSnapshotId,
        },
        {
          pieceId: "meeting-notes-check",
          kind: "prompt_pack",
          owned: true,
          ref: "plugin-reference-plugin-meeting-notes-check",
        },
      ],
    });
  });

  it("installs every piece, holds the group off in the policy engine, and keeps the secret out of the plan", async () => {
    const live = gateway!;
    const inspection = await inspect("meeting-tools");
    expect(inspection.pieces.map((piece) => [piece.pieceId, piece.check.status])).toEqual([
      ["issues", "ready"],
      ["no-browser", "ready"],
      ["tool-watch", "ready"],
      ["checks", "ready"],
    ]);
    expect(live.policyEngine.listSwitchedOffToolNames().has("browser.navigate")).toBe(false);
    const body = {
      workspaceId: WORKSPACE_ID,
      inspectionId: inspection.inspectionId,
      hookSecrets: { "tool-watch": HOOK_SECRET },
    };
    // A secret for a piece that isn't a hook is refused before anything is stored or planned.
    const extra = await inject("POST", INSTALL_URL, { ...body, hookSecrets: { ...body.hookSecrets, issues: "x1" } });
    expect(extra.statusCode, extra.body).toBe(400);
    expect(extra.json()).toMatchObject({ error: "Only a hook takes a signing secret." });
    expect(keychain.size).toBe(0);

    const installed = await inject("POST", INSTALL_URL, body, "install-meeting-tools");

    expect(installed.statusCode, installed.body).toBe(202);
    const outcome = installed.json<PluginActionOutcome>();
    expect(outcome.outcome, outcome.summary).toBe("applied");
    expect(installed.body).not.toContain(HOOK_SECRET);

    // The hold came from the install's own write, and reached the engine every chat asks.
    await vi.waitFor(() => expect(live.policyEngine.listSwitchedOffToolNames().has("browser.navigate")).toBe(true));
    expect(live.policyEngine.listPluginToolGroupHolds()).toEqual([
      { groupId: "browser", pluginId: "meeting-tools", pluginName: "Meeting tools" },
    ]);

    // The connector is saved switched off and marked as the plugin's; the hook only watches, signed by the stored key.
    const servers = (await inject("GET", "/api/v1/mcp/servers")).json<{ items: McpServerRecord[] }>().items;
    const server = servers.find((item) => item.label === "Linear");
    expect(server).toMatchObject({
      enabled: false,
      pluginOwner: { pluginId: "meeting-tools", name: "Meeting tools", installPlanId: outcome.planId },
      policy: { approvalPosture: "reads_free" },
    });
    const hooks = (await inject("GET", `/api/v1/workspaces/${WORKSPACE_ID}/hooks`)).json<{
      items: Array<{ hookId: string; mode: string; dataScope: string; enabled: boolean; action: unknown }>;
    }>().items;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ mode: "observe", dataScope: "metadata", enabled: true });
    const [ref] = [...keychain.keys()];
    expect(keychain.get(ref!)).toBe(HOOK_SECRET);
    // The hooks allowlist listed another host, so the hook's host joined it, in the tool policy file.
    const toolPolicy = JSON.parse(fs.readFileSync(path.join(root, "config", "tool-policy.json"), "utf8"));
    expect(toolPolicy.hooks.networkAllowlist).toEqual(["alerts.example.org", "1.1.1.1"]);

    // The plan and its events hold the key's reference, never the secret.
    const plan = await live.storage.changePlans.get(outcome.planId);
    const events = await live.storage.changePlans.listEvents(outcome.planId);
    expect(JSON.stringify([plan, events])).not.toContain(HOOK_SECRET);
    expect(plan.request).toMatchObject({
      kind: "plugin_install",
      hookSecretRefs: { "tool-watch": expect.any(String) },
    });
    expect(events.map((event) => event.eventType)).toContain("operator_approval_skipped");

    // A retry of the same request gets the first answer, and stores no second secret.
    const retried = await inject("POST", INSTALL_URL, body, "install-meeting-tools");
    expect(retried.statusCode, retried.body).toBe(202);
    expect(retried.json()).toEqual(outcome);
    expect(keychain.size).toBe(1);

    // An install plan is undone by uninstalling the plugin, never by a rollback.
    const rollback = await inject("POST", `/api/v1/change-plans/${outcome.planId}/rollback-requests`, {
      workspaceId: WORKSPACE_ID,
      expectedRevision: plan.revision,
    });
    expect(rollback.statusCode, rollback.body).toBe(409);
    expect(rollback.json()).toMatchObject({ error: "Uninstall the plugin instead." });

    // Installing it again is refused before any secret is stored.
    const again = await inject("POST", INSTALL_URL, body);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ error: "Meeting tools is already installed." });
    expect(keychain.size).toBe(1);
  });

  it("can't be created from Chat or the generic plan route", async () => {
    const plans = (await gateway!.storage.changePlans.list({ workspaceId: WORKSPACE_ID, limit: 200 })).length;
    const request = {
      kind: "plugin_install",
      inspectionId: "4b5c3a3e-6f0e-4c1d-9a7e-2f1b0c9d8e7f",
      manifestSha256: "a".repeat(64),
      snapshotTreeSha256: "b".repeat(64),
      workspaceId: WORKSPACE_ID,
    };
    for (const surface of ["chat", "settings"]) {
      const generic = await inject("POST", "/api/v1/change-plans", { surface, request });
      expect(generic.statusCode, generic.body).toBe(400);
    }
    // A model's `change.request` reaches the control plane as a Chat plan: the install's own origin rule refuses it.
    await expect(
      gateway!.evolutionControlPlaneService.create({
        actor: { workspaceId: WORKSPACE_ID, actorId: "model", surface: "chat", sessionId: "s-1", turnId: "t-1" },
        request: request as never,
      }),
    ).rejects.toMatchObject({ httpStatus: 403, details: { diagnosticCode: "plugin_install_untrusted_origin" } });
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
