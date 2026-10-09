import { beforeEach, expect, it, vi } from "vitest";
import {
  __resetMcpCreationForTests,
  checkMcpCreationOutcome,
  commitMcpCreation,
  readMcpCreationAttempt,
} from "./mcp-create-mutation";
import type { McpCreateInput } from "./mcp-create-binding";

const api = vi.hoisted(() => ({ createMcpServer: vi.fn(), fetchMcpServer: vi.fn(), fetchMcpServers: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
}));
const attempts = vi.hoisted(() => ({ paths: [] as string[], read: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://mcp-fixture",
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

const input = { label: "Fixture", transport: "stdio", command: "fixture" } as unknown as McpCreateInput;
const readback = vi.fn(async () => undefined);
beforeEach(() => {
  vi.resetAllMocks();
  attempts.paths.length = 0;
  readback.mockResolvedValue(undefined);
  __resetMcpCreationForTests();
  api.fetchMcpServers.mockResolvedValue({ items: [] });
});

it("keeps the identity of a lost registration and settles it from the Gateway's record", async () => {
  attempts.paths.push("/api/v1/mcp/servers");
  api.createMcpServer.mockRejectedValue(new Error("response lost"));
  expect((await commitMcpCreation(input, () => true)).status).toBe("uncertain");
  expect(readMcpCreationAttempt()).toMatchObject({
    phase: "uncertain",
    transport: { routePattern: "/api/v1/mcp/servers" },
  });
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  expect(await checkMcpCreationOutcome(readback)).toMatch(/recorded this MCP registration as processed/);
  expect(readback).toHaveBeenCalledOnce();
  expect(readMcpCreationAttempt().phase).toBe("idle");
  expect(api.createMcpServer).toHaveBeenCalledOnce();
});

it("keeps the registration lock while the Gateway has no record", async () => {
  attempts.paths.push("/api/v1/mcp/servers");
  api.createMcpServer.mockRejectedValue(new Error("response lost"));
  await commitMcpCreation(input, () => true);
  attempts.read.mockResolvedValue({ status: "absent" });
  expect(await checkMcpCreationOutcome(readback)).toBeUndefined();
  expect(readMcpCreationAttempt()).toMatchObject({ phase: "uncertain", message: expect.stringMatching(/no record/) });
});
