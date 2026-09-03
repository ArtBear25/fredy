/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as provider from '../../lib/provider/howoge.js';

const SEARCH_URL = 'https://www.howoge.de/immobiliensuche/wohnungssuche.html';

const APARTMENT = {
  uid: 7094,
  title: 'Streitstraße 5, 13587 Berlin',
  image: '/fileadmin/_processed_/wohnung.webp',
  district: 'Hakenfelde',
  rent: 803,
  area: 73,
  rooms: 3,
  wbs: 'ja',
  features: ['WBS erforderlich', 'Bad mit Dusche', 'Aufzug'],
  coordinates: { lat: '52.5575599', lng: '13.209115' },
  link: '/immobiliensuche/wohnungssuche/detail/1771-14536-9997.html',
  notice: ' 3-Zimmer-Wohnung (WBS 100-140)',
};

const PROJECT = {
  title: 'Alle Wohneinheiten in der Huronseestraße',
  address: 'Huronseestraße 28-34, 10319 Berlin',
  coordinates: { lat: '52.497855277202675', lng: '13.497018897526198' },
  link: 'https://www.howoge.de/immobiliensuche/neubauprojekte/huronseestrasse-28-34.html',
};

function projectCard({
  link,
  notice = 'Wohnung in Berlin',
  district = 'Friedrichsfelde',
  address = 'Huronseestraße 34, 10319 Berlin',
  rent = '600,50 €',
  area = '40,25 m²',
  rooms = '1',
} = {}) {
  return `
    <a class="flat-single" href="${link}">
      <div class="image"><img src="/images/project-flat.webp"></div>
      <div class="content">
        <div class="notice">${notice}</div>
        <div class="district">${district}</div>
        <div class="address">${address}</div>
        <div class="attributes">
          <div><div class="attributes-headline">Warmmiete</div><div class="attributes-content">${rent}</div></div>
          <div><div class="attributes-headline">Wohnfläche</div><div class="attributes-content">${area}</div></div>
          <div><div class="attributes-headline">Zimmer</div><div class="attributes-content">${rooms}</div></div>
        </div>
        <div class="features"><div class="feature">WBS erforderlich</div><div class="feature">Aufzug</div></div>
      </div>
    </a>`;
}

const PROJECT_PAGE = `
  <main>
    ${projectCard({ link: APARTMENT.link })}
    ${projectCard({ link: '/immobiliensuche/wohnungssuche/detail/1770-20575-121.html' })}
  </main>`;

const API_RESPONSE = {
  immocount: 62,
  teasercount: 24,
  immoobjects: [
    APARTMENT,
    { ...APARTMENT },
    {
      ...APARTMENT,
      uid: 9999,
      link: '/immobiliensuche/neubauprojekte/beispielprojekt.html',
    },
  ],
  projectteaser: [PROJECT],
};

const DETAIL_PAGE = `
  <main>
    <table>
      <tr><th>Kaltmiete:</th><td>511,00 €</td></tr>
      <tr><th>Nebenkosten:</th><td>292,00 €</td></tr>
      <tr><th>Warmmiete:</th><td>803,00 €</td></tr>
    </table>
  </main>`;

const PROJECT_DETAIL_PAGE = `
  <main>
    <table>
      <tr><th>Kaltmiete:</th><td>450,25 €</td></tr>
      <tr><th>Warmmiete:</th><td>600,50 €</td></tr>
    </table>
  </main>`;

