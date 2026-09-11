/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as provider from '../../lib/provider/dpf.js';

const SEARCH_URL = 'https://www.dpfonline.de/interessenten/angebote/';
let runConfig;

function card({
  id = '075.009.03',
  link = '/immobilien/mittelstrasse-3/',
  title = 'Mittelstraße 3 – attraktive 3 Zimmer mit Balkon',
  price = '1.291,92 €',
  size = '92,28 m²',
  rooms = '3',
  address = 'Mittelstraße 3, 13158 Berlin',
  features = 'Dusche Balkon',
  image = '/wp-content/uploads/wohnung.jpg',
} = {}) {
  return `
    <div class="uk-width-1-1 immo-archive-cc">
      <div class="immo-a-thumb" style="background: url(${image}) no-repeat center center !important;"></div>
      <div class="immo-a-info">
        <div class="uk-width-1-1 trenner">
          <h3><a href="${link}">${title}</a></h3>
          <ul class="uk-list">
            <li>${address}</li>
            <li>${features}</li>
          </ul>
        </div>
        <div class="uk-width-medium-1-4"><span class="immo-data">${price}</span>Kaltmiete</div>
        <div class="uk-width-medium-1-4"><span class="immo-data">${size}</span>Wohnfläche</div>
        <div class="uk-width-medium-1-4"><span class="immo-data">${rooms}</span>Zimmer</div>
        <div class="uk-width-medium-1-4">ID <span class="immo-data-id">${id}</span></div>
      </div>
    </div>`;
}

const PAGE = `
  <main>
    ${card()}
    ${card({
      id: '75.028.09',
      link: '/immobilien/tiefgaragenstellplatz/',
      title: 'Nur noch 1 Tiefgaragenstellplatz',
      price: '95,20 €',
      size: '0,00 m²',
      rooms: '0',
      address: 'Mittelstraße 2-3, 13158 Berlin',
      features: '',
    })}
  </main>`;

describe('#dpf provider', () => {
  beforeEach(() => {
    runConfig = provider.createConfig({ enabled: true, url: SEARCH_URL }, []);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses public housing offers and ignores parking-only cards', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => PAGE });
    vi.stubGlobal('fetch', fetchMock);

    const rawListings = await runConfig.getListings(SEARCH_URL);
    const listing = runConfig.normalize(rawListings[0]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rawListings).toHaveLength(1);
    expect(listing.id).toBeTypeOf('string');
    expect(listing.link).toBe('https://www.dpfonline.de/immobilien/mittelstrasse-3/');
    expect(listing.title).toContain('attraktive 3 Zimmer');
    expect(listing.price).toBe(1291.92);
    expect(listing.size).toBe(92.28);
    expect(listing.rooms).toBe(3);
    expect(listing.address).toBe('Mittelstraße 3, 13158 Berlin, Deutschland');
    expect(listing.image).toBe('https://www.dpfonline.de/wp-content/uploads/wohnung.jpg');
    expect(listing.description).toBe('Ausstattung: Dusche Balkon');
    expect(runConfig.filter(listing)).toBe(true);
  });

  it('applies the configured job blacklist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => PAGE }));
    const rawListings = await runConfig.getListings(SEARCH_URL);
    const listing = runConfig.normalize(rawListings[0]);
    const filteringConfig = provider.createConfig({ enabled: true, url: SEARCH_URL }, ['Balkon']);

    expect(filteringConfig.filter(listing)).toBe(false);
  });

  it('returns no listings when DPF cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' }));

    await expect(runConfig.getListings(SEARCH_URL)).resolves.toEqual([]);
  });
});
