import type { ReactNode } from "react";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { mcpOAuthUnavailable } from "./mcp-oauth-binding";
import { useMcpOAuth } from "./use-mcp-oauth";

/** Both Settings presentations use the same reviewed owner; opening this panel performs no mutation. */
export function McpOAuthControls({
  server,
  scope,
  onSettled,
  button,
}: {
  server: McpServerRecord;
  scope: string;
  onSettled: () => Promise<unknown>;
  button: (label: string, click: () => void, disabled: boolean) => ReactNode;
}) {
  const state = useMcpOAuth({ server, scope, onSettled });
  if (server.authType !== "oauth2") return null;
  const reason = mcpOAuthUnavailable(server),
    review = state.review;
  const disabled = state.checking || state.attempt.locked;
  return (
    <section aria-label="Reviewed MCP OAuth controls" className="space-y-3">
      <h4>OAuth authorization</h4>
      <p>
        This installation-wide action closes the current MCP connection and replaces its authorization request and
        grant. Allowed environment credentials may be enrolled. It does not invoke tools.
      </p>
      <p>
        The Gateway has no automatic MCP OAuth callback here. Use a provider flow that returns a code and state you can
        submit manually. Authentication does not reconnect this server.
      </p>
      {button("Review OAuth authorization", () => void state.requestReview("start"), disabled || Boolean(reason))}
      {reason ? <p>{reason}</p> : null}
      {state.message ? <p role={state.attempt.phase === "uncertain" ? "alert" : "status"}>{state.message}</p> : null}
      {state.flow && !state.attempt.locked ? (
        <section aria-label="Current MCP authorization request" className="space-y-3">
          <p>
            Request acknowledged for this saved server. The provider decides whether this redirect and manual exchange
            are supported.
          </p>
          <a href={state.flow.authorizeUrl} target="_blank" rel="noopener noreferrer" className="text-accent underline">
            Open authorization page
          </a>
          <p>
            Expected state: <code className="break-all font-mono">{state.flow.state}</code>
          </p>
          <label className="block">
            Authorization code
            <input
              type="password"
              autoComplete="off"
              maxLength={8192}
              value={state.fields.code}
              disabled={disabled}
              className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-fg"
              onChange={(event) => state.edit("code", event.target.value)}
            />
          </label>
          <label className="block">
            Returned state
            <input
              type="text"
              autoComplete="off"
              maxLength={128}
              value={state.fields.state}
              disabled={disabled}
              className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-fg"
              onChange={(event) => state.edit("state", event.target.value)}
            />
          </label>
          <p>Codes remain transient in this view and are cleared when dispatched or cancelled.</p>
          {button("Review authorization completion", () => void state.requestReview("complete"), disabled)}
        </section>
      ) : null}
      {review ? (
        <section aria-label="MCP OAuth action review" className="space-y-3">
          <h5>
            {review.action === "start" ? "Review authorization replacement" : "Review authentication publication"}
          </h5>
          <p>
            {review.action === "start"
              ? "Confirm closing the reviewed connection and replacing its grant before opening a new authorization page."
              : "Confirm sending this transient code to the saved token endpoint and publishing returned authentication. The server stays disconnected."}
          </p>
          <dl className="grid gap-2">
            <dt>Server</dt>
            <dd>{review.server.label}</dd>
            <dt>Authorization endpoint</dt>
            <dd>
              <code className="break-all font-mono">{review.server.oauth?.authorizationUrl}</code>
            </dd>
            <dt>Token endpoint</dt>
            <dd>
              <code className="break-all font-mono">{review.server.oauth?.tokenUrl}</code>
            </dd>
            <dt>Redirect</dt>
            <dd>
              <code className="break-all font-mono">
                {review.server.oauth?.redirectUri || "http://127.0.0.1:8787/api/v1/mcp/oauth/callback"}
              </code>
            </dd>
            <dt>Requested scopes</dt>
            <dd>{review.server.oauth?.scopes?.join(", ") || "None configured"}</dd>
            <dt>Allowed environment keys</dt>
            <dd>{review.server.policy.allowedEnvKeys?.join(", ") || "None"}</dd>
            <dt>Current connection</dt>
            <dd>{review.server.status}</dd>
          </dl>
          <p>
            The exact saved configuration and connection generation are checked again before admission. Secret values
            remain hidden.
          </p>
          <div className="flex flex-wrap gap-2">
            {button(
              review.action === "start" ? "Start reviewed authorization" : "Complete reviewed authorization",
              () => void state.confirm(),
              disabled,
            )}
            {button("Cancel OAuth review", state.cancel, state.attempt.phase === "saving")}
          </div>
        </section>
      ) : null}
    </section>
  );
}
