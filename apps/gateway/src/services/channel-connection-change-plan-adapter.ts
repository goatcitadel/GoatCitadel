import {
  ConflictError,
  NotFoundError,
  SemanticValidationError,
  redactSecretText,
  resolveAllowedSenders,
  type ChangePlanChannelConnectionRequest,
  type ChangePlanPublicFormField,
  type ChangePlanRecord,
  type ChannelSetupDefinition,
  type ChannelSetupDraft,
  type ChannelSetupFinalizeResult,
  type ChannelSetupValidationResult,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneAdapterOutcome,
  EvolutionControlPlaneOwnerInputReceipt,
} from "./evolution-control-plane-adapter.js";
import { CHANNEL_SLACK_OAUTH_METADATA_KEYS } from "./channel-oauth-draft-metadata.js";
import { normalizeSlackTargets, normalizeTelegramTargets } from "./channel-setup-definitions/common.js";

export interface ChannelConnectionChangePlanAdapterDependencies {
  readonly getDefinition: (catalogId: string) => ChannelSetupDefinition;
  readonly createDraft: (input: {
    catalogId: string;
    connectionId?: string;
    lifecycleMode?: "create" | "edit" | "repair" | "rotate_secret" | "retest";
  }) => Promise<ChannelSetupDraft>;
  readonly getDraft: (draftId: string) => Promise<ChannelSetupDraft>;
  readonly updateDraft: (
    draftId: string,
    input: { expectedRevision: number; label?: string; enabled?: boolean; draft?: Record<string, unknown> },
  ) => Promise<ChannelSetupDraft>;
  readonly validateDraft: (draftId: string, expectedRevision: number) => Promise<ChannelSetupValidationResult>;
  readonly finalizeDraft: (draftId: string, expectedRevision: number) => Promise<ChannelSetupFinalizeResult>;
  readonly discardDraft: (draftId: string, expectedRevision: number) => Promise<boolean>;
  readonly getConnection: (connectionId: string) => Promise<IntegrationConnection>;
}

/**
 * Change Plan authority for channel draft -> validate -> live test -> finalize.
 * Credential values remain exclusively in ChannelSecretCustodyService.
 */
export class ChannelConnectionChangePlanAdapter implements EvolutionControlPlaneAdapter<ChangePlanChannelConnectionRequest> {
  public readonly adapterId = "channel-connection";
  public readonly version = 1;
  public readonly kinds = ["channel_connection"] as const;

  public constructor(private readonly deps: ChannelConnectionChangePlanAdapterDependencies) {}

