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
});
