import {
  buildRunVariableEvidence,
  resolveLegacyRunVariableTemplate,
  resolveRunVariableTemplate,
  validateRunVariableBindings,
  type ChatSendMessageRequest,
  type RunTemplateInvocation,
  type RunVariableSchema,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

export function resolveChatRunVariableRequest(
  storage: Storage,
  sessionId: string,
  input: ChatSendMessageRequest,
): ChatSendMessageRequest {
  const invocation = input.templateInvocation;
  if (!invocation) return input;
  const owner = resolveOwner(storage, invocation);
  if (owner.revision !== invocation.ownerRevision) throw new TypeError("Template changed; reopen the variable form.");
  const validation = validateRunVariableBindings(owner.schema, invocation.values);
  if (validation.schemaHash !== invocation.schemaHash)
    throw new TypeError("Run-variable schema changed; reopen the form.");

  const templated = resolveRunVariableTemplate(owner.template, owner.schema, validation.bindings);
  const resolvedInput = resolveLegacyRunVariableTemplate(templated, owner.schema, validation.bindings).trim();
  if (input.content !== resolvedInput) throw new TypeError("Resolved template preview is stale or forged.");

  const evidence = buildRunVariableEvidence(invocation, owner.schema, resolvedInput);
  storage.chatSessionRunVariables.upsert({
    sessionId,
    ownerKind: invocation.ownerKind,
    ownerId: invocation.ownerId,
    ownerRevision: invocation.ownerRevision,
    schemaHash: invocation.schemaHash,
    bindings: evidence.bindings,
  });
  return { ...input, content: resolvedInput, runVariableEvidence: evidence };
}

function resolveOwner(
  storage: Storage,
  invocation: RunTemplateInvocation,
): { revision: string; schema: RunVariableSchema; template: string } {
  if (invocation.ownerKind === "prompt_pack") {
    if (!invocation.templateId) throw new TypeError("Prompt-pack template invocation requires a test id.");
    const pack = storage.promptPacks.getPack(invocation.ownerId);
    const test = storage.promptPacks.getTest(invocation.templateId);
    if (test.packId !== pack.packId) throw new TypeError("Prompt-pack template does not belong to its declared owner.");
    if (!pack.runVariableSchema) throw new TypeError("Prompt pack has no run-variable schema.");
    return { revision: pack.updatedAt, schema: pack.runVariableSchema, template: test.prompt };
  }
  const agent = storage.agentProfiles.get(invocation.ownerId);
  if (agent.lifecycleStatus !== "active") throw new TypeError("Agent preset is not active.");
  const schema = agent.presetDefaults?.runVariableSchema;
  const template = agent.presetDefaults?.promptFraming;
  if (!schema || !template) throw new TypeError("Agent preset has no variable template.");
  return { revision: agent.updatedAt, schema, template };
}
