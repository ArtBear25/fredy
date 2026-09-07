/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect, vi } from 'vitest';
import * as similarityCache from '../../lib/services/similarity-check/similarityCache.js';
import { mockFredy, providerConfig } from '../utils.js';
import { get } from '../mocks/mockNotification.js';
import * as provider from '../../lib/provider/immoscout.js';

/** Run-scoped provider config, built per test via createConfig(). */
let runConfig;

// immoscout uses the mobile REST API (fetch-based, no browser). Both tests share
// the same module-level listings so the API is only queried once, avoiding
// duplicate requests that could trigger rate-limiting.
const TEST_TIMEOUT = 120_000;

describe('#immoscout provider testsuite()', () => {
  runConfig = provider.createConfig(providerConfig.immoscout, [], []);

  let liveListings;

  it.each([
    ['Gewobag Wohnungsbau-Aktiengesellschaft Berlin', 'gewobag'],
    ['degewo AG', 'degewo'],
    ['HOWOGE Wohnungsbaugesellschaft mbH', 'howoge'],
    ['WBM Wohnungsbaugesellschaft Berlin-Mitte mbH', 'wbm'],
    ['GESOBAU AG', 'gesobau'],
    ['berlinovo Immobilien Gesellschaft mbH', 'berlinovo'],
    ['STADT UND LAND Wohnbauten-Gesellschaft mbH', 'stadtundland'],
  ])('maps Scout company %s to %s', (company, providerId) => {
    expect(provider.officialProviderFromScoutCompany(company)).toBe(providerId);
  });

  it('leaves an unknown Scout company unrouted', () => {
    expect(provider.officialProviderFromScoutCompany('Makler Mustermann GmbH')).toBe(null);
  });

  it('copies the structured Scout company to officialProvider during detail enrichment', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        contact: { contactData: { agent: { company: 'Gewobag Wohnungsbau-Aktiengesellschaft Berlin' } } },
        sections: [],
      }),
    });
    try {
      const listing = runConfig.normalize({
        id: 'gewobag-1',
        title: 'Im Wedding!',
        price: '693 €',
        size: '88 m²',
        rooms: '2 Zi.',
        link: 'https://www.immobilienscout24.de/expose/1',
        address: 'Buttmannstr. 4, 13357 Berlin',
      });
      const enriched = await runConfig.fetchDetails(listing);
      expect(enriched.officialProvider).toBe('gewobag');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('preserves postcode/city while removing a parenthesized district suffix', () => {
    const listing = runConfig.normalize({
      id: 'dolgensee-38',
      title: 'Wohnung',
      price: '619 €',
      size: '63 m²',
      rooms: '2 Zi.',
      link: 'https://www.immobilienscout24.de/expose/1',
      address: 'Dolgenseestr. 38 (Friedrichsfelde), 10319 Berlin',
    });

    expect(listing.address).toBe('Dolgenseestr. 38, 10319 Berlin');
    expect(listing.rooms).toBe(2);
  });

  it(
    'should test immoscout provider',
    async () => {
      const Fredy = await mockFredy();
      const mockedJob = {
        id: '',
        notificationAdapter: null,
        spatialFilter: null,
        specFilter: null,
      };

      return await new Promise((resolve, reject) => {
        const fredy = new Fredy(runConfig, mockedJob, provider.metaInformation.id, similarityCache, undefined);
        fredy.execute().then((listings) => {
          if (listings == null || listings.length === 0) {
            reject('Listings is empty!');
            return;
          }

          liveListings = listings;
          expect(listings).toBeInstanceOf(Array);
          const notificationObj = get();
          expect(notificationObj).toBeTypeOf('object');

          // check if there is at least one valid notification
          const hasValidNotification = notificationObj.payload.some((notify) => {
            return (
              typeof notify.id === 'string' &&
              typeof notify.price === 'string' &&
              notify.price.includes('€') &&
              typeof notify.size === 'string' &&
              notify.size.includes('m²') &&
              typeof notify.title === 'string' &&
              notify.title !== '' &&
              typeof notify.link === 'string' &&
              notify.link.includes('https://www.immobilienscout24.de/') &&
              typeof notify.address === 'string'
            );
          });

          expect(hasValidNotification).toBe(true);
          resolve();
        });
      });
    },
    TEST_TIMEOUT,
  );

  describe('with provider_details enabled', () => {
    it(
      'should enrich listings with details',
      async () => {
        if (!liveListings?.length) throw new Error('No listings from first test to enrich');

        // Call fetchDetails directly on the first live listing - no need to
        // re-query the search API. immoscout uses fetch (no browser).
        const enriched = await runConfig.fetchDetails(liveListings[0]);

        expect(enriched).toBeTruthy();
        expect(enriched.description).toBeTypeOf('string');
        expect(enriched.description).not.toBe('');
      },
      TEST_TIMEOUT,
    );
  });
});
