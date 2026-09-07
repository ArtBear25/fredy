/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  listing: null,
  job: null,
  patches: [],
  statusWrites: [],
  rows: [],
}));

vi.mock('../../lib/services/storage/jobStorage.js', () => ({
  getJob: (id) => (state.job?.id === id ? state.job : null),
}));

vi.mock('../../lib/services/storage/listingsStorage.js', () => ({
  getListingById: (id) => (state.listing?.id === id ? state.listing : null),
  updateApplicationByIdentity: (_provider, _url, patch) => {
    state.patches.push(patch);
    state.rows = state.rows.map((row) => ({
      ...row,
      application: { ...row.application, ...patch },
    }));
    return state.rows;
  },
  setListingStatus: (id, status) => {
    state.statusWrites.push({ id, status });
    return 1;
  },
}));

vi.mock('../../lib/services/storage/settingsStorage.js', () => ({
  getSettings: async () => ({ baseUrl: 'http://fredy.test' }),
}));

vi.mock('../../lib/notification/adapter/telegram.js', () => ({
  refreshApplicationMessages: async () => {},
}));

async function buildServer() {
  const plugin = (await import('../../lib/api/routes/applicationRouter.js')).default;
  const app = Fastify();
  await app.register(plugin, { prefix: '/api/application' });
  return app;
}

beforeEach(() => {
  const application = {
    provider: 'gewobag',
    url: 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/flat-1',
    state: 'running',
    trigger: 'auto',
  };
  state.listing = { id: 'flat-1', job_id: 'top-job', application };
  state.job = {
    id: 'top-job',
    notificationAdapter: [
      {
        id: 'http',
        configuredAdapterId: 'application-module',
        fields: {
          endpointUrl: 'http://127.0.0.1:8765/api/v1/fredy/events',
          authToken: 'secret',
        },
      },
    ],
  };
  state.rows = [
    state.listing,
    { id: 'flat-same-other-job', job_id: 'broad-job', application: { ...application } },
  ];
  state.patches = [];
  state.statusWrites = [];
});

describe('application module status callback', () => {
  it('marks every Fredy row for the same concrete flat as applied after workflow success', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/api/application/status/top-job/flat-1',
      headers: { Authorization: 'Bearer secret' },
      payload: { status: 'applied', applicationId: 17, trigger: 'auto' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, updated: 2 });
    expect(state.patches[0]).toMatchObject({ state: 'applied', applicationId: 17, trigger: 'auto' });
    expect(state.statusWrites).toEqual([
      { id: 'flat-1', status: 'applied' },
      { id: 'flat-same-other-job', status: 'applied' },
    ]);
    await app.close();
  });

  it('persists a failed application without falsely setting Fredy to applied', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/api/application/status/top-job/flat-1',
      headers: { Authorization: 'Bearer secret' },
      payload: { status: 'failed', detail: 'Form changed', trigger: 'telegram' },
    });

    expect(response.statusCode).toBe(200);
    expect(state.patches[0]).toMatchObject({ state: 'failed', detail: 'Form changed', trigger: 'telegram' });
    expect(state.statusWrites).toHaveLength(0);
    await app.close();
  });

  it('rejects callbacks that do not carry the application channel bearer token', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/api/application/status/top-job/flat-1',
      headers: { Authorization: 'Bearer wrong' },
      payload: { status: 'applied' },
    });

    expect(response.statusCode).toBe(401);
    expect(state.patches).toHaveLength(0);
    expect(state.statusWrites).toHaveLength(0);
    await app.close();
  });
});
