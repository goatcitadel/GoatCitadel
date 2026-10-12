import { randomUUID } from "node:crypto";
import type {
  ChatArtifactCritiqueResponse,
  ChatArtifactRenderResponse,
  ChatGeneratedArtifactRecord,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  RoutingPreflightRequest,
  RoutingPreflightResult,
} from "@goatcitadel/contracts";
import { trackBackgroundTask } from "./background-scheduler.js";

/**
 * Dispatches an `@skill impeccable critique` turn into the artifact's session. The turn carries
 * the artifact as routed context, the offline PNG renders as image attachments when the effective
 * provider can inspect images, and a text-only marker otherwise. The route answers as soon as the
 * turn is admitted; the report arrives as that turn's reply like any other Chat turn.
 */

export interface ArtifactCritiqueActor {
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ChatSendMessageRequest["authActorSource"];
}

export interface ArtifactCritiqueTurnIdentity {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export interface HtmlArtifactCritiqueDependencies {
  getChatGeneratedArtifact(artifactId: string, options: { workspaceId: string }): Promise<ChatGeneratedArtifactRecord>;
  renderChatGeneratedArtifact(artifactId: string, workspaceId: string): Promise<ChatArtifactRenderResponse>;
  routePreflight(sessionId: string, input: RoutingPreflightRequest): Promise<RoutingPreflightResult>;
  providerSupportsVision(providerId: string): boolean;
  sendChatTurn(
    sessionId: string,
    input: ChatSendMessageRequest,
    turnIdentity: ArtifactCritiqueTurnIdentity,
    authenticatedOperator?: unknown,
  ): Promise<ChatSendMessageResponse>;
  /** Owned background promises; the dispatched turn is tracked here until it settles. */
  backgroundTasks: Set<Promise<unknown>>;
  log: { warn(message: string, context?: Record<string, unknown>): void };
}

const DESKTOP_VIEWPORT = "desktop (1440×900)";
const PHONE_VIEWPORT = "phone (390×844)";
const MAX_LABEL_LENGTH = 120;

export async function critiqueChatGeneratedArtifact(
  deps: HtmlArtifactCritiqueDependencies,
  artifactId: string,
  workspaceId: string,
  actor: ArtifactCritiqueActor,
  authenticatedOperator?: unknown,
): Promise<ChatArtifactCritiqueResponse> {
  // Rendering validates the artifact (html, non-redacted, workspace-bound) and is idempotent per hash.
  const rendered = await deps.renderChatGeneratedArtifact(artifactId, workspaceId);
  const artifact = await deps.getChatGeneratedArtifact(artifactId.trim(), { workspaceId: workspaceId.trim() });
  const preflight = await deps.routePreflight(artifact.sessionId, {
    action: "send",
    content: `@skill impeccable critique ${artifact.title}`,
    operatorId: actor.operatorId,
    authActorId: actor.authActorId,
    authActorSource: actor.authActorSource,
  });
  const effectiveProviderId = preflight.effectiveProviderId;
  const visuallyInspected = Boolean(effectiveProviderId && deps.providerSupportsVision(effectiveProviderId));
  const content = buildArtifactCritiquePrompt({ artifact, visuallyInspected, effectiveProviderId });
  const turnIdentity: ArtifactCritiqueTurnIdentity = {
    turnId: randomUUID(),
    userMessageId: randomUUID(),
    assistantMessageId: `assistant-${randomUUID()}`,
  };
  const request: ChatSendMessageRequest = {
    content,
    mode: "chat",
    // Routed context pins the frozen provider/model route and cannot be delegated.
    subagentPolicy: "off",
    contextRefs: [
      {
        kind: "generated_artifact",
        ref: artifact.artifactId,
        ...(artifact.title.trim() ? { label: artifact.title.trim().slice(0, MAX_LABEL_LENGTH) } : {}),
      },
    ],
    ...(visuallyInspected ? { attachments: rendered.renders.map((render) => render.attachmentId) } : {}),
    providerId: preflight.effectiveProviderId,
    model: preflight.effectiveModel,
    routeDecision: preflight.decision,
    operatorId: actor.operatorId,
    authActorId: actor.authActorId,
    authActorSource: actor.authActorSource,
  };

  const task = deps.sendChatTurn(artifact.sessionId, request, turnIdentity, authenticatedOperator).then(
    () => undefined,
    (error: unknown) => {
      deps.log.warn("artifact critique turn failed", {
        artifactId: artifact.artifactId,
        sessionId: artifact.sessionId,
        turnId: turnIdentity.turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  trackBackgroundTask(deps.backgroundTasks, task);

  return {
    sessionId: artifact.sessionId,
    turnId: turnIdentity.turnId,
    visuallyInspected,
    renders: rendered.renders,
  };
}

/** The operator-facing critique request; it names the artifact but never embeds its markup. */
export function buildArtifactCritiquePrompt(input: {
  artifact: Pick<ChatGeneratedArtifactRecord, "artifactId" | "title" | "version" | "designAdvisories">;
  visuallyInspected: boolean;
  effectiveProviderId?: string;
}): string {
  const { artifact } = input;
  const advisories = artifact.designAdvisories ?? [];
  const evidence = input.visuallyInspected
    ? `Render evidence: offline PNG snapshots at ${DESKTOP_VIEWPORT} and ${PHONE_VIEWPORT} are attached as images.`
    : `Render evidence unavailable: the effective provider "${input.effectiveProviderId ?? "unknown"}" cannot inspect images, so this is a text-only critique of the markup; say so in the report header.`;
  const advisoryLine =
    advisories.length === 0
      ? "The artifact carries no runtime design advisories."
      : `${advisories.length} runtime design advisor${advisories.length === 1 ? "y" : "ies"} recorded on the artifact: ${advisories
          .map((advisory) => `${advisory.ruleId} (line ${advisory.line}): ${advisory.summary}`)
          .join("; ")}.`;
  return [
    `@skill impeccable critique the generated HTML artifact "${artifact.title}" (artifact ${artifact.artifactId}, version ${artifact.version}).`,
    `The artifact markup is attached as routed context; critique that document, not the conversation.`,
    evidence,
    advisoryLine,
    "Produce the full critique report, then ask the targeted questions.",
  ].join("\n");
}
