import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CapabilityConnectorItem,
  CapabilityPluginDetail,
  CapabilityPluginInspection,
  CapabilityPluginListResponse,
  CapabilitySkillItem,
  CapabilityToolGroupItem,
  HookRecord,
  McpServerRecord,
  PluginActionOutcome,
} from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import { CapabilityPluginInspectionService } from "./services/capability-plugin-inspection-service.js";
import { CapabilityPluginStore } from "./services/capability-plugin-store.js";
import { GatewayService } from "./services/gateway-service.js";
import { MCP_SERVER_TEMPLATES } from "./services/mcp-server-templates.js";
import { SkillHubLifecycleFilesystem } from "./services/skill-hub-lifecycle-filesystem.js";
import { materializeApprovedSkillHubIntent } from "./services/skill-hub-lifecycle-service.js";
import { SkillHubOperatorService } from "./services/skill-hub-operator-service.js";
import {
  PowerShellSkillHubWindowsSecurityProtocol,
  SkillHubWindowsSecurityError,
} from "./services/skill-hub-windows-security.js";

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
const SKILL_STEPS_URL = "/api/v1/capabilities/skills/operations";
const STEP_WAIT = { timeout: 120_000, interval: 250 } as const;
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

const NOTES_KIT = {
  schemaVersion: 1,
  pluginId: "notes-kit",
  name: "Notes kit",
  description: "One skill for notes.",
  version: "1.0.0",
  pieces: [{ kind: "skill", id: "notes", path: "skills/notes" }],
};
const ACTIVATION_FIXTURES = {
  "already pending": "pending-notes-kit",
  "created after removal": "late-notes-kit",
  "created after reinstall": "reinstalled-notes-kit",
  "effect first": "first-effect-notes-kit",
} as const;

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
  let windowsSecurityProtocol: PowerShellSkillHubWindowsSecurityProtocol | undefined;
  let sequence = 0;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-plugin-install-"));
    writeConfig(path.join(root, "config"));
    fs.cpSync(REFERENCE_PLUGIN, path.join(root, "plugins", "reference-plugin"), { recursive: true });
    // A plugin that is only ever checked here, never installed, with its own copy of the reference skill.
    writePlugin(path.join(root, "plugins", "notes-kit"), NOTES_KIT, {
      "skills/notes/SKILL.md": fs
        .readFileSync(path.join(REFERENCE_PLUGIN, "skills", "meeting-notes", "SKILL.md"), "utf8")
        .replace("name: meeting-notes", "name: notes-kit-notes"),
    });
    writePlugin(path.join(root, "plugins", "meeting-tools"), MEETING_TOOLS, {
      "prompt-packs/checks.md": PROMPT_PACK_MD,
    });
    for (const pluginId of Object.values(ACTIVATION_FIXTURES)) {
      writePlugin(path.join(root, "plugins", pluginId), { ...NOTES_KIT, pluginId, name: pluginId }, {
        "skills/notes/SKILL.md": fs
          .readFileSync(path.join(REFERENCE_PLUGIN, "skills", "meeting-notes", "SKILL.md"), "utf8")
          .replace("name: meeting-notes", `name: ${pluginId}-notes`),
      });
    }
    if (process.platform === "win32") {
      // As in the lifecycle suite, keep one native ACL/reparse worker through the fixture's bursts of checks.
      const worker = new PowerShellSkillHubWindowsSecurityProtocol({ idleShutdownMs: Number.POSITIVE_INFINITY });
      windowsSecurityProtocol = worker;
      const request = PowerShellSkillHubWindowsSecurityProtocol.prototype.request;
      vi.spyOn(PowerShellSkillHubWindowsSecurityProtocol.prototype, "request").mockImplementation(
        (...args) => request.call(worker, ...args),
      );
    }
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
    try {
      await app?.close();
    } finally {
      windowsSecurityProtocol?.dispose();
    }
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

  async function inspectActivationFixture(pluginId: string): Promise<CapabilityPluginInspection> {
    const original = CapabilityPluginInspectionService.prototype.inspect;
    let failure: string | undefined;
    const diagnose = vi.spyOn(CapabilityPluginInspectionService.prototype, "inspect").mockImplementationOnce(
      async function (this: CapabilityPluginInspectionService, input) {
        try {
          return await original.call(this, input);
        } catch (error) {
          failure = error instanceof SkillHubWindowsSecurityError
            ? `SkillHubWindowsSecurityError/${error.code}`
            : "other inspection error";
          throw error;
        }
      },
    );
    try {
      const response = await inject("POST", INSPECTIONS_URL, {
        workspaceId: WORKSPACE_ID,
        source: { kind: "built_in", pluginId },
      });
      expect(response.statusCode, failure ?? response.body).toBe(201);
      return response.json<CapabilityPluginInspection>();
    } finally {
      diagnose.mockRestore();
    }
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
      expect.objectContaining({
        pluginId: "reference-plugin",
        state: "install_not_finished",
        workspaceId: WORKSPACE_ID,
        sourceKind: "built_in",
      }),
    ]);
    // This install's config turns the skip on, and the list answers it with the folder rule and no issues.
    expect(listed).toMatchObject({ operatorApprovalSkip: true, folderSourcesAllowed: true, issues: [] });
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

    // Cancelling the finished plan is refused, and the hook's secret stays in the key store.
    const cancelled = await inject("POST", `/api/v1/change-plans/${outcome.planId}/cancellations`, {
      workspaceId: WORKSPACE_ID,
      expectedRevision: plan.revision,
      actionNonce: "x".repeat(16),
    });
    expect(cancelled.statusCode, cancelled.body).toBe(409);
    expect(keychain.get(ref!)).toBe(HOOK_SECRET);
    // The hooks owner signs the hook's deliveries with the secret the install stored, through its own key-store
    // custody (a second custody over the same key store as the install's).
    const hook = await live.storage.workspaceHooks.get(WORKSPACE_ID, hooks[0]!.hookId);
    const signer = live.hooksService as unknown as { resolveWebhookSigningSecret(record: HookRecord): string };
    expect(signer.resolveWebhookSigningSecret(hook)).toBe(HOOK_SECRET);

    // Installing it again is refused before any secret is stored.
    const again = await inject("POST", INSTALL_URL, body);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ error: "Meeting tools is already installed." });
    expect(keychain.size).toBe(1);
  });

  it("follows a plugin's skill through its own steps, then reads the plugin installed and marks its pieces", async () => {
    // Continues from the two installs above: the reference plugin's skill still needs its own steps, and Meeting
    // tools saved a connector and holds Browser off.
    const detailUrl = `/api/v1/capabilities/plugins/detail?pluginId=reference-plugin&workspaceId=${WORKSPACE_ID}`;
    const readDetail = async () => {
      const response = await inject("GET", detailUrl);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<CapabilityPluginDetail>();
    };
    const before = await readDetail();
    expect(before.state).toBe("install_not_finished");
    expect(before.author).toBe("GoatCitadel");
    expect(before).toMatchObject({
      workspaceId: WORKSPACE_ID,
      sourceKind: "built_in",
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(before.pieces.map((piece) => [piece.pieceId, piece.state])).toEqual([
      ["meeting-notes", "check_passed"],
      ["meeting-notes-check", "added"],
    ]);
    const snapshotId = before.pieces[0]!.skillSnapshotId!;

    // A plugin's check that no installed plugin lists is refused: its plugin was only checked, never installed.
    const checkedOnly = await inspect("notes-kit");
    const refused = await inject("POST", SKILL_STEPS_URL, {
      workspaceId: WORKSPACE_ID,
      snapshotId: checkedOnly.pieces[0]!.skillSnapshotId,
      operationKind: "install_inactive",
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "PLUGIN_OWNED",
      error: "This skill came with a plugin. Install the plugin to use it.",
    });

    // The installed plugin's skill goes through the Skills tab's own two steps, each with its own approval, which the
    // operator's skip setting approves here.
    for (const [operationKind, settled] of [
      ["install_inactive", "installed_off"],
      ["activate", "added"],
    ] as const) {
      const step = await inject("POST", SKILL_STEPS_URL, { workspaceId: WORKSPACE_ID, snapshotId, operationKind });
      expect(step.statusCode, step.body).toBe(202);
      expect(step.json()).toMatchObject({ status: "approved" });
      await vi.waitFor(async () => expect((await readDetail()).pieces[0]?.state).toBe(settled), STEP_WAIT);
    }

    const after = await readDetail();
    expect(after.state).toBe("installed");
    expect(after.pieces[0]).toMatchObject({
      state: "added",
      href: "/capabilities/skills?item=skill:extra:meeting-notes",
    });
    const listed = (
      await inject("GET", `/api/v1/capabilities/plugins?workspaceId=${WORKSPACE_ID}`)
    ).json<CapabilityPluginListResponse>();
    expect(listed.installed.find((item) => item.pluginId === "reference-plugin")?.state).toBe("installed");

    // Each piece is marked in its own tab with the plugin that added it.
    await vi.waitFor(async () => {
      const skills = (await inject("GET", `/api/v1/capabilities/skills?workspaceId=${WORKSPACE_ID}`)).json<{
        items: CapabilitySkillItem[];
      }>().items;
      expect(skills.find((item) => item.skillId === "extra:meeting-notes")?.fromPlugin).toEqual({
        pluginId: "reference-plugin",
        name: "Reference plugin",
      });
    }, STEP_WAIT);
    const connectors = (await inject("GET", `/api/v1/capabilities/connectors?workspaceId=${WORKSPACE_ID}`)).json<{
      items: CapabilityConnectorItem[];
    }>().items;
    expect(connectors.find((item) => item.name === "Linear")?.fromPlugin).toEqual({
      pluginId: "meeting-tools",
      name: "Meeting tools",
    });
    const tools = (await inject("GET", `/api/v1/capabilities/tools?workspaceId=${WORKSPACE_ID}`)).json<{
      groups: CapabilityToolGroupItem[];
    }>().groups;
    expect(tools.find((group) => group.groupId === "browser")).toMatchObject({
      state: "off",
      heldOffBy: [{ pluginId: "meeting-tools", name: "Meeting tools" }],
    });
  });

  describe("plugin activation revocation", () => {
    const uninstall = (pluginId: string) => inject("POST", "/api/v1/capabilities/plugins/uninstall", {
      workspaceId: WORKSPACE_ID,
      pluginId,
    });

    async function installFixture(pluginId: string) {
      const checked = await inspectActivationFixture(pluginId);
      const snapshotId = checked.pieces[0]?.skillSnapshotId;
      expect(snapshotId).toEqual(expect.any(String));
      const installed = await inject("POST", INSTALL_URL, {
        workspaceId: WORKSPACE_ID,
        inspectionId: checked.inspectionId,
      });
      expect(installed.statusCode, installed.body).toBe(202);
      const result = installed.json<PluginActionOutcome>();
      expect(result.outcome, result.summary).toBe("applied");
      return { snapshotId: snapshotId!, planId: result.planId };
    }

    async function installInactiveFixture(pluginId: string) {
      const installed = await installFixture(pluginId);
      const inactive = await inject("POST", SKILL_STEPS_URL, {
        workspaceId: WORKSPACE_ID,
        snapshotId: installed.snapshotId,
        operationKind: "install_inactive",
      });
      expect(inactive.statusCode, inactive.body).toBe(202);
      const detailUrl = `/api/v1/capabilities/plugins/detail?pluginId=${pluginId}&workspaceId=${WORKSPACE_ID}`;
      await vi.waitFor(async () => {
        const detail = await inject("GET", detailUrl);
        expect(detail.json<CapabilityPluginDetail>().pieces[0]?.state).toBe("installed_off");
      }, STEP_WAIT);
      return installed;
    }

    it.each(["already pending", "created after removal", "created after reinstall"] as const)(
      "keeps the skill off when the delayed operation is %s",
      async (timing) => {
        const pluginId = ACTIVATION_FIXTURES[timing];
        const skillName = `${pluginId}-notes`;
        // An already installed candidate intentionally blocks reinstallation. Reinstall the checked-only plugin,
        // then resolve its earlier install_inactive approval against the identical snapshot under the new plan.
        const reinstall = timing === "created after reinstall";
        const operationKind = reinstall ? "install_inactive" : "activate";
        const { snapshotId, planId } = await (reinstall ? installFixture(pluginId) : installInactiveFixture(pluginId));
        const store = new CapabilityPluginStore(gateway!.storage.systemSettings);
        let releaseCreate!: () => void;
        let releaseReturn!: () => void;
        const allowCreate = new Promise<void>((resolve) => { releaseCreate = resolve; });
        const allowReturn = new Promise<void>((resolve) => { releaseReturn = resolve; });
        let capturedPass: string | undefined;
        let replacementPlanId: string | undefined;
        let approvalId: string | undefined;
        let requestFinished = false;
        const create = SkillHubOperatorService.prototype.createApproval;
        const barrier = vi.spyOn(SkillHubOperatorService.prototype, "createApproval").mockImplementation(
          async function (this: SkillHubOperatorService, input, options) {
            if (input.snapshotId !== snapshotId || input.operationKind !== operationKind) {
              return await create.call(this, input, options);
            }
            capturedPass = options?.pluginPass?.installPlanId;
            await allowCreate;
            const result = await create.call(this, input, options);
            approvalId = result.approval.approvalId;
            await allowReturn;
            return result;
          },
        );
        const activation = inject("POST", SKILL_STEPS_URL, {
          workspaceId: WORKSPACE_ID,
          snapshotId,
          operationKind,
        }).finally(() => { requestFinished = true; });
        void activation.catch(() => undefined);
        const waitForApproval = () => vi.waitFor(() => expect(Boolean(approvalId) || requestFinished).toBe(true), STEP_WAIT);
        const resolve = (decision: "approve" | "reject") =>
          inject("POST", `/api/v1/approvals/${approvalId}/resolve`, { decision });

        try {
          await vi.waitFor(() => expect(Boolean(capturedPass) || requestFinished).toBe(true), STEP_WAIT);
          expect(capturedPass).toBe(planId);
          if (timing === "already pending") {
            releaseCreate();
            await waitForApproval();
            expect(approvalId).toEqual(expect.any(String));
            expect((await gateway!.storage.approvals.get(approvalId!)).status).toBe("pending");
          }

          const removal = await uninstall(pluginId);
          expect(removal.statusCode, removal.body).toBe(202);
          if (timing === "already pending") {
            expect(removal.json<PluginActionOutcome>()).toMatchObject({ outcome: "waiting", approvalId });
            await expect(store.get(pluginId)).resolves.toMatchObject({ state: "uninstalling" });
            const rejected = await resolve("reject");
            expect(rejected.statusCode, rejected.body).toBe(200);
            releaseReturn();
            await activation;
            const finished = await uninstall(pluginId);
            expect(finished.statusCode, finished.body).toBe(202);
            expect(finished.json<PluginActionOutcome>().outcome).toBe("applied");
          } else {
            expect(removal.json<PluginActionOutcome>().outcome).toBe("applied");
            await expect(store.get(pluginId)).resolves.toBeUndefined();
            if (reinstall) {
              const replacement = await installFixture(pluginId);
              expect(replacement.snapshotId).toBe(snapshotId);
              expect(replacement.planId).not.toBe(planId);
              replacementPlanId = replacement.planId;
            }
            releaseCreate();
            await waitForApproval();
            // Exercise the effect fence itself by resolving the persisted approval before the request's second read.
            expect(approvalId).toEqual(expect.any(String));
            expect(await gateway!.storage.approvals.get(approvalId!)).toMatchObject({
              status: "pending",
              preview: { pluginInstallPlanId: planId },
            });
            const approved = await resolve("approve");
            expect(approved.statusCode, approved.body).toBe(200);
            await vi.waitFor(async () => {
              const effects = await gateway!.storage.approvalEffects.listByApproval(approvalId!);
              expect(effects.find((effect) => effect.effectKind === "skill_hub_lifecycle_apply")?.status)
                .toMatch(/^(completed|skipped|failed)$/u);
            }, STEP_WAIT);
            const intent = materializeApprovedSkillHubIntent(await gateway!.storage.approvals.get(approvalId!));
            await expect(gateway!.storage.skillHubOperations.findSettlementByOperationId(intent.operationId))
              .resolves.toMatchObject({
                disposition: "blocked",
                result: { code: "plugin_install_authority_changed", boundaryCrossed: false },
              });
            if (reinstall) {
              expect(intent.targetVersionId).toEqual(expect.any(String));
              await expect(gateway!.storage.candidateSkillVersions.find(intent.targetVersionId!)).resolves.toBeUndefined();
            }
          }
          if (replacementPlanId) {
            await expect(store.get(pluginId)).resolves.toMatchObject({ installPlanId: replacementPlanId });
          } else {
            await expect(store.get(pluginId)).resolves.toBeUndefined();
          }
          expect(await store.listRemoved()).toContainEqual(expect.objectContaining({ pluginId }));
          const lifecycle = await gateway!.storage.skillLifecycle.find(`extra:${skillName}`);
          expect(lifecycle?.lifecycleState).not.toBe("approved");
        } finally {
          releaseCreate();
          releaseReturn();
          await Promise.allSettled([activation]);
          barrier.mockRestore();
        }
      },
    );

    it("lets an effect holding the fence finish before overlapping uninstall revokes it", async () => {
      const pluginId = ACTIVATION_FIXTURES["effect first"];
      const skillName = `${pluginId}-notes`;
      const { snapshotId } = await installInactiveFixture(pluginId);
      const target = path.join(root, "skills", "extra", skillName);
      let releaseProjection!: () => void;
      const allowProjection = new Promise<void>((resolve) => { releaseProjection = resolve; });
      let projectionReached = false;
      let uninstallFinished = false;
      const rename = SkillHubLifecycleFilesystem.prototype.renameDirectory;
      const renameBarrier = vi.spyOn(SkillHubLifecycleFilesystem.prototype, "renameDirectory").mockImplementation(
        async function (this: SkillHubLifecycleFilesystem, ...args) {
          if (args[2] === target) {
            projectionReached = true;
            await allowProjection;
          }
          return await rename.call(this, ...args);
        },
      );
      const activation = inject("POST", SKILL_STEPS_URL, { workspaceId: WORKSPACE_ID, snapshotId, operationKind: "activate" });
      void activation.catch(() => undefined);
      let removal: Promise<PluginActionOutcome> | undefined;
      try {
        await vi.waitFor(() => expect(projectionReached).toBe(true), STEP_WAIT);
        // Enter the same composed owner while SQLite holds the projection transaction. The HTTP idempotency
        // layer would queue before reaching this owner, obscuring the overlap being tested here.
        removal = app!.services.capabilityPlugins!.uninstall({
          workspaceId: WORKSPACE_ID,
          pluginId,
          actorId: "operator",
          idempotencyKey: `plugin-install-${++sequence}`,
        }).finally(() => { uninstallFinished = true; });
        void removal.catch(() => undefined);
        expect(uninstallFinished).toBe(false);
        expect(fs.existsSync(target)).toBe(false);
        releaseProjection();
        const activated = await activation;
        expect(activated.statusCode, activated.body).toBe(202);
        const removed = await removal;
        expect(removed.outcome, removed.summary).toBe("applied");
        const store = new CapabilityPluginStore(gateway!.storage.systemSettings);
        await expect(store.get(pluginId)).resolves.toBeUndefined();
        await expect(gateway!.storage.skillLifecycle.find(`extra:${skillName}`)).resolves.toMatchObject({
          lifecycleState: "revoked",
        });
      } finally {
        releaseProjection();
        await Promise.allSettled([activation, ...(removal ? [removal] : [])]);
        renameBarrier.mockRestore();
      }
    });
  });

  describe("a Claude Code plugin", () => {
    const UNINSTALL_URL = "/api/v1/capabilities/plugins/uninstall";
    const ccDetailUrl = `/api/v1/capabilities/plugins/detail?pluginId=cc-notes&workspaceId=${WORKSPACE_ID}`;
    const readCcDetail = async () => {
      const response = await inject("GET", ccDetailUrl);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<CapabilityPluginDetail>();
    };
    const readAllowlist = async () =>
      (await inject("GET", "/api/v1/settings")).json<{ networkAllowlist: string[] }>().networkAllowlist;

    /** Takes the Microsoft Learn template out of the shipped catalog while `run` runs, as a later release might. */
    async function withoutLearnTemplate<T>(run: () => Promise<T>): Promise<T> {
      const index = MCP_SERVER_TEMPLATES.findIndex((template) => template.templateId === "microsoft-learn");
      expect(index).toBeGreaterThanOrEqual(0);
      const [learn] = MCP_SERVER_TEMPLATES.splice(index, 1);
      try {
        return await run();
      } finally {
        MCP_SERVER_TEMPLATES.splice(index, 0, learn!);
      }
    }

    async function inspectCcNotes(): Promise<CapabilityPluginInspection> {
      const pluginDir = path.join(root, "sources", "cc-notes");
      if (!fs.existsSync(pluginDir)) writeClaudeCodePlugin(pluginDir);
      const created = await inject("POST", INSPECTIONS_URL, {
        workspaceId: WORKSPACE_ID,
        source: { kind: "folder", path: pluginDir },
      });
      expect(created.statusCode, created.body).toBe(201);
      const inspection = created.json<CapabilityPluginInspection>();
      expect(inspection, JSON.stringify(inspection.pieces)).toMatchObject({
        sourceFormat: "claude_code",
        installable: true,
      });
      return inspection;
    }

    it("refuses to apply when the translation changed since the check", async () => {
      const inspection = await inspectCcNotes();

      // A release between the check and the install drops the template the server matched.
      const refused = await withoutLearnTemplate(() =>
        inject("POST", INSTALL_URL, { workspaceId: WORKSPACE_ID, inspectionId: inspection.inspectionId }),
      );

      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ error: "This plugin changed since it was checked. Check it again." });
      await expect(new CapabilityPluginStore(gateway!.storage.systemSettings).get("cc-notes")).resolves.toBeUndefined();
    });

    it("installs a Claude Code plugin's skills and matched connector", async () => {
      const inspection = await inspectCcNotes();

      const installed = await inject("POST", INSTALL_URL, {
        workspaceId: WORKSPACE_ID,
        inspectionId: inspection.inspectionId,
      });

      expect(installed.statusCode, installed.body).toBe(202);
      const outcome = installed.json<PluginActionOutcome>();
      expect(outcome.outcome, outcome.summary).toBe("applied");
      const servers = (await inject("GET", "/api/v1/mcp/servers")).json<{ items: McpServerRecord[] }>().items;
      expect(servers.find((item) => item.label === "Microsoft Learn")).toMatchObject({
        enabled: false,
        pluginOwner: { pluginId: "cc-notes", installPlanId: outcome.planId },
        policy: { approvalPosture: "reads_free" },
      });
      expect(await readAllowlist()).toContain("learn.microsoft.com");
      // The skill goes through the Skills tab's own two steps.
      const skillPiece = async () => (await readCcDetail()).pieces.find((piece) => piece.kind === "skill");
      const snapshotId = (await skillPiece())!.skillSnapshotId!;
      for (const [operationKind, settled] of [
        ["install_inactive", "installed_off"],
        ["activate", "added"],
      ] as const) {
        const step = await inject("POST", SKILL_STEPS_URL, { workspaceId: WORKSPACE_ID, snapshotId, operationKind });
        expect(step.statusCode, step.body).toBe(202);
        await vi.waitFor(async () => expect((await skillPiece())?.state).toBe(settled), STEP_WAIT);
      }
      expect((await readCcDetail()).state).toBe("installed");
    });

    it("lists a Claude Code plugin with its format", async () => {
      const listed = (
        await inject("GET", `/api/v1/capabilities/plugins?workspaceId=${WORKSPACE_ID}`)
      ).json<CapabilityPluginListResponse>();
      expect(listed.installed.find((item) => item.pluginId === "cc-notes")).toMatchObject({
        sourceFormat: "claude_code",
        trust: "unverified",
      });
      expect(listed.installed.find((item) => item.pluginId === "reference-plugin")).not.toHaveProperty("sourceFormat");
    });

    it("keeps the left-out list, coverage and warnings on the installed plugin", async () => {
      const detail = await readCcDetail();
      expect(detail).toMatchObject({
        sourceFormat: "claude_code",
        claudeCode: { translatorVersion: 1, coverage: { usable: 2, total: 4 } },
      });
      expect(detail.ignored?.map((part) => [part.kind, part.label])).toEqual([
        ["command", "go"],
        ["mcp_server", "local"],
      ]);
      expect(detail.pieces.map((piece) => [piece.kind, piece.warnings])).toEqual([
        ["skill", ["Its pre-approved tools aren't kept. Your own tool rules and approvals apply."]],
        ["connector", undefined],
      ]);
      const record = await new CapabilityPluginStore(gateway!.storage.systemSettings).get("cc-notes");
      expect(record?.claudeCode?.manifestText).toEqual(expect.any(String));
      expect(JSON.stringify(detail)).not.toContain("manifestText");
    });

    it("reads an installed plugin's manifest from its record after the translation changes", async () => {
      const detail = await withoutLearnTemplate(() => readCcDetail());
      // Read again, the translation would no longer hold the connector, and every piece would read by its id
      // ("connector-1"). The record's kept text still names its template, which labels it while the catalog lacks it.
      expect(detail.pieces.map((piece) => [piece.kind, piece.pieceId, piece.label])).toEqual([
        ["skill", "cc-notes", "cc-notes"],
        ["connector", "connector-1", "microsoft-learn"],
      ]);
      expect((await readCcDetail()).pieces[1]?.label).toBe("Microsoft Learn");
    });

    it("uninstalls a Claude Code plugin and leaves its hosts allowed", async () => {
      const allowed = await readAllowlist();
      expect(allowed).toContain("learn.microsoft.com");

      const removed = await withoutLearnTemplate(() =>
        inject("POST", UNINSTALL_URL, { workspaceId: WORKSPACE_ID, pluginId: "cc-notes" }),
      );

      expect(removed.statusCode, removed.body).toBe(202);
      const outcome = removed.json<PluginActionOutcome>();
      expect(outcome.outcome, outcome.summary).toBe("applied");
      const servers = (await inject("GET", "/api/v1/mcp/servers")).json<{ items: McpServerRecord[] }>().items;
      expect(servers.find((item) => item.label === "Microsoft Learn")).toBeUndefined();
      expect(await readAllowlist()).toEqual(allowed);
      await expect(new CapabilityPluginStore(gateway!.storage.systemSettings).get("cc-notes")).resolves.toBeUndefined();
    });
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

/** A Claude Code plugin: a skill with pre-approved tools, a server matching a shipped template, a stdio server, a command. */
function writeClaudeCodePlugin(pluginDir: string): void {
  const skill = [
    "---",
    "name: cc-notes",
    "description: Takes notes in meetings.",
    "allowed-tools: Read",
    "metadata:",
    "  version: 1.0.0",
    "  tools: [memory.read]",
    "---",
    "",
    "Take short notes and list the actions.",
    "",
  ].join("\n");
  for (const [relativePath, content] of Object.entries({
    ".claude-plugin/plugin.json": JSON.stringify({ name: "cc-notes", description: "Notes from Claude Code." }),
    "skills/cc-notes/SKILL.md": skill,
    ".mcp.json": JSON.stringify({
      mcpServers: { learn: { type: "http", url: "https://learn.microsoft.com/api/mcp" }, local: { command: "node" } },
    }),
    "commands/go.md": "Go.\n",
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
