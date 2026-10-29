// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostingChoice, type PostingOption } from "./PostingChoice";

const OPTIONS: readonly PostingOption[] = [
  { value: "dm", label: "Your direct messages with the bot" },
  { value: "general", label: "#general" },
  { value: "alerts", label: "#alerts" },
];

let root: Root;
let container: HTMLDivElement;

async function show(props: Partial<Parameters<typeof PostingChoice>[0]> = {}) {
  await act(async () => {
    root.render(
      <PostingChoice
        legend="Where should it post?"
        options={OPTIONS}
        value="dm"
        onChange={() => undefined}
        {...props}
      />,
    );
  });
}

const radios = () => [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PostingChoice", () => {
  it("is a group named by its legend, with one radio per option in the order given", async () => {
    await show();
    const group = container.querySelector("fieldset")!;
    expect(group.querySelector("legend")?.textContent).toBe("Where should it post?");
    expect(radios().map((radio) => radio.value)).toEqual(["dm", "general", "alerts"]);
    expect([...group.querySelectorAll("label")].map((label) => label.textContent)).toEqual(
      OPTIONS.map((option) => option.label),
    );
  });

  it("keeps the order it is given, whatever the values sort as", async () => {
    await show({
      options: [
        { value: "z", label: "Zed" },
        { value: "a", label: "Ay" },
      ],
      value: "a",
    });
    expect(radios().map((radio) => radio.value)).toEqual(["z", "a"]);
  });

  it("checks the chosen option only, and all radios share one name", async () => {
    await show({ value: "general" });
    expect(radios().map((radio) => radio.checked)).toEqual([false, true, false]);
    expect(new Set(radios().map((radio) => radio.name)).size).toBe(1);
    expect(radios()[0]!.name).not.toBe("");
  });

  it("gives two groups on one page their own names", async () => {
    await act(async () => {
      root.render(
        <>
          <PostingChoice legend="One" options={OPTIONS} value="dm" onChange={() => undefined} />
          <PostingChoice legend="Two" options={OPTIONS} value="dm" onChange={() => undefined} />
        </>,
      );
    });
    const names = radios().map((radio) => radio.name);
    expect(new Set(names).size).toBe(2);
  });

  it("names the label of each radio by its text, so a click on the text chooses it", async () => {
    const onChange = vi.fn();
    await show({ onChange });
    const label = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent === "#alerts")!;
    expect(label.contains(radios()[2]!)).toBe(true);
    await act(async () => {
      radios()[2]!.click();
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("alerts");
  });

  it("does not report a click on the option that is already chosen", async () => {
    const onChange = vi.fn();
    await show({ onChange, value: "dm" });
    await act(async () => {
      radios()[0]!.click();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is turned off as a group", async () => {
    await show({ disabled: true });
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    await show({ disabled: false });
    expect(container.querySelector("fieldset")!.disabled).toBe(false);
  });
});
