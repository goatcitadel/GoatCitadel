import { useLayoutEffect } from "react";
import { useChatMultimodalControls, type ChatMultimodalInput } from "./useChatMultimodalControls";

export function ChatMultimodalRuntime({
  input,
  publish,
}: {
  input: ChatMultimodalInput;
  publish: (controls: ReturnType<typeof useChatMultimodalControls>) => void;
}) {
  const controls = useChatMultimodalControls(input);
  useLayoutEffect(() => publish(controls));
  return null;
}
