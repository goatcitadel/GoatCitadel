import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Field borders use the control border token, so an input reads as an input (U-LB-002).
const FILES = ["LibraryFileUpload.tsx", "LibraryKnowledgeActions.tsx", "LibraryKnowledgeWorkspace.tsx"];

it.each(FILES)("%s draws its fields with the control border", (file) => {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  expect(source).not.toMatch(/\bborder-line(?![-\w])/);
  expect(source).toMatch(/\bborder-line-control\b/);
});
