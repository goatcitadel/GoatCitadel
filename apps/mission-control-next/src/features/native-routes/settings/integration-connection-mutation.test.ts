import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import {
  __resetIntegrationConnectionMutationsForTests,
  beginIntegrationMutation,
  checkIntegrationAttemptOutcome,
  commitIntegrationConnectionUpdate,
  readIntegrationAttempt,
} from "./integration-connection-mutation";

const api = vi.hoisted(() => ({ updateIntegrationConnection: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
}));
// Each owner write reports the attempt it dispatched, as the real capture would for its Gateway route.
const attempts = vi.hoisted(() => ({ paths: [] as string[], read: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  captureMutationAttempt: (dispatch: () => Promise<unknown>, onAttempt: (attempt: unknown) => void) => {
    const path = attempts.paths.shift();
    if (path) onAttempt({ attemptKey: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", method: "PATCH", path });
    return dispatch();
  },
}));
vi.mock("@goatcitadel/mission-control-shared/api/mutation-attempts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMutationAttempt: attempts.read,
}));

const reviewed = {
  connectionId: "connection-1",
  revision: "a".repeat(64),
  catalogId: "catalog",
  key: "key",
  kind: "channel",
  label: "Connection",
  enabled: false,
  status: "configured",
  config: {},
  workspaceId: "default",
  createdAt: "2026-10-01T00:00:00.000Z",
} as unknown as IntegrationConnection;
const readback = vi.fn(async () => undefined);
async function loseUpdate() {
  attempts.paths.push("/api/v1/integrations/connections/connection-1");
  api.updateIntegrationConnection.mockRejectedValue(new Error("response lost"));
  const result = await commitIntegrationConnectionUpdate({
    reviewed,
    input: { expectedRevision: reviewed.revision, enabled: true },
    isCurrent: () => true,
  });
  expect(result.status).toBe("uncertain");
}
beforeEach(() => {
  vi.resetAllMocks();
  attempts.paths.length = 0;
  readback.mockResolvedValue(undefined);
  __resetIntegrationConnectionMutationsForTests();
});
afterEach(() => __resetIntegrationConnectionMutationsForTests());

it("keeps the identity of a lost connection update and settles it from the Gateway's record", async () => {
  await loseUpdate();
  expect(readIntegrationAttempt("connection-1")).toMatchObject({
    phase: "uncertain",
    transport: { routePattern: "/api/v1/integrations/connections/:connectionId" },
  });
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  const notice = await checkIntegrationAttemptOutcome("connection-1", readback);
  expect(attempts.read).toHaveBeenCalledWith(
    "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    "PATCH",
    "/api/v1/integrations/connections/:connectionId",
  );
  expect(readback).toHaveBeenCalledOnce();
  expect(notice).toMatch(/recorded this integration change as processed/);
  expect(readIntegrationAttempt("connection-1").phase).toBe("idle");
  expect(api.updateIntegrationConnection).toHaveBeenCalledOnce();
});

it("keeps the identity of a lost write through the shared admission, by registered route pattern", async () => {
  const owner = beginIntegrationMutation("notification-target:t-1")!;
  attempts.paths.push("/api/v1/notifications/targets/t-1/test");
  await expect(
    owner.write(
      () => Promise.reject(new Error("response lost")),
      () => undefined,
    ),
  ).rejects.toThrow();
  owner.finish();
  expect(readIntegrationAttempt("notification-target:t-1")).toMatchObject({
    phase: "uncertain",
    transport: { routePattern: "/api/v1/notifications/targets/:targetId/test" },
  });
});

it.each([
  [{ status: "pending", claimExpired: false }, /still running/],
  [{ status: "absent" }, /no record/],
])("keeps the integration lock for %o", async (record, message) => {
  await loseUpdate();
  attempts.read.mockResolvedValue(record);
  expect(await checkIntegrationAttemptOutcome("connection-1", readback)).toBeUndefined();
  expect(readIntegrationAttempt("connection-1")).toMatchObject({
    phase: "uncertain",
    message: expect.stringMatching(message),
  });
  expect(readback).not.toHaveBeenCalled();
});

it("keeps the integration lock when the read fails, with fixed copy", async () => {
  await loseUpdate();
  attempts.read.mockRejectedValue(new Error("API error 403: gateway-internal-detail"));
  await checkIntegrationAttemptOutcome("connection-1", readback);
  const attempt = readIntegrationAttempt("connection-1");
  expect(attempt.phase).toBe("uncertain");
  expect(attempt.message).toMatch(/check failed/);
  expect(attempt.message).not.toContain("gateway-internal-detail");
});

it("offers no check for a lost write it could not identify", async () => {
  api.updateIntegrationConnection.mockRejectedValue(new Error("response lost"));
  await commitIntegrationConnectionUpdate({
    reviewed,
    input: { expectedRevision: reviewed.revision, enabled: true },
    isCurrent: () => true,
  });
  expect(readIntegrationAttempt("connection-1").transport).toBeUndefined();
  await checkIntegrationAttemptOutcome("connection-1", readback);
  expect(attempts.read).not.toHaveBeenCalled();
  expect(readIntegrationAttempt("connection-1").phase).toBe("uncertain");
});
