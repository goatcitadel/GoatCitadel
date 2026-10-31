import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CapabilityPluginInspection, McpServerRecord } from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import { CapabilityPluginStore, type StoredPlugin } from "./services/capability-plugin-store.js";
import { GatewayService } from "./services/gateway-service.js";
import { createMcpServer, type McpServerAdminHost } from "./services/mcp-server-admin-service.js";
import { preparePromptPackImport } from "./services/prompt-pack/prepare-import.js";

/**
 * A plugin's pieces are read-only to every other editor, over the real Gateway's routes. Nothing installs a plugin yet,
 * so the pieces and the plugin's record are written straight into their owners and the plugin store; the Skill Hub
 * check is the real one a plugin inspection makes. Switching a piece on and off still works, and a plugin's "turn this
 * group off" is a hold of its own: the operator's switch is never written, and another plugin's check doesn't read the
 * hold as the operator's switch.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TOKEN = "capability-plugin-ownership-test-operator-1234567890";
const WORKSPACE_ID = "default";
const PLUGIN_ID = "meeting-tools";
const OTHER_PLUGIN_ID = "repo-rules";
const PLUGIN_PACK_ID = `plugin-${PLUGIN_ID}-checks`;
const INSPECTIONS_URL = "/api/v1/capabilities/plugins/inspections";
const FROM_PLUGIN = {
  error: "From Meeting tools. Uninstall it to remove this.",
  code: "PLUGIN_OWNED",
  details: { pluginId: PLUGIN_ID },
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

const SKILL_MD = [
  "---",
  "name: meeting-notes",
  "description: Takes notes in meetings.",
  "metadata:",
  "  version: 1.0.0",
  "  tools: [memory.read]",
  "---",
  "",
  "Take short notes and list the actions.",
  "",
].join("\n");
const PROMPT_PACK_MD = [
  "# Meeting checks",
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
  pluginId: PLUGIN_ID,
  name: "Meeting tools",
  description: "Notes and checks for meetings.",
  version: "1.0.0",
  pieces: [{ kind: "skill", id: "meeting-notes", path: "skills/meeting-notes" }],
};
const REPO_RULES = {
  schemaVersion: 1,
  pluginId: OTHER_PLUGIN_ID,
  name: "Repo rules",
  description: "Keeps the browser off.",
  version: "1.0.0",
  pieces: [{ kind: "tool_group_off", id: "no-browser", groupId: "browser" }],
};

describe("a plugin's pieces over the real Gateway", { timeout: 300_000 }, () => {
  const originalEnv = new Map<string, string | undefined>();
  let root = "";
  let app: FastifyInstance | undefined;
  let gateway: GatewayService | undefined;
  let sequence = 0;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-plugin-ownership-"));
    writeConfig(path.join(root, "config"));
    writePlugin(path.join(root, "plugins", PLUGIN_ID), MEETING_TOOLS, {
      "skills/meeting-notes/SKILL.md": SKILL_MD,
      "skills/meeting-notes/LICENSE": "MIT\n",
    });
    writePlugin(path.join(root, "plugins", OTHER_PLUGIN_ID), REPO_RULES, {});
    for (const [key, value] of Object.entries({ ...ENV, GOATCITADEL_ROOT_DIR: root })) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    // The app's runtime facade keeps the Gateway's owners to itself; the fixture pieces are written through them, so the
    // Gateway is caught as it starts.
    const caught = vi.spyOn(GatewayService.prototype, "initCritical");
    try {
      app = await buildApp();
      await app.ready();
      gateway = caught.mock.contexts[0] as GatewayService | undefined;
    } finally {
      caught.mockRestore();
    }
    expect(gateway).toBeDefined();
  }, 300_000);

  afterAll(async () => {
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

  async function inject(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) {
    return await app!.inject({
      method,
      url,
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": `plugin-ownership-${++sequence}` },
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

  async function readServer(serverId: string): Promise<McpServerRecord> {
    const listed = await inject("GET", "/api/v1/mcp/servers");
    expect(listed.statusCode, listed.body).toBe(200);
    return listed.json<{ items: McpServerRecord[] }>().items.find((server) => server.serverId === serverId)!;
  }

  it("refuses editing or removing each piece with the plugin's name, and still switches them", async () => {
    const live = gateway!;
    const skillSnapshotId = (await inspect(PLUGIN_ID)).pieces[0]!.skillSnapshotId!;
    const operate = (operationKind: string) =>
      inject("POST", "/api/v1/skills/hub/operations", {
        workspaceId: WORKSPACE_ID,
        snapshotId: skillSnapshotId,
        operationKind,
      });

    // Before the plugin is installed, its skill's check still came with a plugin, so nothing installs it this way.
    const early = await operate("install_inactive");
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json()).toEqual({
      error: "This skill came with a plugin that isn't installed.",
      code: "PLUGIN_OWNED",
      details: { pluginId: PLUGIN_ID },
    });

    // The pieces an install would add, and the plugin's record listing them.
    const owner = { pluginId: PLUGIN_ID, name: "Meeting tools", installPlanId: "plan-install-1" };
    const mcpAdministration = (live as unknown as { mcpAdministration: McpServerAdminHost }).mcpAdministration;
    const server = await createMcpServer(
      mcpAdministration,
      { label: "Meeting issues", transport: "stdio", command: "node", args: ["meeting-issues.mjs"], enabled: false },
      undefined,
      undefined,
      undefined,
      owner,
    );
    const hook = await live.storage.workspaceHooks.create({
      workspaceId: WORKSPACE_ID,
      label: "Tool watch",
      trigger: "tool.call.after",
      mode: "observe",
      dataScope: "metadata",
      action: {
        type: "webhook",
        webhook: { url: "https://1.1.1.1/goatcitadel", secretRef: `keychain:goatcitadel:hook:${randomUUID()}` },
      },
    });
    const prepared = preparePromptPackImport({ content: PROMPT_PACK_MD, packId: PLUGIN_PACK_ID }).write;
    await live.storage.promptPacks.createPackWithTestsIfAbsent({ ...prepared, packId: PLUGIN_PACK_ID });
    await new CapabilityPluginStore(live.storage.systemSettings).update(PLUGIN_ID, () =>
      installedRecord({ serverId: server.serverId, hookId: hook.hookId, skillSnapshotId }),
    );

    // Connector: Advanced setup's edit, its approval setting and removal are refused; switching and disconnecting aren't.
    const saved = await readServer(server.serverId);
    expect(saved.pluginOwner).toEqual(owner);
    const serverUrl = `/api/v1/mcp/servers/${server.serverId}`;
    for (const [method, url, payload] of [
      ["PATCH", serverUrl, { label: "Renamed", expectedRevision: saved.revision }],
      ["PATCH", `${serverUrl}/policy`, { approvalPosture: "everything_asks", expectedRevision: saved.revision }],
      ["DELETE", serverUrl, { expectedRevision: saved.revision }],
    ] as const) {
      const refused = await inject(method, url, payload);
      expect(refused.statusCode, `${method} ${url} ${refused.body}`).toBe(409);
      expect(refused.json()).toEqual(FROM_PLUGIN);
    }
    expect(await readServer(server.serverId)).toMatchObject({ label: "Meeting issues", revision: saved.revision });
    const switchedOn = await inject("PATCH", serverUrl, { enabled: true, expectedRevision: saved.revision });
    expect(switchedOn.statusCode, switchedOn.body).toBe(200);
    expect(switchedOn.json()).toMatchObject({ enabled: true, pluginOwner: owner });
    const switchedOff = await inject("PATCH", serverUrl, {
      enabled: false,
      expectedRevision: switchedOn.json<McpServerRecord>().revision,
    });
    expect(switchedOff.json()).toMatchObject({ enabled: false });
    const disconnected = await inject("POST", `${serverUrl}/disconnect`);
    expect(disconnected.statusCode, disconnected.body).toBe(200);

    // Hook: Settings › Hooks edit and delete are refused; switching it off and on isn't.
    const hookUrl = `/api/v1/workspaces/${WORKSPACE_ID}/hooks/${hook.hookId}`;
    for (const [method, payload] of [
      ["PATCH", { label: "Renamed" }],
      ["PATCH", { enabled: false, priority: 5 }],
      ["DELETE", undefined],
    ] as const) {
      const refused = await inject(method, hookUrl, payload);
      expect(refused.statusCode, `${method} ${refused.body}`).toBe(409);
      expect(refused.json()).toEqual(FROM_PLUGIN);
    }
    const hookOff = await inject("PATCH", hookUrl, { enabled: false });
    expect(hookOff.statusCode, hookOff.body).toBe(200);
    expect(hookOff.json()).toMatchObject({ hookId: hook.hookId, label: "Tool watch", enabled: false });
    expect((await inject("PATCH", hookUrl, { enabled: true })).json()).toMatchObject({ enabled: true });

    // Prompt pack: importing over it and clearing its runs are refused; an import with no id still gets its own.
    for (const [url, payload] of [
      ["/api/v1/prompt-packs/import", { content: `${PROMPT_PACK_MD}\nChanged.\n`, packId: PLUGIN_PACK_ID }],
      [`/api/v1/prompt-packs/${PLUGIN_PACK_ID}/reset`, {}],
    ] as const) {
      const refused = await inject("POST", url, payload);
      expect(refused.statusCode, `${url} ${refused.body}`).toBe(409);
      expect(refused.json()).toEqual(FROM_PLUGIN);
    }
    const ordinary = await inject("POST", "/api/v1/prompt-packs/import", { content: PROMPT_PACK_MD });
    expect(ordinary.statusCode, ordinary.body).toBe(200);
    expect(ordinary.json<{ pack: { packId: string } }>().pack.packId).toMatch(/^pack-/u);

    // Skill: the old Skill Hub operations route now names the installed plugin, for every step.
    for (const operationKind of [
      "install_inactive",
      "stage_update_candidate",
      "stage_rollback_candidate",
      "activate",
    ]) {
      const refused = await operate(operationKind);
      expect(refused.statusCode, `${operationKind} ${refused.body}`).toBe(409);
      expect(refused.json()).toEqual(FROM_PLUGIN);
    }

    // Hold: another plugin's check reads the operator's own switch, not this plugin's hold. The check's own save
    // writes the plugin store, which reads the holds again.
    const other = await inspect(OTHER_PLUGIN_ID);
    expect(other.pieces.map((piece) => [piece.pieceId, piece.check])).toEqual([["no-browser", { status: "ready" }]]);
    await vi.waitFor(() => expect(live.policyEngine.listSwitchedOffToolNames().has("browser.navigate")).toBe(true));
    const settings = await inject("GET", "/api/v1/settings");
    expect(settings.json()).toMatchObject({
      switchedOffToolGroups: ["browser"],
      pluginToolGroupHolds: [{ groupId: "browser", pluginId: PLUGIN_ID, pluginName: "Meeting tools" }],
    });
    // Now the hold is in force and the settings read browser as off, another check of the other plugin still reads
    // the operator's own switch: its piece is ready, never "already there" because of Meeting tools' hold.
    const whileHeld = await inspect(OTHER_PLUGIN_ID);
    expect(whileHeld.pieces.map((piece) => [piece.pieceId, piece.check])).toEqual([
      ["no-browser", { status: "ready" }],
    ]);
    expect((await inject("GET", "/api/v1/settings")).json()).toMatchObject({ switchedOffToolGroups: ["browser"] });
    const tools = await inject("GET", `/api/v1/capabilities/tools?workspaceId=${WORKSPACE_ID}`);
    expect(
      tools
        .json<{ groups: Array<{ groupId: string; state: string }> }>()
        .groups.find((group) => group.groupId === "browser"),
    ).toMatchObject({ state: "off" });
    // The operator's own switch, in the tool policy file, was never written.
    const readOwnSwitch = () =>
      JSON.parse(fs.readFileSync(path.join(root, "config", "tool-policy.json"), "utf8")).tools?.disabledGroups ?? [];
    expect(readOwnSwitch()).toEqual([]);

    // The Tools switch's own save can't switch a held group on: refused before any plan is made.
    const plans = async () => (await live.storage.changePlans.list({ workspaceId: WORKSPACE_ID, limit: 200 })).length;
    const approvals = async () => (await inject("GET", "/api/v1/approvals")).json<{ items: unknown[] }>().items.length;
    const [plansBefore, approvalsBefore] = [await plans(), await approvals()];
    const revision = () => inject("GET", "/api/v1/settings").then((read) => read.json<{ revision: number }>().revision);
    const switchOn = await inject("PATCH", "/api/v1/settings", {
      expectedRevision: await revision(),
      toolGroupChange: { groupId: "browser", enabled: true },
    });
    expect(switchOn.statusCode, switchOn.body).toBe(409);
    expect(switchOn.json()).toEqual(FROM_PLUGIN);
    expect([await plans(), await approvals()]).toEqual([plansBefore, approvalsBefore]);
    expect(readOwnSwitch()).toEqual([]);
    // The generic Change Plan route reaches the same settings check, before any plan is written.
    const planned = await inject("POST", "/api/v1/change-plans", {
      surface: "settings",
      request: {
        kind: "runtime_configuration",
        change: { operation: "tool_group_access", groupId: "browser", enabled: true },
      },
    });
    expect(planned.statusCode, planned.body).toBe(409);
    expect(planned.json()).toEqual(FROM_PLUGIN);
    expect([await plans(), await approvals()]).toEqual([plansBefore, approvalsBefore]);
    expect(readOwnSwitch()).toEqual([]);

    // Switching the held group off is the operator's own switch: it completes and is kept.
    const switchOff = await inject("PATCH", "/api/v1/settings", {
      expectedRevision: await revision(),
      toolGroupChange: { groupId: "browser", enabled: false },
    });
    expect(switchOff.statusCode, switchOff.body).toBe(200);
    expect(switchOff.json()).toMatchObject({
      switchedOffToolGroups: ["browser"],
      changePlanReceipt: { status: "completed" },
    });
    expect(readOwnSwitch()).toEqual(["browser"]);
  });
});

/** The record an install of Meeting tools would leave: a connector, a hold, a hook, a prompt pack and a skill check. */
function installedRecord(refs: { serverId: string; hookId: string; skillSnapshotId: string }): StoredPlugin {
  return {
    pluginId: PLUGIN_ID,
    name: "Meeting tools",
    description: "Notes and checks for meetings.",
    version: "1.0.0",
    trust: "built_in",
    sourceKind: "built_in",
    sourceDisplay: "Ships with GoatCitadel",
    pin: { kind: "content", treeSha256: "a".repeat(64) },
    manifestSha256: "b".repeat(64),
    snapshotTreeSha256: "a".repeat(64),
    workspaceId: WORKSPACE_ID,
    installPlanId: "plan-install-1",
    state: "installed",
    installedAt: "2026-10-31T00:00:00.000Z",
    pieces: [
      { pieceId: "meeting-notes", kind: "skill", owned: true, skillSnapshotId: refs.skillSnapshotId },
      { pieceId: "issues", kind: "connector", owned: true, ref: refs.serverId },
      { pieceId: "no-browser", kind: "tool_group_off", owned: true, ref: "browser" },
      { pieceId: "tool-watch", kind: "hook", owned: true, ref: refs.hookId },
      { pieceId: "checks", kind: "prompt_pack", owned: true, ref: PLUGIN_PACK_ID },
    ],
  };
}

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
  fs.writeFileSync(path.join(configDir, "goatcitadel.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(configDir, "llm-model-metadata.json"), JSON.stringify({ version: 1, entries: {} }));
}
