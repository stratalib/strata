const express = require('express');
const { handleStripeWebhook } = require('../controllers/webhookController');

const router = express.Router();

// express.raw() keeps req.body as a Buffer instead of parsing it as JSON --
// required here because Stripe's signature is computed over the raw bytes.
router.post('/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

module.exports = router;
