/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';
import { getJobs, getJob } from '../storage/jobStorage.js';
import {
  getListingById,
  getListingsByApplicationIdentity,
  updateApplicationByIdentity,
} from '../storage/listingsStorage.js';
import { getSettings } from '../storage/settingsStorage.js';
import { getHttpOutbox } from '../../notification/httpOutbox.js';
import { refreshApplicationMessages } from '../../notification/adapter/telegram.js';
import {
  buildApplicationEvent,
  fetchWorkflowProviders,
  resolveApplicationChannel,
} from './applicationAutomation.js';

const CALLBACK_PREFIX = 'fredy_apply:';

const chatIds = (channel) =>
  String(channel?.fields?.chatId ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

async function telegramCall(token, endpoint, body, fetchImpl) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(endpoint === 'getUpdates' ? 25_000 : 5_000),
  });
  if (!response.ok) throw new Error(`Telegram ${endpoint} returned HTTP ${response.status}`);
  return response.json();
}

async function answerCallback(token, callbackQueryId, text, fetchImpl) {
  try {
    await telegramCall(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text }, fetchImpl);
  } catch (error) {
    logger.warn(`Could not answer Telegram application callback: ${error.message}`);
  }
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
 * Handle one inline "Bewerben" click. Exported separately so the complete one-tap path can be
 * exercised without starting Telegram's long-poll loop.
 *
 * @param {Object} input
 * @param {string} input.token
 * @param {Object} input.callbackQuery
 * @param {Function} [input.fetchImpl]
 * @returns {Promise<{status:string, queued?:boolean}>}
 */
export async function handleApplicationCallback({ token, callbackQuery, fetchImpl = (...args) => fetch(...args) }) {
  const data = String(callbackQuery?.data ?? '');
  if (!data.startsWith(CALLBACK_PREFIX)) return { status: 'ignored' };
  const listingId = data.slice(CALLBACK_PREFIX.length);
  const listing = getListingById(listingId, null, true);
  const callbackId = callbackQuery?.id;
  if (!listing?.application?.provider || !listing.application.url) {
    await answerCallback(token, callbackId, 'Listing nicht mehr verfügbar', fetchImpl);
    return { status: 'missing' };
  }

  const job = getJob(listing.job_id);
  const callbackChatId = String(callbackQuery?.message?.chat?.id ?? '');
  const telegramChannel = job?.notificationAdapter?.find(
    (channel) =>
      channel.id === 'telegram' &&
      channel.fields?.token === token &&
      chatIds(channel).includes(callbackChatId),
  );
  if (!job || !telegramChannel) {
    await answerCallback(token, callbackId, 'Diese Nachricht darf die Bewerbung nicht starten', fetchImpl);
    return { status: 'forbidden' };
  }

  const identityRows = getListingsByApplicationIdentity(listing.application.provider, listing.application.url);
  if (identityRows.some((row) => row.application?.state === 'applied' || row.status?.status === 'applied')) {
    await answerCallback(token, callbackId, 'Bereits beworben', fetchImpl);
    return { status: 'applied' };
  }
  if (identityRows.some((row) => row.application?.state === 'running')) {
    await answerCallback(token, callbackId, 'Bewerbung läuft bereits', fetchImpl);
    return { status: 'running' };
  }
  if (listing.application.wbsCompatible === false) {
    await answerCallback(token, callbackId, 'WBS-Anforderung passt nicht zur hinterlegten WBS-Angabe', fetchImpl);
    return { status: 'wbs-blocked' };
  }

  const applicationChannel = await resolveApplicationChannel(job.notificationAdapter, fetchImpl);
  if (!applicationChannel) {
    await answerCallback(token, callbackId, 'Kein Bewerbungsmodul verbunden', fetchImpl);
    return { status: 'unavailable' };
  }
  let workflows;
  try {
    workflows = await fetchWorkflowProviders(applicationChannel, fetchImpl);
  } catch (error) {
    logger.warn(`Could not refresh workflow availability for Telegram apply: ${error.message}`);
    await answerCallback(token, callbackId, 'Bewerbungsmodul gerade nicht erreichbar', fetchImpl);
    return { status: 'unavailable' };
  }
  if (!workflows.has(listing.application.provider)) {
    updateApplicationByIdentity(listing.application.provider, listing.application.url, { workflowAvailable: false });
    await answerCallback(token, callbackId, 'Kein Workflow für diesen Anbieter', fetchImpl);
    return { status: 'no-workflow' };
  }

  const updatedRows = updateApplicationByIdentity(listing.application.provider, listing.application.url, {
    state: 'running',
    trigger: 'telegram',
    workflowAvailable: true,
  });
  await answerCallback(token, callbackId, 'Bewerbung gestartet', fetchImpl);
  void refreshRows(updatedRows);

  const settings = await getSettings();
  const callbackUrl = `http://127.0.0.1:${settings?.port || 9998}/api/application/status/${encodeURIComponent(
    job.id,
  )}/${encodeURIComponent(listing.id)}`;
  const eventListing = {
    ...listing,
    image: listing.image ?? listing.image_url,
    link: listing.application.url,
    officialProvider: undefined,
    providerLink: undefined,
  };
  const body = buildApplicationEvent({
    jobId: job.id,
    provider: listing.application.provider,
    listing: eventListing,
    trigger: 'telegram',
    callbackUrl,
    baseUrl: settings?.baseUrl ?? '',
  });
  const outbox = await getHttpOutbox();
  const outboxId = outbox.enqueue(applicationChannel.fields.endpointUrl, job.id, body);
  void outbox.deliver(outboxId).catch((error) => {
    logger.warn(`Application delivery remains queued for retry: ${error.message}`);
  });
  return { status: 'running', queued: true };
}

/**
 * Start one Telegram long poll per unique bot token. Inline callback data contains only Fredy's
 * listing id; ownership, chat and workflow availability are re-checked server-side before anything
 * is queued.
 *
 * @param {Function} [fetchImpl]
 * @returns {() => void} Stop function.
 */
export function startTelegramApplicationPoller(fetchImpl = (...args) => fetch(...args)) {
  const tokens = [
    ...new Set(
      getJobs({ includeDisabled: true })
        .flatMap((job) => job.notificationAdapter ?? [])
        .filter((channel) => channel.id === 'telegram' && channel.fields?.token)
        .map((channel) => channel.fields.token),
    ),
  ];
  const controller = new AbortController();

  for (const token of tokens) {
    void (async () => {
      let offset = 0;
      while (!controller.signal.aborted) {
        try {
          const result = await telegramCall(
            token,
            'getUpdates',
            { offset, timeout: 20, allowed_updates: ['callback_query'] },
            fetchImpl,
          );
          for (const update of Array.isArray(result?.result) ? result.result : []) {
            offset = Math.max(offset, Number(update.update_id) + 1);
            if (update.callback_query) {
              await handleApplicationCallback({ token, callbackQuery: update.callback_query, fetchImpl });
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            logger.warn(`Telegram application poll failed: ${error.message}`);
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
        }
      }
    })();
  }
  return () => controller.abort();
}
