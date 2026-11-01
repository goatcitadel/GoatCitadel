import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  ValidationError,
  type CapabilityPluginInspection,
  type CapabilityPluginPieceView,
  type McpServerTemplateRecord,
} from "@goatcitadel/contracts";
import {
  CapabilityPluginInspectionService,
  CapabilityPluginManifestRefusedError,
  checkHookPiece,
  type CapabilityPluginInspectionSources,
} from "./capability-plugin-inspection-service.js";
import type { CapabilityPluginInspectionRequestKey, StoredPlugin } from "./capability-plugin-store.js";
import type { PluginSkillCheck } from "./plugin-skill-checks.js";
import { PluginSnapshotPathError, PluginSnapshotStore } from "./plugin-snapshot-store.js";
import { PluginSourceError, fetchPluginSource } from "./plugin-source-service.js";
import type { SkillHubReviewResult, SkillHubSourceReviewInput } from "./skill-hub-review-service.js";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const PLUGIN_ID = "meeting-tools";
/** The Gateway version the harness composes the service with: a skill's review key names it. */
const GATEWAY_VERSION = "1.4.2-rc.1";

const POLICY = {
  requireFirstToolApproval: true,
  redactionMode: "basic" as const,
  allowedToolPatterns: [],
  blockedToolPatterns: [],
};

function template(overrides: Partial<McpServerTemplateRecord> & Pick<McpServerTemplateRecord, "templateId" | "label">) {
  return {
    description: `${overrides.label} for tests.`,
    transport: "http",
    url: "https://mcp.notes.test/mcp",
    authType: "oauth2",
    oauth: { metadataDiscovery: true },
    category: "data",
    trustTier: "restricted",
    costTier: "unknown",
    policy: POLICY,
    enabledByDefault: false,
    ...overrides,
  } satisfies McpServerTemplateRecord;
}

const TEMPLATES: McpServerTemplateRecord[] = [
  template({ templateId: "notes-app", label: "Notes App", networkHosts: ["mcp.notes.test", "AUTH.notes.test"] }),
  template({
    templateId: "keyed",
    label: "Keyed",
    transport: "stdio",
    url: undefined,
    command: "npx",
    authType: "token",
    oauth: undefined,
  }),
];

const SKILL_MD = ["---", "name: meeting-notes", "description: Notes for meetings.", "---", "", "Take notes.", ""].join(
  "\n",
);
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
  "### TEST-C902: Actions",
  "",
  "List the actions from the meeting.",
  "",
].join("\n");

type Pieces = Array<Record<string, unknown>>;

const EVERY_KIND: Pieces = [
  { kind: "skill", id: "meeting-notes", path: "skills/meeting-notes" },
  { kind: "connector", id: "notes", templateId: "notes-app" },
  { kind: "connector", id: "notes-strict", templateId: "notes-app", asksFirst: "everything" },
  { kind: "tool_group_off", id: "no-browser", groupId: "browser" },
  { kind: "hook", id: "tool-watch", trigger: "tool.call.after", url: "https://hooks.example.test/goatcitadel" },
  { kind: "prompt_pack", id: "checks", path: "prompt-packs/checks.md" },
];

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** A reviewed skill's check as its install steps read it: by default, nothing refuses installing it. */
function skillCheck(snapshotId: string, overrides: Partial<PluginSkillCheck> = {}): PluginSkillCheck {
  return {
    snapshotId,
    title: "meeting-notes",
    version: "none",
    revoked: false,
    pendingApprovals: {},
    installInactive: { allowed: true, blockers: [] },
    step: "check_passed",
    ...overrides,
  };
}

function reviewed(snapshotId: string, blockerCodes: string[] = [], skillName = "meeting-notes"): SkillHubReviewResult {
  return {
    snapshot: { snapshotId, blockerCodes, provenance: { skillName } },
    replayed: false,
  } as unknown as SkillHubReviewResult;
}

/**
 * A plugin folder on disk, fetched through the real folder source into a real snapshot store. Every other owner is a
 * plain function the case can replace.
 */
