#!/usr/bin/env node
// Runs before `npm test` and `npm run test:e2e` (package.json "pretest" and "pretest:e2e"): the tests load node:sqlite, and on a
// Node.js older than 22.16 (or any 23.x) that ends in a raw "No such built-in module: node:sqlite" stack trace inside the test report. This file
// imports only the dependency-free version check, so the person gets one friendly sentence instead.
//
//   node scripts/require-node.js "npm test"      the command to name in the message ("... and run npm test again.")

import { nodeVersionProblem } from '../src/server/node-version.js';

const problem = nodeVersionProblem(undefined, { command: process.argv[2] || 'npm test' });
if (problem) {
  process.stderr.write(`\n${problem}\n\n`);
  process.exit(1);
}
