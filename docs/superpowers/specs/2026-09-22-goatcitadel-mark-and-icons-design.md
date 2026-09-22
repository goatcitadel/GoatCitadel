# GoatCitadel mark and icon pipeline — design

Date: 2026-09-22
Status: approved (design), pending spec review

## Problem

The only brand source is a detailed raster lockup
(`apps/mission-control-next/public/brand/source/goatcitadel-logo-source.png`).
Every icon is a crop of it, so at 16–32 px it is an unreadable smudge. Several
surfaces have no GoatCitadel icon at all:

| Surface | Today |
| --- | --- |
| Web favicons / apple-touch | Crops of the raster lockup |
| WinUI exe, desktop + Start-menu shortcut | No `<ApplicationIcon>` → default exe icon (installer shortcuts point at the exe) |
| WinUI MSIX identity tiles | `Package.appxmanifest` references `Assets\*.png` that do not exist |
| WinUI tray | `SystemIcons.Application` (`apps/mission-control-windows/Services/TrayService.cs`) |
| Tauri tray | `TrayIconBuilder` never calls `.icon()` (`apps/mission-control-desktop/src-tauri/src/main.rs`) |
| Tauri / macOS bundle | Only `icon.png` + `icon.ico` crops; no `.icns` |

## Decision

A new flat vector mark, **"horned citadel"**: a crenellated tower whose corner
merlons sprout tapered goat horns, two slit windows read as goat eyes, arched
gate with an ice-blue node dot, accent base line, on a navy rounded tile. The
existing raster lockup stays for README/splash use.

Palette (from the existing identity):

| Token | Hex | Use |
| --- | --- | --- |
| navy | `#0e1a27` | tile, cut-outs |
| ice | `#cfe0ee` | horns, tower |
| ice-shade | `#8fb3cc` | parapet band |
| accent | `#6fb6e0` | gate node, base line |
| tray-ice | `#e6f0f8` | brighter fill for the tray variant |

## Sources of truth

Two hand-authored SVGs in `apps/mission-control-next/public/brand/source/`,
`viewBox="0 0 100 100"`:

- `goatcitadel-mark.svg` — full-detail mark (app icon, favicons, tiles).
- `goatcitadel-mark-tray.svg` — heavier variant for ≤24 px: thicker horns and
  merlons, wider gate, no ridges/eyes/dot, keeps the navy tile so it reads on
  light and dark taskbars.

Both are drawn exactly as previewed and approved on 2026-09-22 (geometry is the
approved preview; the implementation plan carries the literal SVG).

## Pipeline

Extend `pnpm brand:derive` (`scripts/brand/derive-assets.mjs`); no new
dependencies (`sharp` is a root devDependency, `@tauri-apps/cli` is in
`apps/mission-control-desktop`).

1. **Web** (`sharp`, from `goatcitadel-mark.svg`): `goatcitadel-mark.png` 512,
   `apple-touch-icon.png` 180, `favicon-32x32.png`, `favicon-16x16.png` (16/32
   from the tray SVG — it is the legible one at that size), plus
   `favicon.svg`. Lockup/wordmark continue to derive from the raster source.
2. **Tauri** (`tauri icon <mark.svg> -o src-tauri/icons`): `icon.ico`,
   `icon.icns`, sized PNGs. Remove platform outputs we don't ship (Android/iOS)
   so the tracked set stays small.
3. **WinUI** (`sharp` + in-script ICO writer — ICO with embedded PNG entries):
   `apps/mission-control-windows/Assets/` → `Square44x44Logo.png`,
   `Square150x150Logo.png`, `StoreLogo.png` (50), `app.ico` (16/24/32/48/256,
   16/24 from the tray SVG), `tray.ico` (16/20/24/32 from the tray SVG).
4. **Tauri tray**: `src-tauri/icons/tray.png` (32, from the tray SVG).
5. Rewrite `asset-manifest.json` with every output. Output must be
   deterministic (no timestamps inside images; manifest `generatedAt` is the
   only volatile field).

## Wiring

- WinUI csproj: `<ApplicationIcon>Assets\app.ico</ApplicationIcon>`; include
  `Assets\*.png` as `Content` (copy to output) and `Assets\tray.ico` as
  `EmbeddedResource`.
- `TrayService`: load `tray.ico` from the embedded resource; on any failure
  fall back to `SystemIcons.Application` and log the reason (never throw from
  tray init).
- Tauri `main.rs`: `.icon(...)` on `TrayIconBuilder` using the bundled
  `tray.png` (`include_bytes!` + `Image::from_bytes`), falling back to
  `app.default_window_icon()`.
- Tauri `tauri.conf.json` / `renderMacTauriConfig`: `bundle.icon` lists
  `icons/icon.icns`, `icons/icon.ico`, `icons/icon.png`.
- Web `index.html`: add `<link rel="icon" type="image/svg+xml" href="/brand/favicon.svg">`
  ahead of the PNG links.
- Installer (`build-windows-native-installer.mjs`): no change — shortcuts and
  `UninstallDisplayIcon` already resolve to the exe, which now carries the icon.

## Verification

- `pnpm brand:derive` twice → no diff in image outputs.
- `scripts/check-mission-control-next-icon-sizing.mjs` still passes.
- WinUI `dotnet build` succeeds; exe icon extracted and inspected.
- `cargo check` for the Tauri crate.
- `verify:repo:hygiene` (run from PowerShell) — new binary assets and docs
  must not trip hygiene rules.
- If the mark appears in mc-next chrome, visual baselines change: regenerate via
  the Linux rebaseline workflow, never locally.

## Out of scope

Redesigning the lockup/wordmark, splash screens, marketing assets, mobile
(Android/iOS) icon sets.
