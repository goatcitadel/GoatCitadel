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

it("skips hidden controls and controls inside a closed disclosure", () => {
  document.body.innerHTML = `<section><button hidden>Hidden</button><button style="display: none">None</button><details><div><button>Inside</button></div></details><input aria-label="Reachable"></section>`;
  restoreFocus(null, document.querySelector("section"));
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Reachable");
});

it("falls back to the page heading, never the body, when nothing in the region can take focus", () => {
  document.body.innerHTML = `<main><h1>Settings</h1><section><button disabled>Save</button></section></main>`;
  const save = document.querySelector("button")!;
  restoreFocus(save, save.closest("section"));
  expect(document.activeElement?.tagName).toBe("H1");
  document.body.innerHTML = `<main><p>No heading</p></main>`;
  restoreFocus(document.createElement("button"), null);
  expect(document.activeElement?.tagName).toBe("MAIN");
});
