/* eslint-disable max-lines -- policy evaluation rules remain co-located to keep branching behavior reviewable. */
import fs from "node:fs";
import type {
  FilesystemReadAccessMode,
  ApprovalLinkage,
  EffectiveToolPolicy,
  ToolGrantConstraints,
  ToolAccessEvaluateRequest,
  ToolAccessEvaluateResponse,
  ToolApprovalMode,
  ToolGrantCreateInput,
  ToolGrantRecord,
  ToolGrantScope,
  ToolInvokeRequest,
  ToolInvokeResult,
  ToolPolicyConfig,
  ToolRiskLevel,
} from "@goatcitadel/contracts";
import { evaluateWards } from "@goatcitadel/contracts";
import type { CitadelWardRecord, WardEffect } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ApprovalGate } from "./approval-gate.js";
import { getVerifiedApprovalBypassId, hasVerifiedApprovalBypass } from "./approval-bypass.js";
import {
  parseIngestionBackend,
  parseIngestionSourceType,
  type IngestionBackendName,
  type IngestionSourceType,
} from "./ingestion-source-type.js";
import { resolveEffectivePolicy } from "./policy-resolver.js";
import { createDefaultToolRegistry, type ToolDefinition, type ToolRegistry } from "./tool-registry.js";
import { matchesAnyToolPattern, matchesToolPattern } from "./tool-patterns.js";
import { assertWritePathInJail, resolveReadPathAccess } from "./sandbox/path-jail.js";
import {
  assertHostAllowed,
  assertNotPrivateOrReservedHost,
  evaluateDangerousHostBypass,
  redactUrlForError,
} from "./sandbox/network-guard.js";
import { classifyShellRisk } from "./sandbox/shell-risk-gate.js";
import { classifyArgumentRisk } from "./sandbox/argument-risk-gate.js";
import { executeTool, resolveFixedOutboundHostsForTool, type ToolExecutorRuntimeHooks } from "./tool-executor.js";
import {
  buildInternalToolCall,
  buildInternalToolResult,
  buildToolAuditRecord,
  deriveToolCapabilityPolicy,
  isUntrustedToolEscalation,
  resolveToolTrustLevel,
  sanitizeForModel,
} from "./tool-security.js";

interface AccessEvaluation {
  allowed: boolean;
  reasonCodes: string[];
  requiresApproval: boolean;
  matchedGrantId?: string;
  riskLevel: ToolRiskLevel;
  policyReason: string;
  grantToConsume?: string;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  approvalMode?: ToolApprovalMode;
  matchedGrantAllowedHosts?: string[];
  /**
   * Raw matched Citadel Ward effect (collapsed to `undefined` on no-match/`allow`).
   * Surfaced to callers so downstream execution can enforce the effects the engine
   * does not itself gate (`require_dry_run`, `route_local`, `redact`). Set on every
   * post-ward return path; never set on the two pre-ward early returns.
   */
  wardEffect?: WardEffect;
}

function assertHostAllowedForConfig(hostOrUrl: string, config: ToolPolicyConfig): void {
  assertHostAllowed(hostOrUrl, config.sandbox.networkAllowlist);
}

function isFullWebAccessEligibleTool(toolName: string): boolean {
  return (
    toolName === "browser.search" ||
    toolName === "browser.navigate" ||
    toolName === "browser.extract" ||
    toolName === "browser.screenshot" ||
    toolName === "http.get" ||
    toolName === "docs.ingest"
  );
}

function hasFullWebAccess(request: Pick<ToolAccessEvaluateRequest, "toolName" | "policyContext">): boolean {
  return isFullWebAccessEligibleTool(request.toolName) && request.policyContext?.fullWebAccess !== false;
}

function assertHostAllowedForRequest(
  hostOrUrl: string,
  request: ToolAccessEvaluateRequest,
  config: ToolPolicyConfig,
): void {
  if (hasFullWebAccess(request)) {
    assertHostAllowed(hostOrUrl, [...config.sandbox.networkAllowlist, "*"]);
    return;
  }
  assertHostAllowedForConfig(hostOrUrl, config);
}

function assertFirecrawlBaseUrlAllowedForConfig(hostOrUrl: string, config: ToolPolicyConfig): void {
  const parsed = parseHttpUrlForPolicy(hostOrUrl, "firecrawlBaseUrl");
  if (isCanonicalLocalFirecrawlBaseUrl(parsed)) {
    return;
  }
  assertHostAllowedForConfig(parsed.toString(), config);
  assertNotPrivateOrReservedHost(parsed.toString());
}

function parseHttpUrlForPolicy(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL (${redactUrlForError(value)})`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https (${redactUrlForError(value)})`);
  }
  return parsed;
}

function isCanonicalLocalFirecrawlBaseUrl(parsed: URL): boolean {
  return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === "3002";
}

function readFirecrawlBaseUrl(args: Record<string, unknown> | undefined): string {
  return String(args?.firecrawlBaseUrl ?? process.env.FIRECRAWL_BASE_URL ?? "http://127.0.0.1:3002");
}

const BROWSER_SEARCH_ENGINE_URLS = {
  duckduckgo: "https://lite.duckduckgo.com/lite/",
  bing: "https://www.bing.com/search",
  google: "https://www.google.com/search",
} as const;

type BrowserSearchEngine = keyof typeof BROWSER_SEARCH_ENGINE_URLS;

function resolveBrowserSearchEngineCandidates(engineValue: unknown): BrowserSearchEngine[] {
  const engine = typeof engineValue === "string" ? engineValue.toLowerCase() : "auto";
  if (engine === "google") {
    return ["google", "bing", "duckduckgo"];
  }
  if (engine === "bing") {
    return ["bing", "duckduckgo", "google"];
  }
  if (engine === "duckduckgo") {
    return ["duckduckgo", "bing", "google"];
  }
  return ["duckduckgo", "bing", "google"];
}

function validateBrowserSearchHosts(request: ToolAccessEvaluateRequest, config: ToolPolicyConfig): void {
  if (hasFullWebAccess(request)) {
    return;
  }
  const backend = typeof request.args?.backend === "string" ? request.args.backend.toLowerCase() : undefined;
  if (backend === "firecrawl" && request.args?.firecrawlFallbackToNative === false) {
    return;
  }
  const candidates = resolveBrowserSearchEngineCandidates(request.args?.engine);
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      assertHostAllowedForConfig(BROWSER_SEARCH_ENGINE_URLS[candidate], config);
      return;
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  throw new Error(
    `browser.search requires at least one native search host in the network allowlist (${candidates.join(", ")}): ${
      errors[0] ?? "no hosts checked"
    }`,
  );
}

interface GrantDecision {
  decision: "allow" | "deny";
  grant: ToolGrantRecord;
  allowGrants?: ToolGrantRecord[];
  constraintsError?: string;
}

type ActiveToolGrantRepository = Storage["toolGrants"] & {
  listActive?: (scope?: ToolGrantScope, scopeRef?: string) => ToolGrantRecord[];
};

export type ToolPolicyEngineRuntimeHooks = ToolExecutorRuntimeHooks;

const DEFAULT_APPROVAL_TTL_MS = 15 * 60_000;

export class ToolPolicyEngine {
  private readonly approvals: ApprovalGate;
  private readonly registry: ToolRegistry;

  public constructor(
    private readonly config: ToolPolicyConfig,
    private readonly storage: Storage,
    registry?: ToolRegistry,
    private readonly runtimeHooks: ToolPolicyEngineRuntimeHooks = {},
  ) {
    this.registry = registry ?? createDefaultToolRegistry();
    this.approvals = new ApprovalGate(storage);
  }

  public listCatalog() {
    return this.registry.toCatalog();
  }

  public listGrants(scope?: ToolGrantScope, scopeRef?: string, limit = 200): ToolGrantRecord[] {
    return this.storage.toolGrants.list(scope, scopeRef, limit);
  }

  public createGrant(input: ToolGrantCreateInput): ToolGrantRecord {
    return this.storage.toolGrants.create(input);
  }

  public revokeGrant(grantId: string, revokedBy: string): boolean {
    if (!revokedBy.trim()) {
      throw new Error("revokedBy is required to revoke a tool grant");
    }
    return this.storage.toolGrants.revoke(grantId, undefined, revokedBy);
  }

  public evaluateAccess(input: ToolAccessEvaluateRequest): ToolAccessEvaluateResponse {
    const evaluation = this.evaluateAccessInternal(input);
    this.storage.toolAccessDecisions.record({
      toolName: input.toolName,
      agentId: input.agentId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      runId: input.runId,
      allowed: evaluation.allowed,
      reasonCodes: evaluation.reasonCodes,
      matchedGrantId: evaluation.matchedGrantId,
      requiresApproval: evaluation.requiresApproval,
      riskLevel: evaluation.riskLevel,
      permissionProfileId: evaluation.permissionProfileId,
      localOperatorOverrideId: evaluation.localOperatorOverrideId,
      countsTowardLimits: false,
    });

    return {
      toolName: input.toolName,
      allowed: evaluation.allowed,
      reasonCodes: evaluation.reasonCodes,
      requiresApproval: evaluation.requiresApproval,
      matchedGrantId: evaluation.matchedGrantId,
      riskLevel: evaluation.riskLevel,
      permissionProfileId: evaluation.permissionProfileId,
      localOperatorOverrideId: evaluation.localOperatorOverrideId,
      wardEffect: evaluation.wardEffect,
    };
  }

