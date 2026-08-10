const EVENT_KEY_PREFIX = 'stripe:event:';
const EVENT_TTL_SECONDS = 7 * 24 * 60 * 60; // Stripe retries delivery for up to 3 days; keep a margin.

// Stripe explicitly documents that webhook events may be delivered more than once,
// so handlers must be idempotent. SET NX gives us an atomic "claim this event id"
// check with no separate read-then-write race.
async function claimEvent(redisConnection, eventId) {
  const result = await redisConnection.set(
    `${EVENT_KEY_PREFIX}${eventId}`,
    '1',
    'EX',
    EVENT_TTL_SECONDS,
    'NX'
  );
  return result === 'OK';
}

module.exports = { claimEvent };
