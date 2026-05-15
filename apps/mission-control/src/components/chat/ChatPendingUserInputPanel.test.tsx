import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatPendingUserInputPanel } from "./ChatPendingUserInputPanel";

describe("ChatPendingUserInputPanel", () => {
  it("renders single-select prompts and submits the selected option", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    const onSubmit = vi.fn();

    await act(async () => {
      renderer = create(
        <ChatPendingUserInputPanel
          pendingUserInput={{
            promptId: "prompt-1",
            turnId: "turn-1",
            kind: "single_select",
            title: "Choose a path",
            question: "Which path should GoatCitadel take?",
            required: true,
            options: [
              {
                optionId: "safe",
                label: "Safe",
                description: "Stay conservative.",
                helpText: "Best when you want the narrowest change.",
              },
            ],
          }}
          pending={false}
          onSubmit={onSubmit}
        />,
      );
    });

    const radio = renderer.root.findByType("input");
    await act(async () => {
      radio.props.onChange();
    });
    const submit = renderer.root.findAllByType("button").find((button) => button.props.children === "Submit");
    expect(submit).toBeDefined();
    await act(async () => {
      submit?.props.onClick();
    });

    expect(onSubmit).toHaveBeenCalledWith({
      kind: "single_select",
      optionId: "safe",
    });
  });

  it("keeps text prompt submission disabled until trimmed text exists", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    const onSubmit = vi.fn();

    await act(async () => {
      renderer = create(
        <ChatPendingUserInputPanel
          pendingUserInput={{
            promptId: "prompt-2",
            turnId: "turn-2",
            kind: "text",
            title: "Need detail",
            question: "Share the missing detail.",
            required: true,
            placeholder: "Type here",
          }}
          pending={false}
          onSubmit={onSubmit}
        />,
      );
    });

    let submit = renderer.root.findByType("button");
    expect(submit.props.disabled).toBe(true);

    const input = renderer.root.findByType("input");
    await act(async () => {
      input.props.onChange({ target: { value: "  Final answer  " } });
    });

    submit = renderer.root.findByType("button");
    expect(submit.props.disabled).toBe(false);

    await act(async () => {
      submit.props.onClick();
    });

    expect(onSubmit).toHaveBeenCalledWith({
      kind: "text",
      text: "Final answer",
    });
  });

  it("resets prompt-local state when the pending prompt changes", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    const onSubmit = vi.fn();

    await act(async () => {
      renderer = create(
        <ChatPendingUserInputPanel
          pendingUserInput={{
            promptId: "prompt-a",
            turnId: "turn-a",
            kind: "text",
            title: "Need detail",
            question: "Share the missing detail.",
            required: true,
          }}
          pending={false}
          onSubmit={onSubmit}
        />,
      );
    });

    await act(async () => {
      renderer.root.findByType("input").props.onChange({ target: { value: "first answer" } });
    });
    expect(renderer.root.findByType("input").props.value).toBe("first answer");

    await act(async () => {
      renderer.update(
        <ChatPendingUserInputPanel
          pendingUserInput={{
            promptId: "prompt-b",
            turnId: "turn-b",
            kind: "text",
            title: "Need next detail",
            question: "Share the next detail.",
            required: true,
          }}
          pending={false}
          onSubmit={onSubmit}
        />,
      );
    });

    expect(renderer.root.findByType("input").props.value).toBe("");
  });

  it("supports multiline text prompts and optional dismissal", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    const onSubmit = vi.fn();
    const onDismiss = vi.fn();

    await act(async () => {
      renderer = create(
        <ChatPendingUserInputPanel
          pendingUserInput={{
            promptId: "prompt-multiline",
            turnId: "turn-3",
            kind: "text",
            title: "Need context",
            question: "Paste the context.",
            required: true,
            multiline: true,
            dismissible: true,
            submitLabel: "Send context",
            expiresAt: "2026-05-15T00:00:00.000Z",
          }}
          pending={false}
          onSubmit={onSubmit}
          onDismiss={onDismiss}
        />,
      );
    });

    const textarea = renderer.root.findByType("textarea");
    await act(async () => {
      textarea.props.onChange({ target: { value: "  multi\nline  " } });
    });

    const buttons = renderer.root.findAllByType("button");
    await act(async () => {
      buttons.find((button) => button.props.children === "Send context")?.props.onClick();
      buttons.find((button) => button.props.children === "Dismiss")?.props.onClick();
    });

    expect(onSubmit).toHaveBeenCalledWith({ kind: "text", text: "multi\nline" });
    expect(onDismiss).toHaveBeenCalledOnce();
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain("Expires ");
    expect(rendered).toContain("2026-05-15T00:00:00.000Z");
  });

  it("renders nothing without a pending prompt and disables controls while pending", async () => {
    const onSubmit = vi.fn();
    const renderer = create(<ChatPendingUserInputPanel pendingUserInput={null} pending={false} onSubmit={onSubmit} />);

    expect(renderer.toJSON()).toBeNull();

    await act(async () => {
      renderer.update(
        <ChatPendingUserInputPanel
          pendingUserInput={{
            promptId: "prompt-pending",
            turnId: "turn-4",
            kind: "single_select",
            title: "Choose",
            question: "Choose one.",
            required: true,
            dismissible: true,
            options: [{ optionId: "a", label: "A", description: "Option A" }],
          }}
          pending
          onSubmit={onSubmit}
          onDismiss={vi.fn()}
        />,
      );
    });

    const buttons = renderer.root.findAllByType("button");
    expect(buttons.find((button) => button.props.children === "Submitting...")?.props.disabled).toBe(true);
    expect(buttons.find((button) => button.props.children === "Dismiss")?.props.disabled).toBe(true);
  });
});
