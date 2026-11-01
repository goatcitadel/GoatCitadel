import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  ConflictError,
  NotFoundError,
  PLUGIN_LIMITS,
  PolicyViolationError,
  SemanticValidationError,
  ServiceUnavailableError,
  ValidationError,
  type CapabilityPluginInspection,
  type CapabilityPluginListResponse,
} from "@goatcitadel/contracts";
import { PluginIdReservedError } from "../services/capability-plugin-actions-service.js";
import { PluginOwnedError } from "../services/plugin-owned-refusal.js";
import { createDatabase, MutationIdempotencyRepository } from "@goatcitadel/storage";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import {
  CapabilityPluginInspectionService,
  CapabilityPluginManifestRefusedError,
} from "../services/capability-plugin-inspection-service.js";
import {
  CapabilityPluginStore,
  type CapabilityPluginSettingRecord,
  type StoredPlugin,
} from "../services/capability-plugin-store.js";
import type { MutationIdempotencyStore } from "../services/mutation-idempotency-store.js";
import {
  CapabilityPluginsRouteService,
  type CapabilityPluginsRouteSources,
} from "../services/capability-plugins-route-service.js";
import { hubApproval, hubItem } from "../services/capability-skill-install.test-support.js";
import { listBuiltInPluginManifests } from "../services/plugin-manifest-file.js";
import { PluginSourceError } from "../services/plugin-source-service.js";
import { capabilityPluginsRoutes } from "./capability-plugins.js";

const LIST_URL = "/api/v1/capabilities/plugins?workspaceId=default";
const INSPECTIONS_URL = "/api/v1/capabilities/plugins/inspections";
const INSPECTION_ID = "4b5c3a3e-6f0e-4c1d-9a7e-2f1b0c9d8e7f";
const INSPECTION_URL = `${INSPECTIONS_URL}/${INSPECTION_ID}`;
const BODY = { workspaceId: "default", source: { kind: "built_in", pluginId: "meeting-tools" } };
const KEY = { "idempotency-key": "inspect-7f0c" };

const INSPECTION: CapabilityPluginInspection = {
  inspectionId: INSPECTION_ID,
  workspaceId: "default",
  pluginId: "meeting-tools",
  name: "Meeting tools",
  description: "Notes and checks for meetings.",
  version: "1.0.0",
  trust: "built_in",
  sourceKind: "built_in",
  sourceDisplay: "Ships with GoatCitadel",
  pin: { kind: "content", treeSha256: "a".repeat(64) },
  manifestSha256: "b".repeat(64),
  pieces: [
    {
      pieceId: "no-browser",
      kind: "tool_group_off",
      label: "Browser",
      asksFirst: "Turns Browser off in every chat while installed.",
      check: { status: "ready" },
    },
  ],
  ignored: [],
  installable: true,
  inspectedAt: "2026-10-31T12:00:00.000Z",
  expiresAt: "2026-11-01T12:00:00.000Z",
};

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function routeService(overrides: Partial<CapabilityPluginsRouteSources> = {}) {
  const sources: CapabilityPluginsRouteSources = {
    listInstalled: vi.fn(async () => []),
    listBuiltIn: vi.fn(async () => []),
    listSkillHubChecks: vi.fn(async () => []),
    inspect: vi.fn(async () => INSPECTION),
    readInspection: vi.fn(async () => INSPECTION),
    install: vi.fn(async () => ({ planId: "plan-install-1", outcome: "applied" as const, summary: "Installed it." })),
    loadToolGroupHolds: vi.fn(async () => undefined),
    reportFailure: vi.fn(),
    ...overrides,
  };
  return { service: new CapabilityPluginsRouteService(sources), sources };
}

function stored(pluginId: string, overrides: Partial<StoredPlugin> = {}): StoredPlugin {
  return {
    pluginId,
    name: `Plugin ${pluginId}`,
    description: `${pluginId} for tests.`,
    version: "1.0.0",
    trust: "unverified",
    sourceKind: "git",
    sourceDisplay: `github.com/example/${pluginId}`,
    pin: { kind: "commit", commit: "c".repeat(40) },
    manifestSha256: "d".repeat(64),
    snapshotTreeSha256: "e".repeat(64),
    workspaceId: "default",
    installPlanId: `plan-${pluginId}`,
    state: "installed",
    installedAt: "2026-10-30T12:00:00.000Z",
    pieces: [],
    ...overrides,
  };
}

function skillPiece(pieceId: string, skillSnapshotId: string) {
  return { pieceId, kind: "skill" as const, owned: true, skillSnapshotId };
}

