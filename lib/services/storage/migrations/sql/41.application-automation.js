/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Keep automation progress separate from the existing user-facing listing status. The final success
 * still writes `status=applied`; this JSON column carries transient state, the provider/exposé
 * identity used for cross-job idempotency, and Telegram message ids that need to be refreshed.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {void}
 */
export function up(db) {
  const columns = db
    .prepare(`PRAGMA table_info(listings)`)
    .all()
    .map((column) => column.name);
  if (!columns.includes('application_state')) {
    db.exec(`ALTER TABLE listings ADD COLUMN application_state TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_listings_application_provider_url
           ON listings (
             json_extract(application_state, '$.provider'),
             json_extract(application_state, '$.url')
           )`);
}