  public async invoke(request: ToolInvokeRequest): Promise<ToolInvokeResult> {
    const directApprovalBypassId = getVerifiedApprovalBypassId(request, this.storage);
    if (directApprovalBypassId) {
      const result = await this.executeApprovedAction(
        directApprovalBypassId,
        request.signal,
        request.externalRuntime === true ? { deferResolution: true } : undefined,
      );
      if (result) {
        return result;
      }
    }

    const auditEventId = randomUUID();
    const startedAt = new Date().toISOString();
    const toolDef = this.registry.get(request.toolName);
    const capabilityPolicy = deriveToolCapabilityPolicy(request.toolName, toolDef);
    const internalCall = buildInternalToolCall(request, capabilityPolicy, startedAt);
    const evaluation = this.evaluateAccessInternal(request);

    this.storage.toolAccessDecisions.record({
      toolName: request.toolName,
      agentId: request.agentId,
      sessionId: request.sessionId,
      workspaceId: request.workspaceId,
      taskId: request.taskId,
      runId: request.runId,
      allowed: evaluation.allowed,
      reasonCodes: evaluation.reasonCodes,
      matchedGrantId: evaluation.matchedGrantId,
      requiresApproval: evaluation.requiresApproval,
      riskLevel: evaluation.riskLevel,
      permissionProfileId: evaluation.permissionProfileId,
      localOperatorOverrideId: evaluation.localOperatorOverrideId,
      countsTowardLimits: evaluation.allowed && !evaluation.requiresApproval && request.dryRun !== true,
    });

    if (!evaluation.allowed) {
      const reason = `blocked: ${evaluation.policyReason}`;
      await this.recordBlocked(auditEventId, request, reason, {
        reasonCodes: evaluation.reasonCodes,
        riskLevel: evaluation.riskLevel,
        matchedGrantId: evaluation.matchedGrantId,
        permissionProfileId: evaluation.permissionProfileId,
        localOperatorOverrideId: evaluation.localOperatorOverrideId,
        approvalMode: evaluation.approvalMode,
      });
      const completedAt = new Date().toISOString();
      const internalResult = buildInternalToolResult({
        toolName: request.toolName,
        outcome: "blocked",
        errorKind: "policy_block",
        completedAt,
      });
      const audit = buildToolAuditRecord({
        auditEventId,
        request,
        outcome: "blocked",
        policyReason: reason,
        startedAt,
        completedAt,
        matchedGrantId: evaluation.matchedGrantId,
        reasonCodes: evaluation.reasonCodes,
        permissionProfileId: evaluation.permissionProfileId,
        localOperatorOverrideId: evaluation.localOperatorOverrideId,
        approvalMode: evaluation.approvalMode,
        errorKind: "policy_block",
      });
      return {
        outcome: "blocked",
        policyReason: reason,
        auditEventId,
        internalCall,
        internalResult,
        audit,
      };
    }

    await this.recordDangerProfileNetworkBypassIfNeeded(auditEventId, request, evaluation);

    // SECURITY (codex finding #16): If a request would require approval,
    // a dry-run must surface that as `approval_required` (with dryRun
    // metadata), not as `executed`. Previously the dry-run short-circuit
    // fired BEFORE the requiresApproval branch, so callers that built
    // their own pre-checks (e.g. `ToolInvocationCoordinatorService.evaluateMcpPolicy`)
    // saw `outcome: "executed"` for tools the policy actually wanted to
    // gate, and then went on to invoke the real tool. We now route
    // `requiresApproval` first so the approval boundary is the same
    // regardless of dryRun.

    if (evaluation.requiresApproval) {
      const expiresAt = new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS).toISOString();
      const approval = await this.approvals.create({
        kind: request.toolName,
        riskLevel: evaluation.riskLevel,
        payload: request.args,
        preview: this.buildApprovalPreview(request),
        linkage: buildToolApprovalLinkage(request, evaluation),
        expiresAt,
      });

      this.storage.pendingApprovalActions.upsertPending({
        approvalId: approval.approvalId,
        actionType: "tool.invoke",
        request: toPlainRecord(request),
        expiresAt,
      });

      this.storage.approvalEvents.append({
        approvalId: approval.approvalId,
        eventType: "pending_action_registered",
        actorId: request.agentId,
        payload: {
          actionType: "tool.invoke",
          toolName: request.toolName,
          sessionId: request.sessionId,
          taskId: request.taskId,
          matchedGrantId: evaluation.matchedGrantId,
          reasonCodes: evaluation.reasonCodes,
        },
      });

      await this.recordInvocation(
        auditEventId,
        request,
        "approval_required",
        evaluation.policyReason,
        undefined,
        approval.approvalId,
        evaluation,
      );
      const completedAt = new Date().toISOString();

      return {
        outcome: "approval_required",
        approvalId: approval.approvalId,
        expiresAt: approval.expiresAt ?? expiresAt,
        policyReason: evaluation.policyReason,
        auditEventId,
        internalCall,
        internalResult: buildInternalToolResult({
          toolName: request.toolName,
          outcome: "approval_required",
          errorKind: "approval_required",
          completedAt,
        }),
        audit: buildToolAuditRecord({
          auditEventId,
          request,
          outcome: "approval_required",
          policyReason: evaluation.policyReason,
          startedAt,
          completedAt,
          approvalId: approval.approvalId,
          matchedGrantId: evaluation.matchedGrantId,
          reasonCodes: evaluation.reasonCodes,
          permissionProfileId: evaluation.permissionProfileId,
          localOperatorOverrideId: evaluation.localOperatorOverrideId,
          approvalMode: evaluation.approvalMode,
          errorKind: "approval_required",
        }),
      };
    }

    // SECURITY (codex finding #16): Dry-run preview for requests that do
    // NOT require approval. We deliberately reach this branch only after
    // the requiresApproval branch above has had a chance to surface as
    // `approval_required` — otherwise dry-run becomes an approval bypass
    // for any caller (MCP coordinator, etc.) that pre-checks with
    // `{ dryRun: true }` and then proceeds when the outcome is "executed".
    if (request.dryRun) {
      const result = {
        dryRun: true,
        toolName: request.toolName,
        policy: {
          allowed: evaluation.allowed,
          requiresApproval: evaluation.requiresApproval,
          riskLevel: evaluation.riskLevel,
          reasonCodes: evaluation.reasonCodes,
        },
      };
      await this.recordInvocation(
        auditEventId,
        request,
        "executed",
        `${evaluation.policyReason}; dry-run`,
        result,
        undefined,
        evaluation,
      );
      const completedAt = new Date().toISOString();
      return {
        outcome: "executed",
        policyReason: `${evaluation.policyReason}; dry-run`,
        auditEventId,
        result,
        wardEffect: evaluation.wardEffect,
        internalCall,
        internalResult: buildInternalToolResult({
          toolName: request.toolName,
          outcome: "executed",
          result,
          completedAt,
        }),
        audit: buildToolAuditRecord({
          auditEventId,
          request,
          outcome: "executed",
          policyReason: `${evaluation.policyReason}; dry-run`,
          startedAt,
          completedAt,
          matchedGrantId: evaluation.matchedGrantId,
          reasonCodes: evaluation.reasonCodes,
          permissionProfileId: evaluation.permissionProfileId,
          localOperatorOverrideId: evaluation.localOperatorOverrideId,
          approvalMode: evaluation.approvalMode,
        }),
      };
    }

    const executionRequest = withExecutionGrantContext(request, evaluation);
    if (request.externalRuntime) {
      return this.executeAllowedRequest(
        executionRequest,
        auditEventId,
        `${evaluation.policyReason}; external runtime`,
        evaluation.grantToConsume,
        startedAt,
        evaluation.matchedGrantId,
        undefined,
        evaluation,
        internalCall,
      );
    }

