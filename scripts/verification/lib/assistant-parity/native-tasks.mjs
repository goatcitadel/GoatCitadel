import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const ASSISTANT_PARITY_SUITE = "assistant_parity_v1";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const assistantCorpusSha256 = (value) => createHash("sha256").update(canonical(value)).digest("hex");
function template(value) {
  if (typeof value === "string") return value.normalize("NFKC").replace(/\d+/gu, "#").replace(/\s+/gu, " ").trim();
  if (Array.isArray(value)) return value.map(template);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, template(value[key])]),
    );
  return value;
}
/** Fixture marker/number substitutions are repetitions of one task template, never independent samples. */
export function assistantIndependentTaskId(task) {
  return `template:${task.category}:${hash(template({ prompt: task.prompt, fixture: task.fixture ?? {} })).slice(0, 24)}`;
}
export function buildAssistantNativeTask(task) {
  if (
    !task?.id ||
    task.nativeTaskId !== `assistant-${task.id}` ||
    task.independentTaskId !== assistantIndependentTaskId(task)
  )
    throw new Error("The assistant case needs its frozen native task and independent template identity.");
  return {
    id: task.nativeTaskId,
    prompt: task.prompt,
    files: {},
    phases: [{ id: "assistant_case", action: "run_assistant_case" }],
    criteria: ["canonical_case_evidence"],
    assistantCase: structuredClone(task),
  };
}
let nativeTasks;
export function assistantNativeTasks() {
  if (nativeTasks) return nativeTasks;
  const cases = JSON.parse(
    readFileSync(new URL("../../fixtures/assistant-parity/cases.json", import.meta.url), "utf8"),
  );
  const manifest = JSON.parse(
    readFileSync(new URL("../../fixtures/assistant-parity/manifest.json", import.meta.url), "utf8"),
  );
  if (assistantCorpusSha256(cases) !== manifest.corpusSha256)
    throw new Error("The frozen assistant corpus changed before native dispatch.");
  nativeTasks = cases.map(buildAssistantNativeTask);
  return nativeTasks;
}
