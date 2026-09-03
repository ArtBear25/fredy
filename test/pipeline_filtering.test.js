/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, expect, vi } from 'vitest';
import { mockFredy, sseEvents } from './utils.js';
import * as mockStore from './mocks/mockStore.js';
import { get as getLastNotification } from './mocks/mockNotification.js';

describe('Issue reproduction: listings filtered by similarity or area should be marked as manually deleted', () => {
  it('should call deleteListingsById when listings are filtered by similarity', async () => {
    const Fredy = await mockFredy();

    const mockSimilarityCache = {
      checkAndAddEntry: vi.fn(() => true), // always similar
    };

    const providerConfig = {
      url: 'http://example.com',
      getListings: () =>
        Promise.resolve([{ id: '1', title: 'test', address: 'addr', price: '100', link: 'http://example.com/1' }]),
      normalize: (l) => l,
      filter: () => true,
      crawlFields: { id: 'id', title: 'title', address: 'address', price: 'price' },
      requiredFieldNames: ['id', 'title', 'address', 'price'],
    };

    const mockedJob = {
      id: 'test-job',
      notificationAdapter: null,
      specFilter: null,
      spatialFilter: null,
    };

    const fredy = new Fredy(providerConfig, mockedJob, 'test-provider', mockSimilarityCache, undefined);

    // Clear deletedIds before test
    mockStore.deletedIds.length = 0;

    try {
      await fredy.execute();
    } catch {
      // Might throw NoNewListingsWarning if all are filtered out
    }

    expect(mockStore.deletedIds).toContain('1');
    // The provider id travels with the listing: the cache only ever treats two listings as the
    // same flat when they came from different providers.
    expect(mockSimilarityCache.checkAndAddEntry).toHaveBeenCalledWith({
      jobId: 'test-job',
      provider: 'test-provider',
      title: 'test',
      address: 'addr',
      price: '100',
      size: undefined,
      rooms: undefined,
      description: undefined,
    });
  });

  it('should pass the shared browser to a custom getListings implementation', async () => {
    const Fredy = await mockFredy();
    const browser = { connected: true };
    const getListings = vi.fn().mockResolvedValue([]);
    const providerConfig = {
      url: 'http://example.com',
      getListings,
      normalize: (listing) => listing,
      filter: () => true,
      crawlFields: {},
      requiredFieldNames: [],
    };
    const mockedJob = {
      id: 'custom-get-listings-browser',
      notificationAdapter: null,
      specFilter: null,
      spatialFilter: null,
    };

    const fredy = new Fredy(providerConfig, mockedJob, 'custom-provider', {}, browser);
    await fredy.execute();

    expect(getListings).toHaveBeenCalledWith('http://example.com', browser);
    expect(getListings.mock.contexts[0]).toBe(fredy);
  });

  it('should call deleteListingsById when listings are filtered by area', async () => {
    const Fredy = await mockFredy();

    const mockSimilarityCache = {
      checkAndAddEntry: () => false, // never similar
    };

    const spatialFilter = {
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [0, 1],
                [1, 1],
                [1, 0],
                [0, 0],
              ],
            ],
          },
        },
      ],
    };

    const mockedJob = {
      id: 'test-job',
      notificationAdapter: null,
      specFilter: null,
      spatialFilter: spatialFilter,
    };

    const providerConfig = {
      url: 'http://example.com',
      getListings: () =>
        Promise.resolve([
          {
            id: '2',
            title: 'test',
            address: 'addr',
            price: '100',
            latitude: 2,
            longitude: 2,
            link: 'http://example.com/2',
          },
        ]), // outside polygon
      normalize: (l) => l,
      filter: () => true,
      crawlFields: { id: 'id', title: 'title', address: 'address', price: 'price' },
      requiredFieldNames: ['id', 'title', 'address', 'price'],
    };

    const fredy = new Fredy(providerConfig, mockedJob, 'test-provider', mockSimilarityCache, undefined);

    mockStore.deletedIds.length = 0;

    try {
      await fredy.execute();
    } catch {
      // Might throw NoNewListingsWarning if all are filtered out
    }

    expect(mockStore.deletedIds).toContain('2');
  });
});

