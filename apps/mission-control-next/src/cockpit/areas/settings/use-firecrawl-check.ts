import { useState } from "react";
import type { FirecrawlConnectionCheck } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { checkFirecrawlConnection } from "@goatcitadel/mission-control-shared/api/web-search-settings";

/**
 * The last Firecrawl connection test. A result belongs to the settings it ran against: once the saved settings
 * revision or the saved address changes (`settingsKey`), it is no longer shown, so a "blocked" test that was fixed by
 * adding the host stops driving the page until a new test says otherwise.
 */
export function useFirecrawlCheck(settingsKey: string) {
  const [stored, setStored] = useState<{ key: string; result: FirecrawlConnectionCheck }>();
  const [checkError, setCheckError] = useState<string>();
  const [checking, setChecking] = useState(false);
  async function runCheck() {
    setChecking(true);
    setCheckError(undefined);
    try {
      setStored({ key: settingsKey, result: await checkFirecrawlConnection() });
    } catch (error) {
      setStored(undefined);
      setCheckError(describeApiError(error).summary);
    } finally {
      setChecking(false);
    }
  }
  const check = stored?.key === settingsKey ? stored.result : undefined;
  return { check, checkError, checking, runCheck };
}
