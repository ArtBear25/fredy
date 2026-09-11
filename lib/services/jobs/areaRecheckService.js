/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { deleteListingsById, getRecentAreaRecheckCandidates } from '../storage/listingsStorage.js';

export const AREA_RECHECK_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Re-evaluate recently stored listings against a job's current polygon filter.
 *
 * Visible listings that now sit outside the polygon are soft-deleted. Hidden listings that now sit
 * inside are hard-deleted so the next normal provider run can rediscover them and put them through
 * every current filter again before notifying. Hard deletion is intentional here: merely restoring
 * the row would still leave its hash in `_findNew`, so Fredy would continue to treat it as known.
 *
 * @param {Object} job
 * @param {string} job.id
 * @param {Object|null} job.spatialFilter
 * @param {{now?:number, days?:number}} [options]
 * @returns {{checked:number, requeued:number, hidden:number, cutoff:number}}
 */
export function recheckRecentAreaListings(job, options = {}) {
  const polygons = job?.spatialFilter?.features?.filter((feature) => feature?.geometry?.type === 'Polygon') ?? [];
  if (polygons.length === 0) {
    throw new Error('Job has no polygon filter.');
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const days = Number.isFinite(options.days) && options.days > 0 ? options.days : AREA_RECHECK_DAYS;
  const cutoff = now - days * DAY_MS;
  const candidates = getRecentAreaRecheckCandidates(job.id, cutoff);
  const toRequeue = [];
  const toHide = [];

  for (const listing of candidates) {
    const point = [listing.longitude, listing.latitude];
    const inside = polygons.some((polygon) => booleanPointInPolygon(point, polygon));
    const hidden = Boolean(listing.manually_deleted);

    if (inside && hidden) {
      toRequeue.push(listing.id);
    } else if (!inside && !hidden) {
      toHide.push(listing.id);
    }
  }

  // A hidden row has to disappear completely before the next run. Otherwise _findNew sees its hash
  // and skips it before the updated polygon gets another chance to decide.
  if (toRequeue.length > 0) deleteListingsById(toRequeue, true);
  if (toHide.length > 0) deleteListingsById(toHide);

  return {
    checked: candidates.length,
    requeued: toRequeue.length,
    hidden: toHide.length,
    cutoff,
  };
}
