import { Fragment, lazy, Suspense } from "react";
import { AssistantMessageContainer } from "@goatcitadel/mission-control-shared/components/chat/AssistantMessageShell";
import { cn } from "../../lib/cn";
const FormattedBody = lazy(async () => ({ default: (await import("@goatcitadel/mission-control-shared/components/chat/AssistantMessageRenderer")).AssistantMessageBody }));
type Props = Parameters<typeof import("@goatcitadel/mission-control-shared/components/chat/AssistantMessageRenderer").AssistantMessageRenderer>[0];

/** Conservative fast path: anything that can affect Markdown or display normalization uses the existing owner. */
export function isPlainMessage(content: string): boolean {
  return !/[\\\x60*_\[\]<>~|&#=\u0000]/u.test(content) &&
    !/(?:https?:\/\/|www\.|@)/iu.test(content) &&
    !/^(?:[ \t]+|[-+]\s|[0-9]+[.)]\s|-{3,}\s*$)/mu.test(content) &&
    !/[ \t]+(?:\r?\n|$)/u.test(content);
}

export function NativeMessageRenderer(props: Props) {
  const plain = !props.running && isPlainMessage(props.content);
  const content = props.content.trim();
  const paragraphs = content ? content.replace(/\r\n?/gu, "\n").split(/\n[ \t]*\n+/u) : [];
  const body = <div className={cn("mc-assistant-markdown", props.role === "user" ? "mc-assistant-markdown-user" : "mc-assistant-markdown-assistant")}>
    {paragraphs.map((paragraph, index) => <Fragment key={index}>{index ? "\n" : null}<p>{paragraph}</p></Fragment>)}
  </div>;
  return <div className={cn("mc-assistant-renderer mc-assistant-renderer-markdown", props.running ? "mc-assistant-renderer-running" : "", `mc-assistant-stream-${props.streamPresentationMode ?? "smooth"}`, props.className)}>
    <AssistantMessageContainer role={props.role} content={props.content} running={props.running}>
      {plain ? body :
        <Suspense fallback={<p role="status">Formatting response…</p>}><FormattedBody {...props} /></Suspense>}
    </AssistantMessageContainer>
  </div>;
}
