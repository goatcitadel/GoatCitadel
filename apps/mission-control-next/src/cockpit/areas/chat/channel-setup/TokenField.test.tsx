// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenField } from "./TokenField";

let root: Root;
let container: HTMLDivElement;

type Props = Parameters<typeof TokenField>[0];

async function show(props: Partial<Props> = {}) {
  await act(async () => {
    root.render(<TokenField label="Bot token" value="" onChange={() => undefined} busy={false} {...props} />);
  });
}

const field = () => container.querySelector<HTMLInputElement>("input")!;
const submit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]');

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TokenField", () => {
  it("is a masked field named by its label, that a browser is not asked to remember", async () => {
    await show({ label: "App token", placeholder: "xapp-…" });
    const label = container.querySelector("label")!;
    expect(label.textContent).toBe("App token");
    expect(field().id).toBe(label.htmlFor);
    expect(field().type).toBe("password");
    expect(field().autocomplete).toBe("new-password");
    expect(field().getAttribute("autocapitalize")).toBe("off");
    expect(field().getAttribute("spellcheck")).toBe("false");
    expect(field().placeholder).toBe("xapp-…");
  });

  it("shows what is typed and passes each change on", async () => {
    const onChange = vi.fn();
    await show({ onChange });
    await type("abc");
    expect(onChange).toHaveBeenCalledWith("abc");
    await show({ onChange, value: "abc" });
    expect(field().value).toBe("abc");
  });

  it("is only the field when it has no button, so a page can put several in one form", async () => {
    await show();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("is read-only, not disabled, while something is in flight", async () => {
    await show({ busy: true, value: "abc" });
    expect(field().readOnly).toBe(true);
    expect(field().disabled).toBe(false);
    await show({ busy: false, value: "abc" });
    expect(field().readOnly).toBe(false);
  });

  describe("with a button", () => {
    const button = (overrides: Partial<NonNullable<Props["button"]>> = {}) => ({
      label: "Check token",
      checking: false,
      onCheck: vi.fn(),
      ...overrides,
    });

    it("checks the token when the form is submitted, which a click or Enter does", async () => {
      const spec = button();
      await show({ value: "abc", button: spec });
      expect(submit()?.textContent).toBe("Check token");
      const form = container.querySelector("form")!;
      expect(form).not.toBeNull();
      const event = new Event("submit", { bubbles: true, cancelable: true });
      await act(async () => {
        form.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(spec.onCheck).toHaveBeenCalledTimes(1);
      // The button is the form's submit, so a click is the same check.
      expect(submit()!.type).toBe("submit");
      expect(submit()!.form).toBe(form);
    });

    it("keeps the button off until something is typed", async () => {
      await show({ value: "", button: button() });
      expect(submit()!.disabled).toBe(true);
      await show({ value: "   ", button: button() });
      expect(submit()!.disabled).toBe(true);
      await show({ value: "abc", button: button() });
      expect(submit()!.disabled).toBe(false);
    });

    it("keeps only the check that is running: any other work turns the button off", async () => {
      await show({ value: "abc", busy: true, button: button({ checking: false }) });
      expect(submit()!.disabled).toBe(true);
      await show({ value: "abc", busy: true, button: button({ checking: true }) });
      expect(submit()!.disabled).toBe(false);
      expect(submit()!.getAttribute("aria-busy")).toBe("true");
      expect(submit()!.textContent).toBe("Checking…");
    });
  });
});
