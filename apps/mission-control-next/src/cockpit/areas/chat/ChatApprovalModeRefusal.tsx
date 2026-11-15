import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

export type ApprovalModeRefusal = "needs_sign_in" | "needs_local_connection";

/** Why the Gateway refused the approval mode read: only a 403 is a refusal; a pending access read never claims sign-in is missing. */
export function approvalModeRefusal(error: unknown, actorSource: string | undefined): ApprovalModeRefusal | null {
  if (!isApiRequestError(error) || error.status !== 403) return null;
  return actorSource === "none" ? "needs_sign_in" : "needs_local_connection";
}

export function ApprovalModeRefusalRow({ refusal, scope }: { refusal: ApprovalModeRefusal; scope: string }) {
  const needsSignIn = refusal === "needs_sign_in";
  return (
    <section
      aria-label="Chat approval mode"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-subtle px-3 py-1.5"
    >
      <p className="text-sm text-fg-secondary">
        {needsSignIn
          ? "Auto mode and Managed files need sign-in. Set up sign-in in Settings › Access to use them in project conversations."
          : "Auto mode and Managed files work only from a signed-in browser on the computer that runs GoatCitadel."}
      </p>
      <NativeOwnerLink href="/settings/access#gateway-auth" scope={scope} className="text-sm">
        {needsSignIn ? "Set up sign-in" : "Review access"}
      </NativeOwnerLink>
    </section>
  );
}
