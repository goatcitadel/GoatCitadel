import { beforeEach, expect, it, vi } from "vitest";
import {
  __resetMcpServerMutationsForTests,
  checkMcpServerOutcome,
  readMcpServerAttempt,
  trackMcpWrite,
  writeMcpServerAttempt,
} from "./mcp-server-attempts";

// Each owner write reports the attempt it dispatched, as the real capture would for its Gateway route.
const attempts = vi.hoisted(() => ({ paths: [] as string[], read: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  captureMutationAttempt: (dispatch: () => Promise<unknown>, onAttempt: (attempt: unknown) => void) => {
    const path = attempts.paths.shift();
    if (path) onAttempt({ attemptKey: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", method: "POST", path });
    return dispatch();
  },
}));
vi.mock("@goatcitadel/mission-control-shared/api/mutation-attempts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMutationAttempt: attempts.read,
}));

const readback = vi.fn(async () => undefined);
/** An owner operation shaped like the real ones: saving, a tracked dispatch that loses its reply, then uncertain. */
async function loseServerWrite(id: string, path?: string) {
  writeMcpServerAttempt(id, { phase: "saving" });
  if (path) attempts.paths.push(path);
  await trackMcpWrite(id, () => Promise.reject(new Error("response lost"))).catch(() => undefined);
  writeMcpServerAttempt(id, { phase: "uncertain", message: "MCP save outcome is unconfirmed." });
}
beforeEach(() => {
  vi.resetAllMocks();
  attempts.paths.length = 0;
  readback.mockResolvedValue(undefined);
  __resetMcpServerMutationsForTests();
});

it("keeps the identity of a lost server write and settles it from the Gateway's record", async () => {
  await loseServerWrite("server-1", "/api/v1/mcp/servers/server-1/connect-reviewed");
  expect(readMcpServerAttempt("server-1")).toMatchObject({
    phase: "uncertain",
    transport: { routePattern: "/api/v1/mcp/servers/:serverId/connect-reviewed" },
  });
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  const notice = await checkMcpServerOutcome("server-1", readback);
  expect(readback).toHaveBeenCalledOnce();
  expect(notice).toMatch(/recorded this MCP change as processed/);
  expect(readMcpServerAttempt("server-1").phase).toBe("idle");
});

it.each([
  ["/api/v1/mcp/servers/server-1/connect-reviewed", "/api/v1/mcp/servers/:serverId/connect-reviewed"],
  ["/api/v1/mcp/servers/server-1/disconnect-reviewed", "/api/v1/mcp/servers/:serverId/disconnect-reviewed"],
])("identifies a lost reviewed connection write %s", async (path, pattern) => {
  await loseServerWrite("server-1", path);
  expect(readMcpServerAttempt("server-1").transport?.routePattern).toBe(pattern);
});

it("never lends a previous operation's identity to a later lost write it could not identify", async () => {
  writeMcpServerAttempt("server-1", { phase: "saving" });
  attempts.paths.push("/api/v1/mcp/servers/server-1");
  await trackMcpWrite("server-1", () => Promise.resolve("ok"));
  writeMcpServerAttempt("server-1", { phase: "saved", message: "Saved." });
  await loseServerWrite("server-1");
  expect(readMcpServerAttempt("server-1").transport).toBeUndefined();
  await checkMcpServerOutcome("server-1", readback);
  expect(attempts.read).not.toHaveBeenCalled();
});

it.each([
  [{ status: "pending", claimExpired: false }, /still running/],
  [{ status: "absent" }, /no record/],
])("keeps the server lock for %o", async (record, message) => {
  await loseServerWrite("server-1", "/api/v1/mcp/servers/server-1");
  attempts.read.mockResolvedValue(record);
  expect(await checkMcpServerOutcome("server-1", readback)).toBeUndefined();
  expect(readMcpServerAttempt("server-1")).toMatchObject({
    phase: "uncertain",
    message: expect.stringMatching(message),
  });
  expect(readback).not.toHaveBeenCalled();
});

it("keeps the server lock when the readback fails, with fixed copy", async () => {
  await loseServerWrite("server-1", "/api/v1/mcp/servers/server-1");
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  readback.mockRejectedValue(new Error("API error 503: gateway-internal-detail"));
  await checkMcpServerOutcome("server-1", readback);
  expect(readMcpServerAttempt("server-1").message).toMatch(/check failed/);
  expect(readMcpServerAttempt("server-1").message).not.toContain("gateway-internal-detail");
});
