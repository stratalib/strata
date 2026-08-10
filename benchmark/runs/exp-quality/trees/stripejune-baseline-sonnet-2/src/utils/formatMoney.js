function formatMoney(amountInCents, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (currency || 'usd').toUpperCase(),
  }).format((amountInCents || 0) / 100);
}

module.exports = { formatMoney };
