/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock external deps BEFORE importing the module under test.
vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../../lib/services/storage/jobStorage.js', () => ({
  getJob: (jobKey) => ({ id: jobKey, name: jobKey }),
}));
vi.mock('../../lib/services/markdown.js', () => ({
  readAdapterReadme: () => '',
}));

// Helpers to build mock fetch responses.
function jsonOk(body = { ok: true }) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

function jsonErr(status, body) {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify(body),
  };
}

function imageOk(bytes = new Uint8Array([0xff, 0xd8, 0xff])) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (h) => {
        const k = h.toLowerCase();
        if (k === 'content-type') return 'image/jpeg';
        if (k === 'content-length') return String(bytes.byteLength);
        return null;
      },
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

// Globals are mocked too so buildPhotoFormData (which uses global fetch) can be
// intercepted by the same single mock.
let mockNodeFetch;
let mockGlobalFetch;
let send;

beforeEach(async () => {
  // Reset modules to get a fresh import with our mocks applied.
  vi.resetModules();
  const nodeFetchMod = await import('node-fetch');
  mockNodeFetch = nodeFetchMod.default;
  mockNodeFetch.mockReset();

  mockGlobalFetch = vi.fn();
  vi.stubGlobal('fetch', mockGlobalFetch);

  ({ send } = await import('../../lib/notification/adapter/telegram.js'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const baseConfig = {
  id: 'telegram',
  fields: { token: 'TKN', chatId: '999' },
};

describe('telegram send() - HTTP URL path (default for .jpg / .png)', () => {
  it('POSTs JSON to sendPhoto for a .jpg image URL', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immowelt',
      newListings: [
        {
          id: 'a',
          title: 'Listing',
          link: 'https://example.com/a',
          address: 'Addr',
          price: '500€',
          size: '50m²',
          image: 'https://mms.immowelt.de/x/y/z/w/abc.jpg?ci_seal=hash&w=525&h=394',
        },
      ],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
    });

    expect(mockNodeFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockNodeFetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTKN/sendPhoto');
    expect(opts.method).toBe('post');
    expect(opts.headers?.['Content-Type']).toBe('application/json');
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe('999');
    expect(body.photo).toBe('https://mms.immowelt.de/x/y/z/w/abc.jpg?ci_seal=hash&w=525&h=394');
    expect(body.parse_mode).toBe('HTML');
  });

  it('does NOT pre-fetch the image when using HTTP URL path', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immowelt',
      newListings: [
        {
          id: 'a',
          title: 't',
          link: 'l',
          address: 'a',
          price: '',
          size: '',
          image: 'https://example.com/x.jpg',
        },
      ],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
    });

    // global fetch (used by buildPhotoFormData) must not be called
    expect(mockGlobalFetch).not.toHaveBeenCalled();
  });

  it('falls back to sendMessage when sendPhoto fails', async () => {
    mockNodeFetch
      .mockResolvedValueOnce(jsonErr(400, { ok: false, description: 'boom' }))
      .mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immowelt',
      newListings: [
        {
          id: 'a',
          title: 't',
          link: 'l',
          address: 'a',
          price: '',
          size: '',
          image: 'https://example.com/x.jpg',
        },
      ],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
    });

    expect(mockNodeFetch).toHaveBeenCalledTimes(2);
    expect(mockNodeFetch.mock.calls[0][0]).toBe('https://api.telegram.org/botTKN/sendPhoto');
    expect(mockNodeFetch.mock.calls[1][0]).toBe('https://api.telegram.org/botTKN/sendMessage');
  });
});

