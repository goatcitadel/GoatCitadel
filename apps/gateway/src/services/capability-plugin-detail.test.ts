import { describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  type ApprovalRequest,
  type ChangePlanStatus,
  type McpServerRecord,
  type PluginManifest,
  type PluginManifestParse,
  type SkillListItem,
} from "@goatcitadel/contracts";
import {
  CapabilitySkillActionsService,
  type CapabilitySkillActionSources,
} from "./capability-skill-actions-service.js";
import { hubApproval, hubItem } from "./capability-skill-install.test-support.js";
import { buildCapabilityConnectors } from "./capability-connectors-projection.js";
import {
  CapabilityPluginStore,
  type CapabilityPluginSettingRows,
  type StoredPlugin,
} from "./capability-plugin-store.js";
import {
  CapabilityPluginsRouteService,
  type CapabilityPluginsRouteSources,
} from "./capability-plugins-route-service.js";
import { buildCapabilitySkillItems } from "./capability-skills-projection.js";
import { CapabilityToolsService } from "./capability-tools-service.js";
import {
  pluginSkillCheck,
  readPluginSkillChecks,
  type ApprovalReading,
  type FindSkillHubChecks,
  type PluginSkillCheck,
} from "./plugin-skill-checks.js";
import type { SkillHubOperatorItem } from "./skill-hub-operator-service.js";

// A plugin's skills go through the Skills tab's own install steps, and the plugin's detail follows each piece: the
// skill pieces by their checks' ids, the rest from the plugin's record. The list and the detail share one rule.

const WORKSPACE = "lab";
const PLUGIN_ID = "browser-checks";
const SKILL_CHECK = "skill-hub-review-browser-qa";
const PIN = { kind: "commit" as const, commit: "c".repeat(40) };
const TREE = "e".repeat(64);
const MANIFEST_SHA = "d".repeat(64);

const MANIFEST: PluginManifest = {
  schemaVersion: 1,
  pluginId: PLUGIN_ID,
  name: "Browser checks",
  description: "Checks pages in a browser.",
  version: "1.2.0",
  author: "Example Labs",
  pieces: [
    { kind: "skill", id: "browser-qa", path: "skills/browser-qa" },
    { kind: "connector", id: "issues", templateId: "linear", asksFirst: "everything" },
    { kind: "tool_group_off", id: "no-git", groupId: "git" },
    { kind: "hook", id: "watch", trigger: "tool.call.after", url: "https://hooks.example.com/goatcitadel" },
    { kind: "prompt_pack", id: "checks", path: "prompt-packs/checks.md" },
  ],
};

const PROMPT_PACK = [
  "# Page checks",
  "",
  "Pack-Version: Page checks",
  "",
  "# Chat",
  "",
  "## No Tools",
  "",
  "### TEST-C901: Summary",
  "",
  "Summarize the page in two lines.",
  "",
].join("\n");

function record(overrides: Partial<StoredPlugin> = {}): StoredPlugin {
  return {
    pluginId: PLUGIN_ID,
    name: "Browser checks",
    description: "Checks pages in a browser.",
    version: "1.2.0",
    trust: "unverified",
    sourceKind: "git",
    sourceDisplay: "github.com/example/browser-checks",
    pin: PIN,
    manifestSha256: MANIFEST_SHA,
    snapshotTreeSha256: TREE,
    workspaceId: WORKSPACE,
    installPlanId: "plan-install-browser-checks",
    state: "installed",
    installedAt: "2026-10-31T12:00:00.000Z",
    pieces: [
      { pieceId: "browser-qa", kind: "skill", owned: true, skillSnapshotId: SKILL_CHECK },
      { pieceId: "issues", kind: "connector", owned: true, ref: "server-linear-1" },
      { pieceId: "no-git", kind: "tool_group_off", owned: true, ref: "git" },
      { pieceId: "watch", kind: "hook", owned: true, ref: "hook-1" },
      { pieceId: "checks", kind: "prompt_pack", owned: true, ref: `plugin-${PLUGIN_ID}-checks` },
    ],
    ...overrides,
  };
}

/** The plugin's skill check, by default switched on. */
function check(overrides: Parameters<typeof hubItem>[0] = {}): SkillHubOperatorItem {
  return hubItem({
    snapshotId: SKILL_CHECK,
    skillId: "extra:browser-qa",
    title: "browser-qa",
    approvals: { activate: hubApproval("activate", "approved", "applied") },
    ...overrides,
    snapshot: {
      sourceProvider: "goatcitadel_plugin",
      sourceType: "local_path",
      sourceRef: `plugin:${PLUGIN_ID}/browser-qa@commit:${"c".repeat(40)}`,
      canonicalSourceKey: `plugin:${PLUGIN_ID}/browser-qa`,
      ...overrides.snapshot,
    },
    runtime: { activeVersion: true, callable: true, ...overrides.runtime },
  });
}

