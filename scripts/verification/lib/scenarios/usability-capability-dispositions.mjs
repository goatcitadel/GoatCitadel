import path from "node:path";

import { buildUsabilityRouteActionInventory } from "./usability-coverage.mjs";

const FILE_FIXTURE_ROOT = "capability-probe";
const FILE_FIXTURE_ALPHA = "alpha\nneedle-one\nomega\n";
const FILE_FIXTURE_CODE = 'export const capabilityNeedle = "needle-two";\n';
const KNOWLEDGE_NAMESPACE = "capability-probe";
const KNOWLEDGE_NEEDLE = "CAPABILITY_KNOWLEDGE_NEEDLE_20260729";
const KNOWLEDGE_SOURCE = `${KNOWLEDGE_NEEDLE} proves attributed local knowledge retrieval.`;
const CITATION_FIXTURE = Object.freeze({
  citationId: "fixture-1",
  title: "Fixture source",
  url: "https://fixture.example.invalid/source",
  snippet: "Deterministic citation",
});

const SAFE_CONTRACT_PROBES = new Map([
  ["tool:session.status", directProbe("session.status", () => ({}), validateSessionStatusResult)],
  ["tool:time.now", directProbe("time.now", () => ({}), validateTimeNowResult)],
  [
    "tool:fs.read",
    directProbe(
      "fs.read",
      (fixture) => ({ path: fixture.alphaPath }),
      (result, context) => validateWholeFileResult(result, context, FILE_FIXTURE_ALPHA),
    ),
  ],
  [
    "tool:file.read_range",
    directProbe(
      "file.read_range",
      (fixture) => ({ path: fixture.alphaPath, startLine: 2, endLine: 3 }),
      validateFileRangeResult,
    ),
  ],
  [
    "tool:file.find",
    directProbe(
      "file.find",
      (fixture) => ({ path: fixture.fileRoot, pattern: "needle-one", caseSensitive: true, limit: 10 }),
      validateFileFindResult,
    ),
  ],
  [
    "tool:code.search",
    directProbe(
      "code.search",
      (fixture) => ({ path: fixture.fileRoot, query: "capabilityNeedle", caseSensitive: true, limit: 10 }),
      validateCodeSearchResult,
    ),
  ],
  [
    "tool:code.search_files",
    directProbe(
      "code.search_files",
      (fixture) => ({ path: fixture.fileRoot, query: "example.ts", caseSensitive: true, limit: 10 }),
      validateCodeSearchFilesResult,
    ),
  ],
  ["tool:fs.list", directProbe("fs.list", (fixture) => ({ path: fixture.fileRoot }), validateFileListResult)],
  ["tool:fs.stat", directProbe("fs.stat", (fixture) => ({ path: fixture.alphaPath }), validateFileStatResult)],
  [
    "tool:docs.ingest",
    directProbe(
      "docs.ingest",
      () => ({
        sourceType: "text",
        source: KNOWLEDGE_SOURCE,
        namespace: KNOWLEDGE_NAMESPACE,
        title: "Capability knowledge fixture",
        backend: "native",
        forceRefresh: true,
      }),
      validateDocsIngestResult,
    ),
  ],
  [
    "tool:memory.read",
    directProbe(
      "memory.read",
      () => ({ namespace: KNOWLEDGE_NAMESPACE, query: KNOWLEDGE_NEEDLE, limit: 5 }),
      validateMemoryReadResult,
    ),
  ],
  [
    "tool:memory.search",
    directProbe(
      "memory.search",
      () => ({ namespace: KNOWLEDGE_NAMESPACE, query: KNOWLEDGE_NEEDLE, limit: 5 }),
      validateMemorySearchResult,
    ),
  ],
  [
    "tool:docs.search",
    directProbe(
      "docs.search",
      () => ({ namespace: KNOWLEDGE_NAMESPACE, query: KNOWLEDGE_NEEDLE, limit: 5 }),
      validateDocsSearchResult,
    ),
  ],
  [
    "tool:embeddings.index",
    directProbe(
      "embeddings.index",
      (fixture) => ({ namespace: KNOWLEDGE_NAMESPACE, documentId: fixture.knowledgeDocId }),
      validateEmbeddingsIndexResult,
    ),
  ],
  [
    "tool:embeddings.query",
    directProbe(
      "embeddings.query",
      () => ({ namespace: KNOWLEDGE_NAMESPACE, query: KNOWLEDGE_NEEDLE, limit: 5 }),
      validateEmbeddingsQueryResult,
    ),
  ],
  [
    "tool:citations.build",
    directProbe("citations.build", () => ({ sources: [CITATION_FIXTURE] }), validateCitationsResult),
  ],
]);

const SAFE_PROBE_ORDER = new Map([...SAFE_CONTRACT_PROBES.keys()].map((capabilityId, index) => [capabilityId, index]));

