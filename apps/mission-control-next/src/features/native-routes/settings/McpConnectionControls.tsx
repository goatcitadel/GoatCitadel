import type { ReactNode } from "react";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { useMcpConnection } from "./use-mcp-connection";
import { mcpConnectionUnavailable } from "./mcp-connection-mutation";

/** Shared explicit review; transports run only after guarded Gateway admission. */
export function McpConnectionControls({
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
  const state = useMcpConnection({ server, scope, onSettled });
  const connectReason = mcpConnectionUnavailable(server, "connect"),
    disconnectReason = mcpConnectionUnavailable(server, "disconnect");
  const review = state.review;
  return (
    <section aria-label="Reviewed MCP connection controls" className="space-y-3">
      <h4>Connection controls</h4>
      <p>
        These actions affect this installation. Connecting may start the saved process or contact the saved endpoint and
        enroll its allowed environment credentials. It discovers tools; it does not invoke them or grant permission.
      </p>
      <div className="flex flex-wrap gap-2">
        {button(
          "Review connection",
          () => void state.requestReview("connect"),
          state.checking || state.attempt.locked || Boolean(connectReason),
        )}
        {button(
          "Review disconnect",
          () => void state.requestReview("disconnect"),
          state.checking || state.attempt.locked || Boolean(disconnectReason),
        )}
      </div>
      {connectReason ? <p>{connectReason}</p> : null}
      {disconnectReason && disconnectReason !== connectReason ? <p>{disconnectReason}</p> : null}
      {state.message ? <p role={state.attempt.phase === "uncertain" ? "alert" : "status"}>{state.message}</p> : null}
      {review ? (
        <section aria-label="MCP connection action review" className="space-y-3">
          <h5>{review.action === "connect" ? "Review saved connection" : "Review saved disconnect"}</h5>
          <p>
            {review.action === "connect"
              ? "Confirm this exact saved command or endpoint. Gateway policy, network restrictions and credential checks remain authoritative."
              : "Confirm closing only sessions captured for this reviewed server generation. A replacement connection is not included."}
          </p>
          <dl className="grid gap-2">
            <dt>Server</dt>
            <dd>{review.server.label}</dd>
            <dt>Transport</dt>
            <dd>{review.server.transport}</dd>
            <dt>Saved command or endpoint</dt>
            <dd>
              <code className="break-all font-mono">
                {review.server.transport === "stdio" ? review.server.command : review.server.url}
              </code>
            </dd>
            <dt>Arguments in order</dt>
            <dd>
              <ol>
                {review.server.args?.map((arg, index) => (
                  <li key={index}>
                    <code className="break-all font-mono">{arg}</code>
                  </li>
                ))}
              </ol>
              {!review.server.args?.length ? "None" : null}
            </dd>
            <dt>Authentication</dt>
            <dd>{review.server.authType}</dd>
            <dt>Allowed environment keys</dt>
            <dd>{review.server.policy.allowedEnvKeys?.join(", ") || "None beyond standard process environment"}</dd>
            <dt>Last connection state</dt>
            <dd>{review.server.status}</dd>
          </dl>
          <p>Secret values remain hidden. The Gateway binds the exact saved configuration and connection revision.</p>
          <div className="flex flex-wrap gap-2">
            {button(
              review.action === "connect" ? "Connect reviewed server" : "Disconnect reviewed server",
              () => void state.confirm(),
              state.checking || state.attempt.locked,
            )}
            {button("Cancel connection review", state.cancel, state.attempt.phase === "saving")}
          </div>
        </section>
      ) : null}
    </section>
  );
}
