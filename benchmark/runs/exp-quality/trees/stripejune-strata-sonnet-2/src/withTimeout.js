'use strict';

/** Races a promise against a deadline. For calls against the shared Redis connection, which is
 *  configured with maxRetriesPerRequest: null (BullMQ requires this for its blocking commands) —
 *  that setting means a command has no built-in ceiling and hangs forever against a dead Redis. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

module.exports = { withTimeout };
