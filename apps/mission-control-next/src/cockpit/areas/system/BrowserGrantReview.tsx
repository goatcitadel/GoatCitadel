import type { BrowserSessionGrantRecord } from "@goatcitadel/contracts";
import { formatTime, type GrantDraft, type GrantRequest } from "./browser-sessions-model";

export type GrantReview =
  | { kind: "create"; request: GrantRequest; requestId: string; expiresAtPreview: string | null; submitted: GrantDraft }
  | { kind: "rotate" | "revoke"; grant: BrowserSessionGrantRecord; otherActiveForActor: number };

/** States exactly what the reviewed grant change does, before Cancel or Confirm. */
export function GrantReviewBody({ review }: { review: GrantReview }) {
  if (review.kind === "create") {
    const { request } = review;
    return (
      <>
        <p>
          <strong>Actor:</strong> {request.actorId}
        </p>
        <p>
          <strong>Scopes:</strong> {request.scopes.join(", ")}
        </p>
        <p>
          <strong>Hosts:</strong>{" "}
          {request.allowedHosts.length ? request.allowedHosts.join(", ") : "Every host (not host-scoped)"}
        </p>
        {review.expiresAtPreview ? (
          <p>
            <strong>Expires:</strong> about {formatTime(review.expiresAtPreview)} (the Gateway sets the exact time)
          </p>
        ) : (
          <p role="note">
            <strong>Expires: Never.</strong> This grant stays active until you revoke it, including after this session
            is idle. Choose a timed grant unless the access is meant to be permanent.
          </p>
        )}
        <p>
          Gives {request.actorId} this access to the session until it {review.expiresAtPreview ? "expires or " : ""}is
          revoked. Tools still pass policy checks and guardrails; this does not open, bind or control a browser.
        </p>
      </>
    );
  }
  const { grant } = review;
  const scope = `${grant.scopes.join(", ")} on ${grant.allowedHosts.length ? grant.allowedHosts.join(", ") : "every host"}`;
  return (
    <>
      <p>
        <strong>Actor:</strong> {grant.actorId} · {scope}
      </p>
      <p>
        <strong>Expiry:</strong> {grant.expiresAt ? formatTime(grant.expiresAt) : "None (until revoked)"}
      </p>
      {review.kind === "rotate" ? (
        <p>
          Revokes this grant record and creates a replacement with the same actor, scopes, hosts and exact expiry.
          Access is checked by actor, so {grant.actorId} keeps the same access; only the grant record changes.
        </p>
      ) : (
        <p>
          Revokes this grant now. {grant.actorId} loses this grant&apos;s access
          {review.otherActiveForActor
            ? `, but ${review.otherActiveForActor} other active grant${review.otherActiveForActor === 1 ? "" : "s"} for this actor remain.`
            : " and has no other active grant on this session."}
        </p>
      )}
    </>
  );
}
