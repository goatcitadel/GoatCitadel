#!/usr/bin/env bash
# Stages one fast lane job's output for upload as a single artifact.
#
# A sharded lane has to carry two things between jobs: the partial verification
# manifest (so merge-fast-manifests.mjs can recompose the run) and the coverage
# reports the slice produced (so the gate can aggregate them without re-running the
# suites). Both are collected under one directory and scanned for secrets before
# they leave the runner, because publishing raw verification output as a build
# artifact is exactly the thing verify:artifacts:redaction exists to prevent.
set -euo pipefail

out="${1:-part}"
rm -rf "$out"
mkdir -p "$out"

# Stage only the run this job produced. A workspace can hold older runs, and
# sweeping them in would both bloat the artifact and hand the merge manifests from
# a different lane.
run_dir="$(node -e "
  try {
    const pointer = require('./artifacts/verification/latest-run.json');
    process.stdout.write(pointer.artifactRoot ?? '');
  } catch {
    process.stdout.write('');
  }
")"
if [ -n "$run_dir" ] && [ -d "$run_dir" ]; then
  mkdir -p "$out/artifacts/verification"
  cp -r "$run_dir" "$out/artifacts/verification/"
fi

# apps/<pkg>/coverage*/coverage-final.json and the packages/ equivalent. The depth
# bound keeps the scan off node_modules trees.
while IFS= read -r report; do
  mkdir -p "$out/coverage/$(dirname "$report")"
  cp "$report" "$out/coverage/$report"
done < <(find apps packages -maxdepth 3 -type f -path '*/coverage*/coverage-final.json' 2>/dev/null || true)

node scripts/verify-artifact-redaction.mjs "$out"

find "$out" -type f | sort
