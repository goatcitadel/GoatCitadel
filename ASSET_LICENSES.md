# GoatCitadel Asset Licenses

This file tracks every external visual/audio asset used by GoatCitadel.

Last updated: 2026-10-24

Allowed shipped asset licenses: **CC0 / Public Domain**, **CC BY 4.0**, and **SIL Open Font License 1.1** for bundled fonts only.

Disallowed by default:

- CC BY-SA
- CC BY-NC
- CC BY-ND
- editorial-only or marketplace-only licenses
- site-specific "free" licenses that do not clearly allow public redistribution
- any asset with unclear or unverifiable provenance

Note: Mission Control screenshots in `docs/screenshots/mission-control` are generated project artifacts, not third-party licensed assets.

## Tracking Table

| Asset ID | Type | Runtime Path | Source Asset Path | Source URL | Author | License | License URL | Attribution Required | Exact Attribution Text | Downloaded At (UTC) | Modified | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| central-operator | 3D model | apps/mission-control/public/assets/office/models/central-operator.glb | release bundle: office-source/central-operator/runtime-source-male/ | https://quaternius.itch.io/universal-base-characters | Quaternius | CC0 | https://creativecommons.org/publicdomain/zero/1.0/ | No | n/a | 2026-03-07 | Yes: copied the selected `Superhero_Male_FullBody` source subset into the optional Office source bundle and exported the shipped single-file GLB with embedded textures. | Shipped Office operator model. Source asset is from Universal Base Characters[Standard]; runtime currently uses the body-only male operator variant for the central Goatherder station. |
| goat-subagent | 3D model | apps/mission-control/public/assets/office/models/goat-subagent.glb | release bundle: office-source/goat-subagent/ | https://skfb.ly/osEZ8 | hendrikReyneke | CC BY 4.0 | http://creativecommons.org/licenses/by/4.0/ | Yes | "Goat" (https://skfb.ly/osEZ8) by hendrikReyneke is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/). | 2026-03-06 | Yes: renamed to `goat-subagent.glb`; runtime keeps the embedded-texture GLB only; source provenance now lives in the optional Office source bundle instead of the default repo clone. | Shipped Office goat model. GLB validates as glTF v2 with embedded textures and no animation track. |
| goat-subagent-animated | 3D model | apps/mission-control/public/assets/office/models/goat-subagent-animated.glb | release bundle: office-source/goat-subagent-animated/ | https://skfb.ly/pGW7u | 3D_Tech | CC BY 4.0 | http://creativecommons.org/licenses/by/4.0/ | Yes | "Animated Goat: 2 Texture Variants (Free Asset)" (https://skfb.ly/pGW7u) by 3D_Tech is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/). | 2026-03-07 | Yes: runtime GLB imported as `goat-subagent-animated.glb`; manifest now prefers it ahead of the static fallback goat, and source provenance lives in the optional Office source bundle. | Shipped Office animated goat model. GLB hash `C730D6D84193D10D566064856240CE97D6319D5D98CABEF5800408DADA06BAAA`; JSON chunk reports 4 idle clips (`DeformationSystem|IDLE_01_LOOP`, `DeformationSystem|IDLE_02_LOOP`, `DeformationSystem.001|IDLE_01_LOOP`, `DeformationSystem.001|IDLE_02_LOOP`). |
| office-kit-quaternius-modular-scifi-megakit | 3D model subset | apps/mission-control/public/assets/office/kits/quaternius-modular-scifi-megakit/ | release bundle: office-source/quaternius-modular-scifi-megakit/ | https://quaternius.itch.io/modular-scifi-megakit | Quaternius | CC0 | https://creativecommons.org/publicdomain/zero/1.0/ | No | n/a | 2026-03-07 | Yes: copied the runtime subset into `public/assets/office/kits`; patched shipped glTF image URIs to `../Textures/*`; full source provenance now lives in the optional Office source bundle. | Shipped environment subset for Office V5: `Platform_DarkPlates`, `WallAstra_Straight_Flat`, `WallAstra_Straight_Flat_Window`, `Column_Round`, `Prop_Light_Wide`, `Prop_AccessPoint`, and `Prop_Computer` with only referenced textures. |
| office-kit-quaternius-scifi-essentials | 3D model subset | apps/mission-control/public/assets/office/kits/quaternius-scifi-essentials-kit/ | release bundle: office-source/quaternius-scifi-essentials-kit/ | https://quaternius.itch.io/sci-fi-essentials-kit | Quaternius | CC0 | https://creativecommons.org/publicdomain/zero/1.0/ | No | n/a | 2026-03-07 | Yes: copied only the runtime office subset and supporting textures into `public/assets/office/kits`; full source provenance now lives in the optional Office source bundle. | Shipped furniture subset for Office V5: `Prop_Desk_Medium`, `Prop_Desk_L`, `Prop_Chair`, `Prop_Locker`, `Prop_Shelves_WideTall`, `Prop_Crate_Large`, and `Prop_Mug`. |
| rajdhani-display-font | Font | apps/mission-control/public/fonts/rajdhani/ | assets/source/fonts/rajdhani/ | https://github.com/google/fonts/tree/main/ofl/rajdhani | Indian Type Foundry | SIL Open Font License 1.1 | https://openfontlicense.org/open-font-license-official-text/ | No | n/a | 2026-03-07 | Yes: bundled local latin-only `woff2` subset for weights 500, 600, and 700; runtime no longer fetches Google Fonts at load time. | Shipped Mission Control display font for headings, tactical labels, and KPI numerals. Full license text stored in `assets/source/fonts/rajdhani/OFL.txt`. |
| noto-sans-regular-pdf-fallback | Font | packages/policy-engine/fonts/NotoSans-Regular.ttf | packages/policy-engine/fonts/NotoSans-Regular.ttf | https://github.com/notofonts/notofonts.github.io/blob/42af67ccd12bc0e31ed85384bf73e39248265374/fonts/NotoSans/unhinted/ttf/NotoSans-Regular.ttf | The Noto Project Authors | SIL Open Font License 1.1 | https://openfontlicense.org/open-font-license-official-text/ | No | n/a | 2026-10-24 | No: byte-identical to the upstream file at commit `42af67ccd12bc0e31ed85384bf73e39248265374`; SHA-256 `f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8`. | Server-rendered PDF fallback for Latin Extended, Greek, and Cyrillic letters Helvetica lacks; each PDF embeds only the glyphs it uses. Full license text stored in `packages/policy-engine/fonts/OFL.txt` (upstream `fonts/LICENSE`, SHA-256 `f2095b08bed08b23a6fe26112fcd679a2bee3f002eef077eb05d215ed1051bd8`). |
| noto-sans-bold-pdf-fallback | Font | packages/policy-engine/fonts/NotoSans-Bold.ttf | packages/policy-engine/fonts/NotoSans-Bold.ttf | https://github.com/notofonts/notofonts.github.io/blob/42af67ccd12bc0e31ed85384bf73e39248265374/fonts/NotoSans/unhinted/ttf/NotoSans-Bold.ttf | The Noto Project Authors | SIL Open Font License 1.1 | https://openfontlicense.org/open-font-license-official-text/ | No | n/a | 2026-10-24 | No: byte-identical to the upstream file at commit `42af67ccd12bc0e31ed85384bf73e39248265374`; SHA-256 `87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9`. | Bold weight of the PDF fallback above. Full license text stored in `packages/policy-engine/fonts/OFL.txt` (upstream `fonts/LICENSE`, SHA-256 `f2095b08bed08b23a6fe26112fcd679a2bee3f002eef077eb05d215ed1051bd8`). |
| noto-sans-symbols2-pdf-fallback | Font | packages/policy-engine/fonts/NotoSansSymbols2-Regular.ttf | packages/policy-engine/fonts/NotoSansSymbols2-Regular.ttf | https://github.com/notofonts/notofonts.github.io/blob/42af67ccd12bc0e31ed85384bf73e39248265374/fonts/NotoSansSymbols2/unhinted/ttf/NotoSansSymbols2-Regular.ttf | The Noto Project Authors | SIL Open Font License 1.1 | https://openfontlicense.org/open-font-license-official-text/ | No | n/a | 2026-10-24 | No: byte-identical to the upstream file at commit `42af67ccd12bc0e31ed85384bf73e39248265374`; SHA-256 `c4a0a80f0041ce4be81e2478faad22776d23edb98ae3f0d19bd37044820ecf9d`. | Server-rendered PDF fallback for symbols such as ballot boxes and check marks; each PDF embeds only the glyphs it uses. Full license text stored in `packages/policy-engine/fonts/OFL.txt` (upstream `fonts/LICENSE`, SHA-256 `f2095b08bed08b23a6fe26112fcd679a2bee3f002eef077eb05d215ed1051bd8`). |
| pixel-office-jik-characters | 2D sprite sheet subset | Retired; see docs/ARCHIVED_PIXEL_OFFICE_UI.md | release bundle: pixel-office/characters/ (retired; not shipped) | https://jik-a-4.itch.io/metrocity-free-top-down-character-pack | JIK-A-4 | CC0 | https://creativecommons.org/publicdomain/zero/1.0/ | No | n/a | 2026-03-15 | Yes: copied the six runtime character sprite sheets used by the Mission Control Pixel Office overlay layer. | Pixel character sheets used for the Pixel Office agent overlay. The source page lists Creative Commons Zero v1.0 Universal. |
| pixel-office-jik-furniture | 2D furniture subset | Retired; see docs/ARCHIVED_PIXEL_OFFICE_UI.md | release bundle: pixel-office/furniture/ (retired; not shipped) | https://jik-a-4.itch.io/metrocity | JIK-A-4 | CC0 | https://creativecommons.org/publicdomain/zero/1.0/ | No | n/a | 2026-03-15 | Yes: copied the runtime furniture subset used to compose the first multi-room Mission Control building. | Pixel Office furniture set used for desks, shelves, plants, lounge furniture, paintings, and support props. |
| pixel-office-jik-floor-wall-tiles | 2D tile subset | Retired; see docs/ARCHIVED_PIXEL_OFFICE_UI.md | release bundle: pixel-office/floor-wall-tiles/ (retired; not shipped) | https://jik-a-4.itch.io/metrocity | JIK-A-4 | CC0 | https://creativecommons.org/publicdomain/zero/1.0/ | No | n/a | 2026-03-15 | Yes: copied the runtime floor and wall tile subset for future building composition work. | Pixel Office tile subset reserved for multi-room building composition and future district work. |
| pixel-office-jik-interior-pack | 2D sprite reference | Retired; see docs/ARCHIVED_PIXEL_OFFICE_UI.md | release bundle: pixel-office/reference-scene/ (retired; not shipped) | https://jik-a-4.itch.io/metrocity-interior-asset-pack | JIK-A-4 | CC0 | https://creativecommons.org/publicdomain/zero/1.0/ | No | n/a | 2026-03-15 | Yes: used as the verified source pack for the office furniture and room styling referenced by the Pixel Office adaptation. | JIK-A-4 office/interior sprite source verified as CC0 before adapting the Pixel Office tab. |
| pixel-office-jik-top-down-interiors | 2D sprite reference | Retired; see docs/ARCHIVED_PIXEL_OFFICE_UI.md | release bundle: pixel-office/reference-scene/ (retired; not shipped) | https://jik-a-4.itch.io/metrocity-top-down-interiors | JIK-A-4 | CC0 | https://creativecommons.org/publicdomain/zero/1.0/ | No | n/a | 2026-03-15 | Yes: used as the verified source pack for the scene layout style referenced by the Pixel Office adaptation. | JIK-A-4 environment/interior source verified as CC0 before adapting the Pixel Office tab. |

