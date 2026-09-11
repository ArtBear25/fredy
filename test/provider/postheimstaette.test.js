/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as provider from '../../lib/provider/postheimstaette.js';

const SEARCH_URL = 'https://www.xn--postheimsttte-kfb.de/thema/freie_wohnungen/';
let runConfig;

const PAGE = `
  <main>
    <article id="post-1728" class="post category-freie_wohnungen">
      <header class="entry-header">
        <h1 class="entry-title"><a href="https://www.xn--postheimsttte-kfb.de/wohnungsangebot/">Wohnungsangebot!</a></h1>
      </header>
      <div class="entry-content">
        <h2>2,5-Zimmerwohnung in Prenzlauer Berg</h2>
        <p>Details:</p>
        <ul>
          <li>Lage: Wichertstraße 30, 2. Erdgeschoss, 10439 Berlin</li>
          <li>Größe: 2,5 Zimmer, ca. 61,66 qm</li>
          <li>Nettogrundnutzungsgebühr: 616,60 €</li>
          <li>Vorauszahlung Betriebskosten zur Zeit: 130,00 €</li>
          <li>Vorauszahlung Heizkosten zur Zeit: 87,00 €</li>
          <li>Gesamtnutzungsgebühr: 833,60 €</li>
          <li>Vermietung ab: 15. Oktober 2026</li>
        </ul>
        <details><summary>Die Wohnung wird derzeit umfassend saniert und verfügt über ein gefliestes Bad.</summary></details>
      </div>
    </article>
  </main>`;

describe('#postheimstaette provider', () => {
  beforeEach(() => {
    runConfig = provider.createConfig({ enabled: true, url: SEARCH_URL }, []);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the public apartment offer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => PAGE });
    vi.stubGlobal('fetch', fetchMock);

    const rawListings = await runConfig.getListings(SEARCH_URL);
    const listing = runConfig.normalize(rawListings[0]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rawListings).toHaveLength(1);
    expect(listing.id).toBeTypeOf('string');
    expect(listing.link).toBe('https://www.xn--postheimsttte-kfb.de/wohnungsangebot/');
    expect(listing.title).toBe('2,5-Zimmerwohnung in Prenzlauer Berg');
    expect(listing.price).toBe(616.6);
    expect(listing.size).toBe(61.66);
    expect(listing.rooms).toBe(2.5);
    expect(listing.address).toBe('Wichertstraße 30, 10439 Berlin, Deutschland');
    expect(listing.image).toBeNull();
    expect(listing.description).toContain('umfassend saniert');
    expect(runConfig.filter(listing)).toBe(true);
  });

  it('uses apartment data in the source identity when the permalink is reused', async () => {
    const changedPage = PAGE.replace('Wichertstraße 30', 'Wichertstraße 32').replace('616,60 €', '620,00 €');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => PAGE })
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => changedPage }),
    );

    const first = runConfig.normalize((await runConfig.getListings(SEARCH_URL))[0]);
    const second = runConfig.normalize((await runConfig.getListings(SEARCH_URL))[0]);

    expect(first.link).toBe(second.link);
    expect(first.id).not.toBe(second.id);
  });

  it('applies the configured job blacklist to the offer description', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => PAGE }));
    const listing = runConfig.normalize((await runConfig.getListings(SEARCH_URL))[0]);
    const filteringConfig = provider.createConfig({ enabled: true, url: SEARCH_URL }, ['saniert']);

    expect(filteringConfig.filter(listing)).toBe(false);
  });

  it('returns no listings when Postheimstätte cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' }));

    await expect(runConfig.getListings(SEARCH_URL)).resolves.toEqual([]);
  });
});
