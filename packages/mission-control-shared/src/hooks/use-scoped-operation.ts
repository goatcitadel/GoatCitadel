import { useProjectAccess } from "./use-current-access";
import { describeApiError } from "../api/describe-api-error";
import { beginApprovalOperation, resumeUncertainApprovalOperation, releaseApprovalOperationCheck, updateApprovalOperation, useApprovalOperationAttempt } from "../state/scoped-operation-attempts";

/** Session-local replay suppression, using the shared attempt and access owners.
 * A changed record revision is never evidence that an interrupted write settled.
 * No credentials, input contents, or authorization are stored by this hook.
 */
export function useScopedOperation(scope: string) {
  const access = useProjectAccess(scope);
  const key = JSON.stringify(["library-operation", access.presentationScope]);
  const attempt = useApprovalOperationAttempt(key);
  const locked = Boolean(attempt && attempt.phase !== "resolved");
  async function run<T, R>(revision: string, preflight: () => Promise<T>, dispatch: (fresh: T) => Promise<R>, validate: (receipt: R) => void = () => undefined, replayExactOwnerRequest = false): Promise<R | undefined> {
    if (!access.current()) return;
    // Only callers with a durable idempotent owner request may opt into exact replay.
    const replay = replayExactOwnerRequest && attempt?.phase === "uncertain" && attempt.revision === revision;
    const token = replay ? resumeUncertainApprovalOperation(key, revision) : beginApprovalOperation(key, revision, true);
    if (!token) return;
    let sent = false;
    try {
      const fresh = await preflight();
      if (!access.current()) return;
      sent = true;
      updateApprovalOperation(key, token, "submitted", "Request submitted; its result is not yet confirmed.");
      const receipt = await dispatch(fresh);
      validate(receipt);
      updateApprovalOperation(key, token, "resolved", "The owner returned a receipt. Admission, approval and the final effect remain separate.");
      return access.current() ? receipt : undefined;
    } catch (cause) {
      if (sent) updateApprovalOperation(key, token, "uncertain", "The request outcome is uncertain. Another write is locked across navigation and record changes; a plain refresh does not settle the original attempt.");
      if (access.current()) throw new Error(`${describeApiError(cause).summary}${sent ? " The original attempt remains locked." : " No action was submitted."}`, { cause });
    } finally {
      if (replay && !sent) updateApprovalOperation(key, token, "uncertain", "The original request remains uncertain. Exact replay did not dispatch.");
      releaseApprovalOperationCheck(key, token);
    }
  }
  return { ...access, key, attempt, locked, run };
}