const SWITCHED_ON = check();
const INSTALLED_OFF = check({
  approvals: { install_inactive: hubApproval("install_inactive", "approved", "applied") },
  candidate: {
    candidateId: "candidate-1",
    versionId: "version-1",
    lifecycleState: "candidate",
    createdAt: "2026-10-31T12:00:00.000Z",
    updatedAt: "2026-10-31T12:00:00.000Z",
  },
  runtime: { activeVersion: false, callable: false, inactiveCandidate: true },
});
const NOT_INSTALLED = check({ approvals: {}, runtime: { activeVersion: false, callable: false } });
const WAITING_INSTALL = check({
  approvals: { install_inactive: hubApproval("install_inactive", "pending") },
  runtime: { activeVersion: false, callable: false },
});

function checksOf(...items: SkillHubOperatorItem[]): ReadonlyMap<string, PluginSkillCheck> {
  return new Map(items.map((item) => [item.snapshotId, pluginSkillCheck(item)]));
}

function routeService(overrides: Partial<CapabilityPluginsRouteSources> = {}) {
  const sources: CapabilityPluginsRouteSources = {
    listInstalled: vi.fn(async () => [record()]),
    listBuiltIn: vi.fn(async () => []),
    readSkillChecks: vi.fn(async () => checksOf(SWITCHED_ON)),
    readInstallPlanStatus: vi.fn(async (): Promise<ChangePlanStatus> => "completed"),
    readApproval: vi.fn(async (): Promise<ApprovalReading | undefined> => ({ status: "pending", effects: "done" })),
    readManifest: vi.fn(
      async (): Promise<PluginManifestParse> => ({ ok: true, manifest: MANIFEST, manifestSha256: MANIFEST_SHA }),
    ),
    readSnapshotText: vi.fn(async () => PROMPT_PACK),
    inspect: vi.fn(async () => {
      throw new Error("reading never inspects");
    }),
    readInspection: vi.fn(async () => undefined),
    install: vi.fn(async () => {
      throw new Error("reading never installs");
    }),
    uninstall: vi.fn(async () => {
      throw new Error("reading never uninstalls");
    }),
    loadToolGroupHolds: vi.fn(async () => undefined),
    reportFailure: vi.fn(),
    ...overrides,
  };
  return { service: new CapabilityPluginsRouteService(sources), sources };
}

async function stateInList(service: CapabilityPluginsRouteService, pluginId = PLUGIN_ID) {
  return (await service.list()).installed.find((item) => item.pluginId === pluginId)?.state;
}

describe("a plugin's skill steps", () => {
  /** The Capabilities skill steps over a plugin's check, with the plugin's record as given. */
  function steps(
    plugins: readonly StoredPlugin[],
    snapshot: { sourceProvider: string; sourceRef: string } = {
      sourceProvider: "goatcitadel_plugin",
      sourceRef: `plugin:${PLUGIN_ID}/browser-qa@commit:${"c".repeat(40)}`,
    },
  ) {
    const sources = {
      setSkillState: vi.fn(),
      resolveApproval: vi.fn(async () => ({})),
      readApproval: vi.fn(),
      appendApprovalAudit: vi.fn(async () => undefined),
      deploymentProfile: () => "trusted_local" as const,
      readApprovalSkipSetting: vi.fn(async () => false),
      reviewSkillHubSource: vi.fn(),
      listSkillHub: vi.fn(async () => ({ items: [] })),
      createSkillHubApproval: vi.fn(async () => ({
        approval: { approvalId: "approval-install_inactive", status: "pending" as const },
      })),
      findSkillHubSnapshot: vi.fn(async () => ({ ...snapshot, workspaceId: WORKSPACE })),
      listPluginRecords: vi.fn(async () => plugins),
    } satisfies CapabilitySkillActionSources;
    return { service: new CapabilitySkillActionsService(sources), sources };
  }

  const step = { workspaceId: WORKSPACE, snapshotId: SKILL_CHECK, operationKind: "install_inactive" as const };

  it("accepts a skill step only for a listed piece of an installing plugin", async () => {
    for (const state of ["installing", "installed"] as const) {
      const { service, sources } = steps([record({ state })]);

      await expect(service.requestStep({ ...step, actorId: "operator-1" })).resolves.toEqual({
        status: "waiting",
        approvalId: "approval-install_inactive",
      });
      // Only now, with the plugin's record checked, does the step carry the plugin's pass to Skill Hub's owner.
      expect(sources.createSkillHubApproval).toHaveBeenCalledExactlyOnceWith(
        { ...step, actorId: "operator-1" },
        { pluginPass: { pluginId: PLUGIN_ID } },
      );
    }

    const refusals: Array<[string, StoredPlugin[]]> = [
      ["no record", []],
      ["an uninstall under way", [record({ state: "uninstalling" })]],
      ["another workspace's record", [record({ workspaceId: "default" })]],
      ["a record that doesn't list it", [record({ pieces: [] })]],
      ["another plugin's record", [record({ pluginId: "other-plugin" })]],
    ];
    for (const [label, plugins] of refusals) {
      const { service, sources } = steps(plugins);
      await expect(service.requestStep({ ...step, actorId: "operator-1" }), label).rejects.toMatchObject({
        httpStatus: 409,
        code: "PLUGIN_OWNED",
        message: "This skill came with a plugin. Install the plugin to use it.",
      });
      expect(sources.createSkillHubApproval, label).not.toHaveBeenCalled();
    }
  });

  it("leaves an ordinary skill's step as it was, with no pass and no plugin read", async () => {
    const { service, sources } = steps([record()], {
      sourceProvider: "github",
      sourceRef: "https://github.com/example/skills",
    });

    await service.requestStep({ ...step, actorId: "operator-1" });

    expect(sources.createSkillHubApproval).toHaveBeenCalledExactlyOnceWith({ ...step, actorId: "operator-1" });
    expect(sources.listPluginRecords).not.toHaveBeenCalled();
  });

  it("leaves a check of another workspace to Skill Hub's own refusal", async () => {
    const { service, sources } = steps([record()]);
    sources.findSkillHubSnapshot.mockResolvedValueOnce({
      sourceProvider: "goatcitadel_plugin",
      sourceRef: `plugin:${PLUGIN_ID}/browser-qa@commit:${"c".repeat(40)}`,
      workspaceId: "default",
    });
    sources.createSkillHubApproval.mockRejectedValueOnce(new NotFoundError({ entity: "Skill Hub snapshot" }));

    await expect(service.requestStep({ ...step, actorId: "operator-1" })).rejects.toBeInstanceOf(NotFoundError);
    expect(sources.createSkillHubApproval).toHaveBeenCalledExactlyOnceWith({ ...step, actorId: "operator-1" });
  });
});

