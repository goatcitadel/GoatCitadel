import { useCockpitNavigation } from "../../app/cockpit-navigation-context";
import { isModifiedClick } from "../../lib/modified-click";

/** The one page that owns each runtime editor; other pages point here instead of mounting a second copy. */
export const LLAMA_SETUP_HREF = "/settings/models#local-ai";
export const MANAGED_RUNTIME_HREF = "/settings/advanced#managed-runtime";

/** "llama.cpp setup is on Models › Local AI." with the page name as the link. */
export function SettingsOwnerPointer({ text, label, href }: { text: string; label: string; href: string }) {
  const { navigate } = useCockpitNavigation();
  return (
    <p className="mt-4 border-t border-line-subtle pt-4 text-sm text-fg-secondary">
      {text}{" "}
      <a
        href={href}
        onClick={(event) => {
          if (isModifiedClick(event)) return;
          event.preventDefault();
          navigate(href);
        }}
        className="font-medium text-accent hover:underline"
      >
        {label}
      </a>
      .
    </p>
  );
}
