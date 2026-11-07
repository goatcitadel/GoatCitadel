type SourcesCode = typeof import("../../../features/threaded-surface/ThreadedExternalSourceStrip");

let pendingSourcesCode: Promise<SourcesCode> | undefined;

export function loadChatComposerSources() {
  return (pendingSourcesCode ??= import("../../../features/threaded-surface/ThreadedExternalSourceStrip").catch(
    (cause) => {
      pendingSourcesCode = undefined;
      throw cause;
    },
  ));
}
