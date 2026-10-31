import type { ReactNode } from "react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { updateInboxApprovalAttempt } from "./inbox-approval-attempts";

/**
 * A decision bar's step after the record is re-read and before the approval is sent (turning Code Mode on). `progress`
 * replaces the bar's status line meanwhile. An error may name where its next step is with `href` and `linkLabel`.
 */
export type PrepareApprove = (progress: (message: string) => void) => Promise<void>;

/** Why a prepare step stopped: its plain summary, and the line the bar shows, with a link to the next step if any. */
export interface PrepareFailure {
  summary: string;
  line: ReactNode;
}

function nextStepLink(cause: unknown): { href: string; label: string } | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const { href, linkLabel } = cause as { href?: unknown; linkLabel?: unknown };
  return typeof href === "string" && typeof linkLabel === "string" ? { href, label: linkLabel } : undefined;
}

/**
 * Runs a prepare step under the decision attempt `token` for this approval, whose status line shows its progress.
 * Returns undefined once it finished, or why it stopped; it never throws.
 */
export async function runPrepareApprove(
  prepare: PrepareApprove,
  workspaceId: string,
  approvalId: string,
  token: symbol,
): Promise<PrepareFailure | undefined> {
  try {
    await prepare((message) => updateInboxApprovalAttempt(workspaceId, approvalId, token, "checking", message));
    return undefined;
  } catch (cause) {
    const summary = describeApiError(cause).summary;
    const link = nextStepLink(cause);
    if (!link) return { summary, line: summary };
    return {
      summary,
      line: (
        // Every sentence that points somewhere links there, in the same element.
        <>
          {summary}{" "}
          <NativeOwnerLink
            href={link.href}
            scope={[workspaceId, approvalId]}
            className="font-medium text-accent hover:underline"
          >
            {link.label}
          </NativeOwnerLink>
        </>
      ),
    };
  }
}
