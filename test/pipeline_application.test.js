/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFredy } from './utils.js';
import * as mockStore from './mocks/mockStore.js';

const applicationChannel = {
  id: 'http',
  configuredAdapterId: 'application-module',
  fields: {
    endpointUrl: 'http://127.0.0.1:8765/api/v1/fredy/events',
    authToken: 'secret',
  },
};

const listing = () => ({
  id: 'flat-1',
  title: 'Wohnung',
  description: '',
  address: 'Musterstraße 1, Berlin',
  price: 900,
  size: 50,
  rooms: 2,
  link: 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/flat-1',
});

async function run({ rule, providers }) {
  mockStore.setUserSettings({ auto_apply: rule });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      expect(url).toBe('http://127.0.0.1:8765/api/v1/fredy/workflows');
      expect(options.headers.Authorization).toBe('Bearer secret');
      return { ok: true, status: 200, json: async () => ({ providers }) };
    }),
  );
  const Fredy = await mockFredy();
  const pipeline = new Fredy(
    {
      url: 'https://example.test/search',
      getListings: async () => [listing()],
      normalize: (value) => value,
      filter: () => true,
      crawlFields: { id: 'id', title: 'title', address: 'address', price: 'price' },
      requiredFieldNames: ['id', 'title', 'address', 'price'],
    },
    {
      id: 'top-job',
      notificationAdapter: [applicationChannel],
      specFilter: null,
      spatialFilter: null,
      commuteFilter: null,
    },
    'gewobag',
    { checkAndAddEntry: () => false },
    undefined,
  );
  return pipeline.execute();
}

beforeEach(() => {
  mockStore.setUserSettings({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pipeline application decision', () => {
  it('marks a matching listing running before notifications when its provider workflow exists', async () => {
    const result = await run({
      rule: { enabled: true, jobIds: ['top-job'], maxPrice: 1000, minSize: 45 },
      providers: ['gewobag'],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      applyRequested: true,
      applicationTrigger: 'auto',
      application: {
        provider: 'gewobag',
        autoMatched: true,
        workflowAvailable: true,
        state: 'running',
        trigger: 'auto',
      },
    });
  });

  it('keeps an auto match visible but does not start a browser run while the provider workflow is missing', async () => {
    const result = await run({
      rule: { enabled: true, jobIds: ['top-job'], maxPrice: 1000 },
      providers: [],
    });

    expect(result[0].applyRequested).toBeUndefined();
    expect(result[0].application).toMatchObject({
      provider: 'gewobag',
      autoMatched: true,
      workflowAvailable: false,
      state: 'idle',
    });
  });

  it('offers the workflow to Telegram without auto-starting when the one auto rule does not match', async () => {
    const result = await run({
      rule: { enabled: true, jobIds: ['another-job'] },
      providers: ['gewobag'],
    });

    expect(result[0].applyRequested).toBeUndefined();
    expect(result[0].application).toMatchObject({
      provider: 'gewobag',
      autoMatched: false,
      workflowAvailable: true,
      state: 'idle',
    });
  });
});
