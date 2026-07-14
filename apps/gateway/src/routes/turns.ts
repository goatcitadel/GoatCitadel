import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelUsageAttributionContext,
} from "@goatcitadel/contracts";

import { sendRouteError } from "./_error-handler.js";

// Inbound turn-completion contract for MatterGoat (the collaboration room) routing
// one agent turn to GoatCitadel (the runtime brain). The wire shape mirrors the
// MatterGoat hand-off spec — see the MatterGoat repo,
// docs/goatcitadel-integration-requests.md (Phase 1). Fields are snake_case to
// match that JSON contract.
const turnMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  author_ref: z.string().optional(),
  message: z.string(),
  file_ids: z.array(z.string()).optional(),
});

const turnCompleteSchema = z.object({
  session_id: z.string().min(1),
  turn_id: z.string().min(1),
  agent_ref: z.string().min(1),
  operation: z.string().optional(),
  user_ref: z.string().optional(),
  channel_ref: z.string().optional(),
  messages: z.array(turnMessageSchema).min(1),
});

const DEFAULT_WORKSPACE_ID = "default";

// Protocol markers a MatterGoat agent emits inline (e.g. <<MG:FINAL_SYNTHESIS:...>>).
// GoatCitadel parses them out of the model's OWN (trusted, just-generated) output
// and returns them structurally, so MatterGoat never trusts markers parsed from
// untrusted prior-turn message text.
const MG_MARKER_RE = /<<MG:([A-Z_]+)(?::[^>]*)?>>/g;

function parseMarkers(text: string): string[] {
  const markers: string[] = [];
  for (const match of text.matchAll(MG_MARKER_RE)) {
    const name = match[1];
    if (name) {
      markers.push(name);
    }
  }
  return markers;
}

// Extract the text under a "### <heading>" markdown section.
function extractSection(text: string, heading: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let capturing = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      if (capturing) {
        break;
      }
      if (trimmed.toLowerCase().includes(heading.toLowerCase())) {
        capturing = true;
        continue;
      }
    }
    if (capturing) {
      out.push(line);
    }
  }
  return out.join("\n").trim();
}

function needsApproval(text: string): boolean {
  const section = extractSection(text, "Approval Needed").toLowerCase();
  if (!section) {
    return false;
  }
  return section.includes("yes") || section.includes("required") || section.includes("approval needed");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface ResolvedAgentPreset {
  providerId?: string;
  model?: string;
  promptFraming?: string;
}

// resolveAgentPreset maps agent_ref onto the GoatCitadel agent's preset so the
// turn runs AS that agent — its preferred provider/model and persona framing.
// Returns null when agent_ref does not resolve: an advisory turn must not fail
// just because the agent isn't registered, so it falls back to the gateway default.
function resolveAgentPreset(fastify: FastifyInstance, agentRef: string): ResolvedAgentPreset | null {
  try {
    const preset = fastify.services.agents.getAgent(agentRef).presetDefaults;
    if (!preset) {
      return null;
    }
    return {
      providerId: preset.preferredProviderId,
      model: preset.preferredModel,
      promptFraming: preset.promptFraming,
    };
  } catch {
    return null;
  }
}

export const turnsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/v1/turns/complete — run one MatterGoat agent turn.
  //
  // Phase 1 is a STATELESS, advisory completion: the provided messages are the
  // full allowed context (GoatCitadel fetches nothing extra), no tools run, and
  // no side effects occur. Operator bearer auth and automatic Idempotency-Key
  // dedup are applied by the gateway to all /api/v1 routes.
  fastify.post("/api/v1/turns/complete", async (request, reply) => {
    const parsed = turnCompleteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const body = parsed.data;

    // Run the turn AS the referenced agent: its preferred provider/model and its
    // persona framing. An unknown agent_ref falls back to the gateway default.
    const preset = resolveAgentPreset(fastify, body.agent_ref);

    // Map the turn messages to a provider completion. author_ref is accepted for
    // attribution but not forwarded to the model (speaker context already rides
    // in the message text); it is available for future provenance/audit use.
    const messages: ChatCompletionMessage[] = [];
    if (preset?.promptFraming) {
      messages.push({ role: "system", content: preset.promptFraming });
    }
    for (const m of body.messages) {
      messages.push({ role: m.role, content: m.message });
    }

    const completionRequest: ChatCompletionRequest = { messages };
    if (preset?.providerId) {
      completionRequest.providerId = preset.providerId;
    }
    if (preset?.model) {
      completionRequest.model = preset.model;
    }

    try {
      const usageAttribution: ModelUsageAttributionContext = {
        operationId: `mattergoat:${body.session_id}:${body.turn_id}:${body.agent_ref}`,
        dispatchGeneration: `mattergoat-turn:${body.turn_id}`,
        callKind: "delegation_worker",
        workspaceId: DEFAULT_WORKSPACE_ID,
        sessionId: body.session_id,
        turnId: body.turn_id,
        taskId: `mattergoat:${body.operation?.trim() || "turn_complete"}:${body.turn_id}`,
        agentId: body.agent_ref,
        workerId: body.agent_ref,
      };
      const result: ChatCompletionResponse = await fastify.services.llm.createChatCompletion(
        completionRequest,
        usageAttribution,
      );

      const message = asString(result.choices?.[0]?.message?.content);
      const usage = result.usage ?? {};

      return reply.send({
        message,
        // Structured, authoritative protocol signals parsed from the model's own output.
        markers: parseMarkers(message),
        needs_approval: needsApproval(message),
        // Provenance.
        provider: result.routing?.effectiveProviderId ?? result.routing?.primaryProviderId ?? "",
        model: result.routing?.effectiveModel ?? result.model ?? "",
        run_id: randomUUID(),
        usage: {
          input_tokens: asNumber(usage.prompt_tokens ?? usage.input_tokens),
          output_tokens: asNumber(usage.completion_tokens ?? usage.output_tokens),
        },
      });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
