/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Allow hidden HOWOGE and Degewo listings to be evaluated once more after
 * switching their authoritative price from Warmmiete to Kaltmiete.
 *
 * The hidden legacy rows remain intact. Moving only their internal hashes into
 * a dedicated namespace frees the original provider hashes for a fresh insert
 * when an offer is still available.
 */
export function up(db) {
  db.prepare(
    `UPDATE listings
     SET hash = 'legacy-warm-price:' || hash
     WHERE provider IN ('howoge', 'degewo')
       AND manually_deleted = 1
       AND hash IS NOT NULL
       AND hash NOT LIKE 'legacy-warm-price:%'`,
  ).run();
}
