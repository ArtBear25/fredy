/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf } from '../utils.js';
import { extractNumber } from '../utils/extract-number.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const PROVIDER_ID = 'howoge';
const BASE_URL = 'https://www.howoge.de/';
const DEFAULT_URL = `${BASE_URL}immobiliensuche/wohnungssuche.html`;
const API_URL = `${BASE_URL}?type=999&tx_howrealestate_json_list[action]=immoList`;
const REQUEST_HEADERS = {
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest',
};
const PAGE_REQUEST_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'User-Agent': REQUEST_HEADERS['User-Agent'],
};

/**
 * Collapse whitespace in values received from HOWOGE.
 *
 * @param {unknown} value
 * @returns {string}
 */
function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a possibly relative HOWOGE URL.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function toAbsoluteUrl(value) {
  if (!value) return null;

  try {
    return new URL(value, BASE_URL).href;
  } catch {
    return null;
  }
}

/**
 * Return a safe HOWOGE referer for the JSON request.
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
function toRefererUrl(value) {
  const url = toAbsoluteUrl(value || DEFAULT_URL);
  return url?.startsWith(BASE_URL) ? url : DEFAULT_URL;
}

/**
 * Convert the latitude/longitude strings from the HOWOGE API to numbers.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeCoordinate(value) {
  const coordinate = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(coordinate) && coordinate !== 0 ? coordinate : null;
}

/**
 * Build a full address while avoiding a repeated district or country name.
 *
 * @param {any} item
 * @returns {string|null}
 */
function buildAddress(item) {
  const streetAndCity = cleanText(item.title);
  const district = cleanText(item.district);
  const parts = [streetAndCity];

  if (district && !streetAndCity.toLowerCase().includes(district.toLowerCase())) {
    parts.push(district);
  }

  const address = parts.filter(Boolean).join(', ');
  if (!address) return null;
  return /\bdeutschland\b/i.test(address) ? address : `${address}, Deutschland`;
}

/**
 * Include all result-page text that should participate in Fredy's blacklist.
 *
 * @param {any} item
 * @param {string|null} address
 * @returns {string|null}
 */
function buildDescription(item, address) {
  const features = Array.isArray(item.features) ? item.features.map(cleanText).filter(Boolean) : [];
  const parts = [
    address ? `Adresse: ${address}` : null,
    item.projectTitle ? `Projekt: ${cleanText(item.projectTitle)}` : null,
    features.length ? `Merkmale: ${features.join(', ')}` : null,
  ].filter(Boolean);

  return parts.length ? parts.join('\n') : null;
}

/**
 * Read a value from the repeated headline/content pairs inside a project card.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio<any>} card
 * @param {string} labelPrefix
 * @returns {string|null}
 */
function readProjectAttribute($, card, labelPrefix) {
  const normalizedPrefix = labelPrefix.toLowerCase();
  const headline = card
    .find('.attributes-headline')
    .filter((_, element) => cleanText($(element).text()).toLowerCase().startsWith(normalizedPrefix))
    .first();

  return cleanText(headline.siblings('.attributes-content').first().text()) || null;
}

/**
 * Parse every concrete apartment card embedded in a HOWOGE project page.
 *
 * @param {string} html
 * @param {any} project
 * @returns {any[]}
 */
function parseProjectPage(html, project) {
  const $ = cheerio.load(html);

  return $('a.flat-single[href*="/immobiliensuche/wohnungssuche/detail/"]')
    .map((_, element) => {
      const card = $(element);
      const link = toAbsoluteUrl(card.attr('href'));
      if (!link) return null;

      return {
        uid: link,
        link,
        notice: cleanText(card.find('.notice').first().text()),
        title: cleanText(card.find('.address').first().text()),
        district: cleanText(card.find('.district').first().text()),
        rent: readProjectAttribute($, card, 'warmmiete'),
        area: readProjectAttribute($, card, 'wohnfl'),
        rooms: readProjectAttribute($, card, 'zimmer'),
        image: card.find('img[src]').first().attr('src') || null,
        features: card
          .find('.feature')
          .map((__, feature) => cleanText($(feature).text()))
          .get()
          .filter(Boolean),
        coordinates: project.coordinates,
        projectTitle: project.title,
      };
    })
    .get();
}

/**
 * Fetch the apartment cards grouped on one project page.
 *
 * @param {any} project
 * @param {string} [refererUrl]
 * @returns {Promise<any[]>}
 */
async function getProjectListings(project, refererUrl = DEFAULT_URL) {
  const projectUrl = toAbsoluteUrl(project.link);
  if (!projectUrl?.startsWith(BASE_URL)) return [];

  try {
    const response = await fetch(projectUrl, {
      headers: {
        ...PAGE_REQUEST_HEADERS,
        Referer: refererUrl,
      },
    });

    if (!response.ok) {
      logger.warn(`HOWOGE project page returned HTTP ${response.status} for '${projectUrl}'.`);
      return [];
    }

    return parseProjectPage(await response.text(), project);
  } catch (error) {
    logger.warn(`Could not fetch HOWOGE project page '${projectUrl}'.`, error?.message || error);
    return [];
  }
}

/**
 * HOWOGE's endpoint returns direct offers plus project teasers. Each project
 * page contains additional concrete apartment cards, so all project pages are
 * fetched and their detail links are merged with the direct API results.
 *
 * @param {string} url
 * @param {string} [refererUrl]
 * @returns {Promise<any[]>}
 */
