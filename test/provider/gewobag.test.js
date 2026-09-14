/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, createConfig, metaInformation, parseDetailPage, parseSearchPage } from '../../lib/provider/gewobag.js';

const SEARCH_URL = 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/?objekttyp%5B0%5D=wohnung';
const DETAIL_URL = 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/1000-00188-0101-0159/';

const card = ({ next = '' } = {}) => `
<html><body>
<article class="angebot-big-box gw-offer">
  <div class="gw-pictogram--wbs"><svg><title>WBS erforderlich</title></svg></div>
  <div class="angebot-region"><table><tr><td>Prenzlauer Berg</td></tr></table></div>
  <div class="angebot-address"><address>Pieskower Weg 52, 10409 Berlin/Pankow</address><h3 class="angebot-title">2 Zimmer mit WBS</h3></div>
  <table>
    <tr class="angebot-area"><td>2 Zimmer | 52,28 m²</td></tr>
    <tr class="availability"><td>01.09.2026</td></tr>
    <tr class="angebot-kosten"><td>ab 561,58€</td></tr>
    <tr class="angebot-characteristics"><td><ul><li>Badewanne</li><li>Fahrstuhl</li></ul></td></tr>
  </table>
  <img src="https://www.gewobag.de/wp-content/uploads/flat.jpg">
  <div class="angebot-footer"><a class="read-more-link" href="${DETAIL_URL}">Mietangebot ansehen</a></div>
</article>
${next ? `<a class="next page-numbers" href="${next}">Next »</a>` : ''}
</body></html>`;

const detail = ({ missing = false } = {}) =>
  missing
    ? '<html><body><h1>Mietangebot nicht gefunden</h1></body></html>'
    : `<html><body class="single-immobilien">
      <h1>2 Zimmer ohne WBS</h1>
      <div class="swiper"><img src="https://www.gewobag.de/wp-content/uploads/detail.jpg"></div>
      <div class="details-description"><h3 id="objektbeschreibung">Objektbeschreibung</h3><p>Ohne WBS – selbst renovieren.</p></div>
      <div class="details-description"><h3 id="lage">Lage</h3><p>Mitten in Prenzlauer Berg.</p></div>
      <table><tr><th>Mietpreis</th></tr><tr><th>Grundmiete</th><td>383,58 Euro</td></tr><tr><th>Gesamtmiete</th><td>561,58 Euro</td></tr></table>
      <table><tr><th>Allgemeine Angebotsdaten</th></tr><tr><th>Anschrift</th><td>Pieskower Weg 52, 10409 Berlin</td></tr><tr><th>Anzahl Zimmer</th><td>2</td></tr><tr><th>Fläche in m²</th><td>52,28 m²</td></tr><tr><th>Objektnummer</th><td>1000/00188/0101/0159</td></tr></table>
      <table><tr><th>Merkmale</th><td><ul><li>Badewanne</li><li>Fahrstuhl</li></ul></td></tr></table>
    </body></html>`;

afterEach(() => vi.restoreAllMocks());

describe('Gewobag provider', () => {
  it('parses server-rendered search cards without treating Gesamtmiete as Fredy price', () => {
    const parsed = parseSearchPage(card(), SEARCH_URL);
    expect(parsed.nextUrl).toBeNull();
    expect(parsed.listings).toHaveLength(1);
    expect(parsed.listings[0]).toMatchObject({
      link: DETAIL_URL,
      title: '2 Zimmer mit WBS',
      address: 'Pieskower Weg 52, 10409 Berlin/Pankow',
      totalRent: 561.58,
      size: 52.28,
      rooms: 2,
      wbsRequirement: 'erforderlich',
      providerName: 'Gewobag',
    });
  });

  it('follows pagination and de-duplicates a repeated offer', async () => {
    const pageTwo = 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/page/2/?objekttyp%5B0%5D=wohnung';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => card({ next: pageTwo }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => card() });

    const listings = await config.getListings(SEARCH_URL);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(listings).toHaveLength(1);
    expect(listings[0].link).toBe(DETAIL_URL);
  });

  it('loads authoritative cold rent and detail metadata before filtering', () => {
    const parsed = parseSearchPage(card(), SEARCH_URL).listings[0];
    const normalized = config.normalize(parsed);
    expect(normalized.price).toBeNull();

    const enriched = parseDetailPage(detail(), normalized);
    expect(enriched).toMatchObject({
      price: 383.58,
      size: 52.28,
      rooms: 2,
      address: 'Pieskower Weg 52, 10409 Berlin',
      wbsRequirement: 'nicht erforderlich',
      providerName: 'Gewobag',
    });
    expect(enriched.description).toContain('Gesamtmiete: 561.58 €');
    expect(enriched.description).toContain('Objektnummer: 1000/00188/0101/0159');
  });

  it('treats a Gewobag not-found page as inactive and a concrete offer as active', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => detail({ missing: true }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => detail() });

    expect(await config.activityProbe(DETAIL_URL)).toBe(0);
    expect(await config.activityProbe(DETAIL_URL)).toBe(1);
  });

  it('exposes a stateless run config with the official Gewobag search as its default', () => {
    const first = createConfig({ enabled: true }, ['Seniorenwohnung']);
    const second = createConfig({ enabled: false }, []);
    expect(metaInformation).toMatchObject({ id: 'gewobag', name: 'Gewobag', baseUrl: 'https://www.gewobag.de/' });
    expect(first.url).toBe(SEARCH_URL);
    expect(first.enabled).toBe(true);
    expect(second.enabled).toBe(false);
    expect(first).not.toBe(second);
  });
});
