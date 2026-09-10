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
const APPLICATION_DISCOVERY_PATH = '/api/v1/fredy/discovery';
const WORKFLOWS_PATH = '/api/v1/fredy/workflows';
const TRAVEL_MODES = new Set(['transit', 'car', 'bike', 'walk']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const WBS_LEVEL_SEQUENCE = /\bwbs\s*((?:100|140|160|180|220)(?:\s*(?:[-–—/,]|bis|oder|und)\s*(?:wbs\s*)?(?:100|140|160|180|220))*)/gi;
const WBS_LEVEL = /\b(100|140|160|180|220)\b/g;
const WBS_NOT_REQUIRED = [
  /\bwbs\s*(?::|=|-)?\s*(?:ist\s+)?(?:nicht\s+erforderlich|nicht\s+nötig|nicht\s+notwendig|nein)\b/i,
  /\bwbs(?:\s+(?:nötig|erforderlich|notwendig|vorhanden))?\s*(?::|=|-)\s*nein\b/i,
  /\b(?:kein(?:e[nrms]?|en)?|ohne)\s+(?:gültigen?\s+)?wbs\b/i,
];
const WBS_REQUIRED = [
  /\bwbs(?:\s+(?:nötig|erforderlich|notwendig|vorhanden))?\s*(?::|=|-)\s*ja\b/i,
  /\bwbs\s*(?::|=|-)?\s*(?:ist\s+)?(?:erforderlich|nötig|notwendig)\b(?!\s*(?::|=|-)\s*nein\b)/i,
  /\b(?:mit|nur\s+mit)\s+(?:gültigem?\s+)?wbs\b/i,
];
const WBS_INCOME_LIMIT = /\beinkommensgrenz\w*\b/i;
const WBS_STRUCTURED_UNCLEAR = /^(?:unklar|unbekannt|nicht\s+eindeutig)$/i;

const localApplicationOrigin = () => `http://127.0.0.1:${process.env.BEWERBUNGSMODUL_PORT || '8765'}`;

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
 * Reduce provider-specific WBS wording to the few states auto-apply needs. Structured provider data
 * participates first, while title/description cover portals that expose the requirement only as
 * prose. Income-limit wording and contradictory evidence deliberately stay `unclear` instead of
 * guessing a legal equivalence between percentages and WBS types.
 *
 * @param {Object} listing
 * @returns {{status:'none'|'generic'|'specific'|'unclear', levels:number[]}}
 */
export function classifyWbsRequirement(listing) {
  const structured = String(listing?.wbsRequirement ?? '').trim();
  const text = [structured ? `WBS: ${structured}` : '', listing?.title, listing?.description, listing?.wbsSourceText]
    .filter(Boolean)
    .join('\n');
  const levels = new Set();

  for (const sequence of text.matchAll(WBS_LEVEL_SEQUENCE)) {
    for (const level of sequence[1].matchAll(WBS_LEVEL)) levels.add(Number(level[1]));
  }

  const specificLevels = [...levels].sort((a, b) => a - b);
  const explicitlyNotRequired = WBS_NOT_REQUIRED.some((pattern) => pattern.test(text));
  const explicitlyRequired = WBS_REQUIRED.some((pattern) => pattern.test(text));
  const hasIncomeLimit = WBS_INCOME_LIMIT.test(text);
  const structuredUnclear = WBS_STRUCTURED_UNCLEAR.test(structured);
  const mentionsWbs = /\bwbs\b/i.test(text) || /\bwohnberechtigungsschein\b/i.test(text);

  if (structuredUnclear) return { status: 'unclear', levels: specificLevels };
  if (explicitlyNotRequired && (specificLevels.length > 0 || hasIncomeLimit)) {
    return { status: 'unclear', levels: specificLevels };
  }
  if (hasIncomeLimit) return { status: 'unclear', levels: specificLevels };
  if (specificLevels.length > 0) return { status: 'specific', levels: specificLevels };
  if (explicitlyNotRequired) return { status: 'none', levels: [] };
  if (explicitlyRequired || mentionsWbs) return { status: 'generic', levels: [] };
  return { status: 'none', levels: [] };
}

/**
 * Decide whether the applicant information exposed by the local application module is sufficient
 * for this listing's WBS requirement. A generic WBS requirement accepts any recorded WBS; an
 * explicit WBS type requires an exact listed type. Unknown income-limit semantics never auto-apply.
 *
 * @param {Object} listing
 * @param {{hasWbs?:boolean, type?:string}|null|undefined} applicantWbs
 * @returns {{status:'none'|'generic'|'specific'|'unclear', levels:number[], compatible:boolean}}
 */
export function evaluateWbsCompatibility(listing, applicantWbs) {
  const requirement = classifyWbsRequirement(listing);
  const hasWbs = applicantWbs?.hasWbs === true;
  const levelMatch = String(applicantWbs?.type ?? '').match(/\b(100|140|160|180|220)\b/);
  const applicantLevel = levelMatch ? Number(levelMatch[1]) : null;

  let compatible = false;
  if (requirement.status === 'none') compatible = true;
  else if (requirement.status === 'generic') compatible = hasWbs;
  else if (requirement.status === 'specific') {
    compatible = hasWbs && applicantLevel != null && requirement.levels.includes(applicantLevel);
  }

  return { ...requirement, compatible };
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
 * Discover the bundled local application module without requiring a user-managed HTTP channel.
 * The discovery endpoint itself is loopback-only and hands Fredy the same bearer token the manual
 * setup uses, so all existing workflow, event and callback authentication stays unchanged.
 *
 * @param {Function} [fetchImpl]
 * @returns {Promise<Object|null>}
 */
export async function discoverLocalApplicationChannel(fetchImpl = (...args) => fetch(...args)) {
  try {
    const response = await fetchImpl(`${localApplicationOrigin()}${APPLICATION_DISCOVERY_PATH}`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (body?.service !== 'fredy-application-module') return null;

    const endpointUrl = String(body?.endpointUrl ?? '');
    const authToken = String(body?.authToken ?? '');
    const endpoint = new URL(endpointUrl);
    if (!LOOPBACK_HOSTS.has(endpoint.hostname) || !isApplicationEndpoint(endpointUrl) || !authToken) return null;

    return {
      id: 'http',
      autoDiscovered: true,
      applicantWbs: {
        hasWbs: body?.applicantWbs?.hasWbs === true,
        type: String(body?.applicantWbs?.type ?? '').trim(),
      },
      fields: { endpointUrl, authToken },
    };
  } catch {
    return null;
  }
}

/**
 * Prefer an explicitly configured application channel, otherwise use the bundled local module when
 * it is running. Manual HTTP setup therefore remains a compatible override rather than a requirement.
 *
 * @param {Array<Object>} notificationConfig
 * @param {Function} [fetchImpl]
 * @returns {Promise<Object|null>}
 */
export async function resolveApplicationChannel(notificationConfig, fetchImpl = (...args) => fetch(...args)) {
  const configured = findApplicationChannel(notificationConfig);
  if (!configured) return discoverLocalApplicationChannel(fetchImpl);
  if (configured.applicantWbs) return configured;

  try {
    const configuredUrl = new URL(configured.fields?.endpointUrl);
    const localUrl = new URL(localApplicationOrigin());
    if (LOOPBACK_HOSTS.has(configuredUrl.hostname) && configuredUrl.port === localUrl.port) {
      const discovered = await discoverLocalApplicationChannel(fetchImpl);
      if (discovered?.applicantWbs) return { ...configured, applicantWbs: discovered.applicantWbs };
    }
  } catch {
    // The configured channel remains authoritative even when optional local profile discovery fails.
  }
  return configured;
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