async function getListings(url, refererUrl = DEFAULT_URL) {
  const body = new URLSearchParams({
    'tx_howrealestate_json_list[page]': '1',
    'tx_howrealestate_json_list[limit]': '100',
    'tx_howrealestate_json_list[lang]': '',
    'tx_howrealestate_json_list[rooms]': '',
    'tx_howrealestate_json_list[wbs]': '',
  });

  try {
    const response = await fetch(url || API_URL, {
      method: 'POST',
      headers: {
        ...REQUEST_HEADERS,
        Referer: refererUrl,
      },
      body,
    });

    if (!response.ok) {
      logger.warn(`HOWOGE search returned HTTP ${response.status}.`);
      return [];
    }

    const responseBody = await response.json();
    const listingsByLink = new Map();

    for (const item of Array.isArray(responseBody.immoobjects) ? responseBody.immoobjects : []) {
      const link = toAbsoluteUrl(item.link);
      if (!link || !new URL(link).pathname.startsWith('/immobiliensuche/wohnungssuche/detail/')) continue;
      if (!listingsByLink.has(link)) listingsByLink.set(link, item);
    }

    const projects = Array.isArray(responseBody.projectteaser) ? responseBody.projectteaser : [];
    const projectListings = (
      await Promise.all(projects.map((project) => getProjectListings(project, refererUrl)))
    ).flat();

    for (const item of projectListings) {
      const link = toAbsoluteUrl(item.link);
      if (link && !listingsByLink.has(link)) listingsByLink.set(link, item);
    }

    return [...listingsByLink.values()];
  } catch (error) {
    logger.warn('Could not fetch HOWOGE listings.', error?.message || error);
    return [];
  }
}

/**
 * Load the Kaltmiete from a HOWOGE detail page. The search API and project
 * cards only expose Warmmiete, which must not participate in Fredy's price
 * filter.
 *
 * @param {ParsedListing} listing
 * @param {string} [refererUrl]
 * @returns {Promise<ParsedListing>}
 */
async function fetchDetails(listing, refererUrl = DEFAULT_URL) {
  try {
    const response = await fetch(listing.link, {
      headers: {
        ...PAGE_REQUEST_HEADERS,
        Referer: refererUrl,
      },
    });

    if (!response.ok) {
      logger.warn(`HOWOGE detail page returned HTTP ${response.status} for listing '${listing.id}'.`);
      return listing;
    }

    const $ = cheerio.load(await response.text());
    const coldRentRow = $('tr')
      .filter((_, element) => {
        const label = cleanText($(element).find('th').text()).replace(/:\s*$/, '').toLowerCase();
        return label === 'kaltmiete';
      })
      .first();
    const price = extractNumber(cleanText(coldRentRow.find('td').text()));

    if (price == null) {
      logger.warn(`Could not read HOWOGE Kaltmiete for listing '${listing.id}'.`);
    }

    return {
      ...listing,
      price,
    };
  } catch (error) {
    logger.warn(`Could not fetch HOWOGE detail page for listing '${listing.id}'.`, error?.message || error);
    return listing;
  }
}

/**
 * Convert a HOWOGE API item to Fredy's common listing schema.
 *
 * @param {any} item
 * @returns {ParsedListing}
 */
function normalize(item) {
  const link = toAbsoluteUrl(item.link);
  const sourceId = cleanText(item.uid || link);
  const address = buildAddress(item);
  const wbsFeature = Array.isArray(item.features)
    ? item.features.map(cleanText).find((feature) => /\bwbs\b/i.test(feature))
    : null;

  return {
    id: sourceId ? buildHash(PROVIDER_ID, sourceId) : null,
    link,
    title: cleanText(item.notice) || cleanText(item.title),
    price: null,
    size: extractNumber(item.area),
    rooms: extractNumber(item.rooms),
    address,
    image: toAbsoluteUrl(item.image),
    description: buildDescription(item, address),
    wbsRequirement: wbsFeature || cleanText(item.wbs) || undefined,
    latitude: normalizeCoordinate(item.coordinates?.lat),
    longitude: normalizeCoordinate(item.coordinates?.lng),
  };
}

/**
 * Apply the job blacklist to all text already supplied by the search API.
 *
 * @param {ParsedListing} listing
 * @returns {boolean}
 */
function applyBlacklist(listing, blacklist = []) {
  return (
    !isOneOf(listing.title, blacklist) &&
    !isOneOf(listing.description, blacklist) &&
    !isOneOf(listing.address, blacklist)
  );
}

/** @type {ProviderConfig} */
const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  url: null,
  crawlFields: {
    id: 'uid',
    link: 'link',
    title: 'notice',
    price: 'rent',
    size: 'area',
    rooms: 'rooms',
    address: 'title',
    image: 'image',
    description: 'features',
  },
  getListings,
  fetchDetails,
  fetchDetailsAlways: true,
  normalize,
  activityProbe: checkIfListingIsActive,
};

export const metaInformation = {
  countries: ['de'],
  name: 'HOWOGE',
  baseUrl: BASE_URL,
  id: PROVIDER_ID,
};

export const createConfig = (sourceConfig, blacklist = []) => {
  const refererUrl = toRefererUrl(sourceConfig.url);
  return {
    ...config,
    enabled: sourceConfig.enabled,
    url: API_URL,
    refererUrl,
    getListings: (url) => getListings(url, refererUrl),
    fetchDetails: (listing) => fetchDetails(listing, refererUrl),
    filter: (listing) => applyBlacklist(listing, blacklist ?? []),
  };
};

export { config };
