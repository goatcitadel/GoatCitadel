import { describe, expect, it } from "vitest";

import { isProseFence } from "./prose-fence";

const EMAIL = [
  "Hi Sam,",
  "",
  "Thanks for the update. I can make Tuesday at 3pm if that still works for you.",
  "",
  "Best,",
  "[Your name]",
].join("\n");

describe("isProseFence", () => {
  it("treats sentences in an untagged or text fence as prose", () => {
    expect(isProseFence(undefined, EMAIL)).toBe(true);
    expect(isProseFence("text", EMAIL)).toBe(true);
    expect(isProseFence("TXT", EMAIL)).toBe(true);
    expect(isProseFence("plaintext", "The deploy finished cleanly, and every check passed on the first try.")).toBe(
      true,
    );
  });

  it("keeps a fence tagged with any other language as code, even when it reads like prose", () => {
    expect(isProseFence("markdown", EMAIL)).toBe(false);
    expect(isProseFence("md", EMAIL)).toBe(false);
    expect(isProseFence("python", EMAIL)).toBe(false);
  });

  it("keeps short text and text without a full sentence as code", () => {
    expect(isProseFence(undefined, "")).toBe(false);
    expect(isProseFence(undefined, "npm install --save-dev vitest")).toBe(false);
    expect(isProseFence(undefined, "Done.")).toBe(false);
    expect(isProseFence(undefined, "first item\nsecond item\nthird item\nfourth item")).toBe(false);
  });

  it("keeps code, commands, logs and drawings as code", () => {
    const samples = [
      "const total = items.reduce((sum, item) => sum + item.price, 0);\nconsole.log(total);",
      "def greet(name):\n    print(f'Hello, {name}. Nice to meet you today.')",
      "$ pnpm test\nAll the tests passed in this run, and nothing was skipped.",
      "SELECT name FROM users WHERE active = 1 ORDER BY name. Then group them.",
      "Check the result of user.save() before you continue with the next step.",
      "+--------+\n| Box of text that is drawn in a diagram. |\n+--------+",
      "Name      Status      Owner\nGateway   Running     Ops team for this week.",
      "┌──┐ The diagram shows the gateway and the worker.",
      "> This line is quoted from an earlier message, and it is long enough.",
    ];
    for (const sample of samples) {
      expect(isProseFence(undefined, sample), sample).toBe(false);
    }
  });
});
