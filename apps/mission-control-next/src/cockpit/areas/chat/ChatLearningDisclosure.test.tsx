import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatLearningDisclosure } from "./ChatLearningDisclosure";

const fixture = vi.hoisted(() => ({
  access: "first-caller",
  workspace: "workspace-1",
  loads: 0,
  render: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/use-current-access", () => ({
  useProjectAccess: () => ({ identity: fixture.access, current: () => true }),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: fixture.workspace }),
}));
vi.mock("./ChatLearningReceiptControl", () => {
  fixture.loads += 1;
  return {
    ChatLearningReceiptControl: (props: unknown) => {
      fixture.render(props);
      return null;
    },
  };
});

describe("ChatLearningDisclosure", () => {
  let tree: ReactTestRenderer | undefined;
  const props = { workspaceId: "workspace-1", sessionId: "session-1", turnId: "turn-1" };

  afterEach(async () => {
    await act(async () => tree?.unmount());
    tree = undefined;
  });

  async function toggle(open: boolean) {
    const target = { open };
    await act(async () => tree?.root.findByType("details").props.onToggle({ target, currentTarget: target }));
  }

  it("loads only on open, keeps the controller on close, and resets on access change", async () => {
    await act(async () => {
      tree = create(<ChatLearningDisclosure {...props} />);
    });
    expect(tree?.root.findByType("summary").children).toContain("Memory and learning");
    expect(fixture.loads).toBe(0);

    await toggle(true);
    await vi.waitFor(() => expect(fixture.render).toHaveBeenLastCalledWith(expect.objectContaining({ open: true })));
    expect(fixture.loads).toBe(1);

    await toggle(false);
    expect(fixture.render).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }));
    expect(fixture.loads).toBe(1);

    fixture.render.mockClear();
    fixture.access = "replacement-caller";
    await act(async () => tree?.update(<ChatLearningDisclosure {...props} />));
    expect(fixture.render).not.toHaveBeenCalled();

    fixture.workspace = "workspace-2";
    await act(async () => tree?.update(<ChatLearningDisclosure {...props} />));
    expect(tree?.root.findAllByType("details")).toHaveLength(0);
  });
});
