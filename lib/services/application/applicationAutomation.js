/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { officialProviderFromDirectLink } from '../similarity-check/listingFingerprint.js';

/**
 * @typedef {Object} AutoApplyRule
 * @property {boolean} enabled
 * @property {string[]} jobIds
 * @property {number|null} maxPrice
 * @property {number|null} minSize
 * @property {number|null} minRooms
 * @property {Array<{label:string, mode:'transit'|'car'|'bike'|'walk', maxMinutes:number}>} travelTimes
 */

const APPLICATION_EVENTS_PATH = '/api/v1/fredy/events';
const WORKFLOWS_PATH = '/api/v1/fredy/workflows';
const TRAVEL_MODES = new Set(['transit', 'car', 'bike', 'walk']);

const finiteOrNull = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

/**
 * Turn persisted/user supplied settings into the one fixed auto-application rule Fredy supports.
 * Unknown fields are ignored rather than becoming a second, generic rule language.
 *
 * @param {any} raw
 * @returns {AutoApplyRule}
 */
export function normalizeAutoApplyRule(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const jobIds = Array.isArray(source.jobIds)
    ? [...new Set(source.jobIds.map((id) => String(id).trim()).filter(Boolean))]
    : [];
  const travelTimes = Array.isArray(source.travelTimes)
    ? source.travelTimes
        .map((criterion) => {
          const label = String(criterion?.label ?? '').trim();
          const mode = String(criterion?.mode ?? '').toLowerCase();
          const maxMinutes = finiteOrNull(criterion?.maxMinutes);
          return label && TRAVEL_MODES.has(mode) && maxMinutes != null && maxMinutes > 0
            ? { label, mode, maxMinutes }
            : null;
        })
        .filter(Boolean)
    : [];

  return {
    enabled: source.enabled === true,
    jobIds,
    maxPrice: finiteOrNull(source.maxPrice),
    minSize: finiteOrNull(source.minSize),
    minRooms: finiteOrNull(source.minRooms),
    travelTimes,
  };
}

/**
 * Test one fully prepared listing against the configured auto rule. Every configured criterion is
 * mandatory. Missing listing data never guesses its way into an automatic application.
 *
 * @param {AutoApplyRule|any} rawRule
 * @param {{jobId:string, listing:Object}} input
 * @returns {boolean}
 */
export function matchesAutoApplyRule(rawRule, { jobId, listing }) {
  const rule = normalizeAutoApplyRule(rawRule);
  const hasCriteria =
    rule.jobIds.length > 0 ||
    rule.maxPrice != null ||
    rule.minSize != null ||
    rule.minRooms != null ||
    rule.travelTimes.length > 0;
  if (!rule.enabled || !hasCriteria) return false;
  if (rule.jobIds.length > 0 && !rule.jobIds.includes(jobId)) return false;
  if (rule.maxPrice != null && (!Number.isFinite(Number(listing?.price)) || Number(listing.price) > rule.maxPrice)) {
    return false;
  }
  if (rule.minSize != null && (!Number.isFinite(Number(listing?.size)) || Number(listing.size) < rule.minSize)) {
    return false;
  }
  if (rule.minRooms != null && (!Number.isFinite(Number(listing?.rooms)) || Number(listing.rooms) < rule.minRooms)) {
    return false;
  }

  for (const criterion of rule.travelTimes) {
    const destination = Array.isArray(listing?.travelTimes)
      ? listing.travelTimes.find((entry) => entry?.label === criterion.label)
      : null;
    const minutes = Number(destination?.[criterion.mode]?.minutes);
    if (!Number.isFinite(minutes) || minutes > criterion.maxMinutes) return false;
  }
  return true;
}

/**
 * Canonical provider key the application module uses. A strict Scout/direct match belongs to the
 * official provider. Direct aggregator links are resolved from their provider host; everything
 * else belongs to the provider that produced the notification.
 *
 * @param {string} serviceName
 * @param {Object} listing
 * @returns {string}
 */
export function applicationProvider(serviceName, listing) {
  const raw =
    listing?.officialProvider && listing?.providerLink
      ? listing.officialProvider
      : officialProviderFromDirectLink(listing?.link) ?? serviceName;
  return String(raw ?? '').trim().toLowerCase();
}

/**
 * The exact current exposé that Selenium must start from.
 *
 * @param {Object} listing
 * @returns {string}
 */
export function applicationUrl(listing) {
  return listing?.officialProvider && listing?.providerLink ? listing.providerLink : listing?.link;
}

/**
 * Whether a generic HTTP channel points at the bundled application module.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isApplicationEndpoint(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return ['http:', 'https:'].includes(url.protocol) && url.pathname.replace(/\/+$/, '') === APPLICATION_EVENTS_PATH;
  } catch {
    return false;
  }
}

/**
 * Find the application-module HTTP channel already attached to a job.
 *
 * @param {Array<Object>} notificationConfig
 * @returns {Object|null}
 */
export function findApplicationChannel(notificationConfig) {
  return (
    (Array.isArray(notificationConfig) ? notificationConfig : []).find(
      (channel) => channel?.id === 'http' && isApplicationEndpoint(channel?.fields?.endpointUrl),
    ) ?? null
  );
}

/**
 * Ask the application module which provider workflows are currently active. A newly recorded
 * workflow therefore becomes usable on the next listing without a second provider list in Fredy.
 *
 * @param {Object} channel Hydrated Fredy HTTP channel.
 * @param {Function} [fetchImpl]
 * @returns {Promise<Set<string>>}
 */
export async function fetchWorkflowProviders(channel, fetchImpl = (...args) => fetch(...args)) {
  if (!channel?.fields?.endpointUrl) return new Set();
  const url = new URL(channel.fields.endpointUrl);
  url.pathname = WORKFLOWS_PATH;
  url.search = '';
  url.hash = '';
  const response = await fetchImpl(url.href, {
    headers: channel.fields.authToken ? { Authorization: `Bearer ${channel.fields.authToken}` } : {},
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Workflow lookup returned HTTP ${response.status}`);
  const body = await response.json();
  return new Set(
    (Array.isArray(body?.providers) ? body.providers : []).map((provider) => String(provider).trim().toLowerCase()).filter(Boolean),
  );
}

/**
 * Build the one event shape used by both auto-apply and the Telegram button.
 *
 * @param {Object} params
 * @param {string} params.jobId
 * @param {string} params.provider
 * @param {Object} params.listing
 * @param {'auto'|'telegram'} params.trigger
 * @param {string} params.callbackUrl
 * @param {string} [params.baseUrl]
 * @returns {Object}
 */
export function buildApplicationEvent({ jobId, provider, listing, trigger, callbackUrl, baseUrl = '' }) {
  return {
    event: 'listings',
    jobId,
    provider,
    timestamp: new Date().toISOString(),
    listings: [
      {
        id: listing.id,
        url: listing.link,
        title: listing.title ?? '',
        description: listing.description ?? '',
        address: listing.address ?? null,
        imageUrl: listing.image ?? null,
        fredyUrl: baseUrl && listing.id ? `${baseUrl}/#/listings/listing/${listing.id}` : null,
        ...(listing.officialProvider ? { officialProvider: listing.officialProvider } : {}),
        ...(listing.providerLink ? { providerLink: listing.providerLink } : {}),
        applyRequested: true,
        applicationTrigger: trigger,
        callbackUrl,
        price: listing.price ?? null,
        size: listing.size ?? null,
        rooms: listing.rooms ?? null,
      },
    ],
  };
}