    return this.executeAllowedRequest(
      executionRequest,
      auditEventId,
      evaluation.policyReason,
      evaluation.grantToConsume,
      startedAt,
      evaluation.matchedGrantId,
      undefined,
      evaluation,
      internalCall,
    );
  }

  public async executeApprovedAction(
    approvalId: string,
    signal?: AbortSignal,
    options?: { deferResolution?: boolean; externalRuntimeReplay?: boolean },
  ): Promise<ToolInvokeResult | undefined> {
    const pending = this.storage.pendingApprovalActions.find(approvalId);
    if (!pending || pending.resolutionStatus !== "pending") {
      return undefined;
    }

    if (pending.actionType !== "tool.invoke") {
      this.storage.pendingApprovalActions.markResolved(approvalId, "failed", {
        error: `unsupported pending action type ${pending.actionType}`,
      });
      return undefined;
    }

    const request = asToolInvokeRequest(pending.request);
    const approvedRequest: ToolInvokeRequest = {
      ...request,
      signal,
      consentContext: {
        ...(request.consentContext ?? {}),
        source: request.consentContext?.source ?? "ui",
        reason: `approval:${approvalId}`,
      },
    };
    if (!hasVerifiedApprovalBypass(approvedRequest, this.storage)) {
      const reason = "pending approval action is expired, resolved, or no longer matches the stored request";
      this.storage.pendingApprovalActions.markResolved(approvalId, "failed", { reason });
      this.storage.approvalEvents.append({
        approvalId,
        eventType: "approved_action_executed",
        actorId: "system",
        payload: { outcome: "blocked", reason },
      });
      return undefined;
    }
    const executionRequest: ToolInvokeRequest =
      options?.externalRuntimeReplay === true
        ? {
            ...approvedRequest,
            dryRun: undefined,
            externalRuntime: true,
          }
        : approvedRequest;
    const auditEventId = randomUUID();
    const startedAt = new Date().toISOString();
    const approvedToolDef = this.registry.get(executionRequest.toolName);
    const approvedCapabilityPolicy = deriveToolCapabilityPolicy(executionRequest.toolName, approvedToolDef);
    const internalCall = buildInternalToolCall(executionRequest, approvedCapabilityPolicy, startedAt);
    const evaluation = this.evaluateAccessInternal(executionRequest);

    this.storage.toolAccessDecisions.record({
      toolName: executionRequest.toolName,
      agentId: executionRequest.agentId,
      sessionId: executionRequest.sessionId,
      workspaceId: executionRequest.workspaceId,
      taskId: executionRequest.taskId,
      runId: executionRequest.runId,
      allowed: evaluation.allowed,
      reasonCodes: evaluation.reasonCodes,
      matchedGrantId: evaluation.matchedGrantId,
      requiresApproval: false,
      riskLevel: evaluation.riskLevel,
      permissionProfileId: evaluation.permissionProfileId,
      localOperatorOverrideId: evaluation.localOperatorOverrideId,
      countsTowardLimits: evaluation.allowed,
    });

    if (!evaluation.allowed) {
      const reason = `blocked: ${evaluation.policyReason}`;
      await this.recordBlocked(auditEventId, executionRequest, reason, {
        reasonCodes: evaluation.reasonCodes,
        riskLevel: evaluation.riskLevel,
        matchedGrantId: evaluation.matchedGrantId,
        permissionProfileId: evaluation.permissionProfileId,
        localOperatorOverrideId: evaluation.localOperatorOverrideId,
        approvalMode: evaluation.approvalMode,
        approvalId,
      });
      this.storage.pendingApprovalActions.markResolved(approvalId, "failed", { reason });
      this.storage.approvalEvents.append({
        approvalId,
        eventType: "approved_action_executed",
        actorId: "system",
        payload: { outcome: "blocked", reason, auditEventId },
      });
      const completedAt = new Date().toISOString();
      return {
        outcome: "blocked",
        policyReason: reason,
        auditEventId,
        internalCall,
        internalResult: buildInternalToolResult({
          toolName: executionRequest.toolName,
          outcome: "blocked",
          errorKind: "policy_block",
          completedAt,
        }),
        audit: buildToolAuditRecord({
          auditEventId,
          request: executionRequest,
          outcome: "blocked",
          policyReason: reason,
          startedAt,
          completedAt,
          approvalId,
          matchedGrantId: evaluation.matchedGrantId,
          reasonCodes: evaluation.reasonCodes,
          permissionProfileId: evaluation.permissionProfileId,
          localOperatorOverrideId: evaluation.localOperatorOverrideId,
          approvalMode: evaluation.approvalMode,
          errorKind: "policy_block",
        }),
      };
    }

    const result = await this.executeAllowedRequest(
      executionRequest,
      auditEventId,
      `allowed_via_approval:${approvalId}`,
      evaluation.grantToConsume,
      startedAt,
      evaluation.matchedGrantId,
      approvalId,
      evaluation,
      internalCall,
    );

    if (options?.deferResolution !== true) {
      this.storage.pendingApprovalActions.markResolved(
        approvalId,
        result.outcome === "executed" ? "executed" : "failed",
        {
          outcome: result.outcome,
          policyReason: result.policyReason,
          auditEventId,
          result: result.result,
        },
      );

      this.storage.approvalEvents.append({
        approvalId,
        eventType: "approved_action_executed",
        actorId: "system",
        payload: {
          toolName: approvedRequest.toolName,
          outcome: result.outcome,
          policyReason: result.policyReason,
          auditEventId,
        },
      });
    }

    return result;
  }

  private evaluateAccessInternal(request: ToolAccessEvaluateRequest): AccessEvaluation {
    const toolDef = this.registry.get(request.toolName);
    const capabilityPolicy = deriveToolCapabilityPolicy(request.toolName, toolDef);
    const riskLevel = toolDef?.riskLevel ?? "caution";
    const shellRisk = this.evaluateShellRisk(request);
    const argumentRisk = this.evaluateArgumentRisk(request);
    const policy = resolveEffectivePolicy(
      this.config,
      request.agentId,
      request.policyContext?.permissionProfile,
      request.policyContext?.localOperatorOverride,
    );
    const localOperatorOverrideAuditId = policy.localOperatorOverrideId;
    const withPolicy = (evaluation: AccessEvaluation): AccessEvaluation => ({
      ...evaluation,
      permissionProfileId: policy.permissionProfileId,
      localOperatorOverrideId: localOperatorOverrideAuditId,
      approvalMode: policy.approvalMode,
    });
    if (matchesAnyToolPattern(policy.denySet, request.toolName)) {
      return withPolicy(deny(riskLevel, "policy_deny", "tool denied by policy"));
    }

    if (!toolDef) {
      return withPolicy(deny(riskLevel, "unknown_tool", `unknown tool ${request.toolName}`));
    }

    // Effective Citadel scope. Gateway runtime paths resolve the parent Citadel
    // from the workspace and pass it on the request, so Wards always enforce on
    // the correct scope. Requests without a citadelId are unscoped (global) and
    // simply skip Ward evaluation.
    const effectiveCitadelId = request.citadelId;

    // Citadel Wards (deny-wins) gate the request before grants.
    const rawWardEffect = effectiveCitadelId
      ? this.evaluateCitadelWards(effectiveCitadelId, request.toolName)
      : undefined;
    // The matched effect surfaced to callers: `evaluateWards` returns "allow" on
    // no-match, so collapse both "allow" and absence to `undefined`. Set ONLY when
    // a Ward actually matched with a non-allow effect. Threaded onto every post-ward
    // return via `withWard` so downstream execution can enforce the effects the
    // engine does not itself gate (require_dry_run / route_local / redact).
    const matchedWardEffect: WardEffect | undefined =
      rawWardEffect && rawWardEffect !== "allow" ? rawWardEffect : undefined;
    const withWard = (evaluation: AccessEvaluation): AccessEvaluation => ({
      ...evaluation,
      wardEffect: matchedWardEffect,
    });
    if (rawWardEffect === "deny") {
      return withWard(
        withPolicy(deny(riskLevel, "citadel_ward_deny", `tool ${request.toolName} denied by a Citadel Ward`)),
      );
    }
    const wardRequiresApproval = rawWardEffect === "require_approval";

    const grantDecision = this.resolveGrantDecision(request, toolDef);
    if (grantDecision?.decision === "deny") {
      return withWard({
        allowed: false,
        reasonCodes: ["grant_deny"],
        requiresApproval: false,
        matchedGrantId: grantDecision.grant.grantId,
        riskLevel,
        policyReason: "tool denied by scoped grant",
        permissionProfileId: policy.permissionProfileId,
        localOperatorOverrideId: localOperatorOverrideAuditId,
        approvalMode: policy.approvalMode,
      });
    }

    const allowGrants =
      grantDecision?.decision === "allow" ? (grantDecision.allowGrants ?? [grantDecision.grant]) : undefined;

    const structuralError = this.validateStructuralSafety(request, policy, allowGrants);
    if (structuralError) {
      return withWard(withPolicy(deny(riskLevel, "structural_safety_block", structuralError)));
    }

    if (isUntrustedToolEscalation(resolveToolTrustLevel(request), capabilityPolicy)) {
      return withWard(
        withPolicy(
          deny(
            riskLevel,
            "untrusted_source_privileged_tool_block",
            `tool ${request.toolName} is blocked because untrusted external content cannot escalate into privileged execution`,
          ),
        ),
      );
    }

    if (grantDecision?.decision === "allow" && grantDecision.constraintsError) {
      return withWard({
        allowed: false,
        reasonCodes: ["grant_constraints_block"],
        requiresApproval: false,
        matchedGrantId: grantDecision.grant.grantId,
        riskLevel,
        policyReason: grantDecision.constraintsError,
        permissionProfileId: policy.permissionProfileId,
        localOperatorOverrideId: localOperatorOverrideAuditId,
        approvalMode: policy.approvalMode,
      });
    }

    const inProfile = matchesAnyToolPattern(policy.effectiveTools, request.toolName);
    const hasAllowGrant = grantDecision?.decision === "allow";
    if (!inProfile && !hasAllowGrant) {
      return withWard(withPolicy(deny(riskLevel, "policy_disallow", "tool not available in resolved policy")));
    }

    let requiresApproval =
      wardRequiresApproval ||
      (!hasAllowGrant && (policy.approvalMode === "approve_all" || Boolean(toolDef?.requiresApproval)));
    const outsideRootsReadRequiresApproval = this.requiresApprovalForOutsideRootsRead(request, policy, allowGrants);

    if (
      riskLevel === "danger" &&
      grantDecision?.decision === "allow" &&
      isMutationTool(toolDef) &&
      this.isFirstMutationInScope(
        request,
        this.resolveEffectiveAllowGrant(request, policy, grantDecision.grant, allowGrants) ?? grantDecision.grant,
      )
    ) {
      requiresApproval = true;
    }

    if (riskLevel === "nuclear") {
      requiresApproval = true;
    }
    if (shellRisk?.risky) {
      requiresApproval = true;
    }
    if (argumentRisk?.risky) {
      requiresApproval = true;
    }
    if (outsideRootsReadRequiresApproval) {
      requiresApproval = true;
    }
    if (policy.approvalMode === "approve_risky" && riskLevel !== "safe" && !hasAllowGrant) {
      requiresApproval = true;
    }
    const codeModeRunPreapproved = Boolean(request.policyContext?.approvedCodeModeRunId);
    if (
      codeModeRunPreapproved &&
      !wardRequiresApproval &&
      riskLevel !== "nuclear" &&
      !shellRisk?.risky &&
      !argumentRisk?.risky &&
      !outsideRootsReadRequiresApproval
    ) {
      requiresApproval = false;
    }
    // A remote A2A peer (lowest-trust inbound actor) must not ride the local
    // operator's blanket bypass mode to auto-execute risky/danger tools. Approval
    // (or an explicit scoped allow-grant, handled above) is still required.
    const isRemoteA2APeer = request.policyContext?.authActorSource === "a2a_peer";
    if (
      policy.approvalMode === "bypass" &&
      !wardRequiresApproval &&
      !isRemoteA2APeer &&
      riskLevel !== "nuclear" &&
      !shellRisk?.risky &&
      !argumentRisk?.risky &&
      !outsideRootsReadRequiresApproval
    ) {
      requiresApproval = false;
    }

    const { reasonCodes, policyReason } = this.buildAccessReason({
      policy,
      localOperatorOverrideAuditId,
      codeModeRunPreapproved,
      wardRequiresApproval,
      matchedWardEffect,
      riskLevel,
      hasAllowGrant,
      requiresApproval,
      shellRisk,
      argumentRisk,
      outsideRootsReadRequiresApproval,
    });
    const effectiveAllowGrant =
      grantDecision?.decision === "allow"
        ? (this.resolveEffectiveAllowGrant(request, policy, grantDecision.grant, allowGrants) ?? grantDecision.grant)
        : undefined;

    return withWard({
      allowed: true,
      reasonCodes,
      requiresApproval,
      matchedGrantId: effectiveAllowGrant?.grantId,
      matchedGrantAllowedHosts: effectiveAllowGrant ? getAllowedGrantHosts(effectiveAllowGrant.constraints) : undefined,
      riskLevel,
      policyReason,
      grantToConsume: effectiveAllowGrant?.grantId,
      permissionProfileId: policy.permissionProfileId,
      localOperatorOverrideId: localOperatorOverrideAuditId,
      approvalMode: policy.approvalMode,
    });
  }

  /**
   * Assemble the approval-escalation reason codes + human narrative from the already-computed
   * decision state. Pure projection (no decision logic) extracted from evaluateAccessInternal so
   * the "why" of the escalation axis is a named, auditable unit. Behavior-preserving.
   */
  private buildAccessReason(input: {
    policy: { permissionProfileId?: string; approvalMode: string };
    localOperatorOverrideAuditId: string | undefined;
    codeModeRunPreapproved: boolean;
    wardRequiresApproval: boolean;
    matchedWardEffect: WardEffect | undefined;
    riskLevel: AccessEvaluation["riskLevel"];
    hasAllowGrant: boolean;
    requiresApproval: boolean;
    shellRisk: { risky: true; matchedPattern: string } | undefined;
    argumentRisk: { risky: true; matchedPattern: string } | undefined;
    outsideRootsReadRequiresApproval: boolean;
  }): { reasonCodes: string[]; policyReason: string } {
    const {
      policy,
      localOperatorOverrideAuditId,
      codeModeRunPreapproved,
      wardRequiresApproval,
      matchedWardEffect,
      riskLevel,
      hasAllowGrant,
      requiresApproval,
      shellRisk,
      argumentRisk,
      outsideRootsReadRequiresApproval,
    } = input;
    const reasonCodes = ["allowed"];
    if (policy.permissionProfileId) {
      reasonCodes.push("permission_profile");
    }
    if (localOperatorOverrideAuditId) {
      reasonCodes.push("local_operator_override");
    }
    if (codeModeRunPreapproved) {
      reasonCodes.push("approved_code_mode_run");
    }
    if (wardRequiresApproval) {
      reasonCodes.push("citadel_ward_requires_approval");
    }
    // Audit the previously-silent Ward effects (require_dry_run / route_local /
    // redact) so a matched-but-dropped Ward leaves evidence in reason_codes. deny
    // and require_approval already emit their own codes upstream, so they are the
    // only WardEffects excluded here.
    if (
      matchedWardEffect === "require_dry_run" ||
      matchedWardEffect === "route_local" ||
      matchedWardEffect === "redact"
    ) {
      reasonCodes.push(`citadel_ward_${matchedWardEffect}`);
    }
    if (policy.approvalMode === "bypass") {
      reasonCodes.push("approval_bypass_mode");
      if (riskLevel === "nuclear") {
        reasonCodes.push("nuclear_risk_requires_approval");
      }
    } else if (policy.approvalMode === "approve_all" && !hasAllowGrant) {
      reasonCodes.push("approval_mode_all");
    } else if (riskLevel !== "safe" && !hasAllowGrant) {
      reasonCodes.push("approval_mode_risky");
    }
    let policyReason = "allowed";
    if (wardRequiresApproval) {
      policyReason = "approval required by Citadel Ward";
    } else if (policy.approvalMode === "bypass" && riskLevel === "nuclear") {
      policyReason = "nuclear-risk tools require approval even when normal approvals are bypassed";
    } else if (codeModeRunPreapproved && !requiresApproval) {
      policyReason = "allowed by approved Code Mode run";
    } else if (policy.approvalMode === "bypass") {
      policyReason = "allowed by bypass approval mode";
    } else if (requiresApproval) {
      policyReason = "approval required by approval mode";
    }
    if (shellRisk?.risky) {
      reasonCodes.push("shell_risky_requires_approval");
      policyReason = `risky shell command matched policy pattern "${shellRisk.matchedPattern}"`;
    }
    if (argumentRisk?.risky) {
      reasonCodes.push("argument_risky_requires_approval");
      policyReason = `risky tool argument matched policy pattern "${argumentRisk.matchedPattern}"`;
    }
    if (outsideRootsReadRequiresApproval) {
      reasonCodes.push("outside_roots_read_requires_approval");
      policyReason = "file access outside trusted roots requires approval";
    }
    return { reasonCodes, policyReason };
  }

  private evaluateShellRisk(request: ToolAccessEvaluateRequest): { risky: true; matchedPattern: string } | undefined {
    if (request.toolName !== "shell.exec") {
      return undefined;
    }
    const command = typeof request.args?.command === "string" ? request.args.command : "";
    if (!command.trim()) {
      return undefined;
    }
    const risk = classifyShellRisk(command, this.config.sandbox.riskyShellPatterns);
    if (!risk.risky || !this.config.sandbox.requireApprovalForRiskyShell) {
      return undefined;
    }
    return {
      risky: true,
      matchedPattern: risk.matchedPattern ?? "unknown",
    };
  }

  private evaluateArgumentRisk(
    request: ToolAccessEvaluateRequest,
  ): { risky: true; matchedPattern: string; toolNamePattern?: string } | undefined {
    const patterns = this.config.sandbox.riskyArgumentPatterns;
    if (!patterns || patterns.length === 0) {
      return undefined;
    }
    const risk = classifyArgumentRisk(request.toolName, request.args, patterns);
    if (!risk.risky) {
      return undefined;
    }
    return {
      risky: true,
      matchedPattern: risk.matchedPattern ?? "unknown",
      toolNamePattern: risk.toolNamePattern,
    };
  }

  /**
   * Consult the Citadel's Wards (deny-wins) for an action. Returns undefined when the
   * citadel repo is unavailable (e.g. a minimal storage stub) so callers fall through
   * to the normal grant path. Architecture decision: the engine consults the
   * `citadel_wards` table directly (preserving the rich WardEffects) rather than
   * mirroring Wards into tool-grants (which would be lossy to allow/deny).
   */
  private evaluateCitadelWards(citadelId: string, action: string): WardEffect | undefined {
    const citadelRepo = this.storage.citadels as { listWards?: (id: string) => CitadelWardRecord[] } | undefined;
    if (!citadelRepo?.listWards) {
      return undefined;
    }
    return evaluateWards(citadelRepo.listWards(citadelId), action);
  }

  private resolveGrantDecision(
    request: ToolAccessEvaluateRequest,
    toolDef?: ToolDefinition,
  ): GrantDecision | undefined {
    const scoped = buildScopeCandidates(request);
    const matchingGrants: ToolGrantRecord[] = [];
    for (const candidate of scoped) {
      const grantRepo = this.storage.toolGrants as ActiveToolGrantRepository;
      const grants = (
        grantRepo.listActive
          ? grantRepo.listActive(candidate.scope, candidate.scopeRef)
          : grantRepo
              .list(candidate.scope, candidate.scopeRef, Number.MAX_SAFE_INTEGER)
              .filter((grant) => isGrantActive(grant))
      ).filter(
        (grant) =>
          grant.scope === candidate.scope &&
          grant.scopeRef === candidate.scopeRef &&
          matchesToolPattern(grant.toolPattern, request.toolName),
      );

      if (grants.length === 0) {
        continue;
      }
      matchingGrants.push(...grants);
    }

    const denyGrant = matchingGrants.find((grant) => grant.decision === "deny");
    if (denyGrant) {
      return { decision: "deny", grant: denyGrant };
    }

    const allowedGrants: ToolGrantRecord[] = [];
    let firstConstrainedAllow:
      | {
          grant: ToolGrantRecord;
          constraintsError: string;
        }
      | undefined;
    for (const grant of matchingGrants) {
      if (grant.decision !== "allow") {
        continue;
      }
      const constraintsError = this.applyGrantConstraints(request, grant, toolDef);
      if (!constraintsError) {
        allowedGrants.push(grant);
        continue;
      }
      firstConstrainedAllow ??= { grant, constraintsError };
    }

    if (allowedGrants.length > 0) {
      const firstAllowedGrant = allowedGrants[0];
      if (firstAllowedGrant) {
        return { decision: "allow", grant: firstAllowedGrant, allowGrants: allowedGrants };
      }
    }

    if (firstConstrainedAllow) {
      return {
        decision: "allow",
        grant: firstConstrainedAllow.grant,
        constraintsError: firstConstrainedAllow.constraintsError,
      };
    }

    return undefined;
  }

  private applyGrantConstraints(
    request: ToolAccessEvaluateRequest,
    grant: ToolGrantRecord,
    toolDef?: ToolDefinition,
  ): string | undefined {
    const constraints = grant.constraints;
    if (!constraints) {
      return undefined;
    }

    if (constraints.mutationAllowed === false && isMutationTool(toolDef)) {
      return "grant disallows mutation actions";
    }

    if (typeof constraints.maxCallsPerHour === "number") {
      const count = this.storage.toolAccessDecisions.countToolCallsInLastHourInScope({
        toolName: request.toolName,
        scope: grant.scope,
        agentId: request.agentId,
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        taskId: request.taskId,
      });
      if (count >= constraints.maxCallsPerHour) {
        return `grant maxCallsPerHour exceeded (${constraints.maxCallsPerHour})`;
      }
    }

    if (typeof constraints.maxWritesPerHour === "number" && isMutationTool(toolDef)) {
      const count = this.storage.toolAccessDecisions.countWritesInLastHourInScope({
        scope: grant.scope,
        agentId: request.agentId,
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        taskId: request.taskId,
      });
      if (count >= constraints.maxWritesPerHour) {
        return `grant maxWritesPerHour exceeded (${constraints.maxWritesPerHour})`;
      }
    }

    const docsIngestSourceType =
      request.toolName === "docs.ingest" ? readDocsIngestSourceTypeIfValid(request) : undefined;

    if (constraints.allowedHosts && constraints.allowedHosts.length > 0) {
      if (request.toolName === "docs.ingest" && docsIngestSourceType !== "url") {
        return "grant host constraints require a URL docs.ingest source";
      }
      const candidates = extractGrantHostCandidates(request, this.storage);
      if (candidates.length === 0 && request.toolName === "docs.ingest") {
        return "grant host constraints require a URL docs.ingest source";
      }
      if (candidates.length > 0) {
        const blocked = candidates.some((host) => !matchesHostAllowlist(host, constraints.allowedHosts as string[]));
        if (blocked) {
          return "grant host constraints blocked this action";
        }
      }
    }

    if (constraints.allowedPaths && constraints.allowedPaths.length > 0) {
      if (request.toolName === "docs.ingest" && docsIngestSourceType !== "file") {
        return "grant path constraints require a file docs.ingest source";
      }
      const candidates = extractGrantPathCandidates(request).map((candidate) =>
        this.resolvePathForGrantConstraint(candidate),
      );
      if (
        candidates.length === 0 &&
        (requiresExplicitPathForGrantConstraints(request.toolName) || request.toolName === "docs.ingest")
      ) {
        return "grant path constraints require an explicit output path";
      }
      if (candidates.length > 0) {
        const blocked = candidates.some(
          (candidate) => !isPathWithinAnyRoot(candidate, constraints.allowedPaths as string[]),
        );
        if (blocked) {
          return "grant path constraints blocked this action";
        }
      }
    }

    const referenceRoots = getReferenceRootPaths(constraints);
    if (referenceRoots.length > 0) {
      const candidates = extractGrantPathCandidates(request).map((candidate) =>
        this.resolvePathForGrantConstraint(candidate),
      );
      if (candidates.length === 0 && requiresExplicitPathForGrantConstraints(request.toolName)) {
        return "grant path constraints require an explicit output path";
      }
      if (isMutationTool(toolDef) && candidates.some((candidate) => isPathWithinAnyRoot(candidate, referenceRoots))) {
        return "reference roots are read-only";
      }
    }

    return undefined;
  }

  private isFirstMutationInScope(request: ToolAccessEvaluateRequest, grant: ToolGrantRecord): boolean {
    return (
      this.storage.toolAccessDecisions.countToolCallsInLastHourInScope({
        toolName: request.toolName,
        scope: grant.scope,
        agentId: request.agentId,
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        taskId: request.taskId,
      }) === 0
    );
  }

  private validateStructuralSafety(
    request: ToolAccessEvaluateRequest,
    policy?: EffectiveToolPolicy,
    allowGrants?: ToolGrantRecord[],
  ): string | undefined {
    try {
      const readPathError = this.validateReadPaths(
        request,
        policy ?? resolveEffectivePolicy(this.config, request.agentId),
        allowGrants,
      );
      if (readPathError) {
        return readPathError;
      }

      const writePathCandidates = extractWritePathCandidates(request);
      if (requiresExplicitWritePath(request.toolName) && writePathCandidates.length === 0) {
        return `${request.toolName} requires a target path.`;
      }
      for (const pathValue of writePathCandidates) {
        const referenceRoots = getReferenceRootPaths(allowGrants?.[0]?.constraints);
        const targetsReferenceRoot = referenceRoots.length > 0 && isPathWithinAnyRoot(pathValue, referenceRoots);
        if (!targetsReferenceRoot) {
          assertWritePathInJail(pathValue, this.config.sandbox.writeJailRoots);
        }
      }

      if (request.toolName.startsWith("http.") || request.toolName === "webhook.send") {
        const target = String(request.args?.url ?? request.args?.host ?? "");
        if (!target) {
          // Fail closed: a network tool with no resolvable target must not slip
          // past the host allowlist by simply omitting `url`/`host`. Every
          // http.*/webhook.send tool requires an explicit destination.
          return `${request.toolName} requires a url or host target.`;
        }
        assertHostAllowedForRequest(target, request, this.config);
      }

      const docsIngestSourceType = readDocsIngestSourceType(request);
      const docsIngestBackend = docsIngestSourceType ? readDocsIngestBackend(request) : undefined;
      if (docsIngestSourceType === "url") {
        const source = String(request.args?.source ?? "");
        if (source) {
          assertHostAllowedForRequest(source, request, this.config);
        }
        if (docsIngestBackend === "firecrawl") {
          const firecrawlBaseUrl = String(
            request.args?.firecrawlBaseUrl ?? process.env.FIRECRAWL_BASE_URL ?? "http://127.0.0.1:3002",
          );
          assertFirecrawlBaseUrlAllowedForConfig(firecrawlBaseUrl, this.config);
        }
      }

      if (request.toolName.startsWith("browser.")) {
        const target = String(request.args?.url ?? "");
        if (target) {
          assertHostAllowedForRequest(target, request, this.config);
        }
        if (request.args?.backend === "firecrawl") {
          assertFirecrawlBaseUrlAllowedForConfig(readFirecrawlBaseUrl(request.args), this.config);
        }
        if (request.toolName === "browser.search") {
          validateBrowserSearchHosts(request, this.config);
        }
      }
    } catch (error) {
      return (error as Error).message;
    }

    return undefined;
  }

  private validateReadPaths(
    request: ToolAccessEvaluateRequest,
    policy: EffectiveToolPolicy,
    allowGrants?: ToolGrantRecord[],
  ): string | undefined {
    const readAccessMode = this.getReadAccessMode(policy);
    for (const target of extractReadPathCandidates(request)) {
      const access = resolveReadPathAccess(
        target,
        this.config.sandbox.writeJailRoots,
        this.config.sandbox.readOnlyRoots,
      );
      if (access.withinRoots) {
        continue;
      }
      if (readAccessMode === "full_disk") {
        continue;
      }
      if (readAccessMode === "approval_required" && this.hasApprovalBypass(request)) {
        continue;
      }
      if (this.anyGrantAllowsReadPath(allowGrants, access.resolvedPath)) {
        continue;
      }
      if (readAccessMode === "approval_required") {
        continue;
      }
      return `Path is outside read allowlist: ${access.resolvedPath}`;
    }
    return undefined;
  }

  private requiresApprovalForOutsideRootsRead(
    request: ToolAccessEvaluateRequest,
    policy: EffectiveToolPolicy,
    allowGrants?: ToolGrantRecord[],
  ): boolean {
    if (this.getReadAccessMode(policy) !== "approval_required") {
      return false;
    }
    if (this.hasApprovalBypass(request)) {
      return false;
    }
    for (const target of extractReadPathCandidates(request)) {
      const access = resolveReadPathAccess(
        target,
        this.config.sandbox.writeJailRoots,
        this.config.sandbox.readOnlyRoots,
      );
      if (!access.withinRoots && !this.anyGrantAllowsReadPath(allowGrants, access.resolvedPath)) {
        return true;
      }
    }
    return false;
  }

  private hasApprovalBypass(request: ToolAccessEvaluateRequest): boolean {
    return hasVerifiedApprovalBypass(request, this.storage);
  }

  private grantAllowsReadPath(grant: ToolGrantRecord | undefined, resolvedPath: string): boolean {
    const allowedPaths = getAllowedReadPaths(grant?.constraints);
    if (allowedPaths.length === 0) {
      return false;
    }
    return isPathWithinAnyRoot(resolvedPath, allowedPaths);
  }

  private anyGrantAllowsReadPath(grants: ToolGrantRecord[] | undefined, resolvedPath: string): boolean {
    return grants?.some((grant) => this.grantAllowsReadPath(grant, resolvedPath)) ?? false;
  }

  private resolveEffectiveAllowGrant(
    request: ToolAccessEvaluateRequest,
    policy: EffectiveToolPolicy,
    fallback: ToolGrantRecord | undefined,
    allowGrants?: ToolGrantRecord[],
  ): ToolGrantRecord | undefined {
    return this.resolveGrantForOutsideRootsRead(request, policy, allowGrants) ?? fallback;
  }

  private resolveGrantForOutsideRootsRead(
    request: ToolAccessEvaluateRequest,
    policy: EffectiveToolPolicy,
    allowGrants?: ToolGrantRecord[],
  ): ToolGrantRecord | undefined {
    if (!allowGrants?.length || this.getReadAccessMode(policy) === "full_disk") {
      return undefined;
    }
    if (this.getReadAccessMode(policy) === "approval_required" && this.hasApprovalBypass(request)) {
      return undefined;
    }
    for (const target of extractReadPathCandidates(request)) {
      const access = resolveReadPathAccess(
        target,
        this.config.sandbox.writeJailRoots,
        this.config.sandbox.readOnlyRoots,
      );
      if (access.withinRoots) {
        continue;
      }
      const matchingGrant = allowGrants.find((grant) => this.grantAllowsReadPath(grant, access.resolvedPath));
      if (matchingGrant) {
        return matchingGrant;
      }
    }
    return undefined;
  }

  private resolvePathForGrantConstraint(pathValue: string): string {
    try {
      return resolveReadPathAccess(pathValue, this.config.sandbox.writeJailRoots, this.config.sandbox.readOnlyRoots)
        .resolvedPath;
    } catch {
      return path.resolve(pathValue);
    }
  }

  private getReadAccessMode(policy?: EffectiveToolPolicy): FilesystemReadAccessMode {
    return policy?.readAccessMode ?? this.config.sandbox.readAccessMode ?? "roots_only";
  }

  private buildApprovalPreview(request: ToolInvokeRequest): Record<string, unknown> {
    const preview: Record<string, unknown> = {
      toolName: request.toolName,
      sessionId: request.sessionId,
      taskId: request.taskId,
    };

    const pathValue = request.args.path ?? request.args.to ?? request.args.from;
    if (pathValue) {
      preview.path = String(pathValue);
    }

    const target = request.args.url ?? request.args.target ?? request.args.host;
    if (target) {
      preview.target = String(target);
    }

    if (request.toolName === "shell.exec" && request.args.command) {
      preview.command = String(request.args.command);
    }

    return preview;
  }

  private async executeAllowedRequest(
    request: ToolInvokeRequest,
    auditEventId: string,
    policyReason: string,
    grantIdToConsume?: string,
    startedAt?: string,
    matchedGrantId?: string,
    approvalId?: string,
    evaluation?: AccessEvaluation,
    internalCall?: ReturnType<typeof buildInternalToolCall>,
  ): Promise<ToolInvokeResult> {
    const executionRequest = withExecutionGrantContext(request, evaluation);
    if (grantIdToConsume && !this.storage.toolGrants.consumeOne(grantIdToConsume)) {
      const reason = "blocked: one-time tool grant is no longer available";
      await this.recordBlocked(auditEventId, request, reason, {
        matchedGrantId: matchedGrantId ?? grantIdToConsume,
        permissionProfileId: evaluation?.permissionProfileId,
        localOperatorOverrideId: evaluation?.localOperatorOverrideId,
        approvalMode: evaluation?.approvalMode,
        reasonCodes: evaluation?.reasonCodes,
      });
      const completedAt = new Date().toISOString();
      return {
        outcome: "blocked",
        policyReason: reason,
        auditEventId,
        internalCall,
        internalResult: buildInternalToolResult({
          toolName: request.toolName,
          outcome: "blocked",
          errorKind: "policy_block",
          completedAt,
        }),
        audit: buildToolAuditRecord({
          auditEventId,
          request,
          outcome: "blocked",
          policyReason: reason,
          startedAt: startedAt ?? completedAt,
          completedAt,
          approvalId,
          matchedGrantId: matchedGrantId ?? grantIdToConsume,
          reasonCodes: evaluation?.reasonCodes,
          permissionProfileId: evaluation?.permissionProfileId,
          localOperatorOverrideId: evaluation?.localOperatorOverrideId,
          approvalMode: evaluation?.approvalMode,
          errorKind: "policy_block",
        }),
      };
    }
    if (request.externalRuntime) {
      const result = {
        externalRuntime: true,
        toolName: request.toolName,
        policyContext: executionRequest.policyContext,
      };
      await this.recordInvocation(auditEventId, request, "executed", policyReason, result, approvalId, evaluation);
      const completedAt = new Date().toISOString();
      return {
        outcome: "executed",
        policyReason,
        auditEventId,
        result,
        wardEffect: evaluation?.wardEffect,
        internalCall,
        internalResult: buildInternalToolResult({
          toolName: request.toolName,
          outcome: "executed",
          result,
          completedAt,
        }),
        audit: buildToolAuditRecord({
          auditEventId,
          request,
          outcome: "executed",
          policyReason,
          startedAt: startedAt ?? completedAt,
          completedAt,
          approvalId,
          matchedGrantId,
          reasonCodes: evaluation?.reasonCodes,
          permissionProfileId: evaluation?.permissionProfileId,
          localOperatorOverrideId: evaluation?.localOperatorOverrideId,
          approvalMode: evaluation?.approvalMode,
        }),
      };
    }
    try {
      const result = await executeTool(executionRequest, this.config, this.storage, this.runtimeHooks);
      await this.recordInvocation(auditEventId, request, "executed", policyReason, result, approvalId, evaluation);
      const completedAt = new Date().toISOString();
      return {
        outcome: "executed",
        policyReason,
        auditEventId,
        result,
        wardEffect: evaluation?.wardEffect,
        internalCall,
        internalResult: buildInternalToolResult({
          toolName: request.toolName,
          outcome: "executed",
          result,
          completedAt,
        }),
        audit: buildToolAuditRecord({
          auditEventId,
          request,
          outcome: "executed",
          policyReason,
          startedAt: startedAt ?? completedAt,
          completedAt,
          approvalId,
          matchedGrantId,
          reasonCodes: evaluation?.reasonCodes,
          permissionProfileId: evaluation?.permissionProfileId,
          localOperatorOverrideId: evaluation?.localOperatorOverrideId,
          approvalMode: evaluation?.approvalMode,
        }),
      };
    } catch (error) {
      const reason = `execution error: ${(error as Error).message}`;
      await this.recordBlocked(auditEventId, request, reason, {
        error: (error as Error).message,
        matchedGrantId,
        permissionProfileId: evaluation?.permissionProfileId,
        localOperatorOverrideId: evaluation?.localOperatorOverrideId,
        approvalMode: evaluation?.approvalMode,
        reasonCodes: evaluation?.reasonCodes,
      });
      const completedAt = new Date().toISOString();
      return {
        outcome: "blocked",
        policyReason: reason,
        auditEventId,
        internalCall,
        internalResult: buildInternalToolResult({
          toolName: request.toolName,
          outcome: "blocked",
          errorKind: "execution_error",
          completedAt,
        }),
        audit: buildToolAuditRecord({
          auditEventId,
          request,
          outcome: "blocked",
          policyReason: reason,
          startedAt: startedAt ?? completedAt,
          completedAt,
          approvalId,
          matchedGrantId,
          reasonCodes: evaluation?.reasonCodes,
          permissionProfileId: evaluation?.permissionProfileId,
          localOperatorOverrideId: evaluation?.localOperatorOverrideId,
          approvalMode: evaluation?.approvalMode,
          errorKind: "execution_error",
        }),
      };
    }
  }

  private async recordBlocked(
    auditEventId: string,
    request: ToolInvokeRequest,
    reason: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date().toISOString();
    const matchedGrantId = readNonEmptyString(details.matchedGrantId);
    const permissionProfileId = readNonEmptyString(details.permissionProfileId);
    const localOperatorOverrideId = readNonEmptyString(details.localOperatorOverrideId);
    const approvalMode = readApprovalMode(details.approvalMode);
    const reasonCodes = readReasonCodes(details.reasonCodes);
    this.storage.db
      .prepare(
        `
      INSERT INTO policy_blocks (
        audit_event_id, timestamp, agent_id, session_id, task_id, run_id, tool_name, reason, details_json,
        matched_grant_id, permission_profile_id, local_operator_override_id, approval_mode, reason_codes_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        auditEventId,
        now,
        request.agentId,
        request.sessionId,
        request.taskId ?? null,
        request.runId ?? null,
        request.toolName,
        reason,
        JSON.stringify(details),
        matchedGrantId ?? null,
        permissionProfileId ?? null,
        localOperatorOverrideId ?? null,
        approvalMode ?? null,
        reasonCodes ? JSON.stringify(reasonCodes) : null,
      );

    await this.storage.audit.append("policy_blocks", {
      auditEventId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId,
      toolName: request.toolName,
      reason,
      details,
      matchedGrantId,
      permissionProfileId,
      localOperatorOverrideId,
      approvalMode,
      reasonCodes,
    });
  }

  private async recordInvocation(
    auditEventId: string,
    request: ToolInvokeRequest,
    outcome: "executed" | "approval_required" | "blocked",
    policyReason: string,
    result?: Record<string, unknown>,
    approvalId?: string,
    evaluation?: AccessEvaluation,
  ): Promise<void> {
    const now = new Date().toISOString();
    const sanitizedArgs = sanitizeForModel(request.args);
    const sanitizedResult = result ? sanitizeForModel(result) : undefined;
    this.storage.db
      .prepare(
        `
      INSERT INTO tool_invocations (
        audit_event_id, timestamp, agent_id, session_id, task_id, run_id, tool_name,
        outcome, policy_reason, args_json, result_json, approval_id, matched_grant_id,
        permission_profile_id, local_operator_override_id, approval_mode, reason_codes_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        auditEventId,
        now,
        request.agentId,
        request.sessionId,
        request.taskId ?? null,
        request.runId ?? null,
        request.toolName,
        outcome,
        policyReason,
        JSON.stringify(sanitizedArgs),
        sanitizedResult ? JSON.stringify(sanitizedResult) : null,
        approvalId ?? null,
        evaluation?.matchedGrantId ?? null,
        evaluation?.permissionProfileId ?? null,
        evaluation?.localOperatorOverrideId ?? null,
        evaluation?.approvalMode ?? null,
        evaluation?.reasonCodes ? JSON.stringify(evaluation.reasonCodes) : null,
      );

    await this.storage.audit.append("tool_invocations", {
      auditEventId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId,
      toolName: request.toolName,
      outcome,
      policyReason,
      approvalId,
      matchedGrantId: evaluation?.matchedGrantId,
      permissionProfileId: evaluation?.permissionProfileId,
      localOperatorOverrideId: evaluation?.localOperatorOverrideId,
      approvalMode: evaluation?.approvalMode,
      reasonCodes: evaluation?.reasonCodes,
      args: sanitizedArgs,
      result: sanitizedResult,
    });
  }

  private async recordDangerProfileNetworkBypassIfNeeded(
    auditEventId: string,
    request: ToolInvokeRequest,
    evaluation?: AccessEvaluation,
  ): Promise<void> {
    const accessEvaluation = evaluation ?? this.evaluateAccessInternal(request);
    if (hasFullWebAccess(request)) {
      await this.recordFullWebAccessNetworkUseIfNeeded(auditEventId, request, accessEvaluation);
      return;
    }
    if (request.dryRun === true || accessEvaluation.approvalMode !== "bypass" || accessEvaluation.requiresApproval) {
      return;
    }
    const bypassedTargets = extractOutboundHostCandidates(request).flatMap((target) => {
      const decision = evaluateDangerousHostBypass(target, this.config.sandbox.networkAllowlist);
      return decision.shouldAudit
        ? [
            {
              target: redactUrlForError(target),
              hostname: decision.hostname,
              reason: decision.reason,
            },
          ]
        : [];
    });
    if (bypassedTargets.length === 0) {
      return;
    }
    await this.storage.audit.append("tool_invocations", {
      auditEventId,
      event: "approval_bypass_mode_network_target",
      agentId: request.agentId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      toolName: request.toolName,
      permissionProfileId: accessEvaluation.permissionProfileId,
      localOperatorOverrideId: accessEvaluation.localOperatorOverrideId,
      targets: bypassedTargets,
    });
  }

  private async recordFullWebAccessNetworkUseIfNeeded(
    auditEventId: string,
    request: ToolInvokeRequest,
    accessEvaluation: AccessEvaluation,
  ): Promise<void> {
    if (request.dryRun === true || !accessEvaluation.allowed || accessEvaluation.requiresApproval) {
      return;
    }
    const publicTargets = extractOutboundHostCandidates(request).flatMap((target) => {
      const decision = evaluateDangerousHostBypass(target, this.config.sandbox.networkAllowlist);
      return decision.shouldAudit
        ? [
            {
              target: redactUrlForError(target),
              hostname: decision.hostname,
              reason: `Full-web public access allowed network target outside the configured allowlist: ${redactUrlForError(target)}`,
            },
          ]
        : [];
    });
    if (publicTargets.length === 0) {
      return;
    }
    await this.storage.audit.append("tool_invocations", {
      auditEventId,
      event: "full_web_access_public_network_target",
      agentId: request.agentId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      runId: request.runId,
      toolName: request.toolName,
      permissionProfileId: accessEvaluation.permissionProfileId,
      localOperatorOverrideId: accessEvaluation.localOperatorOverrideId,
      targets: publicTargets,
    });
  }
}