describe('telegram send() - multipart path (.webp URLs)', () => {
  it('pre-fetches the image then POSTs FormData to sendPhoto for a .webp URL', async () => {
    // 1st: GET image via global fetch
    mockGlobalFetch.mockResolvedValueOnce(imageOk());
    // 2nd: POST sendPhoto via node-fetch
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immowelt',
      newListings: [
        {
          id: 'a',
          title: 'Listing',
          link: 'https://example.com/a',
          address: 'Addr',
          price: '500€',
          size: '50m²',
          image: 'https://mms.immowelt.de/1/1/6/5/abc.webp?ci_seal=hash&w=525&h=394',
        },
      ],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
    });

    // image was fetched
    expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
    expect(mockGlobalFetch.mock.calls[0][0]).toBe('https://mms.immowelt.de/1/1/6/5/abc.webp?ci_seal=hash&w=525&h=394');

    // sendPhoto called via node-fetch with FormData
    expect(mockNodeFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockNodeFetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTKN/sendPhoto');
    expect(opts.method).toBe('post');
    expect(opts.body).toBeInstanceOf(FormData);
    // No explicit Content-Type header - fetch sets multipart boundary itself
    expect(opts.headers).toBeUndefined();
    expect(opts.body.get('chat_id')).toBe('999');
    expect(opts.body.get('parse_mode')).toBe('HTML');
    const photo = opts.body.get('photo');
    expect(photo).toBeTruthy();
    expect(photo.size).toBeGreaterThan(0);
  });

  it('falls back to sendMessage when the image pre-fetch fails for a .webp URL', async () => {
    // image fetch fails (404 from CDN)
    mockGlobalFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    // then sendMessage succeeds via node-fetch
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immowelt',
      newListings: [
        {
          id: 'a',
          title: 't',
          link: 'l',
          address: 'a',
          price: '',
          size: '',
          image: 'https://example.com/gone.webp',
        },
      ],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
    });

    expect(mockNodeFetch).toHaveBeenCalledTimes(1);
    expect(mockNodeFetch.mock.calls[0][0]).toBe('https://api.telegram.org/botTKN/sendMessage');
  });

  it('falls back to sendMessage when multipart sendPhoto returns a Telegram error', async () => {
    mockGlobalFetch.mockResolvedValueOnce(imageOk());
    mockNodeFetch
      .mockResolvedValueOnce(jsonErr(400, { description: 'broke' })) // multipart sendPhoto
      .mockResolvedValueOnce(jsonOk()); // sendMessage fallback

    await send({
      serviceName: 'immowelt',
      newListings: [
        {
          id: 'a',
          title: 't',
          link: 'l',
          address: 'a',
          price: '',
          size: '',
          image: 'https://example.com/x.webp',
        },
      ],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
    });

    expect(mockNodeFetch).toHaveBeenCalledTimes(2);
    expect(mockNodeFetch.mock.calls[1][0]).toBe('https://api.telegram.org/botTKN/sendMessage');
  });
});

describe('telegram send() - mixed batch (regression-safety)', () => {
  it('handles a batch with both .jpg and .webp - jpg uses URL, webp uses multipart', async () => {
    // .webp image fetch
    mockGlobalFetch.mockResolvedValueOnce(imageOk());
    // both sendPhoto calls succeed
    mockNodeFetch
      .mockResolvedValueOnce(jsonOk()) // could be either listing first
      .mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immowelt',
      newListings: [
        {
          id: 'jpg-listing',
          title: 'a',
          link: 'l',
          address: 'a',
          price: '',
          size: '',
          image: 'https://example.com/a.jpg',
        },
        {
          id: 'webp-listing',
          title: 'b',
          link: 'l',
          address: 'a',
          price: '',
          size: '',
          image: 'https://example.com/b.webp',
        },
      ],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
    });

    expect(mockGlobalFetch).toHaveBeenCalledTimes(1); // only webp pre-fetches
    expect(mockNodeFetch).toHaveBeenCalledTimes(2);

    // Verify one call had FormData and one had JSON body
    const bodies = mockNodeFetch.mock.calls.map((c) => c[1].body);
    const hasFormData = bodies.some((b) => b instanceof FormData);
    const hasJson = bodies.some((b) => typeof b === 'string' && b.startsWith('{'));
    expect(hasFormData).toBe(true);
    expect(hasJson).toBe(true);
  });

  it('uses sendMessage (not sendPhoto) when image is null', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immowelt',
      newListings: [
        {
          id: 'a',
          title: 't',
          link: 'l',
          address: 'a',
          price: '',
          size: '',
          image: null,
        },
      ],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
    });

    expect(mockNodeFetch).toHaveBeenCalledTimes(1);
    expect(mockNodeFetch.mock.calls[0][0]).toBe('https://api.telegram.org/botTKN/sendMessage');
    expect(mockGlobalFetch).not.toHaveBeenCalled();
  });
});

