/** One label per Library section, shared by the section tab and the page heading (LB-17). */
export const LIBRARY_SECTION_LABELS = {
  capabilities: "Candidates and mesh",
  memory: "Memory",
  notes: "Notes",
  files: "Files",
  artifacts: "Artifacts",
  agents: "Agents",
  knowledge: "Knowledge",
  communications: "Mail",
  curator: "Skill curator",
  journey: "Journey timeline",
  "prompt-packs": "Prompt packs",
} as const;

export type LibrarySectionKey = keyof typeof LIBRARY_SECTION_LABELS;
