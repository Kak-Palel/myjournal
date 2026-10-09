#!/usr/bin/env node
// Try the whole app without any key:  npm run demo
//
// A thin launcher on purpose. The demo (scripts/demo-lib.js) reaches node:sqlite, which a Node.js older than 22.16 (or 23.x) does
// not have; importing it statically would end in a raw "No such built-in module: node:sqlite" stack trace before any
// friendly message could be printed. So this file imports only the dependency-free version check, and loads the demo
// with import() once that has passed (the same arrangement as server.js).
//
//   --port N      listen on this port instead of a free one
//   --delay MS    pause between streamed chunks of the pretend models (default 25)
//   --verbose     print one line per request

import { nodeVersionProblem } from '../src/server/node-version.js';

function main() {
  const tooOld = nodeVersionProblem(undefined, { command: 'npm run demo' });
  if (tooOld) {
    process.stderr.write(`\n${tooOld}\n\n`);
    process.exit(1);
  }
  import('./demo-lib.js')
    .then(({ runDemo }) => runDemo())
    .catch((err) => {
      // A database error carries a sentence meant for people (for instance "this Node.js has no FTS5"); anything else gets the trace.
      const friendly = err && err.name === 'DbError' ? err.message : err && err.stack ? err.stack : err;
      process.stderr.write(`The demo could not start: ${friendly}\n`);
      process.exit(1);
    });
}

main();
