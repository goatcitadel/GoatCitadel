import { useState } from "react";
import { type ChatErrorSource } from "../chat-error-copy";

/** Owns transient session error and image recovery state. */
export function useChatErrorState() {
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<ChatErrorSource | null>(null);
  const [failedAutoImageRecovery, setFailedAutoImageRecovery] = useState<{
    prompt: string;
    sessionId: string | null;
  } | null>(null);

  return { setError, setErrorSource, setFailedAutoImageRecovery, failedAutoImageRecovery, error, errorSource };
}
