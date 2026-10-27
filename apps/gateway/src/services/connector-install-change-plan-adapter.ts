import {
  ConflictError,
  PolicyViolationError,
  SemanticValidationError,
  hasMcpOAuthEndpointSource,
  redactSecretText,
  type ChangePlanConnectorInstallRequest,
  type ChangePlanOrigin,
  type ChangePlanRecord,
  type McpServerCreateInput,
  type McpServerRecord,
  type McpServerTemplateRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneAdapterOutcome,
} from "./evolution-control-plane-adapter.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import type { UpdateSettingsInput } from "./settings-auth-service.js";
import { EXCLUDED_CONNECTOR_TEMPLATE_IDS } from "./capability-connectors-projection.js";
import { isHostAllowlistedInList } from "./connection-url-helpers.js";
import { mcpServerLabelKey } from "./mcp-money-moving.js";
import * as mcpServerAdminService from "./mcp-server-admin-service.js";
import { mcpServerRevision } from "./mcp-server-revision.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { isVisibleMcpTemplateRecord } from "./mcp-template-visibility.js";

/** The settings an install reads: the allowed hosts and whether Chat may use connectors. */
export type ConnectorInstallSettings = Pick<RuntimeSettings, "revision" | "networkAllowlist"> & {
  features: Pick<RuntimeSettings["features"], "chatStaticMcpV1Enabled">;
};

/** The owners an install writes through. Each write stays with its owner; the adapter only orders them. */
export interface ConnectorInstallDependencies {
  /** The shipped catalog. Visibility and the Capabilities exclusions are applied by the adapter. */
  readonly templates: readonly McpServerTemplateRecord[];
  readMcpServers(): Promise<readonly McpServerRecord[]>;
  readSettings(): Promise<ConnectorInstallSettings>;
  /** Revision-fenced, so every write re-reads the settings first. */
  updateSettings(
    input: Pick<UpdateSettingsInput, "expectedRevision" | "networkAllowlist" | "features">,
  ): Promise<unknown>;
  createMcpServer(input: McpServerCreateInput): Promise<McpServerRecord>;
  /** Sets "Reading is free" through the policy write, which audits the change under `actorId`. */
  setReadsFree(server: McpServerRecord, actorId: string): Promise<McpServerRecord>;
}

/** The GatewayService members an install uses. `mcpAdministration` is passed beside it because it is private there. */
export interface ConnectorInstallGateway {
  readonly storage: Pick<Storage, "runImmediateTransaction">;
  getSettings(): Promise<RuntimeSettings>;
  updateSettings(input: UpdateSettingsInput): Promise<RuntimeSettings>;
  listMcpServers(): Promise<McpServerRecord[]>;
}

type InstallStep = "allow" | "save" | "reads_free" | "chat";

/**
 * Installs a connector from its template as the operator's own Capabilities action: it allows the template's hosts,
 * saves the server switched off with "Reading is free", and lets Chat use connectors when asked. Validation runs when
 * the plan is made and again at apply. Nothing is staged, so the operator's confirmation reaches the approval skip.
 */
export class ConnectorInstallChangePlanAdapter implements EvolutionControlPlaneAdapter<ChangePlanConnectorInstallRequest> {
  readonly adapterId = "connector-install";
  readonly version = 1;
  readonly kinds = ["connector_install"] as const;
  constructor(private readonly deps: ConnectorInstallDependencies) {}

  async prepare(context: EvolutionControlPlaneAdapterContext, request: ChangePlanConnectorInstallRequest) {
    requireCapabilitiesOrigin(context.origin);
    const template = await this.resolve(request);
    const settings = await this.deps.readSettings();
    const missing = missingHosts(template, settings.networkAllowlist);
    const steps = [
      ...(missing.length > 0 ? [`Allow ${missing.join(", ")}.`] : []),
      `Save ${template.label}, switched off, set to Reading is free.`,
      ...(request.enableChatConnectors && settings.features.chatStaticMcpV1Enabled !== true
        ? ["Let Chat use connectors."]
        : []),
    ].join(" ");
    return {
      target: { ownerId: "capability_connector_install", resourceId: `mcp_template:${template.templateId}` },
      title: `Install ${template.label}`,
      summary: steps,
      impact: [
        ...(missing.length > 0 ? ["Any tool can reach an allowed host, not only this connector."] : []),
        `${template.label} stays switched off until you switch it on.`,
        ...(template.riskNotes ?? []),
      ].join(" "),
      risk: "danger" as const,
      status: "awaiting_confirmation" as const,
      requiredAction: context.actions.confirmation({ title: `Install ${template.label}`, confirmationText: steps }),
      evidenceRefs: [`mcp_template:${template.templateId}`],
    };
  }

