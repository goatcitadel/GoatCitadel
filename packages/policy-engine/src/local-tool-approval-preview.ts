import { redactStructuredSecrets } from "@goatcitadel/contracts";
import { createDefaultToolRegistry, RUNTIME_CONFIGURE_TOOL_NAME } from "./tool-registry.js";

const registry = createDefaultToolRegistry();
const targets = new Map([
  ["skills.read", "Callable skill in this workspace"],
  ["session.status", "This conversation"],
  ["context.list", "Context attached to this turn"],
  ["context.grep", "Context attached to this turn"],
  ["context.query", "Context attached to this turn"],
  ["context.read_range", "Context attached to this turn"],
  ["project.files.list", "Active managed project"],
  ["project.files.read", "Active managed project"],
  ["fs.list", "Selected directory"],
  ["file.read_range", "Selected file"],
  ["file.find", "Files under the selected path"],
  ["code.search", "Code under the selected path"],
  ["code.search_files", "File and directory names under the selected path"],
  ["docs.read_bytes", "Selected file or chat attachment"],
  ["docs.extract_text", "Selected file or chat attachment"],
  ["user_input.request", "This conversation"],
  ["chat.reminder.preview", "Reminder review in this conversation"],
  ["document.propose_patch", "Selected editable note or generated artifact"],
  [RUNTIME_CONFIGURE_TOOL_NAME, "Search provider configuration"],
]);

function validSelector(key: string, value: unknown, field: Record<string, unknown> | undefined): boolean {
  if (!field) return false;
  if (Array.isArray(field.enum) && !field.enum.includes(value)) return false;
  if (field.type === "string") {
    return (
      typeof value === "string" &&
      (["proposedContent", "prefix", "message"].includes(key) || Boolean(value.trim())) &&
      value.length >= (typeof field.minLength === "number" ? field.minLength : 0) &&
      value.length <= (typeof field.maxLength === "number" ? field.maxLength : 4096) &&
      (typeof field.pattern !== "string" || new RegExp(field.pattern, "u").test(value))
    );
  }
  if (field.type === "integer") {
    return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      (typeof field.minimum !== "number" || value >= field.minimum) &&
      (typeof field.maximum !== "number" || value <= field.maximum)
    );
  }
  return field.type === "boolean" && typeof value === "boolean";
}

/** Local reads and review preparation calls with bounded display-safe arguments. */
export function localToolApprovalPreview(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const target = targets.get(toolName);
  const tool = registry.get(toolName);
  if (!target || !tool) return undefined;

  const schema = tool.argSchema;
  const properties = (schema?.properties ?? (toolName === "fs.list" ? { path: { type: "string" } } : {})) as Record<
    string,
    Record<string, unknown>
  >;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const entries = Object.entries(args);
  if (
    required.some((key: string) => !Object.hasOwn(args, key)) ||
    entries.some(([key, value]) => !Object.hasOwn(properties, key) || !validSelector(key, value, properties[key]))
  ) {
    return undefined;
  }
  if (
    (toolName === "docs.read_bytes" || toolName === "docs.extract_text") &&
    Boolean(args.path) === Boolean(args.attachmentId)
  ) {
    return undefined;
  }

  const { value: selectors } = redactStructuredSecrets(args, { env: process.env });
  const lines = Object.entries(selectors).map(([key, value]) => {
    const label = key.replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`);
    const display = String(value).replace(/\r?\n/gu, "\n  ");
    return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${display}`;
  });
  if (toolName === "skills.read" && args.relativePath === undefined) lines.push("Relative path: SKILL.md");
  if (toolName === "fs.list" && args.path === undefined) lines.push("Path: .");
  return {
    reviewKind: "knowledge.operation",
    toolName,
    target,
    input: lines.join("\n") || "No additional selectors",
    summary: tool.description,
  };
}