type ScopeCandidate = {
  scope: "task" | "agent" | "session" | "chamber" | "citadel" | "workspace" | "global";
  scopeRef: string;
};

function buildScopeCandidates(request: ToolAccessEvaluateRequest): ScopeCandidate[] {
  const out: ScopeCandidate[] = [];
  if (request.taskId) {
    out.push({ scope: "task", scopeRef: request.taskId });
  }
  out.push({ scope: "agent", scopeRef: request.agentId });
  out.push({ scope: "session", scopeRef: request.sessionId });
  // Citadel/Chamber scope appears only when the gateway has resolved those ids.
  // Ordered specific→broad so a Chamber grant's constraints win over a Citadel-wide one;
  // deny-wins is order-independent, so a deny at any of these scopes still blocks.
  if (request.chamberId) {
    out.push({ scope: "chamber", scopeRef: request.chamberId });
  }
  if (request.citadelId) {
    out.push({ scope: "citadel", scopeRef: request.citadelId });
  }
  if (request.workspaceId) {
    out.push({ scope: "workspace", scopeRef: request.workspaceId });
  }
  out.push({ scope: "global", scopeRef: "global" });
  return out;
}

function buildToolApprovalLinkage(
  request: ToolInvokeRequest,
  evaluation: AccessEvaluation,
): ApprovalLinkage | undefined {
  const surface = readApprovalOriginSurface(request.surface ?? request.policyContext?.surface);
  const linkage = stripUndefined({
    workspaceId: readNonEmptyString(request.workspaceId ?? request.policyContext?.workspaceId),
    sessionId: readNonEmptyString(request.sessionId ?? request.policyContext?.sessionId),
    taskId: readNonEmptyString(request.taskId ?? request.policyContext?.taskId),
    runId: readNonEmptyString(request.runId ?? request.policyContext?.runId),
    originSurface: surface,
    toolName: readNonEmptyString(request.toolName),
    actionType: "tool.invoke",
    operatorId: readNonEmptyString(request.policyContext?.operatorId ?? request.consentContext?.operatorId),
    authActorId: readNonEmptyString(request.policyContext?.authActorId),
    authActorSource: request.policyContext?.authActorSource,
    permissionProfileId: readNonEmptyString(
      evaluation.permissionProfileId ?? request.permissionProfileId ?? request.policyContext?.permissionProfileId,
    ),
    localOperatorOverrideId: readNonEmptyString(evaluation.localOperatorOverrideId),
  });
  return Object.keys(linkage).length > 0 ? linkage : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readApprovalMode(value: unknown): ToolApprovalMode | undefined {
  return value === "approve_all" || value === "approve_risky" || value === "bypass" ? value : undefined;
}

function readReasonCodes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const reasonCodes = value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  return reasonCodes.length > 0 ? reasonCodes : undefined;
}