describe('telegram send() - multiple chat IDs', () => {
  const listing = {
    id: '1',
    title: 'Flat',
    link: 'https://ex.com',
    address: 'Berlin',
    price: '800',
    size: '50',
    image: 'https://ex.com/img.jpg',
  };

  it('sends to every chat ID in a comma-separated list', async () => {
    mockNodeFetch.mockResolvedValue(jsonOk());

    await send({
      serviceName: 'immoscout',
      newListings: [listing],
      notificationConfig: [{ id: 'telegram', fields: { token: 'TKN', chatId: '111, 222' } }],
      jobKey: 'Berlin',
    });

    expect(mockNodeFetch).toHaveBeenCalledTimes(2);
    const bodies = mockNodeFetch.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(bodies.map((b) => b.chat_id)).toEqual(expect.arrayContaining(['111', '222']));
  });

  it('trims whitespace around each chat ID', async () => {
    mockNodeFetch.mockResolvedValue(jsonOk());

    await send({
      serviceName: 'immoscout',
      newListings: [listing],
      notificationConfig: [{ id: 'telegram', fields: { token: 'TKN', chatId: '  333 , 444  ' } }],
      jobKey: 'Berlin',
    });

    expect(mockNodeFetch).toHaveBeenCalledTimes(2);
    const bodies = mockNodeFetch.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(bodies.map((b) => b.chat_id)).toEqual(expect.arrayContaining(['333', '444']));
  });

  it('sends each listing to each chat ID (N listings × M chats)', async () => {
    mockNodeFetch.mockResolvedValue(jsonOk());

    await send({
      serviceName: 'immoscout',
      newListings: [listing, { ...listing, id: '2' }],
      notificationConfig: [{ id: 'telegram', fields: { token: 'TKN', chatId: '555, 666' } }],
      jobKey: 'Berlin',
    });

    expect(mockNodeFetch).toHaveBeenCalledTimes(4);
  });
});

describe('telegram send() - Try sample', () => {
  it('exercises the current merged-link and travel-time layout', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());
    const telegram = await import('../../lib/notification/adapter/telegram.js');
    const { testFire } = await import('../../lib/notification/testFire.js');

    await testFire(telegram, { token: 'TKN', chatId: '999' });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.text).toContain('Beim Anbieter öffnen:');
    expect(body.text).toContain('Auf Scout24 öffnen:');
    expect(body.text).toContain('DKB: 25 min Ö // 38 min F');
    expect(body.text).toContain('Kitty: 22 min Ö // 83 min F');
    expect(body.text).toContain('Supermarkt: 21 min F');
    expect(body.text).toContain('Gym: 23 min F');
  });
});

describe('telegram send() - readable listing structure', () => {
  const structuredListing = {
    id: 'structured-1',
    title: 'WBS erforderlich. Zentral wohnen am Halleschen Tor',
    link: 'https://example.com/listing/1',
    address: 'Lindenstr. 110, 10969 Berlin, Kreuzberg',
    price: '588 €',
    size: '86 m²',
    commute:
      'DKB-Ö: 35 min ÖPNV, 50 min zu Fuß | Gym: 15 min zu Fuß | Kitty-Ö: 25 min ÖPNV, 43 min zu Fuß | Supermarkt: 21 min zu Fuß',
    travelTimes: [
      { label: 'Gym', walk: { minutes: 15 } },
      { label: 'Supermarkt', walk: { minutes: 21 } },
      { label: 'DKB-Ö', transit: { minutes: 35, transfers: 1 }, walk: { minutes: 50 } },
      { label: 'Kitty-Ö', transit: { minutes: 25, transfers: 1 }, walk: { minutes: 43 } },
    ],
    image: null,
  };

  it('puts link, address, price, size and each travel destination on separate lines in HTML mode', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immoscout',
      newListings: [structuredListing],
      notificationConfig: [baseConfig],
      jobKey: 'PREMIUM',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.text).toContain(
      "<a href='https://example.com/listing/1'><b>WBS erforderlich. Zentral wohnen am Halleschen Tor</b></a>\n" +
        'Adresse: Lindenstr. 110, 10969 Berlin, Kreuzberg\n' +
        'Preis: 588 €\n' +
        'Größe: 86 m²\n' +
        'DKB: 35 min Ö // 50 min F\n' +
        'Kitty: 25 min Ö // 43 min F\n' +
        'Supermarkt: 21 min F\n' +
        'Gym: 15 min F',
    );
    expect(body.text).not.toContain(' | ');
  });

  it('uses the same ordered one-fact-per-line structure in plain-text mode', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immoscout',
      newListings: [structuredListing],
      notificationConfig: [{ id: 'telegram', fields: { ...baseConfig.fields, plainText: true } }],
      jobKey: 'PREMIUM',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.text).toContain(
      'WBS erforderlich. Zentral wohnen am Halleschen Tor\n' +
        'https://example.com/listing/1\n' +
        'Adresse: Lindenstr. 110, 10969 Berlin, Kreuzberg\n' +
        'Preis: 588 €\n' +
        'Größe: 86 m²\n' +
        'DKB: 35 min Ö // 50 min F\n' +
        'Kitty: 25 min Ö // 43 min F\n' +
        'Supermarkt: 21 min F\n' +
        'Gym: 15 min F',
    );
    expect(body.text).not.toContain(' | ');
  });

  it('shows the actual housing company when an aggregator provides it', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'inberlinwohnen',
      newListings: [{ ...structuredListing, providerName: 'HOWOGE' }],
      notificationConfig: [baseConfig],
      jobKey: 'Alles Innen unter 540',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.text).toContain('<i>Alles Innen unter 540</i> (HOWOGE)');
    expect(body.text).not.toContain('(inberlinwohnen)');
  });
});

