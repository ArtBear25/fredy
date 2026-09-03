import { afterEach, describe, expect, it, vi } from 'vitest';
import * as provider from '../../lib/provider/wbm.js';

const SEARCH_URL = 'https://www.wbm.de/wohnungen-berlin/angebote/';
const LIST = `<main><article data-id="W-1"><h2>Helle Wohnung</h2><address>Musterstraße 1, 10115 Berlin</address><a href="/wohnungen-berlin/angebote/expose-1">Exposé</a><span>1.234,56 € Warmmiete</span><span>65,50 m²</span><span>2 Zimmer</span><img src="/images/one.jpg"></article></main>`;

describe('#wbm provider', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('parses and normalizes listings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => LIST }));
    provider.init({ enabled: true, url: SEARCH_URL }, []);
    const listing = provider.config.normalize((await provider.config.getListings(SEARCH_URL))[0]);
    expect(listing.id).toBeTypeOf('string');
    expect(listing.price).toBe(1234.56);
    expect(listing.size).toBe(65.5);
    expect(listing.rooms).toBe(2);
    expect(listing.link).toBe('https://www.wbm.de/wohnungen-berlin/angebote/expose-1');
  });
  it('enriches a listing from its detail page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<main><address>Neue Straße 2, 10117 Berlin</address><span>900,00 € Warmmiete</span><p>Mit Balkon</p></main>' }));
    const detail = await provider.config.fetchDetails(provider.config.normalize({ id: 'W-1', link: '/detail', title: 'Wohnung' }));
    expect(detail.price).toBe(900);
    expect(detail.address).toContain('Neue Straße');
  });
  it('returns no listings for an empty or invalid response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<main></main>' }));
    provider.init({ enabled: true, url: SEARCH_URL }, []);
    expect(await provider.config.getListings(SEARCH_URL)).toEqual([]);
  });
  it('keeps optional fields empty when a card omits them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<main><article><h2>Wohnung</h2><a href="/detail">Exposé</a></article></main>' }));
    provider.init({ enabled: true, url: SEARCH_URL }, []);
    const raw = (await provider.config.getListings(SEARCH_URL))[0];
    expect(provider.config.normalize(raw)).toMatchObject({ title: 'Wohnung', price: null, size: null, rooms: null });
  });
});
