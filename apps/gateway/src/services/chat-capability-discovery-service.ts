import { ConflictError, type ToolInvokeRequest, type ChatSessionRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { CapabilitySystemService } from "./capability-system-service.js";
import { searchCallableCapabilities } from "./callable-capability-discovery.js";
import { buildTrustedSkillSnapshot } from "./chat-turn-capability-profile-service.js";
import { readGovernedSkillContent } from "./governed-skill-instruction-service.js";

/** Read-only Chat discovery ports. Execution and activation authority stay with their owners. */
export interface ChatCapabilityDiscoveryHost {
  requireEnabled(): Promise<void>;
  requireSession(sessionId: string): Promise<ChatSessionRecord>;
  listCatalog(
    ...args: Parameters<CapabilitySystemService["listCatalog"]>
  ): ReturnType<CapabilitySystemService["listCatalog"]>;
  listSkills(
    ...args: Parameters<CapabilitySystemService["listSkills"]>
  ): ReturnType<CapabilitySystemService["listSkills"]>;
  listLifecycle(
    ...args: Parameters<AsyncStorage["skillLifecycle"]["list"]>
  ): ReturnType<AsyncStorage["skillLifecycle"]["list"]>;
}

export class ChatCapabilityDiscoveryService {
  public constructor(private readonly host: ChatCapabilityDiscoveryHost) {}

  private async requireWorkspace(request: ToolInvokeRequest): Promise<string> {
    await this.host.requireEnabled();
    const session = await this.host.requireSession(request.sessionId);
    const workspaceId = session.workspaceId;
    if (
      !workspaceId ||
      (request.workspaceId && request.workspaceId !== workspaceId) ||
      (request.policyContext?.workspaceId && request.policyContext.workspaceId !== workspaceId)
    ) {
      throw new ConflictError({ message: "Capability discovery requires the current session workspace." });
    }
    return workspaceId;
  }

  public async discover(request: ToolInvokeRequest): Promise<Record<string, unknown>> {
    const workspaceId = await this.requireWorkspace(request);
    return searchCallableCapabilities({
      query: String(request.args.query ?? ""),
      ...(typeof request.args.limit === "number" ? { limit: request.args.limit } : {}),
      callableCatalog: await this.host.listCatalog("callable", "ALL", workspaceId),
    });
  }

  public async readSkill(request: ToolInvokeRequest): Promise<Record<string, unknown>> {
    const workspaceId = await this.requireWorkspace(request);
    const skillId = String(request.args.skillId ?? "");
    const [catalog, lifecycleRows, loadedSkills] = await Promise.all([
      this.host.listCatalog("callable", "ALL", workspaceId),
      this.host.listLifecycle(),
      this.host.listSkills("ALL", workspaceId),
    ]);
    const callableEntry = catalog.find((entry) => entry.kind === "skill" && entry.skillId === skillId);
    return readGovernedSkillContent({
      skillId,
      ...(typeof request.args.relativePath === "string" ? { relativePath: request.args.relativePath } : {}),
      callableEntry,
      trustedSkill: buildTrustedSkillSnapshot(callableEntry ? [callableEntry] : [], lifecycleRows)[0],
      loadedSkill: loadedSkills.find((skill) => skill.skillId === skillId),
      lifecycle: lifecycleRows.find((lifecycle) => lifecycle.skillId === skillId),
    });
  }
}
