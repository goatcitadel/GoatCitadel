import { createHash, createHmac, randomBytes } from "node:crypto";
import type { DeploymentProfile, ResearchSearchOfficialProvider } from "@goatcitadel/contracts";
import { ExternalServiceError, PolicyViolationError, ValidationError } from "@goatcitadel/contracts";
import {
  executeOfficialResearchSearch,
  getOfficialSearchCredentialEnvAliases,
  isHostAllowed,
  type RuntimeConfigurationTargetId,
} from "@goatcitadel/policy-engine";
import type { SecretStoreService } from "./secret-store-service.js";

const CONFIGURATION_PROBE_QUERY = "GoatCitadel search connectivity test";
const MAX_SECRET_LENGTH = 8_192;
const COMPLETED_REQUEST_LIMIT = 256;

interface RuntimeConfigurationTarget {
  targetId: RuntimeConfigurationTargetId;
  provider: ResearchSearchOfficialProvider;
  targetLabel: string;
  secretFieldLabel: string;
  endpointHost: string;
  acquisitionUrl: string;
  acquisitionLabel: string;
  accountSuffix: string;
}

const TARGETS: Record<RuntimeConfigurationTargetId, RuntimeConfigurationTarget> = {
  "search.brave": {
    targetId: "search.brave",
    provider: "brave",
    targetLabel: "Brave Search",
    secretFieldLabel: "Brave Search API key",
    endpointHost: "api.search.brave.com",
    acquisitionUrl: "https://brave.com/search/api/",
    acquisitionLabel: "Get a Brave Search API key",
    accountSuffix: "search.brave",
  },
  "search.parallel": {
    targetId: "search.parallel",
    provider: "parallel",
    targetLabel: "Parallel Search",
    secretFieldLabel: "Parallel Search API key",
    endpointHost: "api.parallel.ai",
    acquisitionUrl: "https://platform.parallel.ai/",
    acquisitionLabel: "Get a Parallel API key",
    accountSuffix: "search.parallel",
  },
};

export interface RuntimeConfigurationPromptDescriptor {
  targetId: RuntimeConfigurationTargetId;
  targetLabel: string;
  secretFieldLabel: string;
  acquisitionUrl: string;
  acquisitionLabel: string;
  storage: "os_keychain";
  scope: "installation";
  verification: "live_probe";
}

export interface RuntimeConfigurationAvailabilityProjection {
  status: "prerequisite_required";
  configurationRequired: false;
  targetId: RuntimeConfigurationTargetId;
  diagnosticCode:
    | "runtime_configuration_network_prerequisite"
    | "keychain_unavailable"
    | "keychain_write_custody_unsafe"
    | "installation_scope_remote_blocked"
    | "runtime_configuration_manual_reconciliation_required"
    | "runtime_configuration_unavailable";
  message: string;
  operatorAction: string;
}

export interface RuntimeConfigurationApplyInput {
  targetId: string;
  secret: string;
  requestId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  actorId: string;
  expiresAt: string;
  operatorId?: string;
  authActorSource?: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion" | "a2a_peer" | "mesh_node";
  runId?: string;
  taskId?: string;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
}

export type RuntimeConfigurationAuthorizationInput = Omit<RuntimeConfigurationApplyInput, "secret">;

export interface RuntimeConfigurationApplyResult {
  configured: true;
  validated: true;
  targetId: RuntimeConfigurationTargetId;
  provider: ResearchSearchOfficialProvider;
  source: "keychain";
  diagnosticCode: "configured_and_validated";
  revision: string;
  scopeRef: string;
}

interface RuntimeConfigurationProbeResult {
  ok: boolean;
  status?: string;
  httpStatus?: number;
}

