import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChangePlanRuntimeFeatureFlag, ToolGroupChange } from "@goatcitadel/contracts";
import { loadGatewayConfig } from "../config.js";
import type { EvolutionControlPlaneActor } from "./evolution-control-plane-service.js";
import { GatewayService } from "./gateway-service.js";

interface GatewayFixture {
  readonly tempRoot: string;
  readonly gateway: GatewayService;
  readonly previousDriver: string | undefined;
}

/** A real Gateway on a temp copy of the repository config fixtures, with the operator's approval skip turned on. */
async function startGatewayFixture(): Promise<GatewayFixture> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-operator-skip-"));
  const previousDriver = process.env.GOATCITADEL_DATABASE_DRIVER;
  process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
  // Seed the temp root with the repository config fixtures (same pattern as the MCP approval relief test).
  const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
  await fs.cp(path.join(repoRoot, "config"), path.join(tempRoot, "config"), { recursive: true });
  const config = await loadGatewayConfig(tempRoot);
  config.assistant.features.settingsApprovalSkipEnabled = true;
  return { tempRoot, gateway: new GatewayService(config), previousDriver };
}

async function stopGatewayFixture(fixture: GatewayFixture | undefined): Promise<void> {
  if (!fixture) return;
  if (fixture.previousDriver === undefined) delete process.env.GOATCITADEL_DATABASE_DRIVER;
  else process.env.GOATCITADEL_DATABASE_DRIVER = fixture.previousDriver;
  await fixture.gateway.close().catch(() => undefined);
  await fs.rm(fixture.tempRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function planEventTypes(gateway: GatewayService, planId: string) {
  return (await gateway.storage.changePlans.listEvents(planId)).map((event) => event.eventType);
}

// R57: the Gateway's owner callback, not the skip helper, reads remote_hardened. These run a real
// Capabilities install through the Gateway's own control plane with the operator's skip turned on. R95: a Capabilities
// plan of any other kind keeps its approval.
describe("GatewayService operator approval skip for Capabilities installs", () => {
  let fixture: GatewayFixture | undefined;
  let gateway: GatewayService | undefined;
  const operator = { workspaceId: "default", actorId: "operator-capabilities", surface: "capabilities" as const };

  beforeAll(async () => {
    fixture = await startGatewayFixture();
    gateway = fixture.gateway;
  }, 120_000);

  afterAll(async () => {
    await stopGatewayFixture(fixture);
  });

  /** Creates and confirms a danger install plan as the Capabilities install route does. */
  async function confirmInstall(templateId: string) {
    const plans = gateway!.evolutionControlPlaneService;
    const plan = await plans.create({
      actor: operator,
      request: { kind: "connector_install", templateId, enableChatConnectors: false },
    });
    expect(plan.origin.surface).toBe("capabilities");
    expect(plan.risk).toBe("danger");
    return await plans.confirm(operator, plan.planId, plan.revision, plan.requiredAction!.actionNonce, {
      operatorSettingsSave: true,
    });
  }

  async function eventTypes(planId: string) {
    return await planEventTypes(gateway!, planId);
  }

  it("installs from Capabilities without an Inbox approval when the operator turned the skip on", async () => {
    expect(await gateway!.isFeatureEnabled("settingsApprovalSkipEnabled")).toBe(true);

    const settled = await confirmInstall("aws-knowledge");

    expect(settled.status).toBe("completed");
    expect(await eventTypes(settled.planId)).toContain("operator_approval_skipped");
  });

  it("keeps the Inbox approval for a Capabilities plan that isn't an install, even with the skip on", async () => {
    const flag: ChangePlanRuntimeFeatureFlag = "claudeCliWarmContinuationEnabled";
    const plans = gateway!.evolutionControlPlaneService;
    const plan = await plans.create({
      actor: operator,
      request: { kind: "runtime_configuration", change: { operation: "feature_flag", flag, enabled: false } },
    });

    const waiting = await plans.confirm(operator, plan.planId, plan.revision, plan.requiredAction!.actionNonce, {
      operatorSettingsSave: true,
    });

    expect(waiting.status).toBe("awaiting_approval");
    expect(await eventTypes(waiting.planId)).not.toContain("operator_approval_skipped");
  });

  it("always asks under remote_hardened, even with the skip on", async () => {
    const service = gateway!;
    const previous = service.config.assistant.deploymentProfile;
    service.config.assistant.deploymentProfile = "remote_hardened";
    try {
      expect(await service.isFeatureEnabled("settingsApprovalSkipEnabled")).toBe(true);

      const waiting = await confirmInstall("deepwiki");

      expect(waiting.status).toBe("awaiting_approval");
      expect(waiting.requiredAction?.kind).toBe("approval");
      expect(await eventTypes(waiting.planId)).not.toContain("operator_approval_skipped");
    } finally {
      service.config.assistant.deploymentProfile = previous;
    }
  });
});

// A tool group switch is a governed Settings change: off is safe and applies at once, on is caution and follows the
// operator's approval skip. Each test works on its own group so a plan left waiting in Inbox can't block the next one.
describe("GatewayService tool group switches", () => {
  let fixture: GatewayFixture | undefined;
  let gateway: GatewayService | undefined;
  const settingsActor = { workspaceId: "default", actorId: "operator-settings", surface: "settings" as const };
  const chatActor = {
    workspaceId: "default",
    actorId: "operator-chat",
    surface: "chat" as const,
    sessionId: "tool-group-session",
  };

  beforeAll(async () => {
    fixture = await startGatewayFixture();
    gateway = fixture.gateway;
  }, 120_000);

  afterAll(async () => {
    await stopGatewayFixture(fixture);
  });

  async function createGroupSwitchPlan(change: ToolGroupChange, actor: EvolutionControlPlaneActor = settingsActor) {
    return await gateway!.evolutionControlPlaneService.create({
      actor,
      request: { kind: "runtime_configuration", change: { operation: "tool_group_access", ...change } },
    });
  }

  /** The Settings save: a plan on the settings surface, confirmed as the operator's own save. */
  async function confirmGroupSwitchPlan(
    plan: Awaited<ReturnType<typeof createGroupSwitchPlan>>,
    actor: EvolutionControlPlaneActor = settingsActor,
  ) {
    return await gateway!.evolutionControlPlaneService.confirm(
      actor,
      plan.planId,
      plan.revision,
      plan.requiredAction!.actionNonce,
      { operatorSettingsSave: true },
    );
  }

  async function saveGroupSwitch(change: ToolGroupChange, actor: EvolutionControlPlaneActor = settingsActor) {
    return await confirmGroupSwitchPlan(await createGroupSwitchPlan(change, actor), actor);
  }

  /** What the live policy engine says about a tool, the way the Chat runner probes it before offering the tool. */
  async function reasonCodesFor(toolName: string): Promise<readonly string[]> {
    const access = await gateway!.policyEngine.inspectAccess({
      toolName,
      args: {},
      agentId: "assistant",
      sessionId: "tool-group-session",
      workspaceId: "default",
    });
    return access.reasonCodes;
  }

  async function switchedOffGroups() {
    return (await gateway!.getSettings()).switchedOffToolGroups;
  }

  async function setApprovalSkip(enabled: boolean) {
    await gateway!.updateFeatureFlags({ settingsApprovalSkipEnabled: enabled }, { resumeParkedRuns: false });
    expect(await gateway!.isFeatureEnabled("settingsApprovalSkipEnabled")).toBe(enabled);
  }

  it("applies switching off without an approval", async () => {
    const settled = await saveGroupSwitch({ groupId: "git", enabled: false });

    expect(settled.risk).toBe("safe");
    expect(settled.status).toBe("completed");
    expect(settled.title).toBe("Switch off the Git tools");
    expect(settled.result?.summary).toBe("The AI can't use the Git tools in any chat.");
    const events = await planEventTypes(gateway!, settled.planId);
    expect(events).toEqual(expect.arrayContaining(["apply_started", "verification_settled"]));
    expect(events).not.toContain("operator_approval_skipped");
    expect(settled.target.resourceId).toBe("tool_group_access:git");
    expect(await switchedOffGroups()).toEqual(["git"]);
  });

  it("takes effect in the running policy engine without a restart, and lifts when switched back on", async () => {
    expect(await reasonCodesFor("memory.read")).not.toContain("tool_group_off");

    await saveGroupSwitch({ groupId: "memory", enabled: false });

    // The engine reads the same config object the save changed, so the next evaluation already sees the switch.
    expect(await reasonCodesFor("memory.read")).toContain("tool_group_off");
    expect(await reasonCodesFor("memory.write")).toContain("tool_group_off");
    // Other groups and Core are untouched.
    expect(await reasonCodesFor("fs.stat")).not.toContain("tool_group_off");
    expect(await reasonCodesFor("session.status")).not.toContain("tool_group_off");
    expect(await reasonCodesFor("mcp.invoke")).not.toContain("tool_group_off");

    // The operator's skip is on in this suite, so switching back on applies at once.
    await saveGroupSwitch({ groupId: "memory", enabled: true });
    expect(await reasonCodesFor("memory.read")).not.toContain("tool_group_off");
    expect(await reasonCodesFor("memory.write")).not.toContain("tool_group_off");
  });

  it("waits in Inbox to switch on when the approval skip is off", async () => {
    await saveGroupSwitch({ groupId: "webhooks", enabled: false });
    expect(await reasonCodesFor("webhook.send")).toContain("tool_group_off");
    await setApprovalSkip(false);
    try {
      const waiting = await saveGroupSwitch({ groupId: "webhooks", enabled: true });

      expect(waiting.risk).toBe("caution");
      expect(waiting.title).toBe("Switch the Webhooks tools back on");
      expect(waiting.status).toBe("awaiting_approval");
      expect(waiting.requiredAction?.kind).toBe("approval");
      expect(await planEventTypes(gateway!, waiting.planId)).not.toContain("operator_approval_skipped");
      // Nothing changed while it waits: the group is still off for the AI.
      expect(await switchedOffGroups()).toContain("webhooks");
      expect(await reasonCodesFor("webhook.send")).toContain("tool_group_off");
    } finally {
      await setApprovalSkip(true);
    }
  });

  // The approval is the operator's last word on a switch they flipped themselves, so approving applies it (#496).
  it("switches on once the operator approves it in Inbox", async () => {
    await saveGroupSwitch({ groupId: "subagents", enabled: false });
    await setApprovalSkip(false);
    try {
      const waiting = await saveGroupSwitch({ groupId: "subagents", enabled: true });
      expect(waiting.status).toBe("awaiting_approval");
      const approvalId = waiting.requiredAction?.kind === "approval" ? waiting.requiredAction.approvalId : undefined;
      expect(approvalId).toBeTruthy();

      await gateway!.resolveApproval(approvalId!, { decision: "approve", resolvedBy: "operator" });

      await vi.waitFor(
        async () => {
          const plan = await gateway!.evolutionControlPlaneService.get(settingsActor, waiting.planId);
          expect(plan.status).toBe("completed");
        },
        { timeout: 8_000, interval: 100 },
      );
      expect(await switchedOffGroups()).not.toContain("subagents");
      expect(await reasonCodesFor("agent.fanout")).not.toContain("tool_group_off");
    } finally {
      await setApprovalSkip(true);
    }
  }, 30_000);

  it("switches on straight away when the approval skip is on", async () => {
    await saveGroupSwitch({ groupId: "schedules", enabled: false });
    expect(await reasonCodesFor("schedule.manage")).toContain("tool_group_off");
    await setApprovalSkip(true);

    const settled = await saveGroupSwitch({ groupId: "schedules", enabled: true });

    expect(settled.risk).toBe("caution");
    expect(settled.status).toBe("completed");
    expect(settled.result?.summary).toBe("The Schedules tools are back on. Other safety rules still apply.");
    expect(await planEventTypes(gateway!, settled.planId)).toContain("operator_approval_skipped");
    expect(await switchedOffGroups()).not.toContain("schedules");
    // Switching back on lifts only the group's switch; the engine decides the rest as it did before.
    expect(await reasonCodesFor("schedule.manage")).not.toContain("tool_group_off");
  });

  it("always asks to switch on under remote_hardened", async () => {
    await saveGroupSwitch({ groupId: "subagents", enabled: false });
    // The plan is prepared first, as on an install that already has the auth remote_hardened requires; only the
    // Gateway's own skip callback reads the profile when the operator confirms.
    const plan = await createGroupSwitchPlan({ groupId: "subagents", enabled: true });
    const service = gateway!;
    const previous = service.config.assistant.deploymentProfile;
    service.config.assistant.deploymentProfile = "remote_hardened";
    try {
      expect(await service.isFeatureEnabled("settingsApprovalSkipEnabled")).toBe(true);

      const waiting = await confirmGroupSwitchPlan(plan);

      expect(waiting.status).toBe("awaiting_approval");
      expect(waiting.requiredAction?.kind).toBe("approval");
      expect(await planEventTypes(service, waiting.planId)).not.toContain("operator_approval_skipped");
      expect(await switchedOffGroups()).toContain("subagents");
    } finally {
      service.config.assistant.deploymentProfile = previous;
    }
  });

  it("keeps the approval for a Chat request to switch a group on, even with the skip on", async () => {
    await saveGroupSwitch({ groupId: "documents", enabled: false });
    expect(await gateway!.isFeatureEnabled("settingsApprovalSkipEnabled")).toBe(true);

    const waiting = await saveGroupSwitch({ groupId: "documents", enabled: true }, chatActor);

    expect(waiting.status).toBe("awaiting_approval");
    expect(await planEventTypes(gateway!, waiting.planId)).not.toContain("operator_approval_skipped");
    expect(await reasonCodesFor("docs.search")).toContain("tool_group_off");
  });

  it("saves directly when Change Plans are off, and the switch is stored for the next start", async () => {
    const live = gateway!;
    await live.updateFeatureFlags({ evolutionControlPlaneV1Enabled: false }, { resumeParkedRuns: false });
    try {
      expect(await live.evolutionControlPlaneService.isEnabled()).toBe(false);
      const before = await live.getSettings();

      const after = await live.updateSettings({
        expectedRevision: before.revision,
        toolGroupChange: { groupId: "browser", enabled: false },
      });

      expect(after.switchedOffToolGroups).toContain("browser");
      expect(await reasonCodesFor("browser.navigate")).toContain("tool_group_off");
      // tools.allow and tools.deny are not the switch's to touch.
      expect(after.globalToolAccess).toEqual(before.globalToolAccess);
      // The list is stored with the rest of the tool policy, so a restart reads it back.
      const reloaded = await loadGatewayConfig(fixture!.tempRoot);
      expect(reloaded.toolPolicy.tools.disabledGroups).toContain("browser");
    } finally {
      await live.updateFeatureFlags({ evolutionControlPlaneV1Enabled: true }, { resumeParkedRuns: false });
    }
  });
});
