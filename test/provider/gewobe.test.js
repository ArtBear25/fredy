/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as provider from '../../lib/provider/gewobe.js';

const SOURCE_URL = 'https://www.gewobe.de/leistungen/immobilienangebote';
const PORTAL_LINK =
  'https://portal.immobilienscout24.de/expose/54212102/170000001/1/1?sid=test-session';

const RESULT_PAGE = `
<ul class="result--list">
  <li class="result__list--element">
    <figure class="result__list__element--image">
      <a href="/expose/54212102/170000001/1/1?sid=test-session"><img src="//pictures.immobilienscout24.de/listings/test.jpg"></a>
    </figure>
    <div class="result__list__element--infos">
      <h3 class="result__list__element__infos--figcaption">
        <a href="/expose/54212102/170000001/1/1?sid=test-session">Zweiraumwohnung im MV</a>
      </h3>
      <div class="result__list__element__infos--location"><p>Senftenberger Ring 90, Berlin, Wittenau, Deutschland</p></div>
      <p>Wohnung zur Miete</p>
      <ul class="result__list__element__infos--list">
        <li><h4 class="result__list__element__infos__list--title">Kaltmiete</h4><span class="result__list__element__infos__list--score">€ 487,29</span></li>
        <li><h4 class="result__list__element__infos__list--title">Wohnfläche</h4><span class="result__list__element__infos__list--score">57,16 m²</span></li>
        <li><h4 class="result__list__element__infos__list--title">Zimmer</h4><span class="result__list__element__infos__list--score">2</span></li>
      </ul>
    </div>
  </li>
</ul>`;

const EXPOSE_PAGE = `
<div class="expose--text expose--text__address">
  <p>Deutschland, 13435 Berlin, Wittenau, Senftenberger Ring 90</p>
</div>`;

describe('#gewobe provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the embedded gewobe ImmoScout portal and enriches the exact address', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => RESULT_PAGE })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => EXPOSE_PAGE });
    vi.stubGlobal('fetch', fetchMock);

    const config = provider.createConfig({ enabled: true, url: SOURCE_URL }, []);
    const raw = await config.getListings(SOURCE_URL);
    const listing = config.normalize(raw[0]);

    expect(fetchMock.mock.calls[0][0]).toBe('https://portal.immobilienscout24.de/ergebnisliste/54212102');
    expect(fetchMock.mock.calls[1][0]).toBe(PORTAL_LINK);
    expect(listing.link).toBe(PORTAL_LINK);
    expect(listing.title).toBe('Zweiraumwohnung im MV');
    expect(listing.address).toBe('Deutschland, 13435 Berlin, Wittenau, Senftenberger Ring 90');
    expect(listing.price).toBe(487.29);
    expect(listing.size).toBe(57.16);
    expect(listing.rooms).toBe(2);
  });

  it('recognizes only the gewobe portal account as its direct feed', () => {
    expect(provider.parseListings(RESULT_PAGE)).toHaveLength(1);
    expect(provider.metaInformation).toMatchObject({ id: 'gewobe', name: 'gewobe' });
  });
});