export interface RuntimeConfigurationServiceOptions {
  secretStore: Pick<
    SecretStoreService,
    "isAvailable" | "isWriteCustodySafe" | "getSecret" | "setSecret" | "deleteSecret"
  >;
  networkAllowlist: readonly string[];
  getNetworkAllowlist?: () => readonly string[];
  env?: NodeJS.ProcessEnv;
  installationScopeId: string;
  deploymentProfile?: DeploymentProfile;
  getDeploymentProfile?: () => DeploymentProfile | undefined;
  probe?: (
    provider: ResearchSearchOfficialProvider,
    secret: string,
    networkAllowlist: readonly string[],
  ) => Promise<RuntimeConfigurationProbeResult>;
  appendAudit?: (payload: Record<string, unknown>) => Promise<void>;
  assertAuthorized?: (input: RuntimeConfigurationAuthorizationInput) => Promise<void>;
  hasBlockingDurableReservation?: (
    targetId: RuntimeConfigurationTargetId,
    scopeRef: string,
  ) => boolean | Promise<boolean>;
  now?: () => Date;
}

/**
 * Gateway-owned, allowlisted runtime configuration owner.
 *
 * Raw credentials enter only through configureAndValidate(), are live-probed
 * before activation, and are persisted only in the OS keychain. They are never
 * returned in status, audit, prompt metadata, or model-visible tool results.
 */
