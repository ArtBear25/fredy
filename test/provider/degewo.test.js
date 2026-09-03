/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as provider from '../../lib/provider/degewo.js';

const SEARCH_URL = 'https://www.degewo.de/immosuche#immo-teaser-list';

function resultCard({
  id = 'W1000.00001.0001-0101',
  link = '/immosuche/details/helle-wohnung',
  title = 'Helle Wohnung',
  price = '850,25 €',
  rooms = '2',
  size = '51,50',
  address = 'Lützowstraße 7 | Tiergarten',
} = {}) {
  return `
    <div class="c-teaser c-teaser--apartment">
      <div class="c-teaser__inner">
        <figure><img class="c-img" src="/images/wohnung.jpg"></figure>
        <button data-openimmo-bookmark-item-uid="${id}"></button>
        <div class="c-copy">
          <h3><a href="${link}">${title}</a></h3>
          <p>${address}</p>
          <span class="c-tag__label">Aufzug</span>
          <div class="c-definition-list__item"><dt>${price}</dt><dd>Warmmiete</dd></div>
          <div class="c-definition-list__item"><dt>${rooms}</dt><dd>Zimmer</dd></div>
          <div class="c-definition-list__item"><dt>${size}</dt><dd>m²</dd></div>
          <div class="c-definition-list__item"><dt>sofort</dt><dd>frei ab</dd></div>
        </div>
      </div>
    </div>`;
}

const FIRST_PAGE = `
  <main>
    ${resultCard()}
    <a class="c-pagination__link c-pagination__link--next"
       href="/immosuche?tx_openimmo_immobilie%5Bpage%5D=2">Zur nächsten Seite</a>
  </main>`;

const SECOND_PAGE = `
  <main>
    ${resultCard()}
    ${resultCard({
      id: 'W2000.00002.0002-0202',
      link: '/immosuche/details/wbs-wohnung',
      title: 'WBS-Wohnung',
      price: '499,00 €',
      rooms: '1,5',
      size: '39,25',
      address: 'Wittenberger Straße 57 | Marzahn Nord-West',
    })}
  </main>`;

function sortOptions() {
  return `
    <select id="select-sort-order">
      <option value="/immosuche?tx_openimmo_immobilie%5Bsearch%5D=restore&amp;tx_openimmo_immobilie%5BsortBy%5D=immobilie_flaechen_anzahlZimmer&amp;cHash=rooms">Anzahl Zimmer</option>
      <option value="/immosuche?tx_openimmo_immobilie%5Bsearch%5D=restore&amp;tx_openimmo_immobilie%5BsortBy%5D=immobilie_preise_warmmiete&amp;cHash=rent">Warmmiete</option>
      <option value="/immosuche?tx_openimmo_immobilie%5Bsearch%5D=restore&amp;tx_openimmo_immobilie%5BsortBy%5D=immobilie_flaechen_wohnflaeche&amp;cHash=size">Wohnfläche</option>
    </select>`;
}

function sortedPage(cards, nextUrl = null) {
  return `
    <main>
      <p class="results-count">4 Ergebnisse</p>
      ${sortOptions()}
      ${cards.join('\n')}
      ${nextUrl ? `<a class="c-pagination__link c-pagination__link--next" href="${nextUrl}">Weiter</a>` : ''}
    </main>`;
}

const DEFAULT_SORT_PAGE = sortedPage([resultCard()]);
const RENT_PAGE_ONE = sortedPage(
  [resultCard(), resultCard({ id: 'W2000', link: '/immosuche/details/zwei', title: 'Zwei' })],
  '/immosuche?tx_openimmo_immobilie%5Bpage%5D=2&tx_openimmo_immobilie%5BsortBy%5D=immobilie_preise_warmmiete',
);
const RENT_PAGE_TWO = sortedPage([
  resultCard(),
  resultCard({ id: 'W3000', link: '/immosuche/details/drei', title: 'Drei' }),
]);
const SIZE_PAGE_ONE = sortedPage(
  [resultCard(), resultCard({ id: 'W2000', link: '/immosuche/details/zwei', title: 'Zwei' })],
  '/immosuche?tx_openimmo_immobilie%5Bpage%5D=2&tx_openimmo_immobilie%5BsortBy%5D=immobilie_flaechen_wohnflaeche',
);
const SIZE_PAGE_TWO = sortedPage([
  resultCard({ id: 'W3000', link: '/immosuche/details/drei', title: 'Drei' }),
  resultCard({ id: 'W4000', link: '/immosuche/details/vier', title: 'Vier' }),
]);

const DETAIL_PAGE = `
  <main>
    <div class="c-definition-list__item"><dt>Nettokaltmiete</dt><dd>650,25 €</dd></div>
    <img src="/fileadmin/user_upload/tx_openimmo/connection-1/images/detail.jpg">
    <div class="c-copy"><h3>Beschreibung</h3><p>Ab sofort verfügbar.</p></div>
    <div class="c-copy"><h3>Ausstattung</h3><p>Balkon und Aufzug</p></div>
    <div class="c-copy"><h3>Wichtige Hinweise</h3><p>Unbefristeter Mietvertrag.</p></div>
    <div><h3>Adresse: Lützowstraße 7, 10785 Berlin</h3></div>
    <div class="c-gmap__map" data-lat="52.5025804" data-long="13.3698663"></div>
  </main>`;

