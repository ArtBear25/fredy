/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf, sleep } from '../utils.js';
import { extractNumber } from '../utils/extract-number.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const PROVIDER_ID = 'degewo';
const BASE_URL = 'https://www.degewo.de/';
const DEFAULT_URL = `${BASE_URL}immosuche#immo-teaser-list`;
const MAX_PAGES = 20;
const SORT_ORDERS = ['immobilie_preise_warmmiete', 'immobilie_flaechen_wohnflaeche', 'immobilie_flaechen_anzahlZimmer'];
const REQUEST_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

/**
 * Collapse whitespace in text extracted from Degewo's formatted HTML.
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
 * Resolve a possibly relative Degewo URL.
 *
 * @param {string|null|undefined} value
 * @param {string} [baseUrl]
 * @returns {string|null}
 */
function toAbsoluteUrl(value, baseUrl = BASE_URL) {
  if (!value) return null;

  try {
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * Convert "Street | locality" into a geocodable address without assuming that
 * every offer is inside Berlin (Degewo also lists properties in the Umland).
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function normalizeAddress(value) {
  const address = cleanText(value).replace(/\s*\|\s*/g, ', ');
  if (!address) return null;
  return /\bdeutschland\b/i.test(address) ? address : `${address}, Deutschland`;
}

/**
 * Read a value from Degewo's dt/dd result-card pairs by its displayed label.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio<any>} card
 * @param {string} label
 * @returns {string|null}
 */
function readDefinition($, card, label) {
  const normalizedLabel = label.toLowerCase();
  const item = card
    .find('.c-definition-list__item')
    .filter((_, element) => cleanText($(element).find('dd').text()).toLowerCase() === normalizedLabel)
    .first();

  return cleanText(item.find('dt').text()) || null;
}

/**
 * Parse one results page and return its listings plus the next-page URL.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{listings:any[], nextUrl:string|null}}
 */
function parseSearchPage(html, pageUrl) {
  const $ = cheerio.load(html);
  const listings = $('.c-teaser.c-teaser--apartment')
    .map((_, element) => {
      const card = $(element);
      const link = toAbsoluteUrl(card.find('h3 a[href^="/immosuche/details/"]').attr('href'), pageUrl);
      const sourceId = cleanText(
        card.find('[data-openimmo-bookmark-item-uid]').attr('data-openimmo-bookmark-item-uid'),
      );
      const location = cleanText(card.find('.c-copy > p').first().text());
      const availableFrom = readDefinition($, card, 'frei ab');
      const tags = card
        .find('.c-tag__label')
        .map((__, tag) => cleanText($(tag).text()))
        .get()
        .filter(Boolean);

      const description = [
        location ? `Lage: ${location}` : null,
        availableFrom ? `Frei ab: ${availableFrom}` : null,
        tags.length ? `Ausstattung: ${tags.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      return {
        id: sourceId || link,
        link,
        title: cleanText(card.find('h3 a[href^="/immosuche/details/"]').text()),
        rooms: readDefinition($, card, 'zimmer'),
        size: readDefinition($, card, 'm²'),
        address: location,
        image: toAbsoluteUrl(card.find('img.c-img').attr('src'), pageUrl),
        description: description || null,
      };
    })
    .get()
    .filter((listing) => listing.id && listing.link && listing.title);

  const nextHref = $('.c-pagination__link--next[href]').attr('href');
  return {
    listings,
    nextUrl: toAbsoluteUrl(nextHref, pageUrl),
  };
}

/**
 * Keep Degewo's scan-local session cookies so its sort and pagination links
 * operate on the same search state.
 *
 * @param {any} response
 * @param {Map<string, string>} cookies
 */
function updateCookies(response, cookies) {
  const setCookieHeaders =
    typeof response.headers?.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers?.get?.('set-cookie')].filter(Boolean);

  for (const header of setCookieHeaders) {
    const cookie = header.split(';', 1)[0];
    const separator = cookie.indexOf('=');
    if (separator > 0) cookies.set(cookie.slice(0, separator), cookie.slice(separator + 1));
  }
}

/**
 * Fetch one search page and return its HTML while updating the cookie jar.
 *
 * @param {string} url
 * @param {Map<string, string>} cookies
 * @returns {Promise<{html:string, url:string}|null>}
 */
async function fetchSearchPage(url, cookies) {
  try {
    const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(url, {
      headers: {
        ...REQUEST_HEADERS,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });
    updateCookies(response, cookies);

    if (!response.ok) {
      logger.warn(`Degewo search returned HTTP ${response.status} for '${url}'.`);
      return null;
    }

    return {
      html: await response.text(),
      url: response.url || url,
    };
  } catch (error) {
    logger.warn(`Could not fetch Degewo search page '${url}'.`, error?.message || error);
    return null;
  }
}

/**
 * Find Degewo's current, checksum-protected URL for a requested sort order.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @param {string} sortOrder
 * @returns {string|null}
 */
function findSortUrl(html, pageUrl, sortOrder) {
  const $ = cheerio.load(html);
  const values = $('#select-sort-order option[value]')
    .map((_, element) => $(element).attr('value'))
    .get();

  return (
    values
      .map((value) => toAbsoluteUrl(value, pageUrl))
      .find((value) => {
        if (!value) return false;
        return new URL(value).searchParams.get('tx_openimmo_immobilie[sortBy]') === sortOrder;
      }) || null
  );
}

/**
 * Read the number Degewo displays above its result list.
 *
 * @param {string} html
 * @returns {number|null}
 */
function readExpectedResultCount(html) {
  const $ = cheerio.load(html);
  return extractNumber(cleanText($('.results-count').first().text()));
}

/**
 * Follow one sorted result set and merge every unique OpenImmo object.
 *
 * @param {{html:string, url:string}} firstPage
 * @param {Map<string, string>} cookies
 * @param {Map<string, any>} listingsById
 * @returns {Promise<void>}
 */
async function crawlResultPages(firstPage, cookies, listingsById) {
  let pageDocument = firstPage;
  const visitedPages = new Set();

  while (pageDocument && visitedPages.size < MAX_PAGES && !visitedPages.has(pageDocument.url)) {
    visitedPages.add(pageDocument.url);
    const page = parseSearchPage(pageDocument.html, pageDocument.url);

    for (const listing of page.listings) {
      if (!listingsById.has(listing.id)) listingsById.set(listing.id, listing);
    }

    if (!page.nextUrl) break;
    if (process.env.NODE_ENV !== 'test') await sleep(150);
    pageDocument = await fetchSearchPage(page.nextUrl, cookies);
  }
}

/**
 * Fetch every Degewo results page with a stable sort order. Sorting only by
 * room count causes overlapping pages because many offers have the same value.
 * Warm rent is used first; alternative sorts are merged only if the unique
 * count remains below Degewo's displayed total.
 *
 * @param {string} url
 * @returns {Promise<any[]>}
 */
async function getListings(url) {
  const firstUrl = toAbsoluteUrl(url || DEFAULT_URL);
  if (!firstUrl) return [];

  const parsedFirstUrl = new URL(firstUrl);
  parsedFirstUrl.hash = '';

  const cookies = new Map();
  const initialPage = await fetchSearchPage(parsedFirstUrl.href, cookies);
  if (!initialPage) return [];

  const expectedResultCount = readExpectedResultCount(initialPage.html);
  const listingsById = new Map();
  let crawledSortedResults = false;

  for (const sortOrder of SORT_ORDERS) {
    const sortUrl = findSortUrl(initialPage.html, initialPage.url, sortOrder);
    if (!sortUrl) continue;

    const sortedPage = await fetchSearchPage(sortUrl, cookies);
    if (!sortedPage) continue;

    crawledSortedResults = true;
    await crawlResultPages(sortedPage, cookies, listingsById);

    if (expectedResultCount == null || listingsById.size >= expectedResultCount) break;
  }

  if (!crawledSortedResults) await crawlResultPages(initialPage, cookies, listingsById);

  if (expectedResultCount != null && listingsById.size < expectedResultCount) {
    logger.warn(
      `Degewo reported ${expectedResultCount} results, but only ${listingsById.size} unique listings were found.`,
    );
  }

  return [...listingsById.values()];
}

/**
 * Read all copy sections with a matching heading from a detail page.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} headingText
 * @returns {string[]}
 */
function readDetailSections($, headingText) {
  const values = $('h2, h3')
    .filter((_, element) => cleanText($(element).text()).toLowerCase() === headingText.toLowerCase())
    .map((_, element) => {
      const section = $(element).parent().clone();
      section.find('h2, h3, button').remove();
      return cleanText(section.text());
    })
    .get()
    .filter(Boolean);

  return [...new Set(values)];
}

/**
 * Enrich a new result with the public detail description, exact postal address,
 * image and Degewo's own map coordinates.
 *
 * @param {ParsedListing} listing
 * @returns {Promise<ParsedListing>}
 */
async function fetchDetails(listing) {
  try {
    const response = await fetch(listing.link, { headers: REQUEST_HEADERS });
    if (!response.ok) {
      logger.warn(`Degewo detail page returned HTTP ${response.status} for listing '${listing.id}'.`);
      return listing;
    }

    const $ = cheerio.load(await response.text());
    const coldRentItem = $('.c-definition-list__item')
      .filter((_, element) => cleanText($(element).find('dt').text()).toLowerCase() === 'nettokaltmiete')
      .first();
    const price = extractNumber(cleanText(coldRentItem.find('dd').text()));
    if (price == null) {
      logger.warn(`Could not read Degewo Nettokaltmiete for listing '${listing.id}'.`);
    }
    const addressHeading = $('h2, h3')
      .filter((_, element) => /^Adresse\s*:/i.test(cleanText($(element).text())))
      .first();
    const exactAddress = cleanText(addressHeading.text()).replace(/^Adresse\s*:\s*/i, '');
    const map = $('.c-gmap__map[data-lat][data-long]').first();
    const latitude = Number.parseFloat(map.attr('data-lat'));
    const longitude = Number.parseFloat(map.attr('data-long'));
    const image = toAbsoluteUrl($('main img[src*="/tx_openimmo/"]').first().attr('src'), listing.link);

    const detailText = [
      ...readDetailSections($, 'Beschreibung'),
      ...readDetailSections($, 'Ausstattung'),
      ...readDetailSections($, 'Wichtige Hinweise'),
    ];
    const description = [...new Set([listing.description, ...detailText].filter(Boolean))].join('\n\n');

    return {
      ...listing,
      price,
      address: normalizeAddress(exactAddress) || listing.address,
      image: image || listing.image,
      description: description || listing.description,
      latitude: Number.isFinite(latitude) ? latitude : listing.latitude,
      longitude: Number.isFinite(longitude) ? longitude : listing.longitude,
    };
  } catch (error) {
    logger.warn(`Could not fetch Degewo detail page for listing '${listing.id}'.`, error?.message || error);
    return listing;
  }
}

/**
 * Convert a raw Degewo result to Fredy's common listing schema.
 *
 * @param {any} listing
 * @returns {ParsedListing}
 */
function normalize(listing) {
  const link = toAbsoluteUrl(listing.link);
  const sourceId = cleanText(listing.id || link);

  return {
    id: sourceId ? buildHash(PROVIDER_ID, sourceId) : null,
    link,
    title: cleanText(listing.title),
    price: null,
    size: extractNumber(listing.size),
    rooms: extractNumber(listing.rooms),
    address: normalizeAddress(listing.address),
    image: toAbsoluteUrl(listing.image),
    description: listing.description || null,
  };
}

/**
 * Apply the job blacklist to the text available on the results page.
 *
 * @param {ParsedListing} listing
 * @returns {boolean}
 */
function applyBlacklist(listing, blacklist = []) {
  const titleNotBlacklisted = !isOneOf(listing.title, blacklist);
  const descriptionNotBlacklisted = !isOneOf(listing.description, blacklist);
  return (
    listing.id != null &&
    listing.link != null &&
    listing.title != null &&
    titleNotBlacklisted &&
    descriptionNotBlacklisted
  );
}

/** @type {ProviderConfig} */
const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  url: null,
  crawlContainer: '.c-teaser.c-teaser--apartment',
  crawlFields: {
    id: '[data-openimmo-bookmark-item-uid]@data-openimmo-bookmark-item-uid',
    link: 'h3 a[href^="/immosuche/details/"]@href',
    title: 'h3 a[href^="/immosuche/details/"] | trim',
    address: '.c-copy > p | removeNewline | trim',
    image: 'img.c-img@src',
  },
  getListings,
  fetchDetails,
  fetchDetailsAlways: true,
  fetchDetailsForSpatialFilter: true,
  requireCoordinatesForSpatialFilter: true,
  normalize,
  activityProbe: checkIfListingIsActive,
};

export const metaInformation = {
  countries: ['de'],
  name: 'Degewo',
  baseUrl: BASE_URL,
  id: PROVIDER_ID,
};

export const createConfig = (sourceConfig, blacklist = []) => ({
  ...config,
  enabled: sourceConfig.enabled,
  url: sourceConfig.url || DEFAULT_URL,
  filter: (listing) => applyBlacklist(listing, blacklist ?? []),
});

export { config };
