import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  __resetChannelMutationStateForTests,
  beginChannelOperation,
  checkChannelOutcome,
  readChannelMutationState,
} from "./channel-setup-state";

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
}));
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
async function loseWrite(path?: string) {
  if (path) attempts.paths.push(path);
  const operation = beginChannelOperation()!;
  await expect(
    operation.write(
      () => Promise.reject(new Error("response lost")),
      () => undefined,
    ),
  ).rejects.toThrow();
  operation.finish();
}
beforeEach(() => {
  vi.resetAllMocks();
  attempts.paths.length = 0;
  readback.mockResolvedValue(undefined);
  __resetChannelMutationStateForTests();
});
afterEach(() => __resetChannelMutationStateForTests());

it("keeps the identity of a lost channel write and settles it from the Gateway's record", async () => {
  await loseWrite("/api/v1/channels/drafts/draft-1/finalize");
  expect(readChannelMutationState()).toMatchObject({
    pending: false,
    transport: { routePattern: "/api/v1/channels/drafts/:draftId/finalize" },
  });
  expect(beginChannelOperation()).toBeUndefined();
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  const notice = await checkChannelOutcome(readback);
  expect(attempts.read).toHaveBeenCalledWith(
    "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    "POST",
    "/api/v1/channels/drafts/:draftId/finalize",
  );
  expect(readback).toHaveBeenCalledOnce();
  expect(notice).toMatch(/recorded this channel change as processed/);
  expect(readChannelMutationState().uncertain).toBeUndefined();
  expect(beginChannelOperation()).toBeDefined();
});

it.each([
  [{ status: "pending", claimExpired: false }, /still running/],
  [{ status: "absent" }, /no record/],
])("keeps the channel lock for %o", async (record, message) => {
  await loseWrite("/api/v1/channels/drafts");
  attempts.read.mockResolvedValue(record);
  expect(await checkChannelOutcome(readback)).toBeUndefined();
  expect(readChannelMutationState().uncertain).toMatch(message);
  expect(readback).not.toHaveBeenCalled();
});

it("keeps the channel lock when the readback fails, with fixed copy", async () => {
  await loseWrite("/api/v1/channels/drafts");
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  readback.mockRejectedValue(new Error("API error 503: gateway-internal-detail"));
  await checkChannelOutcome(readback);
  expect(readChannelMutationState().uncertain).toMatch(/check failed/);
  expect(readChannelMutationState().uncertain).not.toContain("gateway-internal-detail");
});

it.each([
  [
    "/api/v1/integrations/connections/c-1/discord/pairings/p-1/revoke",
    "/api/v1/integrations/connections/:connectionId/discord/pairings/:pairingId/revoke",
  ],
  ["/api/v1/integrations/slack/oauth/start", "/api/v1/integrations/slack/oauth/start"],
])("identifies a lost %s write for an outcome check", async (path, pattern) => {
  await loseWrite(path);
  expect(readChannelMutationState().transport?.routePattern).toBe(pattern);
});

it("offers no check for a lost channel write it could not identify", async () => {
  await loseWrite();
  expect(readChannelMutationState().transport).toBeUndefined();
  await checkChannelOutcome(readback);
  expect(attempts.read).not.toHaveBeenCalled();
  expect(readChannelMutationState().uncertain).toBeTruthy();
});
