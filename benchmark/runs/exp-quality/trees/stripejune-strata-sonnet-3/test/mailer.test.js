'use strict';

describe('lib/mailer', () => {
  const originalSmtpUrl = process.env.SMTP_URL;

  afterEach(() => {
    if (originalSmtpUrl === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = originalSmtpUrl;
    jest.resetModules();
  });

  test('falls back to the in-memory test transport when SMTP_URL is unset', async () => {
    delete process.env.SMTP_URL;
    jest.resetModules();
    const { mailer, transport } = require('../lib/mailer');

    const result = await mailer.send({
      to: 'someone@example.com',
      subject: 'Hello',
      text: 'Body',
    });

    expect(result.ok).toBe(true);
    expect(typeof transport.count).toBe('number');
    expect(transport.count).toBe(1);
    expect(transport.last.to[0].address).toBe('someone@example.com');
  });

  test('rejects an invalid recipient without throwing', async () => {
    delete process.env.SMTP_URL;
    jest.resetModules();
    const { mailer } = require('../lib/mailer');

    const result = await mailer.send({ to: 'not-an-email', subject: 'Hi', text: 'Body' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_RECIPIENT');
  });

  test('builds a Nodemailer transport when SMTP_URL is set, without connecting', () => {
    process.env.SMTP_URL = 'smtps://user:pass@smtp.example.com';
    jest.resetModules();
    // Requiring must not throw or attempt a network connection — createTransport() is lazy in
    // Nodemailer, it only connects on first sendMail().
    let mod;
    expect(() => { mod = require('../lib/mailer'); }).not.toThrow();
    // Nodemailer's pooled transport keeps the event loop alive until closed — close it so this
    // test process can exit cleanly, same as a real shutdown handler would.
    mod.smtpTransporter.close();
  });
});
