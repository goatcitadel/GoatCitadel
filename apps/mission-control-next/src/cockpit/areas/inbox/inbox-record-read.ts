import { isInstallWideApproval, type ApprovalRequest } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";

/** A read by id that answers 404 means the record is gone or out of scope: no record, not an error. */
export async function nullWhenMissing<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (isApiRequestError(error) && error.kind === "http" && error.status === 404) return null;
    throw error;
  }
}

/**
 * An Inbox approval's record. A linked approval is read in its workspace. An install-wide one (a skill change) belongs
 * to no workspace, so it is read without one, and a record that turns out to be linked to a workspace is treated as
 * missing: an install-wide item never shows or decides a linked approval.
 */
export async function readInboxApproval(
  approvalId: string,
  { workspaceId, installWide, signal }: { workspaceId: string; installWide: boolean; signal?: AbortSignal },
): Promise<ApprovalRequest | null> {
  if (!installWide) return nullWhenMissing(fetchApproval(approvalId, { workspaceId, signal }));
  const record = await nullWhenMissing(fetchApproval(approvalId, { signal }));
  return record && isInstallWideApproval(record) ? record : null;
}

/**
 * The cache key of an Inbox approval's record. An install-wide one has no workspace in it, as in the Skills tab's
 * approval dialog, so both read one record; the decision bar refreshes either key after a decision.
 */
export function inboxApprovalRecordKey(
  workspaceId: string,
  installWide: boolean,
  approvalId: string,
  identity: string,
) {
  return ["approvals", "record", installWide ? null : workspaceId, approvalId, identity];
}
