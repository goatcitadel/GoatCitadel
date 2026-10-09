// @vitest-environment happy-dom
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChannelOutcomeCheck } from "./ChannelOutcomeCheck";
import {
  __resetChannelMutationStateForTests,
  beginChannelOperation,
  readChannelMutationState,
} from "./channel-setup-state";

const api = vi.hoisted(() => ({ fetchChannelSetupDrafts: vi.fn(), fetchIntegrationConnections: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
}));
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

let view: ReactTestRenderer;
const reload = vi.fn(async () => undefined);
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
async function loseWrite() {
  attempts.paths.push("/api/v1/channels/drafts");
  const operation = beginChannelOperation()!;
  await operation
    .write(
      () => Promise.reject(new Error("response lost")),
      () => undefined,
    )
    .catch(() => undefined);
  operation.finish();
}
beforeEach(() => {
  vi.resetAllMocks();
  attempts.paths.length = 0;
  __resetChannelMutationStateForTests();
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchIntegrationConnections.mockResolvedValue({ items: [] });
});
afterEach(async () => {
  await act(async () => view?.unmount());
  __resetChannelMutationStateForTests();
});

it("settles the channel lock only after the canonical drafts and connections reads", async () => {
  await loseWrite();
  await act(async () => {
    view = create(<ChannelOutcomeCheck reload={reload} />);
  });
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  await act(async () => view.root.findByType("button").props.onClick());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(api.fetchChannelSetupDrafts).toHaveBeenCalled();
  expect(api.fetchIntegrationConnections).toHaveBeenCalled();
  expect(reload).toHaveBeenCalled();
  expect(readChannelMutationState().uncertain).toBeUndefined();
  expect(text(view.root)).toContain("recorded this channel change as processed");
});

it("settles from the canonical reads even when the section refresh fails afterwards", async () => {
  await loseWrite();
  reload.mockRejectedValue(new Error("refresh failed"));
  await act(async () => {
    view = create(<ChannelOutcomeCheck reload={reload} />);
  });
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  await act(async () => view.root.findByType("button").props.onClick());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(readChannelMutationState().uncertain).toBeUndefined();
  expect(reload).toHaveBeenCalled();
});

it("keeps the channel lock when a canonical read fails", async () => {
  await loseWrite();
  api.fetchIntegrationConnections.mockRejectedValue(new Error("connections unavailable"));
  await act(async () => {
    view = create(<ChannelOutcomeCheck reload={reload} />);
  });
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  await act(async () => view.root.findByType("button").props.onClick());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(readChannelMutationState().uncertain).toMatch(/check failed/);
  expect(reload).not.toHaveBeenCalled();
});

it("offers no check for an unidentified lost write", async () => {
  const operation = beginChannelOperation()!;
  await operation
    .write(
      () => Promise.reject(new Error("response lost")),
      () => undefined,
    )
    .catch(() => undefined);
  operation.finish();
  await act(async () => {
    view = create(<ChannelOutcomeCheck />);
  });
  expect(view.root.findAllByType("button")).toHaveLength(0);
});
