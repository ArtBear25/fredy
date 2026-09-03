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

const BASE_URL = 'https://www.tu.berlin';
const DEFAULT_URL = `${BASE_URL}/international/starten-an-der-tu-berlin/wohnen/wohnungsboerse`;
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
};

/** @type {string[]} */
let appliedBlackList = [];
/** @type {string[]} */
let appliedBlacklistedDistricts = [];

/**
 * Collapse whitespace in text extracted from the TU Berlin pages.
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
function cleanText(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * Turn a relative TU Berlin link into an absolute URL.
 *
 * @param {string|null|undefined} link
 * @returns {string|null}
 */
function toAbsoluteLink(link) {
  if (!link) return null;

  try {
    return new URL(link, BASE_URL).toString();
  } catch {
    return null;
  }
}

/**
 * Extract the first number from free-form user input such as "€ 800" or
 * "ca. 1.048,36 Euro".
 *
 * @param {string|number|null|undefined} value
 * @returns {number|null}
 */
function extractFirstNumber(value) {
  if (typeof value === 'number') return value;

  const match = cleanText(value).match(/\d[\d.\s]*(?:,\d+)?/);
  return match ? extractNumber(match[0].replace(/\s+/g, '')) : null;
}

/**
 * Extract the number of rooms from the bilingual listing headline.
 *
 * @param {string|null|undefined} title
 * @returns {number|null}
 */
function extractRooms(title) {
  const match = cleanText(title).match(/(\d+(?:\s*[,.]\s*\d+)?)\s+(?:(?:WG[- ]?)?Zimmer(?:n)?|Room)\b/i);
  return match ? Number(match[1].replace(/\s+/g, '').replace(',', '.')) : null;
}

/**
 * Read the Berlin district from a listing headline.
 *
 * @param {string|null|undefined} title
 * @returns {string|null}
 */
function extractDistrict(title) {
  const match = cleanText(title).match(/\bin\s+(.+?)(?:\s+mit\s+\d+(?:[,.]\d+)?\s+Zimmern?)?$/i);
  const district = cleanText(match?.[1]);
  return district || null;
}

/**
 * Read the value from one of the bilingual teaser lines on the results page.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio<any>} container
 * @param {RegExp} labelPattern
 * @returns {string|null}
 */
function readTeaserValue($, container, labelPattern) {
  const line = container
    .find('.news_list-item__teaser p')
    .map((_, element) => cleanText($(element).text()))
    .get()
    .find((text) => labelPattern.test(text));

  if (!line) return null;
  const separator = line.indexOf(':');
  const value = cleanText(separator >= 0 ? line.slice(separator + 1) : line);
  return value || null;
}

/**
 * Create the short description available on the results page.
 *
 * @param {string|null} publishedAt
 * @param {string|null} availableFrom
 * @param {string|null} availableUntil
 * @param {string|null} district
 * @returns {string|null}
 */
function buildTeaserDescription(publishedAt, availableFrom, availableUntil, district) {
  const parts = [
    district ? `Bezirk: ${district}` : null,
    publishedAt ? `Veröffentlicht: ${publishedAt}` : null,
    availableFrom ? `Frei ab: ${availableFrom}` : null,
    availableUntil ? `Frei bis: ${availableUntil}` : null,
  ].filter(Boolean);

  return parts.length ? parts.join('\n') : null;
}

/**
 * Detect an unambiguously expired numeric "Frei bis" date. Free-form values
 * such as "unbefristet" or "nach Absprache" remain eligible.
 *
 * @param {string|null|undefined} description
 * @returns {boolean}
 */
function isClearlyExpired(description) {
  const availableUntil = String(description || '')
    .split(/\r?\n/)
    .find((line) => /^Frei bis:/i.test(line));
  const match = availableUntil?.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/);
  if (!match) return false;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);
  const isValidDate =
    endOfDay.getFullYear() === year && endOfDay.getMonth() === month - 1 && endOfDay.getDate() === day;

  return isValidDate && endOfDay.getTime() < Date.now();
}