describe('Provider coordinates required by a spatial filter', () => {
  afterEach(() => {
    mockStore.setUserSettings(null);
    mockStore.deletedIds.length = 0;
  });

  it('loads Degewo-style detail coordinates without provider details and rejects an outside listing', async () => {
    const Fredy = await mockFredy();
    const providerId = 'degewo-spatial-test';
    const fetchDetails = vi.fn((listing) =>
      Promise.resolve({
        ...listing,
        address: 'Wörlitzer Straße 26, 12689 Berlin, Deutschland',
        latitude: 52.56675,
        longitude: 13.56998,
      }),
    );

    mockStore.setUserSettings({ provider_details: [] });
    const providerConfig = {
      url: 'https://www.degewo.de/immosuche',
      getListings: () =>
        Promise.resolve([
          {
            id: 'woerlitzer-26',
            title: 'Singlewohnung für Berufseinsteiger im Norden von Marzahn',
            address: 'Wörlitzer Straße 26, Marzahn Nord-West, Deutschland',
            price: 403.15,
            size: 32.6,
            link: 'https://www.degewo.de/immosuche/details/woerlitzer-26',
          },
        ]),
      normalize: (listing) => listing,
      filter: () => true,
      fetchDetails,
      fetchDetailsForSpatialFilter: true,
      requireCoordinatesForSpatialFilter: true,
      crawlFields: { id: 'id', title: 'title', address: 'address', price: 'price', size: 'size', link: 'link' },
      requiredFieldNames: ['id', 'title', 'address', 'price', 'size', 'link'],
    };
    const mockedJob = {
      id: 'degewo-spatial-job',
      notificationAdapter: null,
      specFilter: { maxPrice: 540, minSize: 30 },
      spatialFilter: {
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [13.28, 52.47],
                  [13.28, 52.56],
                  [13.53, 52.56],
                  [13.53, 52.47],
                  [13.28, 52.47],
                ],
              ],
            },
          },
        ],
      },
    };

    const fredy = new Fredy(providerConfig, mockedJob, providerId, { checkAndAddEntry: () => false }, undefined);
    const result = await fredy.execute();

    expect(fetchDetails).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
    expect(mockStore.deletedIds).toContain('woerlitzer-26');
  });

  it('withholds an unlocated listing before storage so a later scan can retry it', async () => {
    const Fredy = await mockFredy();
    const providerId = 'strict-spatial-retry-test';
    mockStore.setUserSettings({ provider_details: [] });
    const providerConfig = {
      url: 'https://example.com/search',
      getListings: () =>
        Promise.resolve([
          {
            id: 'temporarily-unlocated',
            title: 'Wohnung ohne Koordinaten',
            address: 'Unbekannte Adresse',
            price: 400,
            link: 'https://example.com/listing',
          },
        ]),
      normalize: (listing) => listing,
      filter: () => true,
      fetchDetails: (listing) => Promise.resolve(listing),
      fetchDetailsForSpatialFilter: true,
      requireCoordinatesForSpatialFilter: true,
      crawlFields: { id: 'id', title: 'title', address: 'address', price: 'price', link: 'link' },
      requiredFieldNames: ['id', 'title', 'address', 'price', 'link'],
    };
    const mockedJob = {
      id: 'strict-spatial-retry-job',
      notificationAdapter: null,
      specFilter: null,
      spatialFilter: {
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [13.28, 52.47],
                  [13.28, 52.56],
                  [13.53, 52.56],
                  [13.53, 52.47],
                  [13.28, 52.47],
                ],
              ],
            },
          },
        ],
      },
    };
    const fredy = new Fredy(providerConfig, mockedJob, providerId, { checkAndAddEntry: () => false }, undefined);

    const result = await fredy.execute();

    expect(result).toBeUndefined();
    expect(mockStore.getKnownListingHashesForJobAndProvider(mockedJob.id, providerId)).toEqual([]);
    expect(mockStore.deletedIds).toEqual([]);
  });
});