  public async prepare(context: EvolutionControlPlaneAdapterContext, request: ChangePlanChannelConnectionRequest) {
    const catalogId = normalizeCatalogId(request.channelKind);
    const definition = this.deps.getDefinition(catalogId);
    const draft = request.draftId
      ? await this.deps.getDraft(request.draftId)
      : await this.deps.createDraft({ catalogId, lifecycleMode: "create" });
    if (draft.catalogId !== catalogId) {
      throw new ConflictError({ message: "The selected channel draft belongs to a different channel kind." });
    }
    const fields = publicFields(definition, draft);
    const secure = missingSecureFields(definition, draft);
    const settingsReview = context.origin.surface === "settings" && Boolean(request.draftId);
    const requiredAction =
      settingsReview
        ? draft.lastValidatedAt && draft.lastTestedAt
          ? context.actions.confirmation({
              title: `Confirm ${definition.catalog.label} connection`,
              confirmationText: "Review the saved destinations, sender access and latest checks in Channels. Confirm this exact draft for governed validation, live checks and activation.",
            })
          : undefined
        : fields.length > 0
        ? context.actions.publicForm({
            title: `Configure ${definition.catalog.label}`,
            fields,
            submitLabel: "Validate details",
          })
        : secure.length > 0
          ? secureAction(context, definition, draft, secure)
          : context.actions.confirmation({
              title: `Confirm ${definition.catalog.label} connection`,
              confirmationText: "Run the governed live test, then finalize this exact channel draft.",
            });
    return {
      target: targetForDraft(draft),
      title: `Connect ${definition.catalog.label}`,
      summary: settingsReview ? settingsReviewSummary(definition, draft) : `Review the ${definition.catalog.label} setup draft, validate it, and run its registered live checks before finalization.`,
      impact:
        "The live test may contact the channel provider. Credentials remain in OS-keychain custody and a canonical approval is required before finalization.",
      risk: "caution" as const,
      status: !requiredAction ? ("manual_required" as const) : requiredAction.kind === "confirmation" ? ("awaiting_confirmation" as const) : ("awaiting_input" as const),
      requiredAction,
      ...(!requiredAction ? { result: { summary: "Complete and review this exact draft's checks in Channels before preparing its activation plan." } } : {}),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
  }

  public async respond(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
    values: Readonly<Record<string, string | number | boolean>>,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const { definition, draft } = await this.requireCurrentDraft(plan);
    const allowed = new Set(publicFields(definition, draft).map((field) => field.fieldId));
    for (const key of Object.keys(values)) {
      if (!allowed.has(key))
        throw new SemanticValidationError(`Channel setup field ${key} is not registered for this adapter.`);
    }
    const updated = await this.deps.updateDraft(draft.draftId, {
      expectedRevision: draft.revision,
      draft: { ...draft.draft, ...values },
    });
    return await this.nextInputOrConfirmation(context, definition, updated);
  }

  public async resumeOwnerInput(
    context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
    receipt: EvolutionControlPlaneOwnerInputReceipt,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    if (
      receipt.actionKind !== "secure_input" ||
      receipt.ownerId !== "channel_setup_secret" ||
      receipt.ownerResourceId !== plan.target.resourceId ||
      receipt.ownerRevision === undefined
    ) {
      throw new ConflictError({ message: "Channel secure-input receipt does not match this Change Plan." });
    }
    const { definition, draft } = await this.requireCurrentDraft({
      ...plan,
      target: { ...plan.target, expectedRevision: receipt.ownerRevision },
    });
    return await this.nextInputOrConfirmation(context, definition, draft);
  }

  public async apply(
    _context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const { definition, draft } = await this.requireCurrentDraft(plan);
    const finalized = await this.deps.finalizeDraft(draft.draftId, draft.revision);
    return {
      status: "verifying",
      evidenceRefs: [
        `channel-connection:${finalized.connection.connectionId}`,
        `channel-test:${draft.draftId}:${finalized.test?.checkedAt ?? finalized.validation.checkedAt}`,
      ],
      result: {
        summary: `${definition.catalog.label} was live-tested and finalized as ${finalized.connection.label}.`,
        appliedRevision: finalized.draftRevision,
      },
    };
  }

  public async verify(
    _context: EvolutionControlPlaneAdapterContext,
    plan: ChangePlanRecord,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const connectionId = connectionIdFromEvidence(plan.evidenceRefs);
    if (!connectionId) {
      return ambiguousRecovery("The finalized channel connection is missing its owner evidence reference.");
    }
    const connection = await this.deps.getConnection(connectionId);
    if (connection.status !== "connected") {
      return ambiguousRecovery("The channel owner does not report a connected state after finalization.");
    }
    return {
      status: "completed",
      evidenceRefs: [`channel-connection:${connection.connectionId}`],
      result: plan.result ?? { summary: `${connection.label} is connected.` },
    };
  }

  public async reconcile(context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const connectionId = connectionIdFromEvidence(plan.evidenceRefs);
    if (connectionId) {
      try {
        const connection = await this.deps.getConnection(connectionId);
        if (connection.status === "connected") {
          return {
            effectObserved: true,
            status: "completed" as const,
            evidenceRefs: [`channel-connection:${connection.connectionId}`],
            result: plan.result ?? { summary: `${connection.label} is connected.` },
          };
        }
      } catch {
        // Fall through to the fail-closed recovery result.
      }
    }
    try {
      const draft = await this.deps.getDraft(plan.target.resourceId);
      if (plan.status === "staging") {
        return {
          effectObserved: false,
          status: "awaiting_confirmation" as const,
          target: targetForDraft(draft),
          requiredAction: context.actions.confirmation({
            title: "Confirm recovered channel draft",
            confirmationText: "The draft is intact after restart. Run its governed live test and finalize it.",
          }),
          result: { summary: "The channel draft is intact after restart; review and confirm it again." },
        };
      }
    } catch {
      // Intentionally fall through: a missing draft after an interrupted apply is
      // ambiguous without an evidence link and must not be replayed.
    }
    return {
      effectObserved: false,
      ...ambiguousRecovery("Channel finalization could not be proven after restart; it was not replayed."),
    };
  }

  public async discard(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord): Promise<void> {
    const request = requireRequest(plan);
    if (plan.target.ownerId !== "channel_setup_draft" || !Number.isSafeInteger(plan.target.expectedRevision) ||
        (plan.target.expectedRevision ?? 0) < 1) {
      throw new ConflictError({ code: "WRITE_CONFLICT", message: "Cancellation requires the exact reviewed channel draft owner and revision." });
    }
    let draft: ChannelSetupDraft;
    try {
      draft = await this.deps.getDraft(plan.target.resourceId);
    } catch (cause) {
      // Only a missing owner is idempotent. A failed discard or custody cleanup
      // must remain visible rather than recording a fabricated cancellation.
      if (cause instanceof NotFoundError) return;
      throw cause;
    }
    if (draft.revision !== plan.target.expectedRevision || draft.catalogId !== normalizeCatalogId(request.channelKind)) {
      throw new ConflictError({ code: "WRITE_CONFLICT", message: "This draft changed after the plan was reviewed. The newer draft was retained; return to Channels and review it before discarding." });
    }
    await this.deps.discardDraft(draft.draftId, plan.target.expectedRevision);
  }

  private async nextInputOrConfirmation(
    context: EvolutionControlPlaneAdapterContext,
    definition: ChannelSetupDefinition,
    draft: ChannelSetupDraft,
  ): Promise<EvolutionControlPlaneAdapterOutcome> {
    const validation = await this.deps.validateDraft(draft.draftId, draft.revision);
    const validatedDraft = await this.deps.getDraft(draft.draftId);
    const secure = missingSecureFields(definition, validatedDraft);
    const publicErrors = validation.issues.filter(
      (issue) => issue.level === "error" && !isCredentialIssue(issue.fieldKey, definition.adapter.secretFieldKeys),
    );
    if (publicErrors.length > 0) {
      const structuredKeys = new Set(definition.wizard.steps.flatMap((step) => step.fields ?? [])
        .filter((field) => field.type === "target-list" || field.type === "sender-list" || Array.isArray(validatedDraft.draft[field.key]))
        .map((field) => field.key));
      if (publicErrors.some((issue) => issue.fieldKey && structuredKeys.has(issue.fieldKey))) {
        return { status: "manual_required", target: targetForDraft(validatedDraft),
          result: { summary: "Correct the structured destinations or sender access in Channels, then prepare a new review of the saved draft." } };
      }
      return {
        status: "awaiting_input",
        target: targetForDraft(validatedDraft),
        requiredAction: context.actions.publicForm({
          title: `Correct ${definition.catalog.label} details`,
          fields: publicFields(definition, validatedDraft),
          submitLabel: "Validate again",
        }),
        result: {
          summary: publicErrors
            .map((issue) => issue.message)
            .join(" ")
            .slice(0, 2_000),
        },
      };
    }
    if (validation.status === "error" && secure.length > 0) {
      return {
        status: "awaiting_input",
        target: targetForDraft(validatedDraft),
        requiredAction: secureAction(context, definition, validatedDraft, secure),
        result: { summary: "Public channel details are ready. Complete the dedicated secure credential step." },
      };
    }
    if (validation.status === "error") {
      throw new SemanticValidationError(
        validation.issues
          .map((issue) => issue.message)
          .join(" ")
          .slice(0, 2_000),
      );
    }
    return {
      status: "awaiting_confirmation",
      target: targetForDraft(validatedDraft),
      requiredAction: context.actions.confirmation({
        title: `Confirm ${definition.catalog.label} connection`,
        confirmationText: "Run the registered live test and finalize this exact validated draft.",
      }),
      result: { summary: `${definition.catalog.label} inputs passed structural validation.` },
    };
  }

  private async requireCurrentDraft(plan: ChangePlanRecord) {
    const request = requireRequest(plan);
    const definition = this.deps.getDefinition(normalizeCatalogId(request.channelKind));
    const draft = await this.deps.getDraft(plan.target.resourceId);
    if (draft.catalogId !== definition.catalog.catalogId) {
      throw new ConflictError({ message: "The channel draft owner changed kind after this plan was created." });
    }
    if (plan.target.expectedRevision !== undefined && draft.revision !== plan.target.expectedRevision) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "The channel setup draft changed after this Change Plan was reviewed.",
        details: { expectedRevision: plan.target.expectedRevision, actualRevision: draft.revision },
      });
    }
    return { request, definition, draft };
  }
}

