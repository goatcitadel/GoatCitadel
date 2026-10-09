import type { ReactNode } from "react";
import { NativeButton } from "../primitives";
import { describeToolApprovalMode } from "./helpers/permission-helpers";
import { PermissionSelectionReviewDetails } from "./sections/PermissionSelectionReviewDetails";
import type { usePermissionManagement } from "./use-permission-management";

export function PermissionManagementReview({
  control,
  retainedAttempt,
  renderButton = ({ label, secondary, ...props }) => (
    <NativeButton variant={secondary ? "outline" : "default"} {...props}>
      {label}
    </NativeButton>
  ),
}: {
  control: ReturnType<typeof usePermissionManagement>;
  retainedAttempt?: ReturnType<ReturnType<typeof usePermissionManagement>["attemptFor"]>;
  renderButton?: (props: { label: string; disabled: boolean; onClick: () => void; secondary?: boolean }) => ReactNode;
}) {
  const review = control.review;
  if (!review)
    return retainedAttempt ? (
      <p role={retainedAttempt.phase === "uncertain" ? "alert" : "status"}>{retainedAttempt.message}</p>
    ) : control.checking ? (
      <p role="status">Reading the permission owner…</p>
    ) : control.message ? (
      <p role="status">{control.message}</p>
    ) : null;
  const { operation } = review;
  const attempt = control.attemptFor(operation);
  const fields = "fields" in operation ? operation.fields : undefined;
  const override =
    operation.kind === "override-create"
      ? operation.input
      : operation.kind === "override-revoke"
        ? operation.override
        : undefined;
  return (
    <section aria-label="Review permission change" className="space-y-3 rounded-lg border border-line p-3">
      <h4 className="font-semibold">Review permission change</h4>
      <p>
        Gateway workspace: <span className="break-all font-mono">{review.workspaceId}</span>.
      </p>
      {fields ? (
        <>
          <p>
            {operation.kind === "create" ? "Create" : "Update"} <strong>{fields.label}</strong>:{" "}
            {describeToolApprovalMode(fields.approvalMode)}.
          </p>
          {fields.approvalMode === "bypass" ? (
            <p role="alert" className="text-status-waiting">
              This profile skips normal tool prompts wherever it is selected. Review every tool pattern and affected
              policy context. Required high-risk approvals and deny rules remain enforced.
            </p>
          ) : null}
          <dl className="space-y-2 text-sm">
            <div>
              <dt>Description</dt>
              <dd>
                {fields.description ??
                  (operation.kind === "update" ? operation.profile.description : undefined) ??
                  "None"}
              </dd>
            </div>
            <div>
              <dt>Tool patterns</dt>
              <dd className="break-all font-mono">{fields.toolPatterns.join(", ") || "None"}</dd>
            </div>
            <div>
              <dt>Allow rules</dt>
              <dd className="break-all font-mono">{fields.allow.join(", ") || "None"}</dd>
            </div>
            <div>
              <dt>Deny rules</dt>
              <dd className="break-all font-mono">{fields.deny.join(", ") || "None"}</dd>
            </div>
            <div>
              <dt>Read access</dt>
              <dd>
                {fields.readAccessMode ??
                  (operation.kind === "update" ? operation.profile.readAccessMode : undefined) ??
                  "Gateway default"}
              </dd>
            </div>
            <div>
              <dt>Default policy contexts</dt>
              <dd>{fields.defaultForSurfaces.join(", ") || "None"}</dd>
            </div>
          </dl>
          <p>
            Changing a profile affects future policy evaluation wherever it is already selected. Default-context changes
            can replace existing selections.
          </p>
        </>
      ) : null}
      {operation.kind === "archive" ? (
        <p>
          Archive <strong>{operation.profile.label}</strong>. It will no longer be available for activation or normal
          policy selection.
        </p>
      ) : null}
      {override ? (
        <>
          <p>
            {operation.kind === "override-create" ? "Start" : "End"} a temporary override for{" "}
            <strong>{override.scope}</strong>
            {override.scopeRef ? (
              <>
                : <span className="break-all font-mono">{override.scopeRef}</span>
              </>
            ) : (
              " (this operator across workspaces)"
            )}
            .
          </p>
          <p>Reason: {override.reason}</p>
          {operation.kind === "override-create" ? (
            <p>
              Duration: {operation.input.ttlSeconds} seconds, starting at the database-owned creation time. This grants
              broad local tool access and skips normal prompts.
            </p>
          ) : null}
          <p>
            The override API has no revision token. A fresh owner read checks this review, but cannot make the read and
            write atomic.
          </p>
        </>
      ) : null}
      <p>
        Hard denies, auth, path jails, network boundaries, disabled capabilities and Code Mode policy and artifact
        checks remain enforced.
      </p>
      {review.selection ? <PermissionSelectionReviewDetails review={review.selection} /> : null}
      {"profile" in operation ? (
        <details>
          <summary>Reviewed owner identity</summary>
          <p className="break-all font-mono text-xs">
            {operation.profile.profileId} · revision {operation.profile.revision}
          </p>
        </details>
      ) : null}
      {attempt ? <p role="status">{attempt.message}</p> : null}
      <div className="flex flex-wrap gap-2">
        {renderButton({
          label: "Apply reviewed permission change",
          disabled: Boolean(attempt),
          onClick: () => void control.confirm(),
        })}
        {renderButton({
          label: "Cancel permission change",
          secondary: true,
          disabled: attempt?.phase === "submitted",
          onClick: control.invalidate,
        })}
      </div>
    </section>
  );
}
