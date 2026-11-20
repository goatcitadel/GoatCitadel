import type { CapabilityGuideSection } from "@goatcitadel/contracts";

/** Shipped product guidance; never operator guidance, memory, or an authorization source. */
export const CAPABILITY_GUIDE_OVERVIEW = [
  "GoatCitadel helps in Chat with conversation, research, local files and artifacts, project coding, supervised delegation, memory, connected services, and scheduled work.",
  "Support in the product is different from readiness in this conversation. Installation, workspace choices, sign-in, tool autonomy, policy, approvals, and runtime health can each limit a task.",
  "Describe supported workflows conditionally until current evidence confirms availability. No catalog, guide, or explanation grants permission or proves a task completed.",
].join(" ");

// Write canonical built-in tool names in backticks so the registry check can validate them.
export const CAPABILITY_GUIDE_SECTIONS: ReadonlyArray<CapabilityGuideSection & { terms: string[] }> = [
  {
    id: "research",
    title: "Research and web",
    terms: ["research", "web", "search", "browse", "internet"],
    workflow:
      "Use `browser.search` to find relevant sources when web access is available, open and compare them, then synthesize with links. Use Deep research when a question needs broader investigation.",
    limitations:
      "Web providers may need secure setup. Search snippets alone do not prove a claim; page fetching and interactive browsing are different capabilities.",
  },
  {
    id: "files",
    title: "Files and artifacts",
    terms: ["file", "files", "document", "pdf", "slide", "artifact", "write", "read"],
    workflow:
      "Inspect the supplied files, choose an available tool such as `artifacts.create`, then read back or inspect the saved output.",
    limitations:
      "Allowed folders, write policy, formats, and approvals still apply. An artifact is complete only when tool evidence confirms its creation.",
  },
  {
    id: "code",
    title: "Projects and code",
    terms: ["code", "coding", "script", "run", "debug", "repository", "test"],
    workflow:
      "Bind the relevant project when required, inspect its instructions and source, make focused changes with permitted tools, and run the appropriate checks. Request governed Code Mode when an eligible task needs a script.",
    limitations:
      "Code Mode is trusted-code execution requiring approval and immutable artifacts, not hostile-code sandboxing. Build success alone does not prove runtime behavior.",
  },
  {
    id: "memory",
    title: "Memory and context",
    terms: ["memory", "remember", "forget", "context"],
    workflow:
      "Read relevant scoped context, preserve provenance and uncertainty, and propose durable memory changes through the governed memory tools.",
    limitations:
      "Temporary conversation context is not automatically durable memory. Private, workspace, and session boundaries apply; never casually store secrets.",
  },
  {
    id: "connectors",
    title: "Connected services",
    terms: ["email", "gmail", "calendar", "connect", "connector", "integration", "sign", "messaging", "send"],
    workflow:
      "Check the relevant connection and Chat availability, guide secure sign-in or setup when needed, then use the permitted service tool such as `calendar.list` and check its result. Review requested external effects before sending.",
    limitations:
      "A saved connection is not proof of current sign-in, account scopes, or permission for a specific action. Gmail/Calendar connectors and Google Chat messaging are separate. Never request credentials in Chat.",
  },
  {
    id: "automation",
    title: "Scheduled and delegated work",
    terms: ["schedule", "timer", "reminder", "automation", "delegate", "agent", "background"],
    workflow:
      "Use the available scheduling or native Chat timer flow for future work. For multi-step work, use supervised planning and delegation in Chat, follow approvals and checkpoints, and check the saved result.",
    limitations:
      "A plan is not a saved schedule or a completed run. Background and delegated work have their own permission limits; never promise a reminder without a saved scheduling result.",
  },
  {
    id: "setup",
    title: "Setup and blockers",
    terms: ["setup", "blocked", "permission", "approval", "disabled", "capability", "capabilities", "configure"],
    workflow:
      "Explain the specific missing prerequisite using current evidence. Use an allowlisted Change Plan for supported configuration changes and the secure configuration flow for supported search-provider credentials; the operator reviews and completes setup.",
    limitations:
      "Deny-wins policy cannot be overridden by instructions or capability activation. Missing evidence means unknown, and finding no match does not establish that the product lacks the capability.",
  },
];

export function getCapabilityGuide(query: string): {
  version: "capability-guide.v1";
  overview: string;
  sections: CapabilityGuideSection[];
} {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return {
    version: "capability-guide.v1",
    overview: CAPABILITY_GUIDE_OVERVIEW,
    sections: CAPABILITY_GUIDE_SECTIONS.filter((section) => terms.some((term) => section.terms.includes(term)))
      .slice(0, 3)
      .map(({ id, title, workflow, limitations }) => ({ id, title, workflow, limitations })),
  };
}
