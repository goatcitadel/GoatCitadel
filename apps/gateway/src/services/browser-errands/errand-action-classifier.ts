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
const ENTER_KEY = /^(enter|return)$/i;

const OPAQUE_REASON = "GoatCitadel can't see inside this part of the page";
const UNREADABLE_REASON = "GoatCitadel couldn't read this part of the page";

function isSensitiveField(info: ErrandTargetInfo | null): boolean {
  return info !== null && (info.isPasswordLike || info.isOneTimeCode);
}

function isEnter(action: ComputerAction): boolean {
  return action.type === "keypress" && action.keys.some((key) => ENTER_KEY.test(key));
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

  // Unknown or unreadable surfaces are never treated as safe.
  const subject = isKeyboard ? focused : target;
  if (subject === null) {
    return { kind: "ask", category: "send", reason: UNREADABLE_REASON };
  }
  if (subject.isOpaque) {
    return { kind: "ask", category: "send", reason: OPAQUE_REASON };
  }

  // Rule 4: judge by the element's own text or role, or the form's submit text for Enter.
  const enter = isEnter(action);
  if (isPointer || enter) {
    const text = isPointer
      ? `${subject.text} ${subject.role}`
      : `${subject.formSubmitText ?? ""} ${subject.role === "button" || subject.role === "link" ? subject.text : ""}`;
    const category = matchText(text);
    if (category) {
      return { kind: "ask", category, reason: `This looks like a ${category} action` };
    }

    // Rule 5: risky page paths.
    if (RISKY_PAGE_PATH.test(pagePath(pageUrl))) {
      return { kind: "ask", category: "spend", reason: "This is a checkout or payment page" };
    }
  }

  // Rule 6.
  return { kind: "go" };
}
