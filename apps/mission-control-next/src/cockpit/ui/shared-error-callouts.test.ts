import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const FILES = [
  "../app/ScopeSwitcherPicker.tsx",
  "../app/use-cockpit-shell-switch.tsx",
  "./ArtifactRenderActions.tsx",
  "./AttachmentImage.tsx",
  "./UnsavedChangesDialog.tsx",
  "./ClassicOwnerLink.tsx",
];

it.each(FILES)("%s has no bare red alert (U-GL-013)", (file) => {
  const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
  // An alert line is a role="alert" element whose class string carries the failed colour.
  expect(source).not.toMatch(/role="alert"[^>]*text-status-failed/);
  expect(source).not.toMatch(/text-status-failed[^>]*role="alert"/);
});
