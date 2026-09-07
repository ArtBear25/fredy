/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';
import { getJob } from '../../services/storage/jobStorage.js';
import {
  getListingById,
  setListingStatus,
  updateApplicationByIdentity,
} from '../../services/storage/listingsStorage.js';
import { getSettings } from '../../services/storage/settingsStorage.js';
import { findApplicationChannel } from '../../services/application/applicationAutomation.js';
import { refreshApplicationMessages } from '../../notification/adapter/telegram.js';
import logger from '../../services/logger.js';

function sameToken(supplied, expected) {
  const left = Buffer.from(String(supplied ?? ''));
  const right = Buffer.from(String(expected ?? ''));
  return left.length === right.length && right.length > 0 && crypto.timingSafeEqual(left, right);
}

async function refreshRows(rows) {
  const settings = await getSettings();
  await Promise.allSettled(
    rows.map((row) => {
      const job = getJob(row.job_id);
      return job ? refreshApplicationMessages({ listing: row, job, baseUrl: settings?.baseUrl ?? '' }) : undefined;
    }),
  );
}

/**
 * Authenticated server-to-server callbacks from the application module. This route is intentionally
 * outside Fredy's browser session middleware; the bearer token is the same one already configured
 * on the job's application HTTP channel.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function applicationPlugin(fastify) {
  fastify.post('/status/:jobId/:listingId', async (request, reply) => {
    const { jobId, listingId } = request.params ?? {};
    const listing = getListingById(listingId, null, true);
    const job = getJob(jobId);
    if (!listing || !job || listing.job_id !== job.id || !listing.application?.provider || !listing.application.url) {
      return reply.code(404).send({ error: 'Application listing not found' });
    }

    const channel = findApplicationChannel(job.notificationAdapter);
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    if (!channel || !sameToken(supplied, channel.fields?.authToken)) {
      return reply.code(401).send({ error: 'Invalid bearer token' });
    }

    const status = String(request.body?.status ?? '').toLowerCase();
    if (!['running', 'applied', 'failed'].includes(status)) {
      return reply.code(400).send({ error: 'Invalid application status' });
    }
    const patch = {
      state: status,
      detail: typeof request.body?.detail === 'string' ? request.body.detail.slice(0, 1000) : '',
      ...(request.body?.applicationId != null ? { applicationId: request.body.applicationId } : {}),
      ...(request.body?.trigger === 'auto' || request.body?.trigger === 'telegram'
        ? { trigger: request.body.trigger }
        : {}),
    };
    const rows = updateApplicationByIdentity(listing.application.provider, listing.application.url, patch);
    if (status === 'applied') {
      for (const row of rows) setListingStatus(row.id, 'applied');
    }

    // Persistence is the callback's contract. Telegram is refreshed after that and must not keep the
    // Selenium worker waiting on Telegram's per-chat rate limit.
    void refreshRows(rows).catch((error) => logger.warn(`Could not refresh application messages: ${error.message}`));
    return { ok: true, updated: rows.length };
  });
}
