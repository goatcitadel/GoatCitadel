#!/usr/bin/env bash
# Opens a PR with refreshed Mission Control Next visual baselines.
# Invoked by .github/workflows/visual-rebaseline.yml after the rebaseline lane
# regenerates the PNGs. Kept as a script so the workflow YAML stays free of the
# long git/gh lines that the repo's Prettier config would line-wrap (which would
# corrupt the YAML block scalar).
set -euo pipefail

baseline_dir="scripts/verification/baselines/visual"

if git diff --quiet -- "$baseline_dir"; then
  echo "No baseline changes produced; nothing to do."
  exit 0
fi

branch="chore/visual-rebaseline-${GITHUB_RUN_ID:-manual}"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git checkout -b "$branch"
git add "$baseline_dir"
git commit -m "chore(verification): refresh mc-next visual baselines"
git push origin "$branch"

title="chore(verification): refresh visual baselines (mc-next)"
body="Automated rebaseline run ${GITHUB_RUN_ID:-manual} on the Ubuntu renderer. Review the image diff before merging."
gh pr create --base main --head "$branch" --title "$title" --body "$body"
