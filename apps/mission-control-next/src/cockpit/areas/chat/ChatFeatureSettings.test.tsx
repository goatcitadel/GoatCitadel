import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { MissionThreadedContextDockProps } from "@goatcitadel/threaded-surface-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatFeatureSettings } from "./ChatFeatureSettings";

vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: { open: boolean; confirmDisabled: boolean; onConfirm: () => void }) =>
    props.open ? (
      <button type="button" data-confirm-auto disabled={props.confirmDisabled} onClick={props.onConfirm}>
        Confirm
      </button>
    ) : null,
}));
let tree: ReactTestRenderer;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
});
function fixture() {
  return {
    selectedSessionId: "session-1",
    prefs: { subagentPolicy: "ask_when_useful" },
    sending: false,
    automaticFanout: { enabled: false },
    supervisedDelegationAvailable: false,
    codingDelegationAvailable: false,
    providerFallbackAvailable: false,
    providerOptions: [],
    onPrefPatch: vi.fn(async () => {}),
    onSuggestDelegation: vi.fn(async () => {}),
    onRunCodeDelegation: vi.fn(async () => {}),
    onAcceptDelegation: vi.fn(async () => {}),
  } as unknown as MissionThreadedContextDockProps;
}
async function render(dock: MissionThreadedContextDockProps) {
  await act(async () => {
    tree = create(<ChatFeatureSettings dock={dock} />);
  });
}
describe("Cockpit execution settings", () => {
  it("keeps default-off capabilities visible without activating anything", async () => {
    const dock = fixture();
    await render(dock);
    const select = tree.root.findByProps({ "aria-label": "Subagent policy" });
    expect(select.props.value).toBe("ask_when_useful");
    expect(select.props.disabled).toBe(true);
    expect(tree.root.findByProps({ "aria-label": "Fallback provider" }).props.value).toBe("");
    expect(dock.onPrefPatch).not.toHaveBeenCalled();
  });
  it("requires explicit confirmation and cancels it when the project grant becomes unavailable", async () => {
    const dock = fixture();
    dock.automaticFanout = { enabled: true };
    await render(dock);
    const selectAuto = async () =>
      act(async () => {
        tree.root
          .findByProps({ "aria-label": "Subagent policy" })
          .props.onChange({ target: { value: "auto_when_useful" } });
      });
    await selectAuto();
    expect(dock.onPrefPatch).not.toHaveBeenCalled();
    await act(async () => tree.root.findByProps({ "data-confirm-auto": true }).props.onClick());
    expect(dock.onPrefPatch).toHaveBeenCalledWith({ subagentPolicy: "auto_when_useful" });
    await selectAuto();
    dock.automaticFanout = { enabled: false, unavailableReason: "Grant expired" };
    await act(async () => tree.update(<ChatFeatureSettings dock={dock} />));
    expect(tree.root.findAllByProps({ "data-confirm-auto": true })).toHaveLength(0);
    expect(dock.onPrefPatch).toHaveBeenCalledTimes(1);
  });
  it("uses the existing governed suggestion, approval, and coding controllers", async () => {
    const dock = fixture();
    dock.supervisedDelegationAvailable = true;
    dock.codingDelegationAvailable = true;
    dock.delegationSuggestion = { mode: "sequential", objective: "Review the project", roles: ["QA"] } as never;
    await render(dock);
    const click = async (label: string) =>
      act(async () => {
        const button = tree.root.findAllByType("button").find((item) => item.children.join("") === label)!;
        expect(button.props.disabled).toBe(false);
        await button.props.onClick();
      });
    await click("Suggest delegation");
    await click("Delegate review");
    await click("Approve delegation");
    expect(dock.onSuggestDelegation).toHaveBeenCalledTimes(1);
    expect(dock.onRunCodeDelegation).toHaveBeenCalledWith("review");
    expect(dock.onAcceptDelegation).toHaveBeenCalledTimes(1);
    dock.sending = true;
    await act(async () => tree.update(<ChatFeatureSettings dock={dock} />));
    expect(tree.root.findAllByType("button").every((item) => item.props.disabled)).toBe(true);
  });
});