describe('telegram send() - application controls and status', () => {
  const applicationListing = {
    id: 'apply-1',
    title: 'Wohnung in Mitte',
    link: 'https://example.com/apply-1',
    address: 'Musterstraße 1, Berlin',
    price: '900 €',
    size: '50 m²',
    image: null,
  };

  it('shows a one-tap Bewerben button only when a workflow is available', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'gewobag',
      newListings: [
        {
          ...applicationListing,
          application: {
            provider: 'gewobag',
            url: applicationListing.link,
            criteriaMatched: false,
            autoEligible: false,
            workflowStatus: 'available',
            workflowAvailable: true,
            state: 'idle',
          },
        },
      ],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Bewerben', callback_data: 'fredy_apply:apply-1' }]],
    });
  });

  it('shows that an auto application is already running and removes the manual button', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'gewobag',
      newListings: [
        {
          ...applicationListing,
          application: {
            provider: 'gewobag',
            url: applicationListing.link,
            criteriaMatched: true,
            autoEligible: true,
            workflowStatus: 'available',
            workflowAvailable: true,
            state: 'running',
            trigger: 'auto',
          },
        },
      ],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.text).toContain('⚡ Auto-Bewerbung läuft');
    expect(body.text).not.toContain('Auto-Bewerbung erfüllt');
    expect(body).not.toHaveProperty('reply_markup');
  });

  it('keeps WBS-incompatible listings visible but removes every application action', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'wbm',
      newListings: [
        {
          ...applicationListing,
          title: '2-Zimmer-Wohnung mit WBS160-220',
          application: {
            provider: 'wbm',
            url: applicationListing.link,
            criteriaMatched: true,
            autoEligible: false,
            workflowStatus: 'available',
            workflowAvailable: true,
            wbsStatus: 'specific',
            wbsLevels: [160, 220],
            wbsCompatible: false,
            state: 'idle',
          },
        },
      ],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.text).toContain('⚠️ Auto-Bewerbung übersprungen: WBS 160/WBS 220 nicht passend');
    expect(body).not.toHaveProperty('reply_markup');
  });

  it('shows an auto match without a dead button when that provider has no workflow yet', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'howoge',
      newListings: [
        {
          ...applicationListing,
          application: {
            provider: 'howoge',
            url: applicationListing.link,
            criteriaMatched: true,
            autoEligible: false,
            workflowStatus: 'missing',
            workflowAvailable: false,
            state: 'idle',
          },
        },
      ],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.text).toContain('⚠️ Auto-Bewerbung nicht möglich: Kein Workflow vorhanden');
    expect(body.text).not.toContain('Auto-Bewerbung erfüllt');
    expect(body).not.toHaveProperty('reply_markup');
  });

  it('distinguishes an unreachable application module from a genuinely missing workflow', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'howoge',
      newListings: [
        {
          ...applicationListing,
          application: {
            provider: 'howoge',
            url: applicationListing.link,
            criteriaMatched: true,
            autoEligible: false,
            workflowStatus: 'unreachable',
            workflowAvailable: false,
            state: 'idle',
          },
        },
      ],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.text).toContain('⚠️ Auto-Bewerbung nicht möglich: Bewerbungsmodul nicht erreichbar');
    expect(body.text).not.toContain('Kein Workflow vorhanden');
    expect(body).not.toHaveProperty('reply_markup');
  });
});

