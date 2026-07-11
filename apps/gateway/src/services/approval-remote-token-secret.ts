import { ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { SecretStoreService } from "./secret-store-service.js";

const SECRET_REF_PREFIX = "keychain:goatcitadel:";
const REMOTE_APPROVAL_ACCOUNT_PREFIX = "approval-remote-action:";

type ApprovalRemoteTokenSecretStore = Pick<SecretStoreService, "setSecret" | "getSecret" | "deleteSecret">;
type ApprovalRemoteTokenRepository = Pick<
  Storage["remoteActionTokens"],
  "listPendingExpiredAtOrBefore" | "expirePendingAtOrBefore"
>;

export class ApprovalRemoteTokenSecretService {
  public constructor(
    private readonly storeBackend: ApprovalRemoteTokenSecretStore,
    private readonly tokens: ApprovalRemoteTokenRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public store(tokenId: string, token: string): string {
    return storeApprovalRemoteTokenSecret(this.storeBackend, tokenId, token);
  }

  public resolve(secretRef: string): string {
    return resolveApprovalRemoteTokenSecret(this.storeBackend, secretRef);
  }

  public delete(secretRef: string): void {
    deleteApprovalRemoteTokenSecret(this.storeBackend, secretRef);
  }

  public deleteById(tokenId: string): void {
    this.delete(buildApprovalRemoteTokenSecretRef(tokenId));
  }

  public reconcileExpired(limit = 100): number {
    const boundaryAt = this.now().toISOString();
    const candidates = this.tokens.listPendingExpiredAtOrBefore(boundaryAt, limit);
    let expired = 0;
    let cleanupError: unknown;
    for (const candidate of candidates) {
      try {
        this.deleteById(candidate.tokenId);
      } catch (error) {
        cleanupError ??= error;
        continue;
      }
      const current = this.tokens.expirePendingAtOrBefore(candidate.tokenId, boundaryAt);
      if (current.state === "expired") {
        expired += 1;
      }
    }
    if (cleanupError) {
      throw cleanupError;
    }
    return expired;
  }
}

export function storeApprovalRemoteTokenSecret(
  store: ApprovalRemoteTokenSecretStore,
  tokenId: string,
  token: string,
): string {
  const account = remoteApprovalTokenAccount(tokenId);
  store.setSecret(account, token);
  return buildApprovalRemoteTokenSecretRef(tokenId);
}

export function buildApprovalRemoteTokenSecretRef(tokenId: string): string {
  return `${SECRET_REF_PREFIX}${remoteApprovalTokenAccount(tokenId)}`;
}

export function resolveApprovalRemoteTokenSecret(store: ApprovalRemoteTokenSecretStore, secretRef: string): string {
  const account = accountFromSecretRef(secretRef);
  const token = store.getSecret(account)?.trim();
  if (!token?.startsWith("grat_")) {
    throw new ValidationError({ message: "Approval remote-action token secret is unavailable or invalid." });
  }
  return token;
}

export function deleteApprovalRemoteTokenSecret(store: ApprovalRemoteTokenSecretStore, secretRef: string): void {
  store.deleteSecret(accountFromSecretRef(secretRef));
}

function remoteApprovalTokenAccount(tokenId: string): string {
  const normalized = tokenId.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new ValidationError({ message: "Approval remote-action token id is invalid." });
  }
  return `${REMOTE_APPROVAL_ACCOUNT_PREFIX}${normalized}`;
}

function accountFromSecretRef(secretRef: string): string {
  const normalized = secretRef.trim();
  if (!normalized.startsWith(`${SECRET_REF_PREFIX}${REMOTE_APPROVAL_ACCOUNT_PREFIX}`)) {
    throw new ValidationError({ message: "Approval remote-action token secret reference is invalid." });
  }
  const account = normalized.slice(SECRET_REF_PREFIX.length);
  remoteApprovalTokenAccount(account.slice(REMOTE_APPROVAL_ACCOUNT_PREFIX.length));
  return account;
}