const NAMED_TOOL_PROOFS = new Map([
  ["notify.request", ["route.ops-notifications.notification-test-and-operator-policy"]],
  ["document.propose_patch", ["route.chat.code-mode-artifacts", "route.library-notes.note-crud-and-conflict"]],
  ["context.list", ["route.chat.attachments-citations-tools"]],
  ["context.grep", ["route.chat.attachments-citations-tools"]],
  ["context.query", ["route.chat.attachments-citations-tools"]],
  ["context.read_range", ["route.chat.attachments-citations-tools"]],
  ["submit_work_result", ["route.chat.planning-delegation-synthesis"]],
  ["agent.fanout", ["route.chat.planning-delegation-synthesis"]],
  ["fs.write", ["route.library-files.file-list-upload-download", "route.chat.code-mode-artifacts"]],
  ["fs.copy", ["route.library-files.file-list-upload-download"]],
  ["fs.move", ["route.library-files.file-list-upload-download"]],
  ["fs.delete", ["route.library-files.file-list-upload-download"]],
  ["shell.exec", ["route.chat.code-mode-artifacts"]],
  ["shell.exec_background", ["route.chat.code-mode-artifacts"]],
  ["git.exec", ["route.chat.code-mode-artifacts"]],
  ["git.status", ["route.chat.code-mode-artifacts"]],
  ["git.diff", ["route.chat.code-mode-artifacts"]],
  ["git.add", ["route.chat.code-mode-artifacts"]],
  ["git.commit", ["route.chat.code-mode-artifacts"]],
  ["git.branch.create", ["route.chat.code-mode-artifacts"]],
  ["git.branch.switch", ["route.chat.code-mode-artifacts"]],
  ["git.worktree.create", ["route.chat.code-mode-artifacts"]],
  ["git.worktree.remove", ["route.chat.code-mode-artifacts"]],
  ["tests.run", ["route.chat.code-mode-artifacts"]],
  ["lint.run", ["route.chat.code-mode-artifacts"]],
  ["build.run", ["route.chat.code-mode-artifacts"]],
  ["schedule.manage", ["route.ops-schedules.schedule-create-list-cancel-and-run"]],
  ["memory.write", ["route.library-memory.memory-edit-pin-forget-history"]],
  ["memory.upsert", ["route.library-memory.memory-edit-pin-forget-history"]],
  ["artifacts.create", ["route.chat.code-mode-artifacts", "route.library-artifacts.artifact-list-detail-download"]],
  ["documents.create", ["route.library-artifacts.artifact-list-detail-download"]],
  ["presentations.create", ["route.library-artifacts.artifact-list-detail-download"]],
]);

export const CAPABILITY_DISPOSITIONS = Object.freeze({
  SAFE_CONTRACT_PROBE: "safe_contract_probe",
  SKILL_ACTIVATION_CONTRACT: "skill_activation_contract",
  NAMED_JOURNEY_PROOF: "named_journey_proof",
  CATALOG_ONLY_DENIED: "catalog_only_denied",
  EXPLICIT_NON_EXECUTED_LIMITATION: "explicit_non_executed_limitation",
});

/**
 * Converts every live catalog item into independently checked execution or
 * governance evidence. Catalog membership alone is never a passing proof.
 */
export async function probeLiveCapabilityDispositions(input) {
  const inspectable = requireCapabilityArray(input.capabilityCatalog?.inspectable, "inspectable");
  const callable = requireCapabilityArray(input.capabilityCatalog?.callable, "callable");
  const callableIds = new Set(callable.map((item) => item.capabilityId));
  const callableToolNames = new Set(callable.filter((item) => item.kind === "tool").map((item) => item.toolName));
  const rows = [];
  const fixture = await prepareDirectProbeFixture(input);
  const namedProofIndex = buildRequiredNamedProofIndex(input.baseSha);
  const ordered = [...inspectable].sort(
    (left, right) =>
      (SAFE_PROBE_ORDER.get(left.capabilityId) ?? Number.MAX_SAFE_INTEGER) -
      (SAFE_PROBE_ORDER.get(right.capabilityId) ?? Number.MAX_SAFE_INTEGER),
  );

  for (const item of ordered) {
    const callableItem = callableIds.has(item.capabilityId);
    const disposition = classifyCapabilityDisposition(item, callableItem);
    rows.push(
      await probeCapabilityDisposition({
        ...input,
        callableToolNames,
        namedProofIndex,
        disposition,
        fixture,
        item,
        callable: callableItem,
      }),
    );
  }

  const expectedIds = new Set(inspectable.map((item) => item.capabilityId));
  assertExactDispositionSet(rows, expectedIds, input.baseSha);
  return rows;
}

export function classifyCapabilityDisposition(item, callable) {
  if (!callable) return CAPABILITY_DISPOSITIONS.CATALOG_ONLY_DENIED;
  if (SAFE_CONTRACT_PROBES.has(item.capabilityId)) return CAPABILITY_DISPOSITIONS.SAFE_CONTRACT_PROBE;
  if (item.kind === "skill") return CAPABILITY_DISPOSITIONS.SKILL_ACTIVATION_CONTRACT;
  if (item.kind === "tool" && NAMED_TOOL_PROOFS.has(item.toolName)) return CAPABILITY_DISPOSITIONS.NAMED_JOURNEY_PROOF;
  return CAPABILITY_DISPOSITIONS.EXPLICIT_NON_EXECUTED_LIMITATION;
}

async function probeCapabilityDisposition(input) {
  switch (input.disposition) {
    case CAPABILITY_DISPOSITIONS.SAFE_CONTRACT_PROBE:
      return await probeSafeContract(input);
    case CAPABILITY_DISPOSITIONS.SKILL_ACTIVATION_CONTRACT:
      return await probeSkillActivationContract(input);
    case CAPABILITY_DISPOSITIONS.NAMED_JOURNEY_PROOF:
      return await probeNamedJourneyContract(input);
    case CAPABILITY_DISPOSITIONS.CATALOG_ONLY_DENIED:
      return await probeCatalogOnlyDenial(input);
    case CAPABILITY_DISPOSITIONS.EXPLICIT_NON_EXECUTED_LIMITATION:
      return await probeExplicitLimitation(input);
    default:
      throw new Error(`unsupported capability disposition ${input.disposition}`);
  }
}

