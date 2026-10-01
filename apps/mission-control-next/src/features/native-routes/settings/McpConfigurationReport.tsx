import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { canonicalJsonString, type ConnectorDiagnosticReport, type McpServerRecord } from "@goatcitadel/contracts";
import {
  fetchMcpServer,
  runMcpServerHealthCheck,
  isApiRequestError,
} from "@goatcitadel/mission-control-shared/api/client";
import { hasMcpServerBinding } from "./mcp-server-mutation";

type State = {
  phase: "idle" | "checking" | "sending" | "recorded" | "uncertain";
  message?: string;
  report?: ConnectorDiagnosticReport;
  binding?: string;
};
const IDLE: State = { phase: "idle" },
  states = new Map<string, State>(),
  listeners = new Set<() => void>();
const read = (id: string) => states.get(id) ?? IDLE;
const write = (id: string, state: State) => {
  states.set(id, state);
  for (const listener of listeners) listener();
};
function binding(server: McpServerRecord) {
  return canonicalJsonString([
    server.serverId,
    server.revision,
    server.connectionRevision,
    server.enabled,
    server.status,
    server.transport,
    server.command,
    server.url,
    server.policy,
  ]);
}
export function McpConfigurationReport({
  server,
  scope,
  button,
}: {
  server: McpServerRecord;
  scope: string;
  button: (label: string, click: () => void, disabled: boolean) => ReactNode;
}) {
  const identity = canonicalJsonString([scope, binding(server)]);
  const live = useRef({ identity, generation: 0, mounted: true });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.generation += 1;
  }
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.generation += 1;
    };
  }, []);
  const state = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => read(server.serverId),
    () => IDLE,
  );
  const locked = ["checking", "sending", "uncertain"].includes(state.phase);
  const report = state.binding === binding(server) ? state.report : undefined;
  async function record() {
    const id = server.serverId;
    if (["checking", "sending", "uncertain"].includes(read(id).phase) || !hasMcpServerBinding(server)) return;
    const generation = live.current.generation,
      snapshot = binding(server);
    const current = () =>
      live.current.mounted && live.current.generation === generation && live.current.identity === identity;
    let dispatched = false;
    write(id, { phase: "checking", message: "Checking current saved metadata…" });
    try {
      const before = await fetchMcpServer(id);
      if (!current()) {
        write(id, IDLE);
        return;
      }
      if (binding(before) !== snapshot) {
        write(id, {
          phase: "idle",
          message: "Server metadata changed. Refresh this inspection before recording a report.",
        });
        return;
      }
      write(id, { phase: "sending", message: "Recording a configuration report…" });
      dispatched = true;
      const result = await runMcpServerHealthCheck(id);
      if (
        result.connectorType !== "mcp_server" ||
        result.connectorId !== id ||
        !["ok", "warn", "error"].includes(result.status) ||
        !Number.isFinite(Date.parse(result.checkedAt)) ||
        !Array.isArray(result.checks) ||
        result.checks.length > 20 ||
        result.checks.some(
          (check) => !["pass", "warn", "fail"].includes(check.status) || typeof check.message !== "string",
        )
      )
        throw new Error("The configuration report does not match this server.");
      if (binding(await fetchMcpServer(id)) !== snapshot)
        throw new Error("The server changed while its report was recorded.");
      write(id, {
        phase: "recorded",
        binding: snapshot,
        report: result,
        message:
          "Gateway returned the recorded configuration report. It does not prove live connectivity or tool permission.",
      });
    } catch (error) {
      // This exact owner gate runs before the diagnostic record is constructed or persisted.
      const body = isApiRequestError(error) ? (error.body as Record<string, unknown> | undefined) : undefined;
      const details = body?.details as Record<string, unknown> | undefined;
      if (
        isApiRequestError(error) &&
        error.method === "POST" &&
        error.path === `/api/v1/mcp/servers/${encodeURIComponent(id)}/health-check` &&
        error.status === 409 &&
        body?.code === "STATE_CONFLICT" &&
        details?.flag === "connectorDiagnosticsV1Enabled" &&
        body.mutationCommitted !== true &&
        body.committed !== true &&
        details.mutationCommitted !== true &&
        details.committed !== true
      ) {
        write(id, {
          phase: "idle",
          message: "Connector diagnostics are disabled in this Gateway. No configuration report was recorded.",
        });
        return;
      }
      write(
        id,
        dispatched
          ? {
              phase: "uncertain",
              message: "Configuration report outcome is unconfirmed. Repeating it is locked for this app session.",
            }
          : { phase: "idle", message: "Current server metadata could not be checked." },
      );
    }
  }
  return (
    <section aria-label="MCP configuration report">
      <h4>Configuration report</h4>
      <p>
        This records checks of saved command or URL, enabled state, last connection status and policy. It does not start
        a process, contact the server or invoke tools.
      </p>
      {button("Record configuration check", () => void record(), locked || !hasMcpServerBinding(server))}
      {state.message ? (
        <p role={state.phase === "uncertain" ? "alert" : "status"}>
          {state.phase === "recorded" && !report
            ? "Saved metadata changed. The previous report is withheld; record a new configuration check when ready."
            : state.message}
        </p>
      ) : null}
      {report ? (
        <>
          <p>
            {report.status === "ok"
              ? "Checks passed"
              : report.status === "warn"
                ? "Review suggested"
                : "Configuration needs attention"}{" "}
            · {report.checkedAt}
          </p>
          <ul>
            {report.checks.map((check) => (
              <li key={check.key}>
                <strong>
                  {check.status === "pass" ? "Pass" : check.status === "warn" ? "Review" : "Needs attention"}
                </strong>
                : {check.message.slice(0, 2000)}
              </li>
            ))}
          </ul>
          {report.recommendedNextAction ? <p>{report.recommendedNextAction.slice(0, 2000)}</p> : null}
        </>
      ) : null}
    </section>
  );
}
export function __resetMcpConfigurationReportsForTests() {
  states.clear();
  for (const listener of listeners) listener();
}
