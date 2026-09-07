/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
const state = vi.hoisted(() => ({ db: null }));
vi.mock('../../lib/services/storage/SqliteConnection.js', () => ({ default: { getConnection: () => state.db } }));
vi.mock('../../lib/services/storage/jobStorage.js', () => ({
  getJob: () => ({
    notificationAdapter: [
      { id: 'http', fields: { endpointUrl: 'http://127.0.0.1:8765/generic-events', authToken: 'token' } },
      {
        id: 'http',
        fields: { endpointUrl: 'http://127.0.0.1:8765/api/v1/fredy/events', authToken: 'token' },
      },
    ],
  }),
}));

vi.mock('../../lib/services/markdown.js', () => ({
  markdown2Html: () => '',
  readAdapterReadme: () => '',
}));

let send;
let fetchMock;

beforeEach(async () => {
  vi.resetModules();
  state.db = new Database(':memory:');
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  ({ send } = await import('../../lib/notification/adapter/http.js'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  state.db.close();
});

describe('HTTP notification adapter', () => {
  it('sends a channel probe without creating an application delivery or retry', async () => {
    const { testFire } = await import('../../lib/notification/testFire.js');
    const adapter = await import('../../lib/notification/adapter/http.js');
    const fields = { endpointUrl: 'http://127.0.0.1/probe', authToken: 'probe-token' };
    await testFire(adapter, fields);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).event).toBe('test');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer probe-token');
    expect(state.db.prepare("SELECT name FROM sqlite_master WHERE name='http_delivery_outbox'").get()).toBeUndefined();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(testFire(adapter, fields)).rejects.toThrow('HTTP 500');
  });
  it('forwards the confirmed official provider and direct link for machine consumers', async () => {
    await send({
      serviceName: 'immoscout',
      newListings: [
        {
          id: 'scout-1',
          link: 'https://www.immobilienscout24.de/expose/1',
          title: 'Im Wedding!',
          officialProvider: 'gewobag',
          providerLink: 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/1',
        },
      ],
      notificationConfig: [
        {
          id: 'http',
          fields: {
            authToken: 'token',
            endpointUrl: 'http://127.0.0.1:8765/generic-events',
            selfSignedCerts: false,
          },
        },
      ],
      jobKey: 'berlin',
      baseUrl: 'http://127.0.0.1:9998',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.provider).toBe('immoscout');
    expect(body.listings[0]).toMatchObject({
      url: 'https://www.immobilienscout24.de/expose/1',
      officialProvider: 'gewobag',
      providerLink: 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/1',
    });
  });

  it('keeps the legacy HTTP payload free of routing fields when no direct link was confirmed', async () => {
    await send({
      serviceName: 'immoscout',
      newListings: [{ id: 'scout-legacy', link: 'https://www.immobilienscout24.de/expose/2', title: 'Scout' }],
      notificationConfig: [
        {
          id: 'http',
          fields: { endpointUrl: 'http://127.0.0.1:8765/generic-events', authToken: 'token' },
        },
      ],
      jobKey: 'berlin',
      baseUrl: 'http://127.0.0.1:9998',
    });

    const listing = JSON.parse(fetchMock.mock.calls[0][1].body).listings[0];
    expect(listing.url).toBe('https://www.immobilienscout24.de/expose/2');
    expect(listing).not.toHaveProperty('officialProvider');
    expect(listing).not.toHaveProperty('providerLink');
  });

  it('does not feed ordinary discovery events into the application module', async () => {
    const result = await send({
      serviceName: 'wbm',
      newListings: [{ id: 'flat-no-apply', link: 'https://www.wbm.de/flat-no-apply', title: 'Mitte' }],
      notificationConfig: [
        {
          id: 'http',
          fields: { endpointUrl: 'http://127.0.0.1:8765/api/v1/fredy/events', authToken: 'token' },
        },
      ],
      jobKey: 'berlin',
      baseUrl: 'http://127.0.0.1:9998',
    });

    expect(result).toEqual({ ok: true, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an explicit auto application immediately to the application module', async () => {
    await send({
      serviceName: 'wbm',
      newListings: [
        {
          id: 'flat-auto',
          link: 'https://www.wbm.de/flat-auto',
          title: 'Mitte',
          applyRequested: true,
          applicationTrigger: 'auto',
          callbackUrl: 'http://127.0.0.1:9998/api/application/status/berlin/flat-auto',
        },
      ],
      notificationConfig: [
        {
          id: 'http',
          fields: { endpointUrl: 'http://127.0.0.1:8765/api/v1/fredy/events', authToken: 'token' },
        },
      ],
      jobKey: 'berlin',
      baseUrl: 'http://127.0.0.1:9998',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.listings[0]).toMatchObject({
      id: 'flat-auto',
      applyRequested: true,
      applicationTrigger: 'auto',
      callbackUrl: 'http://127.0.0.1:9998/api/application/status/berlin/flat-auto',
    });
  });

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
            endpointUrl: 'http://127.0.0.1:8765/generic-events',
            selfSignedCerts: false,
          },
        },
      ],
      jobKey: 'berlin',
      baseUrl: 'http://127.0.0.1:9998',
    });

    const [url, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(url).toBe('http://127.0.0.1:8765/generic-events');
    expect(options.headers.Authorization).toBe('Bearer token');
    expect(body.listings[0]).toMatchObject({
      id: 'flat-1',
      rooms: 2.5,
      size: 64,
      url: 'https://www.wbm.de/flat-1',
    });
  });
});
