# Upstream provenance: impeccable

- Repository: https://github.com/pbakaus/impeccable
- Commit: `4f956490f0056ae1ff5ea80372cf56e83c001d3c`
- License: Apache-2.0 (see `LICENSE`; attribution and modification statement in `NOTICE`)
- Sync: `node scripts/sync-impeccable.mjs --source <local upstream checkout> --sha <commit>`; the script never downloads or executes upstream code, and running it again at the same commit reproduces these bytes exactly.

## Vendored files

| Vendored path | Upstream path | Upstream sha256 (LF-normalized) | Vendored sha256 | Notes |
| --- | --- | --- | --- | --- |
| SKILL.md | skill/SKILL.src.md | a2c627ba2fbfb0697921ff663b9ea9dbff6584e0fb23977a7185026d07131264 | 2f0276fa61e5596bd6bf695507ab8d5d635a4271d4ca21d50794345d4d6def45 | transformed |
| LICENSE | LICENSE | 02bb8c3b4e70190e3986c0404ad2fd8d639b4f534252d82379cc1b502b6d1812 | 02bb8c3b4e70190e3986c0404ad2fd8d639b4f534252d82379cc1b502b6d1812 | copied |
| reference/craft-floor.md | skill/reference/craft-floor.md | 086e731940b72db13d9693b575db377a7b102729a56da5c79a21461635695c87 | 086e731940b72db13d9693b575db377a7b102729a56da5c79a21461635695c87 | transformed |
| reference/mode-persuade.md | skill/reference/mode-persuade.md | b3f8b39cbf89392b62c07298361fb2a7e8e0b4ef13bbb38bac974ccd8fd835fd | 7370702a7f1dcf503cb8ec352d920178259c6b6086e8af5359189e0218818143 | transformed |
| reference/mode-operate.md | skill/reference/mode-operate.md | 7a52dd7a94ee75f6ae89542c86a1b6e1d306812b16e0d9dbf12d4acad44d148b | 2d4929fd231498de39eb916ddb085d20bbf457ecad232ffc141ae064e16f9a8d | transformed |
| reference/mode-read.md | skill/reference/mode-read.md | a569989e6a3d6453b4c45e9474e162a15cc54e11732ac6baa7990a6e7cccc0b5 | 3d2cdabab23429238bb2798524eb09948a7900ba095f421a9e51fffb943ff15d | transformed |
| reference/operate.md | skill/reference/operate.md | e5bf4980c547e60b091f82f38d0eec4cc3ab85610b4b15ec8f1d86584f9eb404 | e5bf4980c547e60b091f82f38d0eec4cc3ab85610b4b15ec8f1d86584f9eb404 | transformed |
| reference/shape.md | skill/reference/shape.md | a55f016c046cb6a27c55bd7f346375aeb506a755c4fbca19a5f92dbd42309c23 | 0a42c81110e13c5ea81304b06ab51849d864717d100a4a56b3d8cf50ebdd0828 | transformed |
| reference/init.md | skill/reference/init.md | 72a41672b391085738ded0ab3cf8235866dab15fc931f9e2b43c914c3ece915f | 3d163965c18faad40e3d3a79fbd73e7bb5284d63ccf9eecf796239c69f292a2e | transformed |
| reference/document.md | skill/reference/document.md | f3d7d23d24affdc29fe38f3bcd9770f1304a959a7d49bffe8faaa2a4c2eb6647 | 1ebe66af64b77927e076bdeacbc6e323239af10867c59bf14544ab1be347b791 | transformed |
| reference/extract.md | skill/reference/extract.md | f6233909448bf18885e8cbad61e2c4713c3352d002875a891abda2672b4f0e00 | c384e25691b44252705fef4658dc803a91483ac35805c5647af2b62910921676 | transformed |
| reference/critique.md | skill/reference/critique.md | f2ece6380e378ab644d0508adf10e213eb2d6e241e3d7339727fb8e61cd2d39b | f91cfb498a406560e321845e9b0cc74afac5fe5ba095d50c08dde2ddafae4454 | transformed; split index (1 parts) |
| reference/critique/01-reference-material.md | skill/reference/critique.md | f2ece6380e378ab644d0508adf10e213eb2d6e241e3d7339727fb8e61cd2d39b | c199b1eb8a466eaac4381f28c1f42cf5483e2fa1ec615ef8e3392c8dfb1c9143 | transformed; part 1 of 1 |
| reference/audit.md | skill/reference/audit.md | 6f2850794a8e74fd07ab9410104f99e3f20dee5490d5e82c98880852203341d0 | ee4efdb60182de404acca96e1588f3c153ffbd03e5a4f6a9622874e40a742e81 | transformed |
| reference/polish.md | skill/reference/polish.md | c504e12ea076fd1a57b8c9ece79fbb532c54226b2b6298c5c62fa889ae1dd34d | bca5507ae00574b1d12c010af4695538089a595e79ae942a3062b97cd7ffb4f0 | transformed |
| reference/bolder.md | skill/reference/bolder.md | a4e4d986f74ef5f3c8218dfcfd5b04fe103b47182cf1e16aeb979e5703d5cd87 | d5f4e2ac2b4572a01f3b8496ae866edc8957e8da1766cc7710f1a76c57a41ef4 | transformed |
| reference/quieter.md | skill/reference/quieter.md | c4755f41462f3534195912b64333df94dbdd0f54b8f2da1c9ef69ce94d974896 | ca6383c6a26d74ec012db460b7bc9a3aeafaf6e7fb19746f4171fccbe8ab67a6 | transformed |
| reference/distill.md | skill/reference/distill.md | 54be6eca781b8e2d0f7e850277b330cade905ee4df4d9986519aac27538af724 | 7e90a6250c74e2c4e5472f3c4b48ee40081bf778fe1be46bc2cf1bacedf6d520 | transformed |
| reference/harden.md | skill/reference/harden.md | fb00cb42a9cb17d717aefabc418bd4dcb1be540d95d8498d8e3bd4e3e0b2a0a3 | 8f73c3f483beb43f35f6e5d77ca98ab753f8bbd1ccfea7fe3ab485ea1724e77f | transformed |
| reference/onboard.md | skill/reference/onboard.md | 7c8ef99e2671d121455f40179cf29aa5f8f029118cb1d97ce61b7d20a193b709 | f9b250f4a606507f74d7d45e51e2b3234033acf88ee9ca683d35ae5b3d8d106f | transformed |
| reference/animate.md | skill/reference/animate.md | 59f38d50c799aa47ecd7288c69dce0245d8c3e3e2368b29499d583996b5030b3 | 011aad2e312dc0109a85f2e3d5b77f3dd7e14ff0ff8d8a824d4ba9b5658dc5e3 | transformed |
| reference/colorize.md | skill/reference/colorize.md | dcc0c3ebb76bd22c543f45d73c283e3890e5b8a44eb5053ca2f7fdd425635c32 | 19c5beb179f2024be11e56c1248c7e8bd62a98cc6ceee0a132c470befbadf9f4 | transformed |
| reference/typeset.md | skill/reference/typeset.md | 925720c1d610d2a08a6811001303f395e4b2c971ef3d2506fbce43b2a1303152 | 44d2ef50f96740e522e377b6f6101885f8cafc6e82136e5816d151d575e3ca38 | transformed |
| reference/layout.md | skill/reference/layout.md | 14ba132b6168bf0a7498f8c3fbbb41b73ff704da5dc3688fd842807446e54a05 | 0999e55d337121baaff9d074254e3c7f81e5d50169bdab31591487b7b14408af | transformed |
| reference/delight.md | skill/reference/delight.md | 8f157ae861c578d54b2710ea200a6ba2253bd36ab68b6b4c4b880875bd0a415b | 26f5c75b486928bdaf90dcecc2fdae520c9988c53bccea485a17fa551815208e | transformed |
| reference/overdrive.md | skill/reference/overdrive.md | 968c5374ab60080568b11fa53bb82a64b1b59a7ba6a51b3945bcbb03101d2924 | 497f6e6df375fa4d64f8f511022fabad2cdd10027f052fdb56fcf5b90c45a7c4 | transformed |
| reference/clarify.md | skill/reference/clarify.md | 4738e125835bd6c166aec2622977c9bc59bada52aaeb186585ed38b3900860b5 | 346f0e4a90089d253a0d5fef51d1b3f5b5071610700da4c49eeb6f7835028033 | transformed |
| reference/adapt.md | skill/reference/adapt.md | 004b339416187222206adee5ff08ef1fa9bc346d4ceba2932f770d640449ec6d | b180103e1ad91e8aea3daeb384a3f66359292e105b8c7dd4b97d6fe715921af0 | transformed |
| reference/optimize.md | skill/reference/optimize.md | 66e1142b606a2df263bf76774adcf1d007566fa8d220e0387affb7ee396eaec7 | 590e7d198c68c4b69ba09c24d46604955fc3b2d5fa5d6a88416933cf133e287f | transformed |

