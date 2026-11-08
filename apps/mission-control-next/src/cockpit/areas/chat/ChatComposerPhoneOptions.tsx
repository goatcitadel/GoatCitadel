import type { ChatCompletionReasoningEffort } from "@goatcitadel/contracts";
import { ChatComposerControls } from "./ChatComposerControls";
import type { ComposerSources } from "./ChatComposerTools";
import { ChatSourcesChip } from "./ChatSourcesChip";
import type { ComposerProps } from "./ChatTextComposer.types";

export { ChatMediaControls } from "./ChatMediaControls";

export function ChatComposerPhoneOptions({
  props,
  reasoningEfforts,
  sources,
}: {
  props: ComposerProps;
  reasoningEfforts?: ChatCompletionReasoningEffort[];
  sources: ComposerSources;
}) {
  return (
    <ChatComposerControls
      props={props}
      reasoningEfforts={reasoningEfforts}
      scopeKey={props.selectedSessionId ?? ""}
      notices={false}
      sourcesChip={
        props.externalSourceControls ? (
          <ChatSourcesChip
            controls={props.externalSourceControls}
            open={sources.open}
            panelId={sources.panelId}
            onToggle={sources.onToggle}
          />
        ) : null
      }
    />
  );
}
