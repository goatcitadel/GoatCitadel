import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  CapabilityPluginInspection,
  CapabilityPluginListResponse,
  CapabilitySkillInstallsResponse,
  CapabilitySkillsResponse,
} from "@goatcitadel/contracts";
import { buildApp } from "./app.js";

/**
 * Inspecting a built-in plugin over the real Gateway: the plugin folder is copied into a snapshot, its manifest is read,
 * and every piece goes through its owner's own check (the skill through the Skill Hub's real review). Inspection installs
 * nothing: the only paths it adds are the snapshot (and its temp copy) under `<data>/plugins` and the Skill Hub's
 * reviewed bundle under `<data>/skill-hub/artifacts`, and no connector, hook, prompt pack or tool switch changes. On
 * Windows the artifact store sets owner-only ACLs through PowerShell, so the waits here are generous.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TOKEN = "capability-plugins-test-operator-1234567890";
const WORKSPACE_ID = "default";
const PLUGIN_ID = "meeting-tools";
const PLUGINS_URL = `/api/v1/capabilities/plugins?workspaceId=${WORKSPACE_ID}`;
const INSPECTIONS_URL = "/api/v1/capabilities/plugins/inspections";

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

/** The skill the Skill Hub review passes as a Git import would: a declared version and tool, and a licence. */
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
const MANIFEST = {
  schemaVersion: 1,
  pluginId: PLUGIN_ID,
  name: "Meeting tools",
  description: "Notes and checks for meetings.",
  version: "1.0.0",
  pieces: [
    { kind: "skill", id: "meeting-notes", path: "skills/meeting-notes" },
    { kind: "connector", id: "issues", templateId: "linear" },
    { kind: "tool_group_off", id: "no-browser", groupId: "browser" },
    // A public address as a literal, so the check needs no DNS.
    { kind: "hook", id: "tool-watch", trigger: "tool.call.after", url: "https://1.1.1.1/goatcitadel" },
    { kind: "prompt_pack", id: "checks", path: "prompt-packs/checks.md" },
  ],
};

