import { fetchToolCatalog, fetchToolGrants } from "@goatcitadel/mission-control-shared/api/client";
import { nativeLoad, nativeLoadIssues } from "./SettingsShared";

/** Installation-wide bounded records, not an effective-policy projection. */
export async function loadToolGrantsSnapshot() {
  const [tools, grants] = await Promise.all([
    nativeLoad("Tool catalog", fetchToolCatalog(), { items: [] }),
    nativeLoad("Tool grants", fetchToolGrants({ limit: 400 }), { items: [] }),
  ]);
  return { tools: tools.data.items, grants: grants.data.items, issues: nativeLoadIssues([tools, grants]) };
}