describe('telegram send() - Scout24 plus official provider link', () => {
  const mergedListing = {
    id: 'scout-1',
    title: 'Dolgenseestraße & Umgebung',
    link: 'https://www.immobilienscout24.de/expose/1?a=1&b=2',
    providerLink: 'https://www.howoge.de/immobiliensuche/detail/1?a=1&b=2',
    address: 'Dolgenseestraße 38, 10319 Berlin',
    price: '619 €',
    size: '63 m²',
    image: null,
  };

  it('renders exactly the two labelled external links in HTML mode', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immoscout',
      newListings: [mergedListing],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
      baseUrl: 'https://fredy.example',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('Beim Anbieter öffnen:');
    expect(body.text).toContain('Auf Scout24 öffnen:');
    expect(body.text).toContain('https://www.howoge.de/immobiliensuche/detail/1?a=1&amp;b=2');
    expect(body.text).toContain('https://www.immobilienscout24.de/expose/1?a=1&amp;b=2');
    expect(body.text.match(/<a href=/g)).toHaveLength(2);
    expect(body.text).not.toContain('Open in Fredy');
  });

  it('uses the same two labelled links in plain-text mode', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immoscout',
      newListings: [mergedListing],
      notificationConfig: [{ id: 'telegram', fields: { ...baseConfig.fields, plainText: true } }],
      jobKey: 'Berlin',
      baseUrl: 'https://fredy.example',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.parse_mode).toBeUndefined();
    expect(body.text).toContain(`Beim Anbieter öffnen: ${mergedListing.providerLink}`);
    expect(body.text).toContain(`Auf Scout24 öffnen: ${mergedListing.link}`);
    expect(body.text).not.toContain('Open in Fredy');
  });

  it('keeps both links intact inside the 1024-character HTML photo-caption limit', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());
    const listing = {
      ...mergedListing,
      address: 'Sehr lange Metadaten '.repeat(200),
      image: 'https://example.com/photo.jpg',
    };

    await send({
      serviceName: 'immoscout',
      newListings: [listing],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
      baseUrl: 'https://fredy.example',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.caption.length).toBeLessThanOrEqual(1024);
    expect(body.caption).toContain('Beim Anbieter öffnen:');
    expect(body.caption).toContain('Auf Scout24 öffnen:');
    expect(body.caption.match(/<a href=/g)).toHaveLength(2);
    expect(body.caption).not.toContain('Open in Fredy');
  });

  it('uses the same link logic for a plain-text photo caption', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immoscout',
      newListings: [{ ...mergedListing, image: 'https://example.com/photo.jpg' }],
      notificationConfig: [{ id: 'telegram', fields: { ...baseConfig.fields, plainText: true } }],
      jobKey: 'Berlin',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.caption.length).toBeLessThanOrEqual(1024);
    expect(body.caption).toContain(`Beim Anbieter öffnen: ${mergedListing.providerLink}`);
    expect(body.caption).toContain(`Auf Scout24 öffnen: ${mergedListing.link}`);
  });

  it('preserves the merged link body when sendPhoto falls back to sendMessage', async () => {
    mockNodeFetch
      .mockResolvedValueOnce(jsonErr(400, { ok: false, description: 'photo failed' }))
      .mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immoscout',
      newListings: [{ ...mergedListing, image: 'https://example.com/photo.jpg' }],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
      baseUrl: 'https://fredy.example',
    });

    expect(mockNodeFetch).toHaveBeenCalledTimes(2);
    const fallback = JSON.parse(mockNodeFetch.mock.calls[1][1].body);
    expect(fallback.text).toContain('Beim Anbieter öffnen:');
    expect(fallback.text).toContain('Auf Scout24 öffnen:');
    expect(fallback.text.match(/<a href=/g)).toHaveLength(2);
    expect(fallback.text).not.toContain('Open in Fredy');
  });

  it('keeps the previous Telegram format when no unique provider match exists', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'immoscout',
      newListings: [{ ...mergedListing, providerLink: undefined }],
      notificationConfig: [baseConfig],
      jobKey: 'Berlin',
      baseUrl: 'https://fredy.example',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.text).not.toContain('Beim Anbieter öffnen:');
    expect(body.text).not.toContain('Auf Scout24 öffnen:');
    expect(body.text).toContain('Open in Fredy');
    expect(body.text.match(/<a href=/g)).toHaveLength(2);
  });
});

describe('telegram send() - config validation', () => {
  it('throws when telegram adapter config is missing', () => {
    expect(() =>
      send({
        serviceName: 's',
        newListings: [],
        notificationConfig: [],
        jobKey: 'k',
      }),
    ).toThrow(/configuration missing/);
  });

  it('throws when token or chatId is missing', () => {
    expect(() =>
      send({
        serviceName: 's',
        newListings: [],
        notificationConfig: [{ id: 'telegram', fields: { token: '' } }],
        jobKey: 'k',
      }),
    ).toThrow(/token.*chatId/);
  });
});
