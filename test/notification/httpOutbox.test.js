/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHttpOutbox } from '../../lib/notification/httpOutbox.js';
let db;
beforeEach(() => {
  db = new Database(':memory:');
});
afterEach(() => db.close());
const endpoint = 'http://127.0.0.1:8765/api/v1/fredy/events';
const fields = { endpointUrl: endpoint, authToken: 'private-token' };
const body = { event: 'listings', provider: 'wbm', listings: [{ id: 'a', rooms: 2 }], timestamp: 'first' };

it('persists a failed response and delivers after restart without another discovery', async () => {
  let clock = 0;
  const failed = vi.fn().mockResolvedValue({ ok: false, status: 500 });
  const first = createHttpOutbox(db, { resolveFields: () => fields, fetchImpl: failed, now: () => clock });
  const id = first.enqueue(endpoint, 'job', body);
  await expect(first.deliver(id)).rejects.toThrow('HTTP 500');
  const pending = db.prepare('SELECT * FROM http_delivery_outbox').get();
  expect(pending.delivered).toBe(0);
  expect(JSON.stringify(pending)).not.toContain('private-token');
  clock = 10000;
  const success = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const restarted = createHttpOutbox(db, { resolveFields: () => fields, fetchImpl: success, now: () => clock });
  await restarted.drain();
  expect(success).toHaveBeenCalledTimes(1);
  expect(success.mock.calls[0][1].headers.Authorization).toBe('Bearer private-token');
  expect(success.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  expect(db.prepare('SELECT delivered,payload FROM http_delivery_outbox').get()).toEqual({
    delivered: 1,
    payload: null,
  });
});

it('serializes overlapping sends and keeps deduplication after success', async () => {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const service = createHttpOutbox(db, { resolveFields: () => fields, fetchImpl });
  const id = service.enqueue(endpoint, 'job', body);
  expect(service.enqueue(endpoint, 'job', { ...body, timestamp: 'later' })).toBe(id);
  await Promise.all([service.deliver(id), service.deliver(id)]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('does not forward stored applications to a changed destination', async () => {
  const fetchImpl = vi.fn();
  const service = createHttpOutbox(db, {
    resolveFields: () => ({ ...fields, endpointUrl: 'https://other.invalid' }),
    fetchImpl,
  });
  const id = service.enqueue(endpoint, 'job', body);
  await expect(service.deliver(id)).rejects.toThrow('unavailable');
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(db.prepare('SELECT delivered FROM http_delivery_outbox').get().delivered).toBe(0);
});
