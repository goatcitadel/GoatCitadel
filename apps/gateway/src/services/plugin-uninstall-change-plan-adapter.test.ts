import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  ChangePlanRecord,
  DeploymentProfile,
  HookCreateInput,
  McpServerRecord,
} from "@goatcitadel/contracts";
import {
  CapabilitySkillActionsService,
  OPERATOR_SKILL_SKIP_NOTES,
  type CapabilitySkillActionSources,
} from "./capability-skill-actions-service.js";
import { hubApproval } from "./capability-skill-install.test-support.js";
import { pluginToolGroupHolds, type StoredPlugin } from "./capability-plugin-store.js";
import {
  FULL_MANIFEST,
  ISSUES_TEMPLATE,
  OPERATOR,
  PLUGIN_ID,
  TREE_SHA256,
  WORKSPACE_ID,
  fullViews,
} from "./capability-plugin-install.test-support.js";
import {
  HOOK_SECRET,
  REVOKED,
  SKILL_CHECK_ID,
  SKILL_ID,
  pluginUninstallHarness,
  skillCheck,
  type PluginUninstallFixture,
} from "./capability-plugin-uninstall.test-support.js";
import { isAutoResumeOnApprovalPlan } from "./evolution-control-plane-approval-reconciliation.js";
import { assertMcpServerRemovalAllowed } from "./plugin-owned-refusal.js";

const harnesses: Array<ReturnType<typeof pluginUninstallHarness>> = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

function harness(input: PluginUninstallFixture = {}) {
  const created = pluginUninstallHarness(input);
  // A fresh approval per plan, so each plan's approval is resolved on its own.
  let approvals = 0;
  created.createApproval.mockImplementation(async () => `approval-plan-${++approvals}`);
  harnesses.push(created);
  return created;
}

/** Installs the plugin; on a profile that asks, its one approval is given and the plan resumes. */
async function installed(h: ReturnType<typeof harness>) {
  const outcome = await h.install();
  if (outcome.outcome === "waiting") {
    h.approve(outcome.approvalId);
    await h.plans.reconcileApproval(outcome.approvalId!);
  }
  return (await h.store.get(PLUGIN_ID))!;
}

/** Uninstalls the plugin; on a profile that asks, its one approval is given and the plan resumes. */
async function uninstalled(h: ReturnType<typeof harness>, key = `uninstall-${Math.random()}`) {
  const outcome = await h.uninstall(OPERATOR, key);
  if (outcome.outcome !== "waiting" || !(await planAwaitsApproval(h, outcome.planId))) return outcome;
  h.approve(outcome.approvalId);
  await h.plans.reconcileApproval(outcome.approvalId!);
  return await h.uninstall(OPERATOR, key);
}

async function planAwaitsApproval(h: ReturnType<typeof harness>, planId: string) {
  return (await h.plans.get(OPERATOR, planId)).status === "awaiting_approval";
}

/** What an approved revoke's work does, as Skill Hub's would: to the skill's check, and to the approval's follow-up. */
type RevokeEffect = (h: ReturnType<typeof harness>, approvalId: string) => void;

function revokeWork(h: ReturnType<typeof harness>, approvalId: string, effects: "running" | "failed" | "done") {
  h.removal.approvals.set(approvalId, { status: "approved", effects });
}

/** It revokes the skill. */
const revokes: RevokeEffect = (h, approvalId) => {
  h.removal.skillChecks.set(
    SKILL_CHECK_ID,
    REVOKED({ revokeApproval: { approvalId, status: "approved", settled: "applied" } }),
  );
  revokeWork(h, approvalId, "done");
};
/** It settles blocked: the skill stays switched on. */
const blocks: RevokeEffect = (h, approvalId) => {
  h.removal.skillChecks.set(
    SKILL_CHECK_ID,
    skillCheck({ revokeApproval: { approvalId, status: "approved", settled: "blocked" } }),
  );
  revokeWork(h, approvalId, "done");
};
/** Its work fails for good, leaving no settlement. */
const fails: RevokeEffect = (h, approvalId) => {
  h.removal.skillChecks.set(SKILL_CHECK_ID, skillCheck({ revokeApproval: { approvalId, status: "approved" } }));
  revokeWork(h, approvalId, "failed");
};
/** Its work is still queued or running. */
const inFlight: RevokeEffect = (h, approvalId) => {
  h.removal.skillChecks.set(SKILL_CHECK_ID, skillCheck({ revokeApproval: { approvalId, status: "approved" } }));
  revokeWork(h, approvalId, "running");
};

/**
 * A harness whose revoke is the Skills tab's own, over a Skill Hub owner kept in memory. The Inbox reads the same
 * approvals, and an approved revoke's effect is the tab's `effect`: by default it revokes the skill.
 */
function withSkillsTab(profile: DeploymentProfile, fixture: PluginUninstallFixture = {}) {
  const h = harness({
    ...fixture,
    ...(profile === "remote_hardened" ? { profile } : {}),
    // Called only once the tab below exists.
    revokeSkill: (input) => tab.revokeSkill(input),
  });
  const tab = skillActions(profile, h.state.approvalStatuses, (approvalId) => tab.effect(h, approvalId));
  return { h, tab };
}

/**
 * The Skills tab's own revoke over a Skill Hub owner kept in memory: its approval waits until it is resolved, and the
 * profile decides as the Gateway's does. Once approved, its effect applies. As the real owner does, asking again hands
 * back the same pending or approved revoke while nothing about the skill changed (`fingerprint`); a test moves it on.
 */
function skillActions(
  profile: DeploymentProfile,
  approvals: Map<string, ApprovalRequest["status"]>,
  applyEffect: (approvalId: string) => void,
) {
  const minted: Array<{ approvalId: string; fingerprint: number }> = [];
  const approve = (approvalId: string) => {
    approvals.set(approvalId, "approved");
    applyEffect(approvalId);
  };
  const sources = {
    setSkillState: vi.fn(),
    resolveApproval: vi.fn(async (approvalId: string) => approve(approvalId)),
    readApproval: vi.fn(async (approvalId: string) => ({ preview: {}, status: approvals.get(approvalId)! })),
    appendApprovalAudit: vi.fn(async () => undefined),
    deploymentProfile: () => profile,
    readApprovalSkipSetting: vi.fn(async () => false),
    reviewSkillHubSource: vi.fn(),
    listSkillHub: vi.fn(async () => ({ items: [] })),
    createSkillHubApproval: vi.fn(async () => {
      for (const earlier of [...minted].reverse()) {
        const status = approvals.get(earlier.approvalId);
        if (earlier.fingerprint === tab.fingerprint && (status === "pending" || status === "approved")) {
          return { approval: { ...hubApproval("revoke", status), approvalId: earlier.approvalId } };
        }
      }
      const approval = { ...hubApproval("revoke", "pending"), approvalId: `approval-revoke-${minted.length + 1}` };
      minted.push({ approvalId: approval.approvalId, fingerprint: tab.fingerprint });
      approvals.set(approval.approvalId, "pending");
      return { approval };
    }),
    findSkillHubSnapshot: vi.fn(async () => undefined),
    listPluginRecords: vi.fn(async () => []),
  } satisfies CapabilitySkillActionSources;
  const actions = new CapabilitySkillActionsService(sources);
  const tab = {
    sources,
    approvals,
    /** What an approved revoke does to the check; a test changes it. */
    effect: revokes as RevokeEffect,
    /** Moves on when something about the skill changes (it was switched off and on, say). */
    fingerprint: 1,
    /** The operator approves a revoke in the Inbox. */
    approve,
    revokeSkill: (input: Parameters<typeof actions.revokeForPluginUninstall>[0]) =>
      actions.revokeForPluginUninstall(input),
  };
  return tab;
}

/** A plugin installed after this one that found its connector already saved, and kept it. */
async function otherPluginKeeping(
  h: ReturnType<typeof harness>,
  record: StoredPlugin,
  pieceId = "issues",
  manifestSha256 = record.manifestSha256,
) {
  await h.store.update("other-tools", () => ({
    ...record,
    pluginId: "other-tools",
    name: "Other tools",
    installPlanId: "plan-other",
    manifestSha256,
    pieces: [{ pieceId, kind: "connector", owned: false }],
  }));
}

