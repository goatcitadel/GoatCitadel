# Upstream provenance: impeccable

- Repository: https://github.com/pbakaus/impeccable
- Commit: `c63b8dd7dd5a5f3c32eaabe1af76d0694f863ed2`
- License: Apache-2.0 (see `LICENSE`; attribution and modification statement in `NOTICE`)
- Sync: `node scripts/sync-impeccable.mjs --source <local upstream checkout> --sha <commit>`; the script never downloads or executes upstream code, and running it again at the same commit reproduces these bytes exactly.

## Vendored files

| Vendored path | Upstream path | Upstream sha256 (LF-normalized) | Vendored sha256 | Notes |
| --- | --- | --- | --- | --- |
| SKILL.md | skill/SKILL.src.md | 78573ef57390d37ece0366e2746b1dda6a20e2a74352a0abc2e6d05518e87d47 | d39e26f5d96eccefcc9e093c3141be1440de616fe931cf69e8b43ddf05af577f | transformed |
| LICENSE | LICENSE | 02bb8c3b4e70190e3986c0404ad2fd8d639b4f534252d82379cc1b502b6d1812 | 02bb8c3b4e70190e3986c0404ad2fd8d639b4f534252d82379cc1b502b6d1812 | copied |
| reference/craft-floor.md | skill/reference/craft-floor.md | db4dfe2f0b316a94026b89e8cb3c9026042e661ca156dfae747a733e1ab500ed | db4dfe2f0b316a94026b89e8cb3c9026042e661ca156dfae747a733e1ab500ed | transformed |
| reference/mode-persuade.md | skill/reference/mode-persuade.md | b3f8b39cbf89392b62c07298361fb2a7e8e0b4ef13bbb38bac974ccd8fd835fd | 7370702a7f1dcf503cb8ec352d920178259c6b6086e8af5359189e0218818143 | transformed |
| reference/mode-operate.md | skill/reference/mode-operate.md | 7a52dd7a94ee75f6ae89542c86a1b6e1d306812b16e0d9dbf12d4acad44d148b | 2d4929fd231498de39eb916ddb085d20bbf457ecad232ffc141ae064e16f9a8d | transformed |
| reference/mode-read.md | skill/reference/mode-read.md | a569989e6a3d6453b4c45e9474e162a15cc54e11732ac6baa7990a6e7cccc0b5 | 3d2cdabab23429238bb2798524eb09948a7900ba095f421a9e51fffb943ff15d | transformed |
| reference/operate.md | skill/reference/operate.md | e5bf4980c547e60b091f82f38d0eec4cc3ab85610b4b15ec8f1d86584f9eb404 | e5bf4980c547e60b091f82f38d0eec4cc3ab85610b4b15ec8f1d86584f9eb404 | transformed |
| reference/shape.md | skill/reference/shape.md | a55f016c046cb6a27c55bd7f346375aeb506a755c4fbca19a5f92dbd42309c23 | 0a42c81110e13c5ea81304b06ab51849d864717d100a4a56b3d8cf50ebdd0828 | transformed |
| reference/init.md | skill/reference/init.md | 72a41672b391085738ded0ab3cf8235866dab15fc931f9e2b43c914c3ece915f | 3d163965c18faad40e3d3a79fbd73e7bb5284d63ccf9eecf796239c69f292a2e | transformed |
| reference/document.md | skill/reference/document.md | aca6d5ea0770131b8f97a3feb68e1bd3cc536b1ef2e7d05bb0c2c1c9c96c68d3 | df7aaf57b4e31c2d55f140bddaf70430698fe9b56afffb63fcf62af8dddff661 | transformed |
| reference/extract.md | skill/reference/extract.md | da8a999c4b16fee5ddd2f532a74ffab50ef26085311eeb6461689acb8e22c5ea | e6396675e16a05972e8999bbe49891a7ebc06e4bb004b17bd282bd89bfeb8bda | transformed |
| reference/critique.md | skill/reference/critique.md | 8d2cdf4f583a0caf7685620069069354b4fb81582fb63c349783298454140a0e | 440ca34da8f676474bcd252098c7f29dd2fab59884b051cebf6f54c5ad6da64b | transformed; split index (1 parts) |
| reference/critique/01-reference-material.md | skill/reference/critique.md | 8d2cdf4f583a0caf7685620069069354b4fb81582fb63c349783298454140a0e | c199b1eb8a466eaac4381f28c1f42cf5483e2fa1ec615ef8e3392c8dfb1c9143 | transformed; part 1 of 1 |
| reference/audit.md | skill/reference/audit.md | d2aa90f30ba7a0082d242ab69a2a9d46298abb5f36b43308fe7e3c36fa9a9056 | 2c6c2a3e1753cc96aa291525f361722baaa12a03e2407291621a9a8846d54e46 | transformed |
| reference/polish.md | skill/reference/polish.md | c504e12ea076fd1a57b8c9ece79fbb532c54226b2b6298c5c62fa889ae1dd34d | bca5507ae00574b1d12c010af4695538089a595e79ae942a3062b97cd7ffb4f0 | transformed |
| reference/bolder.md | skill/reference/bolder.md | a4e4d986f74ef5f3c8218dfcfd5b04fe103b47182cf1e16aeb979e5703d5cd87 | d5f4e2ac2b4572a01f3b8496ae866edc8957e8da1766cc7710f1a76c57a41ef4 | transformed |
| reference/quieter.md | skill/reference/quieter.md | daf4438c4cdfba62d8e663567f6a23cc3f6471ba5dea67994aa6b312e8f7d721 | 4fcdfcc6d6ca52b282211f7a33d17dd2ed21ce9583164417a8d1b160be64e2d1 | transformed |
| reference/distill.md | skill/reference/distill.md | 048e5a7671024592cba6cd4ede70b6c535db0c1be84d6837638e40f51fb3fad7 | cfc16403553b7af1232eae9f96f32c172e62f134a987d44d8dc15b5f31f9fced | transformed |
| reference/harden.md | skill/reference/harden.md | 6674a6fc1eb681f2ad266dc0a3a71cec29dc4dcd3a1ff91195d2302582fa7c58 | ce2aeda37a500e3db2495b616e582595898d9a29aacd3eddbe1efca01d2810ee | transformed |
| reference/onboard.md | skill/reference/onboard.md | 0d871444769f48a86db68b8b480bb6bfa61bef42d3784e65c248d7e5a555a085 | c2d141fe962160d8a9c653fd7759c0b13737feed599924f5c167a28a1b3a4d51 | transformed |
| reference/animate.md | skill/reference/animate.md | 59f38d50c799aa47ecd7288c69dce0245d8c3e3e2368b29499d583996b5030b3 | 011aad2e312dc0109a85f2e3d5b77f3dd7e14ff0ff8d8a824d4ba9b5658dc5e3 | transformed |
| reference/colorize.md | skill/reference/colorize.md | dcc0c3ebb76bd22c543f45d73c283e3890e5b8a44eb5053ca2f7fdd425635c32 | 19c5beb179f2024be11e56c1248c7e8bd62a98cc6ceee0a132c470befbadf9f4 | transformed |
| reference/typeset.md | skill/reference/typeset.md | bf0259f5b8363d09591885ca6b27ac97bbdf754c130fb2799b949d783a97186b | 0d375f1ca3f2044bd49b86851d0aa1f5c91ad4abd5a38a9e95a33fec5c466da8 | transformed |
| reference/layout.md | skill/reference/layout.md | 14ba132b6168bf0a7498f8c3fbbb41b73ff704da5dc3688fd842807446e54a05 | 0999e55d337121baaff9d074254e3c7f81e5d50169bdab31591487b7b14408af | transformed |
| reference/delight.md | skill/reference/delight.md | 8f157ae861c578d54b2710ea200a6ba2253bd36ab68b6b4c4b880875bd0a415b | 26f5c75b486928bdaf90dcecc2fdae520c9988c53bccea485a17fa551815208e | transformed |
| reference/overdrive.md | skill/reference/overdrive.md | 0b6612c02d6fb7f737b9110f019c3e5548656f0ea7526353d062d3b107d61300 | 80b9333fa3404093b7beb18e7b842ebc224ff4c8eebd38d2b5ac1f6e860ae633 | transformed |
| reference/clarify.md | skill/reference/clarify.md | 4738e125835bd6c166aec2622977c9bc59bada52aaeb186585ed38b3900860b5 | 346f0e4a90089d253a0d5fef51d1b3f5b5071610700da4c49eeb6f7835028033 | transformed |
| reference/adapt.md | skill/reference/adapt.md | fe0f1e0a642575737711ad93f22482b8469c021ffd587f94910893683cb8f316 | fb10aed8c4fec6bf8c31a234d50133896d08987e3953b7706a0f393c072b2cde | transformed |
| reference/optimize.md | skill/reference/optimize.md | 197aa00aba42c85edf4cea25c4b79f4e12f2425454f6cd307f3d1fddfbd11ffd | a807f826d10cff5d3d5b192329b45972b1ba4f9454845ac7481927c77bdce2e8 | transformed |

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

- SKILL.md frontmatter keeps name and description; argument-hint, user-invocable, allowed-tools, and license are dropped; metadata (version, tags, keywords) is added; the description no longer claims live browser iteration.
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
