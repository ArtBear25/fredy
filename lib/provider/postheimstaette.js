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

const PROVIDER_ID = 'postheimstaette';
const BASE_URL = 'https://www.xn--postheimsttte-kfb.de/';
const DEFAULT_URL = `${BASE_URL}thema/freie_wohnungen/`;
const REQUEST_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

/**
 * Collapse whitespace in text extracted from Postheimstätte offer posts.
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
 * Resolve a possibly relative Postheimstätte URL.
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
 * Read the value behind a labelled list item.
 *
 * @param {string[]} lines
 * @param {string} label
 * @returns {string|null}
 */
function labelledValue(lines, label) {
  const prefix = `${label}:`;
  const line = lines.find((item) => item.toLocaleLowerCase('de-DE').startsWith(prefix.toLocaleLowerCase('de-DE')));
  return line ? cleanText(line.slice(prefix.length)) : null;
}

/**
 * Remove floor information from the location so Fredy's geocoder receives a
 * normal postal address instead of values such as "2. Erdgeschoss".
 *
 * @param {string|null} location
 * @returns {string|null}
 */
function postalAddress(location) {
  const value = cleanText(location);
  if (!value) return null;

  const postcode = value.match(/\b\d{5}\s+[^,]+(?:\s*,\s*[^,]+)*$/)?.[0];
  const street = value.split(',')[0]?.trim();
  if (street && postcode) return `${street}, ${postcode}`;

  return value;
}

/**
 * Parse Postheimstätte's public "Freie Wohnungen" archive.
 *
 * The site currently reuses a generic /wohnungsangebot/ permalink. The
 * provider therefore builds its source identity from the actual apartment
 * data instead of the URL alone, so a later offer on the same permalink is
 * still new to Fredy.
 *
 * @param {string} html
 * @returns {any[]}
 */
function parseListings(html) {
  const $ = cheerio.load(html);

  return $('article.category-freie_wohnungen')
    .map((_, element) => {
      const article = $(element);
      const content = article.find('.entry-content').first();
      const title = cleanText(content.find('h2').first().text());
      const link = toAbsoluteUrl(article.find('.entry-title a[href]').first().attr('href'));
      const lines = content
        .find('li')
        .map((__, item) => cleanText($(item).text()))
        .get()
        .filter(Boolean);

      const sizeLine = labelledValue(lines, 'Größe');
      const sizeMatch = sizeLine?.match(/([0-9]+(?:[.,][0-9]+)?)\s*Zimmer.*?([0-9]+(?:[.,][0-9]+)?)\s*(?:qm|m²)/i);
      const address = postalAddress(labelledValue(lines, 'Lage'));
      const price = extractNumber(labelledValue(lines, 'Nettogrundnutzungsgebühr'));
      const rooms = extractNumber(sizeMatch?.[1]);
      const size = extractNumber(sizeMatch?.[2]);
      const availableFrom = labelledValue(lines, 'Vermietung ab');
      const description = cleanText(content.find('details summary').first().text()) || null;
      const image = toAbsoluteUrl(content.find('img[src]').first().attr('src'));

      if (!title || !link || !address || !price || !size || !rooms) return null;

      return {
        id: [link, title, address, rooms, size, price, availableFrom].filter(Boolean).join('|'),
        link,
        title,
        price,
        size,
        rooms,
        address,
        image,
        description,
      };
    })
    .get();
}

/**
 * Fetch Postheimstätte's public apartment offers without starting a browser.
 *
 * @param {string} url
 * @returns {Promise<any[]>}
 */
async function getListings(url) {
  try {
    const response = await fetch(url || DEFAULT_URL, { headers: REQUEST_HEADERS });
    if (!response.ok) {
      logger.warn(`Postheimstätte offers returned HTTP ${response.status}.`);
      return [];
    }

    return parseListings(await response.text());
  } catch (error) {
    logger.warn('Could not fetch Postheimstätte offers.', error?.message || error);
    return [];
  }
}

/**
 * Convert a Postheimstätte offer to Fredy's common listing schema.
 *
 * @param {any} listing
 * @returns {ParsedListing}
 */
function normalize(listing) {
  const sourceId = cleanText(listing.id || listing.link);
  const address = cleanText(listing.address);

  return {
    id: sourceId ? buildHash(PROVIDER_ID, sourceId) : null,
    link: toAbsoluteUrl(listing.link),
    title: cleanText(listing.title),
    price: extractNumber(listing.price),
    size: extractNumber(listing.size),
    rooms: extractNumber(listing.rooms),
    address: address ? (/\bdeutschland\b/i.test(address) ? address : `${address}, Deutschland`) : null,
    image: toAbsoluteUrl(listing.image),
    description: listing.description || null,
  };
}

/**
 * Apply the job blacklist to the text exposed on Postheimstätte's offer post.
 *
 * @param {ParsedListing} listing
 * @param {string[]} blacklist
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
  getListings,
  normalize,
  activityProbe: checkIfListingIsActive,
};

export const metaInformation = {
  countries: ['de'],
  name: 'Postheimstätte',
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
