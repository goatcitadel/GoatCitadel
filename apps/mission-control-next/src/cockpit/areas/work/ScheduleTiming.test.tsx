// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScheduleTiming } from "./ScheduleTiming";

let root: Root, container: HTMLDivElement;
const onChange = vi.fn();
beforeEach(() => {
  onChange.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (value: string) => act(async () => root.render(<ScheduleTiming value={value} onChange={onChange} />));
const select = () => container.querySelector<HTMLSelectElement>("select")!;
async function choose(value: string) {
  await act(async () => {
    select().value = value;
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function setTime(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="time"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("offers guided frequency and time, and states what the expression means", async () => {
  await render("0 9 * * *");
  expect(select().value).toBe("daily");
  expect(container.querySelector<HTMLInputElement>('input[type="time"]')?.value).toBe("09:00");
  expect(container.textContent).toContain("Every day at 09:00");
  await choose("weekdays");
  expect(onChange).toHaveBeenLastCalledWith("0 9 * * 1-5");
  await setTime("07:30");
  expect(onChange).toHaveBeenLastCalledWith("30 7 * * *");
});

it("keeps an explicit timezone when the frequency changes", async () => {
  await render("0 9 * * * UTC");
  await choose("hourly");
  expect(onChange).toHaveBeenLastCalledWith("0 * * * * UTC");
});

it("opens the advanced expression for a custom schedule without changing it", async () => {
  await render("0 9 * * *");
  await choose("custom");
  expect(onChange).not.toHaveBeenCalled();
  expect(container.querySelector("details")?.open).toBe(true);
  await render("*/5 * * * *");
  expect(select().value).toBe("custom");
  expect(container.querySelector('input[type="time"]')).toBeNull();
  expect(container.textContent).toContain("Custom schedule: */5 * * * *");
});

it("keeps Custom expression selected after choosing it, until a guided option is chosen", async () => {
  await render("0 9 * * *");
  await choose("custom");
  expect(select().value).toBe("custom");
  expect(container.querySelector('input[type="time"]')).toBeNull();
  await choose("hourly");
  expect(onChange).toHaveBeenLastCalledWith("0 * * * *");
});
