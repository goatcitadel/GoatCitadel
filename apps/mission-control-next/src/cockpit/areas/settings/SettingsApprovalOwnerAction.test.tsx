// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import {
  awaitingLlamaApproval,
  llamaPlanFixture,
} from "../../../features/native-routes/settings/llama-setup.test-support";
import { useSessionDraft, __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
import { Dialog } from "../../ui/Dialog";

const state = vi.hoisted(() => ({
  installation: "http://gateway-a",
  workspace: "workspace-a",
  open: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../../../shell-preference", () => ({ switchShell: state.open, writeShellPreference: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => state.installation,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "citadel-a", activeWorkspaceId: state.workspace }),
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <section>{children}</section> : null,
}));
let view: ReactTestRenderer;
let draft: ReturnType<typeof useSessionDraft<{ text: string }>>;
function View({ plan }: { plan: ChangePlanRecord }) {
  draft = useSessionDraft("approval-owner-draft", { text: "Saved" }, 1, {
    label: "Unsent tool grant",
    onSave: state.save,
  });
  return <SettingsApprovalOwnerAction plan={plan} owner="llama-setup" workspaceId="workspace-a" />;
}
const plan = () => awaitingLlamaApproval(llamaPlanFixture());
const click = () => view.root.findByType("a").props.onClick({ button: 0, preventDefault: vi.fn() });
const action = (label: string) =>
  view.root
    .findByType(Dialog)
    .findAllByType("button")
    .find((item) => item.children.join("") === label)!.props.onClick;
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  state.installation = "http://gateway-a";
  state.workspace = "workspace-a";
  state.open.mockResolvedValue("cancelled");
  window.history.replaceState(null, "", "/settings/advanced?shell=cockpit#llamacpp-setup");
});
afterEach(async () => {
  await act(async () => view?.unmount());
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
});

describe("Settings approval handoff with actual draft registry", () => {
  it("Cancel retains the real draft; Keep draft opens the exact owner once without a save", async () => {
    await act(async () => {
      view = create(<View plan={plan()} />);
    });
    await act(async () => draft.setValue({ text: "Unsent" }));
    const document = window.document;
    await act(async () => click());
    expect(state.open).not.toHaveBeenCalled();
    await act(async () => action("Cancel")());
    expect(draft.isDirty).toBe(true);
    await act(async () => click());
    await act(async () => action("Keep draft and close")());
    expect(state.open).toHaveBeenCalledExactlyOnceWith(
      "classic",
      expect.objectContaining({
        href: "/ops/approvals?approvalId=approval-1&shell=classic&shellScope=visit",
        isCurrent: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(state.save).not.toHaveBeenCalled();
    expect(draft.value.text).toBe("Unsent");
    expect(window.document).toBe(document);
  });
  it("Discard acknowledges only the selected draft and requests exactly one owner transition", async () => {
    await act(async () => {
      view = create(<View plan={plan()} />);
    });
    await act(async () => draft.setValue({ text: "Discard this draft" }));
    await act(async () => click());
    await act(async () => action("Discard changes")());
    expect(draft.value.text).toBe("Saved");
    expect(draft.isDirty).toBe(false);
    expect(state.open).toHaveBeenCalledOnce();
    expect(state.save).not.toHaveBeenCalled();
  });
  it.each(["revision", "workspace", "installation", "navigation"])(
    "withholds retained Save/Discard/Keep after %s ABA",
    async (change) => {
      const original = plan();
      await act(async () => {
        view = create(<View plan={original} />);
      });
      await act(async () => draft.setValue({ text: "Unsent" }));
      await act(async () => click());
      const oldKeep = action("Keep draft and close"),
        oldDiscard = action("Discard changes"),
        oldSave = action("Save and continue");
      if (change === "revision") {
        await act(async () => view.update(<View plan={{ ...original, revision: original.revision + 1 }} />));
        await act(async () => view.update(<View plan={original} />));
      } else if (change === "navigation") {
        await act(async () => {
          window.history.replaceState(null, "", "/chat?shell=cockpit");
          window.dispatchEvent(new Event("popstate"));
        });
        await act(async () => {
          window.history.replaceState(null, "", "/settings/advanced?shell=cockpit#llamacpp-setup");
          window.dispatchEvent(new Event("popstate"));
        });
      } else {
        if (change === "workspace") state.workspace = "workspace-b";
        else state.installation = "http://gateway-b";
        await act(async () => view.update(<View plan={original} />));
        if (change === "workspace") state.workspace = "workspace-a";
        else state.installation = "http://gateway-a";
        await act(async () => view.update(<View plan={original} />));
      }
      await act(async () => {
        await oldSave();
        oldDiscard();
        oldKeep();
      });
      expect(state.open).not.toHaveBeenCalled();
      expect(state.save).not.toHaveBeenCalled();
      expect(draft.value.text).toBe("Unsent");
      expect(draft.isDirty).toBe(true);
    },
  );
  it("rejects a retained link callback after its dynamic installation changed before rerender", async () => {
    await act(async () => {
      view = create(<View plan={plan()} />);
    });
    const oldClick = view.root.findByType("a").props.onClick;
    state.installation = "http://gateway-b";
    await act(async () => oldClick({ button: 0, preventDefault: vi.fn() }));
    expect(state.open).not.toHaveBeenCalled();
  });
  it("offers no action for a foreign owner or a mismatched current receipt", async () => {
    const original = plan();
    await act(async () => {
      view = create(<SettingsApprovalOwnerAction plan={original} owner="llama-setup" workspaceId="foreign" />);
    });
    expect(view.root.findAllByType("a")).toHaveLength(0);
    await act(async () =>
      view.update(
        <SettingsApprovalOwnerAction
          plan={original}
          owner="llama-setup"
          workspaceId="workspace-a"
          receipt={{ ...original, revision: original.revision + 1 }}
        />,
      ),
    );
    expect(view.root.findAllByType("a")).toHaveLength(0);
    expect(state.open).not.toHaveBeenCalled();
  });
});
