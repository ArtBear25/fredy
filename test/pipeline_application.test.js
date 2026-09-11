/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFredy } from './utils.js';
import * as mockStore from './mocks/mockStore.js';

const httpMock = vi.hoisted(() => ({ send: vi.fn(() => Promise.resolve({ ok: true })) }));
vi.mock('../lib/notification/adapter/http.js', () => ({ send: httpMock.send }));

const applicationChannel = {
  id: 'http',
  configuredAdapterId: 'application-module',
  applicantWbs: { hasWbs: true, type: '100' },
  applicantEligibility: { specialHousingNeed: false, age55Plus: false },
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

async function run({
  rule,
  providers,
  fetchError = null,
  notificationAdapter = [applicationChannel],
  fetchImpl = null,
  listingOverride = {},
  pipelineOptions = {},
}) {
  mockStore.setUserSettings({ auto_apply: rule });
  vi.stubGlobal(
    'fetch',
    fetchImpl ??
      vi.fn(async (url, options) => {
        expect(url).toBe('http://127.0.0.1:8765/api/v1/fredy/workflows');
        expect(options.headers.Authorization).toBe('Bearer secret');
        if (fetchError) throw fetchError;
        return { ok: true, status: 200, json: async () => ({ providers }) };
      }),
  );
  const Fredy = await mockFredy();
  const pipeline = new Fredy(
    {
      url: 'https://example.test/search',
      getListings: async () => [{ ...listing(), ...listingOverride }],
      normalize: (value) => value,
      filter: () => true,
      crawlFields: { id: 'id', title: 'title', address: 'address', price: 'price' },
      requiredFieldNames: ['id', 'title', 'address', 'price'],
    },
    {
      id: 'top-job',
      notificationAdapter,
      specFilter: null,
      spatialFilter: null,
      commuteFilter: null,
    },
    'gewobag',
    { checkAndAddEntry: () => false },
    undefined,
    pipelineOptions,
  );
  return pipeline.execute();
}

beforeEach(() => {
  mockStore.setUserSettings({});
  httpMock.send.mockClear();
  mockStore.pendingAreaRechecks.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockStore.pendingAreaRechecks.length = 0;
});

describe('pipeline application decision', () => {
  it('suppresses applications during a recheck but allows them in the following normal run', async () => {
    const args = { rule: { enabled: true, jobIds: ['top-job'] }, providers: ['gewobag'] };
    const recheck = await run({ ...args, pipelineOptions: { skipAutoApply: true } });
    expect(recheck[0]).toMatchObject({
      applyRequested: false,
      application: { criteriaMatched: true, autoEligible: false, autoApplySuppressed: true, state: 'idle' },
    });
    expect(recheck[0].applicationTrigger).toBeUndefined();
    const normal = await run({
      ...args,
      listingOverride: {
        id: 'new-after-recheck',
        link: 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/new',
      },
    });
    expect(normal[0]).toMatchObject({
      applyRequested: true,
      application: { autoEligible: true, autoApplySuppressed: false, state: 'running' },
    });
  });

  it('keeps a queued historical offer notification-only when a later normal scan processes it', async () => {
    mockStore.pendingAreaRechecks.push(listing());
    const historical = await run({ rule: { enabled: true, jobIds: ['top-job'] }, providers: ['gewobag'] });
    expect(historical[0]).toMatchObject({
      areaRecheck: true,
      applyRequested: false,
      application: { autoApplySuppressed: true, state: 'idle' },
    });
    mockStore.pendingAreaRechecks.length = 0;
    const fresh = await run({
      rule: { enabled: true, jobIds: ['top-job'] },
      providers: ['gewobag'],
      listingOverride: { id: 'new-next-scan' },
    });
    expect(fresh[0].applyRequested).toBe(true);
  });

  it('auto-discovers the local module and sends an eligible application without an HTTP channel on the job', async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      if (url === 'http://127.0.0.1:8765/api/v1/fredy/discovery') {
        return {
          ok: true,
          json: async () => ({
            service: 'fredy-application-module',
            endpointUrl: 'http://127.0.0.1:8765/api/v1/fredy/events',
            authToken: 'secret',
            applicantWbs: { hasWbs: true, type: '100' },
            applicantEligibility: { specialHousingNeed: false, age55Plus: false },
          }),
        };
      }
      expect(url).toBe('http://127.0.0.1:8765/api/v1/fredy/workflows');
      expect(options.headers.Authorization).toBe('Bearer secret');
      return { ok: true, status: 200, json: async () => ({ providers: ['gewobag'] }) };
    });

    const result = await run({
      rule: { enabled: true, jobIds: ['top-job'] },
      providers: ['gewobag'],
      notificationAdapter: [],
      fetchImpl,
    });

    expect(result[0].application).toMatchObject({ autoEligible: true, workflowStatus: 'available', state: 'running' });
    expect(httpMock.send).toHaveBeenCalledTimes(1);
    expect(httpMock.send.mock.calls[0][0]).toMatchObject({
      jobKey: 'top-job',
      notificationConfig: [
        {
          id: 'http',
          autoDiscovered: true,
          applicantWbs: { hasWbs: true, type: '100' },
          applicantEligibility: { specialHousingNeed: false, age55Plus: false },
          fields: {
            endpointUrl: 'http://127.0.0.1:8765/api/v1/fredy/events',
            authToken: 'secret',
          },
        },
      ],
    });
  });

  it('allows WBS 100 but blocks an elevated WBS requirement before Selenium is queued', async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      if (url === 'http://127.0.0.1:8765/api/v1/fredy/discovery') {
        return {
          ok: true,
          json: async () => ({
            service: 'fredy-application-module',
            endpointUrl: 'http://127.0.0.1:8765/api/v1/fredy/events',
            authToken: 'secret',
            applicantWbs: { hasWbs: true, type: '100' },
            applicantEligibility: { specialHousingNeed: false, age55Plus: false },
          }),
        };
      }
      expect(url).toBe('http://127.0.0.1:8765/api/v1/fredy/workflows');
      expect(options.headers.Authorization).toBe('Bearer secret');
      return { ok: true, status: 200, json: async () => ({ providers: ['gewobag'] }) };
    });

    const compatible = await run({
      rule: { enabled: true, jobIds: ['top-job'] },
      providers: ['gewobag'],
      notificationAdapter: [],
      fetchImpl,
      listingOverride: { title: '2-Zimmer-Wohnung mit WBS 100' },
    });
    expect(compatible[0]).toMatchObject({
      applyRequested: true,
      application: { wbsStatus: 'specific', wbsLevels: [100], wbsCompatible: true, autoEligible: true },
    });

    httpMock.send.mockClear();
    const elevated = await run({
      rule: { enabled: true, jobIds: ['top-job'] },
      providers: ['gewobag'],
      notificationAdapter: [],
      fetchImpl,
      listingOverride: { title: '2-Zimmer-Wohnung mit WBS160-220' },
    });
    expect(elevated[0].applyRequested).toBeUndefined();
    expect(elevated[0].application).toMatchObject({
      wbsStatus: 'specific',
      wbsLevels: [160, 180, 220],
      wbsCompatible: false,
      autoEligible: false,
      state: 'idle',
    });
    expect(httpMock.send).not.toHaveBeenCalled();
  });

  it('fails open for an ambiguous income alternative instead of suppressing the application', async () => {
    const result = await run({
      rule: { enabled: true, jobIds: ['top-job'] },
      providers: ['gewobag'],
      listingOverride: { title: 'WBS 160/180/220 oder entsprechendes Einkommen' },
    });

    expect(result[0]).toMatchObject({
      applyRequested: true,
      application: { wbsStatus: 'unclear', wbsCompatible: true, autoEligible: true, state: 'running' },
    });
  });

  it('blocks a known special-housing-need requirement but allows an explicit optional one', async () => {
    const blocked = await run({
      rule: { enabled: true, jobIds: ['top-job'] },
      providers: ['gewobag'],
      listingOverride: { title: 'WBS 100 / 140 mit besonderem Wohnbedarf' },
    });
    expect(blocked[0].applyRequested).toBeUndefined();
    expect(blocked[0].application).toMatchObject({
      wbsCompatible: true,
      specialHousingNeedRequired: true,
      specialHousingNeedCompatible: false,
      autoEligible: false,
      state: 'idle',
    });

    httpMock.send.mockClear();
    const optional = await run({
      rule: { enabled: true, jobIds: ['top-job'] },
      providers: ['gewobag'],
      listingOverride: { title: 'WBS 100-140 mit und ohne besonderem Wohnbedarf' },
    });
    expect(optional[0]).toMatchObject({
      applyRequested: true,
      application: { specialHousingNeedRequired: false, autoEligible: true, state: 'running' },
    });
  });

  it.each([
    ['55 years', 'Barrierearmes Wohnen im Dröpkeweg! Ab 55 Jahren!', 55],
    ['60 years', 'Seniorenresidenz Alt-Britz / erst ab 60 Jahren', 60],
  ])('blocks a known senior minimum age of %s before Selenium is queued', async (_label, title, minimumAge) => {
    const result = await run({
      rule: { enabled: true, jobIds: ['top-job'] },
      providers: ['gewobag'],
      listingOverride: { title },
    });

    expect(result[0].applyRequested).toBeUndefined();
    expect(result[0].application).toMatchObject({
      age55PlusRequired: true,
      minimumAge,
      age55PlusCompatible: false,
      autoEligible: false,
      state: 'idle',
    });
  });

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
        criteriaMatched: true,
        autoEligible: true,
        workflowStatus: 'available',
        workflowAvailable: true,
        state: 'running',
        trigger: 'auto',
      },
    });
  });

  it('keeps filter matching separate from execution readiness when the provider workflow is missing', async () => {
    const result = await run({
      rule: { enabled: true, jobIds: ['top-job'], maxPrice: 1000 },
      providers: [],
    });

    expect(result[0].applyRequested).toBeUndefined();
    expect(result[0].application).toMatchObject({
      provider: 'gewobag',
      criteriaMatched: true,
      autoEligible: false,
      workflowStatus: 'missing',
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
      criteriaMatched: false,
      autoEligible: false,
      workflowStatus: 'available',
      workflowAvailable: true,
      state: 'idle',
    });
  });

  it('does not misreport a temporary workflow lookup failure as a missing provider workflow', async () => {
    const result = await run({
      rule: { enabled: true, jobIds: ['top-job'], maxPrice: 1000 },
      fetchError: new Error('connection refused'),
    });

    expect(result[0].applyRequested).toBeUndefined();
    expect(result[0].application).toMatchObject({
      provider: 'gewobag',
      criteriaMatched: true,
      autoEligible: false,
      workflowStatus: 'unreachable',
      workflowAvailable: false,
      state: 'idle',
    });
  });
});
