/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as provider from '../../lib/provider/wgf.js';

const SEARCH_URL = 'https://wgf.berlin/services/wohnung-finden/';
let runConfig;

function card({
  link = 'https://wgf.berlin/wohnungsinserat/helle-15-zimmerwohnung-mit-balkon-ze-2a-2b/',
  title = 'Helle 1,5- Zimmerwohnung mit Balkon (ZE 2a, 2b)',
  rooms = '1',
  size = '43,00 m²',
  street = 'Zechliner Str. 2A, 2B',
  city = '13055 Berlin , Hohenschönhausen',
  price = '654,00 €',
  image = 'https://wgf.berlin/wp-content/uploads/2026/06/Gesamtansicht-ZE2AB-scaled.jpg',
} = {}) {
  return `
    <div class="wohnungsangebot-teaser-item">
      <div class="wohnungsangebot-card">
        <div class="wohnungsangebot-text">
          <h4 class="wohnungsangebot-title">${title}</h4>
          <strong>Zimmer:</strong> ${rooms}<br>
          <strong>Größe:</strong> ${size}<br>
          <p>${street}<br>${city}</p>
          <p><strong>Kaltmiete:</strong> ${price}</p>
          <a class="details-button" href="${link}">Details</a>
        </div>
        <div class="wohnungsangebot-image" style="background-image: url('${image}');"></div>
      </div>
    </div>`;
}

const PAGE = `
  <main>
    <div id="wohnung">
      <div class="wohnungsangebote-teaser-grid">
        ${card()}
        ${card({
          link: 'https://wgf.berlin/wohnungsinserat/helle-2-zimmerwohnung-mit-balkon-ze-2a-2b/',
          title: 'Helle 2- Zimmerwohnung mit Balkon (ZE 2a, 2b)',
          rooms: '2',
          size: '63,00 m²',
          price: '958,00 €',
          image: 'https://wgf.berlin/wp-content/uploads/2025/09/10125_1-scaled.jpg',
        })}
      </div>
    </div>
  </main>`;

describe('#wgf provider', () => {
  beforeEach(() => {
    runConfig = provider.createConfig({ enabled: true, url: SEARCH_URL }, []);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses public apartment offers from the WGF result page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => PAGE });
    vi.stubGlobal('fetch', fetchMock);

    const rawListings = await runConfig.getListings(SEARCH_URL);
    const listing = runConfig.normalize(rawListings[0]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rawListings).toHaveLength(2);
    expect(listing.id).toBeTypeOf('string');
    expect(listing.link).toBe('https://wgf.berlin/wohnungsinserat/helle-15-zimmerwohnung-mit-balkon-ze-2a-2b/');
    expect(listing.title).toBe('Helle 1,5- Zimmerwohnung mit Balkon (ZE 2a, 2b)');
    expect(listing.price).toBe(654);
    expect(listing.size).toBe(43);
    expect(listing.rooms).toBe(1.5);
    expect(listing.address).toBe('Zechliner Str. 2A, 2B, 13055 Berlin, Hohenschönhausen, Deutschland');
    expect(listing.image).toBe('https://wgf.berlin/wp-content/uploads/2026/06/Gesamtansicht-ZE2AB-scaled.jpg');
    expect(listing.description).toBeNull();
    expect(runConfig.filter(listing)).toBe(true);
  });

  it('applies the configured job blacklist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => PAGE }));
    const rawListings = await runConfig.getListings(SEARCH_URL);
    const listing = runConfig.normalize(rawListings[0]);
    const filteringConfig = provider.createConfig({ enabled: true, url: SEARCH_URL }, ['Hohenschönhausen']);

    expect(filteringConfig.filter(listing)).toBe(false);
  });

  it('returns no listings when WGF cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' }));

    await expect(runConfig.getListings(SEARCH_URL)).resolves.toEqual([]);
  });
});