export class RuntimeConfigurationService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly probe: NonNullable<RuntimeConfigurationServiceOptions["probe"]>;
  private readonly now: () => Date;
  private readonly installationScopeId: string;
  private readonly requestFingerprintKey = randomBytes(32);
  private readonly inFlight = new Map<
    string,
    { fingerprint: string; promise: Promise<RuntimeConfigurationApplyResult> }
  >();
  private readonly completed = new Map<string, { fingerprint: string; result: RuntimeConfigurationApplyResult }>();
  private readonly pendingSettlement = new Map<
    string,
    {
      target: RuntimeConfigurationTarget;
      previous: string | undefined;
      revision: string;
      releaseTarget: () => void;
      completionAudit: Record<string, unknown>;
    }
  >();
  private readonly unresolvedSettlements = new Map<
    RuntimeConfigurationTargetId,
    {
      requestId: string;
      revision: string;
      reason:
        | "rollback_failed"
        | "rollback_audit_failed"
        | "keychain_write_rollback_failed"
        | "activation_audit_rollback_failed";
    }
  >();
  private readonly preparingTargets = new Map<RuntimeConfigurationTargetId, string>();
  private readonly targetLockTails = new Map<RuntimeConfigurationTargetId, Promise<void>>();

  public constructor(private readonly options: RuntimeConfigurationServiceOptions) {
    this.env = options.env ?? process.env;
    this.probe = options.probe ?? probeOfficialSearchCredential;
    this.now = options.now ?? (() => new Date());
    this.installationScopeId = requireScopeId(options.installationScopeId);
  }

  public describePrompt(targetId: RuntimeConfigurationTargetId): RuntimeConfigurationPromptDescriptor {
    requireTarget(targetId);
    return getRuntimeConfigurationPromptDescriptor(targetId)!;
  }

  public getInstallationScopeRef(): string {
    return this.installationScopeId;
  }

  public assertConfigurationAvailable(targetId: RuntimeConfigurationTargetId): void {
    const target = requireTarget(targetId);
    this.assertInstallationScopeAllowed(targetId);
    const unresolved = this.unresolvedSettlements.get(targetId);
    if (unresolved) {
      throw new ExternalServiceError(
        "Runtime configuration requires manual reconciliation before this target can change.",
        {
          targetId,
          requestId: unresolved.requestId,
          revision: unresolved.revision,
          diagnosticCode: "runtime_configuration_manual_reconciliation_required",
        },
      );
    }
    if (!this.options.secretStore.isAvailable()) {
      throw new ExternalServiceError("Secure runtime configuration requires an available OS keychain.", {
        targetId,
        diagnosticCode: "keychain_unavailable",
      });
    }
    if (!this.options.secretStore.isWriteCustodySafe()) {
      throw new ExternalServiceError(
        "This host keychain adapter cannot safely accept a non-interactive Chat credential.",
        {
          targetId,
          diagnosticCode: "keychain_write_custody_unsafe",
        },
      );
    }
    const networkAllowlist = [...(this.options.getNetworkAllowlist?.() ?? this.options.networkAllowlist)];
    if (!isHostAllowed(`https://${target.endpointHost}`, networkAllowlist)) {
      throw new PolicyViolationError({
        message: `${target.targetLabel} cannot be configured until ${target.endpointHost} is explicitly enabled in the network allowlist.`,
        details: {
          targetId,
          endpointHost: target.endpointHost,
          diagnosticCode: "runtime_configuration_network_prerequisite",
          operatorAction: "Add the exact provider host in Settings, then retry the original Chat request.",
        },
      });
    }
  }

  public async resolveOfficialSearchCredential(provider: ResearchSearchOfficialProvider): Promise<string | undefined> {
    const target = Object.values(TARGETS).find((candidate) => candidate.provider === provider);
    if (!target) return undefined;
    if (await this.hasBlockingDurableReservation(target.targetId)) return undefined;
    if (
      this.unresolvedSettlements.has(target.targetId) ||
      this.preparingTargets.has(target.targetId) ||
      [...this.pendingSettlement.values()].some((pending) => pending.target.targetId === target.targetId)
    ) {
      // A probed key is not active until the durable Chat prompt settles. An
      // ambiguous rollback also fails closed instead of leaking the candidate
      // into a concurrent browser.search.
      return undefined;
    }
    let resolvedCredential: string | undefined;
    try {
      const keychainValue = this.options.secretStore.getSecret(this.accountFor(target))?.trim();
      if (keychainValue) resolvedCredential = keychainValue;
    } catch {
      // The official provider adapter retains its environment-variable fallback.
      // A keychain outage must not cause a credential value to enter diagnostics.
    }
    if (!resolvedCredential) {
      for (const envName of getOfficialSearchCredentialEnvAliases(provider)) {
        const value = this.env[envName]?.trim();
        if (value) {
          resolvedCredential = value;
          break;
        }
      }
    }
    // Close the cross-process race where a durable reservation is inserted
    // after the first check but before keychain/environment resolution.
    if (await this.hasBlockingDurableReservation(target.targetId)) return undefined;
    return resolvedCredential;
  }

  public configureAndValidate(input: RuntimeConfigurationApplyInput): Promise<RuntimeConfigurationApplyResult> {
    const requestId = requireNonEmpty(input.requestId, "requestId");
    const normalizedSecret = normalizeSecret(input.secret);
    const normalizedInput: RuntimeConfigurationApplyInput = {
      ...input,
      requestId,
      secret: normalizedSecret,
      workspaceId: requireNonEmpty(input.workspaceId, "workspaceId"),
      sessionId: requireNonEmpty(input.sessionId, "sessionId"),
      turnId: requireNonEmpty(input.turnId, "turnId"),
      actorId: requireNonEmpty(input.actorId, "actorId"),
      expiresAt: requireIsoTimestamp(input.expiresAt, "expiresAt"),
    };
    const fingerprint = createHmac("sha256", this.requestFingerprintKey).update(normalizedSecret).digest("hex");
    const target = requireTarget(normalizedInput.targetId);
    const unresolved = this.unresolvedSettlements.get(target.targetId);
    if (unresolved?.requestId === requestId && this.pendingSettlement.has(requestId)) {
      // A retry of the same still-active prompt is the only automatic lane that
      // may re-attempt its retained compensation before configuration resumes.
      return this.rollbackConfiguration(requestId).then(() => this.configureAndValidate(normalizedInput));
    }
    const completed = this.completed.get(requestId);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        throw new ValidationError({ message: "This secure configuration request was already completed." });
      }
      return Promise.resolve(completed.result);
    }
    const existing = this.inFlight.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ValidationError({ message: "This secure configuration request is already being answered." });
      }
      return existing.promise;
    }
    const promise = this.applyConfiguration(normalizedInput)
      .then((result) => {
        this.rememberCompleted(requestId, fingerprint, result);
        return result;
      })
      .finally(() => {
        this.inFlight.delete(requestId);
      });
    this.inFlight.set(requestId, { fingerprint, promise });
    return promise;
  }

  /** Clears the short-lived rollback material after the durable Chat CAS commits. */
  public async finalizeConfiguration(requestId: string): Promise<void> {
    const normalizedRequestId = requireNonEmpty(requestId, "requestId");
    const pending = this.pendingSettlement.get(normalizedRequestId);
    if (!pending) return;
    try {
      await this.options.appendAudit?.({
        event: "runtime_configuration.completed",
        ...pending.completionAudit,
        completedAt: this.now().toISOString(),
      });
    } catch {
      // The storage-sealed runtimeConfigurationReceipt remains the canonical
      // completion fact. Do not strand the already-settled durable run because
      // an audit projection is temporarily unavailable.
    } finally {
      // The exact durable Chat response receipt is the canonical settlement.
      // Audit is a projection and must not leave a valid, durably settled
      // credential masked forever if that projection is temporarily down.
      this.pendingSettlement.delete(normalizedRequestId);
      this.completed.delete(normalizedRequestId);
      pending.releaseTarget();
    }
  }

  /** Compensates a keychain write when the same-process durable Chat CAS fails. */
  public async rollbackConfiguration(requestId: string): Promise<void> {
    const normalizedRequestId = requireNonEmpty(requestId, "requestId");
    const pending = this.pendingSettlement.get(normalizedRequestId);
    if (!pending) return;
    try {
      if (pending.previous?.trim()) {
        this.options.secretStore.setSecret(this.accountFor(pending.target), pending.previous);
      } else {
        this.options.secretStore.deleteSecret(this.accountFor(pending.target));
      }
    } catch (error) {
      pending.releaseTarget();
      // A failed restore leaves the installation quarantined. Do not retain
      // the prior raw credential or its transient comparison HMAC in process
      // memory indefinitely while waiting for manual reconciliation.
      this.pendingSettlement.delete(normalizedRequestId);
      this.completed.delete(normalizedRequestId);
      this.unresolvedSettlements.set(pending.target.targetId, {
        requestId: normalizedRequestId,
        revision: pending.revision,
        reason: "rollback_failed",
      });
      let failureAuditPersisted = true;
      try {
        await this.options.appendAudit?.({
          event: "runtime_configuration.rollback_failed",
          targetId: pending.target.targetId,
          provider: pending.target.provider,
          storage: "os_keychain",
          scope: "installation",
          scopeRef: this.installationScopeId,
          reason: "durable_chat_settlement_failed",
          requestId: normalizedRequestId,
          revision: pending.revision,
          failureCode: safeErrorCode(error),
          manualReconciliationRequired: true,
          failedAt: this.now().toISOString(),
        });
      } catch {
        failureAuditPersisted = false;
      }
      throw new ExternalServiceError(
        `${pending.target.targetLabel} durable settlement failed and automatic keychain rollback also failed.`,
        {
          targetId: pending.target.targetId,
          requestId: normalizedRequestId,
          revision: pending.revision,
          diagnosticCode: failureAuditPersisted
            ? "durable_settlement_and_rollback_failed_manual_reconciliation"
            : "durable_settlement_rollback_and_audit_failed_manual_reconciliation",
          manualReconciliationRequired: true,
        },
      );
    }
    try {
      await this.options.appendAudit?.({
        event: "runtime_configuration.rolled_back",
        targetId: pending.target.targetId,
        provider: pending.target.provider,
        storage: "os_keychain",
        scope: "installation",
        scopeRef: this.installationScopeId,
        reason: "durable_chat_settlement_failed",
        requestId: normalizedRequestId,
        revision: pending.revision,
        rolledBackAt: this.now().toISOString(),
      });
    } catch {
      pending.releaseTarget();
      this.pendingSettlement.delete(normalizedRequestId);
      this.completed.delete(normalizedRequestId);
      this.unresolvedSettlements.set(pending.target.targetId, {
        requestId: normalizedRequestId,
        revision: pending.revision,
        reason: "rollback_audit_failed",
      });
      throw new ExternalServiceError(
        `${pending.target.targetLabel} was rolled back, but rollback audit persistence failed.`,
        {
          targetId: pending.target.targetId,
          diagnosticCode: "durable_settlement_rolled_back_audit_failed",
          manualReconciliationRequired: true,
        },
      );
    }
    this.pendingSettlement.delete(normalizedRequestId);
    this.completed.delete(normalizedRequestId);
    this.unresolvedSettlements.delete(pending.target.targetId);
    pending.releaseTarget();
  }

  private async applyConfiguration(input: RuntimeConfigurationApplyInput): Promise<RuntimeConfigurationApplyResult> {
    const target = requireTarget(input.targetId);
    const releaseTarget = await this.acquireTargetLock(target.targetId);
    try {
      // These checks deliberately run after the target lock is acquired. A
      // queued request must observe the current profile, policy, and keychain
      // posture immediately before its probe/write rather than the state that
      // happened to exist when it entered the queue.
      await this.assertCurrentAuthority(input, target);
      this.preparingTargets.set(target.targetId, input.requestId);
      return await this.applyConfigurationUnderTargetLock(input, target, releaseTarget);
    } catch (error) {
      if (this.preparingTargets.get(target.targetId) === input.requestId) {
        this.preparingTargets.delete(target.targetId);
      }
      releaseTarget();
      throw error;
    }
  }

  private async applyConfigurationUnderTargetLock(
    input: RuntimeConfigurationApplyInput,
    target: RuntimeConfigurationTarget,
    releaseTarget: () => void,
  ): Promise<RuntimeConfigurationApplyResult> {
    const configuredAt = this.now().toISOString();
    const revision = createHash("sha256").update(`${target.targetId}:${input.requestId}:${configuredAt}`).digest("hex");
    let previous: string | undefined;
    try {
      previous = this.options.secretStore.getSecret(this.accountFor(target));
    } catch (error) {
      throw new ExternalServiceError(`Could not read the existing ${target.targetLabel} keychain state.`, {
        targetId: target.targetId,
        diagnosticCode: "keychain_read_failed",
        cause: safeErrorCode(error),
      });
    }
    const probe = await this.probe(
      target.provider,
      input.secret,
      this.options.getNetworkAllowlist?.() ?? this.options.networkAllowlist,
    );
    if (!probe.ok) {
      throw new ExternalServiceError(`${target.targetLabel} rejected the credential or did not pass its live probe.`, {
        targetId: target.targetId,
        provider: target.provider,
        diagnosticCode: "credential_probe_failed",
        ...(probe.status ? { providerStatus: probe.status } : {}),
        ...(probe.httpStatus ? { httpStatus: probe.httpStatus } : {}),
      });
    }

    // A live probe may consume most of the secure prompt lifetime or overlap a
    // profile/policy change. Recheck every mutable authority immediately before
    // the keychain effect so a near-expiry or newly denied request fails closed.
    await this.assertCurrentAuthority(input, target);

    try {
      this.options.secretStore.setSecret(this.accountFor(target), input.secret);
    } catch (error) {
      try {
        if (previous?.trim()) {
          this.options.secretStore.setSecret(this.accountFor(target), previous);
        } else {
          this.options.secretStore.deleteSecret(this.accountFor(target));
        }
      } catch (rollbackError) {
        const failureAuditPersisted = await this.markUnresolvedSettlement({
          target,
          requestId: input.requestId,
          revision,
          reason: "keychain_write_rollback_failed",
          failureCode: safeErrorCode(rollbackError),
        });
        throw new ExternalServiceError(
          `Could not store ${target.targetLabel}, and automatic keychain rollback also failed.`,
          {
            targetId: target.targetId,
            requestId: input.requestId,
            revision,
            diagnosticCode: failureAuditPersisted
              ? "keychain_write_and_rollback_failed_manual_reconciliation"
              : "keychain_write_rollback_and_audit_failed_manual_reconciliation",
            manualReconciliationRequired: true,
          },
        );
      }
      throw new ExternalServiceError(`Could not store ${target.targetLabel} in the OS keychain.`, {
        targetId: target.targetId,
        diagnosticCode: "keychain_write_failed_rolled_back",
        cause: safeErrorCode(error),
      });
    }

    const result: RuntimeConfigurationApplyResult = {
      configured: true,
      validated: true,
      targetId: target.targetId,
      provider: target.provider,
      source: "keychain",
      diagnosticCode: "configured_and_validated",
      revision,
      scopeRef: this.installationScopeId,
    };
    try {
      await this.options.appendAudit?.({
        event: "runtime_configuration.verified_pending_settlement",
        targetId: target.targetId,
        provider: target.provider,
        endpointHost: target.endpointHost,
        storage: "os_keychain",
        scope: "installation",
        scopeRef: this.installationScopeId,
        validation: "live_probe",
        configuredAt,
        revision,
        requestId: input.requestId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        actorId: input.actorId,
      });
    } catch (error) {
      try {
        if (previous?.trim()) {
          this.options.secretStore.setSecret(this.accountFor(target), previous);
        } else {
          this.options.secretStore.deleteSecret(this.accountFor(target));
        }
      } catch (rollbackError) {
        const failureAuditPersisted = await this.markUnresolvedSettlement({
          target,
          requestId: input.requestId,
          revision,
          reason: "activation_audit_rollback_failed",
          failureCode: safeErrorCode(rollbackError),
        });
        throw new ExternalServiceError(
          `${target.targetLabel} was stored but audit persistence and automatic rollback both failed.`,
          {
            targetId: target.targetId,
            requestId: input.requestId,
            revision,
            diagnosticCode: failureAuditPersisted
              ? "audit_and_rollback_failed_manual_reconciliation"
              : "audit_rollback_and_failure_audit_failed_manual_reconciliation",
            manualReconciliationRequired: true,
          },
        );
      }
      throw new ExternalServiceError(`${target.targetLabel} was not activated because audit persistence failed.`, {
        targetId: target.targetId,
        diagnosticCode: "audit_failed_rolled_back",
        cause: safeErrorCode(error),
      });
    }
    this.pendingSettlement.set(input.requestId, {
      target,
      previous,
      revision,
      releaseTarget,
      completionAudit: {
        targetId: target.targetId,
        provider: target.provider,
        endpointHost: target.endpointHost,
        storage: "os_keychain",
        scope: "installation",
        scopeRef: this.installationScopeId,
        validation: "live_probe",
        configuredAt,
        revision,
        requestId: input.requestId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        actorId: input.actorId,
      },
    });
    this.preparingTargets.delete(target.targetId);
    return result;
  }

  private async markUnresolvedSettlement(input: {
    target: RuntimeConfigurationTarget;
    requestId: string;
    revision: string;
    reason: "keychain_write_rollback_failed" | "activation_audit_rollback_failed";
    failureCode: string;
  }): Promise<boolean> {
    this.unresolvedSettlements.set(input.target.targetId, {
      requestId: input.requestId,
      revision: input.revision,
      reason: input.reason,
    });
    try {
      await this.options.appendAudit?.({
        event: "runtime_configuration.rollback_failed",
        targetId: input.target.targetId,
        provider: input.target.provider,
        storage: "os_keychain",
        scope: "installation",
        scopeRef: this.installationScopeId,
        reason: input.reason,
        requestId: input.requestId,
        revision: input.revision,
        failureCode: input.failureCode,
        manualReconciliationRequired: true,
        failedAt: this.now().toISOString(),
      });
      return true;
    } catch {
      return false;
    }
  }

  private assertInstallationScopeAllowed(targetId: RuntimeConfigurationTargetId): void {
    if ((this.options.getDeploymentProfile?.() ?? this.options.deploymentProfile) === "remote_hardened") {
      throw new PolicyViolationError({
        message:
          "Installation-wide Chat configuration is disabled for remote_hardened deployments; use the authenticated administrator recovery lane.",
        details: { targetId, diagnosticCode: "installation_scope_remote_blocked" },
      });
    }
  }

  private async assertCurrentAuthority(
    input: RuntimeConfigurationApplyInput,
    target: RuntimeConfigurationTarget,
  ): Promise<void> {
    this.assertConfigurationAvailable(target.targetId);
    if (Date.parse(input.expiresAt) <= this.now().getTime()) {
      throw new ValidationError({ field: "expiresAt", message: "Secure runtime configuration request has expired." });
    }
    await this.options.assertAuthorized?.({
      targetId: target.targetId,
      requestId: input.requestId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      actorId: input.actorId,
      expiresAt: input.expiresAt,
      ...(input.operatorId ? { operatorId: input.operatorId } : {}),
      ...(input.authActorSource ? { authActorSource: input.authActorSource } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.permissionProfileId ? { permissionProfileId: input.permissionProfileId } : {}),
      ...(input.localOperatorOverrideId ? { localOperatorOverrideId: input.localOperatorOverrideId } : {}),
    });
  }

  private accountFor(target: RuntimeConfigurationTarget): string {
    return `runtime-configuration:installation:${this.installationScopeId}:${target.accountSuffix}`;
  }

  private async hasBlockingDurableReservation(targetId: RuntimeConfigurationTargetId): Promise<boolean> {
    if (!this.options.hasBlockingDurableReservation) return false;
    try {
      return await this.options.hasBlockingDurableReservation(targetId, this.installationScopeId);
    } catch {
      // Durable reservation truth is the activation fence. A storage read
      // failure cannot safely fall back to a potentially uncommitted key.
      return true;
    }
  }

  private async acquireTargetLock(targetId: RuntimeConfigurationTargetId): Promise<() => void> {
    const predecessor = this.targetLockTails.get(targetId) ?? Promise.resolve();
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const tail = predecessor.then(() => barrier);
    this.targetLockTails.set(targetId, tail);
    await predecessor;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseBarrier();
      if (this.targetLockTails.get(targetId) === tail) {
        this.targetLockTails.delete(targetId);
      }
    };
  }

  private rememberCompleted(requestId: string, fingerprint: string, result: RuntimeConfigurationApplyResult): void {
    this.completed.set(requestId, { fingerprint, result });
    while (this.completed.size > COMPLETED_REQUEST_LIMIT) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completed.delete(oldest);
    }
  }
}

