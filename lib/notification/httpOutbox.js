/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import { createHash } from 'node:crypto';

/** Send one request, including explicit channel probes which must never enter the retry queue.
 * @param {Object} fields Current channel settings.
 * @param {string} payload Serialized event.
 * @param {Function} [fetchImpl] HTTP transport.
 * @returns {Promise<{ok: boolean, status: number}>}
 */
export async function postHttpEvent(fields, payload, fetchImpl = (...args) => fetch(...args)) {
  let dispatcher;
  try {
    if (fields.selfSignedCerts) {
      const { Agent } = await import('undici');
      dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
    const response = await fetchImpl(fields.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(fields.authToken ? { Authorization: `Bearer ${fields.authToken}` } : {}),
      },
      body: payload,
      signal: AbortSignal.timeout(10000),
      ...(dispatcher ? { dispatcher } : {}),
    });
    await response.arrayBuffer?.();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ok: true, status: response.status };
  } finally {
    await dispatcher?.close();
  }
}

/**
 * Durable HTTP delivery. Credentials are resolved from the configured channel on every attempt,
 * rather than copied into another database record. A changed/deleted destination stays pending.
 * @param {import('better-sqlite3').Database} db
 * @param {{resolveFields: Function, fetchImpl?: Function, now?: Function}} options
 * @returns {{enqueue: Function, deliver: Function, drain: Function}}
 */
export function createHttpOutbox(db, { resolveFields, fetchImpl = (...args) => fetch(...args), now = Date.now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS http_delivery_outbox (
    id TEXT PRIMARY KEY, job_key TEXT NOT NULL, endpoint TEXT NOT NULL, payload TEXT,
    delivered INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL
  )`);
  let running = Promise.resolve();
  let draining = false;
  const enqueue = (endpoint, jobKey, body) => {
    const identity = JSON.stringify({ endpoint, jobKey, ...body, timestamp: undefined });
    const id = createHash('sha256').update(identity).digest('hex');
    db.prepare(
      `INSERT OR IGNORE INTO http_delivery_outbox
      (id,job_key,endpoint,payload,created_at) VALUES (?,?,?,?,?)`,
    ).run(id, jobKey, endpoint, JSON.stringify(body), now());
    return id;
  };
  const attempt = async (id) => {
    const row = db.prepare('SELECT * FROM http_delivery_outbox WHERE id=? AND delivered=0').get(id);
    if (!row) return { ok: true, duplicate: true };
    try {
      const fields = await resolveFields(row.job_key, row.endpoint);
      if (!fields || fields.endpointUrl !== row.endpoint) throw new Error('Configured HTTP destination is unavailable');
      const response = await postHttpEvent(fields, row.payload, fetchImpl);
      db.prepare('UPDATE http_delivery_outbox SET delivered=1,payload=NULL,last_error=NULL WHERE id=?').run(id);
      return { ok: true, status: response.status };
    } catch (error) {
      const delay = Math.min(3600000, 5000 * 2 ** Math.min(row.attempts, 10));
      // Store the error category/status only; network errors can contain credentials in URLs.
      const detail = /^HTTP \d+$/.test(error.message) ? error.message : 'HTTP delivery failed; retained for retry';
      db.prepare('UPDATE http_delivery_outbox SET attempts=attempts+1,next_attempt=?,last_error=? WHERE id=?').run(
        now() + delay,
        detail,
        id,
      );
      throw error;
    }
  };
  const deliver = (id) => {
    const result = running.catch(() => {}).then(() => attempt(id));
    running = result;
    return result;
  };
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      const due = db
        .prepare(
          'SELECT id FROM http_delivery_outbox WHERE delivered=0 AND next_attempt<=? ORDER BY created_at LIMIT 50',
        )
        .all(now());
      for (const row of due) {
        try {
          await deliver(row.id);
        } catch {
          /* persisted for the next bounded retry */
        }
      }
    } finally {
      draining = false;
    }
  };
  return { enqueue, deliver, drain };
}

let outbox;
/** @returns {Promise<ReturnType<typeof createHttpOutbox>>} */
export async function getHttpOutbox() {
  if (!outbox) {
    const [{ default: connection }, { getJob }] = await Promise.all([
      import('../services/storage/SqliteConnection.js'),
      import('../services/storage/jobStorage.js'),
    ]);
    outbox ??= createHttpOutbox(connection.getConnection(), {
      resolveFields: (jobKey, endpoint) =>
        getJob(jobKey)?.notificationAdapter?.find(
          (channel) => channel.id === 'http' && channel.fields.endpointUrl === endpoint,
        )?.fields,
    });
  }
  return outbox;
}

/** Resume pending deliveries on boot, including periods when no new flats are found. */
export async function startHttpOutbox() {
  const service = await getHttpOutbox();
  const tick = () => service.drain().catch(() => {});
  void tick();
  const timer = setInterval(tick, 5000);
  timer.unref();
  return () => clearInterval(timer);
}
