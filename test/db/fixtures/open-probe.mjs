// Child process for open.test.js: open the journal database given as argv[2], try one write, and
// report what happened as a single JSON line.
import { openDb } from '../../../src/db/index.js';

try {
  const db = openDb({ file: process.argv[2] });
  let write = 'ok';
  try {
    db.entries.create({ title: 'probe' });
  } catch (err) {
    write = err.message;
  }
  db.close();
  console.log(JSON.stringify({ opened: true, write }));
} catch (err) {
  console.log(JSON.stringify({ opened: false, name: err.name, code: err.code, message: err.message }));
}
