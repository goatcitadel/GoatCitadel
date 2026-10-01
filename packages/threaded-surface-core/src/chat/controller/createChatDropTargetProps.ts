import { type DragEventHandler } from "react";
import type { MissionThreadedRenderSurfaceInput } from "../../MissionThreadedControllerHost.types";
import type { useChatComposerInteractions } from "../useChatComposerInteractions";

type Input = {
  isDragActive: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  blockHistoricalMutation: () => boolean;
  composerInteractions: Pick<
    ReturnType<typeof useChatComposerInteractions>,
    "handleUploadFiles" | "handleDragEnter" | "handleDragOver" | "handleDragLeave" | "handleDrop"
  >;
};

/** Preserves guarded attachment drag and drop semantics. */
export function createChatDropTargetProps({
  isDragActive,
  fileInputRef,
  blockHistoricalMutation,
  composerInteractions,
}: Input): Pick<MissionThreadedRenderSurfaceInput, "dropTargetProps"> {
  const { handleUploadFiles } = composerInteractions;
  const { handleDrop } = composerInteractions;

  return {
    dropTargetProps: {
      isDragActive,
      fileInputRef,
      onAttachFiles: () => {
        if (!blockHistoricalMutation()) fileInputRef.current?.click();
      },
      onUploadFiles: (files) => {
        if (!blockHistoricalMutation()) handleUploadFiles(files);
      },
      onDragEnter: composerInteractions.handleDragEnter as DragEventHandler<HTMLElement>,
      onDragOver: composerInteractions.handleDragOver as DragEventHandler<HTMLElement>,
      onDragLeave: composerInteractions.handleDragLeave as DragEventHandler<HTMLElement>,
      onDrop: ((event) => {
        if (blockHistoricalMutation()) {
          event.preventDefault();
          return;
        }
        handleDrop(event as Parameters<typeof composerInteractions.handleDrop>[0]);
      }) as DragEventHandler<HTMLElement>,
    },
  };
}