/** Only registered public identity/routing values belong in the review receipt. */
function settingsReviewSummary(definition: ChannelSetupDefinition, draft: ChannelSetupDraft): string {
  const clean = (value: unknown): string => typeof value === "string"
    ? // eslint-disable-next-line no-control-regex -- review receipts must replace control characters in operator-supplied text.
      redactSecretText(value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/(?:https?:\/\/|keychain:)[^\s]+/giu, "[private endpoint]")).value.slice(0, 96)
    : "";
  const parts = [`${clean(draft.label) || definition.catalog.label}; ${draft.enabled ? "enabled after approval" : "saved disabled"}; draft revision ${draft.revision}.`];
  const key = definition.catalog.catalogId;
  const targets = key === "channel.slack" ? normalizeSlackTargets(draft.draft)
    : key === "channel.telegram" ? normalizeTelegramTargets(draft.draft) : [];
  if (targets.length) {
    parts.push("Destinations: " + targets.slice(0, 3).map((target) => {
      const address = "channel" in target ? target.channel : target.chatId;
      const thread = "threadTs" in target ? target.threadTs : "threadId" in target ? target.threadId : undefined;
      return `${clean(target.label)} (${clean(address)})${thread ? `, thread ${clean(thread)}` : ""}${target.default ? ", default" : ""}`;
    }).join("; ") + (targets.length > 3 ? `; ${targets.length - 3} more in Channels` : "") + ".");
  } else {
    const fields = definition.wizard.steps.flatMap((step) => step.fields ?? []);
    const destinationKeys = new Set(["channelId", "defaultChannel", "defaultChannelId", "defaultGuildId", "defaultChatId", "defaultRoomId", "defaultTarget", "defaultRecipient", "defaultRecipientId", "defaultHandle", "roomToken", "recipientId", "recipient", "topic", "spaceName", "phoneNumberId"]);
    const destinations = fields.filter((field) => destinationKeys.has(field.key) && !field.sensitive && field.type !== "secret")
      .map((field) => `${field.label}: ${clean(draft.draft[field.key])}`).filter((entry) => !entry.endsWith(": "));
    if (destinations.length) parts.push(destinations.slice(0, 4).join("; ") + ".");
  }
  if (typeof draft.draft.inboundAccessMode === "string") {
    const count = resolveAllowedSenders(draft.draft).length;
    parts.push(`Inbound access: ${draft.draft.inboundAccessMode === "allowlist" ? `allowlist, ${count} allowed sender${count === 1 ? "" : "s"}` : "open legacy access"}.`);
  }
  if (key === "channel.discord") {
    const guilds = draft.draft.guilds && typeof draft.draft.guilds === "object" && !Array.isArray(draft.draft.guilds) ? Object.keys(draft.draft.guilds).length : 0;
    parts.push(`Discord: ${draft.draft.guildPolicy === "off" ? "DM only" : `guild policy ${clean(draft.draft.guildPolicy) || "not selected"}, ${guilds} configured guild rule${guilds === 1 ? "" : "s"}`}; DM policy ${clean(draft.draft.inboundDmPolicy) || "not selected"}.`);
  }
  if (key === "channel.slack" && draft.draft.slackTeamId) {
    parts.push(`Slack workspace: ${clean(draft.draft.slackTeamName)} (${clean(draft.draft.slackTeamId)}); app ${clean(draft.draft.slackAppId)}; bot ${clean(draft.draft.slackBotUserId)}.`);
    const scopes = Array.isArray(draft.draft.slackScopes) ? draft.draft.slackScopes : typeof draft.draft.slackScopes === "string" ? draft.draft.slackScopes.split(",").map((scope) => scope.trim()).filter(Boolean) : [];
    if (scopes.length) parts.push(`Scopes: ${scopes.slice(0, 8).map(clean).join(", ")}${scopes.length > 8 ? "; additional scopes in Channels" : ""}.`);
  }
  for (const [label, timestamp] of [["Validation recorded", draft.lastValidatedAt], ["Live check recorded", draft.lastTestedAt]] as const) {
    if (timestamp && Number.isFinite(Date.parse(timestamp))) parts.push(`${label}: ${new Date(timestamp).toISOString()}.`);
  }
  if (draft.lastFailureCategory) parts.push(`Latest recorded failure: ${clean(draft.lastFailureCategory)}. Activation requires eligible current evidence.`);
  return parts.join(" ").slice(0, 2_000);
}

