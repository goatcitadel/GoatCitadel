import type {
  FilesystemReadAccessMode,
  ToolGrantConstraints,
  ToolAccessEvaluateRequest,
  ToolAccessEvaluateResponse,
  ToolGrantCreateInput,
  ToolGrantRecord,
  ToolInvokeRequest,
  ToolInvokeResult,
  ToolPolicyConfig,
  ToolRiskLevel,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { randomUUID } from "node:crypto";
import { ApprovalGate } from "./approval-gate.js";
import { hasVerifiedApprovalBypass } from "./approval-bypass.js";
import { resolveEffectivePolicy } from "./policy-resolver.js";
import { createDefaultToolRegistry, type ToolDefinition, type ToolRegistry } from "./tool-registry.js";
import { matchesAnyToolPattern, matchesToolPattern } from "./tool-patterns.js";
import { assertWritePathInJail, resolveReadPathAccess } from "./sandbox/path-jail.js";
import { assertHostAllowed } from "./sandbox/network-guard.js";
import { classifyShellRisk } from "./sandbox/shell-risk-gate.js";
import { executeTool } from "./tool-executor.js";
import {
  buildInternalToolCall,
  buildInternalToolResult,
  buildToolAuditRecord,
  deriveToolCapabilityPolicy,
  isUntrustedToolEscalation,
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
}

interface GrantDecision {
  decision: "allow" | "deny";
  grant: ToolGrantRecord;
}

export interface ToolPolicyEngineRuntimeOptions {
  isBankrBuiltinEnabled?: () => boolean;
}

const BANKR_OPTIONAL_MIGRATION_MESSAGE =
  "Bankr built-in is disabled. Install the optional skill pack (docs/OPTIONAL_BANKR_SKILL.md; templates/skills/bankr-optional/SKILL.md).";
const DEFAULT_APPROVAL_TTL_MS = 15 * 60_000;

export class ToolPolicyEngine {
  private readonly approvals: ApprovalGate;
  private readonly registry: ToolRegistry;
  private readonly runtimeOptions: Required<ToolPolicyEngineRuntimeOptions>;

  public constructor(
    private readonly config: ToolPolicyConfig,
    private readonly storage: Storage,
    registry?: ToolRegistry,
    runtimeOptions: ToolPolicyEngineRuntimeOptions = {},
  ) {
    this.runtimeOptions = {
      isBankrBuiltinEnabled: runtimeOptions.isBankrBuiltinEnabled ?? (() => false),
    };
    this.registry = registry
      ?? createDefaultToolRegistry({ bankrBuiltinEnabled: this.runtimeOptions.isBankrBuiltinEnabled() });
    this.approvals = new ApprovalGate(storage);
  }

  public listCatalog() {
    const catalog = this.registry.toCatalog();
    if (this.runtimeOptions.isBankrBuiltinEnabled()) {
      return catalog;
    }
    return catalog.filter((tool) => !isBankrToolName(tool.toolName));
  }

  public listGrants(
    scope?: "global" | "session" | "agent" | "task",
    scopeRef?: string,
    limit = 200,
  ): ToolGrantRecord[] {
    return this.storage.toolGrants.list(scope, scopeRef, limit);
  }

  public createGrant(input: ToolGrantCreateInput): ToolGrantRecord {
    return this.storage.toolGrants.create(input);
  }

  public revokeGrant(grantId: string): boolean {
    return this.storage.toolGrants.revoke(grantId);
  }

  public evaluateAccess(input: ToolAccessEvaluateRequest): ToolAccessEvaluateResponse {
    const evaluation = this.evaluateAccessInternal(input);
    this.storage.toolAccessDecisions.record({
      toolName: input.toolName,
      agentId: input.agentId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      allowed: evaluation.allowed,
      reasonCodes: evaluation.reasonCodes,
      matchedGrantId: evaluation.matchedGrantId,
      requiresApproval: evaluation.requiresApproval,
      riskLevel: evaluation.riskLevel,
    });

    return {
      toolName: input.toolName,
      allowed: evaluation.allowed,
      reasonCodes: evaluation.reasonCodes,
      requiresApproval: evaluation.requiresApproval,
      matchedGrantId: evaluation.matchedGrantId,
      riskLevel: evaluation.riskLevel,
    };
  }

  public async invoke(request: ToolInvokeRequest): Promise<ToolInvokeResult> {
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
      taskId: request.taskId,
      allowed: evaluation.allowed,
      reasonCodes: evaluation.reasonCodes,
      matchedGrantId: evaluation.matchedGrantId,
      requiresApproval: evaluation.requiresApproval,
      riskLevel: evaluation.riskLevel,
    });

    if (!evaluation.allowed) {
      const reason = `blocked: ${evaluation.policyReason}`;
      await this.recordBlocked(auditEventId, request, reason, {
        reasonCodes: evaluation.reasonCodes,
        riskLevel: evaluation.riskLevel,
        matchedGrantId: evaluation.matchedGrantId,
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
      );
      const completedAt = new Date().toISOString();
      return {
        outcome: "executed",
        policyReason: `${evaluation.policyReason}; dry-run`,
        auditEventId,
        result,
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
        }),
      };
    }

    if (evaluation.requiresApproval) {
      const expiresAt = new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS).toISOString();
      const approval = await this.approvals.create({
        kind: request.toolName,
        riskLevel: evaluation.riskLevel,
        payload: request.args,
        preview: this.buildApprovalPreview(request),
        expiresAt,
      });

      this.storage.pendingApprovalActions.upsertPending({
        approvalId: approval.approvalId,
        actionType: "tool.invoke",
        request: toPlainRecord(request),
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
          errorKind: "approval_required",
        }),
      };
    }

    return this.executeAllowedRequest(
      request,
      auditEventId,
      evaluation.policyReason,
      evaluation.grantToConsume,
      startedAt,
      evaluation.matchedGrantId,
      undefined,
      internalCall,
    );
  }

  public async executeApprovedAction(approvalId: string): Promise<ToolInvokeResult | undefined> {
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
      consentContext: {
        ...(request.consentContext ?? {}),
        source: request.consentContext?.source ?? "ui",
        reason: `approval:${approvalId}`,
      },
    };
    const auditEventId = randomUUID();
    const startedAt = new Date().toISOString();
    const approvedToolDef = this.registry.get(approvedRequest.toolName);
    const approvedCapabilityPolicy = deriveToolCapabilityPolicy(approvedRequest.toolName, approvedToolDef);
    const internalCall = buildInternalToolCall(approvedRequest, approvedCapabilityPolicy, startedAt);
    const evaluation = this.evaluateAccessInternal(approvedRequest);

    this.storage.toolAccessDecisions.record({
      toolName: approvedRequest.toolName,
      agentId: approvedRequest.agentId,
      sessionId: approvedRequest.sessionId,
      taskId: approvedRequest.taskId,
      allowed: evaluation.allowed,
      reasonCodes: evaluation.reasonCodes,
      matchedGrantId: evaluation.matchedGrantId,
      requiresApproval: false,
      riskLevel: evaluation.riskLevel,
    });

    if (!evaluation.allowed) {
      const reason = `blocked: ${evaluation.policyReason}`;
      await this.recordBlocked(auditEventId, approvedRequest, reason, {
        reasonCodes: evaluation.reasonCodes,
        riskLevel: evaluation.riskLevel,
        matchedGrantId: evaluation.matchedGrantId,
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
          toolName: approvedRequest.toolName,
          outcome: "blocked",
          errorKind: "policy_block",
          completedAt,
        }),
        audit: buildToolAuditRecord({
          auditEventId,
          request: approvedRequest,
          outcome: "blocked",
          policyReason: reason,
          startedAt,
          completedAt,
          approvalId,
          matchedGrantId: evaluation.matchedGrantId,
          errorKind: "policy_block",
        }),
      };
    }

    const result = await this.executeAllowedRequest(
      approvedRequest,
      auditEventId,
      `allowed_via_approval:${approvalId}`,
      evaluation.grantToConsume,
      startedAt,
      evaluation.matchedGrantId,
      approvalId,
      internalCall,
    );

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

    return result;
  }

  private evaluateAccessInternal(request: ToolAccessEvaluateRequest): AccessEvaluation {
    const toolDef = this.registry.get(request.toolName);
    const capabilityPolicy = deriveToolCapabilityPolicy(request.toolName, toolDef);
    const riskLevel = toolDef?.riskLevel ?? "caution";
    const shellRisk = this.evaluateShellRisk(request);
    if (isBankrToolName(request.toolName) && !this.runtimeOptions.isBankrBuiltinEnabled()) {
      return deny(riskLevel, "bankr_builtin_disabled", BANKR_OPTIONAL_MIGRATION_MESSAGE);
    }

    const policy = resolveEffectivePolicy(this.config, request.agentId);
    if (matchesAnyToolPattern(policy.denySet, request.toolName)) {
      return deny(riskLevel, "policy_deny", "tool denied by policy");
    }

    if (!toolDef && !matchesAnyToolPattern(policy.effectiveTools, request.toolName)) {
      return deny(riskLevel, "unknown_tool", `unknown tool ${request.toolName}`);
    }

    const grantDecision = this.resolveGrantDecision(request);
    if (grantDecision?.decision === "deny") {
      return {
        allowed: false,
        reasonCodes: ["grant_deny"],
        requiresApproval: false,
        matchedGrantId: grantDecision.grant.grantId,
        riskLevel,
        policyReason: "tool denied by scoped grant",
      };
    }

    const allowGrant = grantDecision?.decision === "allow" ? grantDecision.grant : undefined;

    const structuralError = this.validateStructuralSafety(request, allowGrant);
    if (structuralError) {
      return deny(riskLevel, "structural_safety_block", structuralError);
    }

    if (isUntrustedToolEscalation(request.trustLevel ?? "trusted_operator", capabilityPolicy)) {
      return deny(
        riskLevel,
        "untrusted_source_privileged_tool_block",
        `tool ${request.toolName} is blocked because untrusted external content cannot escalate into privileged execution`,
      );
    }

    if (riskLevel !== "safe") {
      if (!grantDecision || grantDecision.decision !== "allow") {
        return deny(riskLevel, "grant_required", `tool risk ${riskLevel} requires explicit grant`);
      }

      const constraintsError = this.applyGrantConstraints(request, grantDecision.grant, toolDef);
      if (constraintsError) {
        return {
          allowed: false,
          reasonCodes: ["grant_constraints_block"],
          requiresApproval: false,
          matchedGrantId: grantDecision.grant.grantId,
          riskLevel,
          policyReason: constraintsError,
        };
      }
    }

    const inProfile = matchesAnyToolPattern(policy.effectiveTools, request.toolName);
    const hasAllowGrant = grantDecision?.decision === "allow";
    if (!inProfile && !hasAllowGrant) {
      return deny(riskLevel, "profile_disallow", "tool not available in resolved profile");
    }

    let requiresApproval = Boolean(toolDef?.requiresApproval);
    const outsideRootsReadRequiresApproval = this.requiresApprovalForOutsideRootsRead(request, allowGrant);

    if (
      riskLevel === "danger"
      && grantDecision?.decision === "allow"
      && isMutationTool(toolDef)
      && this.isFirstMutationInScope(request, grantDecision.grant)
    ) {
      requiresApproval = true;
    }

    if (riskLevel === "nuclear") {
      requiresApproval = true;
    }
    if (shellRisk?.risky) {
      requiresApproval = true;
    }
    if (outsideRootsReadRequiresApproval) {
      requiresApproval = true;
    }

    const reasonCodes = ["allowed"];
    let policyReason = requiresApproval ? "approval required by risk gate" : "allowed";
    if (shellRisk?.risky) {
      reasonCodes.push("shell_risky_requires_approval");
      policyReason = `risky shell command matched policy pattern "${shellRisk.matchedPattern}"`;
    }
    if (outsideRootsReadRequiresApproval) {
      reasonCodes.push("outside_roots_read_requires_approval");
      policyReason = "file access outside trusted roots requires approval";
    }

    return {
      allowed: true,
      reasonCodes,
      requiresApproval,
      matchedGrantId: grantDecision?.grant.grantId,
      riskLevel,
      policyReason,
      grantToConsume: grantDecision?.grant.grantId,
    };
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

  private resolveGrantDecision(request: ToolAccessEvaluateRequest): GrantDecision | undefined {
    const scoped = buildScopeCandidates(request);
    const matchingGrants: ToolGrantRecord[] = [];
    for (const candidate of scoped) {
      const grants = this.storage.toolGrants.list(candidate.scope, candidate.scopeRef, 500)
        .filter((grant) => isGrantActive(grant))
        .filter((grant) => matchesToolPattern(grant.toolPattern, request.toolName));

      if (grants.length === 0) {
        continue;
      }
      matchingGrants.push(...grants);
    }

    const denyGrant = matchingGrants.find((grant) => grant.decision === "deny");
    if (denyGrant) {
      return { decision: "deny", grant: denyGrant };
    }

    const allowGrant = matchingGrants.find((grant) => grant.decision === "allow");
    if (allowGrant) {
      return { decision: "allow", grant: allowGrant };
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
        taskId: request.taskId,
      });
      if (count >= constraints.maxWritesPerHour) {
        return `grant maxWritesPerHour exceeded (${constraints.maxWritesPerHour})`;
      }
    }

    if (constraints.allowedHosts && constraints.allowedHosts.length > 0) {
      const candidates = extractHostCandidates(request.args);
      if (candidates.length > 0) {
        const blocked = candidates.some((host) => !matchesHostAllowlist(host, constraints.allowedHosts as string[]));
        if (blocked) {
          return "grant host constraints blocked this action";
        }
      }
    }

    if (constraints.allowedPaths && constraints.allowedPaths.length > 0) {
      const candidates = extractPathCandidates(request.args);
      if (candidates.length > 0) {
        const blocked = candidates.some((candidate) => !isPathWithinAnyRoot(candidate, constraints.allowedPaths as string[]));
        if (blocked) {
          return "grant path constraints blocked this action";
        }
      }
    }

    const referenceRoots = getReferenceRootPaths(constraints);
    if (referenceRoots.length > 0) {
      const candidates = extractPathCandidates(request.args);
      if (isMutationTool(toolDef) && candidates.some((candidate) => isPathWithinAnyRoot(candidate, referenceRoots))) {
        return "reference roots are read-only";
      }
    }

    return undefined;
  }

  private isFirstMutationInScope(request: ToolAccessEvaluateRequest, grant: ToolGrantRecord): boolean {
    return this.storage.toolAccessDecisions.countToolCallsInLastHourInScope({
      toolName: request.toolName,
      scope: grant.scope,
      agentId: request.agentId,
      sessionId: request.sessionId,
      taskId: request.taskId,
    }) === 0;
  }

  private validateStructuralSafety(
    request: ToolAccessEvaluateRequest,
    allowGrant?: ToolGrantRecord,
  ): string | undefined {
    try {
      const readPathError = this.validateReadPaths(request, allowGrant);
      if (readPathError) {
        return readPathError;
      }

      if (request.toolName === "fs.write" || request.toolName === "fs.move" || request.toolName === "fs.delete" || request.toolName === "artifacts.create") {
        const pathValue = String(request.args?.path ?? request.args?.to ?? request.args?.from ?? "");
        const referenceRoots = getReferenceRootPaths(allowGrant?.constraints);
        const targetsReferenceRoot = referenceRoots.length > 0 && isPathWithinAnyRoot(pathValue, referenceRoots);
        if (!targetsReferenceRoot) {
          assertWritePathInJail(pathValue, this.config.sandbox.writeJailRoots);
        }
      }

      if (request.toolName.startsWith("http.") || request.toolName === "webhook.send") {
        const target = String(request.args?.url ?? request.args?.host ?? "");
        if (target) {
          assertHostAllowed(target, this.config.sandbox.networkAllowlist);
        }
      }

      if (request.toolName.startsWith("bankr.")) {
        assertHostAllowed("https://api.bankr.bot", this.config.sandbox.networkAllowlist);
        if (request.args?.useLlmGateway === true) {
          assertHostAllowed("https://llm.bankr.bot", this.config.sandbox.networkAllowlist);
        }
      }

      if (request.toolName === "docs.ingest" && request.args?.sourceType === "url") {
        const source = String(request.args?.source ?? "");
        if (source) {
          assertHostAllowed(source, this.config.sandbox.networkAllowlist);
        }
        if (request.args?.backend === "firecrawl") {
          const firecrawlBaseUrl = String(
            request.args?.firecrawlBaseUrl ?? process.env.FIRECRAWL_BASE_URL ?? "http://127.0.0.1:3002",
          );
          assertHostAllowed(firecrawlBaseUrl, this.config.sandbox.networkAllowlist);
        }
      }

      if (request.toolName.startsWith("browser.")) {
        const target = String(request.args?.url ?? "");
        if (target) {
          assertHostAllowed(target, this.config.sandbox.networkAllowlist);
        }
      }
    } catch (error) {
      return (error as Error).message;
    }

    return undefined;
  }

  private validateReadPaths(
    request: ToolAccessEvaluateRequest,
    allowGrant?: ToolGrantRecord,
  ): string | undefined {
    const readAccessMode = this.getReadAccessMode();
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
      if (this.hasApprovalBypass(request)) {
        continue;
      }
      if (this.grantAllowsReadPath(allowGrant, access.resolvedPath)) {
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
    allowGrant?: ToolGrantRecord,
  ): boolean {
    if (this.getReadAccessMode() !== "approval_required") {
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
      if (!access.withinRoots && !this.grantAllowsReadPath(allowGrant, access.resolvedPath)) {
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

  private getReadAccessMode(): FilesystemReadAccessMode {
    return this.config.sandbox.readAccessMode ?? "roots_only";
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
    internalCall?: ReturnType<typeof buildInternalToolCall>,
  ): Promise<ToolInvokeResult> {
    try {
      const result = await executeTool(request, this.config, this.storage, {
        bankrBuiltinEnabled: this.runtimeOptions.isBankrBuiltinEnabled(),
      });
      if (grantIdToConsume) {
        this.storage.toolGrants.consumeOne(grantIdToConsume);
      }
      await this.recordInvocation(auditEventId, request, "executed", policyReason, result);
      const completedAt = new Date().toISOString();
      return {
        outcome: "executed",
        policyReason,
        auditEventId,
        result,
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
        }),
      };
    } catch (error) {
      const reason = `execution error: ${(error as Error).message}`;
      await this.recordBlocked(auditEventId, request, reason, {
        error: (error as Error).message,
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
    this.storage.db.prepare(`
      INSERT INTO policy_blocks (
        audit_event_id, timestamp, agent_id, session_id, tool_name, reason, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      auditEventId,
      now,
      request.agentId,
      request.sessionId,
      request.toolName,
      reason,
      JSON.stringify(details),
    );

    await this.storage.audit.append("policy_blocks", {
      auditEventId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      toolName: request.toolName,
      reason,
      details,
    });
  }

  private async recordInvocation(
    auditEventId: string,
    request: ToolInvokeRequest,
    outcome: "executed" | "approval_required" | "blocked",
    policyReason: string,
    result?: Record<string, unknown>,
    approvalId?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const sanitizedArgs = sanitizeForModel(request.args);
    const sanitizedResult = result ? sanitizeForModel(result) : undefined;
    this.storage.db.prepare(`
      INSERT INTO tool_invocations (
        audit_event_id, timestamp, agent_id, session_id, task_id, tool_name,
        outcome, policy_reason, args_json, result_json, approval_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      auditEventId,
      now,
      request.agentId,
      request.sessionId,
      request.taskId ?? null,
      request.toolName,
      outcome,
      policyReason,
      JSON.stringify(sanitizedArgs),
      sanitizedResult ? JSON.stringify(sanitizedResult) : null,
      approvalId ?? null,
    );

    await this.storage.audit.append("tool_invocations", {
      auditEventId,
      agentId: request.agentId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      toolName: request.toolName,
      outcome,
      policyReason,
      approvalId,
      args: sanitizedArgs,
      result: sanitizedResult,
    });
  }
}

function buildScopeCandidates(request: ToolAccessEvaluateRequest): Array<{ scope: "task" | "agent" | "session" | "global"; scopeRef: string }> {
  const out: Array<{ scope: "task" | "agent" | "session" | "global"; scopeRef: string }> = [];
  if (request.taskId) {
    out.push({ scope: "task", scopeRef: request.taskId });
  }
  out.push({ scope: "agent", scopeRef: request.agentId });
  out.push({ scope: "session", scopeRef: request.sessionId });
  out.push({ scope: "global", scopeRef: "global" });
  return out;
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

function isMutationTool(toolDef?: ToolDefinition): boolean {
  if (!toolDef) {
    return false;
  }
  return toolDef.riskLevel === "danger" || toolDef.riskLevel === "nuclear";
}

function extractHostCandidates(args?: Record<string, unknown>): string[] {
  if (!args) {
    return [];
  }
  const values = [args.url, args.host, args.target]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);

  const hosts = new Set<string>();
  for (const value of values) {
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
    } catch {
      hosts.add(value.toLowerCase());
    }
  }
  return [...hosts];
}

function extractPathCandidates(args?: Record<string, unknown>): string[] {
  if (!args) {
    return [];
  }
  return [args.path, args.from, args.to, args.relativePath]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

function extractReadPathCandidates(request: ToolAccessEvaluateRequest): string[] {
  const args = request.args;
  if (!args) {
    return [];
  }
  if (
    request.toolName === "fs.read"
    || request.toolName === "file.read_range"
    || request.toolName === "file.find"
    || request.toolName === "code.search"
    || request.toolName === "code.search_files"
    || request.toolName === "fs.list"
    || request.toolName === "fs.stat"
  ) {
    return typeof args.path === "string" ? [args.path] : [];
  }
  if (request.toolName === "fs.copy") {
    return typeof args.from === "string" ? [args.from] : [];
  }
  if (request.toolName === "docs.ingest" && args.sourceType === "file") {
    return typeof args.source === "string" ? [args.source] : [];
  }
  return [];
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
  return [
    ...(constraints.allowedPaths ?? []),
    ...getReferenceRootPaths(constraints),
  ];
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
      const resolvedRoot = normalizePathForMatch(root);
      if (resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}/`)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function normalizePathForMatch(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
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
  const taskId = value.taskId ? String(value.taskId) : undefined;
  const consentContext = value.consentContext && typeof value.consentContext === "object"
    ? {
      operatorId: typeof (value.consentContext as Record<string, unknown>).operatorId === "string"
        ? String((value.consentContext as Record<string, unknown>).operatorId)
        : undefined,
      source: (value.consentContext as Record<string, unknown>).source as "ui" | "tui" | "agent" | undefined,
      reason: typeof (value.consentContext as Record<string, unknown>).reason === "string"
        ? String((value.consentContext as Record<string, unknown>).reason)
        : undefined,
    }
    : undefined;
  const dryRun = typeof value.dryRun === "boolean" ? value.dryRun : undefined;

  if (!toolName || !agentId || !sessionId) {
    throw new Error("Invalid pending action request payload");
  }

  return {
    toolName,
    args,
    agentId,
    sessionId,
    taskId,
    consentContext,
    dryRun,
  };
}

function isBankrToolName(toolName: string): boolean {
  return toolName.startsWith("bankr.");
}

function toPlainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}
