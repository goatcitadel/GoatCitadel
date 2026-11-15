#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Rebuilds findings.json from its sources: apply-verdicts.cjs (carried findings), apply-new-findings.cjs
// (Phase 2 findings), then apply-overrides.cjs (Task 15 corrections, root causes, ranking). Running it twice
// gives the same findings.json byte for byte.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const STEPS = ['apply-verdicts.cjs', 'apply-new-findings.cjs', 'apply-overrides.cjs'];

for (const step of STEPS) {
  console.log(`== ${step}`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, step)], { stdio: 'inherit', windowsHide: true });
  } catch (e) {
    console.error(`${step} failed (exit ${e.status}); findings.json may be partly rebuilt. Fix the error and run again.`);
    process.exit(1);
  }
}