/** The record with one piece's ref dropped, as an install that stopped before saving it leaves it. */
function withoutRef(record: StoredPlugin, pieceId: string): StoredPlugin {
  return {
    ...record,
    pieces: record.pieces.map((piece) => {
      if (piece.pieceId !== pieceId) return piece;
      const { ref: _ref, ...unnamed } = piece;
      return unnamed;
    }),
  };
}

describe("uninstalling a plugin through one Change Plan", () => {
  it("removes exactly the pieces the plugin added", async () => {
    const h = harness({ allowlist: ["api.openai.com"] });
    const record = await installed(h);
    const [server] = h.state.servers;
    expect(pluginToolGroupHolds([record])).toEqual([
      { groupId: "browser", pluginId: PLUGIN_ID, pluginName: "Meeting tools" },
    ]);
    const settingsWrites = h.sources.updateSettings.mock.calls.length;

    const outcome = await h.uninstall();

    expect(outcome).toEqual({
      planId: expect.any(String),
      outcome: "applied",
      summary: "Removed 5 pieces. Hosts it allowed stay in your allowlist.",
    });
    const plan = await h.plans.get(OPERATOR, outcome.planId);
    expect(plan).toMatchObject({
      kind: "plugin_uninstall",
      scope: "capability",
      risk: "caution",
      status: "completed",
      title: "Uninstall Meeting tools",
      request: { kind: "plugin_uninstall", pluginId: PLUGIN_ID, installPlanId: record.installPlanId },
      target: { ownerId: "capability_plugins", resourceId: `plugin:${PLUGIN_ID}` },
    });
    expect(plan.target.expectedHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.summary).toBe(
      [
        "Remove the hook that sends event details to hooks.example.com.",
        "Delete the prompt pack Meeting checks, with its runs and scores.",
        "Stop holding Browser off.",
        // Labels come from the shipped catalog, as the plugin's detail shows them; this test's template isn't in it.
        "Remove the connector issues.",
        "Remove the skill meeting-notes, so the AI can't use it.",
        "Hosts it allowed stay in your allowlist.",
      ].join(" "),
    );
    // In reverse install order, each through its own owner with the plugin's pass.
    expect(h.removal.order).toEqual([
      "hook",
      "prompt_pack",
      "hold_release",
      "connector_disconnect",
      "connector_delete",
      "revoke",
      "remove_record",
    ]);
    expect(h.uninstallSources.deleteHook).toHaveBeenCalledWith(WORKSPACE_ID, "hook-1", {
      pluginId: PLUGIN_ID,
      installPlanId: record.installPlanId,
    });
    expect(h.uninstallSources.deleteConnector).toHaveBeenCalledWith(server!.serverId, {
      pluginId: PLUGIN_ID,
      installPlanId: record.installPlanId,
    });
    expect(h.revokeSkill).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
      snapshotId: SKILL_CHECK_ID,
      pluginId: PLUGIN_ID,
      actorId: OPERATOR.actorId,
    });
    expect(h.state.servers).toEqual([]);
    expect(h.state.packs).toEqual([]);
    expect(h.removal.deletedPacks).toEqual([`plugin-${PLUGIN_ID}-checks`]);
    expect(h.state.keychain.size).toBe(0);
    // The record is gone, in the same write as the tombstone that names its skills.
    await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
    await expect(h.store.listRemoved()).resolves.toEqual([
      { pluginId: PLUGIN_ID, name: "Meeting tools", skillIds: [SKILL_ID], removedAt: "2026-10-31T12:00:00.000Z" },
    ]);
    expect(pluginToolGroupHolds(await h.store.list())).toEqual([]);
    // Hosts are untouched: the allowlist keeps what the install added, and no settings were written.
    expect(h.state.settings.networkAllowlist).toEqual(["api.openai.com", "mcp.issues.test"]);
    expect(h.sources.updateSettings).toHaveBeenCalledTimes(settingsWrites);
    expect(h.createApproval).not.toHaveBeenCalled();
  });

  it("leaves a connector it found already saved", async () => {
    const saved: McpServerRecord = {
      serverId: "server-mine",
      label: ISSUES_TEMPLATE.label,
      transport: "http",
      url: ISSUES_TEMPLATE.url,
      authType: "oauth2",
      enabled: true,
      category: "data",
      trustTier: "restricted",
      costTier: "unknown",
      policy: ISSUES_TEMPLATE.policy,
      status: "connected",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const views = fullViews().map((view) =>
      view.pieceId === "issues" ? { ...view, check: { status: "already_there" as const }, hosts: undefined } : view,
    );
    const h = harness({ servers: [saved], views });
    const record = await installed(h);
    expect(record.pieces.find((piece) => piece.pieceId === "issues")).toEqual({
      pieceId: "issues",
      kind: "connector",
      owned: false,
    });

    const outcome = await h.uninstall();

    expect(outcome.summary).toBe("Removed 4 pieces. Hosts it allowed stay in your allowlist.");
    expect((await h.plans.get(OPERATOR, outcome.planId)).summary).toContain("Keep issues, which was already there.");
    expect(h.state.servers).toEqual([saved]);
    expect(h.uninstallSources.disconnectConnector).not.toHaveBeenCalled();
    expect(h.uninstallSources.deleteConnector).not.toHaveBeenCalled();
  });

  it("releases its hold but leaves a group the operator switched off", async () => {
    const manifest = {
      ...FULL_MANIFEST,
      pieces: [
        { kind: "tool_group_off", id: "no-browser", groupId: "browser" },
        { kind: "tool_group_off", id: "no-git", groupId: "git" },
      ],
    };
    const views = fullViews()
      .filter((view) => view.pieceId === "no-browser")
      .flatMap((view) => [view, { ...view, pieceId: "no-git", label: "Git" }]);
    // The operator switched Git off themselves before the install.
    const h = harness({ manifest, views, operatorOff: ["git"] });
    await installed(h);
    expect(pluginToolGroupHolds(await h.store.list()).map((hold) => hold.groupId)).toEqual(["browser"]);
    const settingsWrites = h.sources.updateSettings.mock.calls.length;

    const outcome = await h.uninstall();

    expect(outcome).toMatchObject({
      outcome: "applied",
      summary: "Removed 1 piece. Hosts it allowed stay in your allowlist.",
    });
    expect(pluginToolGroupHolds(await h.store.list())).toEqual([]);
    // The operator's own switch is never written: Git stays off.
    expect(h.state.operatorOff).toEqual(["git"]);
    expect(h.sources.updateSettings).toHaveBeenCalledTimes(settingsWrites);
    expect((await h.plans.get(OPERATOR, outcome.planId)).summary).toBe(
      [
        "Stop holding Browser off.",
        "Keep Git, which was already there.",
        "Hosts it allowed stay in your allowlist.",
      ].join(" "),
    );
  });

  it("revokes its skills without asking, except on remote_hardened", async () => {
    // With the setting on, the plan applies at once and the revoke is approved as the operator, with its note. Its
    // effect lands while the approval resolves, so one pass finishes.
    const { h, tab: local } = withSkillsTab("trusted_local");
    await installed(h);

    await expect(h.uninstall()).resolves.toMatchObject({ outcome: "applied" });
    expect(local.sources.createSkillHubApproval).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: WORKSPACE_ID, snapshotId: SKILL_CHECK_ID, operationKind: "revoke", actorId: OPERATOR.actorId },
      { pluginPass: { pluginId: PLUGIN_ID } },
    );
    expect(local.sources.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-revoke-1", {
      decision: "approve",
      resolvedBy: OPERATOR.actorId,
      resolutionNote: OPERATOR_SKILL_SKIP_NOTES.plugin_uninstall,
    });
    await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();

    // remote_hardened: the plan asks, and so does the revoke; the record stays, with the revoke it waits for.
    const { h: r, tab: hardened } = withSkillsTab("remote_hardened");
    await installed(r);

    const waiting = await uninstalled(r, "uninstall-hardened");

    expect(waiting).toMatchObject({ outcome: "waiting", approvalId: "approval-revoke-1" });
    expect(waiting.summary).toBe(
      [
        "Removed 4 pieces.",
        "Hosts it allowed stay in your allowlist.",
        "Removing the skill Meeting notes waits for your approval.",
        "Then uninstall Meeting tools again to finish.",
      ].join(" "),
    );
    expect(hardened.sources.resolveApproval).not.toHaveBeenCalled();
    const left = await r.store.get(PLUGIN_ID);
    expect(left).toMatchObject({ state: "uninstalling" });
    expect(left?.pieces).toEqual([
      {
        pieceId: "meeting-notes",
        kind: "skill",
        owned: true,
        skillSnapshotId: SKILL_CHECK_ID,
        waiting: { approvalId: "approval-revoke-1", operation: "revoke" },
      },
      { pieceId: "issues", kind: "connector", owned: true, removed: {} },
      { pieceId: "no-browser", kind: "tool_group_off", owned: true, removed: {} },
      { pieceId: "tool-watch", kind: "hook", owned: true, removed: {} },
      { pieceId: "checks", kind: "prompt_pack", owned: true, removed: {} },
    ]);
    await expect(r.store.listRemoved()).resolves.toEqual([]);
  });

  it("finishes a waiting one only once its check reads revoked, never asking for a second revoke", async () => {
    const { h, tab } = withSkillsTab("remote_hardened");
    await installed(h);
    await uninstalled(h, "first");
    // Many newer approvals later, the check's own window no longer shows the revoke at all.
    h.removal.skillChecks.set(SKILL_CHECK_ID, skillCheck({ pendingApprovals: {} }));

    const again = await uninstalled(h, "second");

    // The revoke the record kept still waits: it is answered again, never asked for twice.
    expect(again).toMatchObject({ outcome: "waiting", approvalId: "approval-revoke-1" });
    expect(again.summary).toBe(
      [
        "Removed 0 pieces.",
        "Hosts it allowed stay in your allowlist.",
        "Removing the skill Meeting notes waits for your approval.",
        "Then uninstall Meeting tools again to finish.",
      ].join(" "),
    );
    expect(tab.sources.createSkillHubApproval).toHaveBeenCalledOnce();
    expect(tab.sources.readApproval).toHaveBeenCalledWith("approval-revoke-1");

    // The operator approves the revoke, and its work is still running: the plugin stays.
    tab.effect = inFlight;
    tab.approve("approval-revoke-1");

    const applying = await uninstalled(h, "third");

    expect(applying.outcome).toBe("waiting");
    // Nothing is left to approve, so no approval is named.
    expect(applying).not.toHaveProperty("approvalId");
    expect(applying.summary).toBe(
      [
        "Removed 0 pieces.",
        "Hosts it allowed stay in your allowlist.",
        "The skill Meeting notes is being removed.",
        "Once it's off, uninstall Meeting tools again to finish.",
      ].join(" "),
    );
    const left = await h.store.get(PLUGIN_ID);
    expect(left?.state).toBe("uninstalling");
    expect(left?.pieces[0]).toMatchObject({
      pieceId: "meeting-notes",
      waiting: { approvalId: "approval-revoke-1", operation: "revoke" },
    });
    await expect(h.store.listRemoved()).resolves.toEqual([]);

    // Its work revokes the skill.
    revokes(h, "approval-revoke-1");

    const finished = await uninstalled(h, "fourth");

    expect(finished).toMatchObject({
      outcome: "applied",
      summary: "Removed 1 piece. Hosts it allowed stay in your allowlist.",
    });
    expect(tab.sources.createSkillHubApproval).toHaveBeenCalledOnce();
    await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
    await expect(h.store.listRemoved()).resolves.toMatchObject([{ pluginId: PLUGIN_ID, skillIds: [SKILL_ID] }]);
  });

  it.each([
    ["settles blocked", blocks],
    ["fails with no settlement", fails],
  ])("asks afresh in the same pass when a revoke %s because the skill changed meanwhile", async (_case, didntTake) => {
    const { h, tab } = withSkillsTab("trusted_local");
    // The first revoke doesn't take, as the skill was switched off and on meanwhile; the fresh one does.
    tab.effect = (on, approvalId) => {
      didntTake(on, approvalId);
      tab.fingerprint += 1;
      tab.effect = revokes;
    };
    await installed(h);

    await expect(h.uninstall()).resolves.toMatchObject({
      outcome: "applied",
      summary: "Removed 5 pieces. Hosts it allowed stay in your allowlist.",
    });
    expect(tab.sources.createSkillHubApproval).toHaveBeenCalledTimes(2);
    expect(tab.sources.resolveApproval).toHaveBeenLastCalledWith("approval-revoke-2", expect.anything());
    await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
  });

  it.each([
    ["settled blocked", blocks, "Revoke approval approval-revoke-1 settled blocked."],
    ["failed with no settlement", fails, "Revoke approval approval-revoke-1 with its work failed."],
  ])(
    "stops plainly, keeping the plugin, when Skill Hub hands back a revoke that %s",
    async (_case, didntTake, detail) => {
      const { h, tab } = withSkillsTab("trusted_local");
      tab.effect = didntTake;
      await installed(h);

      const stopped = await h.uninstall();

      // Nothing about the skill changed, so asking again hands back the same approved revoke.
      expect(stopped).toMatchObject({
        outcome: "failed",
        summary: [
          "Removed 4 pieces.",
          "Couldn't remove the skill Meeting notes: its removal was approved, but it didn't take effect.",
          "Uninstalling again won't change that until the skill changes.",
          "Switch it off in Skills so the AI can't use it, then uninstall Meeting tools again.",
        ].join(" "),
      });
      expect(await h.plans.get(OPERATOR, stopped.planId)).toMatchObject({
        status: "manual_required",
        result: { failureCode: "plugin_uninstall_skills_failed", failureDetail: detail },
      });
      expect(tab.sources.createSkillHubApproval).toHaveBeenCalledTimes(2);
      expect(tab.sources.resolveApproval).toHaveBeenCalledOnce();
      expect(await h.store.get(PLUGIN_ID)).toMatchObject({ state: "uninstalling" });
      await expect(h.store.listRemoved()).resolves.toEqual([]);
    },
  );

  it.each([
    [
      "revokes the next one in the same pass",
      "revoked" as const,
      "Removed 5 pieces.",
      [] as string[],
      { removed: { skillId: "extra:agenda" } },
    ],
    [
      "names the next one still waiting",
      "waiting" as const,
      "Removed 4 pieces.",
      ["Removing the skill Agenda waits for your approval."],
      { waiting: { approvalId: "approval-revoke-agenda", operation: "revoke" } },
    ],
  ])(
    "goes on to a plugin's other skills when one skill's removal can't take effect, and %s",
    async (_case, second, removed, alsoNamed, secondPiece) => {
      const asked = new Map<string, number>();
      // Skill Hub as the real owner answers: the first skill's revoke settles blocked and asking again hands back that
      // same approved revoke; the second skill's revoke takes at once, or waits for its approval.
      const h = harness({
        revokeSkill: async ({ snapshotId }) => {
          asked.set(snapshotId, (asked.get(snapshotId) ?? 0) + 1);
          if (snapshotId === SKILL_CHECK_ID) {
            blocks(h, "approval-revoke-1");
            return { status: "approved", approvalId: "approval-revoke-1" };
          }
          if (second === "waiting") return { status: "waiting", approvalId: "approval-revoke-agenda" };
          h.removal.skillChecks.set(snapshotId, REVOKED({ snapshotId, title: "Agenda", skillId: "extra:agenda" }));
          return { status: "approved", approvalId: "approval-revoke-agenda" };
        },
      });
      await installed(h);
      // A second switched-on skill, after the first in the record.
      await h.store.update(
        PLUGIN_ID,
        (current) =>
          current && {
            ...current,
            pieces: [
              ...current.pieces,
              { pieceId: "agenda", kind: "skill", owned: true, skillSnapshotId: "snapshot-skill-2" },
            ],
          },
      );
      h.removal.skillChecks.set(
        "snapshot-skill-2",
        skillCheck({ snapshotId: "snapshot-skill-2", title: "Agenda", skillId: "extra:agenda" }),
      );

      const stopped = await h.uninstall();

      expect(stopped).toMatchObject({
        outcome: "failed",
        summary: [
          removed,
          "Couldn't remove the skill Meeting notes: its removal was approved, but it didn't take effect.",
          ...alsoNamed,
          "Uninstalling again won't change that until the skill changes.",
          "Switch it off in Skills so the AI can't use it, then uninstall Meeting tools again.",
        ].join(" "),
      });
      expect(await h.plans.get(OPERATOR, stopped.planId)).toMatchObject({
        status: "manual_required",
        result: {
          failureCode: "plugin_uninstall_skills_failed",
          failureDetail: "Revoke approval approval-revoke-1 settled blocked.",
        },
      });
      // Both skills were tried in this pass: the first twice (its handback), the second once.
      expect(Object.fromEntries(asked)).toEqual({ [SKILL_CHECK_ID]: 2, "snapshot-skill-2": 1 });
      const left = await h.store.get(PLUGIN_ID);
      expect(left?.state).toBe("uninstalling");
      expect(left?.pieces.find((piece) => piece.pieceId === "agenda")).toMatchObject(secondPiece);
      expect(left?.pieces.find((piece) => piece.pieceId === "meeting-notes")).not.toHaveProperty("removed");
      await expect(h.store.listRemoved()).resolves.toEqual([]);
    },
  );

  it("reads a revoke's work before its check again, so one that applied meanwhile reads as revoked", async () => {
    const h = harness();
    await installed(h);
    // At the step's start the check shows an approved revoke still running.
    inFlight(h, "approval-revoke-earlier");
    // It applies just as its work is read.
    h.uninstallSources.readApproval.mockImplementationOnce(async (approvalId) => {
      revokes(h, approvalId);
      return { status: "approved", effects: "done" };
    });

    await expect(h.uninstall()).resolves.toMatchObject({
      outcome: "applied",
      summary: "Removed 5 pieces. Hosts it allowed stay in your allowlist.",
    });
    // Read against the fresh check, it was already revoked: no second revoke was asked for.
    expect(h.revokeSkill).not.toHaveBeenCalled();
  });

  it("reads the check again while an approved revoke's work runs, and keeps the plugin if it never lands", async () => {
    // The work lands a moment after the approval resolved: the uninstall still finishes in one pass.
    const { h, tab } = withSkillsTab("trusted_local");
    tab.effect = inFlight;
    await installed(h);
    let pauses = 0;
    h.uninstallSources.pause.mockImplementation(async () => {
      if (++pauses === 2) revokes(h, "approval-revoke-1");
    });

    await expect(h.uninstall()).resolves.toMatchObject({
      outcome: "applied",
      summary: "Removed 5 pieces. Hosts it allowed stay in your allowlist.",
    });
    expect(h.uninstallSources.pause.mock.calls).toEqual([[250], [250]]);

    // It never lands while the uninstall reads: the skill is being removed, and the plugin stays.
    const { h: slow, tab: slowTab } = withSkillsTab("trusted_local");
    slowTab.effect = inFlight;
    await installed(slow);

    await expect(slow.uninstall()).resolves.toMatchObject({
      outcome: "waiting",
      summary: [
        "Removed 4 pieces.",
        "Hosts it allowed stay in your allowlist.",
        "The skill Meeting notes is being removed.",
        "Once it's off, uninstall Meeting tools again to finish.",
      ].join(" "),
    });
    // About ten seconds of reads, a quarter second apart.
    expect(slow.uninstallSources.pause).toHaveBeenCalledTimes(39);
    expect(await slow.store.get(PLUGIN_ID)).toMatchObject({ state: "uninstalling" });
  });

  it("never waits inside the approval worker: resumed by its approval, it reads a revoke once and finishes next time", async () => {
    // The setting is off, so the plan resumes from its approval inside the approval worker, where the revoke's own
    // work runs only after this uninstall returns.
    const { h, tab } = withSkillsTab("trusted_local", { skip: false });
    tab.effect = inFlight;
    await installed(h);
    const asked = h.createApproval.mock.calls.length;

    const waiting = await h.uninstall();
    expect(waiting).toMatchObject({ outcome: "waiting", approvalId: expect.stringMatching(/^approval-plan-/u) });
    const plan = await h.plans.get(OPERATOR, waiting.planId);
    expect(plan).toMatchObject({ status: "awaiting_approval", requiredAction: { kind: "approval", risk: "caution" } });
    expect(isAutoResumeOnApprovalPlan(plan)).toBe(true);
    expect(h.removal.order).toEqual([]);

    h.approve(waiting.approvalId);
    expect(await h.plans.reconcileApproval(waiting.approvalId!)).toBe(1);

    // One approval for the whole uninstall, and its revoke applies without asking. The plan doesn't wait for that
    // revoke's work, which can't run until it returns: the record stays, and the plan says what's next.
    const resumed = await h.plans.get(OPERATOR, waiting.planId);
    expect(resumed).toMatchObject({
      status: "completed",
      result: {
        summary: [
          "Removed 4 pieces.",
          "Hosts it allowed stay in your allowlist.",
          "The skill Meeting notes is being removed.",
          "Once it's off, uninstall Meeting tools again to finish.",
        ].join(" "),
      },
    });
    expect(h.uninstallSources.pause).not.toHaveBeenCalled();
    expect(tab.sources.resolveApproval).toHaveBeenCalledOnce();
    expect(h.createApproval.mock.calls.length).toBe(asked + 1);
    expect(await h.store.get(PLUGIN_ID)).toMatchObject({ state: "uninstalling" });

    // The worker then runs the revoke's work, and the next uninstall finishes without a second revoke.
    revokes(h, "approval-revoke-1");
    await expect(uninstalled(h, "again")).resolves.toMatchObject({
      outcome: "applied",
      summary: "Removed 1 piece. Hosts it allowed stay in your allowlist.",
    });
    expect(tab.sources.createSkillHubApproval).toHaveBeenCalledOnce();
    await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
  });

  it("waits for a skill still taking one of its own steps, so nothing switches it on once the plugin is gone", async () => {
    const h = harness();
    await installed(h);
    // Its switch-on step waits for the operator's approval.
    h.state.approvalStatuses.set("approval-activate", "pending");
    h.removal.skillChecks.set(
      SKILL_CHECK_ID,
      skillCheck({
        version: "installed_off",
        step: "waiting_switch_on",
        pendingApprovals: { activate: "approval-activate" },
      }),
    );

    const waiting = await h.uninstall();

    expect(waiting).toMatchObject({ outcome: "waiting", approvalId: "approval-activate" });
    // A waiting step never settles by itself, so the operator is told it is their decision, and what to do (F12).
    expect(waiting.summary).toBe(
      [
        "Removed 4 pieces.",
        "Hosts it allowed stay in your allowlist.",
        "Switching on the skill Meeting notes waits for your decision in the Inbox.",
        "Decline it, then uninstall Meeting tools again to finish.",
      ].join(" "),
    );
    expect(h.revokeSkill).not.toHaveBeenCalled();
    expect((await h.store.get(PLUGIN_ID))?.pieces[0]).toMatchObject({
      waiting: { approvalId: "approval-activate", operation: "activate" },
    });

    // Many newer approvals later, the check's own window no longer shows it, but the read of every waiting approval
    // still finds it.
    h.removal.skillChecks.set(SKILL_CHECK_ID, skillCheck({ version: "installed_off", step: "installed_off" }));
    h.removal.pendingSteps.set(SKILL_CHECK_ID, { approvalId: "approval-activate", operation: "activate" });
    await expect(h.uninstall(OPERATOR, "window")).resolves.toMatchObject({
      outcome: "waiting",
      approvalId: "approval-activate",
    });
    expect(h.uninstallSources.listPendingSkillSteps).toHaveBeenLastCalledWith(WORKSPACE_ID, [SKILL_CHECK_ID]);

    // Declined: it stays installed and switched off, inert, so the next uninstall removes the plugin.
    h.removal.pendingSteps.clear();
    h.state.approvalStatuses.set("approval-activate", "rejected");
    await expect(h.uninstall(OPERATOR, "again")).resolves.toMatchObject({
      outcome: "applied",
      summary: "Removed 1 piece. Hosts it allowed stay in your allowlist.",
    });
    expect(h.revokeSkill).not.toHaveBeenCalled();
    await expect(h.store.listRemoved()).resolves.toMatchObject([{ skillIds: [SKILL_ID] }]);
  });

  it("keeps its words for a skill whose own step is already under way, as nothing waits on the operator", async () => {
    const h = harness();
    await installed(h);
    h.removal.skillChecks.set(SKILL_CHECK_ID, skillCheck({ version: "installed_off", step: "switching_on" }));

    const waiting = await h.uninstall();

    expect(waiting).toMatchObject({
      outcome: "waiting",
      summary: [
        "Removed 4 pieces.",
        "Hosts it allowed stay in your allowlist.",
        "The skill Meeting notes is still taking one of its own steps.",
        "Then uninstall Meeting tools again to finish.",
      ].join(" "),
    });
  });

  it("reads the skills' waiting steps again just before the record goes, and keeps it for one asked for meanwhile (F6)", async () => {
    const h = harness();
    await installed(h);
    // Installed and never switched on: inert, so the skills step settles it.
    h.removal.skillChecks.set(SKILL_CHECK_ID, skillCheck({ version: "installed_off", step: "installed_off" }));
    h.state.approvalStatuses.set("approval-activate", "pending");
    const step = { approvalId: "approval-activate", operation: "activate" as const };
    let readsAfterConnectors = 0;
    // The operator asks, in another tab, for its switch-on just after the skills step read the waiting steps.
    h.uninstallSources.listPendingSkillSteps.mockImplementation(async () => {
      if (!h.removal.order.includes("connector_delete")) return new Map();
      readsAfterConnectors += 1;
      return readsAfterConnectors === 1 ? new Map() : new Map([[SKILL_CHECK_ID, step]]);
    });

    const waiting = await h.uninstall();

    expect(waiting).toEqual({
      planId: expect.any(String),
      outcome: "waiting",
      approvalId: "approval-activate",
      summary: [
        "Removed 4 pieces.",
        "Hosts it allowed stay in your allowlist.",
        "Switching on the skill Meeting notes waits for your decision in the Inbox.",
        "Decline it, then uninstall Meeting tools again to finish.",
      ].join(" "),
    });
    expect(h.removal.order).not.toContain("remove_record");
    const left = await h.store.get(PLUGIN_ID);
    expect(left?.state).toBe("uninstalling");
    // Unsettled again, so the next pass decides it afresh.
    expect(left?.pieces.find((piece) => piece.pieceId === "meeting-notes")).toEqual({
      pieceId: "meeting-notes",
      kind: "skill",
      owned: true,
      skillSnapshotId: SKILL_CHECK_ID,
      waiting: step,
    });

    // Declined, the next pass settles it and finishes.
    h.uninstallSources.listPendingSkillSteps.mockImplementation(async () => new Map());
    h.state.approvalStatuses.set("approval-activate", "rejected");
    await expect(h.uninstall(OPERATOR, "again")).resolves.toMatchObject({
      outcome: "applied",
      summary: "Removed 1 piece. Hosts it allowed stay in your allowlist.",
    });
    await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
  });

  describe("a prompt pack its install made before its record named it (F7)", () => {
    const PACK_ID = `plugin-${PLUGIN_ID}-checks`;

    async function unrecordedPack(h: ReturnType<typeof harness>) {
      await installed(h);
      await h.store.update(PLUGIN_ID, (current) => current && withoutRef(current, "checks"));
      expect(h.state.packs.map((pack) => pack.packId)).toEqual([PACK_ID]);
    }

    it("is found under the id the install gives it, and deleted", async () => {
      const h = harness();
      await unrecordedPack(h);

      const outcome = await h.uninstall();

      expect(outcome).toMatchObject({
        outcome: "applied",
        summary: "Removed 5 pieces. Hosts it allowed stay in your allowlist.",
      });
      expect((await h.plans.get(OPERATOR, outcome.planId)).summary).toContain(
        "Delete the prompt pack Meeting checks if its unfinished install left it, with its runs and scores.",
      );
      expect(h.removal.deletedPacks).toEqual([PACK_ID]);
      expect(h.state.packs).toEqual([]);
      await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
    });

    it("is found when the plugin's name ends in a space, as the pack's label is saved trimmed (Q3)", async () => {
      const h = harness({ manifest: { ...FULL_MANIFEST, name: "Meeting tools " } });
      await unrecordedPack(h);
      // The prompt-pack owner saves the source label trimmed.
      h.state.packs = h.state.packs.map((pack) => ({ ...pack, sourceLabel: pack.sourceLabel.trim() }));
      expect(h.state.packs[0]?.sourceLabel).toBe("Plugin Meeting tools");

      const outcome = await h.uninstall();

      expect(outcome).toMatchObject({ outcome: "applied" });
      expect(h.removal.deletedPacks).toEqual([PACK_ID]);
      expect(h.state.packs).toEqual([]);
    });

    it("is left as it is when its source label is another's, or another plugin's record lists that id", async () => {
      // Another plugin's label: a pack this plugin's install never made.
      const relabelled = harness();
      await unrecordedPack(relabelled);
      relabelled.state.packs = relabelled.state.packs.map((pack) => ({ ...pack, sourceLabel: "Plugin Meeting" }));

      // `meeting` + `tools-checks` makes the same id as `meeting-tools` + `checks`.
      const collided = harness();
      await unrecordedPack(collided);
      const record = (await collided.store.get(PLUGIN_ID))!;
      await collided.store.update("meeting", () => ({
        ...record,
        pluginId: "meeting",
        name: "Meeting",
        installPlanId: "plan-meeting",
        pieces: [{ pieceId: "tools-checks", kind: "prompt_pack", owned: true }],
      }));

      for (const h of [relabelled, collided]) {
        const outcome = await h.uninstall();

        expect(outcome).toMatchObject({
          outcome: "applied",
          summary: "Removed 4 pieces. Hosts it allowed stay in your allowlist.",
        });
        expect(h.uninstallSources.deletePromptPack).not.toHaveBeenCalled();
        expect(h.state.packs.map((pack) => pack.packId)).toEqual([PACK_ID]);
        await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
      }
    });
  });

  it("takes control and bidi characters out of a skill's name in what it shows (F5)", async () => {
    const { h } = withSkillsTab("remote_hardened");
    await installed(h);
    h.removal.skillChecks.set(SKILL_CHECK_ID, skillCheck({ title: "Meeting \u202Enotes\n" }));

    const waiting = await uninstalled(h, "bidi");

    expect(waiting.summary).toContain("Removing the skill Meeting notes waits for your approval.");
    expect(waiting.summary).not.toMatch(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u);
  });

  it("names a skill whose own install step waits in the plan, as it may be installed by the time the plan applies", async () => {
    const h = harness({ skip: false });
    await installed(h);
    // Nothing is installed from it yet, but its install step waits for the operator's approval.
    h.removal.skillChecks.set(
      SKILL_CHECK_ID,
      skillCheck({
        skillId: undefined,
        version: "none",
        step: "waiting_install",
        pendingApprovals: { install_inactive: "approval-install" },
      }),
    );

    const waiting = await h.uninstall();

    const plan = await h.plans.get(OPERATOR, waiting.planId);
    expect(plan.summary).toContain("Remove the skill meeting-notes, so the AI can't use it.");
    expect(plan.impact).toContain("A skill it added can't be installed again until skills can be removed.");
  });

  it("cleans up after a failed install, counting only what it added", async () => {
    const h = harness();
    // The install stops at its prompt pack: the hook, connector and hold were added, the pack and skill weren't.
    h.state.failAt = "prompt_pack";
    await expect(h.install()).resolves.toMatchObject({ outcome: "failed" });
    h.state.failAt = undefined;
    expect(await h.store.get(PLUGIN_ID)).toMatchObject({ state: "installing" });
    // Its skill was only checked, never installed.
    h.removal.skillChecks.set(
      SKILL_CHECK_ID,
      skillCheck({ skillId: undefined, version: "none", step: "check_passed" }),
    );

    const outcome = await h.uninstall();

    expect(outcome).toMatchObject({
      outcome: "applied",
      summary: "Removed 3 pieces. Hosts it allowed stay in your allowlist.",
    });
    // The plan never promises to remove a skill that was never installed, nor warns about installing it again.
    const plan = await h.plans.get(OPERATOR, outcome.planId);
    expect(plan.summary).not.toContain("the skill");
    expect(plan.impact).not.toContain("installed again");
    expect(h.removal.order).toEqual([
      "hook",
      "hold_release",
      "connector_disconnect",
      "connector_delete",
      "remove_record",
    ]);
    expect(h.uninstallSources.deletePromptPack).not.toHaveBeenCalled();
    expect(h.revokeSkill).not.toHaveBeenCalled();
    expect(h.state.servers).toEqual([]);
    expect(h.state.keychain.size).toBe(0);
    await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
  });

  it("removes what an install that stopped before its hooks left: its secrets, and a hook it made holding one", async () => {
    for (const orphanHook of [false, true]) {
      const { h, plan, secretRef } = await crashedBeforeHooks();
      // A hook made just before the stop, whose piece the record never got to name, holds the secret.
      if (orphanHook) h.state.hooks.push(hookHolding(secretRef, "https://hooks.example.com/goat"));

      const outcome = await h.uninstall();

      expect(outcome, String(orphanHook)).toMatchObject({
        outcome: "applied",
        summary: `Removed ${orphanHook ? "1 piece" : "0 pieces"}. Hosts it allowed stay in your allowlist.`,
      });
      expect(h.state.keychain.has(secretRef)).toBe(false);
      if (orphanHook) {
        // The plan named it, and it went through the hooks owner with the plugin's pass, which deletes its secret too.
        expect((await h.plans.get(OPERATOR, outcome.planId)).summary).toContain(
          'Remove the hook "After a tool call", which its unfinished install left.',
        );
        expect(h.uninstallSources.deleteHook).toHaveBeenCalledExactlyOnceWith(WORKSPACE_ID, "hook-1", {
          pluginId: PLUGIN_ID,
          installPlanId: plan.planId,
        });
        expect([...h.removal.deletedHooks]).toEqual(["hook-1"]);
      } else {
        expect(h.uninstallSources.deleteHook).not.toHaveBeenCalled();
      }
      await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
    }
  });

  it("says so when a removed hook can't be recorded, and counts it once", async () => {
    const { h, secretRef } = await crashedBeforeHooks();
    h.state.hooks.push(hookHolding(secretRef, "https://hooks.example.com/goat"));
    const deleteHook = h.uninstallSources.deleteHook.getMockImplementation()!;
    // The hook goes, then the write marking its piece fails.
    h.uninstallSources.deleteHook.mockImplementationOnce(async (...args) => {
      const deleted = await deleteHook(...args);
      h.removal.failNextWrite = true;
      return deleted;
    });

    const stopped = await h.uninstall();

    expect(stopped).toMatchObject({
      outcome: "failed",
      summary: [
        "Removed 1 piece.",
        'Removed the hook "After a tool call", but couldn\'t record it.',
        "Uninstall Meeting tools again to finish.",
      ].join(" "),
    });
    // Nothing of it is left, so the next pass counts nothing for it and finishes.
    await expect(h.uninstall(OPERATOR, "again")).resolves.toMatchObject({
      outcome: "applied",
      summary: "Removed 0 pieces. Hosts it allowed stay in your allowlist.",
    });
    expect(h.state.keychain.has(secretRef)).toBe(false);
  });

  it("stops before removing anything at a hook holding its secret that isn't one its install left", async () => {
    const { h, secretRef } = await crashedBeforeHooks();
    h.state.hooks.push(hookHolding(secretRef, "https://elsewhere.example/goat"));

    const stopped = await h.uninstall();

    expect(stopped).toMatchObject({
      outcome: "failed",
      summary: [
        'The hook "After a tool call", which sends event details to elsewhere.example, uses a signing secret this',
        "plugin stored, so both were kept. Remove that hook (or give it a new signing secret) in Hooks, then",
        "uninstall Meeting tools again.",
      ].join(" "),
    });
    expect(await h.plans.get(OPERATOR, stopped.planId)).toMatchObject({
      status: "manual_required",
      result: {
        failureCode: "plugin_uninstall_hooks_failed",
        failureDetail: "Hook hook-1 holds the secret stored for piece tool-watch.",
      },
    });
    expect(h.uninstallSources.deleteHook).not.toHaveBeenCalled();
    expect(h.state.keychain.has(secretRef)).toBe(true);
    expect(await h.store.get(PLUGIN_ID)).toMatchObject({ state: "uninstalling" });
  });

  it("keeps both when another hook shares its hook's signing secret, and removes nothing", async () => {
    const h = harness();
    await installed(h);
    const [pluginHook] = h.state.hooks;
    const secretRef = pluginHook!.action.type === "webhook" ? pluginHook!.action.webhook.secretRef! : "";
    // The operator made a second hook through the API with the same signing secret.
    h.state.hooks.push({ ...hookHolding(secretRef, "https://hooks.example.com/mine"), label: "My copy" });

    const stopped = await h.uninstall();

    expect(stopped).toMatchObject({
      outcome: "failed",
      summary: expect.stringContaining('The hook "My copy", which sends event details to hooks.example.com, uses a'),
    });
    expect(h.removal.order).toEqual([]);
    expect(h.removal.deletedHooks.size).toBe(0);
    expect(h.state.keychain.has(secretRef)).toBe(true);
  });

  it("deletes a hook's signing secret its owner left behind", async () => {
    const h = harness();
    await installed(h);
    expect(h.state.keychain.size).toBe(1);
    // The hooks owner deletes the hook, but its key store is briefly unavailable, so the secret stays.
    h.uninstallSources.deleteHook.mockImplementationOnce(async (_workspaceId, hookId) => {
      h.removal.order.push("hook");
      h.removal.deletedHooks.add(hookId);
      return true;
    });

    await expect(h.uninstall()).resolves.toMatchObject({
      outcome: "applied",
      summary: "Removed 5 pieces. Hosts it allowed stay in your allowlist.",
    });

    expect(h.state.keychain.size).toBe(0);
  });

  it.each([
    ["the hooks list may have been cut off", "The workspace has too many hooks to read them all at once.", true],
    ["the install plan can't be read", "The install plan can't be read.", false],
  ])(
    "keeps the plugin, removing nothing, when it can't tell which stored secrets a hook still uses: %s",
    async (_case, detail, listed) => {
      const h = harness();
      const record = await installed(h);
      const install = await h.plans.get(OPERATOR, record.installPlanId);
      const secretRefs = install.request.kind === "plugin_install" ? install.request.hookSecretRefs : undefined;
      expect(Object.values(secretRefs ?? {})).toHaveLength(1);
      const listHookSecrets = h.uninstallSources.listHookSecrets.getMockImplementation()!;
      const readInstallSecretRefs = h.uninstallSources.readInstallSecretRefs.getMockImplementation()!;
      if (listed) {
        // The workspace has as many hooks as one read returns.
        h.uninstallSources.listHookSecrets.mockResolvedValue(undefined);
      } else {
        h.uninstallSources.readInstallSecretRefs.mockRejectedValue(new Error(detail));
      }

      const stopped = await h.uninstall();

      expect(stopped).toMatchObject({
        outcome: "failed",
        summary: [
          "Couldn't tell whether its hooks still use the signing secrets it stored, so they were kept.",
          "Uninstall Meeting tools again to finish.",
        ].join(" "),
      });
      expect(await h.plans.get(OPERATOR, stopped.planId)).toMatchObject({
        status: "manual_required",
        result: { failureCode: "plugin_uninstall_hooks_failed", failureDetail: detail },
      });
      // Logged by plugin and by the references it read (none when the plan couldn't be read), never a value.
      expect(h.uninstallSources.reportUndecidedSecrets).toHaveBeenCalledExactlyOnceWith(
        PLUGIN_ID,
        listed ? Object.values(secretRefs ?? {}) : [],
        expect.any(Error),
      );
      expect(h.removal.order).toEqual([]);
      expect(await h.store.get(PLUGIN_ID)).toMatchObject({ state: "uninstalling" });

      h.uninstallSources.listHookSecrets.mockImplementation(listHookSecrets);
      h.uninstallSources.readInstallSecretRefs.mockImplementation(readInstallSecretRefs);
      await expect(h.uninstall(OPERATOR, "again")).resolves.toMatchObject({
        outcome: "applied",
        summary: "Removed 5 pieces. Hosts it allowed stay in your allowlist.",
      });
    },
  );

  it("removes, and names in its plan, a connector this install saved before its record named it", async () => {
    const h = harness();
    await installed(h);
    const [server] = h.state.servers;
    // The install stopped between saving the connector, marked as its own, and naming it on its record.
    await h.store.update(PLUGIN_ID, (current) => current && withoutRef(current, "issues"));
    // Another plugin's connector, marked as that plugin's, stays.
    const others: McpServerRecord = {
      ...server!,
      serverId: "server-other",
      pluginOwner: { pluginId: "other-tools", name: "Other tools", installPlanId: "plan-other" },
    };
    h.state.servers.push(others);

    const outcome = await h.uninstall();

    expect(outcome).toMatchObject({
      outcome: "applied",
      summary: "Removed 5 pieces. Hosts it allowed stay in your allowlist.",
    });
    expect((await h.plans.get(OPERATOR, outcome.planId)).summary).toContain("Remove the connector Issues.");
    expect(h.uninstallSources.deleteConnector).toHaveBeenCalledExactlyOnceWith(server!.serverId, {
      pluginId: PLUGIN_ID,
      installPlanId: expect.any(String),
    });
    expect(h.state.servers).toEqual([others]);
  });

  it("leaves a connector no longer marked as its install's, as one already handed over, counting nothing", async () => {
    const h = harness();
    await installed(h);
    // An earlier pass handed it to the operator, then stopped before its piece was marked.
    const { pluginOwner: _mark, ...unmarked } = h.state.servers[0]!;
    h.state.servers = [unmarked];

    const outcome = await h.uninstall();

    expect(outcome).toMatchObject({
      outcome: "applied",
      summary: "Removed 4 pieces. Hosts it allowed stay in your allowlist.",
    });
    expect((await h.plans.get(OPERATOR, outcome.planId)).summary).toContain("Keep issues, which is now yours.");
    expect(h.state.servers).toEqual([unmarked]);
    expect(h.uninstallSources.disconnectConnector).not.toHaveBeenCalled();
    expect(h.uninstallSources.deleteConnector).not.toHaveBeenCalled();
    expect(h.uninstallSources.releaseConnector).not.toHaveBeenCalled();
  });

  it("hands a connector another plugin uses to the operator instead of deleting it", async () => {
    const h = harness();
    const record = await installed(h);
    const [server] = h.state.servers;
    await otherPluginKeeping(h, record);
    expect(() => assertMcpServerRemovalAllowed(server, undefined)).toThrow();

    const outcome = await h.uninstall();

    expect(outcome).toMatchObject({
      outcome: "applied",
      summary: "Removed 4 pieces. Kept issues, which Other tools uses. Hosts it allowed stay in your allowlist.",
    });
    const plan = await h.plans.get(OPERATOR, outcome.planId);
    expect(plan.summary).toContain("Keep issues, which Other tools uses.");
    expect(plan.summary).not.toContain("Remove the connector");
    expect(h.uninstallSources.releaseConnector).toHaveBeenCalledExactlyOnceWith(server!.serverId, {
      pluginId: PLUGIN_ID,
      installPlanId: record.installPlanId,
    });
    expect(h.uninstallSources.disconnectConnector).not.toHaveBeenCalled();
    expect(h.uninstallSources.deleteConnector).not.toHaveBeenCalled();
    // It stays as it was, now the operator's own: nobody's later delete is refused as the gone plugin's.
    const { pluginOwner: _released, ...unmarked } = server!;
    expect(h.state.servers).toEqual([unmarked]);
    expect(() => assertMcpServerRemovalAllowed(h.state.servers[0], undefined)).not.toThrow();
  });

  it("releases, never deletes, a connector another plugin may use, when what it kept has left the catalog", async () => {
    const h = harness();
    const record = await installed(h);
    // The other plugin kept a connector whose template no longer ships: it could be this one.
    await otherPluginKeeping(h, record, "gone-from-catalog");

    const outcome = await h.uninstall();

    expect(outcome.summary).toContain("Kept issues, which Other tools may use.");
    expect((await h.plans.get(OPERATOR, outcome.planId)).summary).toContain("Keep issues, which Other tools may use.");
    expect(h.uninstallSources.deleteConnector).not.toHaveBeenCalled();
    expect(h.state.servers).toHaveLength(1);
  });

  it("stops before any connector when another plugin's manifest can't be read, but only for a plugin with one", async () => {
    // A plugin that added no connector never reads another plugin's, so an unreadable one is no obstacle.
    const manifest = { ...FULL_MANIFEST, pieces: [{ kind: "tool_group_off", id: "no-browser", groupId: "browser" }] };
    const views = fullViews().filter((view) => view.pieceId === "no-browser");
    const plain = harness({ manifest, views });
    const plainRecord = await installed(plain);
    await otherPluginKeeping(plain, plainRecord, "issues", "f".repeat(64));

    await expect(plain.uninstall()).resolves.toMatchObject({ outcome: "applied" });
    expect(plain.uninstallSources.listSavedConnectors).not.toHaveBeenCalled();

    // One with a connector can't tell whether the other plugin uses it: none is touched.
    const h = harness();
    const record = await installed(h);
    await otherPluginKeeping(h, record, "issues", "f".repeat(64));

    const stopped = await h.uninstall();

    expect(stopped).toMatchObject({
      outcome: "failed",
      summary: [
        "Removed 3 pieces.",
        "Couldn't tell whether Other tools uses issues, so no connector was removed.",
        "Try again later, or uninstall Other tools first, then uninstall Meeting tools again.",
      ].join(" "),
    });
    expect((await h.plans.get(OPERATOR, stopped.planId)).summary).toContain(
      "Keep issues for now, as it can't be told whether Other tools uses it.",
    );
    expect(h.uninstallSources.disconnectConnector).not.toHaveBeenCalled();
    expect(h.state.servers).toHaveLength(1);
  });

  it("refuses to apply when what it would keep changed since the plan was made, removing nothing", async () => {
    const h = harness({ skip: false });
    const record = await installed(h);
    const waiting = await h.uninstall();
    expect((await h.plans.get(OPERATOR, waiting.planId)).summary).toContain("Remove the connector issues.");
    // Another plugin that keeps the connector is installed while the uninstall waits for its approval.
    await otherPluginKeeping(h, record);

    h.approve(waiting.approvalId);
    await h.plans.reconcileApproval(waiting.approvalId!);

    expect(await h.plans.get(OPERATOR, waiting.planId)).toMatchObject({
      status: "failed",
      result: {
        summary: "What uninstalling this plugin would remove or keep changed since you asked. Uninstall it again.",
        failureCode: "plugin_uninstall_changed",
      },
    });
    expect(h.removal.order).toEqual([]);
    expect(h.state.servers).toHaveLength(1);
  });

  it.each([
    ["prompt_pack", "prompt_packs", "Removed 1 piece. Couldn't delete the prompt pack Meeting checks."],
    ["hold_release", "tool_groups", "Removed 2 pieces. Couldn't stop holding its tool groups off."],
    ["connector_delete", "connectors", "Removed 3 pieces. Couldn't remove the connector issues."],
    ["revoke", "skills", "Removed 4 pieces. Couldn't remove the skill meeting-notes."],
    ["remove_record", "finish", "Removed 5 pieces. Couldn't finish uninstalling Meeting tools."],
  ])("stops plainly when its %s owner fails, and finishes when uninstalled again", async (owner, step, words) => {
    const h = harness();
    await installed(h);
    h.removal.failAt = owner;

    const stopped = await h.uninstall();

    expect(stopped).toMatchObject({
      outcome: "failed",
      summary: `${words} Uninstall Meeting tools again to finish.`,
    });
    expect(await h.plans.get(OPERATOR, stopped.planId)).toMatchObject({
      status: "manual_required",
      result: {
        failureCode: `plugin_uninstall_${step}_failed`,
        failureDetail: `The ${owner} owner failed at C:\\goat\\data.`,
      },
    });
    expect(await h.store.get(PLUGIN_ID)).toMatchObject({ state: "uninstalling" });

    h.removal.failAt = undefined;
    const again = await h.uninstall(OPERATOR, "again");
    expect(again).toMatchObject({ outcome: "applied" });
    // A skill an earlier pass removed still blocks a reinstall, and the plan still says so.
    expect((await h.plans.get(OPERATOR, again.planId)).impact).toContain(
      "A skill it added can't be installed again until skills can be removed.",
    );
    await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
    await expect(h.store.listRemoved()).resolves.toMatchObject([{ pluginId: PLUGIN_ID, skillIds: [SKILL_ID] }]);
  });

  it("answers a retried uninstall from its first plan, and refuses a retry whose answer is gone", async () => {
    const h = harness();
    await installed(h);

    const first = await h.uninstall(OPERATOR, "uninstall-retried");
    const retried = await h.uninstall(OPERATOR, "uninstall-retried");

    expect(retried).toEqual(first);
    expect(h.removal.order).toEqual([
      "hook",
      "prompt_pack",
      "hold_release",
      "connector_disconnect",
      "connector_delete",
      "revoke",
      "remove_record",
    ]);
    expect(
      (await h.sync.list({ workspaceId: WORKSPACE_ID, limit: 50 })).filter((plan) => plan.kind === "plugin_uninstall"),
    ).toHaveLength(1);
    await expect(
      h.actions.uninstall({
        workspaceId: WORKSPACE_ID,
        pluginId: PLUGIN_ID,
        actorId: OPERATOR.actorId,
        idempotencyKey: "answered-elsewhere",
        replayOnly: true,
      }),
    ).rejects.toMatchObject({
      httpStatus: 409,
      message:
        "This uninstall's first answer is no longer kept, so it can't be sent again. Uninstall the plugin again.",
    });
  });

  it("refuses to uninstall a plugin that isn't installed", async () => {
    const h = harness();
    await expect(h.uninstall()).rejects.toMatchObject({ httpStatus: 404, message: "This plugin isn't installed." });
    await installed(h);
    const plans = (await h.sync.list({ workspaceId: "other", limit: 50 })).length;

    await expect(h.uninstall({ ...OPERATOR, workspaceId: "other" })).rejects.toMatchObject({
      httpStatus: 404,
      message: "This plugin was installed in another workspace. Uninstall it there.",
    });
    expect((await h.sync.list({ workspaceId: "other", limit: 50 })).length).toBe(plans);
    // The control plane refuses a request for another install of it, too.
    await expect(
      h.plans.create({
        actor: OPERATOR,
        request: { kind: "plugin_uninstall", pluginId: PLUGIN_ID, installPlanId: "plan-someone-else" },
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(h.removal.order).toEqual([]);
  });

  it.each([
    ["chat", { surface: "chat" as const, sessionId: "session-1", turnId: "turn-1" }],
    ["settings", { surface: "settings" as const }],
    ["a Capabilities turn", { sessionId: "session-1" }],
    ["system", { surface: "system" as const }],
  ])("can't be created from %s", async (_origin, actor) => {
    const h = harness();
    const record = await installed(h);

    await expect(
      h.plans.create({
        actor: { ...OPERATOR, ...actor },
        request: { kind: "plugin_uninstall", pluginId: PLUGIN_ID, installPlanId: record.installPlanId },
      }),
    ).rejects.toMatchObject({
      httpStatus: 403,
      message: "Plugins are uninstalled from Capabilities.",
      details: { diagnosticCode: "plugin_uninstall_untrusted_origin" },
    });
  });

  it("stops plainly at a hook it can't remove, and goes on from there when uninstalled again", async () => {
    const h = harness();
    await installed(h);
    // The hooks owner reads the whole plugin store to refuse a plugin's hook, and fails closed when it can't.
    h.uninstallSources.deleteHook.mockRejectedValueOnce(new Error("The saved plugin records can't be read."));

    const stopped = await h.uninstall();

    expect(stopped).toMatchObject({
      outcome: "failed",
      summary:
        "Couldn't remove the hook that sends event details to hooks.example.com. Uninstall Meeting tools again to finish.",
    });
    const plan = await h.plans.get(OPERATOR, stopped.planId);
    expect(plan).toMatchObject({
      status: "manual_required",
      result: {
        failureCode: "plugin_uninstall_hooks_failed",
        failureDetail: "The saved plugin records can't be read.",
      },
    });
    const left = await h.store.get(PLUGIN_ID);
    expect(left).toMatchObject({ state: "uninstalling", uninstallPlanId: stopped.planId });
    expect(left?.pieces.every((piece) => piece.kind === "skill" || piece.ref !== undefined)).toBe(true);

    await expect(h.uninstall(OPERATOR, "again")).resolves.toMatchObject({
      outcome: "applied",
      summary: "Removed 5 pieces. Hosts it allowed stay in your allowlist.",
    });
  });

  it("refuses a record that changed since the plan was made, removing nothing", async () => {
    const h = harness({ skip: false });
    await installed(h);
    const waiting = await h.uninstall();
    // A newer write to the record lands while the uninstall waits for its approval.
    await h.store.update(PLUGIN_ID, (current) => current && { ...current, version: "1.0.1" });

    h.approve(waiting.approvalId);
    await h.plans.reconcileApproval(waiting.approvalId!);

    expect(await h.plans.get(OPERATOR, waiting.planId)).toMatchObject({
      status: "failed",
      result: {
        summary: "This plugin changed since you asked to uninstall it. Uninstall it again.",
        failureCode: "plugin_uninstall_changed",
      },
    });
    expect(h.removal.order).toEqual([]);
    expect(await h.store.get(PLUGIN_ID)).toMatchObject({ state: "installed" });
  });

  it("reads an interrupted uninstall from the record, never writing, and is undone only by installing again", async () => {
    const h = harness();
    const record = await installed(h);
    const plan = { request: { kind: "plugin_uninstall", pluginId: PLUGIN_ID, installPlanId: record.installPlanId } };

    await expect(h.uninstallAdapter.reconcile({} as never, plan as ChangePlanRecord)).resolves.toMatchObject({
      effectObserved: false,
      status: "manual_required",
      result: { summary: "The uninstall stopped before it finished. Uninstall Meeting tools again to finish." },
    });
    await h.store.update(PLUGIN_ID, () => undefined);
    await expect(h.uninstallAdapter.reconcile({} as never, plan as ChangePlanRecord)).resolves.toMatchObject({
      effectObserved: true,
      status: "completed",
    });
    expect(h.uninstallAdapter.rollbackRefusal).toBe("Install the plugin again instead.");
  });
});

/** An install plan that stored its hook's signing secret and stopped mid-apply, before its hook step. */
async function crashedBeforeHooks() {
  const h = harness();
  const secretRef = "keychain:goatcitadel:hook:00000000-0000-4000-8000-000000000009";
  h.state.keychain.set(secretRef, HOOK_SECRET);
  const plan = await h.plans.create({
    actor: OPERATOR,
    request: h.pluginRequest({ "tool-watch": secretRef }),
    idempotencyKey: "capabilities:plugin-install:crashed:inspection",
  });
  await interrupt(h, plan);
  await h.store.update(PLUGIN_ID, () => crashedRecord(plan.planId, h.state.inspection.manifestSha256));
  return { h, plan, secretRef };
}

/** A hook in the workspace that signs what it sends to `url` with the stored secret. */
function hookHolding(secretRef: string, url: string): HookCreateInput {
  return {
    workspaceId: WORKSPACE_ID,
    label: "After a tool call",
    trigger: "tool.call.after",
    mode: "observe",
    dataScope: "metadata",
    action: { type: "webhook", webhook: { url, secretRef } },
  };
}

/** The plan as the control plane leaves it after a restart found its apply interrupted. */
async function interrupt(h: ReturnType<typeof harness>, plan: ChangePlanRecord): Promise<void> {
  h.sync.transition(plan.planId, {
    expectedRevision: plan.revision,
    status: "manual_required",
    internal: true,
    result: { summary: "The install stopped before it finished.", failureCode: "plugin_install_interrupted" },
  });
}

/** What an install that stopped before its hook step left: its pieces listed, none of them named yet. */
function crashedRecord(installPlanId: string, manifestSha256: string): StoredPlugin {
  return {
    pluginId: PLUGIN_ID,
    name: "Meeting tools",
    description: FULL_MANIFEST.description,
    version: FULL_MANIFEST.version,
    trust: "built_in",
    sourceKind: "built_in",
    sourceDisplay: "Ships with GoatCitadel",
    pin: { kind: "content", treeSha256: TREE_SHA256 },
    manifestSha256,
    snapshotTreeSha256: TREE_SHA256,
    workspaceId: WORKSPACE_ID,
    installPlanId,
    state: "installing",
    installedAt: "2026-10-31T11:00:00.000Z",
    pieces: [
      { pieceId: "meeting-notes", kind: "skill", owned: true },
      { pieceId: "tool-watch", kind: "hook", owned: true },
    ],
  };
}
