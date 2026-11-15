import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { useChatComposerPaletteActions } from "./useChatComposerPaletteActions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ downloadFile: vi.fn(), uploadChatAttachment: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  downloadFile: api.downloadFile,
  uploadChatAttachment: api.uploadChatAttachment,
}));

describe("useChatComposerPaletteActions", () => {
  it("says an attached file was attached without promising it is for the next turn", async () => {
    api.downloadFile.mockResolvedValue({ encoding: "utf8", content: "x", contentType: "text/markdown" });
    api.uploadChatAttachment.mockResolvedValue({ attachmentId: "att-1", fileName: "notes.md" });
    const pushLocalNotice = vi.fn();
    let latest!: ReturnType<typeof useChatComposerPaletteActions>;
    function Harness() {
      latest = useChatComposerPaletteActions({
        workspaceId: "ws-1",
        ensureSession: vi.fn(async () => ({ sessionId: "session-1", workspaceId: "ws-1" })),
        setPendingAttachments: vi.fn(),
        pushLocalNotice,
        setComposerPaletteGlobalOpen: vi.fn(),
        setComposerPaletteQuery: vi.fn(),
        setDraft: vi.fn(),
        requestThreadModelPatch: vi.fn(),
        setSelectedPresetId: vi.fn(),
        handleApplyPresetById: vi.fn(),
        handleAssignProject: vi.fn(),
        handleAttachKnowledgeUrlValue: vi.fn(),
        openRunVariableForm: vi.fn(),
        setUiError: vi.fn(),
      } as never);
      return null;
    }
    await act(async () => {
      create(<Harness />);
    });
    await act(async () => {
      await latest.handleComposerPaletteSelect({
        action: { type: "attach_file", relativePath: "docs/notes.md" },
      } as never);
    });
    expect(pushLocalNotice).toHaveBeenCalledWith("Attached notes.md.", "success");
  });
});