describe("a plugin's detail", () => {
  it("shows a skill piece waiting for its install approval", async () => {
    const { service } = routeService({ readSkillChecks: vi.fn(async () => checksOf(WAITING_INSTALL)) });

    const detail = await service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });

    expect(detail.pieces[0]).toEqual({
      pieceId: "browser-qa",
      kind: "skill",
      label: "browser-qa",
      asksFirst: "Follows your tool rules. Added after GoatCitadel's checks, then switched on.",
      check: { status: "ready" },
      skillSnapshotId: SKILL_CHECK,
      state: "waiting_for_approval",
      pendingApprovalId: "approval-install_inactive",
    });
    expect(detail.state).toBe("install_not_finished");
  });

  it("marks the plugin not finished until every skill is switched on", async () => {
    const cases: Array<[SkillHubOperatorItem, string, string]> = [
      [NOT_INSTALLED, "check_passed", "install_not_finished"],
      [WAITING_INSTALL, "waiting_for_approval", "install_not_finished"],
      [INSTALLED_OFF, "installed_off", "install_not_finished"],
      [
        check({
          approvals: { activate: hubApproval("activate", "pending") },
          runtime: { activeVersion: false, callable: false, inactiveCandidate: true },
        }),
        "waiting_for_approval",
        "install_not_finished",
      ],
      [
        check({
          approvals: { activate: hubApproval("activate", "approved") },
          runtime: { activeVersion: false, callable: false, inactiveCandidate: true },
        }),
        "installing",
        "install_not_finished",
      ],
      [
        check({ approvals: { activate: hubApproval("activate", "approved", "blocked") } }),
        "failed",
        "install_not_finished",
      ],
      [SWITCHED_ON, "added", "installed"],
    ];
    for (const [item, pieceState, pluginState] of cases) {
      const { service } = routeService({ readSkillChecks: vi.fn(async () => checksOf(item)) });

      const detail = await service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });

      expect(detail.pieces[0]?.state, pieceState).toBe(pieceState);
      expect(detail.state, pieceState).toBe(pluginState);
      // The list reads the same plugin the same way.
      expect(await stateInList(service), pieceState).toBe(pluginState);
    }
  });

  it("reads unknown when the skill list fails", async () => {
    const failure = new Error("database is locked");
    const { service, sources } = routeService({
      readSkillChecks: vi.fn(async () => {
        throw failure;
      }),
    });

    const detail = await service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });

    expect(detail.pieces[0]).toMatchObject({ kind: "skill", state: "unknown" });
    expect(detail.pieces[0]).not.toHaveProperty("href");
    // Never installed, in the detail or the list, while a skill's state can't be read.
    expect(detail.state).toBe("install_not_finished");
    expect(await stateInList(service)).toBe("install_not_finished");
    expect(sources.reportFailure).toHaveBeenCalledWith("skill_hub", failure);
    // A check that isn't there reads unknown too.
    const missing = routeService({ readSkillChecks: vi.fn(async () => new Map()) });
    expect((await missing.service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" })).pieces[0]?.state).toBe(
      "unknown",
    );
  });

  it("reads each skill check by its id, never from the workspace's newest checks", async () => {
    const readSkillChecks = vi.fn(async () => checksOf(SWITCHED_ON));
    const { service } = routeService({ readSkillChecks });

    await service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });
    await service.list();

    // The plugin's own workspace and the check ids its record lists, once for the detail and once for the list.
    expect(readSkillChecks.mock.calls).toEqual([
      [WORKSPACE, [SKILL_CHECK]],
      [WORKSPACE, [SKILL_CHECK]],
    ]);
  });

  it("writes each piece's link and label, and the plugin's own details", async () => {
    const { service, sources } = routeService();

    const detail = await service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });

    expect(detail).toMatchObject({
      pluginId: PLUGIN_ID,
      name: "Browser checks",
      version: "1.2.0",
      author: "Example Labs",
      trust: "unverified",
      sourceDisplay: "github.com/example/browser-checks",
      state: "installed",
      pin: PIN,
      installPlanId: "plan-install-browser-checks",
      installedAt: "2026-10-31T12:00:00.000Z",
      pieceCounts: { skill: 1, connector: 1, tool_group_off: 1, hook: 1, prompt_pack: 1 },
    });
    expect(detail.pieces.map((piece) => [piece.pieceId, piece.state, piece.label, piece.href])).toEqual([
      ["browser-qa", "added", "browser-qa", "/capabilities/skills?item=skill:extra:browser-qa"],
      [
        "issues",
        "added",
        "Linear",
        `/capabilities/connectors?item=${encodeURIComponent("mcp-server:server-linear-1")}`,
      ],
      ["no-git", "added", "Git", "/capabilities/tools?item=group:git"],
      ["watch", "added", "After a tool call", "/settings/safety#hooks"],
      ["checks", "added", "Page checks", `/library/prompt-packs?view=pack:plugin-${PLUGIN_ID}-checks`],
    ]);
    expect(detail.pieces.find((piece) => piece.pieceId === "issues")?.asksFirst).toBe(
      "Everything it does asks first in Chat.",
    );
    expect(detail.pieces.find((piece) => piece.pieceId === "watch")).toMatchObject({
      asksFirst: "Sends event details, never message text, to hooks.example.com: After a tool call.",
      hosts: ["hooks.example.com"],
    });
    expect(detail.pieces.find((piece) => piece.pieceId === "checks")?.asksFirst).toBe(
      "Adds 1 test to Library › Prompt packs. Nothing runs until you press Run.",
    );
    expect(sources.readManifest).toHaveBeenCalledExactlyOnceWith(TREE);
    expect(sources.readInstallPlanStatus).not.toHaveBeenCalled();
  });

  it("reads a piece already there as kept, and links a kept group", async () => {
    const { service } = routeService({
      listInstalled: vi.fn(async () => [
        record({
          pieces: [
            { pieceId: "browser-qa", kind: "skill", owned: true, skillSnapshotId: SKILL_CHECK },
            { pieceId: "issues", kind: "connector", owned: false },
            { pieceId: "no-git", kind: "tool_group_off", owned: false },
          ],
        }),
      ]),
    });

    const detail = await service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });

    expect(detail.pieces.map((piece) => [piece.pieceId, piece.state, piece.check, piece.href])).toEqual([
      ["browser-qa", "added", { status: "ready" }, "/capabilities/skills?item=skill:extra:browser-qa"],
      // The record keeps no saved server's id for a connector that was already there, so it has no link.
      ["issues", "kept", { status: "already_there" }, undefined],
      ["no-git", "kept", { status: "already_there" }, "/capabilities/tools?item=group:git"],
    ]);
    expect(detail.state).toBe("installed");
  });

  it("reads a piece an install stopped before as failed, and one still on its way as installing", async () => {
    const installing = record({
      state: "installing",
      pieces: [
        { pieceId: "issues", kind: "connector", owned: true, ref: "server-linear-1" },
        { pieceId: "no-git", kind: "tool_group_off", owned: true },
      ],
    });
    const statuses: Array<[ChangePlanStatus | Error, string]> = [
      ["manual_required", "failed"],
      ["failed", "failed"],
      // Being rolled back, it won't add the piece; still being checked after it applied, it might.
      ["rolling_back", "failed"],
      ["monitoring", "installing"],
      ["applying", "installing"],
      [new Error("database is locked"), "unknown"],
    ];
    for (const [status, state] of statuses) {
      const readInstallPlanStatus = vi.fn(async (): Promise<ChangePlanStatus> => {
        if (status instanceof Error) throw status;
        return status;
      });
      const { service } = routeService({ listInstalled: vi.fn(async () => [installing]), readInstallPlanStatus });

      const detail = await service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });

      expect(
        detail.pieces.map((piece) => piece.state),
        String(status),
      ).toEqual(["added", state]);
      expect(detail.state).toBe("install_not_finished");
      expect(readInstallPlanStatus).toHaveBeenCalledExactlyOnceWith(
        WORKSPACE,
        "plan-install-browser-checks",
        "operator-1",
      );
      expect(detail.pieces[1]).not.toHaveProperty("href");
    }
  });

  it("reads a piece as removed only once the uninstall removed it, and a revoke still waiting as waiting", async () => {
    const waitingRevoke = check({ approvals: { revoke: hubApproval("revoke", "pending") } });
    // The uninstall removed the connector and the hook; the group and the pack are still there.
    const removing = record({
      state: "uninstalling",
      uninstallPlanId: "plan-uninstall-browser-checks",
      pieces: [
        { pieceId: "browser-qa", kind: "skill", owned: true, skillSnapshotId: SKILL_CHECK },
        { pieceId: "issues", kind: "connector", owned: true },
        { pieceId: "no-git", kind: "tool_group_off", owned: true, ref: "git" },
        { pieceId: "watch", kind: "hook", owned: true },
        { pieceId: "checks", kind: "prompt_pack", owned: true, ref: `plugin-${PLUGIN_ID}-checks` },
      ],
    });
    const statuses: Array<[ChangePlanStatus | Error, string]> = [
      ["applying", "added"],
      ["manual_required", "failed"],
      [new Error("database is locked"), "unknown"],
    ];
    for (const [status, left] of statuses) {
      const readInstallPlanStatus = vi.fn(async (): Promise<ChangePlanStatus> => {
        if (status instanceof Error) throw status;
        return status;
      });
      const { service } = routeService({
        listInstalled: vi.fn(async () => [removing]),
        readSkillChecks: vi.fn(async () => checksOf(waitingRevoke)),
        readInstallPlanStatus,
      });

      const detail = await service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });

      expect(detail.state).toBe("uninstalling");
      expect(
        detail.pieces.map((piece) => [piece.pieceId, piece.state, piece.pendingApprovalId]),
        String(status),
      ).toEqual([
        ["browser-qa", "waiting_for_approval", "approval-revoke"],
        ["issues", "removed", undefined],
        ["no-git", left, undefined],
        ["watch", "removed", undefined],
        ["checks", left, undefined],
      ]);
      // The pieces still there are read from the uninstall plan, never the install's.
      expect(readInstallPlanStatus).toHaveBeenCalledExactlyOnceWith(
        WORKSPACE,
        "plan-uninstall-browser-checks",
        "operator-1",
      );
      expect(detail.pieces.filter((piece) => piece.state === "removed").every((piece) => !piece.href)).toBe(true);
    }
  });

  it("reads a skill the uninstall removed as removed, and one still waiting by the revoke its record kept", async () => {
    const removing = (
      pieces: StoredPlugin["pieces"],
      status: ApprovalRequest["status"] = "pending",
      effects: ApprovalReading["effects"] = "running",
    ) =>
      routeService({
        listInstalled: vi.fn(async () => [record({ state: "uninstalling", pieces })]),
        // Switched on, with no revoke among the check's newest approvals.
        readSkillChecks: vi.fn(async () => checksOf(SWITCHED_ON)),
        readApproval: vi.fn(async () => ({ status, effects })),
      }).service;
    const skill = { pieceId: "browser-qa", kind: "skill" as const, owned: true, skillSnapshotId: SKILL_CHECK };

    const removed = await removing([{ ...skill, removed: { skillId: "extra:browser-qa" } }]).detail({
      pluginId: PLUGIN_ID,
      actorId: "operator-1",
    });
    expect(removed.pieces.map((piece) => [piece.state, piece.href])).toEqual([["removed", undefined]]);

    const waiting = await removing([
      { ...skill, waiting: { approvalId: "approval-revoke-old", operation: "revoke" } },
    ]).detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });
    expect(waiting.pieces.map((piece) => [piece.state, piece.pendingApprovalId])).toEqual([
      ["waiting_for_approval", "approval-revoke-old"],
    ]);

    // Approved in the Inbox, and not in effect yet: being removed, with nothing left to approve.
    const approved = await removing(
      [{ ...skill, waiting: { approvalId: "approval-revoke-old", operation: "revoke" } }],
      "approved",
    ).detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });
    expect(approved.pieces.map((piece) => [piece.state, piece.pendingApprovalId])).toEqual([["removing", undefined]]);

    // Approved, and its work failed or ended without revoking it: nothing is being removed any more, so it reads as
    // its check does, still switched on.
    for (const effects of ["failed", "done"] as const) {
      const ended = await removing(
        [{ ...skill, waiting: { approvalId: "approval-revoke-old", operation: "revoke" } }],
        "approved",
        effects,
      ).detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });
      expect(
        ended.pieces.map((piece) => [piece.state, piece.pendingApprovalId]),
        effects,
      ).toEqual([["added", undefined]]);
    }

    // Refused: it reads as its check does, still switched on.
    const refused = await removing(
      [{ ...skill, waiting: { approvalId: "approval-revoke-old", operation: "revoke" } }],
      "rejected",
    ).detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });
    expect(refused.pieces.map((piece) => [piece.state, piece.pendingApprovalId])).toEqual([["added", undefined]]);

    // Not reached yet: it reads as its check does, still switched on.
    const notYet = await removing([skill]).detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });
    expect(notYet.pieces.map((piece) => piece.state)).toEqual(["added"]);

    // A revoke the check shows approved, whoever asked for it, reads as being removed while its work runs, and as its
    // check does once it settled (blocked here) or its work failed.
    const readRevoke = async (settled: "blocked" | undefined, effects: ApprovalReading["effects"]) => {
      const readApproval = vi.fn(async () => ({ status: "approved" as const, effects }));
      const detail = await routeService({
        listInstalled: vi.fn(async () => [record({ state: "uninstalling", pieces: [skill] })]),
        readSkillChecks: vi.fn(async () =>
          checksOf(
            check({
              approvals: {
                activate: hubApproval("activate", "approved", "applied"),
                revoke: hubApproval("revoke", "approved", settled),
              },
            }),
          ),
        ),
        readApproval,
      }).service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });
      return { states: detail.pieces.map((piece) => [piece.state, piece.pendingApprovalId]), readApproval };
    };
    const running = await readRevoke(undefined, "running");
    expect(running.states).toEqual([["removing", undefined]]);
    // Its work is read by the approval's own id.
    expect(running.readApproval).toHaveBeenCalledWith("approval-revoke");
    expect((await readRevoke(undefined, "failed")).states).toEqual([["added", undefined]]);
    expect((await readRevoke("blocked", "done")).states).toEqual([["added", undefined]]);
  });

  it("reads the installed skill of a check's name as revoked by its own lifecycle, whichever check installed it", () => {
    const lifecycle = {
      skillId: "extra:browser-qa",
      lifecycleState: "revoked",
    } as SkillHubOperatorItem["runtime"]["lifecycle"];
    // A check of a changed copy has no version of its own: only the runtime says it was revoked.
    const item = check({
      candidate: undefined,
      runtime: { activeVersion: false, callable: false, inactiveCandidate: false, lifecycle },
    });

    expect(pluginSkillCheck(item)).toMatchObject({ revoked: false, runtimeRevoked: true });
    expect(pluginSkillCheck(SWITCHED_ON)).toMatchObject({ revoked: false, runtimeRevoked: false });
  });

  it("reads a connector the uninstall handed to the operator as kept, not removed", async () => {
    const { service } = routeService({
      listInstalled: vi.fn(async () => [
        record({
          state: "uninstalling",
          pieces: [{ pieceId: "issues", kind: "connector", owned: false, handedOver: true }],
        }),
      ]),
    });

    const detail = await service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });

    expect(detail.pieces.map((piece) => [piece.pieceId, piece.state])).toEqual([["issues", "kept"]]);
  });

  it("keeps the pieces when the snapshot's manifest can't be read, labelled by their ids", async () => {
    const { service, sources } = routeService({
      readManifest: vi.fn(
        async (): Promise<PluginManifestParse> => ({ ok: true, manifest: MANIFEST, manifestSha256: "f".repeat(64) }),
      ),
    });

    const detail = await service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });

    // A manifest that isn't the one installed tells nothing about these pieces.
    expect(detail.author).toBeUndefined();
    expect(detail.pieces.map((piece) => [piece.pieceId, piece.label, piece.state])).toEqual([
      ["browser-qa", "browser-qa", "added"],
      ["issues", "issues", "added"],
      ["no-git", "Git", "added"],
      ["watch", "watch", "added"],
      ["checks", "checks", "added"],
    ]);
    expect(detail.pieces.find((piece) => piece.pieceId === "issues")?.asksFirst).toBe(
      "Its details can't be read right now.",
    );
    expect(sources.reportFailure).toHaveBeenCalledWith("snapshot", expect.any(Error));
  });

  it("answers a plugin that isn't installed with 404", async () => {
    const { service } = routeService({ listInstalled: vi.fn(async () => []) });

    await expect(service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" })).rejects.toMatchObject({
      httpStatus: 404,
      message: "This plugin isn't installed.",
    });
  });

  it("never writes the store on read", async () => {
    const rows: CapabilityPluginSettingRows = {
      get: vi.fn(async () => ({
        key: "capability_plugins_v1",
        value: { version: 1, plugins: [record({ state: "installing" })], inspections: [] },
        updatedAt: "2026-10-31T12:00:00.000Z",
      })),
      compareAndSet: vi.fn(async () => undefined),
    };
    const store = new CapabilityPluginStore(rows);
    const { service, sources } = routeService({
      listInstalled: () => store.list(),
      readInstallPlanStatus: vi.fn(async (): Promise<ChangePlanStatus> => "completed"),
    });

    await service.detail({ pluginId: PLUGIN_ID, actorId: "operator-1" });
    await service.list();

    expect(rows.compareAndSet).not.toHaveBeenCalled();
    expect(sources.install).not.toHaveBeenCalled();
    expect(sources.inspect).not.toHaveBeenCalled();
  });

  it("agrees with the list on every plugin's state", async () => {
    const plugins = [
      record({ pluginId: "all-on" }),
      record({
        pluginId: "half-on",
        pieces: [{ pieceId: "a", kind: "skill", owned: true, skillSnapshotId: "check-off" }],
      }),
      record({ pluginId: "still-installing", state: "installing" }),
      record({ pluginId: "removing", state: "uninstalling" }),
      record({
        pluginId: "no-skills",
        pieces: [{ pieceId: "no-git", kind: "tool_group_off", owned: true, ref: "git" }],
      }),
      record({
        pluginId: "unread",
        workspaceId: "broken",
        pieces: [{ pieceId: "a", kind: "skill", owned: true, skillSnapshotId: SKILL_CHECK }],
      }),
    ];
    const readSkillChecks = vi.fn(async (workspaceId: string) => {
      if (workspaceId === "broken") throw new Error("database is locked");
      return checksOf(SWITCHED_ON, { ...INSTALLED_OFF, snapshotId: "check-off" });
    });
    const { service } = routeService({ listInstalled: vi.fn(async () => plugins), readSkillChecks });

    const listed = await service.list();
    const states = Object.fromEntries(listed.installed.map((item) => [item.pluginId, item.state]));

    expect(states).toEqual({
      "all-on": "installed",
      "half-on": "install_not_finished",
      "still-installing": "install_not_finished",
      removing: "uninstalling",
      "no-skills": "installed",
      unread: "install_not_finished",
    });
    for (const plugin of plugins) {
      const detail = await service.detail({ pluginId: plugin.pluginId, actorId: "operator-1" });
      expect(detail.state, plugin.pluginId).toBe(states[plugin.pluginId]);
    }
  });
});

