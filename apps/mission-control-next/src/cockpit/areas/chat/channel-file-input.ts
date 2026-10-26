import type { ClipboardEvent, DragEvent } from "react";

/** The composer props that take files in: the drop target and the paste handler. */
export interface FileInputProps {
  isDragActive: boolean;
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onComposerPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
}

function draggingFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function clipboardHasFiles(data: DataTransfer | null | undefined): boolean {
  if (!data) return false;
  return (
    (data.files?.length ?? 0) > 0 ||
    Array.from(data.types ?? []).includes("Files") ||
    Array.from(data.items ?? []).some((item) => item.kind === "file")
  );
}

const ignoreDrag = () => undefined;

/** A file dragged over is refused, and a dropped one is kept from opening in place of the app. */
function refuseFileDrag(event: DragEvent<HTMLElement>) {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
}

function refuseFileDrop(event: DragEvent<HTMLElement>) {
  if (draggingFiles(event)) event.preventDefault();
}

/**
 * The same composer props without a way to bring files in. A channel conversation does not take files, so a drop
 * shows no target and reaches no upload, and a pasted file or image is swallowed. Text still pastes and drags in as
 * usual; text that arrives together with a file (a copied table) keeps its text.
 */
export function withoutFileInput<T extends FileInputProps>(props: T): T {
  return {
    ...props,
    isDragActive: false,
    onDragEnter: ignoreDrag,
    onDragLeave: ignoreDrag,
    onDragOver: refuseFileDrag,
    onDrop: refuseFileDrop,
    onComposerPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!clipboardHasFiles(event.clipboardData)) return props.onComposerPaste(event);
      if (!Array.from(event.clipboardData.types ?? []).includes("text/plain")) event.preventDefault();
    },
  };
}
