import { useState, type ComponentType, type ReactNode } from "react";
import { fetchMcpServer, fetchMcpServers, isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { NativeButton } from "../primitives";
import { checkMcpCreationOutcome, useMcpCreationMutation } from "./mcp-create-mutation";
import { checkMcpServerOutcome, useMcpServerMutation } from "./mcp-server-attempts";

type ButtonLike = ComponentType<{ disabled?: boolean; onClick: () => void; children: ReactNode }>;
type Target = { kind: "server"; serverId: string } | { kind: "create" };
// The canonical MCP owner reads. A registration reads the inventory. A server write reads that server, where its
// connection and auth state live; a missing server proves the outcome only when the lost write was a delete.
const inventoryReadback = async () => {
  await fetchMcpServers();
};
const serverReadback = (serverId: string, method: string | undefined) => async () => {
  try {
    await fetchMcpServer(serverId);
  } catch (error) {
    const body = isApiRequestError(error) ? (error.body as { code?: unknown } | undefined) : undefined;
    const deleted = isApiRequestError(error) && error.status === 404 && body?.code === "ENTITY_NOT_FOUND";
    if (!(method === "DELETE" && deleted)) throw error;
  }
};

/**
 * The one action that can settle an uncertain MCP write: it reads the Gateway's record of that exact attempt, then the
 * canonical owner read, before unlocking. `refresh` only updates the view afterwards and is never part of the proof.
 */
export function McpOutcomeCheck({
  target,
  refresh,
  buttonComponent: Button = NativeButton as unknown as ButtonLike,
}: {
  target: Target;
  refresh?: () => Promise<unknown> | void;
  buttonComponent?: ButtonLike;
}) {
  const server = useMcpServerMutation(target.kind === "server" ? target.serverId : "");
  const creation = useMcpCreationMutation();
  const attempt = target.kind === "server" ? server : creation;
  const [settled, setSettled] = useState<string | null>(null);
  if (attempt.phase !== "uncertain") return settled ? <p role="status">{settled}</p> : null;
  if (!attempt.transport) return null;
  return (
    <Button
      disabled={Boolean(attempt.checking)}
      onClick={() =>
        void (
          target.kind === "server"
            ? checkMcpServerOutcome(target.serverId, serverReadback(target.serverId, attempt.transport?.method))
            : checkMcpCreationOutcome(inventoryReadback)
        ).then(async (message) => {
          if (!message) return;
          setSettled(message);
          await Promise.resolve(refresh?.()).catch(() => undefined);
        })
      }
    >
      {attempt.checking ? "Checking outcome…" : "Check outcome"}
    </Button>
  );
}
