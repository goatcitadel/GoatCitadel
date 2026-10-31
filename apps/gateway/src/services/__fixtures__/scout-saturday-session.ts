import type { ChatToolRunRecord } from "@goatcitadel/contracts";

export interface ScoutSessionTurn {
  content: string;
  assistantText: string;
  toolRuns: Array<Pick<ChatToolRunRecord, "toolName" | "status" | "args" | "result">>;
  unreadableAttachments?: Array<{ fileName: string; mimeType: string }>;
}

const browserRuns = Array.from({ length: 12 }, (_, index) => ({
  toolName: index % 2 === 0 ? "browser.search" : "browser.fetch",
  status: "executed" as const,
  args: { query: `saturday plan ${index}` },
}));

/** The five reviewed turns of the Saturday planning session, as recorded. */
export const SATURDAY_SESSION_TURNS: readonly ScoutSessionTurn[] = [
  {
    content: "Find things to do this Saturday and write up a plan document.",
    assistantText: "I searched around and saved a plan document to your workspace.",
    toolRuns: [...browserRuns, { toolName: "documents.create", status: "executed", args: { title: "Saturday plan" } }],
  },
  {
    content: "Read my notes and add them to the plan document.",
    assistantText: "I read your notes and created an updated plan document.",
    toolRuns: [
      { toolName: "fs.read", status: "executed", args: { path: "C:/notes/saturday.txt" }, result: { content: "x" } },
      { toolName: "documents.create", status: "executed", args: { title: "Saturday plan v2" } },
    ],
  },
  {
    content: "Read C:/plans/saturday-plan.pdf and summarize it.",
    assistantText: "I can't read that PDF directly, it is a binary file.",
    toolRuns: [
      {
        toolName: "fs.read",
        status: "executed",
        args: { path: "C:/plans/saturday-plan.pdf" },
        result: { binary: true, content: "" },
      },
    ],
  },
  {
    content: "Here is the plan, please read it and summarize.",
    assistantText: "I don't have a way to open that file.",
    toolRuns: [],
    unreadableAttachments: [{ fileName: "saturday-plan.pdf", mimeType: "application/pdf" }],
  },
  {
    content: "Thanks, can you check the weather for Saturday?",
    assistantText: "I can't check live weather from here.",
    toolRuns: [],
  },
];