function publicFields(definition: ChannelSetupDefinition, draft: ChannelSetupDraft): ChangePlanPublicFormField[] {
  const secretKeys = new Set(definition.adapter.secretFieldKeys);
  const seen = new Set<string>();
  const fields: ChangePlanPublicFormField[] = [];
  for (const step of definition.wizard.steps) {
    for (const field of step.fields ?? []) {
      if (seen.has(field.key) || secretKeys.has(field.key) || field.type === "secret" || field.sensitive ||
          field.type === "target-list" || field.type === "sender-list" || field.key === "targets" || Array.isArray(draft.draft[field.key]) ||
          (definition.catalog.catalogId === "channel.slack" && (CHANNEL_SLACK_OAUTH_METADATA_KEYS as readonly string[]).includes(field.key))) continue;
      seen.add(field.key);
      const initial = draft.draft[field.key] ?? field.defaultValue;
      fields.push({
        fieldId: field.key,
        label: field.label,
        type:
          field.type === "boolean"
            ? "boolean"
            : field.type === "select"
              ? "select"
              : field.type === "url"
                ? "url"
                : "text",
        required: field.required,
        description: field.explanation,
        ...(field.options
          ? {
              options: field.options.map((option) => ({
                value: option.value,
                label: option.label,
                ...(option.hint ? { description: option.hint } : {}),
              })),
            }
          : {}),
        ...(typeof initial === "string" || typeof initial === "boolean" || typeof initial === "number"
          ? { initialValue: initial }
          : {}),
        ...(field.key.endsWith("Env") ? { valueSemantic: "environment_reference" as const } : {}),
      });
    }
  }
  return fields;
}

