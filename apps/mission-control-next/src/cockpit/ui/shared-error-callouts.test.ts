import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// ClassicOwnerLink and the inline form of ShellSwitchFeedback render right after a link, often inside a paragraph or a
// dense row, so they keep their inline alert (a block callout there is invalid nesting and a box in a dense row).
const FILES = [
  "../app/ScopeSwitcherPicker.tsx",
  "./ArtifactRenderActions.tsx",
  "./AttachmentImage.tsx",
  "./UnsavedChangesDialog.tsx",
];

it.each(FILES)("%s has no bare red alert (U-GL-013)", (file) => {
  const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
  // An alert line is a role="alert" element whose class string carries the failed colour.
  expect(source).not.toMatch(/role="alert"[^>]*text-status-failed/);
  expect(source).not.toMatch(/text-status-failed[^>]*role="alert"/);
});
