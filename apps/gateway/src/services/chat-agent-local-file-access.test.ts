import { describe, expect, it, vi } from "vitest";
import {
  buildLocalFileAccessProbeFailure,
  buildLocalFileAccessProbeSuccess,
  detectLocalFileAccessCheckIntent,
  extractExplicitLocalAccessPaths,
  inferLocalFileAccessCheckPath,
  looksLikeExplicitLocalAccessPath,
  normalizeLocalAccessPathCandidate,
} from "./chat-agent-local-file-access.js";

describe("chat local file access helpers", () => {
  it("detects approval-oriented local file access follow-ups", () => {
    expect(detectLocalFileAccessCheckIntent("What would you need for local filesystem access?")).toBe(true);
    expect(detectLocalFileAccessCheckIntent("Ask me for approval before using the local folder.")).toBe(true);
    expect(detectLocalFileAccessCheckIntent("Can you actually open my local project files?")).toBe(true);
    expect(detectLocalFileAccessCheckIntent("Please summarize this pasted text.")).toBe(false);
  });

  it("extracts rooted Windows and UNC paths while trimming follow-up action text", () => {
    const content = [
      "## User Task",
      "Check `C:\\Users\\spurn\\Desktop\\Chrome Downloads and then list stale files`.",
      "Also inspect \\\\nas\\share\\Inbox before moving anything.",
    ].join("\n");

    expect(extractExplicitLocalAccessPaths(content)).toEqual([
      "C:\\Users\\spurn\\Desktop\\Chrome Downloads",
      "\\\\nas\\share\\Inbox",
    ]);
  });

  it("falls back from current prompt paths to recent history message text", () => {
    const promptPathExtractor = vi.fn<(content: string) => string | undefined>();

    expect(
      inferLocalFileAccessCheckPath({
        content: "What do you need for local file access?",
        historyMessages: [
          {
            role: "assistant",
            content: [
              { text: "The target folder was C:\\Users\\spurn\\Desktop\\Chrome Downloads." },
              { ignored: true },
              null,
            ],
          },
        ],
        promptPathExtractor,
      }),
    ).toBe("C:\\Users\\spurn\\Desktop\\Chrome Downloads");
    expect(promptPathExtractor).toHaveBeenCalled();
  });

  it("normalizes path candidates and formats probe messages without inventing access", () => {
    expect(normalizeLocalAccessPathCandidate(undefined)).toBeUndefined();
    expect(normalizeLocalAccessPathCandidate('"C:\\Temp\\Inbox",')).toBe("C:\\Temp\\Inbox");
    expect(looksLikeExplicitLocalAccessPath("\\\\nas\\share\\Inbox")).toBe(true);
    expect(looksLikeExplicitLocalAccessPath("Desktop\\Inbox")).toBe(false);
    expect(buildLocalFileAccessProbeSuccess("C:\\Temp\\Inbox", { items: [{ name: "a.txt" }] })).toContain(
      "I can see 1 item there.",
    );
    expect(buildLocalFileAccessProbeFailure("C:\\Temp\\Inbox", { failureGuidance: "approval denied" })).toContain(
      "approval denied",
    );
  });
});
