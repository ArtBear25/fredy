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

const PROVIDER_ID = 'wgf';
const BASE_URL = 'https://wgf.berlin/';
const DEFAULT_URL = `${BASE_URL}services/wohnung-finden/`;
const REQUEST_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

/**
 * Collapse whitespace in text extracted from WGF offer cards.
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
 * Resolve a possibly relative WGF URL.
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
 * Read a labelled numeric value from the flattened text of one offer card.
 *
 * @param {string} text
 * @param {string} label
 * @param {string} [unit]
 * @returns {number|null}
 */
function readNumber(text, label, unit = '') {
  const match = text.match(new RegExp(`${label}\\s*([0-9.,]+)${unit ? `\\s*${unit}` : ''}`, 'i'));
  return extractNumber(match?.[1]);
}

/**
 * WGF currently labels a 1.5-room apartment as "Zimmer: 1" while the title
 * correctly says "1,5-Zimmerwohnung". Prefer the explicit title value when
 * available so Fredy's minimum-room filter does not drop such offers.
 *
 * @param {string} title
 * @param {number|null} listedRooms
 * @returns {number|null}
 */
function roomCount(title, listedRooms) {
  const titleRooms = extractNumber(title.match(/([0-9]+(?:[.,][0-9]+)?)\s*-?\s*Zimmer/i)?.[1]);
  return titleRooms ?? listedRooms;
}

/**
 * Extract a CSS background image URL from an offer card.
 *
 * @param {string|null|undefined} style
 * @returns {string|null}
 */
function imageFromStyle(style) {
  const match = String(style || '').match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
  return toAbsoluteUrl(match?.[2]);
}

/**
 * Read the two-line street/postcode address from a WGF offer card.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio<any>} card
 * @returns {string|null}
 */
function readAddress($, card) {
  const paragraph = card
    .find('.wohnungsangebot-text p')
    .filter((_, element) => $(element).find('strong').length === 0)
    .first();
  if (!paragraph.length) return null;

  paragraph.find('br').replaceWith('\n');
  const parts = paragraph
    .text()
    .split('\n')
    .map((part) => cleanText(part).replace(/\s+,\s+/g, ', '))
    .filter(Boolean);

  return parts.length ? parts.join(', ') : null;
}

/**
 * Parse the public apartment cards rendered on WGF's "Wohnung finden" page.
 *
 * @param {string} html
 * @returns {any[]}
 */
function parseListings(html) {
  const $ = cheerio.load(html);

  return $('.wohnungsangebot-teaser-item')
    .map((_, element) => {
      const card = $(element);
      const text = cleanText(card.find('.wohnungsangebot-text').text());
      const link = toAbsoluteUrl(card.find('a.details-button[href]').first().attr('href'));
      const title = cleanText(card.find('.wohnungsangebot-title').first().text());
      const address = readAddress($, card);

      if (!title || !link || !address) return null;

      return {
        id: link,
        link,
        title,
        price: readNumber(text, 'Kaltmiete:', '€'),
        size: readNumber(text, 'Größe:', 'm²'),
        rooms: roomCount(title, readNumber(text, 'Zimmer:')),
        address,
        image: imageFromStyle(card.find('.wohnungsangebot-image').first().attr('style')),
        description: null,
      };
    })
    .get();
}

/**
 * Fetch WGF's public apartment offers without starting a browser process.
 *
 * @param {string} url
 * @returns {Promise<any[]>}
 */
async function getListings(url) {
  try {
    const response = await fetch(url || DEFAULT_URL, { headers: REQUEST_HEADERS });
    if (!response.ok) {
      logger.warn(`WGF offers returned HTTP ${response.status}.`);
      return [];
    }

    return parseListings(await response.text());
  } catch (error) {
    logger.warn('Could not fetch WGF offers.', error?.message || error);
    return [];
  }
}

/**
 * Convert a WGF offer card to Fredy's common listing schema.
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
 * Apply the job blacklist to the text exposed on WGF's public offer card.
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
  name: 'WGF',
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
