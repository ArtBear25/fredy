/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

describe('services/jobs/jobExecutionService', () => {
  /** @type {EventEmitter} */
  let bus;
  let calls;
  let state;

  async function initService(settings = { demoMode: false }) {
    const root = (await import('node:path')).resolve('.');
    const svcPath = root + '/lib/services/jobs/jobExecutionService.js';
    const busPath = root + '/lib/services/events/event-bus.js';
    const jobStoragePath = root + '/lib/services/storage/jobStorage.js';
    const userStoragePath = root + '/lib/services/storage/userStorage.js';
    const settingsStoragePath = root + '/lib/services/storage/settingsStorage.js';
    const listingsStoragePath = root + '/lib/services/storage/listingsStorage.js';
    const brokerPath = root + '/lib/services/sse/sse-broker.js';
    const utilsPath = root + '/lib/utils.js';
    const loggerPath = root + '/lib/services/logger.js';
    const notifyPath = root + '/lib/notification/notify.js';
    const pipelinePath = root + '/lib/FredyPipelineExecutioner.js';
    const puppeteerPath = root + '/lib/services/extractor/puppeteerExtractor.js';

    vi.resetModules();
    vi.doMock(busPath, () => ({ bus }));
    vi.doMock(jobStoragePath, () => ({
      getJob: (id) => state.jobsById[id] || null,
      getJobs: () => state.jobsList.slice(),
      updateJobLastRunAt: (id, timestamp) => calls.lastRunUpdates.push({ id, timestamp }),
    }));
    vi.doMock(userStoragePath, () => ({
      getUsers: () => state.users.slice(),
      getUser: (id) => state.users.find((u) => u.id === id) || null,
    }));
    // The service reads settings live rather than from a snapshot handed in at startup, so demo
    // mode and working hours follow the settings UI without a restart. The mock therefore has to
    // serve what the scenario configured.
    vi.doMock(settingsStoragePath, () => ({
      getSettings: async () => settings,
    }));
    vi.doMock(listingsStoragePath, () => ({
      getActiveListingsForJobAndProvider: () => state.knownScoutListings.slice(),
    }));
    vi.doMock(brokerPath, () => ({
      sendToUsers: (...args) => calls.sent.push(args),
    }));
    vi.doMock(utilsPath, () => ({
      duringWorkingHoursOrNotSet: () => false,
      getPackageVersion: async () => '0.0.0-test',
    }));
    vi.doMock(loggerPath, () => {
      const m = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
      return { default: m };
    });
    vi.doMock(notifyPath, () => ({ send: async () => [] }));
    vi.doMock(puppeteerPath, () => ({
      launchBrowser: async (...args) => {
        calls.launchBrowser.push(args);
        return state.browser;
      },
      closeBrowser: async (browser) => {
        calls.closeBrowser.push(browser);
      },
    }));
    vi.doMock(pipelinePath, () => ({
      default: class {
        constructor(config, job, providerId, similarityCache, browser, options = {}) {
          this.providerId = providerId;
          this.options = options;
          calls.pipeline.push({ config, job, providerId, similarityCache, browser, options, instance: this });
        }

        async execute() {
          calls.timeline.push(`execute:${this.providerId}`);
          if (state.pipelineErrors[this.providerId]) throw state.pipelineErrors[this.providerId];
          return state.pipelineResults[this.providerId];
        }

        async notify(listings) {
          calls.timeline.push(`notify:${this.providerId}`);
          calls.notifications.push({ providerId: this.providerId, listings });
          return listings;
        }
      },
    }));
    vi.doMock(root + '/lib/services/demo/demoService.js', () => ({
      DEMO_JOB_ID: 'demo-job',
      isDemoJob: (jobId) => jobId === 'demo-job',
    }));
    vi.doMock(root + '/lib/services/jobs/run-state.js', () => ({
      isRunning: () => false,
      markRunning: (id) => {
        calls.markRunning.push(id);
        return true;
      },
      markFinished: (id) => calls.markFinished.push(id),
    }));

    const mod = await import(svcPath);
    mod.initJobExecutionService({ providers: state.providers, intervalMs: 0 });
    return mod;
  }

  beforeEach(() => {
    bus = new EventEmitter();
    calls = {
      sent: [],
      markRunning: [],
      markFinished: [],
      lastRunUpdates: [],
      launchBrowser: [],
      closeBrowser: [],
      pipeline: [],
      notifications: [],
      timeline: [],
    };
    state = {
      jobsById: {},
      jobsList: [],
      users: [],
      providers: [],
      browser: { connected: true },
      pipelineResults: {},
      pipelineErrors: {},
      knownScoutListings: [],
    };
  });

  it('forwards SSE jobStatus to owner, shared users and admins', async () => {
    state.jobsById['j1'] = { id: 'j1', userId: 'owner1', shared_with_user: ['u2'] };
    state.users = [
      { id: 'a1', isAdmin: true },
      { id: 'owner1', isAdmin: false },
      { id: 'u2', isAdmin: false },
    ];

    await initService();

    bus.emit('jobs:status', { jobId: 'j1', running: true });

    expect(calls.sent.length, 'sendToUsers should be called once').toBe(1);
    const [recipients, event, data] = calls.sent[0];
    expect(event).toBe('jobStatus');
    expect(data).toEqual({ jobId: 'j1', running: true });
    const got = new Set(recipients);
    const expected = new Set(['owner1', 'u2', 'a1']);
    expect(got).toEqual(expected);
  });

  it('runs all jobs for admin; only own jobs for regular user', async () => {
    state.jobsList = [
      { id: 'j1', enabled: true, userId: 'u1', provider: [] },
      { id: 'j2', enabled: true, userId: 'u2', provider: [] },
    ];
    state.users = [
      { id: 'u1', isAdmin: false },
      { id: 'u2', isAdmin: false },
      { id: 'admin', isAdmin: true },
    ];

    await initService();

    // Non-admin: only own jobs
    bus.emit('jobs:runAll', { userId: 'u1' });
    // allow microtasks to flush
    await new Promise((r) => setTimeout(r, 0));
    expect(new Set(calls.markRunning)).toEqual(new Set(['j1']));

    // Admin: all jobs
    calls.markRunning = [];
    bus.emit('jobs:runAll', { userId: 'admin' });
    await new Promise((r) => setTimeout(r, 0));
    expect(new Set(calls.markRunning)).toEqual(new Set(['j1', 'j2']));
  });

  it('persists last_run_at when a job is executed', async () => {
    state.jobsById['j1'] = { id: 'j1', enabled: true, userId: 'u1', provider: [] };
    state.jobsList = [state.jobsById['j1']];
    state.users = [{ id: 'u1', isAdmin: false }];

    await initService();

    const before = Date.now();
    bus.emit('jobs:runOne', { jobId: 'j1' });
    await new Promise((r) => setTimeout(r, 0));
    const after = Date.now();

    expect(calls.lastRunUpdates.length).toBe(1);
    const [update] = calls.lastRunUpdates;
    expect(update.id).toBe('j1');
    expect(update.timestamp).toBeGreaterThanOrEqual(before);
    expect(update.timestamp).toBeLessThanOrEqual(after);
  });

  it('launches and reuses a single shared browser across all providers in a job', async () => {
    // Providers hand out a fresh config per run instead of mutating a shared one, so the double
    // mirrors that: createConfig() returns a new object every time it is called.
    const provider = (id, config) => ({
      metaInformation: { id },
      createConfig: vi.fn((sourceConfig, blacklist) => ({ ...config, blacklist })),
    });
    state.providers = [
      provider('api-provider', { url: 'https://api.example/', getListings: vi.fn() }),
      provider('browser-provider', {
        url: 'https://browser.example/',
        getListings: vi.fn(),
      }),
      provider('browser-provider-2', {
        url: 'https://browser-2.example/',
        getListings: vi.fn(),
      }),
    ];
    state.jobsById.j1 = {
      id: 'j1',
      enabled: true,
      userId: 'u1',
      provider: state.providers.map(({ metaInformation }) => ({ id: metaInformation.id })),
    };

    await initService();
    bus.emit('jobs:runOne', { jobId: 'j1' });
    await vi.waitFor(() => expect(calls.markFinished).toEqual(['j1']));

    expect(calls.launchBrowser).toEqual([['https://api.example/', {}]]);
    expect(calls.pipeline.map(({ browser }) => browser)).toEqual([state.browser, state.browser, state.browser]);
    expect(calls.closeBrowser).toEqual([state.browser]);
  });

  describe('strict Scout24/provider notification merge', () => {
    const provider = (id) => ({
      metaInformation: { id },
      createConfig: vi.fn((sourceConfig, blacklist) => ({
        url: sourceConfig.url || `https://${id}.example/search`,
        blacklist,
      })),
    });
    const scoutListing = {
      id: 'scout-1',
      title: 'Scout Wohnung',
      link: 'https://www.immobilienscout24.de/expose/1',
      address: 'Dolgenseestr. 38, 10319 Berlin',
      price: 619,
      size: 63,
      rooms: 2,
    };
    const directLinks = {
      howoge: 'https://www.howoge.de/immobiliensuche/wohnungssuche/detail/1.html',
      degewo: 'https://www.degewo.de/immosuche/details/1',
      wbm: 'https://www.wbm.de/wohnungen-berlin/angebote/1',
    };
    const officialListing = (providerId) => ({
      id: `${providerId}-1`,
      title: scoutListing.title,
      link: directLinks[providerId],
      address: 'Dolgenseestraße 38, 10319 Berlin-Lichtenberg, Deutschland',
      price: 618.19,
      size: 63.8,
      rooms: 2,
    });

    it.each(['howoge', 'degewo', 'wbm'])(
      'emits one Scout notification with both links when %s is active and matches uniquely',
      async (providerId) => {
        state.providers = [provider('immoscout'), provider(providerId)];
        state.jobsById.j1 = {
          id: 'j1',
          enabled: true,
          userId: 'u1',
          provider: [{ id: 'immoscout' }, { id: providerId }],
        };
        state.pipelineResults = {
          immoscout: [scoutListing],
          [providerId]: [officialListing(providerId)],
        };

        await initService();
        bus.emit('jobs:runOne', { jobId: 'j1' });
        await vi.waitFor(() => expect(calls.markFinished).toEqual(['j1']));

        expect(calls.notifications).toEqual([
          {
            providerId: 'immoscout',
            listings: [{ ...scoutListing, officialProvider: providerId, providerLink: directLinks[providerId] }],
          },
        ]);
        const scoutRun = calls.pipeline.find((entry) => entry.providerId === 'immoscout');
        const officialRun = calls.pipeline.find((entry) => entry.providerId === providerId);
        expect(scoutRun.options).toMatchObject({
          deferNotification: true,
          forceDetails: true,
          forceMissingRoomDetails: false,
          similarityIgnoredProviders: [providerId],
        });
        expect(officialRun.options).toMatchObject({
          deferNotification: true,
          similarityIgnoredProviders: ['immoscout'],
        });
      },
    );

    it('suppresses the InBerlinWohnen duplicate when Scout and Gewobag match in the same run', async () => {
      const gewobagLink = 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/7100-79011-0101-0005';
      const scout = {
        id: 'scout-buttmann',
        title: 'Im Wedding!',
        link: 'https://www.immobilienscout24.de/expose/170555494',
        officialProvider: 'gewobag',
        address: 'Buttmannstr. 4, 13357 Berlin, Wedding',
        price: 693,
        size: 88,
        rooms: 2,
      };
      const inBerlinWohnen = {
        id: 'ibw-buttmann',
        title: 'Im Wedding!',
        link: gewobagLink,
        address: 'Buttmannstraße 4, 13357 Berlin, Mitte',
        price: 692.35,
        size: 87.54,
        rooms: 2,
      };
      state.providers = [provider('immoscout'), provider('inberlinwohnen')];
      state.jobsById.j1 = {
        id: 'j1',
        enabled: true,
        userId: 'u1',
        provider: [{ id: 'immoscout' }, { id: 'inberlinwohnen' }],
      };
      state.pipelineResults = { immoscout: [scout], inberlinwohnen: [inBerlinWohnen] };

      await initService();
      bus.emit('jobs:runOne', { jobId: 'j1' });
      await vi.waitFor(() => expect(calls.markFinished).toEqual(['j1']));

      expect(calls.notifications).toEqual([
        {
          providerId: 'immoscout',
          listings: [{ ...scout, providerLink: gewobagLink }],
        },
      ]);
    });

    it('is independent of provider order within the same job run', async () => {
      state.providers = [provider('immoscout'), provider('howoge')];
      state.jobsById.j1 = {
        id: 'j1',
        enabled: true,
        userId: 'u1',
        provider: [{ id: 'howoge' }, { id: 'immoscout' }],
      };
      state.pipelineResults = {
        immoscout: [scoutListing],
        howoge: [officialListing('howoge')],
      };

      await initService();
      bus.emit('jobs:runOne', { jobId: 'j1' });
      await vi.waitFor(() => expect(calls.markFinished).toEqual(['j1']));

      expect(calls.notifications).toEqual([
        {
          providerId: 'immoscout',
          listings: [{ ...scoutListing, officialProvider: 'howoge', providerLink: directLinks.howoge }],
        },
      ]);
    });

    it('runs Scout and official providers first and notifies before ordinary portals start', async () => {
      state.providers = [provider('immowelt'), provider('howoge'), provider('immoscout')];
      state.jobsById.j1 = {
        id: 'j1',
        enabled: true,
        userId: 'u1',
        provider: [{ id: 'immowelt' }, { id: 'howoge' }, { id: 'immoscout' }],
      };
      state.pipelineResults = {
        immoscout: [scoutListing],
        howoge: [officialListing('howoge')],
        immowelt: [{ id: 'welt-1' }],
      };

      await initService();
      bus.emit('jobs:runOne', { jobId: 'j1' });
      await vi.waitFor(() => expect(calls.markFinished).toEqual(['j1']));

      expect(calls.timeline.slice(0, 4)).toEqual([
        'execute:immoscout',
        'execute:howoge',
        'notify:immoscout',
        'execute:immowelt',
      ]);
      expect(calls.pipeline.filter((entry) => entry.providerId === 'immoscout')).toHaveLength(1);
      expect(calls.pipeline.filter((entry) => entry.providerId === 'howoge')).toHaveLength(1);
      expect(calls.pipeline.filter((entry) => entry.providerId === 'immowelt')).toHaveLength(1);
    });

    it('matches a new InBerlinWohnen direct link to a Scout listing known before this run', async () => {
      const gewobagLink = 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/7100-79011-0101-0005';
      const knownScout = {
        id: 'stored-scout-1',
        title: 'Im Wedding!',
        link: 'https://www.immobilienscout24.de/expose/170555494',
        address: 'Buttmannstr. 4, 13357 Berlin, Wedding',
        price: 693,
        size: 88,
        rooms: 2,
      };
      const newDirect = {
        id: 'ibw-1',
        title: 'Im Wedding!',
        link: gewobagLink,
        address: 'Buttmannstraße 4, 13357 Berlin, Mitte',
        price: 692.35,
        size: 87.54,
        rooms: 2,
      };
      state.providers = [provider('immoscout'), provider('inberlinwohnen')];
      state.jobsById.j1 = {
        id: 'j1',
        enabled: true,
        userId: 'u1',
        provider: [{ id: 'immoscout' }, { id: 'inberlinwohnen' }],
      };
      state.knownScoutListings = [knownScout];
      state.pipelineResults = { immoscout: [], inberlinwohnen: [newDirect] };

      await initService();
      bus.emit('jobs:runOne', { jobId: 'j1' });
      await vi.waitFor(() => expect(calls.markFinished).toEqual(['j1']));

      expect(calls.notifications).toEqual([
        {
          providerId: 'immoscout',
          listings: [{ ...knownScout, officialProvider: 'gewobag', providerLink: gewobagLink }],
        },
      ]);
    });

    it('keeps a new official listing standalone when neither new nor known Scout listings match', async () => {
      state.providers = [provider('immoscout'), provider('howoge')];
      state.jobsById.j1 = {
        id: 'j1',
        enabled: true,
        userId: 'u1',
        provider: [{ id: 'immoscout' }, { id: 'howoge' }],
      };
      const unmatched = { ...officialListing('howoge'), address: 'Dolgenseestraße 40, 10319 Berlin' };
      state.pipelineResults = { immoscout: [], howoge: [unmatched] };

      await initService();
      bus.emit('jobs:runOne', { jobId: 'j1' });
      await vi.waitFor(() => expect(calls.markFinished).toEqual(['j1']));

      expect(calls.notifications).toEqual([{ providerId: 'howoge', listings: [unmatched] }]);
    });

    it('does not fetch or merge an official provider that is loaded globally but not active in the job', async () => {
      state.providers = [provider('immoscout'), provider('howoge'), provider('degewo')];
      state.jobsById.j1 = {
        id: 'j1',
        enabled: true,
        userId: 'u1',
        provider: [{ id: 'immoscout' }, { id: 'howoge' }],
      };
      state.pipelineResults = {
        immoscout: [scoutListing],
        howoge: [officialListing('howoge')],
      };

      await initService();
      bus.emit('jobs:runOne', { jobId: 'j1' });
      await vi.waitFor(() => expect(calls.markFinished).toEqual(['j1']));

      expect(calls.pipeline.map((entry) => entry.providerId)).toEqual(['immoscout', 'howoge']);
      expect(
        calls.pipeline.find((entry) => entry.providerId === 'immoscout').options.similarityIgnoredProviders,
      ).toEqual(['howoge']);
    });

    it('still sends the Scout listing without a direct link when the active official provider run fails', async () => {
      state.providers = [provider('immoscout'), provider('howoge')];
      state.jobsById.j1 = {
        id: 'j1',
        enabled: true,
        userId: 'u1',
        provider: [{ id: 'immoscout' }, { id: 'howoge' }],
      };
      state.pipelineResults = { immoscout: [scoutListing] };
      state.pipelineErrors.howoge = new Error('provider unavailable');

      await initService();
      bus.emit('jobs:runOne', { jobId: 'j1' });
      await vi.waitFor(() => expect(calls.markFinished).toEqual(['j1']));

      expect(calls.notifications).toEqual([{ providerId: 'immoscout', listings: [scoutListing] }]);
    });

    it('leaves every provider outside the strict set on the ordinary immediate-notification path', async () => {
      state.providers = [provider('immoscout'), provider('howoge'), provider('immowelt')];
      state.jobsById.j1 = {
        id: 'j1',
        enabled: true,
        userId: 'u1',
        provider: [{ id: 'immoscout' }, { id: 'howoge' }, { id: 'immowelt' }],
      };
      state.pipelineResults = {
        immoscout: [scoutListing],
        howoge: [],
        immowelt: [{ id: 'welt-1' }],
      };

      await initService();
      bus.emit('jobs:runOne', { jobId: 'j1' });
      await vi.waitFor(() => expect(calls.markFinished).toEqual(['j1']));

      expect(calls.pipeline.find((entry) => entry.providerId === 'immowelt').options).toMatchObject({
        deferNotification: false,
        forceMissingRoomDetails: false,
        similarityIgnoredProviders: [],
      });
    });
  });

  describe('demo mode', () => {
    const demoJob = (id) => ({ id, enabled: true, userId: 'u1', provider: [], blacklist: [], notificationAdapter: [] });

    it('runs only the demo job on a run-all', async () => {
      state.jobsList = [demoJob('demo-job'), demoJob('other-job')];
      state.jobsById = Object.fromEntries(state.jobsList.map((job) => [job.id, job]));

      await initService({ demoMode: true });
      bus.emit('jobs:runAll', { userId: null });
      await vi.waitFor(() => expect(calls.markFinished).toEqual(['demo-job']));

      expect(calls.lastRunUpdates.map((entry) => entry.id)).toEqual(['demo-job']);
    });

    it('refuses to run a job that is not the demo job', async () => {
      state.jobsList = [demoJob('other-job')];
      state.jobsById = Object.fromEntries(state.jobsList.map((job) => [job.id, job]));

      await initService({ demoMode: true });
      bus.emit('jobs:runOne', { jobId: 'other-job' });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(calls.markRunning).toEqual([]);
      expect(calls.lastRunUpdates).toEqual([]);
    });

    it('still runs the demo job when triggered manually', async () => {
      state.jobsList = [demoJob('demo-job')];
      state.jobsById = Object.fromEntries(state.jobsList.map((job) => [job.id, job]));

      await initService({ demoMode: true });
      bus.emit('jobs:runOne', { jobId: 'demo-job' });
      await vi.waitFor(() => expect(calls.markFinished).toEqual(['demo-job']));
    });
  });
});
