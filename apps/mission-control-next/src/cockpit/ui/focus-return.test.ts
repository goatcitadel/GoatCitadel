// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { restoreFocus } from "./focus-return";

afterEach(() => {
  document.body.innerHTML = "";
});

it("focuses the opener when it is still on the page and usable", () => {
  document.body.innerHTML = `<section><input aria-label="First"><button>Save setting</button></section>`;
  const save = document.querySelector("button")!;
  restoreFocus(save, save.closest("section"));
  expect(document.activeElement).toBe(save);
});

it("falls back to the first usable control in the region when the opener is disabled", () => {
  document.body.innerHTML = `<section><input type="checkbox" aria-label="Show model reasoning in Chat"><button disabled>Save setting</button></section>`;
  const [toggle, save] = [document.querySelector("input")!, document.querySelector("button")!];
  restoreFocus(save, save.closest("section"));
  expect(document.activeElement).toBe(toggle);
});

it("does nothing when neither the opener nor the region is still on the page", () => {
  const orphan = document.createElement("button");
  restoreFocus(orphan, null);
  expect(document.activeElement).toBe(document.body);
});
