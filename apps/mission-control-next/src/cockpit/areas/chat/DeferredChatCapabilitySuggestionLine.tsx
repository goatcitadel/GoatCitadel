import { lazy, useState, type ComponentProps } from "react";
import { DeferredChatLeaf } from "./DeferredChatLeaves";

const SuggestionLine = lazy(async () => ({
  default: (await import("./ChatCapabilitySuggestionLine")).ChatCapabilitySuggestionLine,
}));

export function DeferredChatCapabilitySuggestionLine({
  turnId,
  ...props
}: ComponentProps<typeof SuggestionLine> & { turnId: string }) {
  const offered = props.suggestions.length > 0;
  const [wasOffered, setWasOffered] = useState(offered);
  if (offered && !wasOffered) setWasOffered(true);
  if (!offered && !wasOffered) return null;

  // Keep this turn's expansion and dismissal focus state when its suggestions temporarily disappear.
  return (
    <div className={offered ? "contents" : "hidden"} hidden={!offered}>
      <DeferredChatLeaf identity={turnId} label="Capability suggestions" loadingVisible={offered}>
        <SuggestionLine {...props} />
      </DeferredChatLeaf>
    </div>
  );
}
