import type { ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelDraftLeave } from "./ChannelDraftLeave";
import { McpDraftLeave } from "./McpDraftLeave";
import { ProviderDraftLeave } from "./ProviderDraftLeave";

vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, children, title }: { open: boolean; children: ReactNode; title: string }) =>
    open ? <section aria-label={title}>{children}</section> : null,
}));

let renderer: ReactTestRenderer | undefined;
function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

it.each([
  ["MCP", McpDraftLeave],
  ["provider", ProviderDraftLeave],
  ["channel", ChannelDraftLeave],
])("renders the shared unsaved-changes dialog for %s drafts", async (_name, Leave) => {
  const onCancel = vi.fn();
  await act(async () => {
    renderer = create(<Leave open keys={[]} onContinue={vi.fn()} onCancel={onCancel} />);
  });
  const actions = renderer!.root.findByProps({ "aria-label": "Unsaved changes" }).findAllByType("button");
  expect(actions.map(text)).toEqual(["Discard changes", "Cancel"]);
  expect(String(actions[0]!.props.className)).toContain("border-status-failed");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Keep editing");
  await act(async () => actions[1]!.props.onClick());
  expect(onCancel).toHaveBeenCalledOnce();
});
