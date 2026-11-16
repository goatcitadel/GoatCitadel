import { expect, it } from "vitest";
import { TAB_ACTIVE_CLASS, TAB_CLASS, TAB_CURRENT_PAGE_CLASS } from "./tab-style";

it("one tab class carries hover, the minimum height and the underline slot", () => {
  for (const word of ["min-h-9", "border-b-2", "border-transparent", "hover:text-fg", "text-sm"]) {
    expect(TAB_CLASS.split(" ")).toContain(word);
  }
});

it("the current tab swaps the underline to the accent in both the Radix and the link form", () => {
  expect(TAB_ACTIVE_CLASS).toContain("data-[state=active]:border-accent");
  expect(TAB_ACTIVE_CLASS).toContain("data-[state=active]:text-fg");
  expect(TAB_CURRENT_PAGE_CLASS).toContain("aria-[current=page]:border-accent");
  expect(TAB_CURRENT_PAGE_CLASS).toContain("aria-[current=page]:text-fg");
});