describe('Provider details required for authoritative prices', () => {
  afterEach(() => {
    mockStore.setUserSettings(null);
    mockStore.deletedIds.length = 0;
  });

  function createPriceProvider(fetchDetails) {
    return {
      url: 'https://example.com/search',
      getListings: () =>
        Promise.resolve([
          {
            id: 'cold-rent-listing',
            title: 'Wohnung mit abweichender Warmmiete',
            address: 'Beispielstraße 1',
            price: null,
            warmPrice: 803,
            link: 'https://example.com/listing',
          },
        ]),
      normalize: (listing) => listing,
      filter: () => true,
      fetchDetails,
      fetchDetailsAlways: true,
      crawlFields: { id: 'id', title: 'title', address: 'address', price: 'price', link: 'link' },
      requiredFieldNames: ['id', 'title', 'address', 'price', 'link'],
    };
  }

  function createPriceJob(id) {
    return {
      id,
      notificationAdapter: null,
      specFilter: { maxPrice: 600 },
      spatialFilter: null,
    };
  }

  it('loads required details without a user opt-in and filters against Kaltmiete', async () => {
    const Fredy = await mockFredy();
    const fetchDetails = vi.fn((listing) => Promise.resolve({ ...listing, price: 511 }));
    const providerId = 'required-cold-rent-provider';
    mockStore.setUserSettings({ provider_details: [] });
    const fredy = new Fredy(
      createPriceProvider(fetchDetails),
      createPriceJob('required-cold-rent-job'),
      providerId,
      { checkAndAddEntry: () => false },
      undefined,
    );

    const result = await fredy.execute();

    expect(fetchDetails).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].price).toBe(511);
    expect(getLastNotification().payload[0].price).toBe('511 €');
    expect(mockStore.deletedIds).toEqual([]);
  });

  it('withholds an offer when its Kaltmiete exceeds the configured maximum', async () => {
    const Fredy = await mockFredy();
    const providerId = 'expensive-cold-rent-provider';
    mockStore.setUserSettings({ provider_details: [] });
    const fredy = new Fredy(
      createPriceProvider((listing) => Promise.resolve({ ...listing, price: 650 })),
      createPriceJob('expensive-cold-rent-job'),
      providerId,
      { checkAndAddEntry: () => false },
      undefined,
    );

    const result = await fredy.execute();

    expect(result).toBeUndefined();
    expect(mockStore.getKnownListingHashesForJobAndProvider('expensive-cold-rent-job', providerId)).toEqual([]);
    expect(mockStore.deletedIds).toEqual([]);
  });

  it('forwards an offer without price when Kaltmiete cannot be read', async () => {
    const Fredy = await mockFredy();
    const providerId = 'missing-cold-rent-provider';
    mockStore.setUserSettings({ provider_details: [] });
    const fredy = new Fredy(
      createPriceProvider((listing) => Promise.resolve(listing)),
      createPriceJob('missing-cold-rent-job'),
      providerId,
      { checkAndAddEntry: () => false },
      undefined,
    );

    const result = await fredy.execute();

    expect(result).toHaveLength(1);
    expect(result[0].price).toBeNull();
    expect(getLastNotification().payload[0].price).toBeNull();
    expect(mockStore.deletedIds).toEqual([]);
  });
});

