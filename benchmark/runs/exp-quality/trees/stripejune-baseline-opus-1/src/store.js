'use strict';

// In-memory persistence. Deliberately behind a small interface so it can be
// swapped for a real database (Postgres, etc.) without touching callers.
// Two concerns live here:
//   1. Orders   — the record of a completed purchase.
//   2. Events   — the set of Stripe event IDs we've already handled, so a
//                 retried webhook is processed exactly once (idempotency).

const orders = new Map();
const processedEvents = new Set();

const store = {
  // Returns true the FIRST time an event id is seen, false on every repeat.
  // Callers use this to guarantee at-most-once side effects per Stripe event.
  markEventProcessed(eventId) {
    if (processedEvents.has(eventId)) return false;
    processedEvents.add(eventId);
    return true;
  },

  hasProcessedEvent(eventId) {
    return processedEvents.has(eventId);
  },

  saveOrder(order) {
    orders.set(order.id, order);
    return order;
  },

  getOrder(id) {
    return orders.get(id);
  },

  allOrders() {
    return Array.from(orders.values());
  },

  // Test/support helper: wipe state.
  _reset() {
    orders.clear();
    processedEvents.clear();
  },
};

module.exports = store;
