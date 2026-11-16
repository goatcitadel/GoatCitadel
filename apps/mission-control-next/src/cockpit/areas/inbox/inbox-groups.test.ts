import { expect, it } from "vitest";
import { INBOX_GROUPS } from "./inbox-presentation";

it("labels the background group Notices and keeps its id", () => {
  const group = INBOX_GROUPS.find((entry) => entry.id === "updates");
  expect(group?.label).toBe("Notices");
});
