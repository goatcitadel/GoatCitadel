import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, ChangePlanRecord, DeploymentProfile, McpServerRecord } from "@goatcitadel/contracts";
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
  SKILL_CHECK_ID,
  SKILL_ID,
  pluginUninstallHarness,
  skillCheck,
  type PluginUninstallFixture,
} from "./capability-plugin-uninstall.test-support.js";
import { isAutoResumeOnApprovalPlan } from "./evolution-control-plane-approval-reconciliation.js";

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

/**
 * The Skills tab's own revoke over a Skill Hub owner kept in memory: its approval waits until it is resolved, and the
 * profile decides as the Gateway's does.
 */
function skillActions(profile: DeploymentProfile = "trusted_local") {
  const approvals = new Map<string, ApprovalRequest["status"]>();
  let asked = 0;
  const sources = {
    setSkillState: vi.fn(),
    resolveApproval: vi.fn(async (approvalId: string) => {
      approvals.set(approvalId, "approved");
    }),
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
    revokeSkill: (input: Parameters<typeof actions.revokeForPluginUninstall>[0]) =>
      actions.revokeForPluginUninstall(input),
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
    expect(h.removal.order).toEqual(["hook", "prompt_pack", "connector_disconnect", "connector_delete", "revoke"]);
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
    // With the setting on, the plan applies at once and the revoke is approved as the operator, with its note.
    const local = skillActions("trusted_local");
    const h = harness({ revokeSkill: local.revokeSkill });
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
    const hardened = skillActions("remote_hardened");
    const r = harness({ profile: "remote_hardened", revokeSkill: hardened.revokeSkill });
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

  it("finishes a waiting one when uninstalled again, never asking for a second revoke", async () => {
    const hardened = skillActions("remote_hardened");
    const h = harness({ profile: "remote_hardened", revokeSkill: hardened.revokeSkill });
    await installed(h);
    await uninstalled(h, "first");
    // Many newer approvals later, the check's own window no longer shows the revoke as waiting.
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
    expect(hardened.sources.createSkillHubApproval).toHaveBeenCalledOnce();
    expect(hardened.sources.readApproval).toHaveBeenCalledWith("approval-revoke-1");

    // The operator approves the revoke, and its effect revokes the skill.
    hardened.approvals.set("approval-revoke-1", "approved");
    h.removal.skillChecks.set(SKILL_CHECK_ID, skillCheck({ revoked: true }));

    const finished = await uninstalled(h, "third");

    expect(finished).toMatchObject({
      outcome: "applied",
      summary: "Removed 1 piece. Hosts it allowed stay in your allowlist.",
    });
    expect(hardened.sources.createSkillHubApproval).toHaveBeenCalledOnce();
    await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
    await expect(h.store.listRemoved()).resolves.toMatchObject([{ pluginId: PLUGIN_ID, skillIds: [SKILL_ID] }]);
  });

  it("waits for a skill still taking one of its own steps, so nothing switches it on once the plugin is gone", async () => {
    const h = harness();
    await installed(h);
    // Its switch-on step waits for the operator's approval.
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

    // Declined: it stays installed and switched off, inert, so the next uninstall removes the plugin.
    h.removal.skillChecks.set(SKILL_CHECK_ID, skillCheck({ version: "installed_off", step: "installed_off" }));
    await expect(h.uninstall(OPERATOR, "again")).resolves.toMatchObject({
      outcome: "applied",
      summary: "Removed 1 piece. Hosts it allowed stay in your allowlist.",
    });
    expect(h.revokeSkill).not.toHaveBeenCalled();
    await expect(h.store.listRemoved()).resolves.toMatchObject([{ skillIds: [SKILL_ID] }]);
  });

  it("cleans up after a failed install", async () => {
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
      summary: "Removed 4 pieces. Hosts it allowed stay in your allowlist.",
    });
    expect(h.removal.order).toEqual(["hook", "connector_disconnect", "connector_delete"]);
    expect(h.uninstallSources.deletePromptPack).not.toHaveBeenCalled();
    expect(h.revokeSkill).not.toHaveBeenCalled();
    expect(h.state.servers).toEqual([]);
    expect(h.state.keychain.size).toBe(0);
    await expect(h.store.get(PLUGIN_ID)).resolves.toBeUndefined();
  });

  it("deletes the secrets of an install that stopped before its hooks, but never one a hook still uses", async () => {
    for (const orphanHook of [false, true]) {
      const h = harness();
      const refs = { "tool-watch": "keychain:goatcitadel:hook:00000000-0000-4000-8000-000000000009" };
      h.state.keychain.set(refs["tool-watch"], HOOK_SECRET);
      // The install plan stored its secret and the process stopped mid-apply, before its hook step.
      const plan = await h.plans.create({
        actor: OPERATOR,
        request: h.pluginRequest(refs),
        idempotencyKey: "capabilities:plugin-install:crashed:inspection",
      });
      await interrupt(h, plan);
      await h.store.update(PLUGIN_ID, () => crashedRecord(plan.planId));
      // A hook made just before the stop, whose piece the record never got to name, holds the secret.
      if (orphanHook) {
        h.state.hooks.push({
          workspaceId: WORKSPACE_ID,
          label: "After a tool call",
          trigger: "tool.call.after",
          mode: "observe",
          dataScope: "metadata",
          action: {
            type: "webhook",
            webhook: { url: "https://hooks.example.com/goat", secretRef: refs["tool-watch"] },
          },
        });
      }

      await expect(h.uninstall()).resolves.toMatchObject({ outcome: "applied" });

      expect(h.state.keychain.has(refs["tool-watch"]), String(orphanHook)).toBe(orphanHook);
      expect(h.uninstallSources.deleteHook).not.toHaveBeenCalled();
    }
  });

  it("asks once when the setting is off", async () => {
    const local = skillActions("trusted_local");
    const h = harness({ skip: false, revokeSkill: local.revokeSkill });
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
    expect(h.removal.order).toEqual(["hook", "prompt_pack", "connector_disconnect", "connector_delete", "revoke"]);
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

/** The plan as the control plane leaves it after a restart found its apply interrupted. */
async function interrupt(h: ReturnType<typeof harness>, plan: ChangePlanRecord): Promise<void> {
  h.sync.transition(plan.planId, {
    expectedRevision: plan.revision,
    status: "manual_required",
    internal: true,
    result: { summary: "The install stopped before it finished.", failureCode: "plugin_install_interrupted" },
  });
}

/** What an install that stopped before its hook step left: its connector's piece named, nothing else. */
function crashedRecord(installPlanId: string): StoredPlugin {
  return {
    pluginId: PLUGIN_ID,
    name: "Meeting tools",
    description: FULL_MANIFEST.description,
    version: FULL_MANIFEST.version,
    trust: "built_in",
    sourceKind: "built_in",
    sourceDisplay: "Ships with GoatCitadel",
    pin: { kind: "content", treeSha256: TREE_SHA256 },
    manifestSha256: "0".repeat(64),
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