describe('#howoge provider', () => {
  beforeEach(() => {
    provider.init({ enabled: true, url: SEARCH_URL }, []);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges direct and project apartments while removing repeated detail links', async () => {
    const fetchMock = vi.fn(async (url) =>
      String(url).includes('/neubauprojekte/')
        ? { ok: true, status: 200, text: async () => PROJECT_PAGE }
        : { ok: true, status: 200, json: async () => API_RESPONSE },
    );
    vi.stubGlobal('fetch', fetchMock);

    const rawListings = await provider.config.getListings(provider.config.url);

    expect(provider.config.url).toContain('tx_howrealestate_json_list[action]=immoList');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[0][1].body.get('tx_howrealestate_json_list[limit]')).toBe('100');
    expect(fetchMock.mock.calls[1][1].method).toBeUndefined();
    expect(rawListings).toHaveLength(2);
    expect(rawListings[0]).toEqual(APARTMENT);
    expect(rawListings[1].link).toBe('https://www.howoge.de/immobiliensuche/wohnungssuche/detail/1770-20575-121.html');
  });

  it('normalizes listing data without treating API Warmmiete as the price', () => {
    const listing = provider.config.normalize(APARTMENT);

    expect(listing.id).toBeTypeOf('string');
    expect(listing.link).toBe('https://www.howoge.de/immobiliensuche/wohnungssuche/detail/1771-14536-9997.html');
    expect(listing.title).toBe('3-Zimmer-Wohnung (WBS 100-140)');
    expect(listing.price).toBeNull();
    expect(listing.size).toBe(73);
    expect(listing.rooms).toBe(3);
    expect(listing.address).toBe('Streitstraße 5, 13587 Berlin, Hakenfelde, Deutschland');
    expect(listing.image).toBe('https://www.howoge.de/fileadmin/_processed_/wohnung.webp');
    expect(listing.latitude).toBe(52.5575599);
    expect(listing.longitude).toBe(13.209115);
    expect(listing.description).toContain('WBS erforderlich');
    expect(listing.description).toContain('Aufzug');
  });

  it('loads Kaltmiete from the detail page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => DETAIL_PAGE }));
    const listing = provider.config.normalize(APARTMENT);

    const enriched = await provider.config.fetchDetails(listing);

    expect(provider.config.fetchDetailsAlways).toBe(true);
    expect(enriched.price).toBe(511);
  });

  it('uses a stable id that does not change with the rent', () => {
    const original = provider.config.normalize(APARTMENT);
    const changedRent = provider.config.normalize({ ...APARTMENT, rent: 999 });

    expect(changedRent.id).toBe(original.id);
  });

  it('normalizes complete apartment cards from project pages', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/wohnungssuche/detail/')) {
        return { ok: true, status: 200, text: async () => PROJECT_DETAIL_PAGE };
      }
      if (String(url).includes('/neubauprojekte/')) {
        return { ok: true, status: 200, text: async () => PROJECT_PAGE };
      }
      return { ok: true, status: 200, json: async () => API_RESPONSE };
    });
    vi.stubGlobal('fetch', fetchMock);

    const rawListings = await provider.config.getListings(provider.config.url);
    const projectListing = provider.config.normalize(rawListings[1]);
    const enriched = await provider.config.fetchDetails(projectListing);

    expect(projectListing.title).toBe('Wohnung in Berlin');
    expect(projectListing.price).toBeNull();
    expect(enriched.price).toBe(450.25);
    expect(projectListing.size).toBe(40.25);
    expect(projectListing.rooms).toBe(1);
    expect(projectListing.address).toBe('Huronseestraße 34, 10319 Berlin, Friedrichsfelde, Deutschland');
    expect(projectListing.image).toBe('https://www.howoge.de/images/project-flat.webp');
    expect(projectListing.latitude).toBe(52.497855277202675);
    expect(projectListing.longitude).toBe(13.497018897526198);
    expect(projectListing.description).toContain('Alle Wohneinheiten in der Huronseestraße');
    expect(projectListing.description).toContain('WBS erforderlich');
  });

  it('applies the configured blacklist to result title, features and address', () => {
    const listing = provider.config.normalize(APARTMENT);
    expect(provider.config.filter(listing)).toBe(true);

    provider.init({ enabled: true, url: SEARCH_URL }, ['Aufzug']);
    expect(provider.config.filter(listing)).toBe(false);

    provider.init({ enabled: true, url: SEARCH_URL }, ['Hakenfelde']);
    expect(provider.config.filter(listing)).toBe(false);
  });

  it('returns an empty list for an unsuccessful API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(provider.config.getListings(provider.config.url)).resolves.toEqual([]);
  });

  it('keeps the price empty when the detail page is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const listing = provider.config.normalize(APARTMENT);

    const enriched = await provider.config.fetchDetails(listing);

    expect(enriched.price).toBeNull();
  });
});