function readApprovalOriginSurface(value: unknown): ApprovalLinkage["originSurface"] | undefined {
  return value === "chat" || value === "cowork" || value === "code" ? value : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function withExecutionGrantContext(request: ToolInvokeRequest, evaluation?: AccessEvaluation): ToolInvokeRequest {
  const allowedHosts = evaluation?.matchedGrantAllowedHosts?.filter((entry) => entry.trim().length > 0);
  if (!evaluation?.matchedGrantId && (!allowedHosts || allowedHosts.length === 0)) {
    return request;
  }
  return {
    ...request,
    policyContext: {
      ...(request.policyContext ?? {}),
      matchedGrantId: evaluation?.matchedGrantId ?? request.policyContext?.matchedGrantId,
      matchedGrantAllowedHosts:
        allowedHosts && allowedHosts.length > 0 ? allowedHosts : request.policyContext?.matchedGrantAllowedHosts,
    },
  };
}

function extractOutboundHostCandidates(request: Pick<ToolAccessEvaluateRequest, "toolName" | "args">): string[] {
  if (request.toolName.startsWith("http.") || request.toolName === "webhook.send") {
    return stringTargets(request.args?.url, request.args?.host);
  }
  if (readDocsIngestSourceTypeIfValid(request) === "url") {
    const targets = stringTargets(request.args?.source);
    if (readDocsIngestBackendIfValid(request) === "firecrawl") {
      targets.push(String(request.args?.firecrawlBaseUrl ?? process.env.FIRECRAWL_BASE_URL ?? "http://127.0.0.1:3002"));
    }
    return targets;
  }
  if (request.toolName.startsWith("browser.")) {
    const targets = stringTargets(request.args?.url);
    if (request.args?.backend === "firecrawl") {
      targets.push(readFirecrawlBaseUrl(request.args));
    }
    return targets;
  }
  return [];
}

function stringTargets(...values: unknown[]): string[] {
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isGrantActive(grant: ToolGrantRecord): boolean {
  if (grant.revokedAt) {
    return false;
  }
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) {
    return false;
  }
  if (typeof grant.usesRemaining === "number" && grant.usesRemaining <= 0) {
    return false;
  }
  return true;
}

function getAllowedGrantHosts(constraints: ToolGrantConstraints | undefined): string[] | undefined {
  const allowedHosts = constraints?.allowedHosts?.map((host) => host.trim()).filter(Boolean);
  return allowedHosts && allowedHosts.length > 0 ? allowedHosts : undefined;
}

function isMutationTool(toolDef?: ToolDefinition): boolean {
  if (!toolDef) {
    return false;
  }
  return toolDef.riskLevel === "danger" || toolDef.riskLevel === "nuclear" || isKnownMutatingToolName(toolDef.name);
}

function isKnownMutatingToolName(toolName: string): boolean {
  return (
    CAUTION_MUTATING_TOOL_NAMES.has(toolName) ||
    /\.(send|react|unsend)$/u.test(toolName) ||
    toolName === "webhook.send" ||
    toolName === "calendar.create_event"
  );
}

const CAUTION_MUTATING_TOOL_NAMES = new Set([
  "fs.copy",
  "git.branch.create",
  "memory.write",
  "memory.upsert",
  "docs.ingest",
  "embeddings.index",
  "artifacts.create",
  "documents.create",
  "presentations.create",
]);

function extractHostCandidates(args?: Record<string, unknown>): string[] {
  if (!args) {
    return [];
  }
  const values: string[] = [];
  const pushIfString = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) {
      values.push(value.trim());
    }
  };

  pushIfString(args.url);
  pushIfString(args.host);
  pushIfString(args.target);
  pushIfString(args.origin);
  pushIfString(args.domain);

  // SECURITY (codex finding #22): Matrix/Mattermost (and other channel)
  // delivery paths accept attachments whose `url` is fetched gateway-side
  // before the upload to the chat provider. The per-grant `allowedHosts`
  // constraint must apply to those URLs too, otherwise a `channel.send`
  // grant becomes a hidden network-read primitive that exfiltrates internal
  // response bodies via the chat upload. We also visit `files[].url` for the
  // same reason.
  for (const collectionKey of ["attachments", "files", "cookies"] as const) {
    const collection = args[collectionKey];
    if (Array.isArray(collection)) {
      for (const item of collection) {
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          pushIfString(record.url);
          pushIfString(record.href);
          pushIfString(record.downloadUrl);
          pushIfString(record.origin);
          pushIfString(record.domain);
          pushIfString(record.host);
        }
      }
    }
  }

  const hosts = new Set<string>();
  for (const value of values) {
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
    } catch {
      hosts.add(value.replace(/^\./u, "").toLowerCase());
    }
  }
  return [...hosts];
}

