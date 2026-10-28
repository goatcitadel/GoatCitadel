import { useShellHandoff } from "./use-shell-handoff";

/** A Cockpit address opened from a Classic page: the same address, asking for the Cockpit shell. */
export function cockpitShellHref(href: string): string {
  const url = new URL(href, "http://goatcitadel.local");
  url.searchParams.set("shell", "cockpit");
  return url.pathname + url.search;
}

/** A scoped, explicit native-owner destination from the detailed view. */
export function CockpitOwnerLink({ href, scope, label }: { href: string; scope: string; label: string }) {
  const owner = useShellHandoff([scope, href]);
  return (
    <>
      <a
        href={href}
        aria-disabled={owner.opening || undefined}
        onClick={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          owner.request("cockpit", { href });
        }}
      >
        {owner.opening ? "Opening owner view…" : label}
      </a>
      {owner.error ? <p role="alert">{owner.error}</p> : null}
      {owner.dialog}
    </>
  );
}
