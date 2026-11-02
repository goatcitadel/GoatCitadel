import type { Page } from "playwright";
import type { ComputerAction, ComputerPoint } from "./computer-actions.js";

const WAIT_MS = 1_000;

/** The screen point an action acts on, if any (a drag starts at its first point). */
export function pointOf(action: ComputerAction): ComputerPoint | undefined {
  switch (action.type) {
    case "click":
    case "double_click":
    case "move":
    case "scroll":
      return { x: action.x, y: action.y };
    case "drag":
      return action.path[0];
    default:
      return undefined;
  }
}

/** Sends one action as real mouse/keyboard input. Callers must wrap this in the overlay's automation-input guard. */
export async function dispatchComputerAction(page: Page, action: ComputerAction): Promise<void> {
  switch (action.type) {
    case "click":
      await page.mouse.click(action.x, action.y, { button: action.button });
      return;
    case "double_click":
      await page.mouse.dblclick(action.x, action.y);
      return;
    case "move":
      await page.mouse.move(action.x, action.y);
      return;
    case "scroll":
      await page.mouse.move(action.x, action.y);
      await page.mouse.wheel(action.scrollX, action.scrollY);
      return;
    case "type":
      await page.keyboard.type(action.text);
      return;
    case "keypress": {
      // Held in order and released in reverse, so ["Control", "a"] is the chord Ctrl+A.
      const pressed: string[] = [];
      try {
        for (const key of action.keys) {
          await page.keyboard.down(key);
          pressed.push(key);
        }
      } finally {
        for (const key of pressed.reverse()) {
          await page.keyboard.up(key).catch(() => undefined);
        }
      }
      return;
    }
    case "drag": {
      const [first, ...rest] = action.path;
      if (!first) return;
      await page.mouse.move(first.x, first.y);
      await page.mouse.down();
      try {
        for (const point of rest) {
          await page.mouse.move(point.x, point.y, { steps: 4 });
        }
      } finally {
        await page.mouse.up();
      }
      return;
    }
    case "wait":
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      return;
    case "screenshot":
      return;
  }
}
