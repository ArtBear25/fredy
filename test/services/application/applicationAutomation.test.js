/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it, vi } from 'vitest';

import {
  applicationProvider,
  applicationUrl,
  buildApplicationEvent,
  discoverLocalApplicationChannel,
  fetchWorkflowProviders,
  findApplicationChannel,
  isApplicationEndpoint,
  matchesAutoApplyRule,
  normalizeAutoApplyRule,
  resolveApplicationChannel,
} from '../../../lib/services/application/applicationAutomation.js';

const listing = {
  id: 'flat-1',
  link: 'https://scout.test/flat-1',
  price: 900,
  size: 52,
  rooms: 2,
  travelTimes: [
    { label: 'Arbeit', transit: { minutes: 18 }, walk: { minutes: 52 } },
    { label: 'Kitty', transit: { minutes: 22 } },
  ],
};

describe('auto application rule', () => {
  it('uses one AND rule across job, price, size, rooms and arbitrary saved places', () => {
    const rule = {
      enabled: true,
      jobIds: ['top'],
      maxPrice: 1000,
      minSize: 45,
      minRooms: 2,
      travelTimes: [
        { label: 'Arbeit', mode: 'transit', maxMinutes: 20 },
        { label: 'Kitty', mode: 'transit', maxMinutes: 25 },
      ],
    };
    expect(matchesAutoApplyRule(rule, { jobId: 'top', listing })).toBe(true);
    expect(matchesAutoApplyRule(rule, { jobId: 'broad', listing })).toBe(false);
    expect(matchesAutoApplyRule({ ...rule, maxPrice: 800 }, { jobId: 'top', listing })).toBe(false);
    expect(
      matchesAutoApplyRule(
        { ...rule, travelTimes: [{ label: 'Arbeit', mode: 'walk', maxMinutes: 20 }] },
        { jobId: 'top', listing },
      ),
    ).toBe(false);
  });

  it('never treats an enabled but empty rule as approval for every listing', () => {
    expect(matchesAutoApplyRule({ enabled: true }, { jobId: 'top', listing })).toBe(false);
  });

  it('treats missing data as not matching instead of estimating it', () => {
    expect(matchesAutoApplyRule({ enabled: true, minSize: 40 }, { jobId: 'top', listing: { ...listing, size: null } })).toBe(
      false,
    );
    expect(
      matchesAutoApplyRule(
        { enabled: true, travelTimes: [{ label: 'Unbekannt', mode: 'transit', maxMinutes: 20 }] },
        { jobId: 'top', listing },
      ),
    ).toBe(false);
  });

  it('normalizes only the supported fixed fields', () => {
    expect(
      normalizeAutoApplyRule({
        enabled: true,
        jobIds: ['top', 'top'],
        maxPrice: '1000',
        unsupportedRuleDsl: { anything: true },
      }),
    ).toEqual({
      enabled: true,
      jobIds: ['top'],
      maxPrice: 1000,
      minSize: null,
      minRooms: null,
      travelTimes: [],
    });
  });
});

describe('application module routing', () => {
  const channel = {
    id: 'http',
    configuredAdapterId: 'app-channel',
    fields: {
      endpointUrl: 'http://127.0.0.1:8765/api/v1/fredy/events',
      authToken: 'secret',
    },
  };

  it('recognizes only the application event endpoint', () => {
    expect(isApplicationEndpoint(channel.fields.endpointUrl)).toBe(true);
    expect(isApplicationEndpoint('http://127.0.0.1:8765/api/v1/fredy/events/')).toBe(true);
    expect(isApplicationEndpoint('http://127.0.0.1:8765/anything-else')).toBe(false);
    expect(findApplicationChannel([{ id: 'telegram', fields: {} }, channel])).toBe(channel);
  });

  it('uses a strict direct-provider match when one exists and otherwise the source provider', () => {
    const direct = {
      ...listing,
      officialProvider: 'gewobag',
      providerLink: 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/1/',
    };
    expect(applicationProvider('immoscout', direct)).toBe('gewobag');
    expect(applicationUrl(direct)).toBe(direct.providerLink);
    expect(applicationProvider('immoscout', listing)).toBe('immoscout');
    expect(applicationUrl(listing)).toBe(listing.link);
    expect(
      applicationProvider('inberlinwohnen', {
        ...listing,
        link: 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/2',
      }),
    ).toBe('gewobag');
  });

  it('discovers the bundled local module without a configured HTTP channel', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        service: 'fredy-application-module',
        endpointUrl: 'http://127.0.0.1:8765/api/v1/fredy/events',
        authToken: 'local-secret',
      }),
    }));

    const discovered = await discoverLocalApplicationChannel(fetchImpl);
    expect(discovered).toMatchObject({
      id: 'http',
      autoDiscovered: true,
      fields: {
        endpointUrl: 'http://127.0.0.1:8765/api/v1/fredy/events',
        authToken: 'local-secret',
      },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:8765/api/v1/fredy/discovery');
    expect(await resolveApplicationChannel([], fetchImpl)).toMatchObject({ autoDiscovered: true });
  });

  it('prefers a manually configured application channel over local discovery', async () => {
    const fetchImpl = vi.fn();
    expect(await resolveApplicationChannel([channel], fetchImpl)).toBe(channel);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects discovery responses that point outside the local machine', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        service: 'fredy-application-module',
        endpointUrl: 'https://example.test/api/v1/fredy/events',
        authToken: 'secret',
      }),
    }));
    expect(await discoverLocalApplicationChannel(fetchImpl)).toBeNull();
  });

  it('reads active workflow providers from the module with the configured bearer token', async () => {
    const fetchImpl = vi.fn(async (url, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ providers: ['Gewobag', 'howoge'] }),
      url,
      options,
    }));
    const providers = await fetchWorkflowProviders(channel, fetchImpl);
    expect(providers).toEqual(new Set(['gewobag', 'howoge']));
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:8765/api/v1/fredy/workflows');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
  });

  it('builds the same application event for auto and Telegram triggers', () => {
    const body = buildApplicationEvent({
      jobId: 'top',
      provider: 'gewobag',
      listing,
      trigger: 'telegram',
      callbackUrl: 'http://127.0.0.1:9998/api/application/status/top/flat-1',
      baseUrl: 'http://fredy.test',
    });
    expect(body.event).toBe('listings');
    expect(body.provider).toBe('gewobag');
    expect(body.listings[0]).toMatchObject({
      id: 'flat-1',
      url: listing.link,
      applyRequested: true,
      applicationTrigger: 'telegram',
      callbackUrl: 'http://127.0.0.1:9998/api/application/status/top/flat-1',
    });
  });
});
