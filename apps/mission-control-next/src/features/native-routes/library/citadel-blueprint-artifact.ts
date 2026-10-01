import { parseBlueprint } from "./use-citadel-blueprint";

export function downloadBlueprint(exportedJson: string, citadelId: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("Browser downloads are unavailable in this environment.");
  }
  const objectUrl = URL.createObjectURL(new Blob([exportedJson], { type: "application/json;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `${sanitizeBlueprintFilename(citadelId)}-blueprint.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function sanitizeBlueprintFilename(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized.slice(0, 80) || "citadel";
}

export function buildBlueprintProofItems(
  exportedJson: string | null,
  citadelId: string,
): Array<{ title: string; meta?: string; body?: string }> {
  if (!exportedJson) {
    return [];
  }
  const parsed = parseBlueprint(exportedJson);
  const blueprint =
    "blueprint" in parsed && parsed.blueprint && typeof parsed.blueprint === "object"
      ? (parsed.blueprint as Record<string, unknown>)
      : {};
  return [
    {
      title: "Citadel",
      meta: citadelId,
      body: "Export is generated through the Gateway-backed Citadel blueprint API.",
    },
    {
      title: "Schema",
      meta: typeof blueprint.schemaVersion === "string" ? blueprint.schemaVersion : "unknown",
      body: "Portable Blueprint schema used for validation before import.",
    },
    {
      title: "Content",
      meta: `${exportedJson.length} chars`,
      body: "Read-only artifact preview; importing requires explicit validation and operator action.",
    },
    {
      title: "Secret posture",
      meta: "secret-free contract",
      body: "Blueprint export omits credentials and import validation runs a secret scan.",
    },
  ];
}
