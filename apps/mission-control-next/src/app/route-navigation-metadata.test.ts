import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as fullRoutes from "./route-model";
import * as addresses from "./route-address";
import * as navigation from "./route-navigation-metadata";
import {
  buildConnectorSetupDestinations,
  buildSettingsDestinations,
} from "../cockpit/areas/settings/settings-destinations";
import { buildConnectorSetupRouteHomes, buildSettingsRouteHomes } from "../cockpit/areas/settings/settings-route-homes";

describe("compact navigation metadata", () => {
  it("shares public address functions and group objects by identity", () => {
    expect(fullRoutes.parseAppRoute).toBe(addresses.parseAppRoute);
    expect(fullRoutes.buildAppHref).toBe(addresses.buildAppHref);
    expect(fullRoutes.RAIL_GROUPS).toBe(navigation.RAIL_GROUPS);
    expect(fullRoutes.CITADEL_PAGE_LABELS).toBe(navigation.CITADEL_PAGE_LABELS);
  });

  it.each(["library", "ops", "settings"] as const)(
    "keeps every %s section label identical to its full record",
    (area) => {
      const items = fullRoutes.RAIL_ITEMS[area];
      expect(Object.keys(navigation.ROUTE_SECTION_LABELS[area])).toEqual(items.map((item) => item.section));
      for (const item of items) expect(navigation.readRouteSectionLabel(area, item.section!)).toBe(item.label);
      expect(navigation.readRouteSectionLabel(area, "constructor")).toBeUndefined();
      expect(navigation.readRouteSectionLabel(area, "__proto__")).toBeUndefined();
    },
  );

  it("keeps all Settings page and section addresses without pulling discovery policy into routing", () => {
    const slim = ({ section, href }: { section: string; href: string }) => ({ section, href });
    expect(buildSettingsRouteHomes()).toEqual(
      buildSettingsDestinations().map((page) => ({ id: page.id, label: page.label, entries: page.entries.map(slim) })),
    );
    expect(buildConnectorSetupRouteHomes()).toEqual(buildConnectorSetupDestinations().map(slim));
  });

  it("keeps the cold title, compatibility and history dependencies outside full rail and release prose", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const visited = new Set<string>();
    const visit = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (clause?.isTypeOnly) continue;
          if (
            clause?.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((item) => item.isTypeOnly)
          )
            continue;
        } else {
          if (statement.isTypeOnly) continue;
          if (
            statement.exportClause &&
            ts.isNamedExports(statement.exportClause) &&
            statement.exportClause.elements.length > 0 &&
            statement.exportClause.elements.every((item) => item.isTypeOnly)
          )
            continue;
        }
        const module = statement.moduleSpecifier;
        if (!module || !ts.isStringLiteral(module) || !module.text.startsWith(".")) continue;
        const base = path.resolve(path.dirname(file), module.text.replace(/\.js$/u, ""));
        const dependency = [
          base,
          base + ".ts",
          base + ".tsx",
          path.join(base, "index.ts"),
          path.join(base, "index.tsx"),
        ].find((candidate) => /\.[cm]?[jt]sx?$/u.test(candidate) && existsSync(candidate));
        expect(dependency, module.text).toBeDefined();
        if (dependency) visit(dependency);
      }
    };
    for (const file of [
      "cockpit/app/cockpit-document-title.ts",
      "cockpit/app/cockpit-compatibility.ts",
      "cockpit/app/cockpit-history.ts",
    ])
      visit(path.join(root, file));
    for (const file of [
      "app/route-model.ts",
      "app/route-release-scope.ts",
      "cockpit/areas/settings/settings-destinations.ts",
    ]) {
      expect(visited.has(path.join(root, file)), file).toBe(false);
    }
  });
});
