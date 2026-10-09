import { createHash, randomUUID } from "node:crypto";
import {
  ConflictError, NotFoundError, PolicyViolationError, ValidationError,
  type ChannelOAuthAdoptInput, type ChannelOAuthAdoptResponse, type ChannelOAuthAttempt,
  type ChannelOAuthAttemptInput, type ChannelOAuthCancelInput, type ChannelOAuthInstallReceipt,
  type ChannelOAuthStartInput, type ChannelOAuthStartResponse, type ChannelSetupDraft,
} from "@goatcitadel/contracts";
import type { AsyncStorage, ChannelOAuthAttemptRecord } from "@goatcitadel/storage";
import type { ChannelSecretCustodyService } from "./channel-secret-custody-service.js";
import { assertDraftRevision } from "./channel-setup-draft-security.js";
import { projectChannelSetupDraftForPublicResponse } from "./channel-setup-public-projection.js";
import {
  buildSlackOAuthStart, exchangeSlackOAuthCode, parseScopes, verifySlackOAuthState, SlackOAuthExchangeRejectedError,
  type SlackOAuthConfig, type SlackOAuthTokenPayload,
} from "./slack-oauth-service.js";

export interface ChannelOAuthActor { actorId: string; workspaceId: string }
export interface ChannelOAuthStagingPort {
  installationId: string;
  storage: Pick<AsyncStorage, "channelOAuthAttempts" | "channelSetupDrafts" | "integrationConnections" | "runImmediateTransaction" | "workspaces">;
  channelSecrets?: Pick<ChannelSecretCustodyService, "storeTemporary" | "deleteTemporary" | "assertUsableForDraft" | "resolve">;
  recentChannelSetupTests: { delete(draftId: string): unknown };
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}
const ttlMs = 10 * 60 * 1000;
/** The callback stages credentials; only the channel Change Plan can activate them. */
export class ChannelOAuthStagingService {
  public constructor(private readonly port: ChannelOAuthStagingPort) {}
  public async start(actor: ChannelOAuthActor, input: ChannelOAuthStartInput, config: SlackOAuthConfig): Promise<ChannelOAuthStartResponse> {
    await this.requireActor(actor, input.workspaceId);
    await this.cleanupExpired();
    const draft = await this.requireDraft(input.draftId, input.expectedRevision);
    if (!this.port.channelSecrets) throw new ValidationError({ message: "OS keychain custody is required for Slack OAuth." });
    if (draft.connectionId) await this.requireConnectionBinding(draft);
    const attemptId = randomUUID();
    const start = buildSlackOAuthStart({ ...config, attemptId });
    if (!start.configured || !start.state) return start;
    const attempt = await this.port.storage.channelOAuthAttempts.create({
      attemptId, provider: "slack", installationId: this.port.installationId, workspaceId: actor.workspaceId,
      actorId: actor.actorId, draftId: draft.draftId, draftRevision: draft.revision,
      connectionId: draft.connectionId, connectionRevision: draft.connectionRevision,
      stateHash: hashState(start.state), origin: config.origin,
      status: "pending", expiresAt: new Date(Date.now() + ttlMs).toISOString(), secretRefs: {},
    });
    return { ...start, attempt: projectAttempt(attempt) };
  }
  public async status(actor: ChannelOAuthActor, input: ChannelOAuthAttemptInput): Promise<ChannelOAuthAttempt> {
    await this.requireActor(actor, input.workspaceId);
    await this.cleanupExpired();
    return projectAttempt(await this.requireAttempt(actor, input.attemptId));
  }
  public async callback(state: string, config: SlackOAuthConfig, code?: string, denied = false): Promise<ChannelOAuthAttempt> {
    if (!config.stateSecret || !verifySlackOAuthState(state, config.stateSecret)) {
      throw new ValidationError({ message: "Invalid or expired Slack OAuth state." });
    }
    const initial = await this.port.storage.channelOAuthAttempts.findByStateHash(hashState(state));
    if (!initial || initial.installationId !== this.port.installationId) {
      throw new ValidationError({ message: "Unknown Slack OAuth attempt." });
    }
    await this.cleanupExpired();
    const attempt = await this.port.storage.channelOAuthAttempts.get(initial.attemptId);
    if (attempt.status !== "pending") throw new ConflictError({ message: "This Slack OAuth callback was already consumed." });
    await this.requireActor({ actorId: attempt.actorId, workspaceId: attempt.workspaceId }, attempt.workspaceId);
    if (denied) {
      return projectAttempt(await this.port.storage.channelOAuthAttempts.update(attempt.attemptId, {
        expectedRevision: attempt.revision, status: "failed", failureCode: "operator_denied",
      }));
    }
    if (!code || !config.clientId || !config.clientSecret || !config.redirectUri) {
      throw new ValidationError({ message: "A configured Slack OAuth code exchange is required." });
    }
    const claimed = await this.port.storage.channelOAuthAttempts.update(attempt.attemptId, {
      expectedRevision: attempt.revision, status: "exchanging",
    });
    const secretRefs: Record<string, string> = {};
    let failureCode: ChannelOAuthAttempt["failureCode"] = "unknown_exchange_outcome";
    try {
      // The single-use claim is committed before the provider boundary. Ambiguous failures never retry.
      const payload = await exchangeSlackOAuthCode({
        code, clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri,
        fetcher: this.port.fetcher ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })),
      });
      failureCode = "invalid_install";
      const install = requireInstall(payload);
      failureCode = "binding_changed";
      const draft = await this.requireDraft(claimed.draftId, claimed.draftRevision);
      await this.requireConnectionBinding(draft, install);
      if (Date.parse(claimed.expiresAt) <= Date.now()) throw new ConflictError({ message: "The Slack OAuth attempt expired." });
      const custody = this.requireCustody();
      secretRefs.botToken = custody.storeTemporary(draft.draftId, "botToken", payload.access_token!);
      const staged = await this.port.storage.channelOAuthAttempts.update(claimed.attemptId, {
        expectedRevision: claimed.revision, status: "ready", install, secretRefs,
      });
      return projectAttempt(staged);
    } catch (error) {
      if (error instanceof SlackOAuthExchangeRejectedError) failureCode = "exchange_failed";
      // Keep diagnostics bounded. Slack responses/exceptions may contain credentials.
      for (const ref of Object.values(secretRefs)) this.port.channelSecrets?.deleteTemporary(ref);
      const current = await this.port.storage.channelOAuthAttempts.get(claimed.attemptId);
      if (current.status === "exchanging") {
        return projectAttempt(await this.port.storage.channelOAuthAttempts.update(current.attemptId, {
          expectedRevision: current.revision, status: "failed", failureCode, secretRefs: {},
        }));
      }
      throw new ConflictError({ message: "The Slack OAuth attempt changed while exchanging. Start a new attempt." });
    }
  }
  public async adopt(actor: ChannelOAuthActor, input: ChannelOAuthAdoptInput, onCommitted?: () => Promise<void>): Promise<ChannelOAuthAdoptResponse> {
    await this.requireActor(actor, input.workspaceId);
    await this.cleanupExpired();
    await this.requireAttempt(actor, input.attemptId);
    const result = await this.port.storage.runImmediateTransaction(async () => {
      const attempt = await this.requireAttempt(actor, input.attemptId);
      if (attempt.status !== "ready" || !attempt.install || attempt.draftId !== input.draftId ||
          attempt.draftRevision !== input.expectedRevision || Date.parse(attempt.expiresAt) <= Date.now()) {
        throw new ConflictError({ message: "Review the current Slack installation and draft before adopting." });
      }
      const draft = await this.requireDraft(input.draftId, input.expectedRevision);
      await this.requireConnectionBinding(draft, attempt.install);
      const custody = this.requireCustody();
      const secretState = { ...draft.secretState };
      for (const [fieldKey, ref] of Object.entries(attempt.secretRefs)) {
        custody.assertUsableForDraft(ref, { draftId: draft.draftId, connectionId: draft.connectionId, fieldKey });
        // Availability is checked inside the owner, without exposing a secret to the client.
        custody.resolve(ref);
        secretState[fieldKey] = { configured: true, custody: "temporary", source: "operator", secretRef: ref };
      }
      if (!attempt.secretRefs.botToken) throw new ConflictError({ message: "The staged Slack credential is unavailable." });
      const install = attempt.install;
      const updated = await this.port.storage.channelSetupDrafts.update(draft.draftId, {
        expectedRevision: draft.revision, secretState,
        draft: {
          ...draft.draft, authMode: "oauth", slackInstallId: install.installId, slackTeamId: install.teamId,
          slackTeamName: install.teamName, slackAppId: install.appId, slackBotUserId: install.botUserId,
          slackScopes: install.scopes.join(","), slackInstallerUserId: install.installerUserId,
          oauthConnectedAt: new Date().toISOString(),
        },
      });
      const adopted = await this.port.storage.channelOAuthAttempts.update(attempt.attemptId, {
        expectedRevision: attempt.revision, status: "adopted", adoptedDraftRevision: updated.revision, secretRefs: {},
      });
      await onCommitted?.();
      return { draft: updated, attempt: adopted, previousSecretState: draft.secretState };
    });
    this.port.recentChannelSetupTests.delete(input.draftId);
    // Only delete superseded temporary values after both canonical writes commit.
    for (const [key, previous] of Object.entries(result.previousSecretState ?? {})) {
      if (previous.custody === "temporary" && previous.secretRef &&
          previous.secretRef !== result.draft.secretState[key]?.secretRef) {
        try { this.port.channelSecrets?.deleteTemporary(previous.secretRef); }
        catch { throw Object.assign(new Error("The Slack installation was adopted. Reload the draft; superseded credential cleanup needs attention."), { mutationCommitted: true }); }
      }
    }
    return { draft: projectChannelSetupDraftForPublicResponse(result.draft), attempt: projectAttempt(result.attempt) };
  }
  public async cancel(actor: ChannelOAuthActor, input: ChannelOAuthCancelInput): Promise<ChannelOAuthAttempt> {
    await this.requireActor(actor, input.workspaceId);
    const attempt = await this.requireAttempt(actor, input.attemptId);
    if (attempt.revision !== input.expectedRevision) throw new ConflictError({ code: "WRITE_CONFLICT", message: "The OAuth attempt changed." });
    const cancelled = await this.port.storage.channelOAuthAttempts.update(attempt.attemptId, {
      expectedRevision: input.expectedRevision, status: "cancelled",
    });
    try { await this.deleteStagedRefs(cancelled); }
    catch { throw Object.assign(new Error("The OAuth attempt was cancelled. Staged credential cleanup will be retried."), { mutationCommitted: true }); }
    return projectAttempt(await this.port.storage.channelOAuthAttempts.get(attempt.attemptId));
  }
  /** Owner-only cleanup after a successful draft discard; caller CAS remains authoritative. */
  public async cancelForDraft(draftId: string): Promise<void> {
    for (const attempt of await this.port.storage.channelOAuthAttempts.listByDraft(draftId)) {
      if (attempt.installationId !== this.port.installationId) continue;
      try {
        const cancelled = ["pending", "exchanging", "ready"].includes(attempt.status)
          ? await this.port.storage.channelOAuthAttempts.update(attempt.attemptId, { expectedRevision: attempt.revision, status: "cancelled" })
          : attempt;
        await this.deleteStagedRefs(cancelled);
      } catch (error) { if (!(error instanceof ConflictError)) throw error; }
    }
  }
  /** A committed exchange claim cannot be retried after a Gateway restart. */
  public async recoverInterrupted(): Promise<void> {
    for (const attempt of await this.port.storage.channelOAuthAttempts.listInterruptedExchanges()) {
      if (attempt.installationId !== this.port.installationId) continue;
      try {
        const failed = await this.port.storage.channelOAuthAttempts.update(attempt.attemptId, {
          expectedRevision: attempt.revision, status: "failed", failureCode: "unknown_exchange_outcome",
        });
        await this.deleteStagedRefs(failed);
      } catch (error) { if (!(error instanceof ConflictError)) throw error; }
    }
  }
  /** Called at startup and periodically; retry cleanup refs if keychain deletion fails. */
  public async cleanupExpired(): Promise<void> {
    const now = new Date().toISOString();
    for (const attempt of await this.port.storage.channelOAuthAttempts.listExpiring(now, 100)) {
      try {
        const expired = ["pending", "exchanging", "ready"].includes(attempt.status)
          ? await this.port.storage.channelOAuthAttempts.update(attempt.attemptId, { expectedRevision: attempt.revision, status: "expired" })
          : attempt;
        await this.deleteStagedRefs(expired);
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
      }
    }
  }
  private async deleteStagedRefs(attempt: ChannelOAuthAttemptRecord): Promise<void> {
    for (const ref of Object.values(attempt.secretRefs)) this.requireCustody().deleteTemporary(ref);
    if (Object.keys(attempt.secretRefs).length) {
      await this.port.storage.channelOAuthAttempts.update(attempt.attemptId, {
        expectedRevision: attempt.revision, status: attempt.status, secretRefs: {},
      });
    }
  }
  private async requireActor(actor: ChannelOAuthActor, workspaceId: string): Promise<void> {
    if (!actor.actorId || actor.actorId === "anonymous" || actor.workspaceId !== workspaceId) {
      throw new PolicyViolationError({ message: "An authenticated workspace operator is required." });
    }
    const workspace = await this.port.storage.workspaces.get(workspaceId);
    if (workspace.lifecycleStatus === "archived") throw new PolicyViolationError({ message: "The workspace is archived." });
  }
  private async requireAttempt(actor: ChannelOAuthActor, attemptId: string): Promise<ChannelOAuthAttemptRecord> {
    const attempt = await this.port.storage.channelOAuthAttempts.get(attemptId);
    if (attempt.installationId !== this.port.installationId || attempt.workspaceId !== actor.workspaceId || attempt.actorId !== actor.actorId) {
      throw new NotFoundError({ entity: "Channel OAuth attempt" });
    }
    return attempt;
  }
  private async requireDraft(draftId: string, revision: number): Promise<ChannelSetupDraft> {
    const draft = await this.port.storage.channelSetupDrafts.get(draftId);
    assertDraftRevision(draft, revision);
    if (draft.catalogId !== "channel.slack") throw new ValidationError({ message: "Slack OAuth requires a Slack setup draft." });
    return draft;
  }
  private async requireConnectionBinding(draft: ChannelSetupDraft, install?: ChannelOAuthInstallReceipt): Promise<void> {
    if (!draft.connectionId) return;
    const connection = await this.port.storage.integrationConnections.get(draft.connectionId);
    if (!draft.connectionRevision || connection.revision !== draft.connectionRevision || connection.catalogId !== "channel.slack") {
      throw new ConflictError({ code: "WRITE_CONFLICT", message: "The saved Slack connection changed. Review it before continuing." });
    }
    if (install && ((connection.config.slackTeamId && connection.config.slackTeamId !== install.teamId) ||
        (connection.config.slackAppId && connection.config.slackAppId !== install.appId))) {
      throw new ConflictError({ message: "This installation differs from the Slack workspace or app being reauthorized." });
    }
  }
  private requireCustody() {
    if (!this.port.channelSecrets) throw new ValidationError({ message: "OS keychain custody is unavailable." });
    return this.port.channelSecrets;
  }
}
function hashState(state: string): string { return createHash("sha256").update(state).digest("hex"); }
function requireInstall(payload: SlackOAuthTokenPayload): ChannelOAuthInstallReceipt {
  const teamId = payload.team?.id?.trim();
  const appId = payload.app_id?.trim();
  const botUserId = payload.bot_user_id?.trim();
  if (payload.ok !== true || !payload.access_token?.startsWith("xoxb-") || !teamId || !appId || !botUserId ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(teamId) || !/^[A-Za-z0-9_-]{1,128}$/.test(appId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(botUserId)) {
    throw new ValidationError({ message: "Slack did not return a complete bot installation." });
  }
  return { installId: `slack:${teamId}:${appId}`, teamId, teamName: payload.team?.name?.slice(0,256),
    appId, botUserId, scopes: parseScopes(payload.scope ?? ""), installerUserId: payload.authed_user?.id?.slice(0,128) };
}
export function projectAttempt(attempt: ChannelOAuthAttemptRecord): ChannelOAuthAttempt {
  return {
    attemptId: attempt.attemptId, provider: attempt.provider, workspaceId: attempt.workspaceId,
    draftId: attempt.draftId, draftRevision: attempt.draftRevision, connectionId: attempt.connectionId,
    revision: attempt.revision, status: attempt.status, expiresAt: attempt.expiresAt,
    install: attempt.install, adoptedDraftRevision: attempt.adoptedDraftRevision, failureCode: attempt.failureCode,
    createdAt: attempt.createdAt, updatedAt: attempt.updatedAt,
  };
}