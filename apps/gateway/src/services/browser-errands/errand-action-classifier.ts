import type { ComputerAction, ErrandTargetInfo } from "@goatcitadel/policy-engine";

export type ErrandRiskCategory = "spend" | "send" | "delete" | "settings";

export type ErrandActionVerdict =
  | { kind: "go" }
  | { kind: "ask"; category: ErrandRiskCategory; reason: string }
  | { kind: "handover"; reason: "sign_in" };

export interface ClassifyErrandActionInput {
  action: ComputerAction;
  target: ErrandTargetInfo | null;
  focused: ErrandTargetInfo | null;
  pageUrl: string;
  modelDeclared?: ErrandRiskCategory;
}

const TEXT_RULES: ReadonlyArray<{ category: ErrandRiskCategory; pattern: RegExp }> = [
  {
    category: "spend",
    pattern:
      /place (your )?order|buy now|pay( now)?|checkout|complete purchase|subscribe|confirm (order|purchase|payment)|start (free )?trial|donate/i,
  },
  { category: "send", pattern: /\bsend\b|\bpost\b|publish|reply|submit (review|comment)|share/i },
  {
    category: "delete",
    pattern: /delete|remove (account|permanently)|cancel (subscription|membership|order)|close account|erase/i,
  },
  {
    category: "settings",
    pattern: /save changes|update (password|email|address|payment)|change (password|email|plan)|turn off|deactivate/i,
  },
];

const RISKY_PAGE_PATH = /checkout|payment|billing|\/buy\/|placeorder/i;
const ADD_TO_CART = /add to (cart|basket|bag)/i;
const SUBMIT_KEYS = new Set(["enter", "return", "numpadenter"]);
const SPACE_KEYS = new Set([" ", "space", "spacebar"]);
const NAVIGATION_KEYS = new Set([
  "tab",
  "shift",
  "escape",
  "esc",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "up",
  "down",
  "left",
  "right",
  "pageup",
  "pagedown",
  "home",
  "end",
]);

const OPAQUE_REASON = "GoatCitadel can't see inside this part of the page";
const UNREADABLE_REASON = "GoatCitadel couldn't read this part of the page";

function isSensitiveField(info: ErrandTargetInfo | null): boolean {
  return info !== null && (info.isPasswordLike || info.isOneTimeCode);
}

/** Splits "Ctrl+Enter" style combos into lower-cased key tokens; a lone " " or "+" is kept as typed. */
function keyTokens(action: ComputerAction): string[] {
  if (action.type !== "keypress") {
    return [];
  }
  return action.keys
    .flatMap((key) => (key.length > 1 && key.includes("+") ? key.split("+").filter((part) => part !== "") : [key]))
    .map((token) => (token === " " ? token : token.trim().toLowerCase()));
}

function isActivatable(info: ErrandTargetInfo): boolean {
  return info.role === "button" || info.role === "link";
}

/** Enter-like keys submit; Space activates a focused button or link. */
function isSubmitKeypress(tokens: string[], focused: ErrandTargetInfo): boolean {
  return (
    tokens.some((token) => SUBMIT_KEYS.has(token)) ||
    (isActivatable(focused) && tokens.some((token) => SPACE_KEYS.has(token)))
  );
}

/** Message boxes (a textarea or contenteditable text) often send on Enter even without a form. */
function isMessageBox(info: ErrandTargetInfo): boolean {
  return info.tagName.toLowerCase() === "textarea" || info.isContentEditable === true;
}

/** Enter without Shift (Shift+Enter is a new line in message boxes). */
function isUnshiftedEnter(tokens: string[]): boolean {
  return tokens.some((token) => SUBMIT_KEYS.has(token)) && !tokens.includes("shift");
}

/** With no readable focus, only plain navigation keys are harmless. */
function isNavigationOnly(tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every((token) => NAVIGATION_KEYS.has(token));
}

function matchText(text: string): ErrandRiskCategory | null {
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(text)) {
      return rule.category;
    }
  }
  return null;
}

function pagePath(pageUrl: string): string {
  try {
    return new URL(pageUrl).pathname;
  } catch {
    return pageUrl;
  }
}

/**
 * Decides, from browser DOM facts only (never model prose), whether an errand
 * action may proceed, needs operator approval, or must be handed to the operator.
 * The model may raise a request via `modelDeclared`, never lower one.
 */
export function classifyErrandAction(input: ClassifyErrandActionInput): ErrandActionVerdict {
  const { action, target, focused, pageUrl, modelDeclared } = input;
  const isKeyboard = action.type === "type" || action.type === "keypress";
  const isPointer = action.type === "click" || action.type === "double_click" || action.type === "drag";

  // Rules 1 and 2: credentials are never handled by the model.
  if (isKeyboard && isSensitiveField(focused)) {
    return { kind: "handover", reason: "sign_in" };
  }
  if (isPointer && isSensitiveField(target)) {
    return { kind: "handover", reason: "sign_in" };
  }

  // Rule 3: the model can raise a request, never lower one.
  if (modelDeclared) {
    return { kind: "ask", category: modelDeclared, reason: `The model flagged this action as ${modelDeclared}` };
  }

  if (!isKeyboard && !isPointer) {
    return { kind: "go" };
  }

  // Unknown or unreadable surfaces are never treated as safe (plain navigation keys excepted).
  const tokens = keyTokens(action);
  if (action.type === "keypress" && (focused === null || focused.isOpaque) && isNavigationOnly(tokens)) {
    return { kind: "go" };
  }
  const subject = isKeyboard ? focused : target;
  if (subject === null) {
    return { kind: "ask", category: "send", reason: UNREADABLE_REASON };
  }
  if (subject.isOpaque) {
    return { kind: "ask", category: "send", reason: OPAQUE_REASON };
  }

  // Rule 4: judge by the element's own text or role, or the form's submit text for Enter.
  const submit = action.type === "keypress" && isSubmitKeypress(tokens, subject);
  if (isPointer || submit) {
    const text = isPointer
      ? `${subject.text} ${subject.role}`
      : `${subject.formSubmitText ?? ""} ${isActivatable(subject) ? subject.text : ""}`;
    const category = matchText(text);
    if (category) {
      return { kind: "ask", category, reason: `This looks like a ${category} action` };
    }

    // Adding to a cart is never a spend, even on cart or checkout pages.
    if (ADD_TO_CART.test(text)) {
      return { kind: "go" };
    }

    // Rule 5: risky page paths.
    if (RISKY_PAGE_PATH.test(pagePath(pageUrl))) {
      return { kind: "ask", category: "spend", reason: "This is a checkout or payment page" };
    }

    // Rule 5b: Enter in a message box with no form to judge by may send the message.
    if (submit && !subject.formSubmitText && isMessageBox(subject) && isUnshiftedEnter(tokens)) {
      return { kind: "ask", category: "send", reason: "Pressing Enter here may send a message" };
    }
  }

  // Rule 6.
  return { kind: "go" };
}
