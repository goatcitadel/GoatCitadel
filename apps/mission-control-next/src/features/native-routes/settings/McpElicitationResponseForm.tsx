import { useId, useState, type ReactNode } from "react";
import {
  canonicalJsonString,
  type McpElicitationRequest,
  type McpElicitationResponseAction,
} from "@goatcitadel/contracts";
import { useMcpElicitationResponse } from "./use-mcp-elicitation-response";

export function McpElicitationResponseForm({
  request,
  workspaceId,
  onRecorded,
  fieldClass,
  className,
  button,
}: {
  request: McpElicitationRequest;
  workspaceId: string;
  onRecorded?: () => void | Promise<void>;
  fieldClass: string;
  className?: string;
  button: (label: string, click: () => void, disabled: boolean) => ReactNode;
}) {
  const control = useMcpElicitationResponse({ request, workspaceId, onRecorded });
  const id = useId();
  const [review, setReview] = useState<{ action: McpElicitationResponseAction; identity: string } | null>(null);
  const identity = canonicalJsonString([request, control.draft.value]);
  const set = (key: string, value: string) => control.draft.setValue((current) => ({ ...current, [key]: value }));
  return (
    <section aria-label="MCP response form" className={className}>
      <p>{request.prompt.text.slice(0, 4096)}</p>
      <p>
        This records an operator response in the Gateway's current elicitation list. Records are held for this Gateway
        process; a response does not prove remote delivery or resume durable work. Do not provide secrets.
      </p>
      <dl>
        <dt>Request</dt>
        <dd>
          <code>{request.elicitationId}</code>
        </dd>
        <dt>Source server</dt>
        <dd>
          <code>{request.source.serverId ?? "Not attached"}</code>
        </dd>
        <dt>Source tool</dt>
        <dd>
          <code>{request.source.toolName ?? "No tool attached"}</code>
        </dd>
        <dt>Owner workspace</dt>
        <dd>{request.owner.workspaceId ?? "No workspace attached"}</dd>
        <dt>Owner session</dt>
        <dd>
          <code>{request.owner.sessionId ?? "No session attached"}</code>
        </dd>
      </dl>
      {control.attempt.message ? (
        <p role={control.attempt.phase === "uncertain" ? "alert" : "status"}>{control.attempt.message}</p>
      ) : null}
      {control.fields.unavailable ? <p role="status">{control.fields.unavailable}</p> : null}
      {!control.available && !control.attempt.locked ? (
        <p role="status">This request is resolved or outside the selected workspace.</p>
      ) : null}
      <fieldset disabled={!control.available || Boolean(review)} className={className}>
        <legend>Requested response</legend>
        {control.fields.fields.map((field, index) => (
          <div key={field.key}>
            <label htmlFor={`${id}-${index}`}>
              {field.title}
              {field.required ? " (required)" : ""}
            </label>
            {field.enum || field.type === "boolean" ? (
              <select
                id={`${id}-${index}`}
                className={fieldClass}
                value={control.draft.value[field.key] ?? ""}
                onChange={(event) => set(field.key, event.target.value)}
              >
                <option value="">Choose…</option>
                {(field.enum ?? [true, false]).map((value) => (
                  <option key={String(value)} value={String(value)}>
                    {String(value)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${id}-${index}`}
                className={fieldClass}
                type={field.type === "string" ? "text" : "number"}
                step={field.type === "integer" ? 1 : "any"}
                maxLength={field.maxLength ?? 2000}
                min={field.minimum}
                max={field.maximum}
                value={control.draft.value[field.key] ?? ""}
                onChange={(event) => set(field.key, event.target.value)}
              />
            )}
            {field.description ? <p>{field.description}</p> : null}
          </div>
        ))}
      </fieldset>
      {review ? (
        <section aria-label="Review MCP response" className={className}>
          <h4>Review {review.action} response</h4>
          <p>
            Request <code>{request.elicitationId}</code> · {request.prompt.text.slice(0, 300)}
          </p>
          {review.action === "accept" ? (
            <dl>
              {control.fields.fields.map((field) => (
                <div key={field.key}>
                  <dt>{field.title}</dt>
                  <dd>{control.draft.value[field.key] || "Not supplied"}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>No response content will be sent.</p>
          )}
          {review.identity !== identity ? (
            <p role="alert">The request or draft changed. Cancel this review and inspect it again.</p>
          ) : null}
          {button(
            "Confirm response",
            () => {
              const action = review.action;
              setReview(null);
              void control.respond(action);
            },
            !control.available || review.identity !== identity,
          )}
          {button("Cancel response review", () => setReview(null), control.attempt.pending)}
        </section>
      ) : (
        <div className={className}>
          {(["accept", "decline", "cancel"] as const).map((action) => (
            <span key={action}>
              {button(
                `Review ${action} response`,
                () => setReview({ action, identity }),
                !control.available || (action === "accept" && Boolean(control.fields.unavailable)),
              )}
            </span>
          ))}
        </div>
      )}
      <details>
        <summary>Requested schema</summary>
        <pre className="overflow-auto whitespace-pre-wrap break-all">
          {JSON.stringify(request.requestedSchema.value, null, 2)}
        </pre>
      </details>
    </section>
  );
}