function missingSecureFields(definition: ChannelSetupDefinition, draft: ChannelSetupDraft) {
  const fieldDefinitions = new Map(
    definition.wizard.steps.flatMap((step) => step.fields ?? []).map((field) => [field.key, field] as const),
  );
  return definition.adapter.secretFieldKeys
    .filter((fieldId) => !draft.secretState?.[fieldId]?.configured)
    .map((fieldId) => {
      const field = fieldDefinitions.get(fieldId);
      return {
        fieldId,
        label: field?.label ?? fieldId,
        required: field?.required ?? false,
        description: field?.explanation,
      };
    });
}

function secureAction(
  context: EvolutionControlPlaneAdapterContext,
  definition: ChannelSetupDefinition,
  draft: ChannelSetupDraft,
  fields: ReturnType<typeof missingSecureFields>,
) {
  return context.actions.secureInput({
    targetId: draft.draftId,
    title: `Enter ${definition.catalog.label} credentials`,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    fields,
  });
}

function isCredentialIssue(fieldKey: string | undefined, secretFieldKeys: readonly string[]): boolean {
  if (!fieldKey) return false;
  const normalized = fieldKey.endsWith("Env") ? fieldKey.slice(0, -3) : fieldKey;
  return secretFieldKeys.includes(fieldKey) || secretFieldKeys.includes(normalized);
}

function targetForDraft(draft: ChannelSetupDraft) {
  return { ownerId: "channel_setup_draft", resourceId: draft.draftId, expectedRevision: draft.revision } as const;
}

function normalizeCatalogId(channelKind: string): string {
  const normalized = channelKind.trim();
  return normalized.startsWith("channel.") ? normalized : `channel.${normalized}`;
}

function requireRequest(plan: ChangePlanRecord): ChangePlanChannelConnectionRequest {
  if (plan.request.kind !== "channel_connection") {
    throw new ConflictError({ message: "Change Plan is not a channel connection plan." });
  }
  return plan.request;
}

function connectionIdFromEvidence(evidenceRefs: readonly string[]): string | undefined {
  return evidenceRefs.find((ref) => ref.startsWith("channel-connection:"))?.slice("channel-connection:".length);
}

function ambiguousRecovery(summary: string): EvolutionControlPlaneAdapterOutcome {
  return { status: "manual_required", result: { summary, failureCode: "ambiguous_recovery" } };
}