describe("a plugin's skill checks, read by their ids", () => {
  it("says whether each is installed off or switched on, revoked, waiting, and whether installing it is refused", () => {
    expect(pluginSkillCheck(SWITCHED_ON)).toMatchObject({
      skillId: "extra:browser-qa",
      version: "switched_on",
      revoked: false,
      step: "done",
    });
    expect(pluginSkillCheck(INSTALLED_OFF)).toMatchObject({
      skillId: "extra:browser-qa",
      version: "installed_off",
      step: "installed_off",
    });
    // Not installed: no skill id yet, so no link to a Skills item either.
    expect(pluginSkillCheck(WAITING_INSTALL)).toMatchObject({
      version: "none",
      pendingApprovals: { install_inactive: "approval-install_inactive" },
    });
    expect(pluginSkillCheck(WAITING_INSTALL)).not.toHaveProperty("skillId");
    const revoked = check({
      approvals: { revoke: hubApproval("revoke", "approved", "applied") },
      candidate: { ...INSTALLED_OFF.candidate!, lifecycleState: "revoked" },
      runtime: { activeVersion: false, callable: false, inactiveCandidate: true },
      actions: {
        install_inactive: { allowed: false, blockers: ["RUNTIME_ALREADY_EXISTS", "SOURCE_ALREADY_INSTALLED"] },
      },
    });
    // What an uninstall reads before it revokes, and a reinstall reads before it is refused.
    expect(pluginSkillCheck(revoked)).toMatchObject({
      revoked: true,
      pendingApprovals: {},
      installInactive: { allowed: false, blockers: ["RUNTIME_ALREADY_EXISTS", "SOURCE_ALREADY_INSTALLED"] },
    });
  });

  it("reads at most 100 ids at a time, each id once", async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `check-${index}`);
    const findChecks = vi.fn<FindSkillHubChecks>(async ({ snapshotIds }) =>
      snapshotIds.filter((id) => id !== "check-7").map((snapshotId) => check({ snapshotId })),
    );

    const checks = await readPluginSkillChecks(findChecks, WORKSPACE, [...ids, "check-0"]);

    expect(findChecks.mock.calls.map(([input]) => [input.workspaceId, input.snapshotIds.length])).toEqual([
      [WORKSPACE, 100],
      [WORKSPACE, 50],
    ]);
    // A check that isn't there is left out, so its piece reads unknown.
    expect(checks.size).toBe(149);
    expect(checks.has("check-7")).toBe(false);
    expect(await readPluginSkillChecks(findChecks, WORKSPACE, [])).toEqual(new Map());
    expect(findChecks).toHaveBeenCalledTimes(2);
  });
});