  async apply(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const request = requireRequest(plan);
    let template: McpServerTemplateRecord;
    try {
      template = await this.resolve(request);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      return {
        status: "failed" as const,
        result: { summary: error.message, failureCode: "connector_install_refused" },
      };
    }
    const { readSettings, updateSettings } = this.deps;
    const done: string[] = [];
    let step: InstallStep = "allow";
    let missing: string[] = [];
    try {
      const settings = await readSettings();
      missing = missingHosts(template, settings.networkAllowlist);
      // The allowed list is replaced whole, so the missing hosts are appended to the list as it is now.
      if (missing.length > 0) {
        await updateSettings({
          expectedRevision: settings.revision,
          networkAllowlist: [...settings.networkAllowlist, ...missing],
        });
        done.push(`Allowed ${missing.join(", ")}.`);
      }
      step = "save";
      const created = await this.deps.createMcpServer(createInput(template));
      done.push(`Saved ${template.label}, switched off.`);
      step = "reads_free";
      // The operator who asked for the install, not whoever resumed it, is named in the audit record.
      await this.deps.setReadsFree(created, plan.origin.actorId ?? "operator");
      step = "chat";
      if (request.enableChatConnectors) {
        // Each settings write bumps the revision, so read it again.
        const current = await readSettings();
        if (current.features.chatStaticMcpV1Enabled !== true) {
          await updateSettings({ expectedRevision: current.revision, features: { chatStaticMcpV1Enabled: true } });
          done.push("Let Chat use connectors.");
        }
      }
      return {
        status: "completed" as const,
        evidenceRefs: [...plan.evidenceRefs, `mcp_server:${created.serverId}`],
        result: { summary: done.join(" ") },
      };
    } catch (error) {
      return stopped(template, step, missing, done, error);
    }
  }

  /** Reports what the owners hold after an interruption. It never writes, so an install is never applied twice. */
  async reconcile(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const request = requireRequest(plan);
    const template = this.deps.templates.find((item) => item.templateId === request.templateId);
    if (!template) {
      return {
        effectObserved: false,
        status: "manual_required" as const,
        result: { summary: "The install stopped before it finished.", failureCode: "connector_install_interrupted" },
      };
    }
    const [servers, settings] = await Promise.all([this.deps.readMcpServers(), this.deps.readSettings()]);
    const server = servers.find((item) => mcpServerLabelKey(item.label) === mcpServerLabelKey(template.label));
    const relaxed = server?.policy.approvalPosture === "reads_free";
    const chatReady = !request.enableChatConnectors || settings.features.chatStaticMcpV1Enabled === true;
    if (server && relaxed && chatReady && missingHosts(template, settings.networkAllowlist).length === 0) {
      return {
        effectObserved: true,
        status: "completed" as const,
        evidenceRefs: [...plan.evidenceRefs, `mcp_server:${server.serverId}`],
        result: { summary: `Saved ${template.label}, switched off.` },
      };
    }
    const found = !server
      ? `${template.label} isn't saved.`
      : relaxed
        ? `${template.label} is saved, switched off.`
        : `${template.label} is saved, switched off, and everything it does asks you first.`;
    return {
      effectObserved: false,
      status: "manual_required" as const,
      result: {
        summary: `The install stopped before it finished. ${found}`,
        failureCode: "connector_install_interrupted",
      },
    };
  }

  /** The template, if this install may add it now; otherwise a plain refusal naming the field the client maps. */
  private async resolve(request: ChangePlanConnectorInstallRequest): Promise<McpServerTemplateRecord> {
    const template = this.deps.templates.find((item) => item.templateId === request.templateId);
    if (
      !template ||
      !isVisibleMcpTemplateRecord(template) ||
      EXCLUDED_CONNECTOR_TEMPLATE_IDS.has(template.templateId)
    ) {
      throw refusal("templateId", "This app can't be installed from Capabilities.");
    }
    if (template.authType === "token") {
      throw refusal("needsApiKey", `${template.label} needs an API key. Set it up in Settings.`);
    }
    if (template.authType === "oauth2" && !hasMcpOAuthEndpointSource(template.oauth)) {
      throw refusal("needsSignInSetup", `${template.label}'s sign-in isn't set up yet. Set it up in Settings.`);
    }
    const label = mcpServerLabelKey(template.label);
    if ((await this.deps.readMcpServers()).some((server) => mcpServerLabelKey(server.label) === label)) {
      throw refusal("alreadyInstalled", `${template.label} is already saved.`);
    }
    return template;
  }
}

