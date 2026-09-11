/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const emit = vi.hoisted(() => vi.fn());
vi.mock('../../lib/services/events/event-bus.js', () => ({ bus: { emit } }));
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({ getSettings: async () => ({ demoMode: false }) }));
vi.mock('../../lib/services/storage/jobStorage.js', () => ({
  getJob: () => ({ id: 'j1', userId: 'u1', spatialFilter: { features: [{ geometry: { type: 'Polygon' } }] } }),
}));
vi.mock('../../lib/services/jobs/areaRecheckService.js', () => ({
  recheckRecentAreaListings: () => ({ checked: 10, requeued: 3, hidden: 1 }),
}));

it('the button endpoint starts a notification-only recheck run', async () => {
  const plugin = (await import('../../lib/api/routes/jobRouter.js')).default;
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.currentUser = { id: 'u1', isAdmin: false };
    request.session = { currentUser: 'u1' };
  });
  app.register(plugin, { prefix: '/api/jobs' });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/jobs/j1/recheck-area' });
    expect(response.statusCode).toBe(202);
    expect(emit).toHaveBeenCalledWith('jobs:runOne', { jobId: 'j1', skipAutoApply: true });
  } finally {
    await app.close();
  }
});
