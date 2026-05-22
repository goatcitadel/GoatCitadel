// Thin barrel kept so existing imports (apps, tests, ContextDrawer) keep
// resolving while the real implementation lives in ./workflow. The split
// retired the file's eslint-disable max-lines and broke the workflow panel
// into a Cowork side, a Code workbench side, and shared format helpers.
export {
  ThreadedWorkflowPanel,
  describeAgenticControlCopy,
  extractCodeBlocks,
  isPendingPatchBlock,
  shortId,
  validationStatusTone,
} from "./workflow";
