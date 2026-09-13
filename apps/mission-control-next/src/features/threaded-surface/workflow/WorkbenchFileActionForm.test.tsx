import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionWorkbenchFileOperationPreviewRequest } from "@goatcitadel/contracts";
import { WorkbenchFileActionForm } from "./WorkbenchFileActionForm";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => { renderer?.unmount(); }); renderer = undefined; });
const makeReview = (input: ChatSessionWorkbenchFileOperationPreviewRequest) => ({
  input, revision: "a".repeat(64), sourceKind: "absent" as const, affectedPaths: [], totalBytes: 0,
});
async function fixture() {
  const preview = vi.fn(async (input: ChatSessionWorkbenchFileOperationPreviewRequest) => makeReview(input));
  const apply = vi.fn().mockResolvedValue(true);
  await act(async () => { renderer = create(<WorkbenchFileActionForm busy={false} repoBlockedReason={null}
    onFileOperationPreview={preview} onFileOperation={apply} />); });
  return { preview, apply };
}
const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.children.join("") === label);
async function click(label: string) { await act(async () => { button(label)!.props.onClick(); }); }
async function changePath(value: string) {
  await act(async () => { renderer!.root.findByProps({ placeholder: "src/new-file.ts" }).props.onChange({ target: { value } }); });
}

describe("Workbench file action review", () => {
  it("requires an explicit review and applies exactly its revision", async () => {
    const { preview, apply } = await fixture();
    await changePath("notes.txt");
    expect(button("Apply reviewed action")).toBeUndefined();
    await click("Review file action");
    expect(preview).toHaveBeenCalledWith({ operation: "create_file", path: "notes.txt", targetPath: undefined });
    expect(apply).not.toHaveBeenCalled();
    await click("Apply reviewed action");
    expect(apply).toHaveBeenCalledWith({ operation: "create_file", path: "notes.txt", targetPath: undefined, expectedRevision: "a".repeat(64) });
    expect(button("Apply reviewed action")).toBeUndefined();
  });

  it("invalidates review after any form edit, including changing back to the original path", async () => {
    const { apply } = await fixture();
    await changePath("notes.txt"); await click("Review file action");
    await changePath("later.txt"); await changePath("notes.txt");
    expect(button("Apply reviewed action")).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
  });

  it("ignores an old review response when the operator edits during the request", async () => {
    const { preview } = await fixture();
    let resolve!: (review: ReturnType<typeof makeReview>) => void;
    preview.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await changePath("notes.txt"); await click("Review file action");
    await changePath("later.txt");
    await act(async () => { resolve(makeReview({ operation: "create_file", path: "notes.txt" })); });
    expect(button("Apply reviewed action")).toBeUndefined();
    expect(renderer!.root.findByProps({ placeholder: "src/new-file.ts" }).props.value).toBe("later.txt");
    expect(button("Review file action")!.props.disabled).toBe(false);
  });

  it("retains paths after a conflict and requires a new review before retrying", async () => {
    const { apply, preview } = await fixture(); apply.mockResolvedValueOnce(false);
    await changePath("notes.txt"); await click("Review file action"); await click("Apply reviewed action");
    expect(button("Apply reviewed action")).toBeUndefined();
    expect(renderer!.root.findByProps({ placeholder: "src/new-file.ts" }).props.value).toBe("notes.txt");
    expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain("Review the source and destination again");
    await click("Review file action");
    expect(preview).toHaveBeenCalledTimes(2); expect(apply).toHaveBeenCalledTimes(1);
  });

  it("preserves edits made while an earlier apply is pending", async () => {
    const { apply } = await fixture();
    let resolve!: (result: boolean) => void;
    apply.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await changePath("notes.txt"); await click("Review file action"); await click("Apply reviewed action");
    await changePath("next-file.txt");
    await act(async () => { resolve(true); });
    expect(renderer!.root.findByProps({ placeholder: "src/new-file.ts" }).props.value).toBe("next-file.txt");
    expect(button("Apply reviewed action")).toBeUndefined();
  });
});
