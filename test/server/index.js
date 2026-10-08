// Lets `node --test test/server` work on Node 22, where a directory argument is no longer expanded to
// the test files inside it. (npm test uses the glob "test/{...,server,...}/**/*.test.js", which does not
// match this file, so nothing runs twice.) Importing a test file registers its tests with the runner.
import { readdirSync } from 'node:fs';

const here = new URL('.', import.meta.url);
for (const name of readdirSync(here).filter((file) => file.endsWith('.test.js')).sort()) {
  await import(new URL(name, here).href);
}