/**
 * Parse all housing offers from the TU Berlin results page.
 *
 * @param {string} html
 * @returns {any[]}
 */
function parseListings(html) {
  const $ = cheerio.load(html);

  return $('li.news_list-item')
    .map((_, element) => {
      const container = $(element);
      const link = container.find('h3.news_list-item__headline a').attr('href');
      const title = cleanText(container.find('h3.news_list-item__headline a').text());
      if (!link || !title) return null;

      const availableFrom = readTeaserValue($, container, /Free from|Available from|Frei ab/i);
      const availableUntil = readTeaserValue($, container, /Free until|Available to|Frei bis/i);
      const publishedAt = cleanText(container.find('.news_list-item__date time').attr('datetime')) || null;
      const district = extractDistrict(title);

      return {
        id: link,
        link,
        title,
        price: readTeaserValue($, container, /Rental price|Mietpreis|Rent \(incl\./i),
        rooms: extractRooms(title),
        size: null,
        address: district,
        image: null,
        description: buildTeaserDescription(publishedAt, availableFrom, availableUntil, district),
      };
    })
    .get();
}

/**
 * Fetch the TU Berlin results page without starting a browser process.
 *
 * @param {string} url
 * @returns {Promise<any[]>}
 */
async function getListings(url) {
  try {
    const response = await fetch(url, { headers: REQUEST_HEADERS });
    if (!response.ok) {
      logger.error(`TU Berlin housing board returned HTTP ${response.status}.`);
      return [];
    }

    return parseListings(await response.text());
  } catch (error) {
    logger.error('Could not fetch the TU Berlin housing board.', error?.message || error);
    return [];
  }
}

/**
 * Read the value paragraphs paired with bold bilingual labels on a detail page.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {Map<string, string>}
 */
function readDetailFields($) {
  const fields = new Map();

  $('p:has(> strong)').each((_, element) => {
    const label = cleanText($(element).children('strong').first().text()).toLowerCase();
    const value = cleanText($(element).next('p').text());
    if (label && value) fields.set(label, value);
  });

  return fields;
}

/**
 * Find a detail value via the stable English part of its bilingual label.
 *
 * @param {Map<string, string>} fields
 * @param {string} labelPart
 * @returns {string|null}
 */
function findDetailField(fields, labelPart) {
  const normalizedPart = labelPart.toLowerCase();
  for (const [label, value] of fields.entries()) {
    if (label.includes(normalizedPart)) return value;
  }
  return null;
}

/**
 * Build a geocodable Berlin address without repeating the city name.
 *
 * @param {string|null} street
 * @param {string|null} district
 * @returns {string|null}
 */
function buildAddress(street, district) {
  const address = [street, district].map(cleanText).filter(Boolean).join(', ');
  if (!address) return null;
  return /\bberlin\b/i.test(address) ? address : `${address}, Berlin`;
}

/**
 * Fetch a public detail page and enrich the listing with its address, size,
 * furnishing, availability, description and public contact information.
 * The original result is returned when the detail page cannot be loaded.
 *
 * @param {ParsedListing} listing
 * @returns {Promise<ParsedListing>}
 */
async function fetchDetails(listing) {
  const absoluteLink = toAbsoluteLink(listing.link);
  if (!absoluteLink) return listing;

  try {
    const response = await fetch(absoluteLink, { headers: REQUEST_HEADERS });
    if (!response.ok) return { ...listing, link: absoluteLink };

    const $ = cheerio.load(await response.text());
    const fields = readDetailFields($);
    const district = findDetailField(fields, 'district');
    const street = findDetailField(fields, 'address');
    const availableFrom = findDetailField(fields, 'free from');
    const availableUntil = findDetailField(fields, 'free until');
    const furnishing = findDetailField(fields, 'furnishing');
    const other = findDetailField(fields, 'other');
    const contactName = fields.get('name') || null;
    const contact = findDetailField(fields, 'e-mail address');
    const publishedLine = listing.description?.split('\n').find((line) => line.startsWith('Veröffentlicht:'));

    const description = [
      publishedLine,
      availableFrom ? `Frei ab: ${availableFrom}` : null,
      availableUntil ? `Frei bis: ${availableUntil}` : null,
      furnishing ? `Ausstattung: ${furnishing}` : null,
      other,
      contactName ? `Kontakt: ${contactName}` : null,
      contact,
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      ...listing,
      link: absoluteLink,
      address: buildAddress(street, district) || listing.address,
      rooms: extractFirstNumber(findDetailField(fields, 'number of rooms')) ?? listing.rooms,
      size: extractFirstNumber(findDetailField(fields, 'size in sqm')) ?? listing.size,
      price: extractFirstNumber(findDetailField(fields, 'rental price')) ?? listing.price,
      description: description || listing.description,
    };
  } catch (error) {
    logger.warn(`Could not fetch TU Berlin detail page for listing '${listing.id}'.`, error?.message || error);
    return { ...listing, link: absoluteLink };
  }
}

/**
 * Normalize a raw TU Berlin offer to Fredy's listing schema.
 *
 * @param {any} listing
 * @returns {ParsedListing}
 */
function normalize(listing) {
  const link = toAbsoluteLink(listing.link);
  const title = cleanText(listing.title);
  const price = extractFirstNumber(listing.price);

  return {
    id: buildHash(link, price == null ? null : String(price)),
    link: link || config.url,
    title,
    price,
    size: extractFirstNumber(listing.size),
    rooms: extractFirstNumber(listing.rooms) ?? extractRooms(title),
    // A district-only value would make Fredy geocode the same approximate
    // borough center for every listing. Keep it in title/description instead;
    // fetchDetails supplies a precise, geocodable street address when enabled.
    address: null,
    image: null,
    description: listing.description || null,
  };
}

/**
 * Apply the job's text and district blacklists.
 *
 * @param {ParsedListing} listing
 * @returns {boolean}
 */
function applyBlacklist(listing) {
  const titleNotBlacklisted = !isOneOf(listing.title, appliedBlackList);
  const descriptionNotBlacklisted = !isOneOf(listing.description, appliedBlackList);
  const districtBlacklisted = isOneOf(listing.description, appliedBlacklistedDistricts);
  return (
    listing.title != null &&
    titleNotBlacklisted &&
    descriptionNotBlacklisted &&
    !districtBlacklisted &&
    !isClearlyExpired(listing.description)
  );
}

/** @type {ProviderConfig} */
const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  url: DEFAULT_URL,
  crawlFields: {
    id: 'h3.news_list-item__headline a@href',
    link: 'h3.news_list-item__headline a@href',
    title: 'h3.news_list-item__headline a',
    price: '.news_list-item__teaser p',
    address: 'h3.news_list-item__headline a',
  },
  getListings,
  fetchDetails,
  normalize,
  filter: applyBlacklist,
  activeTester: checkIfListingIsActive,
};

export const metaInformation = {
  name: 'TU Berlin Wohnungsbörse',
  baseUrl: `${BASE_URL}/`,
  id: 'tuBerlin',
};

/**
 * Initialize the provider for a Fredy job.
 *
 * @param {{enabled?: boolean, url?: string}} sourceConfig
 * @param {string[]} blacklist
 * @param {string[]} blacklistedDistricts
 * @returns {void}
 */
export const init = (sourceConfig, blacklist, blacklistedDistricts) => {
  config.enabled = sourceConfig.enabled;
  config.url = sourceConfig.url || DEFAULT_URL;
  appliedBlackList = blacklist || [];
  appliedBlacklistedDistricts = blacklistedDistricts || [];
};

export { config };