async function probeSafeContract(input) {
  const probe = SAFE_CONTRACT_PROBES.get(input.item.capabilityId);
  if (!probe) throw new Error(`safe probe missing for ${input.item.capabilityId}`);
  const profile = await checkedRequest(
    input,
    "/api/v1/tools/permission-profiles",
    {
      method: "POST",
      body: {
        label: "Usability deterministic safe capability probe",
        description: "Isolated fixture profile for one deterministic contract invocation.",
        scope: "workspace",
        scopeRef: input.workspaceId,
        approvalMode: "approve_risky",
        toolPatterns: [probe.toolName],
        allow: [probe.toolName],
        deny: [],
        readAccessMode: "roots_only",
        defaultForSurfaces: [],
      },
    },
    `create safe capability profile for ${input.item.capabilityId}`,
  );
  if (!profile.body?.profileId) throw new Error("safe capability probe profile returned no profileId");
  try {
    const invokeBody = {
      toolName: probe.toolName,
      args: probe.buildArgs(input.fixture),
      agentId: "verification-usability-capability-probe",
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      trustLevel: "trusted_operator",
      surface: "tools",
      permissionProfileId: profile.body.profileId,
    };
    const startedAtMs = Date.now();
    const initial = await checkedRequest(
      input,
      "/api/v1/tools/invoke",
      { method: "POST", body: invokeBody },
      `invoke safe capability ${input.item.capabilityId}`,
    );
    let response = initial;
    let approvalId;
    let approvalResolution;
    if (initial.body?.outcome === "approval_required") {
      approvalId = initial.body?.approvalId;
      if (typeof approvalId !== "string" || !approvalId.trim()) {
        throw new Error(`safe capability ${input.item.capabilityId} requested approval without an approvalId`);
      }
      const resolved = await checkedRequest(
        input,
        `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
        { method: "POST", body: { decision: "approve" } },
        `approve safe capability ${input.item.capabilityId}`,
      );
      approvalResolution = resolved.body;
      if (resolved.body?.approval?.status !== "approved" && resolved.body?.status !== "approved") {
        throw new Error(`safe capability approval ${approvalId} did not resolve approved`);
      }
      response = {
        ...resolved,
        body: await awaitCompletedApprovedToolAction({
          approvalId,
          gatewayUrl: input.gatewayUrl,
          initialResolution: resolved.body,
          requestJson: input.requestJson,
        }),
      };
    }
    if (response.body?.outcome !== "executed" && response.body?.ok !== true) {
      throw new Error(
        `safe capability ${input.item.capabilityId} did not execute: ${JSON.stringify({ action: response.body, approvalResolution })}`,
      );
    }
    const completedAtMs = Date.now();
    const resultContract = validateDeterministicCapabilityResult(input.item.capabilityId, response.body?.result, {
      fixture: input.fixture,
      sessionId: input.sessionId,
      startedAtMs,
      completedAtMs,
    });
    return dispositionRow(input, {
      probeKind: "deterministic-contract-invocation",
      probeOutcome: response.body?.outcome ?? "ok",
      executed: true,
      reason:
        "Deterministic fixture tool executed through the real Gateway policy/executor boundary and its result contract passed.",
      httpStatus: response.status,
      approvalId,
      auditEventId: response.body?.auditEventId,
      permissionProfileId: profile.body.profileId,
      resultContract,
    });
  } finally {
    await checkedRequest(
      input,
      `/api/v1/tools/permission-profiles/${encodeURIComponent(profile.body.profileId)}/archive`,
      { method: "POST", body: {} },
      `archive safe capability profile for ${input.item.capabilityId}`,
    );
  }
}

/**
 * Reads the approved tool result from the durable resolution-effect ledger.
 * ApprovalResolveResult deliberately exposes effects/replay truth rather than
 * a second, denormalized `executedAction` field.
 */
export function readCompletedApprovedToolAction(resolution, approvalId) {
  const state = readApprovedToolActionState(resolution, approvalId);
  if (state.status !== "completed") {
    throw new Error(`safe capability approval ${approvalId} pending-action effect is ${state.status}`);
  }
  return state.action;
}

export async function awaitCompletedApprovedToolAction(input) {
  const timeoutMs = input.timeoutMs ?? 3_000;
  const pollIntervalMs = input.pollIntervalMs ?? 50;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error("safe capability approval polling requires finite positive bounds");
  }
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const deadlineMs = now() + timeoutMs;
  let resolution = input.initialResolution;

  while (true) {
    const state = readApprovedToolActionState(resolution, input.approvalId);
    if (state.status === "completed") return state.action;
    if (now() >= deadlineMs) {
      throw new Error(
        `safe capability approval ${input.approvalId} pending-action effect did not complete within ${timeoutMs}ms`,
      );
    }
    const replay = await input.requestJson(
      input.gatewayUrl,
      `/api/v1/approvals/${encodeURIComponent(input.approvalId)}/replay`,
    );
    if (!replay.ok) {
      throw new Error(
        `read safe capability approval ${input.approvalId} replay failed (${replay.status}): ${JSON.stringify(replay.body)}`,
      );
    }
    resolution = replay.body;
    const remainingMs = deadlineMs - now();
    if (remainingMs > 0) await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

function readApprovedToolActionState(resolution, approvalId) {
  if (!isRecord(resolution) || !nonEmptyText(approvalId)) {
    throw new Error("safe capability approval resolution or approvalId is missing");
  }
  const approval = resolution.approval;
  if (!isRecord(approval) || approval.approvalId !== approvalId || approval.status !== "approved") {
    throw new Error(`safe capability approval ${approvalId} returned mismatched approval truth`);
  }
  if (!Array.isArray(resolution.effects)) {
    throw new Error(`safe capability approval ${approvalId} returned no durable effect ledger`);
  }

  const pendingActionEffects = resolution.effects.filter(
    (effect) =>
      isRecord(effect) &&
      effect.approvalId === approvalId &&
      effect.effectKind === "pending_action_execute" &&
      effect.targetKind === "pending_action" &&
      effect.targetId === approvalId,
  );
  if (pendingActionEffects.length !== 1) {
    throw new Error(
      `safe capability approval ${approvalId} returned ${pendingActionEffects.length} canonical pending-action effects`,
    );
  }

  const effect = pendingActionEffects[0];
  if (!isRecord(effect.payload) || effect.payload.actionType !== "tool.invoke") {
    throw new Error(`safe capability approval ${approvalId} effect is not for tool.invoke`);
  }
  if (effect.status === "pending" || effect.status === "running") {
    validatePendingToolReplay(resolution, approvalId);
    return { status: effect.status };
  }
  if (effect.status !== "completed") {
    const detail = nonEmptyText(effect.lastError) ? `: ${effect.lastError.trim()}` : "";
    throw new Error(
      `safe capability approval ${approvalId} pending-action effect is ${String(effect.status)}${detail}`,
    );
  }

  const action = effect.result;
  if (
    !isRecord(action) ||
    (action.actionType !== undefined && action.actionType !== "tool.invoke") ||
    action.outcome !== "executed" ||
    !nonEmptyText(action.policyReason) ||
    !nonEmptyText(action.auditEventId) ||
    !isRecord(action.result)
  ) {
    throw new Error(
      `safe capability approval ${approvalId} completed without a canonical executed tool action (${describeToolActionShape(action)})`,
    );
  }
  if (action.approvalId !== undefined && action.approvalId !== approvalId) {
    throw new Error(`safe capability approval ${approvalId} action referenced a different approval`);
  }
  validateCompletedToolReplay(resolution, approvalId, action);
  return { status: "completed", action };
}

function validatePendingToolReplay(resolution, approvalId) {
  const pendingAction = requireToolReplayPendingAction(resolution, approvalId);
  if (!["pending", "executed"].includes(pendingAction.resolutionStatus)) {
    throw new Error(
      `safe capability approval ${approvalId} replay has incompatible ${String(pendingAction.resolutionStatus)} pending-action state`,
    );
  }
}

function validateCompletedToolReplay(resolution, approvalId, action) {
  const pendingAction = requireToolReplayPendingAction(resolution, approvalId);
  if (pendingAction.resolutionStatus !== "executed" || !isRecord(pendingAction.result)) {
    throw new Error(`safe capability approval ${approvalId} replay did not record executed pending-action truth`);
  }
  if (canonicalJson(pendingAction.result) !== canonicalJson(action)) {
    throw new Error(`safe capability approval ${approvalId} replay action does not match its completed effect`);
  }
}

function requireToolReplayPendingAction(resolution, approvalId) {
  const replay = isRecord(resolution.replay) ? resolution.replay : resolution;
  if (!isRecord(replay.approval) || replay.approval.approvalId !== approvalId) {
    throw new Error(`safe capability approval ${approvalId} replay returned mismatched approval truth`);
  }
  const pendingAction = replay.pendingAction;
  if (
    !isRecord(pendingAction) ||
    pendingAction.approvalId !== approvalId ||
    pendingAction.actionType !== "tool.invoke"
  ) {
    throw new Error(`safe capability approval ${approvalId} replay omitted its tool.invoke pending action`);
  }
  return pendingAction;
}

function describeToolActionShape(action) {
  if (!isRecord(action)) return `record=${typeof action}`;
  return [
    `actionType=${String(action.actionType)}`,
    `outcome=${String(action.outcome)}`,
    `policyReason=${nonEmptyText(action.policyReason) ? "present" : "missing"}`,
    `auditEventId=${nonEmptyText(action.auditEventId) ? "present" : "missing"}`,
    `result=${isRecord(action.result) ? "record" : typeof action.result}`,
  ].join(",");
}

function canonicalJson(value) {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

async function probeSkillActivationContract(input) {
  const contract = validateSkillActivationContract(input.item, input.callableToolNames);
  const activation = await checkedRequest(
    input,
    "/api/v1/skills/resolve-activation",
    {
      method: "POST",
      body: {
        text: "zqv_jxk_20260729",
        explicitSkills: [input.item.capabilityId],
      },
    },
    `resolve exact skill activation for ${input.item.capabilityId}`,
  );
  const activationResult = validateSkillActivationDecision(input.item, activation.body);
  const autonomy = await evaluateAutonomy(input, input.item);
  assertAutonomyDenied(input.item.capabilityId, autonomy.body);
  return dispositionRow(input, {
    probeKind: "skill-activation-contract",
    probeOutcome: "activation_contract_verified",
    executed: false,
    reason:
      "The trusted/approved skill has an exact activation contract and declared-tool closure; it is not misreported as a directly executed tool.",
    activationContract: contract,
    activationResult,
    blockers: autonomy.body.blockers,
    httpStatus: autonomy.status,
  });
}

async function probeNamedJourneyContract(input) {
  if (input.item.kind !== "tool" || !input.item.toolName) {
    throw new Error(`named-proof capability ${input.item.capabilityId} has no tool identity`);
  }
  const proofRefs = NAMED_TOOL_PROOFS.get(input.item.toolName);
  if (!Array.isArray(proofRefs) || proofRefs.length === 0) {
    throw new Error(`named-proof capability ${input.item.capabilityId} has no exact proof refs`);
  }
  const namedProofs = validateNamedProofRefs(proofRefs, input.namedProofIndex);
  const autonomy = await evaluateAutonomy(input, input.item);
  assertAutonomyDenied(input.item.capabilityId, autonomy.body);
  return dispositionRow(input, {
    probeKind: "named-journey-non-executed-contract",
    probeOutcome: "named_proof_required",
    executed: false,
    reason:
      "This capability is intentionally not dispatched by the catalog sweep; its side-effect or context-bound behavior is assigned to exact journey proof.",
    proofRefs: namedProofs.map((proof) => proof.stepId),
    namedProofs,
    blockers: autonomy.body.blockers,
    httpStatus: autonomy.status,
  });
}

async function probeCatalogOnlyDenial(input) {
  const evaluation = await evaluateAutonomy(input, input.item);
  assertAutonomyDenied(input.item.capabilityId, evaluation.body);
  return dispositionRow(input, {
    probeKind: "noncallable-autonomy-denial",
    probeOutcome: "denied",
    executed: false,
    reason: `Catalog-only lifecycle is not callable; blockers=${formatReasons(evaluation.body?.blockers)}.`,
    blockers: evaluation.body?.blockers ?? [],
    httpStatus: evaluation.status,
  });
}

async function probeExplicitLimitation(input) {
  if (input.item.kind !== "tool" || !input.item.toolName) {
    throw new Error(`explicit limitation capability ${input.item.capabilityId} has no tool identity`);
  }
  const access = await checkedRequest(
    input,
    "/api/v1/tools/access/evaluate",
    {
      method: "POST",
      body: {
        toolName: input.item.toolName,
        agentId: "verification-usability-capability-probe",
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        args: {},
        trustLevel: "untrusted_external",
        sourceAttribution: [
          {
            sourceType: "text",
            sourceRef: "fixture:usability-untrusted-external",
            trustLevel: "untrusted_external",
          },
        ],
        surface: "tools",
      },
    },
    `evaluate unsafe/unconfigured capability ${input.item.capabilityId}`,
  );
  const autonomy = await evaluateAutonomy(input, input.item);
  assertAutonomyDenied(input.item.capabilityId, autonomy.body);
  const policyGoverned = access.body?.allowed === false || access.body?.requiresApproval === true;
  const reasons = [
    ...(Array.isArray(access.body?.reasonCodes) ? access.body.reasonCodes : []),
    ...(Array.isArray(autonomy.body?.blockers) ? autonomy.body.blockers : []),
  ];
  if (reasons.length === 0 && !access.body?.policyReason) {
    throw new Error(`unsafe/unconfigured capability ${input.item.capabilityId} returned no explicit governance reason`);
  }
  return dispositionRow(input, {
    probeKind: "explicit-non-executed-policy-diagnostic",
    probeOutcome: policyGoverned
      ? access.body?.allowed === false
        ? "denied"
        : "approval_required"
      : "autonomy_denied",
    executed: false,
    reason:
      access.body?.policyReason ??
      `Autonomous use is denied in the scrubbed fixture; direct policy diagnostic=${access.body?.allowed === true ? "allowed" : "denied"}; blockers=${formatReasons(autonomy.body?.blockers)}.`,
    blockers: reasons,
    httpStatus: access.status,
  });
}

async function evaluateAutonomy(input, item) {
  const tool = item.kind === "tool" && item.toolName;
  return await checkedRequest(
    input,
    "/api/v1/capabilities/autonomy-grants/evaluate",
    {
      method: "POST",
      body: {
        workspaceId: input.workspaceId,
        surface: tool ? "tools" : "chat",
        riskLevel: "safe",
        activationKind: tool ? "tool" : "capability",
        ...(tool ? { toolName: item.toolName } : { capabilityId: item.capabilityId }),
        estimatedCostUsd: 0,
      },
    },
    `evaluate autonomy for ${item.capabilityId}`,
  );
}

function dispositionRow(input, proof) {
  return {
    capabilityId: input.item.capabilityId,
    baseSha: input.baseSha,
    kind: input.item.kind,
    toolName: input.item.toolName,
    skillId: input.item.skillId,
    callable: input.callable,
    disposition: input.disposition,
    status: "passed",
    catalogOwner: capabilityOwner(input.item),
    catalogEvidence: {
      lifecycleState: input.item.lifecycleState ?? null,
      trustLabel: input.item.trustLabel ?? null,
      candidateId: input.item.candidateId ?? null,
      proposalId: input.item.proposalId ?? null,
      wrapperVisibility: input.item.wrapperVisibility ?? null,
      effectPotential: input.item.effectPotential ?? null,
      declaredTools: Array.isArray(input.item.declaredTools) ? [...input.item.declaredTools] : null,
      requires: Array.isArray(input.item.requires) ? [...input.item.requires] : null,
    },
    proof,
    evidence: [input.evidenceRef],
  };
}

function capabilityOwner(item) {
  const owner =
    item.sourceProvider ??
    item.sourceRef ??
    item.skillId ??
    item.toolName ??
    item.mesh?.publisherNodeId ??
    item.mesh?.publicationId;
  if (typeof owner !== "string" || !owner.trim()) throw new Error(`capability ${item.capabilityId} has no owner`);
  return owner;
}

function assertExactDispositionSet(rows, expectedIds, baseSha) {
  const actualIds = rows.map((row) => row.capabilityId);
  if (rows.length !== expectedIds.size || new Set(actualIds).size !== actualIds.length) {
    throw new Error("capability dispositions contain duplicate or missing identities");
  }
  const missing = [...expectedIds].filter((id) => !actualIds.includes(id));
  if (missing.length > 0) throw new Error(`capability dispositions are missing: ${missing.join(", ")}`);
  for (const row of rows) {
    if (
      row.baseSha !== baseSha ||
      row.status !== "passed" ||
      !Object.values(CAPABILITY_DISPOSITIONS).includes(row.disposition) ||
      !row.proof?.probeKind ||
      !row.proof?.probeOutcome ||
      !row.proof?.reason ||
      typeof row.proof.executed !== "boolean" ||
      !Array.isArray(row.evidence) ||
      row.evidence.length !== 1
    ) {
      throw new Error(`capability disposition ${row.capabilityId} is incomplete`);
    }
    if (row.kind === "tool") assertToolCatalogEvidence(row);
    if (row.kind === "skill") assertSkillCatalogEvidence(row);
  }
}

async function checkedRequest(input, route, init, label) {
  const response = await input.requestJson(input.gatewayUrl, route, init);
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${JSON.stringify(response.body)}`);
  return response;
}

function requireCapabilityArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} capability catalog is empty`);
  return value;
}

function formatReasons(value) {
  return Array.isArray(value) && value.length > 0 ? value.join(",") : "no_matching_grant";
}

function directProbe(toolName, buildArgs, validate) {
  return Object.freeze({ toolName, buildArgs, validate });
}

async function prepareDirectProbeFixture(input) {
  const fixturePaths = buildCapabilityFilesystemFixturePaths(input.workspaceRoot);
  const uploads = [
    ["alpha.txt", FILE_FIXTURE_ALPHA],
    ["example.ts", FILE_FIXTURE_CODE],
  ];
  for (const [name, content] of uploads) {
    const relativePath = `${FILE_FIXTURE_ROOT}/${name}`;
    const response = await checkedRequest(
      input,
      "/api/v1/files/upload",
      { method: "POST", body: { relativePath, content } },
      `upload deterministic capability fixture ${name}`,
    );
    if (response.body?.relativePath !== relativePath || response.body?.bytes !== content.length) {
      throw new Error(`deterministic capability fixture ${name} did not persist exactly`);
    }
    assertPathEndsWith(response.body?.fullPath, `/workspace/${relativePath}`);
  }
  return {
    ...fixturePaths,
    knowledgeDocId: undefined,
  };
}

export function buildCapabilityFilesystemFixturePaths(workspaceRoot) {
  if (!nonEmptyText(workspaceRoot)) {
    throw new Error("capability filesystem probes require the isolated runtime workspaceRoot");
  }
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot.trim());
  const fixture = {
    fileRoot: path.join(resolvedWorkspaceRoot, FILE_FIXTURE_ROOT),
    alphaPath: path.join(resolvedWorkspaceRoot, FILE_FIXTURE_ROOT, "alpha.txt"),
    codePath: path.join(resolvedWorkspaceRoot, FILE_FIXTURE_ROOT, "example.ts"),
  };
  for (const [label, candidate] of Object.entries(fixture)) {
    const relative = path.relative(resolvedWorkspaceRoot, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`capability ${label} escaped the isolated runtime workspaceRoot`);
    }
  }
  return fixture;
}

export function validateDeterministicCapabilityResult(capabilityId, result, context) {
  const probe = SAFE_CONTRACT_PROBES.get(capabilityId);
  if (!probe) throw new Error(`deterministic result validator is missing for ${capabilityId}`);
  if (!isRecord(result)) throw new Error(`${capabilityId} returned no object result`);
  const summary = probe.validate(result, context);
  if (!isRecord(summary) || Object.keys(summary).length === 0) {
    throw new Error(`${capabilityId} result validator returned no proof summary`);
  }
  return summary;
}

export function listDeterministicCapabilityProbeIds() {
  return [...SAFE_CONTRACT_PROBES.keys()];
}

function validateSessionStatusResult(result, context) {
  if (result.schemaVersion !== "chat.session-status.v1" || result.sessionId !== context.sessionId) {
    throw new Error("session.status did not return the exact session status contract");
  }
  for (const section of ["work", "attention", "orchestration", "usage"]) {
    if (!isRecord(result[section]) || result[section].availability !== "available") {
      throw new Error(`session.status ${section} section is not available`);
    }
  }
  assertIsoTimestamp(result.generatedAt, "session.status generatedAt");
  return { schemaVersion: result.schemaVersion, sessionId: result.sessionId, availableSections: 4 };
}

function validateTimeNowResult(result, context) {
  if (!Number.isSafeInteger(result.epochMs)) throw new Error("time.now epochMs is not a safe integer");
  if (result.epochMs < context.startedAtMs - 1_000 || result.epochMs > context.completedAtMs + 1_000) {
    throw new Error("time.now epochMs is outside the request window");
  }
  if (result.iso !== new Date(result.epochMs).toISOString()) throw new Error("time.now ISO and epoch disagree");
  if (!nonEmptyText(result.local) || !nonEmptyText(result.timezone)) {
    throw new Error("time.now omitted local time or timezone");
  }
  return { iso: result.iso, epochMs: result.epochMs, timezone: result.timezone };
}

function validateWholeFileResult(result, _context, expectedContent) {
  assertPathEndsWith(result.path, "/workspace/capability-probe/alpha.txt");
  if (result.content !== expectedContent || result.bytes !== expectedContent.length) {
    throw new Error("fs.read did not return the exact ASCII fixture");
  }
  return { pathSuffix: "workspace/capability-probe/alpha.txt", bytes: result.bytes, contentShaFixture: "alpha-v1" };
}

function validateFileRangeResult(result) {
  assertPathEndsWith(result.path, "/workspace/capability-probe/alpha.txt");
  if (
    result.startLine !== 2 ||
    result.endLine !== 3 ||
    result.lineCount !== 2 ||
    result.content !== "needle-one\nomega"
  ) {
    throw new Error("file.read_range did not return the exact requested lines");
  }
  return { startLine: 2, endLine: 3, lineCount: 2, content: result.content };
}

function validateFileFindResult(result) {
  const matches = Array.isArray(result.matches) ? result.matches : [];
  if (result.pattern !== "needle-one" || result.count !== 1 || matches.length !== 1) {
    throw new Error("file.find did not return exactly one fixture match");
  }
  assertPathEndsWith(matches[0]?.path, "/workspace/capability-probe/alpha.txt");
  if (matches[0]?.line !== 2 || matches[0]?.lineText !== "needle-one") {
    throw new Error("file.find returned the wrong line receipt");
  }
  return { count: 1, line: 2, lineText: "needle-one" };
}

function validateCodeSearchResult(result) {
  const matches = Array.isArray(result.matches) ? result.matches : [];
  if (result.pattern !== "capabilityNeedle" || result.count !== 1 || matches.length !== 1) {
    throw new Error("code.search did not return exactly one fixture match");
  }
  assertPathEndsWith(matches[0]?.path, "/workspace/capability-probe/example.ts");
  if (matches[0]?.line !== 1 || matches[0]?.lineText !== FILE_FIXTURE_CODE.trimEnd()) {
    throw new Error("code.search returned the wrong source receipt");
  }
  return { count: 1, line: 1, symbol: "capabilityNeedle" };
}

function validateCodeSearchFilesResult(result) {
  const matches = Array.isArray(result.matches) ? result.matches : [];
  if (result.query !== "example.ts" || result.count !== 1 || matches.length !== 1) {
    throw new Error("code.search_files did not return exactly one fixture path");
  }
  assertPathEndsWith(matches[0]?.path, "/workspace/capability-probe/example.ts");
  if (matches[0]?.name !== "example.ts" || matches[0]?.type !== "file") {
    throw new Error("code.search_files returned malformed file metadata");
  }
  return { count: 1, name: "example.ts", type: "file" };
}

function validateFileListResult(result) {
  assertPathEndsWith(result.path, "/workspace/capability-probe");
  const items = Array.isArray(result.items) ? result.items.map((item) => `${item?.name}:${item?.type}`).sort() : [];
  if (JSON.stringify(items) !== JSON.stringify(["alpha.txt:file", "example.ts:file"])) {
    throw new Error(`fs.list returned an unexpected fixture set: ${JSON.stringify(items)}`);
  }
  return { items };
}

function validateFileStatResult(result) {
  assertPathEndsWith(result.path, "/workspace/capability-probe/alpha.txt");
  if (result.isFile !== true || result.isDirectory !== false || result.size !== FILE_FIXTURE_ALPHA.length) {
    throw new Error("fs.stat returned incorrect file metadata");
  }
  assertIsoTimestamp(result.modifiedAt, "fs.stat modifiedAt");
  return { isFile: true, isDirectory: false, size: result.size };
}

function validateDocsIngestResult(result, context) {
  if (
    result.document?.sourceType !== "text" ||
    result.document?.sourceRef !== KNOWLEDGE_SOURCE ||
    result.document?.title !== "Capability knowledge fixture" ||
    result.document?.text !== KNOWLEDGE_SOURCE ||
    !Number.isSafeInteger(result.chunksSaved) ||
    result.chunksSaved < 1
  ) {
    throw new Error("docs.ingest did not persist the exact text fixture");
  }
  const chunk = Array.isArray(result.chunks)
    ? result.chunks.find((item) => item?.content === KNOWLEDGE_SOURCE)
    : undefined;
  if (!nonEmptyText(chunk?.docId) || !nonEmptyText(chunk?.chunkId)) {
    throw new Error("docs.ingest returned no canonical document/chunk identity");
  }
  context.fixture.knowledgeDocId = chunk.docId;
  return {
    docId: chunk.docId,
    chunkId: chunk.chunkId,
    chunksSaved: result.chunksSaved,
    cached: result.cached === true,
  };
}

function validateMemoryReadResult(result, context) {
  const item = findKnowledgeItem(result, context, "snippet");
  if (result.namespace !== KNOWLEDGE_NAMESPACE || result.query !== KNOWLEDGE_NEEDLE.toLowerCase()) {
    throw new Error("memory.read returned the wrong namespace or normalized query");
  }
  if (item.title !== "Capability knowledge fixture" || item.sourceRef !== KNOWLEDGE_SOURCE) {
    throw new Error("memory.read lost document attribution");
  }
  return knowledgeSummary(item);
}

function validateMemorySearchResult(result, context) {
  const item = findKnowledgeItem(result, context, "snippet");
  if (result.namespace !== KNOWLEDGE_NAMESPACE || result.query !== KNOWLEDGE_NEEDLE.toLowerCase()) {
    throw new Error("memory.search returned the wrong namespace or normalized query");
  }
  if (!(item.score > 0)) throw new Error("memory.search returned no positive lexical score");
  return knowledgeSummary(item);
}

function validateDocsSearchResult(result, context) {
  const item = findKnowledgeItem(result, context, "content");
  if (result.namespace !== KNOWLEDGE_NAMESPACE || result.query !== KNOWLEDGE_NEEDLE) {
    throw new Error("docs.search returned the wrong namespace or query");
  }
  if (!(item.score > 0)) throw new Error("docs.search returned no positive lexical score");
  return knowledgeSummary(item);
}

function validateEmbeddingsIndexResult(result, context) {
  if (
    result.namespace !== KNOWLEDGE_NAMESPACE ||
    result.documentId !== context.fixture.knowledgeDocId ||
    result.indexed !== 0 ||
    !Number.isSafeInteger(result.skipped) ||
    result.skipped < 1
  ) {
    throw new Error("embeddings.index did not recognize the current deterministic fixture embedding");
  }
  return { documentId: result.documentId, indexed: 0, skipped: result.skipped, stale: result.stale };
}

function validateEmbeddingsQueryResult(result, context) {
  const item = findKnowledgeItem(result, context, "snippet");
  if (result.namespace !== KNOWLEDGE_NAMESPACE || result.query !== KNOWLEDGE_NEEDLE || !nonEmptyText(result.method)) {
    throw new Error("embeddings.query returned an incomplete query contract");
  }
  if (!Number.isFinite(item.score) || !isRecord(result.embedding) || !nonEmptyText(result.embedding.provider)) {
    throw new Error("embeddings.query returned incomplete score/profile evidence");
  }
  return { ...knowledgeSummary(item), method: result.method, provider: result.embedding.provider };
}

function validateCitationsResult(result, context) {
  const expected = { ...CITATION_FIXTURE, sourceType: "web" };
  if (
    result.count !== 1 ||
    JSON.stringify(result.results) !== JSON.stringify([expected]) ||
    JSON.stringify(result.citations) !== JSON.stringify([expected])
  ) {
    throw new Error("citations.build did not return the exact normalized citation bundle");
  }
  const builtAt = assertIsoTimestamp(result.builtAt, "citations.build builtAt");
  if (builtAt < context.startedAtMs - 1_000 || builtAt > context.completedAtMs + 1_000) {
    throw new Error("citations.build builtAt is outside the request window");
  }
  return { count: 1, citationId: expected.citationId, sourceType: "web", builtAt: result.builtAt };
}

function findKnowledgeItem(result, context, contentKey) {
  if (!nonEmptyText(context.fixture.knowledgeDocId))
    throw new Error("knowledge fixture document identity is unavailable");
  const items = Array.isArray(result.items) ? result.items : [];
  const matches = items.filter((item) => item?.docId === context.fixture.knowledgeDocId);
  if (matches.length !== 1 || !String(matches[0]?.[contentKey] ?? "").includes(KNOWLEDGE_NEEDLE)) {
    throw new Error(`knowledge query did not return exactly one canonical ${contentKey} fixture`);
  }
  return matches[0];
}

function knowledgeSummary(item) {
  return {
    docId: item.docId,
    chunkId: item.chunkId ?? null,
    sourceType: item.attribution?.sourceType ?? null,
    trustLevel: item.attribution?.trustLevel ?? null,
  };
}

function validateSkillActivationContract(item, callableToolNames) {
  if (!nonEmptyText(item.skillId) || !["approved", "trusted"].includes(item.lifecycleState)) {
    throw new Error(`callable skill ${item.capabilityId} lacks an approved/trusted lifecycle`);
  }
  if (!nonEmptyText(item.trustLabel)) throw new Error(`callable skill ${item.capabilityId} lacks a trust label`);
  const declaredTools = exactStringList(item.declaredTools, `${item.capabilityId} declaredTools`);
  const requires = exactStringList(item.requires, `${item.capabilityId} requires`);
  const missingTools = declaredTools.filter((toolName) => !callableToolNames.has(toolName));
  if (missingTools.length > 0) {
    throw new Error(`callable skill ${item.capabilityId} declares absent tools: ${missingTools.join(", ")}`);
  }
  return {
    lifecycleState: item.lifecycleState,
    trustLabel: item.trustLabel,
    declaredTools,
    requires,
    sourceRef: item.sourceRef ?? null,
    sourceProvider: item.sourceProvider ?? null,
  };
}

export function validateSkillActivationDecision(item, body) {
  if (!isRecord(body)) throw new Error(`skill ${item.capabilityId} activation returned no decision object`);
  const selected = Array.isArray(body.selected) ? body.selected : [];
  const exact = selected.filter((entry) => entry?.skillId === item.skillId);
  if (exact.length !== 1 || selected.length !== 1) {
    throw new Error(`skill ${item.capabilityId} activation did not select exactly its requested identity`);
  }
  const resolved = exact[0];
  if (!["enabled", "sleep"].includes(resolved.state) || resolved.requiresConfirmation !== false) {
    throw new Error(`skill ${item.capabilityId} activation returned an invalid explicit state/confirmation contract`);
  }
  const declaredTools = exactStringList(resolved.declaredTools, `${item.capabilityId} selected declaredTools`);
  const requires = exactStringList(resolved.requires, `${item.capabilityId} selected requires`);
  if (
    JSON.stringify([...declaredTools].sort()) !== JSON.stringify([...item.declaredTools].sort()) ||
    JSON.stringify([...requires].sort()) !== JSON.stringify([...item.requires].sort())
  ) {
    throw new Error(`skill ${item.capabilityId} activation changed its declared tool/dependency closure`);
  }
  if (!Number.isFinite(resolved.confidence) || resolved.confidence <= 0 || resolved.confidence > 1) {
    throw new Error(`skill ${item.capabilityId} activation returned invalid confidence`);
  }
  const blocked = Array.isArray(body.blocked) ? body.blocked : [];
  if (blocked.some((entry) => entry?.skill === item.capabilityId || entry?.skill === item.skillId)) {
    throw new Error(`skill ${item.capabilityId} was both selected and blocked`);
  }
  return {
    skillId: resolved.skillId,
    state: resolved.state,
    declaredTools,
    requires,
    confidence: resolved.confidence,
    requiresConfirmation: false,
  };
}

function buildRequiredNamedProofIndex(baseSha) {
  const inventory = buildUsabilityRouteActionInventory(baseSha);
  return new Map(
    inventory.rows
      .filter((row) => row.required === true && Array.isArray(row.proofBindings) && row.proofBindings.length > 0)
      .map((row) => [row.stepId, row]),
  );
}

export function validateNamedProofRefs(proofRefs, namedProofIndex) {
  if (!Array.isArray(proofRefs) || proofRefs.length === 0 || !(namedProofIndex instanceof Map)) {
    throw new Error("named capability proof refs or required inventory index are missing");
  }
  return proofRefs.map((stepId) => {
    const row = namedProofIndex.get(stepId);
    if (!row || row.required !== true || !Array.isArray(row.proofBindings) || row.proofBindings.length === 0) {
      throw new Error(`named capability proof ${stepId} is orphaned from required inventory/scenario evidence`);
    }
    return {
      stepId,
      proofMode: row.proofMode,
      proofBindings: row.proofBindings.map((binding) => ({
        mode: binding.mode,
        scenarioIds: Array.isArray(binding.scenarioIds) ? [...binding.scenarioIds] : [],
      })),
    };
  });
}

function exactStringList(value, label) {
  if (!Array.isArray(value) || value.some((item) => !nonEmptyText(item))) {
    throw new Error(`${label} must be an explicit string array`);
  }
  const normalized = value.map((item) => item.trim());
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} contains duplicates`);
  return normalized;
}

