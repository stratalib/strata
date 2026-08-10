'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { useFakeIdempotency } = require('./helpers');
const { claimEvent, releaseEvent } = require('../src/lib/idempotency');

beforeEach(() => useFakeIdempotency());

test('claimEvent returns true the first time and false on redelivery', async () => {
  assert.equal(await claimEvent('evt_1'), true);
  assert.equal(await claimEvent('evt_1'), false);
  assert.equal(await claimEvent('evt_1'), false);
});

test('different event ids each get their own claim', async () => {
  assert.equal(await claimEvent('evt_a'), true);
  assert.equal(await claimEvent('evt_b'), true);
});

test('releaseEvent re-opens a claim so a retry can re-attempt', async () => {
  assert.equal(await claimEvent('evt_x'), true);
  assert.equal(await claimEvent('evt_x'), false);
  await releaseEvent('evt_x');
  assert.equal(await claimEvent('evt_x'), true, 'after release the event can be claimed again');
});