/** Wires the install to GatewayService's owners, the way the pack adapter and the MCP routes reach them. */
export function connectorInstallDependencies(
  gateway: ConnectorInstallGateway,
  mcpAdministration: mcpServerAdminService.McpServerAdminHost,
): ConnectorInstallDependencies {
  return {
    templates: MCP_SERVER_TEMPLATES,
    readMcpServers: () => gateway.listMcpServers(),
    readSettings: () => gateway.getSettings(),
    updateSettings: (input) => gateway.updateSettings(input),
    createMcpServer: (input) =>
      gateway.storage.runImmediateTransaction(() => mcpServerAdminService.createMcpServer(mcpAdministration, input)),
    setReadsFree: (server, actorId) =>
      mcpServerAdminService.updateMcpServerPolicy(
        mcpAdministration,
        server.serverId,
        { approvalPosture: "reads_free" },
        { expectedRevision: mcpServerRevision(server), actorId },
      ),
  };
}

/** One registration line in GatewayService. */
export function createConnectorInstallChangePlanAdapter(
  gateway: ConnectorInstallGateway,
  mcpAdministration: mcpServerAdminService.McpServerAdminHost,
): ConnectorInstallChangePlanAdapter {
  return new ConnectorInstallChangePlanAdapter(connectorInstallDependencies(gateway, mcpAdministration));
}

/** Only the operator's own Capabilities install route makes this plan; Chat, a model or the generic API can't. */
function requireCapabilitiesOrigin(origin: ChangePlanOrigin): void {
  if (origin.surface !== "capabilities" || origin.sessionId || origin.turnId) {
    throw new PolicyViolationError({
      message: "Connectors are installed from Capabilities.",
      details: { diagnosticCode: "connector_install_untrusted_origin" },
    });
  }
}

function requireRequest(plan: ChangePlanRecord): ChangePlanConnectorInstallRequest {
  if (plan.request.kind !== "connector_install") {
    throw new SemanticValidationError("Expected a connector install request.");
  }
  return plan.request;
}

function refusal(field: string, message: string): ConflictError {
  return new ConflictError({ message, details: { field } });
}

/** The template's hosts the list doesn't cover yet, lower-cased, matched the way the network policy matches them. */
function missingHosts(template: McpServerTemplateRecord, allowlist: readonly string[]): string[] {
  const hosts = [...new Set((template.networkHosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean))];
  return hosts.filter((host) => !isHostAllowlistedInList(host, [...allowlist]));
}

/** The template's own configuration and policy, switched off; "Reading is free" is set by the audited policy write. */
function createInput(template: McpServerTemplateRecord): McpServerCreateInput {
  return {
    label: template.label,
    transport: template.transport,
    command: template.command,
    args: template.args,
    url: template.url,
    authType: template.authType,
    oauth: template.oauth,
    category: template.category,
    trustTier: template.trustTier,
    costTier: template.costTier,
    policy: template.policy,
    enabled: false,
  };
}

/**
 * The outcome when a step fails: one sentence per step that finished, then what didn't. A write that committed before
 * a follow-up failed counts as finished.
 */
function stopped(
  template: McpServerTemplateRecord,
  step: InstallStep,
  missing: readonly string[],
  done: readonly string[],
  error: unknown,
): EvolutionControlPlaneAdapterOutcome {
  const committed = (error as { mutationCommitted?: unknown } | null)?.mutationCommitted === true;
  const committedSentence = {
    allow: missing.length > 0 ? `Allowed ${missing.join(", ")}.` : undefined,
    save: `Saved ${template.label}, switched off.`,
    reads_free: undefined,
    chat: "Let Chat use connectors.",
  }[step];
  const finished = committed && committedSentence ? [...done, committedSentence] : done;
  const failure = committed
    ? "The install stopped before it finished."
    : {
        allow: missing.length > 0 ? `Couldn't allow ${missing.join(", ")}.` : "Couldn't read the allowed hosts.",
        save: `Couldn't save ${template.label}.`,
        reads_free: `Couldn't set ${template.label} to Reading is free, so everything it does asks you first.`,
        chat: "Couldn't let Chat use connectors.",
      }[step];
  const reason = redactSecretText((error instanceof Error ? error.message : "").replace(/\s+/gu, " ").trim()).value;
  return {
    status: finished.length > 0 ? "manual_required" : "failed",
    result: {
      summary: [...finished, failure, reason.slice(0, 300)].filter(Boolean).join(" "),
      failureCode: `connector_install_${step}_failed`,
    },
  };
}
