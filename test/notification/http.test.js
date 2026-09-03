/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/services/markdown.js', () => ({
  markdown2Html: () => '',
  readAdapterReadme: () => '',
}));

let send;
let fetchMock;

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  ({ send } = await import('../../lib/notification/adapter/http.js'));
});

afterEach(() => vi.unstubAllGlobals());

describe('HTTP notification adapter', () => {
  it('adds rooms without changing the existing listing fields', async () => {
    await send({
      serviceName: 'wbm',
      newListings: [
        {
          address: 'Alexanderplatz 1',
          description: 'Wohnung',
          id: 'flat-1',
          image: 'image.jpg',
          link: 'https://www.wbm.de/flat-1',
          price: 750,
          rooms: 2.5,
          size: 64,
          title: 'Mitte',
        },
      ],
      notificationConfig: [
        {
          id: 'http',
          fields: {
            authToken: 'token',
            endpointUrl: 'http://127.0.0.1:8765/api/v1/fredy/events',
            selfSignedCerts: false,
          },
        },
      ],
      jobKey: 'berlin',
      baseUrl: 'http://127.0.0.1:9998',
    });

    const [url, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(url).toBe('http://127.0.0.1:8765/api/v1/fredy/events');
    expect(options.headers.Authorization).toBe('Bearer token');
    expect(body.listings[0]).toMatchObject({
      id: 'flat-1',
      rooms: 2.5,
      size: 64,
      url: 'https://www.wbm.de/flat-1',
    });
  });
});
