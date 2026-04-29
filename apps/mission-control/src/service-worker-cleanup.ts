const MISSION_CONTROL_CACHE_PREFIX = "goatcitadel-mission-control-";

type ServiceWorkerRegistrationLike = Pick<
  ServiceWorkerRegistration,
  "active" | "installing" | "scope" | "unregister" | "waiting"
>;

function registrationScriptUrl(registration: ServiceWorkerRegistrationLike): string | undefined {
  return registration.active?.scriptURL ?? registration.waiting?.scriptURL ?? registration.installing?.scriptURL;
}

function isMissionControlServiceWorker(
  registration: ServiceWorkerRegistrationLike,
  origin = globalThis.location?.origin,
): boolean {
  if (!origin || !registration.scope.startsWith(origin)) {
    return false;
  }
  const scriptUrl = registrationScriptUrl(registration);
  if (!scriptUrl) {
    return false;
  }
  try {
    const parsed = new URL(scriptUrl);
    return parsed.origin === origin && parsed.pathname.endsWith("/sw.js");
  } catch {
    return false;
  }
}

async function deleteMissionControlCaches(cacheStorage: CacheStorage | undefined): Promise<void> {
  if (!cacheStorage) {
    return;
  }
  const keys = await cacheStorage.keys();
  await Promise.all(
    keys.filter((key) => key.startsWith(MISSION_CONTROL_CACHE_PREFIX)).map((key) => cacheStorage.delete(key)),
  );
}

export async function retireMissionControlServiceWorkers(): Promise<void> {
  const serviceWorker = globalThis.navigator?.serviceWorker;
  if (!serviceWorker?.getRegistrations) {
    return;
  }

  const registrations = await serviceWorker.getRegistrations();
  await Promise.all(
    registrations
      .filter((registration) => isMissionControlServiceWorker(registration))
      .map((registration) => registration.unregister()),
  );
  await deleteMissionControlCaches(globalThis.caches);
}
