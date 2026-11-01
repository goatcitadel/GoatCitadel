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

/** What an approved revoke's effect does to the skill's check, as Skill Hub's would. */
type RevokeEffect = (h: ReturnType<typeof harness>, approvalId: string) => void;

/** It revokes the skill. */
const revokes: RevokeEffect = (h, approvalId) =>
  h.removal.skillChecks.set(
    SKILL_CHECK_ID,
    REVOKED({ revokeApproval: { approvalId, status: "approved", settled: "applied" } }),
  );
/** It settles blocked: the skill stays switched on. */
const blocks: RevokeEffect = (h, approvalId) =>
  h.removal.skillChecks.set(
    SKILL_CHECK_ID,
    skillCheck({ revokeApproval: { approvalId, status: "approved", settled: "blocked" } }),
  );
/** It hasn't applied yet. */
const inFlight: RevokeEffect = (h, approvalId) =>
  h.removal.skillChecks.set(SKILL_CHECK_ID, skillCheck({ revokeApproval: { approvalId, status: "approved" } }));

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
 * profile decides as the Gateway's does. Once approved, its effect applies.
 */
function skillActions(
  profile: DeploymentProfile,
  approvals: Map<string, ApprovalRequest["status"]>,
  applyEffect: (approvalId: string) => void,
) {
  let asked = 0;
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
      const approval = { ...hubApproval("revoke", "pending"), approvalId: `approval-revoke-${++asked}` };
      approvals.set(approval.approvalId, "pending");
      return { approval };
    }),
    findSkillHubSnapshot: vi.fn(async () => undefined),
    listPluginRecords: vi.fn(async () => []),
  } satisfies CapabilitySkillActionSources;
  const actions = new CapabilitySkillActionsService(sources);
  return {
    sources,
    approvals,
    /** What an approved revoke does to the check; a test changes it. */
    effect: revokes as RevokeEffect,
    /** The operator approves a revoke in the Inbox. */
    approve,
    revokeSkill: (input: Parameters<typeof actions.revokeForPluginUninstall>[0]) =>
      actions.revokeForPluginUninstall(input),
  };
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

    // The operator approves the revoke, and its effect is still being applied: the plugin stays.
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
        "The skill Meeting notes is still being removed.",
        "Then uninstall Meeting tools again to finish.",
      ].join(" "),
    );
    const left = await h.store.get(PLUGIN_ID);
    expect(left?.state).toBe("uninstalling");
    expect(left?.pieces[0]).toMatchObject({
      pieceId: "meeting-notes",
      waiting: { approvalId: "approval-revoke-1", operation: "revoke" },
    });
    await expect(h.store.listRemoved()).resolves.toEqual([]);

    // Its effect revokes the skill.
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

  it("keeps the plugin when a revoke's effect didn't take, and asks again when uninstalled again", async () => {
    const { h, tab } = withSkillsTab("trusted_local");
    tab.effect = blocks;
    await installed(h);

    const first = await h.uninstall();

    // Approved, but its effect settled blocked: the skill is still switched on, so the record stays.
    expect(first).toEqual({
      planId: expect.any(String),
      outcome: "waiting",
      summary: [
        "Removed 4 pieces.",
        "Hosts it allowed stay in your allowlist.",
        "The skill Meeting notes is still being removed.",
        "Then uninstall Meeting tools again to finish.",
      ].join(" "),
    });
    const left = await h.store.get(PLUGIN_ID);
    expect(left?.state).toBe("uninstalling");
    expect(left?.pieces[0]).toMatchObject({
      pieceId: "meeting-notes",
      waiting: { approvalId: "approval-revoke-1", operation: "revoke" },
    });
    await expect(h.store.listRemoved()).resolves.toEqual([]);

    tab.effect = revokes;
    const second = await h.uninstall(OPERATOR, "again");

    // The settled one can't revoke it, so a fresh revoke is asked for, and this one takes.
    expect(second).toMatchObject({
      outcome: "applied",
      summary: "Removed 1 piece. Hosts it allowed stay in your allowlist.",
    });
    expect(tab.sources.createSkillHubApproval).toHaveBeenCalledTimes(2);
    expect(tab.sources.resolveApproval).toHaveBeenLastCalledWith("approval-revoke-2", expect.anything());
    await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
  });

  it("reads the check again while an approved revoke's effect runs, and keeps the plugin if it never lands", async () => {
    // The effect lands a moment after the approval resolved: the uninstall still finishes in one pass.
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

    // It never lands while the uninstall reads: the skill is still being removed, and the plugin stays.
    const { h: slow, tab: slowTab } = withSkillsTab("trusted_local");
    slowTab.effect = inFlight;
    await installed(slow);

    await expect(slow.uninstall()).resolves.toMatchObject({
      outcome: "waiting",
      summary: [
        "Removed 4 pieces.",
        "Hosts it allowed stay in your allowlist.",
        "The skill Meeting notes is still being removed.",
        "Then uninstall Meeting tools again to finish.",
      ].join(" "),
    });
    // About ten seconds of reads, a quarter second apart.
    expect(slow.uninstallSources.pause).toHaveBeenCalledTimes(39);
    expect(await slow.store.get(PLUGIN_ID)).toMatchObject({ state: "uninstalling" });
  });

  it("stops plainly when Skill Hub hands back the approved revoke that didn't take, keeping the plugin", async () => {
    const { h, tab } = withSkillsTab("trusted_local");
    tab.effect = blocks;
    await installed(h);
    await h.uninstall();
    // Skill Hub matches the fresh ask to the revoke it already approved.
    tab.sources.createSkillHubApproval.mockImplementationOnce(async () => ({
      approval: { ...hubApproval("revoke", "approved"), approvalId: "approval-revoke-1" },
    }));

    const stopped = await h.uninstall(OPERATOR, "again");

    expect(stopped).toMatchObject({
      outcome: "failed",
      summary:
        "Couldn't remove the skill Meeting notes: its removal was approved, but it didn't take effect. " +
        "Uninstall Meeting tools again to finish.",
    });
    expect(await h.plans.get(OPERATOR, stopped.planId)).toMatchObject({
      status: "manual_required",
      result: {
        failureCode: "plugin_uninstall_skills_failed",
        failureDetail: "Revoke approval approval-revoke-1 settled blocked.",
      },
    });
    expect(tab.sources.resolveApproval).toHaveBeenCalledOnce();
    expect(await h.store.get(PLUGIN_ID)).toMatchObject({ state: "uninstalling" });
    await expect(h.store.listRemoved()).resolves.toEqual([]);
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
    expect(waiting.summary).toContain("The skill Meeting notes is still taking one of its own steps.");
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

      await expect(h.uninstall(), String(orphanHook)).resolves.toMatchObject({
        outcome: "applied",
        summary: `Removed ${orphanHook ? "1 piece" : "0 pieces"}. Hosts it allowed stay in your allowlist.`,
      });

      expect(h.state.keychain.has(secretRef)).toBe(false);
      if (orphanHook) {
        // Through the hooks owner, with the plugin's pass; it deletes the hook's secret with it.
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

  it("stops plainly at a hook holding its secret that doesn't match its hook, keeping both", async () => {
    const { h, secretRef } = await crashedBeforeHooks();
    h.state.hooks.push(hookHolding(secretRef, "https://elsewhere.example/goat"));

    const stopped = await h.uninstall();

    expect(stopped).toMatchObject({
      outcome: "failed",
      summary:
        "A hook that sends event details to elsewhere.example uses a signing secret this plugin stored, and doesn't " +
        "match its hook, so it was kept. Uninstall Meeting tools again to finish.",
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

  it("deletes a hook's signing secret its owner left behind", async () => {
    const h = harness();
    await installed(h);
    expect(h.state.keychain.size).toBe(1);
    // The hooks owner deletes the hook, but its key store is briefly unavailable, so the secret stays.
    h.uninstallSources.deleteHook.mockImplementationOnce(async (_workspaceId, hookId) => {
      h.removal.order.push("hook");
      h.removal.deletedHooks.add(hookId);
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
    "keeps the plugin when it can't tell which stored secrets a hook still uses: %s",
    async (_case, detail, listed) => {
      const h = harness();
      const record = await installed(h);
      const install = await h.plans.get(OPERATOR, record.installPlanId);
      const secretRefs = install.request.kind === "plugin_install" ? install.request.hookSecretRefs : undefined;
      expect(Object.values(secretRefs ?? {})).toHaveLength(1);
      if (listed) {
        // The workspace has as many hooks as one read returns.
        h.uninstallSources.listHookSecrets.mockResolvedValueOnce(undefined);
      } else {
        h.uninstallSources.readInstallSecretRefs.mockRejectedValueOnce(new Error(detail));
      }

      const stopped = await h.uninstall();

      expect(stopped).toMatchObject({
        outcome: "failed",
        summary: [
          "Removed 1 piece.",
          "Couldn't tell whether its hooks still use the signing secrets it stored, so they were kept.",
          "Uninstall Meeting tools again to finish.",
        ].join(" "),
      });
      expect(await h.plans.get(OPERATOR, stopped.planId)).toMatchObject({
        status: "manual_required",
        result: {
          failureCode: "plugin_uninstall_hooks_failed",
          failureDetail: detail,
        },
      });
      // Logged by plugin and by the references it read (none when the plan couldn't be read), never a value.
      expect(h.uninstallSources.reportUndecidedSecrets).toHaveBeenCalledExactlyOnceWith(
        PLUGIN_ID,
        listed ? Object.values(secretRefs ?? {}) : [],
        expect.any(Error),
      );
      expect(await h.store.get(PLUGIN_ID)).toMatchObject({ state: "uninstalling" });

      await expect(h.uninstall(OPERATOR, "again")).resolves.toMatchObject({
        outcome: "applied",
        summary: "Removed 4 pieces. Hosts it allowed stay in your allowlist.",
      });
    },
  );

  it("removes a connector this install saved before its record named it", async () => {
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

    await expect(h.uninstall()).resolves.toMatchObject({
      outcome: "applied",
      summary: "Removed 5 pieces. Hosts it allowed stay in your allowlist.",
    });

    expect(h.uninstallSources.deleteConnector).toHaveBeenCalledExactlyOnceWith(server!.serverId, {
      pluginId: PLUGIN_ID,
      installPlanId: expect.any(String),
    });
    expect(h.state.servers).toEqual([others]);
  });

  it("hands a connector another plugin uses to the operator instead of deleting it", async () => {
    const h = harness();
    const record = await installed(h);
    const [server] = h.state.servers;
    // Another plugin, installed later, found the connector already saved and kept it.
    await h.store.update("other-tools", () => ({
      ...record,
      pluginId: "other-tools",
      name: "Other tools",
      installPlanId: "plan-other",
      pieces: [{ pieceId: "issues", kind: "connector", owned: false }],
    }));
    expect(() => assertMcpServerRemovalAllowed(server, undefined)).toThrow();

    const outcome = await h.uninstall();

    expect(outcome).toMatchObject({
      outcome: "applied",
      summary: "Removed 4 pieces. Kept Issues, which Other tools uses. Hosts it allowed stay in your allowlist.",
    });
    const plan = await h.plans.get(OPERATOR, outcome.planId);
    expect(plan.summary).toContain("Keep Issues, which Other tools uses.");
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
    await expect(h.uninstall(OPERATOR, "again")).resolves.toMatchObject({ outcome: "applied" });
    await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
    await expect(h.store.listRemoved()).resolves.toMatchObject([{ pluginId: PLUGIN_ID, skillIds: [SKILL_ID] }]);
  });

  it("asks once when the setting is off", async () => {
    const { h, tab: local } = withSkillsTab("trusted_local", { skip: false });
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

    expect((await h.plans.get(OPERATOR, waiting.planId)).status).toBe("completed");
    await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
    // One approval for the whole uninstall: its revoke applies without asking, as it only takes power away.
    expect(h.createApproval.mock.calls.length).toBe(asked + 1);
    expect(local.sources.resolveApproval).toHaveBeenCalledOnce();
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
