/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Track polygon exclusions and pending retries without guessing why legacy rows were hidden.
 * @param {import('better-sqlite3').Database} db
 */
export function up(db) {
  const columns = db
    .prepare('PRAGMA table_info(listings)')
    .all()
    .map((column) => column.name);
  if (!columns.includes('exclusion_reason')) {
    db.exec('ALTER TABLE listings ADD COLUMN exclusion_reason TEXT');
  }
  if (!columns.includes('area_recheck_pending')) {
    db.exec('ALTER TABLE listings ADD COLUMN area_recheck_pending INTEGER NOT NULL DEFAULT 0');
  }
}
