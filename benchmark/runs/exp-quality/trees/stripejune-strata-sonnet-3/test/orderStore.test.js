'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('orderStore', () => {
  let tmpDir;
  let orderStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orderstore-test-'));
    process.env.ORDER_STORE_DIR = tmpDir;
    jest.resetModules();
    orderStore = require('../lib/orderStore');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ORDER_STORE_DIR;
  });

  test('getOrder returns null for an unknown session', () => {
    expect(orderStore.getOrder('cs_unknown')).toBeNull();
  });

  test('upsertOrder creates then merges fields on a second call', () => {
    const first = orderStore.upsertOrder('cs_1', { customerEmail: 'a@b.com', status: 'paid' });
    expect(first.customerEmail).toBe('a@b.com');
    expect(first.status).toBe('paid');
    expect(first.createdAt).toBeDefined();

    const second = orderStore.upsertOrder('cs_1', { status: 'receipted' });
    expect(second.customerEmail).toBe('a@b.com'); // preserved
    expect(second.status).toBe('receipted'); // overwritten
    expect(second.createdAt).toBe(first.createdAt); // createdAt is stable
  });

  test('markReceiptSent flags the order', () => {
    orderStore.upsertOrder('cs_2', { customerEmail: 'x@y.com' });
    const updated = orderStore.markReceiptSent('cs_2', '/tmp/receipt.pdf');
    expect(updated.receiptSent).toBe(true);
    expect(updated.receiptPath).toBe('/tmp/receipt.pdf');
    expect(updated.receiptSentAt).toBeDefined();
  });

  test('persists across a fresh require (simulated process restart)', () => {
    orderStore.upsertOrder('cs_3', { customerEmail: 'z@z.com' });
    jest.resetModules();
    const reloaded = require('../lib/orderStore');
    expect(reloaded.getOrder('cs_3').customerEmail).toBe('z@z.com');
  });

  test('survives a corrupted data file by treating it as empty', () => {
    const dataFile = path.join(tmpDir, 'orders.json');
    fs.writeFileSync(dataFile, '{not valid json');
    expect(orderStore.getOrder('cs_anything')).toBeNull();
    const created = orderStore.upsertOrder('cs_4', { customerEmail: 'r@r.com' });
    expect(created.customerEmail).toBe('r@r.com');
  });
});
