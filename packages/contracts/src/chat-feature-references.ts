import { z } from "zod";
import { assertWorkPassportRecord, type WorkPassportRecord } from "./work-passport.js";

const identifier = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const routeTarget = z.object({ providerId: identifier, model: identifier }).strict();
const workPassportRecord = z.custom<WorkPassportRecord>((value) => {
  try {
    assertWorkPassportRecord(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid Work Passport record");
const ownerReference = z.object({ ownerId: identifier, revision: identifier, sha256: digest }).strict();
export const mcpRequesterAdmissionScopeSchema = z
  .object({
    admissionId: identifier,
    sessionIncarnationId: identifier,
    workspaceId: identifier,
    sessionId: identifier,
    turnId: identifier,
    aggregateRevision: z.number().int().nonnegative(),
    controllerGeneration: z.number().int().nonnegative(),
    materialSha256: digest,
    actorId: identifier,
    actorSource: z.enum(["token", "basic", "loopback", "device", "companion"]),
  })
  .strict();

/** Selected, secret-scanned tool evidence only. Endpoint/headers/credentials never enter this receipt. */
export const mcpRequesterAdmissionConnectionSchema = z
  .object({
    version: z.literal("mcp.requester.admission.v1"),
    connectionId: identifier,
    generation: z.number().int().positive(),
    rotationGeneration: z.number().int().nonnegative().optional(),
    schemaHash: digest,
    bindingId: digest,
    scope: mcpRequesterAdmissionScopeSchema,
    serverId: identifier,
    serverConfigRevision: z.number().int().positive(),
    serverConfigSha256: digest,
    transportPolicySha256: digest,
    resolverId: identifier,
    resolverVersion: identifier,
    resolverConfigGeneration: z.number().int().positive(),
    selectedTools: z
      .array(
        z
          .object({
            rawRemoteToolName: identifier,
            canonicalToolName: identifier,
            modelName: z.string().min(1).max(64),
            description: z.string().max(8192).optional(),
            inputSchema: z.record(z.string(), z.unknown()),
            toolDefinitionSha256: digest,
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.selectedTools.map((tool) => tool.canonicalToolName)).size !== value.selectedTools.length ||
      new Set(value.selectedTools.map((tool) => tool.modelName)).size !== value.selectedTools.length ||
      value.selectedTools.some((tool) => tool.canonicalToolName !== `mcp.${value.serverId}.${tool.rawRemoteToolName}`)
    ) {
      context.addIssue({ code: "custom", message: "Requester MCP receipt has ambiguous or mismatched selected tools" });
    }
  });
export type McpRequesterAdmissionScope = z.infer<typeof mcpRequesterAdmissionScopeSchema>;
export type McpRequesterAdmissionConnection = z.infer<typeof mcpRequesterAdmissionConnectionSchema>;
/** Selected static-server evidence. Saved connection material remains with its existing owner. */
export const mcpStaticAdmissionConnectionSchema = z
  .object({
    version: z.literal("mcp.static.admission.v1"),
    scope: mcpRequesterAdmissionScopeSchema,
    serverId: identifier,
    transport: z.enum(["stdio", "http", "sse"]),
    configurationBindingId: identifier,
    connectionRevision: digest,
    serverRevision: digest,
    selectedTools: z
      .array(
        z
          .object({
            rawRemoteToolName: identifier,
            canonicalToolName: identifier,
            modelName: z.string().regex(/^mcp_s_[a-f0-9]{56}$/u),
            description: z.string().max(8192).optional(),
            inputSchema: z.record(z.string(), z.unknown()),
            toolDefinitionSha256: digest,
          })
          .strict(),
      )
      .min(1)
      .max(16),
    bindingSha256: digest,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.selectedTools.map((tool) => tool.canonicalToolName)).size !== value.selectedTools.length ||
      new Set(value.selectedTools.map((tool) => tool.modelName)).size !== value.selectedTools.length ||
      value.selectedTools.some((tool) => tool.canonicalToolName !== `mcp.${value.serverId}.${tool.rawRemoteToolName}`)
    ) {
      context.addIssue({ code: "custom", message: "Static MCP receipt has ambiguous or mismatched selected tools" });
    }
  });
export type McpStaticAdmissionConnection = z.infer<typeof mcpStaticAdmissionConnectionSchema>;
export const chatSelectedMeshCapabilitiesSchema = z
  .object({
    version: z.literal("chat.mesh.admission.v1"),
    scope: mcpRequesterAdmissionScopeSchema,
    selected: z
      .array(
        z
          .object({
            capabilityId: identifier,
            modelName: z.string().min(1).max(64),
            providerDefinitionSha256: digest,
            publication: z
              .object({
                nodeId: identifier,
                publisherGeneration: z.number().int().positive(),
                manifestSha256: digest,
                entrySha256: digest,
                activationId: identifier,
                activationRevision: z.number().int().positive(),
                publicationLeaseFencingToken: z.number().int().positive(),
                permissionEnvelopeSha256: digest,
                effectPosture: z.enum(["none", "read_only", "write_local", "external_side_effect", "unknown"]),
                healthGeneration: z.number().int().positive(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.selected.map((item) => item.capabilityId)).size !== value.selected.length ||
      new Set(value.selected.map((item) => item.modelName)).size !== value.selected.length
    ) {
      context.addIssue({ code: "custom", message: "Duplicate selected mesh capability" });
    }
  });
export type ChatSelectedMeshCapabilities = z.infer<typeof chatSelectedMeshCapabilitiesSchema>;
/** Bounded selected tool evidence for a remote Chat workload; no callable or
 * inspectable catalog is captured, and this never grants tool permission. */
export const chatRemotePlacementSchema = z
  .object({
    version: z.literal("chat.remote-placement.admission.v1"),
    scope: mcpRequesterAdmissionScopeSchema,
    citadelId: identifier,
    operatorId: identifier.optional(),
    contentSha256: digest,
    memoryMode: z.enum(["off", "auto", "on"]),
    runtimeInterposition: z.object({ hash: digest, count: z.number().int().nonnegative() }).strict(),
    permission: z
      .object({
        profileId: identifier,
        approvalMode: z.enum(["approve_all", "approve_risky", "bypass"]),
        profileHash: digest,
        localOperatorOverrideId: identifier.optional(),
        localOperatorOverrideExpiresAt: identifier.optional(),
      })
      .strict(),
    selectedTools: z
      .array(
        z
          .object({
            canonicalName: identifier,
            modelName: z.string().min(1).max(64),
            definitionHash: digest,
            providerDefinition: z.record(z.string(), z.unknown()),
            runtimeOwner: z.object({ kind: z.enum(["builtin", "plugin"]), bindingHash: digest }).strict(),
            effectPotential: z
              .object({
                version: z.literal("goatcitadel.tool-effect.v1"),
                potential: z.enum(["none", "unknown"]),
                sourceKind: z.enum(["builtin", "browser", "shell", "mcp", "plugin", "remote", "unknown"]),
                reason: z.enum([
                  "trusted_builtin_safe_read",
                  "browser_runtime_may_cross_boundary",
                  "shell_runtime_may_mutate",
                  "mcp_runtime_untrusted",
                  "plugin_runtime_untrusted",
                  "remote_runtime_may_cross_boundary",
                  "tool_may_mutate_runtime_state",
                  "untrusted_read_only_hint",
                  "descriptor_incomplete_or_untrusted",
                ]),
              })
              .strict(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.selectedTools.map((tool) => tool.canonicalName)).size !== value.selectedTools.length ||
      new Set(value.selectedTools.map((tool) => tool.modelName)).size !== value.selectedTools.length
    )
      context.addIssue({ code: "custom", message: "Remote placement has ambiguous selected tool evidence" });
  });
export type ChatRemotePlacement = z.infer<typeof chatRemotePlacementSchema>;
const trustedSkill = z
  .object({
    capabilityId: identifier,
    skillId: identifier,
    category: z.enum([
      "built_in",
      "optional",
      "project_local",
      "self_generated",
      "community_imported",
      "mesh_published",
    ]),
    lifecycleState: z.enum(["approved", "trusted"]),
    trustLabel: identifier,
    source: identifier,
    sourceRef: identifier.optional(),
    sourceProvider: identifier.optional(),
    commitSha: identifier.optional(),
    contentIntegrityManifestVersion: z.literal("goatcitadel.skill-tree.v1"),
    treeSha256: digest,
    contentFileCount: z.number().int().nonnegative(),
    contentBytes: z.number().int().nonnegative(),
  })
  .strict();
const selectedSkill = z
  .object({
    capabilityId: identifier,
    skillId: identifier,
    confidence: z.number().min(0).max(1),
    reasons: z.array(identifier).max(32),
    treeSha256: digest,
    instructionSha256: digest,
    instructionBytes: z.number().int().nonnegative(),
    modules: z
      .array(
        z
          .object({
            name: identifier,
            relativePath: identifier.refine(
              (value) => !/^(?:[a-z]:|[\\/])/iu.test(value) && !value.split(/[\\/]/u).includes(".."),
            ),
            sha256: digest,
            bytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();

/** Independent, default-off runtime switches that restore profile-free Chat features. */
export const CHAT_RESTORATION_FEATURE_FLAGS = [
  "chatProviderFallbackV1Enabled",
  "chatSkillInstructionsV1Enabled",
  "boundedToolExposureV1Enabled",
  "scheduledChatTurnsV1Enabled",
  "chatExplicitContextV1Enabled",
  "chatAutomaticFanoutV1Enabled",
  "chatDelegationControlsV1Enabled",
  "proactiveHeartbeatTurnsV1Enabled",
  "commitmentScheduledTurnsV1Enabled",
  "chatMeshCapabilitiesV1Enabled",
  "chatRemotePlacementV1Enabled",
  "chatModelCouncilV1Enabled",
  "chatWorkPassportV1Enabled",
  "chatRequesterMcpV1Enabled",
  "chatStaticMcpV1Enabled",
] as const;

/** Immutable feature evidence. These records never grant callable authority. */
export const chatTurnFeatureReferencesSchema = z
  .object({
    version: z.literal("chat.turn.feature-references.v1"),
    providerRoute: z
      .object({
        primary: routeTarget,
        fallback: routeTarget.extend({ allowLocalToCloud: z.boolean() }).strict().optional(),
        fingerprint: digest,
      })
      .strict()
      .optional(),
    selectedSkills: z
      .object({
        selectionMode: z.enum(["legacy", "shadow", "ranked"]),
        trustedSkills: z.array(trustedSkill).max(32),
        activatedSkills: z.array(selectedSkill).max(32),
        instructionBudgetTokens: z.number().int().positive().max(32_768),
      })
      .strict()
      .superRefine((value, context) => {
        const trusted = new Map(value.trustedSkills.map((skill) => [skill.skillId, skill]));
        if (
          trusted.size !== value.trustedSkills.length ||
          new Set(value.activatedSkills.map((skill) => skill.skillId)).size !== value.activatedSkills.length
        ) {
          context.addIssue({ code: "custom", message: "Duplicate skill reference" });
        }
        for (const selected of value.activatedSkills) {
          const source = trusted.get(selected.skillId);
          if (!source || source.capabilityId !== selected.capabilityId || source.treeSha256 !== selected.treeSha256) {
            context.addIssue({ code: "custom", message: "Selected skill has no exact trusted content reference" });
          }
        }
      })
      .optional(),
    explicitContext: z.object({ snapshotId: identifier, snapshotHash: digest }).strict().optional(),
    /** The operator requested an advisory, tool-free model council for this turn. */
    modelCouncil: z
      .object({ version: z.literal("chat.model-council.admission.v1") })
      .strict()
      .optional(),
    /** Advisory task/review contract classified once at admission; it grants nothing. */
    workPassport: workPassportRecord.optional(),
    childWork: ownerReference.optional(),
    scheduledOccurrence: ownerReference.optional(),
    heartbeatOccurrence: ownerReference.optional(),
    requesterConnections: z
      .array(
        z.union([
          z
            .object({
              connectionId: identifier,
              generation: z.number().int().nonnegative(),
              schemaHash: digest,
              bindingId: identifier,
            })
            .strict(),
          mcpRequesterAdmissionConnectionSchema,
        ]),
      )
      .max(32)
      .optional(),
    selectedStaticMcp: z.array(mcpStaticAdmissionConnectionSchema).min(1).max(4).optional(),
    selectedMeshCapabilities: chatSelectedMeshCapabilitiesSchema.optional(),
    remotePlacement: z.union([ownerReference, chatRemotePlacementSchema]).optional(),
  })
  .strict();

export type ChatTurnFeatureReferences = z.infer<typeof chatTurnFeatureReferencesSchema>;

/** Strict decoding rejects raw content, client authority fields and future versions. */
export function readChatTurnFeatureReferences(value: unknown): ChatTurnFeatureReferences {
  const parsed = chatTurnFeatureReferencesSchema.parse(value);
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > 65_536) {
    throw new Error("Chat feature references exceed the 64 KiB evidence limit");
  }
  return parsed;
}
