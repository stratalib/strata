import test from 'node:test';
import assert from 'node:assert';

test('email formatting logic', async (t) => {
  const email = 'test@example.com';
  const amount = 99.99;
  const currency = 'usd';
  const currencySymbol = currency === 'usd' ? '$' : currency.toUpperCase();

  const formattedAmount = `${currencySymbol}${amount.toFixed(2)}`;
  assert.strictEqual(formattedAmount, '$99.99');
});
