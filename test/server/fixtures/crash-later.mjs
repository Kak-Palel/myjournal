// Preload for test/server/demo.test.js:  node --import ./crash-later.mjs scripts/demo.js
// Throws an exception that nothing catches shortly after start-up, to prove that the demo still removes its temporary data.
setTimeout(() => {
  throw new Error('simulated crash (test)');
}, Number(process.env.CRASH_AFTER_MS || 1500));