describe('#degewo provider', () => {
  beforeEach(() => {
    provider.init({ enabled: true, url: SEARCH_URL }, []);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('paginates, removes repeated offers and normalizes result cards', async () => {
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      text: async () => (String(url).includes('page%5D=2') ? SECOND_PAGE : FIRST_PAGE),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const rawListings = await provider.config.getListings(SEARCH_URL);
    const listing = provider.config.normalize(rawListings[0]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rawListings).toHaveLength(2);
    expect(listing.id).toBeTypeOf('string');
    expect(listing.link).toBe('https://www.degewo.de/immosuche/details/helle-wohnung');
    expect(listing.title).toBe('Helle Wohnung');
    expect(listing.price).toBeNull();
    expect(listing.rooms).toBe(2);
    expect(listing.size).toBe(51.5);
    expect(listing.address).toBe('Lützowstraße 7, Tiergarten, Deutschland');
    expect(listing.image).toBe('https://www.degewo.de/images/wohnung.jpg');
    expect(listing.description).toContain('Frei ab: sofort');
    expect(listing.description).toContain('Ausstattung: Aufzug');
  });

  it('uses stable sorting and falls back when pagination still overlaps', async () => {
    const fetchMock = vi.fn(async (url) => {
      const parsedUrl = new URL(String(url));
      const sortBy = parsedUrl.searchParams.get('tx_openimmo_immobilie[sortBy]');
      const page = parsedUrl.searchParams.get('tx_openimmo_immobilie[page]');
      let html = DEFAULT_SORT_PAGE;

      if (sortBy === 'immobilie_preise_warmmiete') html = page === '2' ? RENT_PAGE_TWO : RENT_PAGE_ONE;
      if (sortBy === 'immobilie_flaechen_wohnflaeche') html = page === '2' ? SIZE_PAGE_TWO : SIZE_PAGE_ONE;

      return {
        ok: true,
        status: 200,
        url: String(url),
        headers: {
          getSetCookie: () => (sortBy == null ? ['tx_openimmo_session=test-session; Path=/; HttpOnly; Secure'] : []),
        },
        text: async () => html,
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const rawListings = await provider.config.getListings(SEARCH_URL);

    expect(rawListings).toHaveLength(4);
    expect(new Set(rawListings.map((listing) => listing.id)).size).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[1][1].headers.Cookie).toBe('tx_openimmo_session=test-session');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('immobilie_preise_warmmiete'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('immobilie_flaechen_wohnflaeche'))).toBe(true);
  });

  it('applies the configured blacklist to title and result details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => FIRST_PAGE }));
    const rawListings = await provider.config.getListings(SEARCH_URL);
    const listing = provider.config.normalize(rawListings[0]);

    expect(provider.config.filter(listing)).toBe(true);

    provider.init({ enabled: true, url: SEARCH_URL }, ['Aufzug']);
    expect(provider.config.filter(listing)).toBe(false);
  });

  it('enriches a listing with public detail-page data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => DETAIL_PAGE }));
    const listing = provider.config.normalize({
      id: 'W1000.00001.0001-0101',
      link: '/immosuche/details/helle-wohnung',
      title: 'Helle Wohnung',
      price: '850,25 €',
      rooms: '2',
      size: '51,50',
      address: 'Lützowstraße 7 | Tiergarten',
      image: null,
      description: 'Frei ab: sofort',
    });

    const enriched = await provider.config.fetchDetails(listing);

    expect(provider.config.fetchDetailsAlways).toBe(true);
    expect(provider.config.fetchDetailsForSpatialFilter).toBe(true);
    expect(provider.config.requireCoordinatesForSpatialFilter).toBe(true);

    expect(enriched.price).toBe(650.25);
    expect(enriched.address).toBe('Lützowstraße 7, 10785 Berlin, Deutschland');
    expect(enriched.image).toBe(
      'https://www.degewo.de/fileadmin/user_upload/tx_openimmo/connection-1/images/detail.jpg',
    );
    expect(enriched.latitude).toBe(52.5025804);
    expect(enriched.longitude).toBe(13.3698663);
    expect(enriched.description).toContain('Ab sofort verfügbar.');
    expect(enriched.description).toContain('Balkon und Aufzug');
    expect(enriched.description).toContain('Unbefristeter Mietvertrag.');
  });

  it('keeps the price empty when the detail page has no Nettokaltmiete', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '<main></main>' }));
    const listing = provider.config.normalize({
      id: 'W1000.00001.0001-0101',
      link: '/immosuche/details/helle-wohnung',
      title: 'Helle Wohnung',
      rooms: '2',
      size: '51,50',
      address: 'Lützowstraße 7 | Tiergarten',
    });

    const enriched = await provider.config.fetchDetails(listing);

    expect(enriched.price).toBeNull();
  });
});
