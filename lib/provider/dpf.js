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

const PROVIDER_ID = 'dpf';
const BASE_URL = 'https://www.dpfonline.de/';
const DEFAULT_URL = `${BASE_URL}interessenten/angebote/`;
const REQUEST_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

/**
 * Collapse whitespace in text extracted from DPF's offer cards.
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
 * Resolve a possibly relative DPF URL.
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
 * Read one of the repeated value/label pairs from an offer card.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio<any>} card
 * @param {string} label
 * @returns {string|null}
 */
function readLabeledValue($, card, label) {
  const normalizedLabel = label.toLowerCase();
  const value = card
    .find('.immo-data')
    .filter((_, element) => cleanText($(element).parent().text()).toLowerCase().includes(normalizedLabel))
    .first();

  return cleanText(value.text()) || null;
}

/**
 * Extract the image URL from DPF's inline background-image style.
 *
 * @param {string|null|undefined} style
 * @returns {string|null}
 */
function imageFromStyle(style) {
  const match = String(style || '').match(/background\s*:\s*url\((['"]?)(.*?)\1\)/i);
  return toAbsoluteUrl(match?.[2]);
}

/**
 * Parse public DPF offer cards. The same page also contains non-housing offers
 * such as parking spaces, which have zero rooms and zero living area and are
 * deliberately ignored.
 *
 * @param {string} html
 * @returns {any[]}
 */
function parseListings(html) {
  const $ = cheerio.load(html);

  return $('.immo-archive-cc')
    .map((_, element) => {
      const card = $(element);
      const anchor = card.find('h3 a[href]').first();
      const title = cleanText(anchor.text());
      const link = toAbsoluteUrl(anchor.attr('href'));
      const sourceId = cleanText(card.find('.immo-data-id').first().text());
      const size = extractNumber(readLabeledValue($, card, 'Wohnfläche'));
      const rooms = extractNumber(readLabeledValue($, card, 'Zimmer'));

      if (!title || !link || !sourceId || !size || !rooms) return null;

      const listItems = card
        .find('.trenner .uk-list > li')
        .map((__, item) => cleanText($(item).text()))
        .get()
        .filter(Boolean);
      const address = listItems[0] || null;
      const features = listItems.slice(1).join(', ');

      return {
        id: sourceId,
        link,
        title,
        price: readLabeledValue($, card, 'Kaltmiete'),
        size,
        rooms,
        address,
        image: imageFromStyle(card.find('.immo-a-thumb').first().attr('style')),
        description: features ? `Ausstattung: ${features}` : null,
      };
    })
    .get();
}

/**
 * Fetch DPF's public offers without starting a browser process.
 *
 * @param {string} url
 * @returns {Promise<any[]>}
 */
async function getListings(url) {
  try {
    const response = await fetch(url || DEFAULT_URL, { headers: REQUEST_HEADERS });
    if (!response.ok) {
      logger.warn(`DPF offers returned HTTP ${response.status}.`);
      return [];
    }

    return parseListings(await response.text());
  } catch (error) {
    logger.warn('Could not fetch DPF offers.', error?.message || error);
    return [];
  }
}

/**
 * Convert a DPF offer card to Fredy's common listing schema.
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
 * Apply the job blacklist to all text available on the public offer card.
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
  name: 'DPF',
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