describe("pieces a plugin added, in their own tabs", () => {
  it("marks a plugin's skill, connector and held group with the plugin's name", async () => {
    const fromPlugin = { pluginId: PLUGIN_ID, name: "Browser checks" };

    // The skill was switched on from the check the plugin's record lists.
    const skill: SkillListItem = {
      skillId: "extra:browser-qa",
      name: "browser-qa",
      description: "Checks a page.",
      source: "extra",
      dir: "skills/extra/browser-qa",
      declaredTools: [],
      requires: [],
      keywords: [],
      instructionBody: "",
      mtime: "2026-10-31T12:00:00.000Z",
      state: "enabled",
      revision: 2,
      callable: true,
      lifecycle: {
        skillId: "extra:browser-qa",
        category: "community_imported",
        lifecycleState: "approved",
        trustLabel: "Approved upstream snapshot",
        provenance: { source: "extra", sourceRef: SKILL_CHECK },
        createdAt: "2026-10-31T12:00:00.000Z",
        updatedAt: "2026-10-31T12:00:00.000Z",
      },
    } as SkillListItem;
    const other: SkillListItem = { ...skill, skillId: "extra:other", name: "other", lifecycle: undefined };
    const items = buildCapabilitySkillItems({
      skills: [skill, other],
      pendingApprovalIds: new Map(),
      switchableSkillIds: new Set(),
      shippedSkillDirs: { folders: new Set(), packs: new Set() },
      pluginSkills: new Map([[SKILL_CHECK, fromPlugin]]),
    });
    expect(items.find((item) => item.skillId === "extra:browser-qa")?.fromPlugin).toEqual(fromPlugin);
    expect(items.find((item) => item.skillId === "extra:other")).not.toHaveProperty("fromPlugin");

    // The connector's own record names the plugin that saved it.
    const server: McpServerRecord = {
      serverId: "server-linear-1",
      label: "Linear",
      transport: "http",
      url: "https://mcp.linear.app/mcp",
      authType: "none",
      enabled: false,
      status: "disconnected",
      category: "development",
      trustTier: "restricted",
      costTier: "free",
      policy: {
        requireFirstToolApproval: true,
        redactionMode: "basic",
        allowedToolPatterns: [],
        blockedToolPatterns: [],
      },
      pluginOwner: { ...fromPlugin, installPlanId: "plan-install-browser-checks" },
      createdAt: "2026-10-31T12:00:00.000Z",
      updatedAt: "2026-10-31T12:00:00.000Z",
    };
    const { pluginOwner: _owner, ...mine } = server;
    const connectors = buildCapabilityConnectors({
      templates: [],
      servers: [server, { ...mine, serverId: "server-2", label: "Mine" }],
      integrationCatalog: [],
      connections: [],
      googleStatusByConnectionId: new Map(),
      webSearch: [],
      firecrawl: { enabled: false, selfHosted: false },
      hiddenServerIds: new Set(),
      hiddenConnectionIds: new Set(),
      chat: { staticMcp: true, durableExecution: true },
    });
    expect(connectors.find((item) => item.serverId === "server-linear-1")?.fromPlugin).toEqual(fromPlugin);
    expect(connectors.find((item) => item.serverId === "server-2")).not.toHaveProperty("fromPlugin");

    // The group a plugin holds off reads off, held by that plugin, whatever the operator's own switch says.
    const tools = new CapabilityToolsService({
      listToolCatalog: () => [],
      readSettings: async () => ({
        revision: 4,
        switchedOffToolGroups: ["git"],
        pluginToolGroupHolds: [{ groupId: "git", pluginId: PLUGIN_ID, pluginName: "Browser checks" }],
      }),
      resolvePolicyContext: async () => ({}) as never,
      inspectAccess: async () => ({ allowed: true, requiresApproval: false, reasonCodes: [] }) as never,
      probeArgs: () => ({}),
      isBlockedByInstall: () => false,
    });
    const groups = (await tools.list(WORKSPACE)).groups;
    expect(groups.find((group) => group.groupId === "git")).toMatchObject({ state: "off", heldOffBy: [fromPlugin] });
    expect(groups.find((group) => group.groupId === "browser")).not.toHaveProperty("heldOffBy");
  });
});
