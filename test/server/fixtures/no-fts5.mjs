// Preload for test/server/node-version.test.js:   node --import ./no-fts5.mjs server.js
// Makes node:sqlite behave like a Node.js 22.13 to 22.15 or 23.x build, whose bundled SQLite was compiled without FTS5:
// creating an fts5 table fails with "no such module: fts5". Everything else works as usual.
import sqlite from 'node:sqlite';

const exec = sqlite.DatabaseSync.prototype.exec;
sqlite.DatabaseSync.prototype.exec = function patchedExec(sql) {
  if (/USING\s+fts5/i.test(String(sql))) throw new Error('no such module: fts5');
  return exec.call(this, sql);
};