// Test-only export so the codex #22 regression suite can exercise the
// attachment-walking behaviour without standing up an engine instance.
export const extractHostCandidatesForTests = extractHostCandidates;

function extractGrantHostCandidates(
  request: Pick<ToolAccessEvaluateRequest, "toolName" | "args">,
  storage?: Storage,
): string[] {
  const candidates = extractHostCandidates(request.args);
  const args = request.args;
  if (readDocsIngestSourceTypeIfValid(request) === "url" && typeof args?.source === "string") {
    candidates.push(...extractHostCandidates({ url: args.source }));
  }
  candidates.push(
    ...resolveFixedOutboundHostsForTool(request.toolName, resolveIntegrationConnectionKey(request, storage)),
  );
  return [...new Set(candidates)];
}

function resolveIntegrationConnectionKey(
  request: Pick<ToolAccessEvaluateRequest, "args">,
  storage?: Storage,
): string | undefined {
  const connectionId = request.args?.connectionId;
  if (typeof connectionId !== "string" || !connectionId.trim()) {
    return undefined;
  }
  try {
    return storage?.integrationConnections?.get(connectionId.trim())?.key;
  } catch {
    return undefined;
  }
}

function extractPathCandidates(args?: Record<string, unknown>): string[] {
  if (!args) {
    return [];
  }
  return [args.path, args.from, args.to, args.relativePath, args.outputPath]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

function extractGrantPathCandidates(request: Pick<ToolAccessEvaluateRequest, "toolName" | "args">): string[] {
  const candidates = extractPathCandidates(request.args);
  const args = request.args;
  if (readDocsIngestSourceTypeIfValid(request) === "file" && typeof args?.source === "string" && args.source.trim()) {
    candidates.push(args.source.trim());
  }
  return [...new Set(candidates)];
}

function extractReadPathCandidates(request: ToolAccessEvaluateRequest): string[] {
  const args = request.args;
  if (!args) {
    return [];
  }
  if (
    request.toolName === "fs.read" ||
    request.toolName === "file.read_range" ||
    request.toolName === "file.find" ||
    request.toolName === "code.search" ||
    request.toolName === "code.search_files" ||
    request.toolName === "fs.list" ||
    request.toolName === "fs.stat"
  ) {
    return typeof args.path === "string" ? [args.path] : [];
  }
  if (request.toolName === "fs.copy") {
    return typeof args.from === "string" ? [args.from] : [];
  }
  if (readDocsIngestSourceType(request) === "file") {
    return typeof args.source === "string" ? [args.source] : [];
  }
  return [];
}

function readDocsIngestSourceType(
  request: Pick<ToolAccessEvaluateRequest, "toolName" | "args">,
): IngestionSourceType | undefined {
  if (request.toolName !== "docs.ingest") {
    return undefined;
  }
  return parseIngestionSourceType(request.args?.sourceType);
}

function readDocsIngestSourceTypeIfValid(
  request: Pick<ToolAccessEvaluateRequest, "toolName" | "args">,
): IngestionSourceType | undefined {
  try {
    return readDocsIngestSourceType(request);
  } catch {
    return undefined;
  }
}

function readDocsIngestBackend(request: Pick<ToolAccessEvaluateRequest, "toolName" | "args">): IngestionBackendName {
  if (request.toolName !== "docs.ingest") {
    return "native";
  }
  return parseIngestionBackend(request.args?.backend);
}

function readDocsIngestBackendIfValid(
  request: Pick<ToolAccessEvaluateRequest, "toolName" | "args">,
): IngestionBackendName | undefined {
  try {
    return readDocsIngestBackend(request);
  } catch {
    return undefined;
  }
}

function extractWritePathCandidates(request: ToolAccessEvaluateRequest): string[] {
  const args = request.args;
  if (!args) {
    return [];
  }
  const readString = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  switch (request.toolName) {
    case "fs.write":
    case "artifacts.create":
    case "documents.create":
    case "presentations.create":
      return [readString(args.path)].filter((value): value is string => Boolean(value));
    case "fs.delete":
      return [readString(args.path), readString(args.from)].filter((value): value is string => Boolean(value));
    case "fs.copy":
      return [readString(args.to)].filter((value): value is string => Boolean(value));
    case "fs.move":
      return [readString(args.from), readString(args.to)].filter((value): value is string => Boolean(value));
    case "browser.screenshot":
    case "browser.interact":
      return [readString(args.outputPath), readString(args.path)].filter((value): value is string => Boolean(value));
    default:
      return [];
  }
}

function requiresExplicitWritePath(toolName: string): boolean {
  return toolName === "fs.delete";
}

function requiresExplicitPathForGrantConstraints(toolName: string): boolean {
  return toolName === "browser.screenshot";
}

function matchesHostAllowlist(host: string, patterns: string[]): boolean {
  const normalizedHost = host.toLowerCase();
  return patterns.some((pattern) => {
    const normalized = pattern.toLowerCase().trim();
    if (!normalized) {
      return false;
    }
    if (normalized === "*") {
      return true;
    }
    if (normalized.startsWith("*.")) {
      const suffix = normalized.slice(1);
      return normalizedHost.endsWith(suffix);
    }
    return normalizedHost === normalized;
  });
}

function getAllowedReadPaths(constraints?: ToolGrantConstraints): string[] {
  if (!constraints) {
    return [];
  }
  return [...(constraints.allowedPaths ?? []), ...getReferenceRootPaths(constraints)];
}

function getReferenceRootPaths(constraints?: ToolGrantConstraints): string[] {
  return (constraints?.referenceRoots ?? []).map((item) => item.rootPath);
}

function isPathWithinAnyRoot(candidate: string, roots: string[]): boolean {
  try {
    const resolvedCandidate = normalizePathForMatch(candidate);
    for (const root of roots) {
      if (root.trim() === "*") {
        return true;
      }
      const rootVariants = normalizePathVariantsForMatch(root);
      if (
        rootVariants.some(
          (resolvedRoot) => resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}/`),
        )
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function normalizePathForMatch(value: string): string {
  return path.normalize(path.resolve(value)).replaceAll("\\", "/").replace(/\/+$/, "");
}

function normalizePathVariantsForMatch(value: string): string[] {
  const resolvedValue = normalizePathForMatch(value);
  try {
    const realValue = fs.realpathSync(path.resolve(value)).replaceAll("\\", "/").replace(/\/+$/, "");
    return realValue === resolvedValue ? [resolvedValue] : [resolvedValue, realValue];
  } catch {
    return [resolvedValue];
  }
}

function deny(riskLevel: ToolRiskLevel, code: string, reason: string): AccessEvaluation {
  return {
    allowed: false,
    reasonCodes: [code],
    requiresApproval: false,
    riskLevel,
    policyReason: reason,
  };
}

function asToolInvokeRequest(value: Record<string, unknown>): ToolInvokeRequest {
  const toolName = String(value.toolName ?? "");
  const agentId = String(value.agentId ?? "");
  const sessionId = String(value.sessionId ?? "");
  const args = (value.args ?? {}) as Record<string, unknown>;
  const workspaceId = value.workspaceId ? String(value.workspaceId) : undefined;
  const taskId = value.taskId ? String(value.taskId) : undefined;
  const runId = value.runId ? String(value.runId) : undefined;
  const trustLevel =
    value.trustLevel === "trusted_operator" ||
    value.trustLevel === "trusted_workspace" ||
    value.trustLevel === "mixed_untrusted" ||
    value.trustLevel === "untrusted_external"
      ? value.trustLevel
      : undefined;
  const sourceAttribution = Array.isArray(value.sourceAttribution)
    ? (value.sourceAttribution as ToolInvokeRequest["sourceAttribution"])
    : undefined;
  const authContext =
    value.authContext && typeof value.authContext === "object" && !Array.isArray(value.authContext)
      ? (value.authContext as ToolInvokeRequest["authContext"])
      : undefined;
  const consentContext =
    value.consentContext && typeof value.consentContext === "object"
      ? {
          operatorId:
            typeof (value.consentContext as Record<string, unknown>).operatorId === "string"
              ? String((value.consentContext as Record<string, unknown>).operatorId)
              : undefined,
          source: (value.consentContext as Record<string, unknown>).source as "ui" | "tui" | "agent" | undefined,
          reason:
            typeof (value.consentContext as Record<string, unknown>).reason === "string"
              ? String((value.consentContext as Record<string, unknown>).reason)
              : undefined,
        }
      : undefined;
  const dryRun = typeof value.dryRun === "boolean" ? value.dryRun : undefined;
  const externalRuntime = typeof value.externalRuntime === "boolean" ? value.externalRuntime : undefined;

  if (!toolName || !agentId || !sessionId) {
    throw new Error("Invalid pending action request payload");
  }

  return {
    toolName,
    args,
    agentId,
    sessionId,
    workspaceId,
    taskId,
    runId,
    trustLevel,
    sourceAttribution,
    authContext,
    consentContext,
    permissionProfileId: value.permissionProfileId ? String(value.permissionProfileId) : undefined,
    localOperatorOverrideId: value.localOperatorOverrideId ? String(value.localOperatorOverrideId) : undefined,
    surface:
      value.surface === "chat" ||
      value.surface === "cowork" ||
      value.surface === "code" ||
      value.surface === "tools" ||
      value.surface === "mcp" ||
      value.surface === "all"
        ? value.surface
        : undefined,
    policyContext:
      value.policyContext && typeof value.policyContext === "object"
        ? (value.policyContext as ToolInvokeRequest["policyContext"])
        : undefined,
    dryRun,
    externalRuntime,
  };
}

function toPlainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}
