import { SAY_HI_POLL_MS, SETUP_CODE_TTL_MS } from "./setup-code";

/**
 * Runs `ask` every few seconds until stopped, and calls `onExpired` once the code's time is up, which also ends the
 * asking. It never starts an `ask` while the last is still out, so a slow answer is waited for rather than piled on.
 * `ask` handles its own failures. It returns the way to stop: after that, no further `ask` starts and `onExpired`
 * never runs. Everything it schedules is one interval and one timeout, both cleared by stopping.
 */
export function listenForHi(ask: () => Promise<void>, onExpired: () => void): () => void {
  let stopped = false;
  let asking = false;
  const poll = setInterval(() => {
    if (stopped || asking) return;
    asking = true;
    void ask().finally(() => {
      asking = false;
    });
  }, SAY_HI_POLL_MS);
  const expiry = setTimeout(() => {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    onExpired();
  }, SETUP_CODE_TTL_MS);
  return () => {
    stopped = true;
    clearInterval(poll);
    clearTimeout(expiry);
  };
}
