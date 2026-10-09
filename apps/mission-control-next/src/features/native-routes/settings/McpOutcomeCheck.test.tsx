// @vitest-environment happy-dom
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { McpOutcomeCheck } from "./McpOutcomeCheck";
import {
  __resetMcpServerMutationsForTests,
  readMcpServerAttempt,
  trackMcpWrite,
  writeMcpServerAttempt,
} from "./mcp-server-attempts";

const api = vi.hoisted(() => ({ fetchMcpServers: vi.fn(), fetchMcpServer: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
}));
const notFound = { status: 404, body: { code: "ENTITY_NOT_FOUND" } };
const attempts = vi.hoisted(() => ({ paths: [] as string[], read: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://mcp-fixture",
  captureMutationAttempt: (dispatch: () => Promise<unknown>, onAttempt: (attempt: unknown) => void) => {
    const path = attempts.paths.shift();
    if (path)
      onAttempt({
        attemptKey: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b",
        method: path.endsWith("-reviewed") ? "POST" : "DELETE",
        path,
      });
    return dispatch();
  },
}));
vi.mock("@goatcitadel/mission-control-shared/api/mutation-attempts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMutationAttempt: attempts.read,
}));

let view: ReactTestRenderer;
const refresh = vi.fn(async () => undefined);
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
async function loseDelete() {
  writeMcpServerAttempt("server-1", { phase: "saving" });
  attempts.paths.push("/api/v1/mcp/servers/server-1");
  await trackMcpWrite("server-1", () => Promise.reject(new Error("response lost"))).catch(() => undefined);
  writeMcpServerAttempt("server-1", { phase: "uncertain", message: "Delete outcome is unconfirmed." });
}
beforeEach(() => {
  vi.resetAllMocks();
  attempts.paths.length = 0;
  __resetMcpServerMutationsForTests();
});
afterEach(async () => {
  await act(async () => view?.unmount());
});

it("settles a lost server delete when the server read confirms it is gone, then refreshes", async () => {
  await loseDelete();
  api.fetchMcpServer.mockRejectedValue(notFound);
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  await act(async () => {
    view = create(<McpOutcomeCheck target={{ kind: "server", serverId: "server-1" }} refresh={refresh} />);
  });
  await act(async () => view.root.findByType("button").props.onClick());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(api.fetchMcpServer).toHaveBeenCalledWith("server-1");
  expect(refresh).toHaveBeenCalled();
  expect(readMcpServerAttempt("server-1").phase).toBe("idle");
  expect(text(view.root)).toContain("recorded this MCP change as processed");
});

it("keeps the server lock when the server read fails", async () => {
  await loseDelete();
  api.fetchMcpServer.mockRejectedValue(new Error("server read unavailable"));
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  await act(async () => {
    view = create(<McpOutcomeCheck target={{ kind: "server", serverId: "server-1" }} refresh={refresh} />);
  });
  await act(async () => view.root.findByType("button").props.onClick());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(readMcpServerAttempt("server-1").phase).toBe("uncertain");
  expect(refresh).not.toHaveBeenCalled();
});

it("does not accept a missing server as proof for a lost non-delete write", async () => {
  writeMcpServerAttempt("server-1", { phase: "saving" });
  attempts.paths.push("/api/v1/mcp/servers/server-1/connect-reviewed");
  await trackMcpWrite("server-1", () => Promise.reject(new Error("response lost"))).catch(() => undefined);
  writeMcpServerAttempt("server-1", { phase: "uncertain", message: "Connect outcome is unconfirmed." });
  api.fetchMcpServer.mockRejectedValue(notFound);
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  await act(async () => {
    view = create(<McpOutcomeCheck target={{ kind: "server", serverId: "server-1" }} refresh={refresh} />);
  });
  await act(async () => view.root.findByType("button").props.onClick());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(readMcpServerAttempt("server-1").phase).toBe("uncertain");
});