describe("capability plugin routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  /**
   * `operator: false` makes the operator check refuse, as it does for a caller without operator sign-in. `actor` is the
   * signed-in actor, "" for none.
   */
  async function build(
    service: CapabilityPluginsRouteService | undefined,
    options: { operator?: boolean; mutationStore?: MutationIdempotencyStore; actor?: string } = {},
  ) {
    const requireOperatorAuth = vi.fn(async (_request: FastifyRequest, reply: FastifyReply) => {
      if (options.operator === false) return reply.code(403).send({ error: "Operator authentication is required." });
    });
    app = Fastify();
    await app.register(rateLimit, { global: false });
    // The Gateway's Idempotency-Key plugin, as the real app registers it: a mutation without the header never runs.
    await app.register(idempotencyHeaderPlugin, options.mutationStore ? { mutationStore: options.mutationStore } : {});
    app.decorateRequest("authActorId", "");
    app.addHook("onRequest", async (request) => {
      request.authActorId = options.actor ?? "operator-1";
    });
    app.decorate("requireOperatorAuth", requireOperatorAuth as never);
    app.decorate("services", (service ? { capabilityPlugins: service } : {}) as never);
    await app.register(capabilityPluginsRoutes);
    return { server: app, requireOperatorAuth };
  }

  it("rejects unknown fields", async () => {
    const { service, sources } = routeService();
    const { server } = await build(service);

    const cases: Array<{ method: "GET" | "POST"; url: string; payload?: unknown; headers?: Record<string, string> }> = [
      { method: "GET", url: `${LIST_URL}&refresh=true` },
      { method: "GET", url: "/api/v1/capabilities/plugins" },
      { method: "POST", url: INSPECTIONS_URL, payload: { ...BODY, installNow: true }, headers: KEY },
      {
        method: "POST",
        url: INSPECTIONS_URL,
        payload: { ...BODY, source: { kind: "git", url: "https://github.com/o/r", token: "x" } },
        headers: KEY,
      },
      { method: "POST", url: INSPECTIONS_URL, payload: { ...BODY, source: { kind: "url", url: "x" } }, headers: KEY },
      {
        method: "POST",
        url: INSPECTIONS_URL,
        payload: { ...BODY, source: { kind: "built_in", pluginId: "../skills" } },
        headers: KEY,
      },
      {
        method: "POST",
        url: INSPECTIONS_URL,
        payload: { ...BODY, source: { kind: "folder", path: "" } },
        headers: KEY,
      },
      { method: "POST", url: INSPECTIONS_URL, payload: { source: BODY.source }, headers: KEY },
      { method: "POST", url: INSPECTIONS_URL, payload: BODY, headers: { "idempotency-key": "has spaces" } },
      { method: "POST", url: INSPECTIONS_URL, payload: BODY, headers: { "idempotency-key": "k".repeat(257) } },
      { method: "POST", url: INSPECTIONS_URL, payload: BODY },
      { method: "GET", url: `${INSPECTION_URL}?workspaceId=default` },
      { method: "GET", url: `${INSPECTIONS_URL}/not-a-check` },
    ];
    for (const request of cases) {
      const response = await server.inject(request as never);
      expect(response.statusCode, `${request.method} ${request.url} ${JSON.stringify(request.payload)}`).toBe(400);
    }
    expect(sources.inspect).not.toHaveBeenCalled();
    expect(sources.readInspection).not.toHaveBeenCalled();
    expect(sources.listInstalled).not.toHaveBeenCalled();
  });

  it("refuses a workspace id the Skill Hub review would refuse with a 400, not a 503", async () => {
    const { service, sources } = routeService();
    const { server } = await build(service);

    for (const workspaceId of [" default", "default ", "\u00a0default", "\ufb01le-lab", "default\t"]) {
      const inspect = await server.inject({
        method: "POST",
        url: INSPECTIONS_URL,
        payload: { ...BODY, workspaceId },
        headers: KEY,
      });
      const list = await server.inject({
        method: "GET",
        url: `/api/v1/capabilities/plugins?workspaceId=${encodeURIComponent(workspaceId)}`,
      });
      expect([inspect.statusCode, list.statusCode], JSON.stringify(workspaceId)).toEqual([400, 400]);
    }
    expect(sources.inspect).not.toHaveBeenCalled();
    expect(sources.listInstalled).not.toHaveBeenCalled();

    // A plain workspace id still goes through.
    const plain = await server.inject({
      method: "POST",
      url: INSPECTIONS_URL,
      payload: { ...BODY, workspaceId: "lab-2" },
      headers: KEY,
    });
    expect(plain.statusCode).toBe(201);
  });

  it("sets the rate limits", async () => {
    const { service, sources } = routeService();
    const { server, requireOperatorAuth } = await build(service);

    const list = await server.inject({ method: "GET", url: LIST_URL });
    const inspect = await server.inject({ method: "POST", url: INSPECTIONS_URL, payload: BODY, headers: KEY });
    const read = await server.inject({ method: "GET", url: INSPECTION_URL });

    expect([list.statusCode, inspect.statusCode, read.statusCode]).toEqual([200, 201, 200]);
    expect([list, inspect, read].map((response) => response.headers["x-ratelimit-limit"])).toEqual(["60", "10", "60"]);
    expect([list, inspect, read].map((response) => response.headers["cache-control"])).toEqual([
      "no-store",
      "no-store",
      "no-store",
    ]);
    expect(requireOperatorAuth).toHaveBeenCalledTimes(3);
    expect(inspect.json()).toEqual(INSPECTION);
    expect(read.json()).toEqual(INSPECTION);
    expect(sources.inspect).toHaveBeenCalledExactlyOnceWith({
      ...BODY,
      actorId: "operator-1",
      actorScope: "operator-1",
      idempotencyKey: "inspect-7f0c",
      log: expect.objectContaining({ warn: expect.any(Function) }),
      replayOnly: false,
    });
    expect(sources.readInspection).toHaveBeenCalledExactlyOnceWith(INSPECTION_ID);
  });

  it("refuses a caller without operator access", async () => {
    const { service, sources } = routeService();
    const { server } = await build(service, { operator: false });

    const responses = await Promise.all([
      server.inject({ method: "GET", url: LIST_URL }),
      server.inject({ method: "POST", url: INSPECTIONS_URL, payload: BODY, headers: KEY }),
      server.inject({ method: "GET", url: INSPECTION_URL }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([403, 403, 403]);
    expect(sources.inspect).not.toHaveBeenCalled();
  });

  it("lists built-in plugins without fetching", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-plugin-list-"));
    roots.push(root);
    const builtInRoot = path.join(root, "plugins");
    const manifest = (pluginId: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        schemaVersion: 1,
        pluginId,
        name: `Plugin ${pluginId}`,
        description: `${pluginId} for tests.`,
        version: "2.0.0",
        pieces: [
          { kind: "skill", id: "notes", path: "skills/notes" },
          { kind: "skill", id: "summary", path: "skills/summary" },
          { kind: "tool_group_off", id: "no-browser", groupId: "browser" },
        ],
        ...extra,
      });
    const folders: Record<string, string | undefined> = {
      "meeting-tools": manifest("meeting-tools"),
      // Installed already, so it is listed only as installed.
      "browser-checks": manifest("browser-checks"),
      "too-big": `${manifest("too-big").slice(0, -1)}, "padding": "${"x".repeat(PLUGIN_LIMITS.maxManifestBytes)}"}`,
      refused: manifest("refused", { featureFlags: { durableKernelV1Enabled: false } }),
      empty: undefined,
      Not_An_Id: manifest("not-an-id"),
      mismatch: manifest("someone-else"),
    };
    for (const [folder, content] of Object.entries(folders)) {
      await fs.mkdir(path.join(builtInRoot, folder), { recursive: true });
      if (content !== undefined) await fs.writeFile(path.join(builtInRoot, folder, "goatcitadel-plugin.json"), content);
    }
    await fs.writeFile(path.join(builtInRoot, "README.md"), "# Plugins\n");
    const inspect = vi.fn();
    const readInspection = vi.fn();
    const { service, sources } = routeService({
      listInstalled: vi.fn(async () => [stored("browser-checks", { name: "Browser checks" })]),
      listBuiltIn: () => listBuiltInPluginManifests(builtInRoot),
      inspect,
      readInspection,
    });
    const { server } = await build(service);

    const response = await server.inject({ method: "GET", url: LIST_URL });

    expect(response.statusCode).toBe(200);
    expect(response.json<CapabilityPluginListResponse>()).toEqual({
      installed: [
        {
          pluginId: "browser-checks",
          name: "Browser checks",
          description: "browser-checks for tests.",
          version: "1.0.0",
          trust: "unverified",
          sourceDisplay: "github.com/example/browser-checks",
          state: "installed",
          pieceCounts: {},
        },
      ],
      builtIn: [
        {
          pluginId: "meeting-tools",
          name: "Plugin meeting-tools",
          description: "meeting-tools for tests.",
          version: "2.0.0",
          trust: "built_in",
          sourceDisplay: "Ships with GoatCitadel",
          state: "available",
          pieceCounts: { skill: 2, tool_group_off: 1 },
        },
      ],
    });
    // Listing reads manifests only: nothing is fetched, checked or kept, and no Skill Hub check is read.
    expect(inspect).not.toHaveBeenCalled();
    expect(readInspection).not.toHaveBeenCalled();
    expect(sources.listSkillHubChecks).not.toHaveBeenCalled();
    expect(sources.reportFailure).not.toHaveBeenCalled();
  });

  it("reads an installed plugin as not finished until every skill is switched on", async () => {
    const plugins = [
      stored("installing", { state: "installing" }),
      stored("half-on", { pieces: [skillPiece("a", "check-done"), skillPiece("b", "check-waiting")] }),
      stored("all-on", {
        pieces: [skillPiece("a", "check-done"), { pieceId: "c", kind: "connector", owned: true, ref: "server-1" }],
      }),
      stored("gone-from-list", { pieces: [skillPiece("a", "check-older")] }),
      stored("removing", { state: "uninstalling", pieces: [skillPiece("a", "check-done")] }),
      stored("elsewhere", { workspaceId: "lab", pieces: [skillPiece("a", "check-lab")] }),
    ];
    const listSkillHubChecks = vi.fn(async (workspaceId: string) =>
      workspaceId === "lab"
        ? [
            hubItem({
              snapshotId: "check-lab",
              approvals: { activate: hubApproval("activate", "approved", "applied") },
            }),
          ]
        : [
            hubItem({
              snapshotId: "check-done",
              approvals: { activate: hubApproval("activate", "approved", "applied") },
            }),
            hubItem({ snapshotId: "check-waiting", approvals: { activate: hubApproval("activate", "pending") } }),
          ],
    );
    const { service } = routeService({ listInstalled: vi.fn(async () => plugins), listSkillHubChecks });

    const listed = await service.list();

    expect(Object.fromEntries(listed.installed.map((item) => [item.pluginId, item.state]))).toEqual({
      installing: "install_not_finished",
      "half-on": "install_not_finished",
      "all-on": "installed",
      "gone-from-list": "install_not_finished",
      removing: "uninstalling",
      elsewhere: "installed",
    });
    expect(listed.installed.find((item) => item.pluginId === "all-on")?.pieceCounts).toEqual({
      skill: 1,
      connector: 1,
    });
    // Each workspace's checks are read once, from the workspace each plugin was installed in.
    expect(listSkillHubChecks.mock.calls.map(([workspaceId]) => workspaceId).sort()).toEqual(["default", "lab"]);
  });

  it("never reads a plugin as installed when its skills' checks can't be read", async () => {
    const failure = new Error("database is locked");
    const { service, sources } = routeService({
      listInstalled: vi.fn(async () => [stored("all-on", { pieces: [skillPiece("a", "check-done")] })]),
      listSkillHubChecks: vi.fn(async () => {
        throw failure;
      }),
      listBuiltIn: vi.fn(async () => {
        throw new Error("EACCES");
      }),
    });

    const listed = await service.list();

    expect(listed.installed.map((item) => item.state)).toEqual(["install_not_finished"]);
    expect(listed.builtIn).toEqual([]);
    expect(sources.reportFailure).toHaveBeenCalledWith("skill_hub", failure);
    expect(sources.reportFailure).toHaveBeenCalledWith("built_in", expect.objectContaining({ message: "EACCES" }));
  });

  it("answers a refused source with its own status, plain words and its code", async () => {
    const { service } = routeService({
      inspect: vi.fn(async () => {
        throw new PluginSourceError(422, "HOST_NOT_PUBLIC", "That address isn't a public host.", {
          cause: new Error("Private host is blocked: https://10.0.0.5/"),
        });
      }),
    });
    const { server } = await build(service);

    const response = await server.inject({ method: "POST", url: INSPECTIONS_URL, payload: BODY, headers: KEY });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: "That address isn't a public host.",
      code: "PLUGIN_REFUSED",
      details: { code: "HOST_NOT_PUBLIC" },
    });
  });

  it.each([
    [403, "FOLDER_INSTALL_NOT_ALLOWED", "Folder installs work only when GoatCitadel runs on this computer."],
    [400, "INVALID_FOLDER", "Give the full path of a folder on this computer."],
    [502, "GIT_FETCH_FAILED", "GoatCitadel couldn't fetch that Git repository. Git didn't finish."],
  ] as const)("answers a %i source refusal (%s) as its own status", async (statusCode, reason, message) => {
    const { service } = routeService({
      inspect: vi.fn(async () => {
        throw new PluginSourceError(statusCode, reason, message);
      }),
    });
    const { server } = await build(service);

    const response = await server.inject({ method: "POST", url: INSPECTIONS_URL, payload: BODY, headers: KEY });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ error: message, code: "PLUGIN_REFUSED", details: { code: reason } });
  });

  it("answers a refused manifest with 422, its code and the inspection to read it back", async () => {
    const refused: CapabilityPluginInspection = {
      ...INSPECTION,
      pluginId: "",
      name: "",
      description: "",
      version: "",
      manifestSha256: "",
      pieces: [],
      installable: false,
      refusal: { code: "HOOK_CODE_NOT_ALLOWED", message: "A plugin's hooks can't run code." },
    };
    const { service } = routeService({
      inspect: vi.fn(async () => {
        throw new CapabilityPluginManifestRefusedError(refused, "pieces[0].command");
      }),
    });
    const { server } = await build(service);

    const response = await server.inject({ method: "POST", url: INSPECTIONS_URL, payload: BODY, headers: KEY });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: "A plugin's hooks can't run code.",
      code: "PLUGIN_REFUSED",
      details: { code: "HOOK_CODE_NOT_ALLOWED", inspectionId: INSPECTION_ID, field: "pieces[0].command" },
    });
  });

  it("answers 409 for a plugin that is already installed", async () => {
    const { service } = routeService({
      inspect: vi.fn(async () => {
        throw new ConflictError({
          code: "ALREADY_EXISTS",
          message: "Meeting tools is already installed.",
          details: { pluginId: "meeting-tools" },
        });
      }),
    });
    const { server } = await build(service);

    const response = await server.inject({ method: "POST", url: INSPECTIONS_URL, payload: BODY, headers: KEY });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Meeting tools is already installed.",
      code: "ALREADY_EXISTS",
      details: { pluginId: "meeting-tools" },
    });
  });

  it("answers a server fault with plain words only, and a check that isn't kept with 404", async () => {
    const leaky = new Error("ENOSPC: no space left, mkdtemp 'C:\\goat\\data\\plugins\\tmp\\copy-abc'");
    const { service } = routeService({
      listInstalled: vi.fn(async () => {
        throw leaky;
      }),
      inspect: vi.fn(async () => {
        throw new ValidationError({ field: "sourceRef", message: "Skill Hub sourceRef C:\\goat is not canonical." });
      }),
      readInspection: vi.fn(async () => undefined),
    });
    const { server } = await build(service);

    const list = await server.inject({ method: "GET", url: LIST_URL });
    const inspect = await server.inject({ method: "POST", url: INSPECTIONS_URL, payload: BODY, headers: KEY });
    const read = await server.inject({ method: "GET", url: INSPECTION_URL });

    for (const response of [list, inspect]) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "Plugins can't be read right now.", code: "EXTERNAL_SERVICE_FAILED" });
    }
    expect(read.statusCode).toBe(404);
    expect(read.json()).toEqual({
      error: "That plugin check wasn't found, or it ran out of time. Check the plugin again.",
      code: "ENTITY_NOT_FOUND",
    });
  });

  it("lists the first 64 built-in plugins by name, whatever order the folder lists them in", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-plugin-cap-"));
    roots.push(root);
    const ids = Array.from({ length: 66 }, (_unused, index) => `plugin-${String(index).padStart(2, "0")}`);
    // Written newest first, so a listing that kept the folder's own order would differ on a disk that keeps it.
    for (const pluginId of [...ids].reverse()) {
      await fs.mkdir(path.join(root, pluginId), { recursive: true });
      await fs.writeFile(
        path.join(root, pluginId, "goatcitadel-plugin.json"),
        JSON.stringify({
          schemaVersion: 1,
          pluginId,
          name: pluginId,
          description: "A plugin.",
          version: "1.0.0",
          pieces: [{ kind: "tool_group_off", id: "no-browser", groupId: "browser" }],
        }),
      );
    }

    const listed = await listBuiltInPluginManifests(root);

    expect(listed.map((manifest) => manifest.pluginId)).toEqual(ids.slice(0, 64));
  });

  describe("a retried inspection", () => {
    const databases: Array<ReturnType<typeof createDatabase>> = [];

    afterEach(() => {
      for (const database of databases.splice(0)) database.close();
    });

    /** The plugin store's row, with the system settings repository's own compare-and-set rule. */
    function settingRows() {
      let record: CapabilityPluginSettingRecord | undefined;
      let clock = 0;
      return {
        get: async () => (record ? structuredClone(record) : undefined),
        compareAndSet: async (key: string, expected: CapabilityPluginSettingRecord | undefined, value: unknown) => {
          const unchanged = expected
            ? record?.updatedAt === expected.updatedAt &&
              JSON.stringify(record.value) === JSON.stringify(expected.value)
            : record === undefined;
          if (!unchanged) return undefined;
          record = {
            key,
            value: structuredClone(value),
            updatedAt: new Date(Date.UTC(2026, 9, 31, 0, 0, ++clock)).toISOString(),
          };
          return structuredClone(record);
        },
      };
    }

    /**
     * Built-in plugins whose folders stand in for their snapshots, inspected through the real inspection, the real
     * plugin store and the Gateway's real attempt record. `actor` is the signed-in actor, "" for none.
     */
    async function realReplay(actor?: string) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-plugin-replay-"));
      roots.push(root);
      const manifests: Record<string, Record<string, unknown>> = {
        "good-plugin": { pieces: [{ kind: "tool_group_off", id: "no-browser", groupId: "browser" }] },
        "refused-plugin": {
          featureFlags: { durableKernelV1Enabled: false },
          pieces: [{ kind: "tool_group_off", id: "no-browser", groupId: "browser" }],
        },
      };
      for (const [pluginId, extra] of Object.entries(manifests)) {
        await fs.mkdir(path.join(root, pluginId), { recursive: true });
        await fs.writeFile(
          path.join(root, pluginId, "goatcitadel-plugin.json"),
          JSON.stringify({
            schemaVersion: 1,
            pluginId,
            name: pluginId,
            description: "A plugin.",
            version: "1.0.0",
            ...extra,
          }),
        );
      }
      // Each built-in plugin's folder stands in for its snapshot; the inspection, the store and the replay are real.
      const fetchSource = vi.fn(async (source: { kind: string; pluginId?: string }) => {
        const treeSha256 = (source.pluginId === "good-plugin" ? "a" : "b").repeat(64);
        return {
          snapshot: { treeSha256, dir: path.join(root, source.pluginId ?? "") },
          pin: { kind: "content" as const, treeSha256 },
          trust: "built_in" as const,
          sourceDisplay: "Ships with GoatCitadel",
        };
      });
      const store = new CapabilityPluginStore(settingRows());
      let sequence = 0;
      const inspection = new CapabilityPluginInspectionService({
        fetchSource,
        resolveSnapshotPath: () => {
          throw new Error("no piece reads a file here");
        },
        reviewSkill: vi.fn(),
        connectorTemplates: () => [],
        listSavedConnectorLabels: async () => [],
        readSettings: async () => ({
          switchedOffToolGroups: [],
          networkAllowlist: [],
          typedRunVariablesEnabled: false,
        }),
        promptPackExists: async () => false,
        lookupHost: async () => [],
        findInstalled: (pluginId) => store.get(pluginId),
        findKeptInspection: (actorScope, key) => store.findInspectionByRequest(actorScope, key),
        saveInspection: (kept, treeSha256, request) => store.saveInspection(kept, treeSha256, request),
        now: () => new Date(),
        newInspectionId: () => `4b5c3a3e-6f0e-4c1d-9a7e-2f1b0c9d8e${String(++sequence).padStart(2, "0")}`,
        gatewayVersion: "1.0.0",
      });
      const { service } = routeService({ inspect: (input) => inspection.inspect(input) });
      const database = createDatabase({ dbPath: ":memory:" });
      databases.push(database);
      const attempts = new MutationIdempotencyRepository(database);
      const { server } = await build(service, {
        ...(actor === undefined ? {} : { actor }),
        mutationStore: {
          claim: async (input) => attempts.claim(input),
          markCompleted: async (input) => attempts.markCompleted(input),
          markFailed: async (input) => attempts.markFailed(input),
        },
      });
      const post = (pluginId: string, key: string, remoteAddress = "127.0.0.1") =>
        server.inject({
          method: "POST",
          url: INSPECTIONS_URL,
          remoteAddress,
          headers: { "idempotency-key": key },
          payload: { workspaceId: "default", source: { kind: "built_in", pluginId } },
        });
      return { post, fetchSource, attempts };
    }

    it("gets the first answer again, the same 201 or the same 422, from the Gateway's own attempt record", async () => {
      const { post, fetchSource, attempts } = await realReplay();

      const first = await post("good-plugin", "attempt-good");
      const retried = await post("good-plugin", "attempt-good");
      const refused = await post("refused-plugin", "attempt-refused");
      const refusedAgain = await post("refused-plugin", "attempt-refused");
      const changed = await post("refused-plugin", "attempt-good");

      expect([first.statusCode, retried.statusCode]).toEqual([201, 201]);
      expect(retried.json()).toEqual(first.json());
      expect([refused.statusCode, refusedAgain.statusCode]).toEqual([422, 422]);
      expect(refused.json()).toMatchObject({ details: { code: "FEATURE_FLAGS_NOT_ALLOWED", field: "featureFlags" } });
      expect(refusedAgain.json()).toEqual(refused.json());
      // Each answered attempt is recorded as done, so the retries were the Gateway's canonical replays, not new checks.
      for (const key of ["attempt-good", "attempt-refused"]) {
        expect(
          attempts.get({ method: "POST", routePath: INSPECTIONS_URL, idempotencyKey: key, actorScope: "operator-1" })
            ?.status,
        ).toBe("completed");
      }
      expect(fetchSource).toHaveBeenCalledTimes(2);
      // A key reused for another request is still refused by the attempt record.
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toEqual({ error: "Idempotency-Key was reused with a different payload" });
    });

    it("answers a same-key retry without sign-in from the kept inspection, whatever address it comes from", async () => {
      const { post, fetchSource, attempts } = await realReplay("");

      const first = await post("good-plugin", "attempt-unsigned", "10.0.0.7");
      // The retry comes back through another address, as it can behind a proxy or after a network change.
      const retried = await post("good-plugin", "attempt-unsigned", "10.0.0.8");

      expect([first.statusCode, retried.statusCode], retried.body).toEqual([201, 201]);
      expect(retried.json()).toEqual(first.json());
      expect(fetchSource).toHaveBeenCalledTimes(1);
      // The attempt record and the kept inspection share the idempotency plugin's scope: "" without sign-in.
      expect(
        attempts.get({ method: "POST", routePath: INSPECTIONS_URL, idempotencyKey: "attempt-unsigned", actorScope: "" })
          ?.status,
      ).toBe("completed");
    });
  });

  it("answers 503 when the Gateway has no plugin owner", async () => {
    const { server } = await build(undefined);

    const response = await server.inject({ method: "GET", url: LIST_URL });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Plugins can't be read right now.", code: "EXTERNAL_SERVICE_FAILED" });
  });

  describe("POST /api/v1/capabilities/plugins/install", () => {
    const INSTALL_URL = "/api/v1/capabilities/plugins/install";
    const databases: Array<ReturnType<typeof createDatabase>> = [];
    afterEach(() => {
      for (const database of databases.splice(0)) database.close();
    });
    const INSTALL_BODY = {
      workspaceId: "default",
      inspectionId: INSPECTION_ID,
      hookSecrets: { "tool-watch": "s3cret" },
    };

    it("installs from the inspection as the operator, and answers 202 with the outcome", async () => {
      const outcome = {
        planId: "plan-1",
        outcome: "waiting" as const,
        approvalId: "approval-1",
        summary: "Install it.",
      };
      const { service, sources } = routeService({ install: vi.fn(async () => outcome) });
      const { server, requireOperatorAuth } = await build(service);

      const response = await server.inject({
        method: "POST",
        url: INSTALL_URL,
        payload: INSTALL_BODY,
        headers: { "idempotency-key": "install-7f0c" },
      });

      expect(response.statusCode, response.body).toBe(202);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual(outcome);
      expect(requireOperatorAuth).toHaveBeenCalled();
      expect(sources.install).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "default",
        inspectionId: INSPECTION_ID,
        hookSecrets: { "tool-watch": "s3cret" },
        actorId: "operator-1",
        idempotencyKey: "install-7f0c",
        requestId: expect.any(String),
        replayOnly: false,
      });
    });

    it("refuses a caller without operator sign-in", async () => {
      const { service, sources } = routeService();
      const { server } = await build(service, { operator: false });

      const response = await server.inject({
        method: "POST",
        url: INSTALL_URL,
        payload: INSTALL_BODY,
        headers: { "idempotency-key": "install-7f0c" },
      });

      expect(response.statusCode).toBe(403);
      expect(sources.install).not.toHaveBeenCalled();
    });

    it("rejects a body that isn't exactly a workspace, a check and hook secrets", async () => {
      const { service, sources } = routeService();
      const { server } = await build(service);
      const key = { "idempotency-key": "install-7f0c" };

      for (const [payload, headers] of [
        [{ ...INSTALL_BODY, installNow: true }, key],
        [{ ...INSTALL_BODY, inspectionId: "not-a-check" }, key],
        [{ ...INSTALL_BODY, workspaceId: " default" }, key],
        [{ ...INSTALL_BODY, hookSecrets: { Tool_Watch: "s3cret" } }, key],
        [{ ...INSTALL_BODY, hookSecrets: { "tool-watch": 7 } }, key],
        [{ ...INSTALL_BODY, hookSecretRefs: { "tool-watch": "keychain:goatcitadel:hook:x" } }, key],
        [{ inspectionId: INSPECTION_ID }, key],
        [INSTALL_BODY, { "idempotency-key": "has spaces" }],
        [INSTALL_BODY, {}],
      ] as const) {
        const response = await server.inject({ method: "POST", url: INSTALL_URL, payload, headers });
        expect(response.statusCode, `${JSON.stringify(payload)} ${response.body}`).toBe(400);
        // A refused body never echoes a secret back.
        expect(response.body).not.toContain("s3cret");
      }
      expect(sources.install).not.toHaveBeenCalled();
    });

    it("answers an owner's refusal with its own status and plain words, and anything else as a plain 503", async () => {
      const refusals: Array<[unknown, number]> = [
        [new PolicyViolationError({ message: "Plugins are installed from Capabilities." }), 403],
        [new NotFoundError("That plugin check wasn't found, or it ran out of time. Check the plugin again."), 404],
        [new ConflictError({ code: "ALREADY_EXISTS", message: "Meeting tools is already installed." }), 409],
        [new SemanticValidationError("Every hook needs one signing secret."), 422],
        [new ValidationError({ field: "hookSecrets", message: "Every hook needs its own signing secret." }), 400],
        [new PluginOwnedError({ pluginId: "meeting-tools", name: "Meeting tools" }), 409],
        [new PluginIdReservedError(), 409],
      ];
      for (const [error, status] of refusals) {
        const { service } = routeService({
          install: vi.fn(async () => {
            throw error;
          }),
        });
        const { server } = await build(service);
        const response = await server.inject({
          method: "POST",
          url: INSTALL_URL,
          payload: INSTALL_BODY,
          headers: { "idempotency-key": "install-7f0c" },
        });
        expect(response.statusCode, response.body).toBe(status);
        expect(response.json().error).toBe((error as Error).message);
        await app?.close();
        app = null;
      }

      const { service } = routeService({
        install: vi.fn(async () => {
          throw new Error("EPERM: C:\\goat\\data\\plugins\\snapshots\\aaaa");
        }),
      });
      const { server } = await build(service);
      const fault = await server.inject({
        method: "POST",
        url: INSTALL_URL,
        payload: INSTALL_BODY,
        headers: { "idempotency-key": "install-7f0c" },
      });
      expect(fault.statusCode).toBe(503);
      // An install's own plain words; the fault's path stays in the server log.
      expect(fault.json()).toEqual({
        error: "This plugin can't be installed right now.",
        code: "EXTERNAL_SERVICE_FAILED",
      });
    });

    it.each([
      ["change_plans_off", "Installing plugins needs Change Plans, which are off on this install."],
      [
        "key_store_unavailable",
        "This computer's key store can't be used right now, so a hook's signing secret can't be kept. Nothing was installed.",
      ],
    ])("says %s in plain words", async (reason, message) => {
      const { service } = routeService({
        install: vi.fn(async () => {
          throw new ServiceUnavailableError(message, { reason });
        }),
      });
      const { server } = await build(service);

      const response = await server.inject({
        method: "POST",
        url: INSTALL_URL,
        payload: INSTALL_BODY,
        headers: { "idempotency-key": "install-7f0c" },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: message, details: { reason } });
    });

    it("hands a retry of an answered key to the service as a replay, so it answers from the first plan", async () => {
      const install = vi.fn(async () => ({ planId: "plan-1", outcome: "applied" as const, summary: "Installed it." }));
      const { service } = routeService({ install });
      const database = createDatabase({ dbPath: ":memory:" });
      databases.push(database);
      const attempts = new MutationIdempotencyRepository(database);
      const { server } = await build(service, {
        mutationStore: {
          claim: async (input) => attempts.claim(input),
          markCompleted: async (input) => attempts.markCompleted(input),
          markFailed: async (input) => attempts.markFailed(input),
        },
      });
      const post = (hookSecrets: Record<string, string>) =>
        server.inject({
          method: "POST",
          url: INSTALL_URL,
          payload: { ...INSTALL_BODY, hookSecrets },
          headers: { "idempotency-key": "install-retried" },
        });

      const first = await post({ "tool-watch": "s3cret" });
      // A retry can't be told from the first by its secret: the attempt record never holds one.
      const retried = await post({ "tool-watch": "another" });

      expect([first.statusCode, retried.statusCode], retried.body).toEqual([202, 202]);
      expect(install.mock.calls.map(([input]) => (input as { replayOnly: boolean }).replayOnly)).toEqual([false, true]);
      const stored = JSON.stringify(database.prepare("SELECT * FROM mutation_idempotency").all());
      expect(stored).toContain("install-retried");
      expect(stored).not.toContain("s3cret");
      expect(stored).not.toContain("another");
    });
  });
});
