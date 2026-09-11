/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/services/storage/listingsStorage.js', () => ({
  getRecentAreaRecheckCandidates: vi.fn(),
  deleteListingsById: vi.fn(),
}));

import { deleteListingsById, getRecentAreaRecheckCandidates } from '../../../lib/services/storage/listingsStorage.js';
import { recheckRecentAreaListings } from '../../../lib/services/jobs/areaRecheckService.js';

const POLYGON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [13.3, 52.5],
            [13.3, 52.6],
            [13.5, 52.6],
            [13.5, 52.5],
            [13.3, 52.5],
          ],
        ],
      },
      properties: {},
    },
  ],
};

const JOB = { id: 'job-1', spatialFilter: POLYGON };

describe('areaRecheckService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requeues hidden listings that are now inside and hides visible listings that are now outside', () => {
    getRecentAreaRecheckCandidates.mockReturnValue([
      { id: 'hidden-inside', latitude: 52.55, longitude: 13.4, manually_deleted: 1 },
      { id: 'visible-inside', latitude: 52.55, longitude: 13.41, manually_deleted: 0 },
      { id: 'visible-outside', latitude: 52.65, longitude: 13.4, manually_deleted: 0 },
      { id: 'hidden-outside', latitude: 52.65, longitude: 13.41, manually_deleted: 1 },
    ]);

    const result = recheckRecentAreaListings(JOB, { now: 2_000_000_000_000, days: 14 });

    expect(getRecentAreaRecheckCandidates).toHaveBeenCalledWith('job-1', 2_000_000_000_000 - 14 * 86_400_000);
    expect(deleteListingsById).toHaveBeenCalledWith(['hidden-inside'], true);
    expect(deleteListingsById).toHaveBeenCalledWith(['visible-outside']);
    expect(result).toMatchObject({ checked: 4, requeued: 1, hidden: 1 });
  });

  it('does not rewrite rows whose current visibility already matches the polygon', () => {
    getRecentAreaRecheckCandidates.mockReturnValue([
      { id: 'visible-inside', latitude: 52.55, longitude: 13.4, manually_deleted: 0 },
      { id: 'hidden-outside', latitude: 52.65, longitude: 13.4, manually_deleted: 1 },
    ]);

    const result = recheckRecentAreaListings(JOB, { now: 2_000_000_000_000 });

    expect(deleteListingsById).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 2, requeued: 0, hidden: 0 });
  });

  it('refuses a job without a polygon', () => {
    expect(() => recheckRecentAreaListings({ id: 'job-1', spatialFilter: null })).toThrow('Job has no polygon filter.');
    expect(getRecentAreaRecheckCandidates).not.toHaveBeenCalled();
  });
});
