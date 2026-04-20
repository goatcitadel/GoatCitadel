import { describe, expect, it } from "vitest";
import { parseRichAgentMarkdown } from "./agent-markdown.js";

describe("parseRichAgentMarkdown", () => {
  it("parses Agency-style frontmatter and canonical sections", () => {
    const parsed = parseRichAgentMarkdown(`---
name: Frontend Developer
description: Builds polished frontends with performance discipline
color: cyan
services:
  - vercel
---

# Frontend Developer

## Your Identity & Memory
- **Role**: Frontend engineer

## Your Communication Style
- Clear and calm

## Critical Rules You Must Follow
- Ship accessible UI

## Your Core Mission
- Build the interface

## Your Technical Deliverables
\`\`\`tsx
export function App() {
  return <main>Hello</main>;
}
\`\`\`

## Your Workflow Process
1. Discover
2. Implement

## Learning & Memory
- Learn from regressions

## Your Success Metrics
- Core Web Vitals stay green

## Advanced Capabilities
- Design systems
`);

    expect(parsed.parseStatus).toBe("supported");
    expect(parsed.frontmatter).toMatchObject({
      name: "Frontend Developer",
      description: "Builds polished frontends with performance discipline",
      color: "cyan",
      services: ["vercel"],
    });
    expect(parsed.sectionOrder).toHaveLength(9);
    expect(parsed.sectionMap["identity-memory"]?.kind).toBe("persona");
    expect(parsed.sectionMap["learning-memory"]?.kind).toBe("persona");
    expect(parsed.sectionMap["core-mission"]?.kind).toBe("operations");
  });

  it("marks unknown sections as supported_with_warnings while preserving them", () => {
    const parsed = parseRichAgentMarkdown(`---
name: Trend Researcher
description: Finds market signals and patterns
---

# Trend Researcher

## Your Identity & Memory
- Research lead

## Secret Sauce
- A custom framework

## Your Core Mission
- Spot the signal
`);

    expect(parsed.parseStatus).toBe("supported_with_warnings");
    expect(parsed.sectionMap["secret-sauce"]?.kind).toBe("other");
    expect(parsed.parseWarnings.join(" ")).toContain("Unrecognized sections");
  });

  it("marks missing frontmatter as unsupported", () => {
    const parsed = parseRichAgentMarkdown(`
# No Frontmatter

## Your Core Mission
- Try anyway
`);

    expect(parsed.parseStatus).toBe("unsupported");
    expect(parsed.frontmatter).toBeUndefined();
    expect(parsed.parseWarnings.join(" ")).toContain("Missing YAML frontmatter");
  });
});
