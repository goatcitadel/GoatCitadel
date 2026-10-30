import { EmptyState } from "../../ui/EmptyState";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { SKILLS_HREF } from "../capabilities/skills/skill-links";
import { TOOLS_HREF } from "../capabilities/tools/tool-links";

/**
 * What the catalog shows when no row is left. Either way it says where skills and tools went, because that is what
 * someone who arrives here for them is looking for.
 */
export function CapabilityCatalogEmpty({ hasEntries }: { hasEntries: boolean }) {
  return (
    <EmptyState
      title={hasEntries ? "No matching capabilities" : "Nothing to review yet"}
      description={`${
        hasEntries
          ? "Try a different search or filter."
          : "Candidates, proposals and mesh entries appear here when there are any."
      } Skills and tools are in Capabilities.`}
      action={
        <span className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm font-medium">
          <NativeOwnerLink href={SKILLS_HREF} scope="library-skills-moved">
            Skills
          </NativeOwnerLink>
          <NativeOwnerLink href={TOOLS_HREF} scope="library-tools-moved">
            Tools
          </NativeOwnerLink>
        </span>
      }
    />
  );
}
