# Archived PixelOffice UI

The dormant shared PixelOffice simulation was retired from active source during the Five Focused Improvements work. No application mounted it on the implementation base revision, `30958cdbcfe2a8dc3234929fbee6bdf4b2248b15`.

Retired paths:

- `packages/mission-control-shared/src/components/PixelOfficeCanvas.tsx` and its component tests.
- `packages/mission-control-shared/src/pixel-office/`, including its simulation-only assets and tests.
- `apps/mission-control-next/public/assets/pixel-office/`: the exclusive layout, character, furniture, floor, wall, and scene assets. The complete current-source search found no remaining runtime consumers. Unrelated 3D office assets remain.
- PixelOffice-only sections of the mixed branch-tail test and the obsolete TypeScript exclusion.

Git history at the base revision retains the implementation and assets. The corresponding license records remain as retired provenance in `ASSET_LICENSES.md`. There is no duplicate archive directory. Add-on identifiers, runtime APIs, persisted settings, unrelated assets, and generic add-on tests remain unchanged; this retirement is not an add-on uninstall or a data migration.