export function getRuntimeConfigurationPromptDescriptor(
  targetId: string,
): RuntimeConfigurationPromptDescriptor | undefined {
  if (!(targetId in TARGETS)) return undefined;
  const target = TARGETS[targetId as RuntimeConfigurationTargetId];
  return {
    targetId: target.targetId,
    targetLabel: target.targetLabel,
    secretFieldLabel: target.secretFieldLabel,
    acquisitionUrl: target.acquisitionUrl,
    acquisitionLabel: target.acquisitionLabel,
    storage: "os_keychain",
    scope: "installation",
    verification: "live_probe",
  };
}

/**
 * Projects only target-owned, secret-free readiness guidance into a tool
 * result. Arbitrary exception text and details never enter model-visible Chat
 * context through this path.
 */
export function getRuntimeConfigurationAvailabilityProjection(
  targetId: string,
  error: unknown,
): RuntimeConfigurationAvailabilityProjection | undefined {
  const target = TARGETS[targetId as RuntimeConfigurationTargetId];
  if (!target) return undefined;
  const details =
    error && typeof error === "object" && "details" in error && error.details && typeof error.details === "object"
      ? (error.details as Record<string, unknown>)
      : undefined;
  const diagnosticCode = details?.diagnosticCode;
  if (diagnosticCode === "runtime_configuration_network_prerequisite") {
    return {
      status: "prerequisite_required",
      configurationRequired: false,
      targetId: target.targetId,
      diagnosticCode,
      message: `${target.targetLabel} cannot be configured until ${target.endpointHost} is explicitly enabled in the network allowlist.`,
      operatorAction: "Add the exact provider host in Settings, then retry the original Chat request.",
    };
  }
  if (diagnosticCode === "keychain_unavailable") {
    return {
      status: "prerequisite_required",
      configurationRequired: false,
      targetId: target.targetId,
      diagnosticCode,
      message: "Secure Chat configuration requires an available OS keychain.",
      operatorAction: "Repair or enable the OS keychain, then retry the original Chat request.",
    };
  }
  if (diagnosticCode === "keychain_write_custody_unsafe") {
    return {
      status: "prerequisite_required",
      configurationRequired: false,
      targetId: target.targetId,
      diagnosticCode,
      message: "This host cannot safely accept a credential through the Chat configuration form.",
      operatorAction: "Administrator intervention is required outside this Chat form.",
    };
  }
  if (diagnosticCode === "installation_scope_remote_blocked") {
    return {
      status: "prerequisite_required",
      configurationRequired: false,
      targetId: target.targetId,
      diagnosticCode,
      message: "Installation-wide Chat configuration is disabled for remote-hardened deployments.",
      operatorAction: "Administrator intervention is required outside this Chat form.",
    };
  }
  if (diagnosticCode === "runtime_configuration_manual_reconciliation_required") {
    return {
      status: "prerequisite_required",
      configurationRequired: false,
      targetId: target.targetId,
      diagnosticCode,
      message: `${target.targetLabel} has an unresolved configuration attempt and remains quarantined.`,
      operatorAction: "Reconcile the installation credential before starting another Chat configuration attempt.",
    };
  }
  return {
    status: "prerequisite_required",
    configurationRequired: false,
    targetId: target.targetId,
    diagnosticCode: "runtime_configuration_unavailable",
    message: `${target.targetLabel} secure configuration is currently unavailable.`,
    operatorAction: "Inspect Runtime health and Settings, then retry the original Chat request.",
  };
}

