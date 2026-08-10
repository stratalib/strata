import { test } from 'node:test';
import assert from 'node:assert';
import { getMailer } from '../src/config/mailer.js';

test('Email service configuration', async (t) => {
  await t.test('should return mailer instance', () => {
    const mailer = getMailer();
    assert(mailer, 'Mailer should be defined');
    assert(mailer.sendMail, 'Mailer should have sendMail method');
  });

  await t.test('should return same instance on multiple calls', () => {
    const mailer1 = getMailer();
    const mailer2 = getMailer();
    assert.strictEqual(mailer1, mailer2, 'Should return same instance');
  });
});
