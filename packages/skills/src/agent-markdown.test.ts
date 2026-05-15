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

  it("reports malformed frontmatter fences and YAML without losing body parsing", () => {
    const missingClose = parseRichAgentMarkdown(`---
name: Broken Agent
description: Missing the closing fence

## Your Core Mission
- Keep reading`);

    expect(missingClose.parseStatus).toBe("unsupported");
    expect(missingClose.parseWarnings.join(" ")).toContain("Frontmatter fence closes incorrectly");

    const invalidYaml = parseRichAgentMarkdown(`---
name: [unterminated
description: Broken YAML
---

## Your Core Mission
- Keep reading`);

    expect(invalidYaml.parseStatus).toBe("unsupported");
    expect(invalidYaml.parseWarnings.join(" ")).toContain("Invalid YAML frontmatter");
  });

  it("reports invalid frontmatter objects and missing required fields", () => {
    const scalarFrontmatter = parseRichAgentMarkdown(`---
plain scalar
---

## Your Core Mission
- Work`);

    expect(scalarFrontmatter.frontmatter).toBeUndefined();
    expect(scalarFrontmatter.parseWarnings.join(" ")).toContain("Frontmatter must be a YAML object");

    const missingRequired = parseRichAgentMarkdown(`---
color: cyan
services: "research, research, code,   "
presentation:
  density: compact
metadata:
  owner: test
custom: kept
---

## Your Identity & Memory
- Persona

## Your Core Mission
- Work`);

    expect(missingRequired.frontmatter).toMatchObject({
      name: "",
      description: "",
      services: ["research", "code"],
      presentation: { density: "compact" },
      metadata: { owner: "test" },
      extra: { custom: "kept" },
    });
    expect(missingRequired.parseWarnings.join(" ")).toContain("Frontmatter name is required");
    expect(missingRequired.parseWarnings.join(" ")).toContain("Frontmatter description is required");
  });

  it("normalizes services from mixed arrays without preserving empty or duplicate entries", () => {
    const parsed = parseRichAgentMarkdown(`---
name: Mixed Services
description: Normalizes service metadata
services:
  - " research "
  - 42
  - ""
  - code
  - research
---

## Your Identity & Memory
- Persona

## Your Core Mission
- Work`);

    expect(parsed.parseStatus).toBe("supported");
    expect(parsed.frontmatter?.services).toEqual(["research", "code"]);
  });

  it("tracks duplicate canonical sections and reference groups", () => {
    const parsed = parseRichAgentMarkdown(`---
name: Operations Lead
description: Keeps operations moving
services: ""
presentation:
  - ignored
metadata:
  - ignored
---

## Your Identity & Memory
- Primary persona

## Identity and Memory
- Secondary persona

## Your Core Mission
- Primary mission

## Quick Reference
- Reference material

## Next Steps
- Follow-up work
`);

    expect(parsed.parseStatus).toBe("supported");
    expect(parsed.frontmatter?.services).toBeUndefined();
    expect(parsed.frontmatter?.presentation).toBeUndefined();
    expect(parsed.frontmatter?.metadata).toBeUndefined();
    expect(parsed.sectionOrder).toEqual([
      "identity-memory",
      "identity-memory-2",
      "core-mission",
      "quick-reference",
      "next-steps",
    ]);
    expect(parsed.sectionMap["quick-reference"]?.kind).toBe("reference");
    expect(parsed.sectionMap["identity-memory-2"]?.canonicalKey).toBe("identity-memory");
  });

  it("ignores malformed or empty level-2 headings", () => {
    const parsed = parseRichAgentMarkdown(`---
name: Heading Tester
description: Checks heading handling
---

##No Space
## ${"\t"}
## Your Identity & Memory
- Persona

## Your Core Mission
- Work
`);

    expect(parsed.parseStatus).toBe("supported");
    expect(parsed.sectionOrder).toEqual(["identity-memory", "core-mission"]);
  });

  it("reports missing section groups separately", () => {
    const noSections = parseRichAgentMarkdown(`---
name: Empty Agent
description: Has no sections
---

# Just a title`);

    expect(noSections.parseStatus).toBe("unsupported");
    expect(noSections.parseWarnings.join(" ")).toContain("No level-2 Markdown sections were found");

    const personaOnly = parseRichAgentMarkdown(`---
name: Persona Only
description: Missing operations
---

## Your Identity & Memory
- Persona`);

    expect(personaOnly.parseStatus).toBe("supported_with_warnings");
    expect(personaOnly.parseWarnings.join(" ")).toContain("Missing operations section group");
  });
});
