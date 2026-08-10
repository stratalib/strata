'use strict';

// forceExit: the ioredis reachability probe in test/receiptQueue.test.js (an unreachable Redis in
// this environment, by design — see that file) leaves jest-worker's child process a few hundred ms
// slower to settle than Jest's fixed 1s grace window, even though the client is fully disconnected
// (verified with 0 active handles in a plain `node` process). Without Redis this trips on every run;
// with Redis reachable the BullMQ integration test opens a real Worker/Queue connection with the
// same shape of teardown cost. Either way nothing here is unbounded — it is a fixed, one-time,
// bounded-duration probe per test run, not a growing leak.
module.exports = {
  testEnvironment: 'node',
  forceExit: true,
};
