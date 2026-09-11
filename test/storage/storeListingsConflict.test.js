/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { up as migrateAreaRecheck } from '../../lib/services/storage/migrations/sql/42.area-recheck.js';

/**
 * `storeListings` writes the DB primary key back onto each listing so the rest of the pipeline can
 * address the stored row - distance updates, and the spec/area/similarity filters, which delete by
 * id. The insert carries `ON CONFLICT DO NOTHING`, so it does not always write a row; when it did
 * not, the generated id used to be assigned anyway and every later step silently addressed a row
 * that does not exist.
 */
describe('storeListings id propagation', () => {
  let db;
  let listingsStorage;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE listings (
        id TEXT PRIMARY KEY,
        hash TEXT,
        provider TEXT,
        job_id TEXT,
        price REAL,
        size REAL,
        rooms REAL,
        build_year INTEGER,
        energy_class TEXT,
        title TEXT,
        image_url TEXT,
        description TEXT,
        address TEXT,
        link TEXT,
        created_at INTEGER,
        is_active INTEGER,
        exclusion_reason TEXT,
        area_recheck_pending INTEGER DEFAULT 0,
        address_is_manual INTEGER DEFAULT 0,
        manually_deleted INTEGER DEFAULT 0,
        latitude REAL,
        longitude REAL,
        distances TEXT,
        notes TEXT,
        status TEXT,
        UNIQUE (job_id, hash)
      );
    `);

    vi.resetModules();
    vi.doMock('../../lib/services/storage/SqliteConnection.js', () => ({
      default: {
        getConnection: () => db,
        query: (sql, params) => db.prepare(sql).all(params),
        execute: (sql, params) => db.prepare(sql).run(params),
        withTransaction: (callback) => db.transaction(() => callback(db))(),
      },
    }));
    vi.doMock('../../lib/services/similarity-check/similarityCache.js', () => ({
      removeEntry: vi.fn(),
      initSimilarityCache: vi.fn(),
    }));
    listingsStorage = await import('../../lib/services/storage/listingsStorage.js');
  });

  afterEach(() => {
    db.close();
  });

  const listing = (hash, overrides = {}) => ({
    id: hash,
    price: 1000,
    size: 60,
    rooms: 2,
    title: `Flat ${hash}`,
    image: null,
    description: 'nice',
    address: 'Hauptstrasse 1 (Innenstadt)',
    link: `https://example.com/${hash}`,
    ...overrides,
  });

  it('rechecks a polygon exclusion without losing identity or user data', () => {
    const first = [listing('polygon', { latitude: 52.55, longitude: 13.4 })];
    listingsStorage.storeListings('job-1', 'postheimstaette', first);
    const id = first[0].id;
    db.prepare("UPDATE listings SET notes='keep me', created_at=123 WHERE id=?").run(id);
    listingsStorage.deleteListingsById([id], false, 'area');
    expect(listingsStorage.getKnownListingHashesForJobAndProvider('job-1', 'postheimstaette')).toEqual(['polygon']);
    expect(listingsStorage.queueAreaRecheck([id]).changes).toBe(1);
    expect(listingsStorage.queueAreaRecheck([id]).changes).toBe(0);
    expect(listingsStorage.getKnownListingHashesForJobAndProvider('job-1', 'postheimstaette')).toEqual([]);
    const retry = [listing('polygon', { price: 616.6 })];
    listingsStorage.storeListings('job-1', 'postheimstaette', retry);
    expect(retry[0].id).toBe(id);
    expect(db.prepare('SELECT * FROM listings WHERE id=?').get(id)).toMatchObject({
      notes: 'keep me',
      created_at: 123,
      price: 616.6,
      manually_deleted: 0,
      exclusion_reason: null,
      area_recheck_pending: 0,
    });
    expect(listingsStorage.getKnownListingHashesForJobAndProvider('job-1', 'postheimstaette')).toEqual(['polygon']);
  });

  it('queues manual and legacy rows but keeps unavailable offers out', () => {
    for (const hash of ['legacy', 'manual', 'inactive']) {
      const batch = [listing(hash)];
      listingsStorage.storeListings('job-1', 'p', batch);
      const id = batch[0].id;
      if (hash === 'legacy') db.prepare('UPDATE listings SET manually_deleted=1 WHERE id=?').run(id);
      else listingsStorage.deleteListingsById([id], false, hash === 'inactive' ? 'area' : 'other');
      if (hash === 'inactive') db.prepare('UPDATE listings SET is_active=0 WHERE id=?').run(id);
      expect(listingsStorage.queueAreaRecheck([id]).changes).toBe(hash === 'inactive' ? 0 : 1);
    }
    expect(listingsStorage.getKnownListingHashesForJobAndProvider('job-1', 'p').sort()).toEqual(['inactive']);
  });

  it('reads queued stored data with the provider hash and scopes it to the job and provider', () => {
    const offers = [listing('old', { latitude: 52.55, longitude: 13.4 })];
    listingsStorage.storeListings('job-1', 'p', offers);
    listingsStorage.deleteListingsById([offers[0].id]);
    listingsStorage.queueAreaRecheck([offers[0].id]);
    expect(listingsStorage.getPendingAreaRecheckListings('job-1', 'p')).toMatchObject([
      { id: 'old', title: 'Flat old', price: 1000, latitude: 52.55 },
    ]);
    expect(listingsStorage.getPendingAreaRecheckListings('job-2', 'p')).toEqual([]);
    expect(listingsStorage.getPendingAreaRecheckListings('job-1', 'other')).toEqual([]);
  });

  it('manual deletion cancels an already queued retry', () => {
    const batch = [listing('cancel')];
    listingsStorage.storeListings('job-1', 'p', batch);
    const id = batch[0].id;
    listingsStorage.deleteListingsById([id], false, 'area');
    listingsStorage.queueAreaRecheck([id]);
    listingsStorage.deleteListingsById([id]);
    expect(listingsStorage.getKnownListingHashesForJobAndProvider('job-1', 'p')).toEqual(['cancel']);
    expect(db.prepare('SELECT * FROM listings WHERE id=?').get(id)).toMatchObject({
      manually_deleted: 1,
      exclusion_reason: 'other',
      area_recheck_pending: 0,
    });
  });

  it('withholds a retry deleted by the user while provider details were loading', () => {
    const initial = [listing('race')];
    listingsStorage.storeListings('job-1', 'p', initial);
    const id = initial[0].id;
    listingsStorage.deleteListingsById([id], false, 'area');
    listingsStorage.queueAreaRecheck([id]);
    const retry = [listing('race')];
    listingsStorage.deleteListingsById([id]);
    listingsStorage.storeListings('job-1', 'p', retry);
    expect(retry).toEqual([]);
    expect(db.prepare('SELECT manually_deleted FROM listings WHERE id=?').get(id).manually_deleted).toBe(1);
  });

  it('selects recent active rows including manual and legacy exclusions', () => {
    for (const hash of ['polygon', 'legacy', 'manual', 'old', 'offline', 'visible']) {
      const batch = [listing(hash, { latitude: 52.55, longitude: 13.4 })];
      listingsStorage.storeListings('job-1', 'p', batch);
      const id = batch[0].id;
      if (hash === 'legacy') db.prepare('UPDATE listings SET manually_deleted=1 WHERE id=?').run(id);
      else if (hash !== 'visible')
        listingsStorage.deleteListingsById([id], false, hash === 'manual' ? 'other' : 'area');
      if (hash === 'old') db.prepare('UPDATE listings SET created_at=1 WHERE id=?').run(id);
      if (hash === 'offline') db.prepare('UPDATE listings SET is_active=0 WHERE id=?').run(id);
    }
    expect(listingsStorage.getRecentAreaRecheckCandidates('job-1', Date.now() - 86400000)).toHaveLength(4);
  });

  it('migrates legacy data without inventing exclusion reasons and is repeatable', () => {
    const legacy = new Database(':memory:');
    try {
      legacy.exec("CREATE TABLE listings (id TEXT, manually_deleted INTEGER); INSERT INTO listings VALUES ('old', 1)");
      migrateAreaRecheck(legacy);
      migrateAreaRecheck(legacy);
      expect(legacy.prepare('SELECT * FROM listings').get()).toEqual({
        id: 'old',
        manually_deleted: 1,
        exclusion_reason: null,
        area_recheck_pending: 0,
      });
    } finally {
      legacy.close();
    }
  });

  const rowExists = (id) => db.prepare('SELECT 1 FROM listings WHERE id = ?').get(id) != null;

  it('gives a freshly inserted listing the id of its row', () => {
    const listings = [listing('hash-1')];
    listingsStorage.storeListings('job-1', 'immowelt', listings);

    expect(rowExists(listings[0].id)).toBe(true);
  });

  it('points a duplicate inside one batch at the row that was actually written', () => {
    const listings = [listing('same-hash'), listing('same-hash')];
    listingsStorage.storeListings('job-1', 'immowelt', listings);

    expect(db.prepare('SELECT COUNT(*) AS c FROM listings').get().c).toBe(1);
    // Both entries must address the one existing row, not a phantom id.
    expect(rowExists(listings[0].id)).toBe(true);
    expect(rowExists(listings[1].id)).toBe(true);
    expect(listings[0].id).toBe(listings[1].id);
  });

  it('points a listing already stored by another provider of the same job at the existing row', () => {
    const first = [listing('shared-hash')];
    listingsStorage.storeListings('job-1', 'immowelt', first);
    const storedId = first[0].id;

    const second = [listing('shared-hash')];
    listingsStorage.storeListings('job-1', 'immoscout', second);

    expect(db.prepare('SELECT COUNT(*) AS c FROM listings').get().c).toBe(1);
    expect(second[0].id).toBe(storedId);
    expect(rowExists(second[0].id)).toBe(true);
  });

  it('lets a downstream delete actually remove the row after a conflict', () => {
    listingsStorage.storeListings('job-1', 'immowelt', [listing('dup')]);
    const second = [listing('dup')];
    listingsStorage.storeListings('job-1', 'immoscout', second);

    // This is what _filterBySpecs/_filterByArea do with the ids they were handed.
    listingsStorage.deleteListingsById([second[0].id]);

    expect(db.prepare('SELECT manually_deleted FROM listings').get().manually_deleted).toBe(1);
  });

  it('keeps the same hash separate across different jobs', () => {
    const forJobOne = [listing('hash-x')];
    const forJobTwo = [listing('hash-x')];
    listingsStorage.storeListings('job-1', 'immowelt', forJobOne);
    listingsStorage.storeListings('job-2', 'immowelt', forJobTwo);

    expect(db.prepare('SELECT COUNT(*) AS c FROM listings').get().c).toBe(2);
    expect(forJobOne[0].id).not.toBe(forJobTwo[0].id);
  });

  it('strips parenthesised address suffixes', () => {
    const listings = [listing('hash-addr')];
    listingsStorage.storeListings('job-1', 'immowelt', listings);
    expect(db.prepare('SELECT address FROM listings').get().address).toBe('Hauptstrasse 1');
  });
});