async function harness(
  options: {
    pieces?: Pieces;
    manifest?: string;
    files?: Record<string, string | Buffer>;
    overrides?: Partial<CapabilityPluginInspectionSources>;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-plugin-inspection-"));
  roots.push(root);
  const pluginDir = path.join(root, "source", PLUGIN_ID);
  const manifest =
    options.manifest ??
    JSON.stringify({
      schemaVersion: 1,
      pluginId: PLUGIN_ID,
      name: "Meeting tools",
      description: "Notes and checks for meetings.",
      version: "1.2.0",
      author: "Example Author",
      pieces: options.pieces ?? EVERY_KIND,
    });
  const files: Record<string, string | Buffer> = {
    "goatcitadel-plugin.json": manifest,
    "skills/meeting-notes/SKILL.md": SKILL_MD,
    "skills/other-notes/SKILL.md": SKILL_MD.replace("meeting-notes", "other-notes"),
    "prompt-packs/checks.md": PROMPT_PACK_MD,
    // No Pack-Version, so the pack is named from the label an install saves it under.
    "prompt-packs/one.md": (PROMPT_PACK_MD.split("### TEST-C902")[0] ?? "").replace(
      "Pack-Version: Meeting checks\n\n",
      "",
    ),
    ...options.files,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(pluginDir, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  const snapshots = new PluginSnapshotStore(path.join(root, "data", "plugins", "snapshots"));
  const saved: Array<{
    inspection: CapabilityPluginInspection;
    snapshotTreeSha256: string;
    request: CapabilityPluginInspectionRequestKey;
  }> = [];
  const fetchCalls: unknown[] = [];
  const reviewSkill = vi.fn(async (input: SkillHubSourceReviewInput) =>
    reviewed(`skill-hub-review-${input.idempotencyKey}`),
  );
  const sources: CapabilityPluginInspectionSources = {
    fetchSource: (source) => {
      fetchCalls.push(source);
      return fetchPluginSource(source, {
        importSnapshot: (dir) => snapshots.importDirectory(dir),
        builtInRoot: path.join(root, "plugins"),
        deploymentProfile: "trusted_local",
        tempRoot: path.join(root, "data", "plugins", "tmp"),
      });
    },
    resolveSnapshotPath: (treeSha256, relativePath) => snapshots.resolve(treeSha256, relativePath),
    reviewSkill,
    connectorTemplates: () => TEMPLATES,
    listSavedConnectorLabels: vi.fn(async () => []),
    readSettings: vi.fn(async () => ({
      switchedOffToolGroups: [],
      networkAllowlist: [],
      typedRunVariablesEnabled: false,
    })),
    promptPackExists: vi.fn(async () => false),
    lookupHost: vi.fn(async () => [{ address: "93.184.216.34" }]),
    readSkillCheck: vi.fn(async (_workspaceId: string, snapshotId: string) => skillCheck(snapshotId)),
    findInstalled: vi.fn(async () => undefined),
    findKeptInspection: vi.fn(async (actorScope: string, idempotencyKey: string) => {
      const kept = saved.find(
        (entry) => entry.request.actorScope === actorScope && entry.request.idempotencyKey === idempotencyKey,
      );
      return kept && { inspection: kept.inspection, payloadSha256: kept.request.payloadSha256 };
    }),
    saveInspection: vi.fn(async (inspection, snapshotTreeSha256, request) => {
      saved.push({ inspection, snapshotTreeSha256, request });
    }),
    now: () => new Date(NOW),
    newInspectionId: () => "4b5c3a3e-6f0e-4c1d-9a7e-2f1b0c9d8e7f",
    gatewayVersion: GATEWAY_VERSION,
    ...options.overrides,
  };
  const log = { warn: vi.fn() };
  const service = new CapabilityPluginInspectionService(sources);
  const inspect = (overrides: Partial<Parameters<CapabilityPluginInspectionService["inspect"]>[0]> = {}) =>
    service.inspect({
      workspaceId: "default",
      source: { kind: "folder", path: pluginDir },
      actorId: "operator-1",
      actorScope: "operator-1",
      idempotencyKey: "inspect-7f0c",
      log,
      ...overrides,
    });
  return { service, sources, saved, reviewSkill, log, inspect, root, pluginDir, fetchCalls };
}

function piece(inspection: CapabilityPluginInspection, pieceId: string): CapabilityPluginPieceView {
  const found = inspection.pieces.find((item) => item.pieceId === pieceId);
  if (!found) throw new Error(`no piece ${pieceId}`);
  return found;
}

describe("CapabilityPluginInspectionService", () => {
  it("marks a plugin installable only when every piece passes", async () => {
    const { inspect, saved, reviewSkill, root } = await harness();

    const inspection = await inspect();

    expect(inspection).toMatchObject({
      inspectionId: "4b5c3a3e-6f0e-4c1d-9a7e-2f1b0c9d8e7f",
      workspaceId: "default",
      pluginId: PLUGIN_ID,
      name: "Meeting tools",
      description: "Notes and checks for meetings.",
      version: "1.2.0",
      author: "Example Author",
      trust: "unverified",
      sourceKind: "folder",
      sourceDisplay: PLUGIN_ID,
      ignored: [],
      installable: true,
      inspectedAt: "2026-10-31T12:00:00.000Z",
      expiresAt: "2026-11-01T12:00:00.000Z",
    });
    expect(inspection.pin).toEqual({ kind: "content", treeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(inspection.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(inspection.refusal).toBeUndefined();
    expect(inspection.pieces.map((item) => [item.pieceId, item.kind, item.check])).toEqual([
      ["meeting-notes", "skill", { status: "ready" }],
      ["notes", "connector", { status: "ready" }],
      ["notes-strict", "connector", { status: "ready" }],
      ["no-browser", "tool_group_off", { status: "ready" }],
      ["tool-watch", "hook", { status: "ready" }],
      ["checks", "prompt_pack", { status: "ready" }],
    ]);
    expect(piece(inspection, "meeting-notes")).toMatchObject({
      label: "meeting-notes",
      skillSnapshotId: expect.stringMatching(/^skill-hub-review-plugin:[a-f0-9]{64}:meeting-notes@1\.4\.2-rc\.1$/u),
    });
    expect(piece(inspection, "notes")).toMatchObject({
      label: "Notes App",
      hosts: ["mcp.notes.test", "auth.notes.test"],
    });
    expect(piece(inspection, "no-browser")).toMatchObject({ label: "Browser" });
    expect(piece(inspection, "tool-watch")).toMatchObject({
      label: "After a tool call",
      hosts: ["hooks.example.test"],
      needsSecret: true,
    });
    expect(piece(inspection, "checks").label).toBe("Meeting checks");

    // The skill went through the Skill Hub's own review of its folder in the snapshot, keyed by that copy and piece.
    const treeSha256 = inspection.pin.kind === "content" ? inspection.pin.treeSha256 : "";
    expect(reviewSkill).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      pluginSkill: {
        snapshotTreeSha256: treeSha256,
        path: "skills/meeting-notes",
        pluginId: PLUGIN_ID,
        pieceId: "meeting-notes",
        trust: "unverified",
        pinLabel: `content:${treeSha256}`,
      },
      idempotencyKey: `plugin:${treeSha256}:meeting-notes@${GATEWAY_VERSION}`,
      actorId: "operator-1",
    });
    // The inspection is kept with the snapshot it read, so installing reads the same bytes, and with its request.
    expect(saved).toEqual([
      {
        inspection,
        snapshotTreeSha256: treeSha256,
        request: {
          actorScope: "operator-1",
          idempotencyKey: "inspect-7f0c",
          payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      },
    ]);
    // The folder it came from is named by its own name only; no path on this computer is kept or answered.
    expect(JSON.stringify(inspection)).not.toContain(path.basename(root));
  });

  it("blocks the whole plugin when one skill is blocked", async () => {
    const pieces: Pieces = [
      { kind: "skill", id: "meeting-notes", path: "skills/meeting-notes" },
      { kind: "skill", id: "other-notes", path: "skills/other-notes" },
      { kind: "tool_group_off", id: "no-browser", groupId: "browser" },
    ];
    const { inspect } = await harness({
      pieces,
      overrides: {
        reviewSkill: vi.fn(async (input: SkillHubSourceReviewInput) =>
          input.idempotencyKey.includes(":other-notes@")
            ? reviewed("review-other", ["PROMPT_INJECTION_DETECTED", "UNKNOWN_FRONTMATTER_DIMENSION"], "other-notes")
            : reviewed("review-meeting"),
        ),
      },
    });

    const inspection = await inspect();

    expect(inspection.installable).toBe(false);
    expect(piece(inspection, "meeting-notes").check).toEqual({ status: "ready" });
    expect(piece(inspection, "other-notes")).toMatchObject({
      label: "other-notes",
      skillSnapshotId: "review-other",
      check: {
        status: "blocked",
        code: "PROMPT_INJECTION_DETECTED",
        message: "This skill didn't pass GoatCitadel's checks.",
      },
    });
    expect(piece(inspection, "no-browser").check).toEqual({ status: "ready" });
  });

  it.each<[string, Partial<PluginSkillCheck>, string, string]>([
    [
      "removed with an earlier install",
      {
        revoked: true,
        installInactive: { allowed: false, blockers: ["RUNTIME_ALREADY_EXISTS", "SOURCE_ALREADY_INSTALLED"] },
      },
      "SOURCE_ALREADY_INSTALLED",
      "This skill was removed with an earlier install. It can't come back until skills can be removed.",
    ],
    [
      "left by an earlier install, with nothing of it running",
      { installInactive: { allowed: false, blockers: ["SOURCE_ALREADY_INSTALLED"] } },
      "SOURCE_ALREADY_INSTALLED",
      "This skill was removed with an earlier install. It can't come back until skills can be removed.",
    ],
    [
      "installed by an earlier install and still running, not revoked",
      { installInactive: { allowed: false, blockers: ["RUNTIME_ALREADY_EXISTS", "SOURCE_ALREADY_INSTALLED"] } },
      "RUNTIME_ALREADY_EXISTS",
      "A skill with this name is already installed.",
    ],
    [
      "revoked, with only its name left installed",
      { revoked: true, installInactive: { allowed: false, blockers: ["RUNTIME_ALREADY_EXISTS"] } },
      "RUNTIME_ALREADY_EXISTS",
      "This skill was removed with an earlier install. It can't come back until skills can be removed.",
    ],
    [
      "taken by another installed skill of that name",
      { installInactive: { allowed: false, blockers: ["RUNTIME_ALREADY_EXISTS"] } },
      "RUNTIME_ALREADY_EXISTS",
      "A skill with this name is already installed.",
    ],
    [
      "refused for another reason",
      { installInactive: { allowed: false, blockers: ["CANDIDATE_INVENTORY_TRUNCATED"] } },
      "CANDIDATE_INVENTORY_TRUNCATED",
      "This skill didn't pass GoatCitadel's checks.",
    ],
  ])("blocks a skill its check can't install: %s", async (_case, overrides, code, message) => {
    const readSkillCheck = vi.fn(async (_workspaceId: string, snapshotId: string) => skillCheck(snapshotId, overrides));
    const { inspect } = await harness({
      pieces: [{ kind: "skill", id: "meeting-notes", path: "skills/meeting-notes" }],
      overrides: { readSkillCheck },
    });

    const inspection = await inspect();

    expect(inspection.installable).toBe(false);
    expect(piece(inspection, "meeting-notes").check).toEqual({ status: "blocked", code, message });
    // Read by the reviewed check's own id, in the inspection's workspace.
    expect(readSkillCheck).toHaveBeenCalledExactlyOnceWith(
      "default",
      piece(inspection, "meeting-notes").skillSnapshotId,
    );
  });

  it("never reads a skill whose check can't be read as installable", async () => {
    for (const [readSkillCheck, logged] of [
      [vi.fn(async () => undefined), 0],
      [
        vi.fn(async (): Promise<PluginSkillCheck> => {
          throw new Error("Skill Hub's store is busy.");
        }),
        1,
      ],
    ] as const) {
      const { inspect, log } = await harness({
        pieces: [{ kind: "skill", id: "meeting-notes", path: "skills/meeting-notes" }],
        overrides: { readSkillCheck },
      });

      const inspection = await inspect();

      expect(inspection.installable).toBe(false);
      expect(piece(inspection, "meeting-notes").check).toEqual({
        status: "blocked",
        code: "SKILL_CHECK_UNREADABLE",
        message: "GoatCitadel can't check this skill.",
      });
      expect(JSON.stringify(inspection)).not.toContain("busy");
      // A read that failed is logged on the server only.
      expect(log.warn).toHaveBeenCalledTimes(logged);
    }
  });

  it("blocks a skill the review refuses, with the review's code, and logs a refusal's cause only on the server", async () => {
    const pieces: Pieces = [
      { kind: "skill", id: "meeting-notes", path: "skills/meeting-notes" },
      { kind: "skill", id: "other-notes", path: "skills/other-notes" },
    ];
    const lookupFault = new ValidationError({
      field: "pluginSkill",
      message: "That plugin's skill isn't available to review.",
    });
    Object.defineProperty(lookupFault, "cause", { value: new Error("EIO reading C:\\data\\plugins\\snapshots\\x") });
    const { inspect, log } = await harness({
      pieces,
      overrides: {
        reviewSkill: vi.fn(async (input: SkillHubSourceReviewInput): Promise<SkillHubReviewResult> => {
          if (input.idempotencyKey.includes(":other-notes@")) throw lookupFault;
          throw new ValidationError({ field: "PROMPT_INJECTION_DETECTED", message: "Skill Hub blocked it." });
        }),
      },
    });

    const inspection = await inspect();

    expect(piece(inspection, "meeting-notes").check).toEqual({
      status: "blocked",
      code: "PROMPT_INJECTION_DETECTED",
      message: "This skill didn't pass GoatCitadel's checks.",
    });
    expect(piece(inspection, "other-notes").check).toEqual({
      status: "blocked",
      code: "PLUGIN_SKILL_UNAVAILABLE",
      message: "That plugin's skill isn't available to review.",
    });
    expect(JSON.stringify(inspection)).not.toContain("EIO");
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      { pieceId: "other-notes", err: expect.objectContaining({ message: expect.stringContaining("EIO") }) },
      "a plugin's skill couldn't be reviewed",
    );
  });

  it("marks an already saved connector as already there", async () => {
    const pieces: Pieces = [
      { kind: "connector", id: "notes", templateId: "notes-app" },
      { kind: "connector", id: "keyed", templateId: "keyed" },
      { kind: "connector", id: "unknown", templateId: "unknown-app" },
    ];
    const { inspect } = await harness({
      pieces,
      overrides: { listSavedConnectorLabels: vi.fn(async () => ["NOTES APP"]) },
    });

    const inspection = await inspect();

    expect(piece(inspection, "notes")).toEqual({
      pieceId: "notes",
      kind: "connector",
      label: "Notes App",
      asksFirst: "Reading runs freely; creating or changing something asks first in Chat.",
      check: { status: "already_there" },
    });
    // The install's own template rule, word for word.
    expect(piece(inspection, "keyed")).toMatchObject({
      label: "Keyed",
      check: { status: "blocked", code: "needsApiKey", message: "Keyed needs an API key. Set it up in Settings." },
    });
    expect(piece(inspection, "unknown")).toMatchObject({
      label: "unknown-app",
      check: { status: "blocked", code: "templateId", message: "This app can't be installed from Capabilities." },
    });
  });

  it("refuses a group that can't be switched off", async () => {
    const pieces: Pieces = [
      { kind: "tool_group_off", id: "core", groupId: "core" },
      { kind: "tool_group_off", id: "invoke", groupId: "mcp.invoke" },
      { kind: "tool_group_off", id: "unknown", groupId: "teleport" },
      { kind: "tool_group_off", id: "web", groupId: "web_search" },
      { kind: "tool_group_off", id: "browser", groupId: "browser" },
    ];
    const { inspect } = await harness({
      pieces,
      overrides: {
        readSettings: vi.fn(async () => ({
          switchedOffToolGroups: ["web_search"],
          networkAllowlist: [],
          typedRunVariablesEnabled: false,
        })),
      },
    });

    const inspection = await inspect();

    const notSwitchable = {
      status: "blocked",
      code: "GROUP_NOT_SWITCHABLE",
      message: "That group can't be switched off.",
    };
    expect(piece(inspection, "core").check).toEqual(notSwitchable);
    expect(piece(inspection, "invoke").check).toEqual(notSwitchable);
    expect(piece(inspection, "unknown").check).toEqual({
      status: "blocked",
      code: "UNKNOWN_TOOL_GROUP",
      message: "GoatCitadel has no tool group with that id.",
    });
    expect(piece(inspection, "web").check).toEqual({ status: "already_there" });
    expect(piece(inspection, "browser").check).toEqual({ status: "ready" });
    expect(inspection.installable).toBe(false);
  });

  it("refuses a hook to a private address", async () => {
    const pieces: Pieces = [
      { kind: "hook", id: "literal", trigger: "session.start", url: "https://10.0.0.5/hook" },
      { kind: "hook", id: "loopback", trigger: "session.start", url: "https://[::1]/hook" },
      { kind: "hook", id: "rebound", trigger: "session.start", url: "https://rebound.example.test/hook" },
      { kind: "hook", id: "missing", trigger: "session.start", url: "https://missing.example.test/hook" },
      { kind: "hook", id: "public", trigger: "session.start", url: "https://hooks.example.test:8443/hook" },
    ];
    const lookupHost = vi.fn(async (hostname: string) => {
      if (hostname === "rebound.example.test") return [{ address: "93.184.216.34" }, { address: "169.254.169.254" }];
      if (hostname === "missing.example.test") throw new Error("ENOTFOUND");
      return [{ address: "93.184.216.34" }];
    });
    const { inspect } = await harness({ pieces, overrides: { lookupHost } });

    const inspection = await inspect();

    const notPublic = { status: "blocked", code: "HOST_NOT_PUBLIC", message: "That address isn't a public host." };
    expect(piece(inspection, "literal").check).toEqual(notPublic);
    expect(piece(inspection, "loopback").check).toEqual(notPublic);
    expect(piece(inspection, "rebound").check).toEqual(notPublic);
    expect(piece(inspection, "missing").check).toEqual({
      status: "blocked",
      code: "HOST_NOT_FOUND",
      message: "That address's host can't be found.",
    });
    expect(piece(inspection, "public")).toMatchObject({ hosts: ["hooks.example.test"], check: { status: "ready" } });
    // A literal address is checked as written; only names are looked up.
    expect(lookupHost.mock.calls.map(([hostname]) => hostname).sort()).toEqual([
      "hooks.example.test",
      "missing.example.test",
      "rebound.example.test",
    ]);
  });

  it("refuses a prompt pack id that is taken", async () => {
    const pieces: Pieces = [
      { kind: "prompt_pack", id: "checks", path: "prompt-packs/checks.md" },
      { kind: "prompt_pack", id: "missing", path: "prompt-packs/missing.md" },
    ];
    const promptPackExists = vi.fn(async (packId: string) => packId === `plugin-${PLUGIN_ID}-checks`);
    const { inspect } = await harness({ pieces, overrides: { promptPackExists } });

    const inspection = await inspect();

    expect(piece(inspection, "checks")).toMatchObject({
      label: "Meeting checks",
      check: {
        status: "blocked",
        code: "PROMPT_PACK_ID_TAKEN",
        message: "Another prompt pack already uses the id this one needs.",
      },
    });
    expect(piece(inspection, "missing").check).toEqual({
      status: "blocked",
      code: "PROMPT_PACK_MISSING",
      message: "The plugin doesn't have that prompt pack file.",
    });
    expect(promptPackExists).toHaveBeenCalledExactlyOnceWith(`plugin-${PLUGIN_ID}-checks`);
    expect(inspection.installable).toBe(false);
  });

  it("answers 409 for a plugin that is already installed", async () => {
    const installed = { pluginId: PLUGIN_ID, name: "Meeting tools" } as StoredPlugin;
    const { inspect, reviewSkill, saved } = await harness({
      overrides: { findInstalled: vi.fn(async (pluginId: string) => (pluginId === PLUGIN_ID ? installed : undefined)) },
    });

    const refusal = await inspect().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ConflictError);
    expect(refusal).toMatchObject({
      httpStatus: 409,
      code: "ALREADY_EXISTS",
      message: "Meeting tools is already installed.",
      details: { pluginId: PLUGIN_ID },
    });
    // Nothing is checked or kept for a plugin that is already there.
    expect(reviewSkill).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  it("writes the exact asks-first lines", async () => {
    const pieces: Pieces = [
      ...EVERY_KIND,
      { kind: "prompt_pack", id: "one", path: "prompt-packs/one.md" },
      { kind: "hook", id: "approvals", trigger: "approval.resolve.after", url: "https://hooks.example.test:8443/a" },
    ];
    const { inspect } = await harness({ pieces });

    const inspection = await inspect();

    expect(Object.fromEntries(inspection.pieces.map((item) => [item.pieceId, item.asksFirst]))).toEqual({
      "meeting-notes": "Follows your tool rules. Added after GoatCitadel's checks, then switched on.",
      notes: "Reading runs freely; creating or changing something asks first in Chat.",
      "notes-strict": "Everything it does asks first in Chat.",
      "no-browser": "Turns Browser off in every chat while installed.",
      "tool-watch": "Sends event details, never message text, to hooks.example.test: After a tool call.",
      checks: "Adds 2 tests to Library › Prompt packs. Nothing runs until you press Run.",
      one: "Adds 1 test to Library › Prompt packs. Nothing runs until you press Run.",
      approvals: "Sends event details, never message text, to hooks.example.test: After an approval is decided.",
    });
    // A pack is named as the prompt-pack owner names it: its Pack-Version, or else the label an install gives it.
    expect(piece(inspection, "checks").label).toBe("Meeting checks");
    expect(piece(inspection, "one").label).toBe("Plugin Meeting tools");
  });

  it("gives two prompt packs that would share a name a name each, the one an install saves", async () => {
    const pieces: Pieces = [
      { kind: "prompt_pack", id: "checks", path: "prompt-packs/checks.md" },
      { kind: "prompt_pack", id: "more-checks", path: "prompt-packs/more.md" },
      { kind: "prompt_pack", id: "one", path: "prompt-packs/one.md" },
    ];
    const { inspect } = await harness({ pieces, files: { "prompt-packs/more.md": PROMPT_PACK_MD } });

    const inspection = await inspect();

    expect(inspection.pieces.map((item) => [item.pieceId, item.label])).toEqual([
      ["checks", "Meeting checks · checks"],
      ["more-checks", "Meeting checks · more-checks"],
      ["one", "Plugin Meeting tools"],
    ]);
    expect(inspection.installable).toBe(true);
  });

  it("keeps a refused manifest's inspection and refuses it with its own code", async () => {
    const { inspect, saved, reviewSkill } = await harness({
      manifest: JSON.stringify({
        schemaVersion: 1,
        pluginId: PLUGIN_ID,
        name: "Meeting tools",
        description: "Notes.",
        version: "1.0.0",
        featureFlags: { durableKernelV1Enabled: false },
        pieces: [{ kind: "tool_group_off", id: "no-browser", groupId: "browser" }],
      }),
    });

    const refusal = await inspect().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(CapabilityPluginManifestRefusedError);
    const { inspection, field } = refusal as CapabilityPluginManifestRefusedError;
    expect(field).toBe("featureFlags");
    expect(inspection).toMatchObject({
      pluginId: "",
      pieces: [],
      installable: false,
      refusal: {
        code: "FEATURE_FLAGS_NOT_ALLOWED",
        message: "Plugins can't carry feature flags or runtime presets.",
      },
    });
    expect(saved.map((entry) => entry.inspection)).toEqual([inspection]);
    expect(reviewSkill).not.toHaveBeenCalled();
  });

  it("refuses a built-in plugin whose manifest names another plugin id, as the list leaves it out", async () => {
    const { inspect, root, pluginDir, saved, reviewSkill } = await harness({
      pieces: [{ kind: "tool_group_off", id: "no-browser", groupId: "browser" }],
    });
    // The same folder ships twice: once under its own id, once under another.
    await fs.cp(pluginDir, path.join(root, "plugins", PLUGIN_ID), { recursive: true });
    await fs.cp(pluginDir, path.join(root, "plugins", "other-tools"), { recursive: true });

    const matching = await inspect({ source: { kind: "built_in", pluginId: PLUGIN_ID } });
    const refusal = (await inspect({
      source: { kind: "built_in", pluginId: "other-tools" },
      idempotencyKey: "inspect-other",
    }).catch((error: unknown) => error)) as CapabilityPluginManifestRefusedError;

    expect(matching).toMatchObject({ pluginId: PLUGIN_ID, trust: "built_in", installable: true });
    expect(refusal).toBeInstanceOf(CapabilityPluginManifestRefusedError);
    expect(refusal.field).toBe("pluginId");
    expect(refusal.inspection).toMatchObject({
      pluginId: "",
      installable: false,
      refusal: {
        code: "MANIFEST_INVALID",
        message: "This built-in plugin's manifest names a different plugin id.",
        field: "pluginId",
      },
    });
    // Kept like any refused manifest, so the same key gets the same answer.
    expect(saved.map((entry) => entry.inspection.refusal?.code)).toEqual([undefined, "MANIFEST_INVALID"]);
    expect(reviewSkill).not.toHaveBeenCalled();
  });

  it("passes a refused source through as the source's own refusal, and keeps nothing", async () => {
    const { service, saved } = await harness();

    const refusal = await service
      .inspect({
        workspaceId: "default",
        source: { kind: "git", url: "https://example.test/owner/repo" },
        actorId: "operator-1",
        actorScope: "operator-1",
        idempotencyKey: "inspect-git",
        log: { warn: vi.fn() },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(PluginSourceError);
    expect(refusal).toMatchObject({ statusCode: 400, reason: "UNTRUSTED_GIT_HOST" });
    expect(saved).toEqual([]);
  });
  it("answers a key it already answered again, from the kept inspection, without fetching or checking", async () => {
    const { inspect, fetchCalls, reviewSkill, saved } = await harness();

    const first = await inspect();
    const again = await inspect();
    const retried = await inspect({ replayOnly: true });

    expect(again).toEqual(first);
    expect(retried).toEqual(first);
    expect(fetchCalls).toHaveLength(1);
    expect(reviewSkill).toHaveBeenCalledOnce();
    expect(saved).toHaveLength(1);
  });

  it("refuses a key reused for another request, and a retry whose answer is no longer kept", async () => {
    const { inspect, fetchCalls } = await harness();
    await inspect();

    const reused = await inspect({ workspaceId: "lab" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const gone = await inspect({ idempotencyKey: "inspect-forgotten", replayOnly: true }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(reused).toBeInstanceOf(ConflictError);
    expect(reused).toMatchObject({
      code: "STATE_CONFLICT",
      message: "This request's key was already used for a different plugin check. Check it with a new key.",
    });
    expect(gone).toBeInstanceOf(ConflictError);
    expect(gone).toMatchObject({
      message: "This plugin check is no longer kept, so its answer can't be sent again. Check the plugin again.",
    });
    expect(fetchCalls).toHaveLength(1);
  });

  it("answers a refused manifest's key again with the same refusal", async () => {
    const { inspect, fetchCalls } = await harness({
      manifest: JSON.stringify({
        schemaVersion: 1,
        pluginId: PLUGIN_ID,
        name: "Meeting tools",
        description: "Notes.",
        version: "1.0.0",
        pieces: [{ kind: "hook", id: "run", trigger: "session.start", url: "https://h.example.test/", command: "x" }],
      }),
    });

    const first = (await inspect().catch((error: unknown) => error)) as CapabilityPluginManifestRefusedError;
    const again = (await inspect().catch((error: unknown) => error)) as CapabilityPluginManifestRefusedError;

    expect(first).toBeInstanceOf(CapabilityPluginManifestRefusedError);
    expect(first.field).toBe("pieces[0].command");
    expect(first.inspection.refusal).toEqual({
      code: "HOOK_CODE_NOT_ALLOWED",
      message: "A plugin's hooks can't run code.",
      field: "pieces[0].command",
    });
    expect(again).toBeInstanceOf(CapabilityPluginManifestRefusedError);
    expect([again.inspection, again.field]).toEqual([first.inspection, first.field]);
    expect(fetchCalls).toHaveLength(1);
  });

  it("keys a skill's review by the copy, the piece and the Gateway's version, so checking again replays one check", async () => {
    const { inspect, reviewSkill } = await harness();

    const first = await inspect();
    const second = await inspect({ idempotencyKey: "inspect-second" });

    const keys = reviewSkill.mock.calls.map(([input]) => input.idempotencyKey);
    const treeSha256 = first.pin.kind === "content" ? first.pin.treeSha256 : "";
    const contentKey = `plugin:${treeSha256}:meeting-notes@${GATEWAY_VERSION}`;
    expect(keys).toEqual([contentKey, contentKey]);
    expect(piece(second, "meeting-notes").skillSnapshotId).toBe(piece(first, "meeting-notes").skillSnapshotId);
  });

  it("checks the same copy once more after a release, under that release's key", async () => {
    const { sources, inspect, reviewSkill } = await harness();

    const first = await inspect();
    sources.gatewayVersion = "1.5.0";
    await inspect({ idempotencyKey: "inspect-next-release" });

    const treeSha256 = first.pin.kind === "content" ? first.pin.treeSha256 : "";
    expect(reviewSkill.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      `plugin:${treeSha256}:meeting-notes@1.4.2-rc.1`,
      `plugin:${treeSha256}:meeting-notes@1.5.0`,
    ]);
    // The longest key the review can be given still fits its own key rule: 256 plain characters.
    const longest = `plugin:${"a".repeat(64)}:${"p".repeat(48)}@${"9".repeat(64)}:4b5c3a3e-6f0e-4c1d-9a7e-2f1b0c9d8e7f`;
    expect(longest.length).toBeLessThanOrEqual(256);
    expect(longest).toMatch(/^[\p{L}\p{N}._:@/+*-]+$/u);
  });

  it("refuses a path the copy can't hold as the manifest's own path refusal, as the preflight does", async () => {
    const { inspect, reviewSkill } = await harness({
      pieces: [{ kind: "skill", id: "meeting-notes", path: "skills/meeting-notes/" }],
    });

    const refusal = (await inspect().catch((error: unknown) => error)) as CapabilityPluginManifestRefusedError;

    expect(refusal).toBeInstanceOf(CapabilityPluginManifestRefusedError);
    expect(refusal.field).toBe("pieces[0].path");
    expect(refusal.inspection.refusal).toMatchObject({ code: "PIECE_PATH_INVALID", field: "pieces[0].path" });
    expect(reviewSkill).not.toHaveBeenCalled();
  });

  it("blocks a skill whose path the snapshot store refuses, without asking for a review", async () => {
    const { inspect, reviewSkill } = await harness({
      pieces: [{ kind: "skill", id: "meeting-notes", path: "skills/meeting-notes" }],
      overrides: {
        resolveSnapshotPath: () => {
          throw new PluginSnapshotPathError("That plugin copy isn't on this computer.");
        },
      },
    });

    const inspection = await inspect();

    expect(piece(inspection, "meeting-notes")).toEqual({
      pieceId: "meeting-notes",
      kind: "skill",
      label: "meeting-notes",
      asksFirst: "Follows your tool rules. Added after GoatCitadel's checks, then switched on.",
      check: { status: "blocked", code: "PIECE_PATH_INVALID", message: "That plugin copy isn't on this computer." },
    });
    expect(inspection.installable).toBe(false);
    expect(reviewSkill).not.toHaveBeenCalled();
  });

  it("checks a skill again under a fresh key when its copy's earlier check came out differently", async () => {
    const differentMaterial = () =>
      new ConflictError({
        code: "WRITE_CONFLICT",
        message: "Skill Hub review idempotency key is already bound to different source material.",
      });
    const reviewSkill = vi.fn(async (input: SkillHubSourceReviewInput): Promise<SkillHubReviewResult> => {
      // The content key's check was made under rules that have since changed; a key of this inspection's own passes.
      if (/^plugin:[a-f0-9]{64}:meeting-notes@[^:]+$/u.test(input.idempotencyKey)) throw differentMaterial();
      return reviewed("skill-hub-review-fresh");
    });
    const { inspect, log } = await harness({
      pieces: [{ kind: "skill", id: "meeting-notes", path: "skills/meeting-notes" }],
      overrides: { reviewSkill },
    });

    const inspection = await inspect();

    const treeSha256 = inspection.pin.kind === "content" ? inspection.pin.treeSha256 : "";
    expect(piece(inspection, "meeting-notes")).toMatchObject({
      check: { status: "ready" },
      skillSnapshotId: "skill-hub-review-fresh",
    });
    expect(reviewSkill.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      `plugin:${treeSha256}:meeting-notes@${GATEWAY_VERSION}`,
      `plugin:${treeSha256}:meeting-notes@${GATEWAY_VERSION}:4b5c3a3e-6f0e-4c1d-9a7e-2f1b0c9d8e7f`,
    ]);
    // Only the piece and the copy are logged, never the review's words.
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      { pieceId: "meeting-notes", treeSha256 },
      "a plugin skill's content key was superseded by a fresh check",
    );
  });

  it("treats a second different-material conflict, on the fresh key, as a fault", async () => {
    const reviewSkill = vi.fn(async (): Promise<SkillHubReviewResult> => {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "Skill Hub review idempotency key is already bound to different source material.",
      });
    });
    const { inspect, log, saved } = await harness({ overrides: { reviewSkill } });

    const fault = await inspect().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(fault).toBeInstanceOf(Error);
    expect(fault).not.toBeInstanceOf(ConflictError);
    expect((fault as Error).message).toBe("A plugin's skill check broke.");
    // The content key once, then the fresh key once: never a third try.
    expect(reviewSkill).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenLastCalledWith(
      {
        pieceId: "meeting-notes",
        err: expect.objectContaining({ name: "ConflictError", message: expect.stringContaining("different source") }),
      },
      "a plugin's skill check broke",
    );
    expect(saved).toEqual([]);
  });

  it("treats any other review conflict as a fault, with its detail in the server log only", async () => {
    const { inspect, log, saved } = await harness({
      overrides: {
        reviewSkill: vi.fn(async (): Promise<SkillHubReviewResult> => {
          throw new ConflictError({
            code: "STATE_CONFLICT",
            message: "Skill Hub review artifact failed exact-byte verification.",
          });
        }),
      },
    });

    const fault = await inspect().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(fault).toBeInstanceOf(Error);
    expect(fault).not.toBeInstanceOf(ConflictError);
    expect((fault as Error).message).toBe("A plugin's skill check broke.");
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      {
        pieceId: "meeting-notes",
        err: expect.objectContaining({ name: "ConflictError", message: expect.stringContaining("exact-byte") }),
      },
      "a plugin's skill check broke",
    );
    expect(saved).toEqual([]);
  });

  it("blocks a prompt pack that declares run variables while typed run variables are off", async () => {
    const declared = [
      "# Topic checks",
      "",
      "```goatcitadel-variables",
      JSON.stringify({ fields: [{ id: "topic", label: "Topic", type: "text", required: true }] }),
      "```",
      "",
      "# Chat",
      "",
      "## No Tools",
      "",
      "### TEST-C901: Topic",
      "",
      "Summarize the topic in two lines.",
      "",
    ].join("\n");
    const pieces: Pieces = [{ kind: "prompt_pack", id: "topics", path: "prompt-packs/topics.md" }];
    const files = { "prompt-packs/topics.md": declared };
    const off = await harness({ pieces, files });
    const on = await harness({
      pieces,
      files,
      overrides: {
        readSettings: vi.fn(async () => ({
          switchedOffToolGroups: [],
          networkAllowlist: [],
          typedRunVariablesEnabled: true,
        })),
      },
    });

    const refused = await off.inspect();
    const allowed = await on.inspect();

    expect(piece(refused, "topics")).toMatchObject({
      asksFirst: "Adds 1 test to Library › Prompt packs. Nothing runs until you press Run.",
      check: {
        status: "blocked",
        code: "PROMPT_PACK_RUN_VARIABLES_OFF",
        message:
          "This prompt pack declares run variables, and typed run variables are switched off. A plugin can't switch them on.",
      },
    });
    expect(piece(allowed, "topics").check).toEqual({ status: "ready" });
  });

  it("blocks a prompt pack the parser refuses, or that isn't text, in plain words with the detail logged", async () => {
    const pieces: Pieces = [
      { kind: "prompt_pack", id: "empty", path: "prompt-packs/empty.md" },
      { kind: "prompt_pack", id: "binary", path: "prompt-packs/binary.md" },
    ];
    const { inspect, log } = await harness({
      pieces,
      files: {
        "prompt-packs/empty.md": "# Nothing to run\n\nJust words.\n",
        "prompt-packs/binary.md": Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x41]),
      },
    });

    const inspection = await inspect();

    expect(piece(inspection, "empty")).toEqual({
      pieceId: "empty",
      kind: "prompt_pack",
      label: "empty",
      asksFirst: "Adds tests to Library › Prompt packs. Nothing runs until you press Run.",
      check: {
        status: "blocked",
        code: "PROMPT_PACK_INVALID",
        message: "The prompt pack file isn't a prompt pack GoatCitadel can read.",
      },
    });
    expect(piece(inspection, "binary").check).toEqual({
      status: "blocked",
      code: "PROMPT_PACK_NOT_TEXT",
      message: "The prompt pack file isn't UTF-8 text.",
    });
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      { pieceId: "empty", err: expect.objectContaining({ message: "No tests found in prompt-pack markdown." }) },
      "a plugin's prompt pack couldn't be read",
    );
  });

  it("lists only the hosts installing a connector would add", async () => {
    const pieces: Pieces = [{ kind: "connector", id: "notes", templateId: "notes-app" }];
    const settings = (networkAllowlist: string[]) =>
      vi.fn(async () => ({ switchedOffToolGroups: [], networkAllowlist, typedRunVariablesEnabled: false }));
    const some = await harness({ pieces, overrides: { readSettings: settings(["mcp.notes.test"]) } });
    const all = await harness({ pieces, overrides: { readSettings: settings(["*.notes.test", "mcp.notes.test"]) } });

    expect(piece(await some.inspect(), "notes")).toMatchObject({
      check: { status: "ready" },
      hosts: ["auth.notes.test"],
    });
    expect(piece(await all.inspect(), "notes")).not.toHaveProperty("hosts");
  });
});

describe("checkHookPiece", () => {
  const hook = (url: string) => ({ kind: "hook" as const, id: "watch", trigger: "session.start" as const, url });

  it("blocks an address the hooks owner refuses, in plain words, without a lookup or hosts", async () => {
    const lookupHost = vi.fn(async () => [{ address: "93.184.216.34" }]);

    const view = await checkHookPiece(hook("http://hooks.example.test/goatcitadel"), lookupHost);

    expect(view).toEqual({
      pieceId: "watch",
      kind: "hook",
      label: "When a session starts",
      asksFirst: "Sends event details, never message text, to its address: When a session starts.",
      check: {
        status: "blocked",
        code: "HOOK_URL_INVALID",
        message: "That hook's address isn't a valid https address.",
      },
      needsSecret: true,
    });
    expect(lookupHost).not.toHaveBeenCalled();
  });

  it("names a refused host in no hosts, and a passing one by its host name without the port", async () => {
    const refused = await checkHookPiece(hook("https://10.0.0.5:8443/hook"), vi.fn());
    const passing = await checkHookPiece(
      hook("https://hooks.example.test:8443/hook"),
      vi.fn(async () => [{ address: "93.184.216.34" }]),
    );

    expect(refused).not.toHaveProperty("hosts");
    expect(refused.check).toMatchObject({ code: "HOST_NOT_PUBLIC" });
    expect(refused.asksFirst).toBe("Sends event details, never message text, to 10.0.0.5: When a session starts.");
    expect(passing).toMatchObject({
      hosts: ["hooks.example.test"],
      asksFirst: "Sends event details, never message text, to hooks.example.test: When a session starts.",
      check: { status: "ready" },
    });
  });

  it("lets a check that breaks, rather than refuses, through as a fault", async () => {
    const broken = vi.fn(async () => ({}) as never);

    await expect(checkHookPiece(hook("https://hooks.example.test/hook"), broken)).rejects.toBeInstanceOf(TypeError);
  });
});
