'use strict';

const { createConnection } = require('./redis');
const logger = require('./logger');

/**
 * Event-level idempotency guard backed by Redis.
 *
 * Stripe can deliver the same event more than once. Deduping only the receipt
 * job (via jobId) still lets the inline confirmation email fire twice on a
 * redelivery. This guard covers ALL side effects for an event from a single
 * gate: the first caller to claim an event id proceeds; redeliveries are told
 * to stop before any email is sent or job enqueued.
 *
 * SET NX (set-if-not-exists) is atomic, so two concurrent deliveries of the
 * same event can't both win the claim.
 */

const KEY_PREFIX = 'idempotency:event:';
// Keep claims long enough to outlast Stripe's retry window (which can span
// days) without growing unbounded. 7 days is comfortably beyond it.
const TTL_SECONDS = 7 * 24 * 3600;

let connection = null;
function getConnection() {
  if (!connection) connection = createConnection();
  return connection;
}

/**
 * Atomically claim an event id. Returns true if this caller won the claim
 * (first time we've seen it) and should process; false if it was already
 * claimed (a redelivery) and processing should be skipped.
 */
async function claimEvent(eventId) {
  const key = KEY_PREFIX + eventId;
  // NX = only set if not present; EX = expiry in seconds.
  const result = await getConnection().set(key, Date.now(), 'EX', TTL_SECONDS, 'NX');
  const won = result === 'OK';
  if (!won) {
    logger.info('duplicate event ignored', { eventId });
  }
  return won;
}

/**
 * Release a claim. Called when processing failed and we want a Stripe retry to
 * be able to re-attempt, rather than being permanently deduped away.
 */
async function releaseEvent(eventId) {
  await getConnection().del(KEY_PREFIX + eventId);
}

/** Test seam: inject a fake redis-like client with set/del. */
function _setConnection(conn) {
  connection = conn;
}

module.exports = { claimEvent, releaseEvent, _setConnection };
