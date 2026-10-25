// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Switch, type SwitchProps } from "./Switch";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderSwitch(overrides: Partial<SwitchProps> = {}): { onCheckedChange: ReturnType<typeof vi.fn> } {
  const onCheckedChange = vi.fn();
  act(() => {
    root.render(<Switch checked label="Linear" onCheckedChange={onCheckedChange} {...overrides} />);
  });
  return { onCheckedChange };
}

function findSwitch(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('[role="switch"]');
  if (!found) throw new Error("No switch rendered");
  return found;
}

describe("cockpit Switch", () => {
  it("exposes a switch named by its label with the checked state", () => {
    renderSwitch({ checked: true });
    const control = findSwitch();
    expect(control.getAttribute("aria-label")).toBe("Linear");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("On");
    // The visible word is a hint: it sits outside the switch so the accessible name stays exactly the label.
    const hint = container.querySelector('span[aria-hidden="true"]');
    expect(hint?.textContent).toBe("On");
    expect(control.contains(hint)).toBe(false);
    expect(control.textContent).toBe("");
  });

  it("flips on click", () => {
    const { onCheckedChange } = renderSwitch({ checked: true });
    act(() => findSwitch().click());
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("is unavailable while pending", () => {
    const { onCheckedChange } = renderSwitch({ checked: true, pending: true });
    const control = findSwitch();
    expect(control.getAttribute("aria-busy")).toBe("true");
    expect(control.getAttribute("aria-disabled")).toBe("true");
    // Not natively disabled: a disabled button drops keyboard focus to <body> mid-save.
    expect(control.hasAttribute("disabled")).toBe(false);
    expect(control.disabled).toBe(false);
    act(() => control.click());
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("keeps keyboard focus when a change starts saving", () => {
    renderSwitch({ checked: true });
    const control = findSwitch();
    control.focus();
    expect(document.activeElement).toBe(control);

    const { onCheckedChange } = renderSwitch({ checked: true, pending: true });
    expect(findSwitch()).toBe(control);
    expect(document.activeElement).toBe(control);
    act(() => control.click());
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("accepts changes again once the save settles", () => {
    renderSwitch({ checked: true, pending: true });
    const { onCheckedChange } = renderSwitch({ checked: false, pending: false });
    const control = findSwitch();
    expect(control.hasAttribute("aria-busy")).toBe(false);
    expect(control.hasAttribute("aria-disabled")).toBe(false);
    act(() => control.click());
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("shows Off text when unchecked", () => {
    renderSwitch({ checked: false });
    const control = findSwitch();
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Off");
    expect(container.textContent).not.toContain("On");
  });

  it("flips on when clicked while off", () => {
    const { onCheckedChange } = renderSwitch({ checked: false });
    act(() => findSwitch().click());
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("ignores clicks and reports no busy state while only disabled", () => {
    const { onCheckedChange } = renderSwitch({ disabled: true });
    const control = findSwitch();
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("aria-busy")).toBeNull();
    act(() => control.click());
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("uses custom state words and points at its description", () => {
    renderSwitch({ checked: false, onText: "Allowed", offText: "Blocked", describedBy: "linear-hint" });
    expect(container.textContent).toContain("Blocked");
    expect(container.textContent).not.toContain("Allowed");
    expect(findSwitch().getAttribute("aria-describedby")).toBe("linear-hint");
  });

  it("uses the primary accent when on and the raised surface with a control border when off", () => {
    renderSwitch({ checked: true });
    const onTrack = findSwitch().firstElementChild as HTMLElement;
    const onClasses = onTrack.className.split(/\s+/);
    expect(onClasses).toEqual(expect.arrayContaining(["h-5", "w-9", "rounded-full", "bg-accent"]));

    renderSwitch({ checked: false });
    const offTrack = findSwitch().firstElementChild as HTMLElement;
    const offClasses = offTrack.className.split(/\s+/);
    expect(offClasses).toEqual(
      expect.arrayContaining(["h-5", "w-9", "rounded-full", "bg-raised", "border-line-control"]),
    );
    expect(offClasses).not.toContain("bg-accent");
  });

  it("slides the thumb with a scale class, not an arbitrary value", () => {
    renderSwitch({ checked: true });
    const onThumb = findSwitch().querySelector<HTMLElement>("span > span");
    expect(onThumb?.className.split(/\s+/)).toEqual(expect.arrayContaining(["size-4", "translate-x-4"]));

    renderSwitch({ checked: false });
    const offThumb = findSwitch().querySelector<HTMLElement>("span > span");
    expect(offThumb?.className.split(/\s+/)).toContain("size-4");
    expect(offThumb?.className.split(/\s+/)).not.toContain("translate-x-4");
  });

  it("pairs the thumb with a contrasting token in each state", () => {
    // R16: the cockpit has no white token. On uses the accent's ink; off uses a muted ink that shows on the raised track.
    renderSwitch({ checked: true });
    const onThumb = findSwitch().querySelector<HTMLElement>("span > span")?.className.split(/\s+/);
    expect(onThumb).toContain("bg-accent-ink");
    expect(onThumb).not.toContain("bg-fg-muted");

    renderSwitch({ checked: false });
    const offThumb = findSwitch().querySelector<HTMLElement>("span > span")?.className.split(/\s+/);
    expect(offThumb).toContain("bg-fg-muted");
    expect(offThumb).not.toContain("bg-accent-ink");
  });

  it("dims the track and the state word while pending", () => {
    renderSwitch({ checked: true, pending: true });
    const track = findSwitch().firstElementChild as HTMLElement;
    expect(track.className.split(/\s+/)).toContain("opacity-50");
    expect(container.querySelector('span[aria-hidden="true"]')?.className.split(/\s+/)).toContain("opacity-50");
  });
});
