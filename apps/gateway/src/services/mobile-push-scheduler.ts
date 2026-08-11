import { startBackgroundInterval, type BackgroundIntervalHandle } from "./background-scheduler.js";
import type { MobilePushService } from "./mobile-push-service.js";

export const MOBILE_PUSH_DELIVERY_INTERVAL_MS = 15_000;
export const MOBILE_PUSH_DELIVERY_BOOT_DELAY_MS = 5_000;
const MOBILE_PUSH_DELIVERY_BATCH_LIMIT = 25;

export interface MobilePushDeliverySchedulerDeps {
  service: Pick<MobilePushService, "deliverDue">;
  /** Live provider posture; the scheduler never starts while this is false. */
  providerAvailable: () => boolean;
  isClosing: () => boolean;
  registerInflight: (task: Promise<void>) => void;
  onError: (error: unknown, label: string) => void;
  intervalMs?: number;
  bootDelayMs?: number;
}

/**
 * Outbox drain scheduler for the M8 mobile push delivery owner.
 *
 * Production-dark contract: with no provisioned provider credential
 * (`providerAvailable()` false, the shipped default) this returns `undefined`
 * and NO timer is created — an enabled registration stays a durable intent,
 * never live delivery. When credentialed, each tick drains due deliveries
 * through {@link MobilePushService.deliverDue}, which owns claim CAS, the
 * atomic revoke/send fence, bounded exponential retry/backoff, and
 * unknown-after-send quarantine. Ticks are non-overlapping and unref'd via
 * {@link startBackgroundInterval}.
 */
export function startMobilePushDeliveryScheduler(
  deps: MobilePushDeliverySchedulerDeps,
): BackgroundIntervalHandle | undefined {
  let available: boolean;
  try {
    available = deps.providerAvailable();
  } catch {
    available = false;
  }
  if (!available) {
    return undefined;
  }
  return startBackgroundInterval({
    label: "mobile push delivery scheduler",
    intervalMs: Math.max(1_000, Math.floor(deps.intervalMs ?? MOBILE_PUSH_DELIVERY_INTERVAL_MS)),
    bootDelayMs: deps.bootDelayMs ?? MOBILE_PUSH_DELIVERY_BOOT_DELAY_MS,
    task: async () => {
      await deps.service.deliverDue(MOBILE_PUSH_DELIVERY_BATCH_LIMIT);
    },
    isClosing: deps.isClosing,
    registerInflight: deps.registerInflight,
    onError: deps.onError,
  });
}