## Office Asset Source Targets

Tier 1: preferred because the licensing is clearly compatible with repo redistribution.

1. Quaternius  
   Character and environment packs with CC0 licensing on the pack pages. Best current goatherder targets:
   - Universal Base Characters
   - Ultimate Modular Men Pack
2. Kenney  
   CC0 packs with broad prop and environment coverage.
3. Poly Haven  
   CC0 HDRIs, textures, and models.
4. ambientCG  
   CC0 textures, HDRIs, and models.

Tier 2: allowed only when the individual asset explicitly matches the repo policy and attribution burden is acceptable.

5. Sketchfab  
   Only use assets explicitly licensed under CC BY 4.0 or CC0, and record full attribution before shipping.
6. Poly Pizza  
   Mixed-license catalog. Use only after verifying that the exact asset is CC0 and not a different Creative Commons variant.

## Verification Rules

1. Do not ship an asset unless its license is explicitly CC0/Public Domain or CC BY 4.0. Bundled fonts may additionally use SIL Open Font License 1.1 when the full license text ships alongside the font files.
2. Every CC BY asset must record creator, source URL, license URL, exact attribution text, modification notes, and download date before commit.
3. If any asset license, source, or provenance is unclear, do not ship it.
4. Procedural fallback meshes must remain available to avoid license lock-in.
5. Keep raw archives and extracted source files outside `public/`; only runtime-needed files belong in the shipped asset tree.

## Current Shipped Attribution-Required Assets

1. `goat-subagent`
   - Attribution: "Goat" (https://skfb.ly/osEZ8) by hendrikReyneke is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/).
   - Source page: https://sketchfab.com/3d-models/goat-2624ac2ce2364930ba2d5f70eb7aa1ea#download

2. `goat-subagent-animated`
   - Attribution: "Animated Goat: 2 Texture Variants (Free Asset)" (https://skfb.ly/pGW7u) by 3D_Tech is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/).
   - Runtime path: `apps/mission-control/public/assets/office/models/goat-subagent-animated.glb`
   - Verified on March 7, 2026 with 4 embedded idle clips.
