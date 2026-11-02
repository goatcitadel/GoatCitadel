import { describe, expect, it, vi } from "vitest";
import type { ChangePlanStatus, PluginManifest, PluginManifestParse } from "@goatcitadel/contracts";
import { hubApproval, hubItem } from "./capability-skill-install.test-support.js";
import type { StoredPlugin } from "./capability-plugin-store.js";
import {
  CapabilityPluginsRouteService,
  type CapabilityPluginsRouteSources,
} from "./capability-plugins-route-service.js";
import { pluginSkillCheck, type ApprovalReading } from "./plugin-skill-checks.js";
import type { SkillHubOperatorItem } from "./skill-hub-operator-service.js";

// A skill piece links to its Skills item only once the Skills list has that item: when the piece reads added. Before
// that the link would open "This skill isn't in the list anymore."

const PLUGIN_ID = "meeting-tools";
const SKILL_CHECK = "skill-hub-review-notes";
const MANIFEST_SHA = "d".repeat(64);

const MANIFEST: PluginManifest = {
  schemaVersion: 1,
  pluginId: PLUGIN_ID,
  name: "Meeting tools",
  description: "Notes for meetings.",
  version: "1.0.0",
  pieces: [{ kind: "skill", id: "notes", path: "skills/notes" }],
};

function record(): StoredPlugin {
  return {
    pluginId: PLUGIN_ID,
    name: "Meeting tools",
    description: "Notes for meetings.",
    version: "1.0.0",
    trust: "unverified",
    sourceKind: "git",
    sourceDisplay: "github.com/example/meeting-tools",
    pin: { kind: "commit", commit: "c".repeat(40) },
    manifestSha256: MANIFEST_SHA,
    snapshotTreeSha256: "e".repeat(64),
    workspaceId: "lab",
    installPlanId: "plan-install",
    state: "installing",
    installedAt: "2026-10-31T12:00:00.000Z",
    pieces: [{ pieceId: "notes", kind: "skill", owned: true, skillSnapshotId: SKILL_CHECK }],
  };
}

function check(overrides: Parameters<typeof hubItem>[0] = {}): SkillHubOperatorItem {
  return hubItem({
    snapshotId: SKILL_CHECK,
    skillId: "extra:notes",
    title: "notes",
    approvals: { activate: hubApproval("activate", "approved", "applied") },
    ...overrides,
    snapshot: {
      sourceProvider: "goatcitadel_plugin",
      sourceType: "local_path",
      sourceRef: `plugin:${PLUGIN_ID}/notes@commit:${"c".repeat(40)}`,
      canonicalSourceKey: `plugin:${PLUGIN_ID}/notes`,
      ...overrides.snapshot,
    },
    runtime: { activeVersion: true, callable: true, ...overrides.runtime },
  });
}

const CANDIDATE = {
  candidateId: "candidate-1",
  versionId: "version-1",
  lifecycleState: "candidate" as const,
  createdAt: "2026-10-31T12:00:00.000Z",
  updatedAt: "2026-10-31T12:00:00.000Z",
};

function detailWith(item: SkillHubOperatorItem) {
  const sources: CapabilityPluginsRouteSources = {
    listInstalled: vi.fn(async () => [record()]),
    listBuiltIn: vi.fn(async () => []),
    builtInUnavailable: vi.fn(() => false),
    readSkillChecks: vi.fn(async () => new Map([[item.snapshotId, pluginSkillCheck(item)]])),
    readInstallPlanStatus: vi.fn(async (): Promise<ChangePlanStatus> => "completed"),
    readApproval: vi.fn(async (): Promise<ApprovalReading | undefined> => ({ status: "pending", effects: "done" })),
    readManifest: vi.fn(
      async (): Promise<PluginManifestParse> => ({ ok: true, manifest: MANIFEST, manifestSha256: MANIFEST_SHA }),
    ),
    readSnapshotText: vi.fn(async () => ""),
    inspect: vi.fn(),
    readInspection: vi.fn(async () => undefined),
    install: vi.fn(),
    uninstall: vi.fn(),
    loadToolGroupHolds: vi.fn(async () => undefined),
    readOperatorApprovalSkip: vi.fn(async () => false),
    folderSourcesAllowed: vi.fn(() => true),
    reportFailure: vi.fn(),
  };
  return new CapabilityPluginsRouteService(sources).detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });
}

describe("a plugin skill piece's link", () => {
  it("links the skill only once the piece reads added", async () => {
    const cases: Array<[string, SkillHubOperatorItem, string | undefined]> = [
      [
        "installed_off",
        check({
          approvals: { install_inactive: hubApproval("install_inactive", "approved", "applied") },
          candidate: CANDIDATE,
          runtime: { activeVersion: false, callable: false, inactiveCandidate: true },
        }),
        undefined,
      ],
      [
        "waiting_for_approval",
        check({
          approvals: { activate: hubApproval("activate", "pending") },
          candidate: CANDIDATE,
          runtime: { activeVersion: false, callable: false, inactiveCandidate: true },
        }),
        undefined,
      ],
      [
        "installing",
        check({
          approvals: { activate: hubApproval("activate", "approved") },
          candidate: CANDIDATE,
          runtime: { activeVersion: false, callable: false, inactiveCandidate: true },
        }),
        undefined,
      ],
      ["added", check(), "/capabilities/skills?item=skill:extra:notes"],
    ];
    for (const [state, item, href] of cases) {
      const detail = await detailWith(item);

      expect(detail.pieces[0]?.state, state).toBe(state);
      expect(detail.pieces[0]?.href, state).toBe(href);
    }
  });
});
