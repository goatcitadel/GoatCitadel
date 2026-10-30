import { describe, expect, it } from "vitest";
import { normalizeAssistantDisplayText, normalizeCitationDisplayText } from "./assistant-display-text";
import { normalizeMathDelimiters } from "./math-delimiters";

describe("normalizeMathDelimiters", () => {
  it.each([
    ["Euler: $e^{i\\pi} + 1 = 0$.", "Euler: $$e^{i\\pi} + 1 = 0$$."],
    ["Area \\(\\pi r^2\\) here", "Area $$\\pi r^2$$ here"],
    ["\\[\\int_0^1 x\\,dx\\]", "$$\n\\int_0^1 x\\,dx\n$$"],
    ["  \\[ a^2 + b^2 \\]", "  $$\n  a^2 + b^2\n  $$"],
    ["\\[\nx = 1\n\\]", "$$\nx = 1\n$$"],
    ["Already $$x^2$$ and $y$", "Already $$x^2$$ and $$y$$"],
    ["$x$-axis and $n$", "$$x$$-axis and $$n$$"],
  ])("reads %j as math", (input, expected) => {
    expect(normalizeMathDelimiters(input)).toBe(expected);
  });

  it.each([
    "It costs $5 and $10.",
    "Between $5-$10 a month",
    "$HOME and $PATH",
    "Price: US$5 or $ 6",
    "Escaped \\$5 and \\$6",
    "Ends with a lone $",
    "From $5 to $10, while $x$ is math",
  ])("keeps prices and plain dollar signs in %j", (input) => {
    const out = normalizeMathDelimiters(input);
    if (input.includes("$x$")) {
      expect(out).toBe("From $5 to $10, while $$x$$ is math");
    } else {
      expect(out).toBe(input);
    }
  });

  it("never runs math across a line or a shielded code span", () => {
    expect(normalizeMathDelimiters("a $b\nc$ d")).toBe("a $b\nc$ d");
    expect(normalizeMathDelimiters("$a \u0000code:0\u0000 b$")).toBe("$a \u0000code:0\u0000 b$");
  });
});

describe("math in reply text", () => {
  it("leaves code alone", () => {
    expect(normalizeAssistantDisplayText("Run `echo $a$` then $b$")).toBe("Run `echo $a$` then $$b$$");
    expect(normalizeAssistantDisplayText("```\nprintf '$x$'\n```")).toBe("```\nprintf '$x$'\n```");
  });

  it.each([
    ["an indented block", "Example:\n\n    \\[x^2\\] and $y$\n\nThen $z$."],
    ["a fence in a quote", "> ```latex\n> \\[x^2\\]\n> ```\n\nThen $z$."],
    ["a fence in a list", "- step\n\n  ```\n  echo $a$ \\(b\\)\n  ```\n\nThen $z$."],
  ])("leaves %s as written", (_label, input) => {
    expect(normalizeAssistantDisplayText(input)).toBe(input.replace("Then $z$.", () => "Then $$z$$."));
  });

  it("keeps citation snippets as written", () => {
    expect(normalizeCitationDisplayText("costs $x$ per unit")).toBe("costs $x$ per unit");
  });
});