async function probeOfficialSearchCredential(
  provider: ResearchSearchOfficialProvider,
  secret: string,
  networkAllowlist: readonly string[],
): Promise<RuntimeConfigurationProbeResult> {
  const response = await executeOfficialResearchSearch(
    {
      query: CONFIGURATION_PROBE_QUERY,
      providers: [provider],
      mode: "quick",
      maxResults: 1,
    },
    {
      env: {},
      resolveCredential: async (candidate) => (candidate === provider ? secret : undefined),
      additionalAllowlists: [[...networkAllowlist]],
      maxResponseBytes: 64 * 1_024,
    },
  );
  const attempt = response.providerAttempts?.find((candidate) => candidate.provider === provider);
  return {
    ok: attempt?.status === "succeeded",
    status: attempt?.status,
    httpStatus: attempt?.httpStatus,
  };
}

function requireTarget(targetId: string): RuntimeConfigurationTarget {
  const target = TARGETS[targetId as RuntimeConfigurationTargetId];
  if (!target) {
    throw new ValidationError({ field: "targetId", message: "Runtime configuration target is not allowlisted." });
  }
  return target;
}

function normalizeSecret(value: string): string {
  const secret = value.trim();
  if (!secret) {
    throw new ValidationError({ field: "secret", message: "Credential must not be empty." });
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    throw new ValidationError({ field: "secret", message: "Credential is too long." });
  }
  return secret;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ValidationError({ field });
  return normalized;
}

function requireIsoTimestamp(value: string, field: string): string {
  const normalized = requireNonEmpty(value, field);
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new ValidationError({ field, message: `${field} must be a valid ISO timestamp.` });
  }
  return new Date(timestamp).toISOString();
}

function requireScopeId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{7,63}$/u.test(normalized)) {
    throw new ValidationError({ field: "installationScopeId", message: "Installation scope id is invalid." });
  }
  return normalized;
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 80);
  }
  return "operation_failed";
}
