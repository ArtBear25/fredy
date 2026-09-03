/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { up } from '../../../lib/services/storage/migrations/sql/22.recheck-cold-rent-providers.js';

describe('22.recheck-cold-rent-providers migration', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE listings (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        hash TEXT,
        provider TEXT,
        manually_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX idx_listings_job_hash ON listings (job_id, hash);
    `);

    const insert = db.prepare(
      `INSERT INTO listings (id, job_id, hash, provider, manually_deleted)
       VALUES (@id, @jobId, @hash, @provider, @manuallyDeleted)`,
    );
    insert.run({ id: 'hidden-howoge', jobId: 'job-1', hash: 'howoge-hash', provider: 'howoge', manuallyDeleted: 1 });
    insert.run({ id: 'hidden-degewo', jobId: 'job-1', hash: 'degewo-hash', provider: 'degewo', manuallyDeleted: 1 });
    insert.run({ id: 'visible-howoge', jobId: 'job-1', hash: 'visible-hash', provider: 'howoge', manuallyDeleted: 0 });
    insert.run({ id: 'hidden-other', jobId: 'job-1', hash: 'other-hash', provider: 'immowelt', manuallyDeleted: 1 });
  });

  afterEach(() => {
    db.close();
  });

  it('namespaces only hidden HOWOGE and Degewo hashes and preserves their rows', () => {
    up(db);
    up(db);

    const rows = new Map(
      db
        .prepare('SELECT id, hash, manually_deleted FROM listings')
        .all()
        .map((row) => [row.id, row]),
    );

    expect(rows.get('hidden-howoge')).toMatchObject({ hash: 'legacy-warm-price:howoge-hash', manually_deleted: 1 });
    expect(rows.get('hidden-degewo')).toMatchObject({ hash: 'legacy-warm-price:degewo-hash', manually_deleted: 1 });
    expect(rows.get('visible-howoge')).toMatchObject({ hash: 'visible-hash', manually_deleted: 0 });
    expect(rows.get('hidden-other')).toMatchObject({ hash: 'other-hash', manually_deleted: 1 });
    expect(rows.size).toBe(4);

    expect(() =>
      db
        .prepare(
          `INSERT INTO listings (id, job_id, hash, provider, manually_deleted)
           VALUES ('fresh-howoge', 'job-1', 'howoge-hash', 'howoge', 0)`,
        )
        .run(),
    ).not.toThrow();
  });
});
