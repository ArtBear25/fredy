/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  listing: null,
  identityRows: [],
  job: null,
  updatedRows: [],
  updatePatches: [],
  outboxBody: null,
  deliverCalls: 0,
  refreshedRows: [],
}));

vi.mock('../../../lib/services/storage/jobStorage.js', () => ({
  getJobs: () => (state.job ? [state.job] : []),
  getJob: (jobId) => (state.job?.id === jobId ? state.job : null),
}));

vi.mock('../../../lib/services/storage/listingsStorage.js', () => ({
  getListingById: (id) => (state.listing?.id === id ? state.listing : null),
  getListingsByApplicationIdentity: () => state.identityRows,
  updateApplicationByIdentity: (_provider, _url, patch) => {
    state.updatePatches.push(patch);
    state.updatedRows = state.identityRows.map((row) => ({
      ...row,
      application: { ...row.application, ...patch },
    }));
    state.identityRows = state.updatedRows;
    return state.updatedRows;
  },
}));

vi.mock('../../../lib/services/storage/settingsStorage.js', () => ({
  getSettings: async () => ({ port: 9998, baseUrl: 'http://fredy.test' }),
}));

vi.mock('../../../lib/notification/httpOutbox.js', () => ({
  getHttpOutbox: async () => ({
    enqueue: (_endpoint, _jobId, body) => {
      state.outboxBody = body;
      return 'outbox-1';
    },
    deliver: async () => {
      state.deliverCalls += 1;
      return { ok: true };
    },
  }),
}));

vi.mock('../../../lib/notification/adapter/telegram.js', () => ({
  refreshApplicationMessages: async ({ listing }) => {
    state.refreshedRows.push(listing.id);
  },
}));

const telegramChannel = {
  id: 'telegram',
  configuredAdapterId: 'telegram-main',
  fields: { token: 'BOT', chatId: '999' },
};
const applicationChannel = {
  id: 'http',
  configuredAdapterId: 'application-module',
  applicantWbs: { hasWbs: true, type: '100' },
  fields: {
    endpointUrl: 'http://127.0.0.1:8765/api/v1/fredy/events',
    authToken: 'secret',
  },
};

function callbackQuery() {
  return {
    id: 'callback-1',
    data: 'fredy_apply:flat-1',
    message: { chat: { id: 999 } },
  };
}

function fetchImpl(url, options = {}) {
  if (url === 'http://127.0.0.1:8765/api/v1/fredy/workflows') {
    expect(options.headers.Authorization).toBe('Bearer secret');
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ providers: ['gewobag'] }) });
  }
  if (url === 'https://api.telegram.org/botBOT/answerCallbackQuery') {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  }
  throw new Error(`Unexpected URL ${url}`);
}

beforeEach(() => {
  state.job = {
    id: 'top-job',
    userId: 'user-1',
    name: 'Top Wohnungen',
    notificationAdapter: [telegramChannel, applicationChannel],
  };
  state.listing = {
    id: 'flat-1',
    job_id: 'top-job',
    provider: 'immoscout',
    title: 'Wohnung',
    description: '',
    address: 'Musterstraße 1, Berlin',
    price: 900,
    size: 50,
    rooms: 2,
    image_url: null,
    application: {
      provider: 'gewobag',
      url: 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/flat-1',
      state: 'idle',
      workflowAvailable: true,
      autoMatched: false,
    },
  };
  state.identityRows = [state.listing];
  state.updatedRows = [];
  state.updatePatches = [];
  state.outboxBody = null;
  state.deliverCalls = 0;
  state.refreshedRows = [];
});

describe('Telegram one-tap application callback', () => {
  it('turns one click into the same queued application event used by auto-apply', async () => {
    const { handleApplicationCallback } = await import(
      '../../../lib/services/application/telegramApplicationPoller.js'
    );

    const result = await handleApplicationCallback({ token: 'BOT', callbackQuery: callbackQuery(), fetchImpl });

    expect(result).toEqual({ status: 'running', queued: true });
    expect(state.updatePatches[0]).toMatchObject({
      state: 'running',
      trigger: 'telegram',
      workflowAvailable: true,
    });
    expect(state.outboxBody).toMatchObject({
      event: 'listings',
      jobId: 'top-job',
      provider: 'gewobag',
    });
    expect(state.outboxBody.listings[0]).toMatchObject({
      id: 'flat-1',
      url: 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/flat-1',
      applyRequested: true,
      applicationTrigger: 'telegram',
      callbackUrl: 'http://127.0.0.1:9998/api/application/status/top-job/flat-1',
    });
    expect(state.deliverCalls).toBe(1);
  });

  it('refuses the manual Telegram action when the stored WBS check blocked the listing', async () => {
    state.listing.application = {
      ...state.listing.application,
      wbsStatus: 'specific',
      wbsLevels: [160, 220],
      wbsCompatible: false,
    };
    state.identityRows = [state.listing];
    const { handleApplicationCallback } = await import(
      '../../../lib/services/application/telegramApplicationPoller.js'
    );

    const result = await handleApplicationCallback({ token: 'BOT', callbackQuery: callbackQuery(), fetchImpl });

    expect(result).toEqual({ status: 'wbs-blocked' });
    expect(state.outboxBody).toBeNull();
    expect(state.updatePatches).toHaveLength(0);
    expect(state.deliverCalls).toBe(0);
  });

  it('does not queue a second application when another job row already shows the same flat as applied', async () => {
    state.identityRows = [
      state.listing,
      {
        ...state.listing,
        id: 'flat-other-job',
        job_id: 'broad-job',
        status: { status: 'applied' },
        application: { ...state.listing.application, state: 'applied' },
      },
    ];
    const { handleApplicationCallback } = await import(
      '../../../lib/services/application/telegramApplicationPoller.js'
    );

    const result = await handleApplicationCallback({ token: 'BOT', callbackQuery: callbackQuery(), fetchImpl });

    expect(result).toEqual({ status: 'applied' });
    expect(state.outboxBody).toBeNull();
    expect(state.updatePatches).toHaveLength(0);
    expect(state.deliverCalls).toBe(0);
  });
});
