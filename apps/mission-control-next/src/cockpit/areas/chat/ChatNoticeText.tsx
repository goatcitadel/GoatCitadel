import { lazy, Suspense, type ReactNode } from "react";

const ChatCommandNotice = lazy(() =>
  import("./ChatCommandNotice").then(
    ({ ChatCommandNotice }) => ({ default: ChatCommandNotice }),
    () => ({ default: ({ fallback }: { fallback: ReactNode }) => fallback }),
  ),
);

export function ChatNoticeText({ content }: { content: string }) {
  if (!content.includes("\n")) return <>{content}</>;
  const text = <span className="whitespace-pre-line">{content}</span>;
  if (!content.includes(" - ")) return text;
  return (
    <Suspense fallback={text}>
      <ChatCommandNotice content={content} fallback={text} />
    </Suspense>
  );
}