describe('Blacklist is re-applied after detail enrichment', () => {
  afterEach(() => {
    mockStore.setUserSettings(null);
  });

  it('filters out a listing whose blacklisted term only appears in the enriched description', async () => {
    const Fredy = await mockFredy();
    const providerId = 'test-provider';

    mockStore.setUserSettings({
      provider_details: [providerId],
      blacklist_filter_on_provider_details: true,
    });

    const mockSimilarityCache = {
      checkAndAddEntry: () => false,
    };

    const blacklist = ['allkauf'];

    // The search results page returns a clean snippet (no blacklisted term).
    // fetchDetails simulates loading the full detail page and discovers the
    // blacklisted term hidden deep in the description.
    const providerConfig = {
      url: 'http://example.com',
      getListings: () =>
        Promise.resolve([
          {
            id: 'kept',
            title: 'Nice house',
            address: 'Some street',
            price: '500000',
            link: 'http://example.com/kept',
            description: 'Cozy home with garden',
          },
          {
            id: 'blacklisted',
            title: 'Eleganz trifft Raumkomfort',
            address: 'Other street',
            price: '600000',
            link: 'http://example.com/blacklisted',
            description: 'Eleganz trifft Raumkomfort',
          },
        ]),
      normalize: (l) => l,
      filter: (l) => {
        const text = `${l.title ?? ''} ${l.description ?? ''}`.toLowerCase();
        return !blacklist.some((term) => text.includes(term));
      },
      fetchDetails: (listing) => {
        if (listing.id === 'blacklisted') {
          return Promise.resolve({
            ...listing,
            description: 'Mit allkauf Haus wird dein Traum vom Eigenheim wahr.',
          });
        }
        return Promise.resolve(listing);
      },
      crawlFields: {
        id: 'id',
        title: 'title',
        address: 'address',
        price: 'price',
        link: 'link',
        description: 'description',
      },
      requiredFieldNames: ['id', 'title', 'address', 'price', 'link', 'description'],
    };

    const mockedJob = {
      id: 'blacklist-test-job',
      notificationAdapter: null,
      specFilter: null,
      spatialFilter: null,
    };

    const fredy = new Fredy(providerConfig, mockedJob, providerId, mockSimilarityCache, undefined);

    const result = await fredy.execute();

    expect(result).toBeInstanceOf(Array);
    const ids = result.map((l) => l.id);
    expect(ids).toContain('kept');
    expect(ids).not.toContain('blacklisted');

    const notification = getLastNotification();
    const notifiedIds = (notification?.payload ?? []).map((p) => p.id);
    expect(notifiedIds).not.toContain('blacklisted');
  });

  it('short-circuits the pipeline when all listings get blacklisted after enrichment', async () => {
    const Fredy = await mockFredy();
    const providerId = 'all-blacklisted-provider';

    mockStore.setUserSettings({
      provider_details: [providerId],
      blacklist_filter_on_provider_details: true,
    });

    const mockSimilarityCache = {
      checkAndAddEntry: () => false,
    };

    const blacklist = ['allkauf'];

    const providerConfig = {
      url: 'http://example.com',
      getListings: () =>
        Promise.resolve([
          {
            id: 'only',
            title: 'Eleganz trifft Raumkomfort',
            address: 'Some street',
            price: '700000',
            link: 'http://example.com/only',
            description: 'Eleganz trifft Raumkomfort',
          },
        ]),
      normalize: (l) => l,
      filter: (l) => {
        const text = `${l.title ?? ''} ${l.description ?? ''}`.toLowerCase();
        return !blacklist.some((term) => text.includes(term));
      },
      fetchDetails: (listing) =>
        Promise.resolve({
          ...listing,
          description: 'Mit allkauf Haus wird dein Traum vom Eigenheim wahr.',
        }),
      crawlFields: {
        id: 'id',
        title: 'title',
        address: 'address',
        price: 'price',
        link: 'link',
        description: 'description',
      },
      requiredFieldNames: ['id', 'title', 'address', 'price', 'link', 'description'],
    };

    const mockedJob = {
      id: 'all-blacklisted-job',
      notificationAdapter: null,
      specFilter: null,
      spatialFilter: null,
    };

    const fredy = new Fredy(providerConfig, mockedJob, providerId, mockSimilarityCache, undefined);

    // Should resolve to undefined (NoNewListingsWarning is caught in _handleError).
    const result = await fredy.execute();
    expect(result).toBeUndefined();
  });

  it('does NOT re-filter when blacklist_filter_on_provider_details is disabled', async () => {
    const Fredy = await mockFredy();
    const providerId = 'opt-out-provider';

    // provider_details enabled (so fetchDetails runs) but blacklist re-filter NOT enabled.
    mockStore.setUserSettings({
      provider_details: [providerId],
      blacklist_filter_on_provider_details: false,
    });

    const mockSimilarityCache = {
      checkAndAddEntry: () => false,
    };

    const blacklist = ['allkauf'];

    const providerConfig = {
      url: 'http://example.com',
      getListings: () =>
        Promise.resolve([
          {
            id: 'leaks-through',
            title: 'Eleganz trifft Raumkomfort',
            address: 'Other street',
            price: '600000',
            link: 'http://example.com/leaks-through',
            description: 'Eleganz trifft Raumkomfort',
          },
        ]),
      normalize: (l) => l,
      filter: (l) => {
        const text = `${l.title ?? ''} ${l.description ?? ''}`.toLowerCase();
        return !blacklist.some((term) => text.includes(term));
      },
      fetchDetails: (listing) =>
        Promise.resolve({
          ...listing,
          description: 'Mit allkauf Haus wird dein Traum vom Eigenheim wahr.',
        }),
      crawlFields: {
        id: 'id',
        title: 'title',
        address: 'address',
        price: 'price',
        link: 'link',
        description: 'description',
      },
      requiredFieldNames: ['id', 'title', 'address', 'price', 'link', 'description'],
    };

    const mockedJob = {
      id: 'opt-out-job',
      notificationAdapter: null,
      specFilter: null,
      spatialFilter: null,
    };

    const fredy = new Fredy(providerConfig, mockedJob, providerId, mockSimilarityCache, undefined);

    const result = await fredy.execute();

    // Listing leaks through because user has not opted in to the stricter check.
    expect(result).toBeInstanceOf(Array);
    expect(result.map((l) => l.id)).toContain('leaks-through');
  });
});

describe('Live reload triggers via SSE', () => {
  afterEach(() => {
    sseEvents.length = 0;
  });

  it('emits a listings:new event via SSE when a new listing is saved', async () => {
    sseEvents.length = 0;
    const Fredy = await mockFredy();

    const mockSimilarityCache = {
      checkAndAddEntry: () => false, // unique listing
    };

    const providerConfig = {
      url: 'http://example.com',
      getListings: () =>
        Promise.resolve([
          {
            id: 'brand-new-listing',
            title: 'Cool Apartment',
            address: 'Awesome Ave',
            price: '500',
            link: 'http://example.com/new',
          },
        ]),
      normalize: (l) => l,
      filter: () => true,
      crawlFields: { id: 'id', title: 'title', address: 'address', price: 'price', link: 'link' },
      requiredFieldNames: ['id', 'title', 'address', 'price', 'link'],
    };

    const mockedJob = {
      id: 'live-reload-job',
      notificationAdapter: null,
      specFilter: null,
      spatialFilter: null,
    };

    const fredy = new Fredy(providerConfig, mockedJob, 'live-reload-provider', mockSimilarityCache, undefined);

    await fredy.execute();

    expect(sseEvents).toHaveLength(1);
    expect(sseEvents[0]).toEqual({
      userId: 'user1',
      event: 'listings:new',
      data: {
        jobId: 'live-reload-job',
        count: 1,
      },
    });
  });
});
