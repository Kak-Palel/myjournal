// Preload for test/server/node-version.test.js:   node --import ./fake-node-version.mjs server.js
// Makes the process claim another Node.js version (FAKE_NODE_VERSION) and reports on exit whether node:sqlite was
// loaded, so the test can prove that a too-old Node never gets as far as the modules that need it.
Object.defineProperty(process.versions, 'node', { value: process.env.FAKE_NODE_VERSION, enumerable: true, configurable: true });
process.on('exit', () => {
  const loaded = process.moduleLoadList.some((name) => /sqlite/i.test(name));
  process.stderr.write(`\n[probe] node:sqlite ${loaded ? 'LOADED' : 'not loaded'}\n`);
});
