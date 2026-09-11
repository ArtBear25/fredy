/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { deleteListingsById, getRecentAreaRecheckCandidates, queueAreaRecheck } from '../storage/listingsStorage.js';

export const AREA_RECHECK_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Re-evaluate recently stored listings against a job's current polygon filter.
 *
 * Visible listings outside the polygon are hidden with an explicit reason. Only confirmed
 * polygon exclusions inside it are queued for the normal provider pipeline; no rows are deleted.
 * Legacy exclusions with an unknown reason and manual deletions remain untouched.
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

    if (inside && hidden && listing.exclusion_reason === 'area' && !listing.area_recheck_pending) {
      toRequeue.push(listing.id);
    } else if (!inside && !hidden) {
      toHide.push(listing.id);
    }
  }

  const requeued = queueAreaRecheck(toRequeue)?.changes ?? 0;
  const hidden = deleteListingsById(toHide, false, 'area')?.changes ?? 0;

  return {
    checked: candidates.length,
    requeued,
    hidden,
    cutoff,
  };
}
