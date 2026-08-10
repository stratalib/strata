const db = require('./index');

function createOrGetBySessionId({
  stripeSessionId,
  stripePaymentIntentId,
  customerEmail,
  customerName,
  amountTotal,
  currency,
  description,
}) {
  const existing = stripeSessionId
    ? db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(stripeSessionId)
    : undefined;
  if (existing) return existing;

  const result = db
    .prepare(
      `INSERT INTO orders
        (stripe_session_id, stripe_payment_intent_id, customer_email, customer_name, amount_total, currency, description, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'paid')`
    )
    .run(
      stripeSessionId || null,
      stripePaymentIntentId || null,
      customerEmail,
      customerName || null,
      amountTotal,
      currency,
      description || null
    );

  return db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
}

function getById(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

function markReceiptSent(id) {
  db.prepare(`UPDATE orders SET receipt_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
}

function hasProcessedEvent(eventId) {
  return !!db.prepare('SELECT 1 FROM processed_webhook_events WHERE stripe_event_id = ?').get(eventId);
}

function markEventProcessed(eventId, type) {
  db.prepare(
    'INSERT OR IGNORE INTO processed_webhook_events (stripe_event_id, type) VALUES (?, ?)'
  ).run(eventId, type);
}

module.exports = {
  createOrGetBySessionId,
  getById,
  markReceiptSent,
  hasProcessedEvent,
  markEventProcessed,
};