## Excluded upstream files

- skill/reference/new-work.md: launcher-driven (concept-seed rolls, surface-brief, build-phase gates)
- skill/reference/component-review.md: launcher-driven (component-review, comp-spec)
- skill/reference/visualize.md: launcher-driven comp pipeline that needs image generation and build-phase state
- skill/reference/routing.md: menu built from launcher context output; SKILL.md carries an inline no-argument rule instead
- skill/reference/region-map.md: launcher-driven (comp-spec)
- skill/reference/generate.md: live browser variant mode
- skill/reference/live.md: live browser mode
- skill/reference/live-setup.md: live browser mode
- skill/reference/hooks.md: design detector hook installer; also documents provider folders GoatCitadel does not ship
- skill/reference/doctor.md: launcher drift repair
- skill/reference/craft.md: deprecated alias of ordinary new-work
- skill/reference/ios.md: native platform reference
- skill/reference/android.md: native platform reference
- skill/reference/audit.native.md: native platform reference
- skill/reference/adapt.native.md: native platform reference
- skill/agents/*: every agents/* prompt depends on the build-phase pipeline (.impeccable/review, .impeccable/build); GoatCitadel cannot run them
- skill/scripts/*, launcher binaries, hooks, live-browser bundles: GoatCitadel runs no external design runtime

## Transforms applied

- SKILL.md frontmatter keeps name and description; argument-hint, user-invocable, allowed-tools, and license are dropped; metadata (version, tags, keywords) is added; the description no longer claims native iOS or Android screens.
- new-work (the upstream visual-world workshop) is not vendored: SKILL.md, init.md, document.md, shape.md, and bolder.md sentences that routed through it now ask the operator (user_input.request) to choose and commit the visual world in DESIGN.md; remaining links to it are marked as not vendored.
- document.md: sentences that pointed at the removed design.json sidecar now point at DESIGN.md prose and the schemaVersion paragraph is removed; any other surviving sidecar mention fails the guard so a re-sync must add a rewrite rather than ship it.
- An Apache License 2.0 section 4(b) modification notice follows the SKILL.md frontmatter.
- The SKILL.md Setup section is replaced: no launcher runs; context comes from the workspace PRODUCT.md and DESIGN.md.
- SKILL.md routing: inline no-argument rule, workflow-questions bullet removed, launcher context clauses rewritten, deprecated craft alias removed.
- SKILL.md Commands table: craft, live, and generate rows removed; native-platform suffixes removed; an availability note added.
- Pin, Hooks, Doctor, drift-repair, and post-init launcher paragraphs removed.
- Mode references: the concept-seed clause becomes plain prose.
- init.md: the PRODUCT.md path sentence points at the workspace context and the live-mode workflow-defaults step is removed; polish.md: the launcher context sentence is rewritten; audit.md: the bundled-detector sentence points at runtime design advisories; document.md: the sidecar mention in the seed-mode wrap-up is removed.
- document.md: the .impeccable/design.json sidecar section is removed.
- Sections about live mode are removed at any heading level.
- Fenced code blocks that only invoke the launcher are removed together with a lead-in line ending in a colon; any other line invoking the launcher, a launcher artifact such as snapshot_file, an .impeccable/ path, a native-platform reference, or an unavailable command (live, generate, craft) is removed.
- critique.md: Codex-only harness blocks (<codex>…</codex>) are removed; the launcher slug and ignore-list steps, the detector and browser-overlay evidence, the sub-agent gate, and the snapshot-persistence section are removed or rewritten so the critique runs as a single-context routed turn over GoatCitadel's render evidence (attached offline PNG snapshots plus runtime design advisories).
- Placeholders: {{command_prefix}} becomes `@skill impeccable`, upstream `/impeccable <command>` syntax becomes `@skill impeccable <command>`, {{ask_instruction}} becomes the user_input.request phrasing, {{available_commands}} becomes the vendored command list.
- Links to references that are not vendored become plain text marked as not vendored.
- Line endings normalized to LF, trailing whitespace trimmed, runs of blank lines collapsed, single trailing newline.
- References over 20 KiB are split by H2 heading into reference/<name>/NN-<slug>.md with reference/<name>.md as the index.

## GoatCitadel-authored files (not upstream)

- reference/artifacts.md
