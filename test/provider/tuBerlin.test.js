/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as provider from '../../lib/provider/tuBerlin.js';

const SEARCH_URL = 'https://www.tu.berlin/international/starten-an-der-tu-berlin/wohnen/wohnungsboerse';

const LIST_HTML = `
  <ul>
    <li class="news_list-item">
      <h3 class="news_list-item__headline">
        <a href="/international/starten-an-der-tu-berlin/wohnen/wohnungsboerse/wohnungsboerse-detailseite/test-1">
          1, 5 Zimmer Wohnung in Charlottenburg-Wilmersdorf
        </a>
      </h3>
      <div class="news_list-item__teaser">
        <p>Mietpreis inkl. Nebenkosten pro Monat: € 1.048,36</p>
        <p>Frei ab: 01.08.2026</p>
        <p>Frei bis: unbefristet</p>
      </div>
      <div class="news_list-item__date"><time datetime="2026-07-21">21.07.2026</time></div>
    </li>
    <li class="news_list-item">
      <h3 class="news_list-item__headline">
        <a href="/international/starten-an-der-tu-berlin/wohnen/wohnungsboerse/wohnungsboerse-detailseite/test-2">
          2 Zimmer Wohnung in Pankow
        </a>
      </h3>
      <div class="news_list-item__teaser">
        <p>Rent (incl. electricity and heating costs): €800</p>
        <p>Available from: 01.09.2026</p>
        <p>Available to: 01.09.2027</p>
      </div>
      <div class="news_list-item__date"><time datetime="2026-07-20">20.07.2026</time></div>
    </li>
    <li class="news_list-item">
      <h3 class="news_list-item__headline">
        <a href="/international/starten-an-der-tu-berlin/wohnen/wohnungsboerse/wohnungsboerse-detailseite/test-3">
          Zimmer und Apartments in Mitte
        </a>
      </h3>
      <div class="news_list-item__teaser">
        <p>Mietpreis inkl. Nebenkosten pro Monat: Room: €460 per month, Flat: €920 per month</p>
      </div>
    </li>
  </ul>
`;

const DETAIL_HTML = `
  <main>
    <p><strong>Bezirk / District</strong></p><p>Charlottenburg-Wilmersdorf</p>
    <p><strong>Adresse / Address</strong></p><p>Straße des 17. Juni 135</p>
    <p><strong>Anzahl Zimmer / Number of rooms</strong></p><p>1,5</p>
    <p><strong>Größe in qm / Size in sqm</strong></p><p>42 qm</p>
    <p><strong>Ausstattung / Furnishing</strong></p><p>voll möbliert / fully furnished</p>
    <p><strong>Mietpreis inkl. Nebenkosten pro Monat / Rental price including ancillary costs per month</strong></p><p>1.050,50 €</p>
    <p><strong>Frei ab / Free from</strong></p><p>01.08.2026</p>
    <p><strong>Frei bis / Free until</strong></p><p>unbefristet</p>
    <p><strong>Sonstiges / Other</strong></p><p>Ruhige Wohnung nahe der TU.</p>
    <p><strong>Name</strong></p><p>Erika Beispiel</p>
    <p><strong>E-Mail-Adresse und/oder Telefonnummer / E-mail address and/or telephone number</strong></p>
    <p>erika@example.test</p>
  </main>
`;

describe('#tuBerlin provider', () => {
  beforeEach(() => {
    provider.init({ enabled: true, url: SEARCH_URL }, [], []);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses and normalizes the TU Berlin results page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => LIST_HTML });
    vi.stubGlobal('fetch', fetchMock);

    const rawListings = await provider.config.getListings(SEARCH_URL);
    const listing = provider.config.normalize(rawListings[0]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(rawListings).toHaveLength(3);
    expect(listing.id).toBeTypeOf('string');
    expect(listing.link).toBe(
      'https://www.tu.berlin/international/starten-an-der-tu-berlin/wohnen/wohnungsboerse/wohnungsboerse-detailseite/test-1',
    );
    expect(listing.title).toBe('1, 5 Zimmer Wohnung in Charlottenburg-Wilmersdorf');
    expect(listing.price).toBe(1048.36);
    expect(listing.rooms).toBe(1.5);
    expect(listing.size).toBeNull();
    expect(listing.address).toBeNull();
    expect(listing.description).toContain('Bezirk: Charlottenburg-Wilmersdorf');
    expect(listing.description).toContain('Frei bis: unbefristet');

    const englishListing = provider.config.normalize(rawListings[1]);
    expect(englishListing.price).toBe(800);
    expect(englishListing.rooms).toBe(2);
    expect(englishListing.address).toBeNull();
    expect(englishListing.description).toContain('Bezirk: Pankow');
    expect(englishListing.description).toContain('Frei ab: 01.09.2026');
    expect(englishListing.description).toContain('Frei bis: 01.09.2027');

    const multiOfferListing = provider.config.normalize(rawListings[2]);
    expect(multiOfferListing.price).toBe(460);
    expect(multiOfferListing.address).toBeNull();
    expect(multiOfferListing.description).toContain('Bezirk: Mitte');
  });

  it('enriches a listing from the public detail page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => DETAIL_HTML }));
    const listing = {
      id: 'listing-id',
      link: '/international/starten-an-der-tu-berlin/wohnen/wohnungsboerse/wohnungsboerse-detailseite/test-1',
      title: '1,5 Zimmer Wohnung in Charlottenburg-Wilmersdorf',
      price: 1048.36,
      rooms: 1.5,
      size: null,
      address: null,
      image: null,
      description: 'Veröffentlicht: 2026-07-21',
    };

    const enriched = await provider.config.fetchDetails(listing);

    expect(enriched.address).toBe('Straße des 17. Juni 135, Charlottenburg-Wilmersdorf, Berlin');
    expect(enriched.price).toBe(1050.5);
    expect(enriched.rooms).toBe(1.5);
    expect(enriched.size).toBe(42);
    expect(enriched.description).toContain('Ruhige Wohnung nahe der TU.');
    expect(enriched.description).toContain('Kontakt: Erika Beispiel');
    expect(enriched.description).toContain('erika@example.test');
  });

  it('applies text and district blacklists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => LIST_HTML }));
    const rawListings = await provider.config.getListings(SEARCH_URL);
    const listing = provider.config.normalize(rawListings[0]);

    provider.init({ enabled: true, url: SEARCH_URL }, ['unbefristet'], []);
    expect(provider.config.filter(listing)).toBe(false);

    provider.init({ enabled: true, url: SEARCH_URL }, [], ['Charlottenburg']);
    expect(provider.config.filter(listing)).toBe(false);
  });

  it('filters only listings with an unambiguously expired end date', () => {
    const listing = {
      title: '1 Zimmer Wohnung in Mitte',
      address: 'Mitte, Berlin',
      description: 'Frei bis: 01.01.2020',
    };

    expect(provider.config.filter(listing)).toBe(false);
    expect(provider.config.filter({ ...listing, description: 'Frei bis: unbefristet' })).toBe(true);
    expect(provider.config.filter({ ...listing, description: 'Frei bis: nach Absprache' })).toBe(true);
  });
});
