import type { ReactNode } from "react";
import { Button } from "../../ui/Button";

export function ApprovalDecisionStatus({
  message,
  uncertain,
  error,
  rechecking,
  checkAgain,
}: {
  message?: ReactNode;
  uncertain: boolean;
  error?: ReactNode;
  rechecking: boolean;
  checkAgain: () => Promise<void>;
}) {
  return (
    <>
      {message ? (
        <p role={uncertain ? "alert" : "status"} className="text-fg-muted">
          {message}
        </p>
      ) : null}
      {uncertain ? (
        <Button type="button" size="sm" disabled={rechecking} onClick={() => void checkAgain()}>
          Check again
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-status-failed">
          {error}
        </p>
      ) : null}
    </>
  );
}
