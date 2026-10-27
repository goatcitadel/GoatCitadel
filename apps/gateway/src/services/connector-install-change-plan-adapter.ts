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

/** The install's steps in order; a failure's `failureCode` names the one it stopped at. */
type InstallStep = "allowlist" | "save" | "posture" | "chat_flag";

/** What the owners hold for a template now. */
interface InstallObservation {
  /** The saved server paired with the template by label, ignoring case. */
  readonly server: McpServerRecord | undefined;
  readonly relaxed: boolean;
  /** The template's hosts the allowed list doesn't cover. */
  readonly missing: readonly string[];
  readonly chatOn: boolean;
}

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
    let step: InstallStep = "allowlist";
    let pending: readonly string[] = [];
    let allowed: readonly string[] = [];
    try {
      const settings = await readSettings();
      pending = missingHosts(template, settings.networkAllowlist);
      // The allowed list is replaced whole, so the missing hosts are appended to the list as it is now.
      if (pending.length > 0) {
        await updateSettings({
          expectedRevision: settings.revision,
          networkAllowlist: [...settings.networkAllowlist, ...pending],
        });
        allowed = pending;
      }
      step = "save";
      const created = await this.deps.createMcpServer(createInput(template));
      step = "posture";
      // The operator who asked for the install, not whoever resumed it, is named in the audit record.
      await this.deps.setReadsFree(created, plan.origin.actorId ?? "operator");
      step = "chat_flag";
      let chatTurnedOn = false;
      if (request.enableChatConnectors) {
        // Each settings write bumps the revision, so read it again.
        const current = await readSettings();
        if (current.features.chatStaticMcpV1Enabled !== true) {
          await updateSettings({ expectedRevision: current.revision, features: { chatStaticMcpV1Enabled: true } });
          chatTurnedOn = true;
        }
      }
      return {
        status: "completed" as const,
        evidenceRefs: [...plan.evidenceRefs, `mcp_server:${created.serverId}`],
        result: { summary: finishedSentences(template, allowed, true, chatTurnedOn).join(" ") },
      };
    } catch (error) {
      // Nothing was written before the allowed-host write landed. After it, what the owners hold decides the summary:
      // a save can report a failed follow-up after it landed, or be rolled back with its transaction.
      const observed =
        step === "allowlist"
          ? undefined
          : await this.observe(template).catch(() => undefined /* the step tracker stands in */);
      return stopped({ template, request, step, pending, allowed, observed, error });
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
    const { server, relaxed, missing, chatOn } = await this.observe(template);
    if (server && relaxed && (!request.enableChatConnectors || chatOn) && missing.length === 0) {
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

  private async observe(template: McpServerTemplateRecord): Promise<InstallObservation> {
    const [servers, settings] = await Promise.all([this.deps.readMcpServers(), this.deps.readSettings()]);
    const server = servers.find((item) => mcpServerLabelKey(item.label) === mcpServerLabelKey(template.label));
    return {
      server,
      relaxed: server?.policy.approvalPosture === "reads_free",
      missing: missingHosts(template, settings.networkAllowlist),
      chatOn: settings.features.chatStaticMcpV1Enabled === true,
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

/** One plain sentence per finished step (R66). */
function finishedSentences(
  template: McpServerTemplateRecord,
  allowed: readonly string[],
  saved: boolean,
  chatTurnedOn: boolean,
): string[] {
  return [
    ...(allowed.length > 0 ? [`Allowed ${allowed.join(", ")}.`] : []),
    ...(saved ? [`Saved ${template.label}, switched off.`] : []),
    ...(chatTurnedOn ? ["Let Chat use connectors."] : []),
  ];
}

/**
 * The outcome when a step fails (R79): the summary is plain sentences only, one per finished step and then what didn't
 * happen and what to do next. The owner's own error text goes to `failureDetail`, for technical details only.
 */
function stopped(input: {
  readonly template: McpServerTemplateRecord;
  readonly request: ChangePlanConnectorInstallRequest;
  readonly step: InstallStep;
  readonly pending: readonly string[];
  readonly allowed: readonly string[];
  readonly observed: InstallObservation | undefined;
  readonly error: unknown;
}): EvolutionControlPlaneAdapterOutcome {
  const { template, step, observed } = input;
  // Without a fresh read, a step counts as done once the next one started.
  const held = {
    saved: observed ? observed.server !== undefined : step === "posture" || step === "chat_flag",
    relaxed: observed ? observed.relaxed : step === "chat_flag",
    chatMissing: input.request.enableChatConnectors && observed?.chatOn !== true,
  };
  const finished = finishedSentences(template, input.allowed, held.saved, false);
  const detail = failureDetail(input.error);
  return {
    status: finished.length > 0 ? "manual_required" : "failed",
    result: {
      summary: [...finished, whatsLeft(template.label, step, input.pending, held)].join(" "),
      failureCode: `connector_install_${step}_failed`,
      ...(detail ? { failureDetail: detail } : {}),
    },
  };
}

/** What didn't happen and what to do next, from what the owners hold once the install stopped. */
function whatsLeft(
  label: string,
  step: InstallStep,
  pending: readonly string[],
  held: { readonly saved: boolean; readonly relaxed: boolean; readonly chatMissing: boolean },
): string {
  if (step === "allowlist") {
    const failed = pending.length > 0 ? `Couldn't allow ${pending.join(", ")}.` : "Couldn't read the allowed hosts.";
    return `${failed} Nothing was changed, so trying again is safe.`;
  }
  // Trying again skips the hosts already allowed, and nothing else was saved.
  if (!held.saved) return `Couldn't save ${label}. Trying again is safe.`;
  // It is saved now, so installing again would refuse: the setting is changed in its panel instead.
  if (!held.relaxed) {
    return (
      `Couldn't set ${label} to Reading is free, so everything it does asks you first. ` +
      "You can choose Reading is free under What asks first in its panel."
    );
  }
  if (held.chatMissing) {
    return `Couldn't let Chat use connectors, so Chat can't use ${label} yet. Its panel links to Chat access in Settings.`;
  }
  return `${label} is installed, but its last step reported a problem. Check it in its panel.`;
}

/** The error's own message on one line, redacted and bounded, or nothing when it carries none. */
function failureDetail(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message.replace(/[\s\p{Cc}]+/gu, " ").trim() : "";
  const detail = redactSecretText(message).value.slice(0, 300).trim();
  return detail || undefined;
}
