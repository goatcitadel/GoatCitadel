export const COMPUTER_SCREEN = { width: 1280, height: 800 } as const;

export type ComputerMouseButton = "left" | "right" | "middle";

export interface ComputerPoint {
  x: number;
  y: number;
}

export type ComputerAction =
  | { type: "click"; x: number; y: number; button: ComputerMouseButton }
  | { type: "double_click"; x: number; y: number }
  | { type: "move"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; scrollX: number; scrollY: number }
  | { type: "type"; text: string }
  | { type: "keypress"; keys: string[] }
  | { type: "wait" }
  | { type: "drag"; path: ComputerPoint[] }
  | { type: "screenshot" };

/** What the browser reports about the element an action would hit; read from DOM facts only. */
export interface ErrandTargetInfo {
  x: number;
  y: number;
  tagName: string;
  role: string;
  text: string;
  inputType?: string;
  autocomplete?: string;
  isPasswordLike: boolean;
  isOneTimeCode: boolean;
  formSubmitText?: string;
  rect: { x: number; y: number; width: number; height: number };
}

/** Model-facing key names to Playwright key names. Looked up by upper-cased name; other keys pass through. */
export const COMPUTER_KEY_ALIASES: Readonly<Record<string, string>> = {
  CTRL: "Control",
  CONTROL: "Control",
  ENTER: "Enter",
  RETURN: "Enter",
  ESC: "Escape",
  SHIFT: "Shift",
  ALT: "Alt",
  META: "Meta",
  CMD: "Meta",
  SPACE: " ",
  TAB: "Tab",
  BACKSPACE: "Backspace",
};

const MAX_TEXT_LENGTH = 4_000;
const MAX_KEYS = 8;
const MAX_DRAG_POINTS = 64;
const MAX_SCROLL = 10_000;

export function normalizeComputerKey(key: string): string {
  return COMPUTER_KEY_ALIASES[key.toUpperCase()] ?? key;
}

/**
 * Turns the model's raw action list into validated actions. The model fills every field of every action, so only the
 * fields relevant to each type are read. Invalid actions are dropped with an error naming their 1-based position.
 */
export function normalizeComputerActions(raw: unknown): { actions: ComputerAction[]; errors: string[] } {
  const actions: ComputerAction[] = [];
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    return { actions, errors: ["Computer actions must be a list."] };
  }
  raw.forEach((entry: unknown, index) => {
    const label = `action ${index + 1}`;
    const result = normalizeOne(entry, label);
    if (typeof result === "string") {
      errors.push(result);
    } else {
      actions.push(result);
    }
  });
  return { actions, errors };
}

function normalizeOne(entry: unknown, label: string): ComputerAction | string {
  if (!entry || typeof entry !== "object") {
    return `${label} is not an object.`;
  }
  const record = entry as Record<string, unknown>;
  switch (record.type) {
    case "click": {
      const point = readPoint(record, label);
      if (typeof point === "string") return point;
      const button = readButton(record.button);
      if (!button) return `${label} has an unsupported mouse button.`;
      return { type: "click", ...point, button };
    }
    case "double_click":
    case "move": {
      const point = readPoint(record, label);
      if (typeof point === "string") return point;
      return { type: record.type, ...point };
    }
    case "scroll": {
      const point = readPoint(record, label);
      if (typeof point === "string") return point;
      return {
        type: "scroll",
        ...point,
        scrollX: readScroll(record.scroll_x ?? record.scrollX),
        scrollY: readScroll(record.scroll_y ?? record.scrollY),
      };
    }
    case "type":
      if (typeof record.text !== "string") return `${label} has no text to type.`;
      if (record.text.length > MAX_TEXT_LENGTH) return `${label} types more than ${MAX_TEXT_LENGTH} characters.`;
      return { type: "type", text: record.text };
    case "keypress": {
      const keys = Array.isArray(record.keys) ? record.keys : [];
      if (keys.length === 0 || keys.length > MAX_KEYS || !keys.every((key) => typeof key === "string" && key)) {
        return `${label} needs between 1 and ${MAX_KEYS} keys.`;
      }
      return { type: "keypress", keys: (keys as string[]).map(normalizeComputerKey) };
    }
    case "wait":
      return { type: "wait" };
    case "screenshot":
      return { type: "screenshot" };
    case "drag": {
      const rawPath = Array.isArray(record.path) ? record.path : [];
      if (rawPath.length < 2 || rawPath.length > MAX_DRAG_POINTS) {
        return `${label} needs a drag path of 2 to ${MAX_DRAG_POINTS} points.`;
      }
      const path: ComputerPoint[] = [];
      for (const candidate of rawPath) {
        const point = readPoint((candidate ?? {}) as Record<string, unknown>, label);
        if (typeof point === "string") return point;
        path.push(point);
      }
      return { type: "drag", path };
    }
    default:
      return `${label} has an unknown type.`;
  }
}

function readPoint(record: Record<string, unknown>, label: string): ComputerPoint | string {
  const { x, y } = record;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    return `${label} needs numeric x and y coordinates.`;
  }
  if (x < 0 || y < 0 || x > COMPUTER_SCREEN.width - 1 || y > COMPUTER_SCREEN.height - 1) {
    return `${label} is outside the ${COMPUTER_SCREEN.width}x${COMPUTER_SCREEN.height} screen.`;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

function readButton(value: unknown): ComputerMouseButton | undefined {
  if (value === undefined || value === null || value === "" || value === "left") return "left";
  if (value === "right") return "right";
  if (value === "middle" || value === "wheel") return "middle";
  return undefined;
}

function readScroll(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, Math.round(value)));
}
