'use strict';

const mockListLineItems = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: { sessions: { listLineItems: mockListLineItems } },
  }));
});

const mockSend = jest.fn();
jest.mock('../lib/mailer', () => ({
  mailer: { send: (...args) => mockSend(...args) },
}));

const mockEnqueueReceipt = jest.fn();
jest.mock('../queue/receiptQueue', () => ({
  enqueueReceipt: (...args) => mockEnqueueReceipt(...args),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('purchaseHandler.handleCheckoutSessionCompleted', () => {
  let tmpDir;
  let handleStripeEvent;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-test-'));
    process.env.ORDER_STORE_DIR = tmpDir;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    jest.clearAllMocks();
    jest.resetModules();
    mockSend.mockResolvedValue({ ok: true, id: 'mail_1', attempts: 1 });
    mockEnqueueReceipt.mockResolvedValue({ id: 'job_1' });
    mockListLineItems.mockResolvedValue({
      data: [{ description: 'Widget', quantity: 1, amount_total: 1500 }],
    });
    ({ handleStripeEvent } = require('../lib/purchaseHandler'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ORDER_STORE_DIR;
    delete process.env.STRIPE_SECRET_KEY;
  });

  function makeEvent(overrides) {
    return {
      type: 'checkout.session.completed',
      data: {
        object: Object.assign(
          {
            id: 'cs_test_123',
            currency: 'usd',
            amount_total: 1500,
            customer_details: { email: 'buyer@example.com', name: 'Ada Lovelace' },
            customer_email: 'buyer@example.com',
          },
          overrides,
        ),
      },
    };
  }

  test('sends a confirmation email and enqueues a receipt job', async () => {
    await handleStripeEvent(makeEvent());

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sendArg = mockSend.mock.calls[0][0];
    expect(sendArg.to).toBe('buyer@example.com');
    expect(sendArg.idempotencyKey).toBe('confirmation:cs_test_123');
    expect(sendArg.subject).toMatch(/confirmed/i);

    expect(mockEnqueueReceipt).toHaveBeenCalledTimes(1);
    const jobArg = mockEnqueueReceipt.mock.calls[0][0];
    expect(jobArg.sessionId).toBe('cs_test_123');
    expect(jobArg.customerEmail).toBe('buyer@example.com');
    expect(jobArg.lineItems).toEqual([{ description: 'Widget', quantity: 1, amountTotal: 1500 }]);
  });

  test('persists the order before enqueueing', async () => {
    const orderStore = require('../lib/orderStore');
    await handleStripeEvent(makeEvent());
    const order = orderStore.getOrder('cs_test_123');
    expect(order).not.toBeNull();
    expect(order.status).toBe('paid');
    expect(order.amountTotal).toBe(1500);
  });

  test('skips entirely when there is no customer email', async () => {
    await handleStripeEvent(makeEvent({ customer_details: null, customer_email: null }));
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockEnqueueReceipt).not.toHaveBeenCalled();
  });

  test('still enqueues the receipt if fetching line items fails', async () => {
    mockListLineItems.mockRejectedValue(new Error('stripe is down'));
    await handleStripeEvent(makeEvent());
    expect(mockEnqueueReceipt).toHaveBeenCalledTimes(1);
    expect(mockEnqueueReceipt.mock.calls[0][0].lineItems).toEqual([]);
  });

  test('ignores unrelated event types', async () => {
    await handleStripeEvent({ type: 'invoice.paid', data: { object: {} } });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockEnqueueReceipt).not.toHaveBeenCalled();
  });

  test('does not throw when the confirmation email is dead-lettered', async () => {
    mockSend.mockResolvedValue({ ok: false, error: new Error('smtp down') });
    await expect(handleStripeEvent(makeEvent())).resolves.toBeUndefined();
    expect(mockEnqueueReceipt).toHaveBeenCalledTimes(1);
  });
});