function assertAutonomyDenied(capabilityId, body) {
  if (body?.allowed !== false || !Array.isArray(body.blockers) || body.blockers.length === 0) {
    throw new Error(`capability ${capabilityId} lacks an exact no-grant autonomy denial: ${JSON.stringify(body)}`);
  }
}

function assertToolCatalogEvidence(row) {
  const visibility = row.catalogEvidence?.wrapperVisibility;
  const effect = row.catalogEvidence?.effectPotential;
  if (
    !isRecord(visibility) ||
    typeof visibility.readOnly !== "boolean" ||
    typeof visibility.deterministic !== "boolean" ||
    typeof visibility.codeModeAllowed !== "boolean" ||
    !isRecord(effect) ||
    !nonEmptyText(effect.version) ||
    !["none", "unknown"].includes(effect.potential) ||
    !nonEmptyText(effect.sourceKind) ||
    !nonEmptyText(effect.reason)
  ) {
    throw new Error(`tool capability ${row.capabilityId} omitted wrapper visibility or effect-potential truth`);
  }
}

function assertSkillCatalogEvidence(row) {
  exactStringList(row.catalogEvidence?.declaredTools, `${row.capabilityId} catalog declaredTools`);
  exactStringList(row.catalogEvidence?.requires, `${row.capabilityId} catalog requires`);
}

function assertPathEndsWith(value, expectedSuffix) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  if (!normalized.endsWith(expectedSuffix)) {
    throw new Error(`path ${JSON.stringify(value)} does not end with ${expectedSuffix}`);
  }
}

function assertIsoTimestamp(value, label) {
  if (!nonEmptyText(value)) throw new Error(`${label} is missing`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error(`${label} is not canonical ISO`);
  return parsed;
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
