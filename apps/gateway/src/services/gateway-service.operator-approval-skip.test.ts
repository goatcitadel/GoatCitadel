import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChangePlanRuntimeFeatureFlag } from "@goatcitadel/contracts";
import { loadGatewayConfig } from "../config.js";
import { GatewayService } from "./gateway-service.js";

// R57: the Gateway's owner callback, not the skip helper, reads remote_hardened. These run a real
// Capabilities install through the Gateway's own control plane with the operator's skip turned on. R95: a Capabilities
// plan of any other kind keeps its approval.
describe("GatewayService operator approval skip for Capabilities installs", () => {
  let tempRoot: string;
  let gateway: GatewayService | undefined;
  const previousDriver = process.env.GOATCITADEL_DATABASE_DRIVER;
  const operator = { workspaceId: "default", actorId: "operator-capabilities", surface: "capabilities" as const };

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-operator-skip-"));
    process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
    // Seed the temp root with the repository config fixtures (same pattern as the MCP approval relief test).
    const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
    await fs.cp(path.join(repoRoot, "config"), path.join(tempRoot, "config"), { recursive: true });
    const config = await loadGatewayConfig(tempRoot);
    config.assistant.features.settingsApprovalSkipEnabled = true;
    gateway = new GatewayService(config);
  }, 120_000);

  afterAll(async () => {
    if (previousDriver === undefined) delete process.env.GOATCITADEL_DATABASE_DRIVER;
    else process.env.GOATCITADEL_DATABASE_DRIVER = previousDriver;
    await gateway?.close().catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
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
    return (await gateway!.storage.changePlans.listEvents(planId)).map((event) => event.eventType);
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
