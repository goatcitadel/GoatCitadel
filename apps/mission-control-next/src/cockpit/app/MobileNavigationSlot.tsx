import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import type { MobileTabBar } from "./MobileTabBar";
import { COCKPIT_AREA_SHORTCUTS } from "./routes";
import { cockpitHref } from "./cockpit-history";
import { isModifiedClick } from "../lib/modified-click";
import { useCockpitRoute } from "./use-cockpit-route";

type Runtime = typeof MobileTabBar;
let loaded: Runtime | undefined;
let loading: Promise<Runtime> | undefined;

function loadMobileNavigation() {
  return (loading ??= import("./MobileTabBar").then(
    (module) => (loaded = module.MobileTabBar),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  ));
}

/** Desktop has its own navigation. Phones can navigate while their tab bar loads. */
export function MobileNavigationSlot(props: ComponentProps<Runtime>) {
  const [Runtime, setRuntime] = useState<Runtime | undefined>(() => loaded);
  const [failed, setFailed] = useState(false);
  const fallback = useRef<HTMLElement>(null);
  const ready = useRef<HTMLDivElement>(null);
  const focusedHref = useRef<string | null>(null);
  const { area, navigate } = useCockpitRoute();
  useEffect(() => {
    if (Runtime) return;
    let mounted = true;
    void loadMobileNavigation().then(
      (component) => {
        if (!mounted) return;
        const active = document.activeElement;
        focusedHref.current =
          active instanceof HTMLAnchorElement && fallback.current?.contains(active) ? active.href : null;
        setRuntime(() => component);
      },
      () => {
        if (mounted) setFailed(true);
      },
    );
    return () => {
      mounted = false;
    };
  }, [Runtime]);

  useLayoutEffect(() => {
    const href = focusedHref.current;
    focusedHref.current = null;
    if (!Runtime || !href || document.activeElement !== document.body) return;
    const navigation = ready.current;
    const link = Array.from(navigation?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []).find(
      (candidate) => candidate.href === href,
    );
    (link ?? navigation?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, [Runtime]);

  if (Runtime) {
    return (
      <div ref={ready} className="contents">
        <Runtime {...props} />
      </div>
    );
  }
  return (
    <div className="cockpit-safe-bottom shrink-0 border-t border-line-subtle bg-raised sm:hidden">
      <nav ref={fallback} aria-label="Areas on small screens" className="flex min-h-12 overflow-x-auto">
        {COCKPIT_AREA_SHORTCUTS.map(({ area: destination, label, path }) => (
          <a
            key={destination}
            href={cockpitHref(path) ?? path}
            aria-current={area === destination ? "page" : undefined}
            onClick={(event) => {
              if (isModifiedClick(event)) return;
              event.preventDefault();
              navigate(path);
            }}
            className="flex min-h-12 grow shrink-0 items-center justify-center px-2 text-xs text-fg-muted aria-[current=page]:text-fg"
          >
            {label}
          </a>
        ))}
      </nav>
      {failed ? (
        <p className="px-2 text-xs text-fg-secondary">
          The tab bar could not load. Use these area links to navigate.
        </p>
      ) : null}
    </div>
  );
}
