import { describe, expect, it, vi } from "vitest";
import { withoutFileInput } from "./channel-file-input";

const file = new File(["x"], "a.txt");

function base() {
  return {
    isDragActive: true,
    onDragEnter: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onComposerPaste: vi.fn(),
  };
}

function dragEvent(types: string[], files: File[] = []) {
  return { dataTransfer: { types, files, dropEffect: "copy" }, preventDefault: vi.fn() };
}

function pasteEvent(data: { types?: string[]; files?: File[]; items?: Array<{ kind: string }> }) {
  return { clipboardData: { types: [], files: [], items: [], ...data }, preventDefault: vi.fn() };
}

describe("withoutFileInput", () => {
  it("never shows a drop target and hands no dropped file to the controller", () => {
    const original = base();
    const props = withoutFileInput(original);
    expect(props.isDragActive).toBe(false);
    const enter = dragEvent(["Files"]);
    props.onDragEnter(enter as never);
    props.onDragLeave(enter as never);
    const drop = dragEvent(["Files"], [file]);
    props.onDrop(drop as never);
    expect(original.onDragEnter).not.toHaveBeenCalled();
    expect(original.onDragLeave).not.toHaveBeenCalled();
    expect(original.onDrop).not.toHaveBeenCalled();
    // The browser must not open the dropped file in place of the app.
    expect(drop.preventDefault).toHaveBeenCalledOnce();
  });

  it("shows a refused cursor over a file drag", () => {
    const over = dragEvent(["Files"]);
    withoutFileInput(base()).onDragOver(over as never);
    expect(over.preventDefault).toHaveBeenCalledOnce();
    expect(over.dataTransfer.dropEffect).toBe("none");
  });

  it("leaves dragged text to the text box", () => {
    const props = withoutFileInput(base());
    const over = dragEvent(["text/plain"]);
    const drop = dragEvent(["text/plain"]);
    props.onDragOver(over as never);
    props.onDrop(drop as never);
    expect(over.preventDefault).not.toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe("copy");
    expect(drop.preventDefault).not.toHaveBeenCalled();
  });

  it("swallows a pasted file or image and hands it to no one", () => {
    const original = base();
    const props = withoutFileInput(original);
    const viaFiles = pasteEvent({ types: ["Files"], files: [file] });
    const viaItems = pasteEvent({ items: [{ kind: "file" }] });
    props.onComposerPaste(viaFiles as never);
    props.onComposerPaste(viaItems as never);
    expect(original.onComposerPaste).not.toHaveBeenCalled();
    expect(viaFiles.preventDefault).toHaveBeenCalledOnce();
    expect(viaItems.preventDefault).toHaveBeenCalledOnce();
  });

  it("still pastes plain text", () => {
    const original = base();
    const text = pasteEvent({ types: ["text/plain"], items: [{ kind: "string" }] });
    withoutFileInput(original).onComposerPaste(text as never);
    expect(original.onComposerPaste).toHaveBeenCalledExactlyOnceWith(text);
    expect(text.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps the text of a paste that arrives with a file, such as a copied table", () => {
    const original = base();
    const both = pasteEvent({ types: ["text/plain", "Files"], files: [file] });
    withoutFileInput(original).onComposerPaste(both as never);
    expect(original.onComposerPaste).not.toHaveBeenCalled();
    expect(both.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps every other prop", () => {
    const original = { ...base(), draft: "hi" };
    expect(withoutFileInput(original).draft).toBe("hi");
  });
});
