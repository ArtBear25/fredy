/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const root = (await import('node:path')).resolve('.');
const settingsStoragePath = root + '/lib/services/storage/settingsStorage.js';
const jobStoragePath = root + '/lib/services/storage/jobStorage.js';

let stored;
let jobs;

async function buildServer() {
  vi.resetModules();
  vi.doMock(settingsStoragePath, () => ({
    getSettings: async () => ({ demoMode: false }),
    getUserSettings: () => stored,
    getAddresses: (settings) => (Array.isArray(settings?.home_addresses) ? settings.home_addresses : []),
    upsertSettings: (values) => Object.assign(stored, values),
  }));
  vi.doMock(jobStoragePath, () => ({
    getJobs: () => jobs,
  }));
  const plugin = (await import(root + '/lib/api/routes/userSettingsRoute.js')).default;
  const app = Fastify();
  app.addHook('preHandler', (request, _reply, done) => {
    request.session = { currentUser: 'user-1' };
    request.currentUser = { id: 'user-1', isAdmin: false };
    done();
  });
  await app.register(plugin, { prefix: '/api/user/settings' });
  return app;
}

beforeEach(() => {
  stored = { home_addresses: [{ label: 'Arbeit' }, { label: 'Kitty' }] };
  jobs = [
    { id: 'top', name: 'Top Wohnungen', userId: 'user-1' },
    { id: 'other', name: 'Andere Person', userId: 'user-2' },
  ];
});

describe('POST /api/user/settings/auto-apply', () => {
  it('stores the one fixed auto rule with owned jobs and saved places', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/api/user/settings/auto-apply',
      payload: {
        auto_apply: {
          enabled: true,
          jobIds: ['top'],
          maxPrice: 1000,
          minSize: 45,
          minRooms: 2,
          travelTimes: [{ label: 'Arbeit', mode: 'transit', maxMinutes: 20 }],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(stored.auto_apply).toEqual({
      enabled: true,
      jobIds: ['top'],
      maxPrice: 1000,
      minSize: 45,
      minRooms: 2,
      travelTimes: [{ label: 'Arbeit', mode: 'transit', maxMinutes: 20 }],
    });
    await app.close();
  });

  it('rejects foreign jobs and unknown places', async () => {
    const app = await buildServer();
    const foreignJob = await app.inject({
      method: 'POST',
      url: '/api/user/settings/auto-apply',
      payload: { auto_apply: { enabled: true, jobIds: ['other'] } },
    });
    expect(foreignJob.statusCode).toBe(400);

    const unknownPlace = await app.inject({
      method: 'POST',
      url: '/api/user/settings/auto-apply',
      payload: {
        auto_apply: {
          enabled: true,
          travelTimes: [{ label: 'Unbekannt', mode: 'walk', maxMinutes: 10 }],
        },
      },
    });
    expect(unknownPlace.statusCode).toBe(400);
    await app.close();
  });
});
