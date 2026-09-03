/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf } from '../utils.js';
import { extractNumber } from '../utils/extract-number.js';
import checkIfListingIsActive from '../services/listings/listingActiveTester.js';
import logger from '../services/logger.js';
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const PROVIDER_ID = 'wbm';
const BASE_URL = 'https://www.wbm.de/';
const DEFAULT_URL = `${BASE_URL}wohnungen-berlin/angebote/`;
const HEADERS = { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'de-DE,de;q=0.9' };

const text = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
const absolute = (value, base = BASE_URL) => {
  if (!value) return null;
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
};
const labelled = ($, root, labels) => {
  const number = /\d+(?:[.\s]\d{3})*(?:[.,]\d+)?\s*(?:EUR|€|m²)?/i;
  for (const label of labels) {
    const wanted = label.toLowerCase();
    const node = root
      .find('*')
      .filter((_, el) => {
        if ($(el).children().length > 0) return false;
        const value = text($(el).text()).toLowerCase();
        const labelOnly = value.replace(/:\s*$/, '') === wanted;
        const inlineValue = (value.startsWith(wanted) || value.endsWith(wanted)) && number.test(value);
        return labelOnly || inlineValue;
      })
      .first();
    if (node.length === 0) continue;

    for (const value of [text(node.text()), text(node.next().text()), text(node.parent().text())]) {
      const match = value.replace(new RegExp(label, 'i'), '').match(number);
      if (match) return match[0];
    }
  }
  return null;
};
const extractSize = (value) => {
  if (typeof value !== 'string') return extractNumber(value);
  return extractNumber(value.replace(/(\d+)\.(\d{1,2})(?=\s*m²)/i, '$1,$2'));
};

function cards($) {
  const selectors = ['article', '[class*="teaser"]', '[class*="offer"]', '[class*="listing"]'];
  const result = [];
  const seen = new Set();
  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const card = $(element);
      const link = card.find('a[href*="expose"], a[href*="expos"], a[href*="wohnung"], a[href]').first();
      const title = text(card.find('h2, h3, h4').first().text() || link.text());
      if (!title || !link.attr('href')) return;
      const url = absolute(link.attr('href'), DEFAULT_URL);
      if (!url || seen.has(url)) return;
      seen.add(url);
      const values = text(card.text());
      result.push({
        id: card.attr('data-id') || card.attr('data-uid') || url,
        link: url,
        title,
        address: text(card.find('address, [class*="address"]').first().text()) || null,
        price:
          labelled($, card, ['Nettokaltmiete', 'Kaltmiete', 'Warmmiete', 'Gesamtmiete']) ||
          values.match(/[\d.]+,\d{2}\s*€/)?.[0],
        size: labelled($, card, ['Wohnfläche', 'Größe', 'm²']) || values.match(/[\d,.]+\s*m²/i)?.[0],
        rooms: labelled($, card, ['Zimmer']) || values.match(/[\d,.]+\s*Zimmer/i)?.[0],
        image: absolute(
          card.find('img[src], source[srcset]').first().attr('src') || card.find('source').first().attr('srcset'),
          DEFAULT_URL,
        ),
        description: values || null,
      });
    });
    if (result.length) break;
  }
  return result;
}

async function getListings(url) {
  try {
    const response = await fetch(url || DEFAULT_URL, { headers: HEADERS });
    if (!response.ok) return [];
    return cards(cheerio.load(await response.text()));
  } catch (error) {
    logger.warn(`Could not fetch WBM search page '${url || DEFAULT_URL}'.`, error?.message || error);
    return [];
  }
}

async function fetchDetails(listing) {
  try {
    const response = await fetch(listing.link, { headers: HEADERS });
    if (!response.ok) return listing;
    const $ = cheerio.load(await response.text());
    const body = text($('main, body').first().text());
    const jsonLd = $('script[type="application/ld+json"]')
      .map((_, el) => {
        try {
          return JSON.parse($(el).text());
        } catch {
          return null;
        }
      })
      .get()
      .find(Boolean);
    const image = absolute(jsonLd?.image || $('main img[src]').first().attr('src'), listing.link);
    const address = text(
      jsonLd?.address?.streetAddress
        ? `${jsonLd.address.streetAddress}, ${jsonLd.address.postalCode || ''} ${jsonLd.address.addressLocality || ''}`
        : $('.openimmo-detail__intro-address').first().text() || $('address').first().text(),
    );
    return {
      ...listing,
      price: extractNumber(
        labelled($, $('main'), ['Nettokaltmiete', 'Kaltmiete', 'Warmmiete', 'Gesamtmiete']) || listing.price,
      ),
      size: extractSize(labelled($, $('main'), ['Größe', 'Wohnfläche']) || listing.size),
      rooms: extractNumber(labelled($, $('main'), ['Anzahl der Zimmer', 'Zimmer']) || listing.rooms),
      address: address || listing.address,
      image: image || listing.image,
      description: body || listing.description,
    };
  } catch (error) {
    logger.warn(`Could not fetch WBM detail page for listing '${listing.id}'.`, error?.message || error);
    return listing;
  }
}

function normalize(raw) {
  const link = absolute(raw.link, DEFAULT_URL);
  return {
    id: buildHash(PROVIDER_ID, raw.id || link),
    link,
    title: text(raw.title),
    price: extractNumber(raw.price),
    size: extractSize(raw.size),
    rooms: extractNumber(raw.rooms),
    address: text(raw.address) || null,
    image: absolute(raw.image, DEFAULT_URL),
    description: raw.description || null,
  };
}
function filter(listing, blacklist = []) {
  return Boolean(
    listing.id &&
    listing.link &&
    listing.title &&
    !isOneOf(listing.title, blacklist) &&
    !isOneOf(listing.description, blacklist),
  );
}

/** @type {ProviderConfig} */
const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address', 'image', 'description'],
  url: null,
  getListings,
  fetchDetails,
  fetchDetailsAlways: true,
  normalize,
  activityProbe: checkIfListingIsActive,
};

export const createConfig = (sourceConfig, blacklist = []) => ({
  ...config,
  enabled: sourceConfig.enabled,
  url: sourceConfig.url || DEFAULT_URL,
  filter: (listing) => filter(listing, blacklist ?? []),
});
export const metaInformation = { countries: ['de'], name: 'WBM', baseUrl: BASE_URL, id: PROVIDER_ID };
export { config };
