// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { FollowThroughSetupResponse } from "@goatcitadel/contracts";
import { ChatFollowThroughSetupForm } from "./ChatFollowThroughSetup";
let tree: ReactTestRenderer;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
});
const setup = {
  version: 1,
  workspaceId: "w",
  sessionId: "s",
  sourceHash: "a".repeat(64),
  configRevision: 4,
  profiles: [
    {
      profileId: "safe",
      revision: "profile",
      label: "Safe",
      description: "Reviewed access",
      approvalMode: "approve_risky",
    },
  ],
  eventSources: [],
  limits: { scope: "installation", dailyUsdHardCap: 2, sessionTokenHardCap: 20000 },
  blockedReasons: [],
} satisfies FollowThroughSetupResponse;
it("reviews the exact configured destination before confirming a daily brief", async () => {
  const onCreate = vi.fn(async () => {});
  const current: FollowThroughSetupResponse = {
    ...setup,
    channelDestinations: [
      {
        channelKey: "discord",
        connectionId: "thread",
        revision: "r1",
        target: "123456789012345678",
        label: "Project brief",
      },
    ],
  };
  await act(async () => {
    tree = create(<ChatFollowThroughSetupForm setup={current} onCreate={onCreate} onClose={() => {}} />);
  });
  await act(async () => {
    tree.root.findByType("textarea").props.onChange({ target: { value: "Send the daily brief" } });
    const selector = tree.root
      .findAllByType("select")
      .find((select) => select.findAllByType("option").some((option) => option.props.value === "thread"));
    selector?.props.onChange({ target: { value: "thread" } });
  });
  await act(async () => tree.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(JSON.stringify(tree.toJSON())).toContain("Project brief · 123456789012345678 · after every completed run");
  expect(onCreate).not.toHaveBeenCalled();
  await act(async () => tree.root.findByProps({ "data-follow-through-confirm": true }).props.onClick());
  expect(onCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      draft: expect.objectContaining({ delivery: { kind: "channel", connectionId: "thread" } }),
    }),
  );
});
it("an event uses the conversation's real quiet-hour zone rather than a decorative timezone selection", async () => {
  const onCreate = vi.fn(async () => {}),
    current = {
      ...setup,
      eventSources: [{ hookId: "h", label: "Subagent completed" }],
      quietHours: { start: 12, end: 18, timezone: "Asia/Kathmandu" },
    };
  await act(async () => {
    tree = create(<ChatFollowThroughSetupForm setup={current} onCreate={onCreate} onClose={() => {}} />);
  });
  await act(async () => {
    tree.root.findByType("textarea").props.onChange({ target: { value: "Check after completion" } });
    tree.root
      .findAllByType("select")
      .find((node) => node.props.value === "recurring")!
      .props.onChange({ target: { value: "event" } });
  });
  expect(JSON.stringify(tree.toJSON()).includes("Asia/Kathmandu")).toBe(true);
  await act(async () => tree.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  await act(async () => tree.root.findByProps({ "data-follow-through-confirm": true }).props.onClick());
  expect(onCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      draft: expect.objectContaining({
        trigger: expect.objectContaining({ kind: "event", timezone: "Asia/Kathmandu" }),
      }),
    }),
  );
});
it("reviews purpose, trigger, reporting, permissions and true budget scope before a single creation decision", async () => {
  const createJob = vi.fn(async () => {});
  await act(async () => {
    tree = create(<ChatFollowThroughSetupForm setup={setup} onCreate={createJob} onClose={() => {}} />);
  });
  expect(createJob).not.toHaveBeenCalled();
  await act(async () =>
    tree.root.findByType("textarea").props.onChange({ target: { value: "Check the result for a meaningful change" } }),
  );
  await act(async () => tree.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(createJob).not.toHaveBeenCalled();
  const text = tree.root
    .findAllByType("dd")
    .map((node) => node.children.join(""))
    .join(" ");
  for (const value of ["Check the result", "This conversation", "Safe", "installation", "$2"])
    expect(text).toContain(value);
  await act(async () => tree.root.findByProps({ "data-follow-through-confirm": true }).props.onClick());
  expect(createJob).toHaveBeenCalledExactlyOnceWith({
    sourceHash: setup.sourceHash,
    draft: expect.objectContaining({
      purpose: "Check the result for a meaningful change",
      permissionProfileId: "safe",
      trigger: expect.objectContaining({ kind: "recurring" }),
      delivery: { kind: "conversation" },
    }),
  });
});
it("a changed setup invalidates confirmation while retaining the entered purpose", async () => {
  const createJob = vi.fn(async () => {});
  await act(async () => {
    tree = create(<ChatFollowThroughSetupForm setup={setup} onCreate={createJob} onClose={() => {}} />);
  });
  await act(async () =>
    tree.root.findByType("textarea").props.onChange({ target: { value: "Keep the reviewed purpose" } }),
  );
  await act(async () => tree.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  await act(async () =>
    tree.update(
      <ChatFollowThroughSetupForm
        setup={{ ...setup, sourceHash: "b".repeat(64) }}
        onCreate={createJob}
        onClose={() => {}}
      />,
    ),
  );
  expect(tree.root.findByProps({ "data-follow-through-confirm": true }).props.disabled).toBe(true);
  expect(JSON.stringify(tree.toJSON())).toContain("changed after review");
  expect(createJob).not.toHaveBeenCalled();
});
it("an uncertain creation can retry only its same reviewed request while edits stay locked", async () => {
  const createJob = vi.fn(async () => {});
  await act(async () => {
    tree = create(<ChatFollowThroughSetupForm setup={setup} onCreate={createJob} onClose={() => {}} />);
  });
  await act(async () =>
    tree.root.findByType("textarea").props.onChange({ target: { value: "Keep the exact request" } }),
  );
  await act(async () => tree.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  await act(async () => tree.root.findByProps({ "data-follow-through-confirm": true }).props.onClick());
  await act(async () =>
    tree.update(<ChatFollowThroughSetupForm setup={setup} uncertain onCreate={createJob} onClose={() => {}} />),
  );
  await act(async () => tree.root.findByProps({ "data-follow-through-confirm": true }).props.onClick());
  expect(createJob).toHaveBeenCalledTimes(2);
  expect(createJob.mock.calls[0]).toEqual(createJob.mock.calls[1]);
});
