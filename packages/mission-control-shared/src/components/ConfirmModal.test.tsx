import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { ConfirmModal } from "./ConfirmModal";

const modalProps: Array<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  confirmPending?: boolean;
  confirmDisabled?: boolean;
  dismissDisabled?: boolean;
  onConfirm: () => void;
}> = [];

vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  return {
    ...actual,
    GCModal: (props: (typeof modalProps)[number]) => {
      modalProps.push(props);
      return props.open ? (
        <section data-danger={props.danger ? "danger" : "normal"}>
          <h1>{props.title}</h1>
          <p>{props.description}</p>
          <button type="button" disabled={props.dismissDisabled} onClick={() => props.onOpenChange(false)}>
            {props.cancelLabel}
          </button>
          <button type="button" disabled={props.confirmPending || props.confirmDisabled} onClick={props.onConfirm}>
            {props.confirmPending ? "Working..." : props.confirmLabel}
          </button>
        </section>
      ) : null;
    },
  };
});

describe("ConfirmModal", () => {
  it("uses default copy and cancels when the modal closes", () => {
    modalProps.length = 0;
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const renderer = create(
      <ConfirmModal
        open
        title="Apply changes"
        message="Commit this workspace update?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Apply changes");
    expect(text).toContain("Commit this workspace update?");
    expect(text).toContain("Apply");
    expect(text).toContain("Cancel");

    act(() => {
      renderer.root.findAllByType("button")[1]!.props.onClick();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.root.findAllByType("button")[0]!.props.onClick();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(modalProps.at(-1)?.dismissDisabled).toBe(false);
  });

  it("passes custom labels and disables dismissal while pending or explicitly blocked", () => {
    modalProps.length = 0;
    const renderer = create(
      <ConfirmModal
        open
        title="Delete prompt pack"
        message="This removes the draft."
        confirmLabel="Delete"
        cancelLabel="Keep draft"
        danger
        pending
        confirmDisabled
        cancelDisabled
        disableDismiss
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    const buttons = renderer.root.findAllByType("button");
    expect(JSON.stringify(renderer.toJSON())).toContain("Delete prompt pack");
    expect(buttons[0]!.children.join("")).toBe("Keep draft");
    expect(buttons[0]!.props.disabled).toBe(true);
    expect(buttons[1]!.children.join("")).toBe("Working...");
    expect(buttons[1]!.props.disabled).toBe(true);
    expect(modalProps.at(-1)).toMatchObject({
      danger: true,
      confirmPending: true,
      confirmDisabled: true,
      dismissDisabled: true,
    });
  });

  it("does not render closed modal content", () => {
    const renderer = create(
      <ConfirmModal
        open={false}
        title="Hidden"
        message="Not visible"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(renderer.toJSON()).toBeNull();
  });
});
