import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AreaErrorBoundary } from "./AreaErrorBoundary";
import {
  beginApprovalOperation,
  updateApprovalOperation,
  __resetApprovalOperationAttemptsForTests,
  hasUnsettledChatContextMutation,
} from "@goatcitadel/mission-control-shared/state/scoped-operation-attempts";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const key = JSON.stringify([
  "library-operation",
  JSON.stringify([
    "original-installation",
    "original-caller",
    JSON.stringify(["chat-context", "original-workspace", "original-session"]),
  ]),
]);
const reload = vi.fn();
let root: ReactTestRenderer | undefined;
function Failure(): React.ReactNode {
  throw new Error("Failed to fetch dynamically imported module");
}
const view = () => (
  <AreaErrorBoundary label="Chat" resetKey="stable">
    <Failure />
  </AreaErrorBoundary>
);
beforeEach(() => {
  __resetApprovalOperationAttemptsForTests();
  reload.mockReset();
  vi.stubGlobal("window", { location: { reload } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  __resetApprovalOperationAttemptsForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("rejects a connected old Reload handler when unknown custody appears without rerender", async () => {
  await act(async () => {
    root = create(view());
  });
  const button = root!.root.findAllByType("button").find((node) => node.props.children === "Reload app")!;
  expect(button.props.disabled).toBe(false);
  const token = beginApprovalOperation(key, "original-revision")!;
  updateApprovalOperation(key, token, "uncertain", "lost response");
  button.props.onClick();
  button.props.onClick();
  expect(reload).not.toHaveBeenCalled();
  expect(hasUnsettledChatContextMutation()).toBe(true);
  await act(async () => root!.update(view()));
  const guarded = root!.root.findAllByType("button").find((node) => node.props.children === "Reload app")!;
  expect(guarded.props.disabled).toBe(true);
  expect(guarded.props.title).toContain("cannot recover missing canonical linkage");
});
it("keeps pending attempts blocked across boundary remount and permits settled receipt state", async () => {
  const token = beginApprovalOperation(key, "original-revision")!;
  await act(async () => {
    root = create(view());
  });
  root!.root
    .findAllByType("button")
    .find((node) => node.props.children === "Reload app")!
    .props.onClick();
  expect(reload).not.toHaveBeenCalled();
  await act(async () => {
    root!.unmount();
    root = create(view());
  });
  expect(root!.root.findAllByType("button").find((node) => node.props.children === "Reload app")!.props.disabled).toBe(
    true,
  );
  updateApprovalOperation(key, token, "resolved", "canonical receipt returned");
  await act(async () => root!.update(view()));
  root!.root
    .findAllByType("button")
    .find((node) => node.props.children === "Reload app")!
    .props.onClick();
  expect(reload).toHaveBeenCalledTimes(1);
});