describe("plugin inspection over the real Gateway", { timeout: 300_000 }, () => {
  const originalEnv = new Map<string, string | undefined>();
  let root = "";
  let app: FastifyInstance | undefined;
  let sequence = 0;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-capability-plugins-"));
    writeConfig(path.join(root, "config"));
    writePlugin(path.join(root, "plugins", PLUGIN_ID));
    for (const [key, value] of Object.entries({ ...ENV, GOATCITADEL_ROOT_DIR: root })) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    app = await buildApp();
    await app.ready();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // A temp root that can't be removed is reported rather than left behind unseen: only the errors Windows raises while
    // a file is still closing are tried again.
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
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": `capability-plugins-${++sequence}` },
      ...(payload ? { payload } : {}),
    });
  }

  async function readOwners() {
    const reads = await Promise.all([
      inject("GET", "/api/v1/mcp/servers"),
      inject("GET", `/api/v1/workspaces/${WORKSPACE_ID}/hooks`),
      inject("GET", "/api/v1/prompt-packs"),
      inject("GET", `/api/v1/capabilities/tools?workspaceId=${WORKSPACE_ID}`),
      inject("GET", "/api/v1/settings"),
      inject("GET", "/api/v1/approvals"),
    ]);
    for (const response of reads) expect(response.statusCode, response.body).toBe(200);
    const [servers, hooks, promptPacks, tools, settings, approvals] = reads.map((response) => response.json());
    // The hooks allowlist lives in the tool policy file, which installing a hook would add its host to.
    const toolPolicy = JSON.parse(fs.readFileSync(path.join(root, "config", "tool-policy.json"), "utf8"));
    const items = (value: unknown) => (value as { items: Array<Record<string, unknown>> }).items;
    return {
      servers: items(servers).map((server) => [server.serverId, server.label]),
      hooks: items(hooks).map((hook) => hook.hookId),
      promptPacks: items(promptPacks).map((pack) => pack.packId),
      switches: (tools as { groups: Array<{ groupId: string; state: string }> }).groups.map((group) => [
        group.groupId,
        group.state,
      ]),
      networkAllowlist: (settings as { networkAllowlist: string[] }).networkAllowlist,
      hooksAllowlist: toolPolicy.hooks?.networkAllowlist ?? null,
      approvals: items(approvals).map((approval) => [approval.approvalId, approval.status]),
    };
  }

  it("inspects a built-in plugin, reads it back, and changes nothing but its snapshot and the skill's check", async () => {
    // Every read the panel makes first, so whatever a read creates lazily is there before the paths are counted.
    const listed = await inject("GET", PLUGINS_URL);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<CapabilityPluginListResponse>()).toEqual({
      installed: [],
      builtIn: [
        {
          pluginId: PLUGIN_ID,
          name: "Meeting tools",
          description: "Notes and checks for meetings.",
          version: "1.0.0",
          trust: "built_in",
          sourceDisplay: "Ships with GoatCitadel",
          state: "available",
          pieceCounts: { skill: 1, connector: 1, tool_group_off: 1, hook: 1, prompt_pack: 1 },
        },
      ],
    });
    const ownersBefore = await readOwners();
    const pathsBefore = new Set(listPaths(root));

    const created = await inject("POST", INSPECTIONS_URL, {
      workspaceId: WORKSPACE_ID,
      source: { kind: "built_in", pluginId: PLUGIN_ID },
    });

    expect(created.statusCode, created.body).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    const inspection = created.json<CapabilityPluginInspection>();
    expect(inspection).toMatchObject({
      workspaceId: WORKSPACE_ID,
      pluginId: PLUGIN_ID,
      trust: "built_in",
      sourceKind: "built_in",
      sourceDisplay: "Ships with GoatCitadel",
      installable: true,
      ignored: [],
    });
    expect(inspection.pieces.map((piece) => [piece.pieceId, piece.check])).toEqual([
      ["meeting-notes", { status: "ready" }],
      ["issues", { status: "ready" }],
      ["no-browser", { status: "ready" }],
      ["tool-watch", { status: "ready" }],
      ["checks", { status: "ready" }],
    ]);
    const skill = inspection.pieces[0]!;
    expect(skill.skillSnapshotId).toEqual(expect.any(String));
    expect(inspection.pieces.find((piece) => piece.pieceId === "issues")?.label).toBe("Linear");
    // No path on this computer reaches the operator.
    expect(created.body).not.toContain(root);
    expect(created.body).not.toContain(root.replaceAll("\\", "\\\\"));

    const readBack = await inject("GET", `${INSPECTIONS_URL}/${inspection.inspectionId}`);
    expect(readBack.statusCode, readBack.body).toBe(200);
    expect(readBack.json()).toEqual(inspection);

    // Inspection installed nothing.
    expect(await readOwners()).toEqual(ownersBefore);
    const listedAfter = await inject("GET", PLUGINS_URL);
    expect(listedAfter.json<CapabilityPluginListResponse>()).toEqual(listed.json());

    // The only new paths are the snapshot (with the temp folder it was copied through) and the Skill Hub's bundle.
    const treeSha256 = inspection.pin.kind === "content" ? inspection.pin.treeSha256 : "";
    const added = listPaths(root).filter((entry) => !pathsBefore.has(entry));
    expect(added).toContain(`data/plugins/snapshots/${treeSha256}/goatcitadel-plugin.json`);
    expect(added).toContain(`data/plugins/snapshots/${treeSha256}/skills/meeting-notes/SKILL.md`);
    expect(added.some((entry) => entry.startsWith("data/skill-hub/artifacts/"))).toBe(true);
    // The two folders themselves are new on a fresh install too; nothing else is.
    const insideAllowed = (entry: string) =>
      ["data/plugins", "data/skill-hub", "data/skill-hub/artifacts"].includes(entry) ||
      entry.startsWith("data/plugins/") ||
      entry.startsWith("data/skill-hub/artifacts/");
    expect(added.filter((entry) => !insideAllowed(entry))).toEqual([]);
    // The temp copy the snapshot was made through is gone: only the snapshot itself stays under data/plugins.
    expectNoTempCopies(root);

    // The skill's check is a Skill Hub record, yet it shows nowhere on the Skills tab.
    const installs = await inject("GET", `/api/v1/capabilities/skills/installs?workspaceId=${WORKSPACE_ID}`);
    expect(installs.statusCode, installs.body).toBe(200);
    expect(installs.json<CapabilitySkillInstallsResponse>().installs).toEqual([]);
    const oneCheck = await inject(
      "GET",
      `/api/v1/capabilities/skills/installs?workspaceId=${WORKSPACE_ID}&snapshotId=${skill.skillSnapshotId}`,
    );
    expect(oneCheck.json<CapabilitySkillInstallsResponse>().installs).toEqual([]);
    const skills = await inject("GET", `/api/v1/capabilities/skills?workspaceId=${WORKSPACE_ID}`);
    expect(skills.statusCode, skills.body).toBe(200);
    expect(skills.json<CapabilitySkillsResponse>().items.some((item) => item.skillId.includes("meeting-notes"))).toBe(
      false,
    );
  });

  it("checks the same copy again without a second Skill Hub check, and answers a retried key with the first answer", async () => {
    const body = { workspaceId: WORKSPACE_ID, source: { kind: "built_in", pluginId: PLUGIN_ID } };
    const first = await inject("POST", INSPECTIONS_URL, body);
    const second = await inject("POST", INSPECTIONS_URL, body);
    expect([first.statusCode, second.statusCode], second.body).toEqual([201, 201]);
    const [one, two] = [first.json<CapabilityPluginInspection>(), second.json<CapabilityPluginInspection>()];
    expect(two.inspectionId).not.toBe(one.inspectionId);
    expect(two.pieces[0]?.skillSnapshotId).toBe(one.pieces[0]?.skillSnapshotId);

    // The Skill Hub holds one check of this plugin's skill, however many times the same copy is inspected.
    const hub = await inject("GET", `/api/v1/skills/hub?workspaceId=${WORKSPACE_ID}&limit=100`);
    expect(hub.statusCode, hub.body).toBe(200);
    const checks = (
      hub.json() as { items: Array<{ snapshotId: string; snapshot: { canonicalSourceKey: string } }> }
    ).items
      .filter((item) => item.snapshot.canonicalSourceKey === `plugin:${PLUGIN_ID}/meeting-notes`)
      .map((item) => item.snapshotId);
    expect(checks).toEqual([one.pieces[0]?.skillSnapshotId]);

    // The same Idempotency-Key again gets the first answer, through the Gateway's own attempt record.
    const key = "capability-plugins-retried";
    const sent = await app!.inject({
      method: "POST",
      url: INSPECTIONS_URL,
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": key },
      payload: body,
    });
    const resent = await app!.inject({
      method: "POST",
      url: INSPECTIONS_URL,
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": key },
      payload: body,
    });
    expect([sent.statusCode, resent.statusCode], resent.body).toEqual([201, 201]);
    expect(resent.json()).toEqual(sent.json());
    expectNoTempCopies(root);
  });

  it("refuses a built-in plugin that isn't shipped, with its code and nothing kept", async () => {
    const pathsBefore = new Set(listPaths(root));

    const response = await inject("POST", INSPECTIONS_URL, {
      workspaceId: WORKSPACE_ID,
      source: { kind: "built_in", pluginId: "not-shipped" },
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toEqual({
      error: "GoatCitadel doesn't ship a plugin with that id.",
      code: "PLUGIN_REFUSED",
      details: { code: "BUILT_IN_NOT_FOUND" },
    });
    expect(listPaths(root).filter((entry) => !pathsBefore.has(entry))).toEqual([]);
  });
});

/** Every file and folder under `dir`, relative and with `/`, skipping SQLite's own side files. */
/** `<data>/plugins/tmp` holds nothing after an inspection, or isn't there at all. */
function expectNoTempCopies(root: string): void {
  const tempRoot = path.join(root, "data", "plugins", "tmp");
  expect(fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot) : []).toEqual([]);
}

function listPaths(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full).replaceAll("\\", "/");
      if (/\.(?:db|sqlite)-(?:wal|shm|journal)$/u.test(entry.name)) continue;
      found.push(relative);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return found.sort();
}

function writePlugin(pluginDir: string): void {
  const files: Record<string, string> = {
    "goatcitadel-plugin.json": JSON.stringify(MANIFEST, null, 2),
    "skills/meeting-notes/SKILL.md": SKILL_MD,
    "skills/meeting-notes/LICENSE": "MIT\n",
    "prompt-packs/checks.md": PROMPT_PACK_MD,
  };
  for (const [relativePath, content] of Object.entries(files)) {
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
