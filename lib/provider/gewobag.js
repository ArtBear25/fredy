/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf } from '../utils.js';
import { extractNumber } from '../utils/extract-number.js';
import logger from '../services/logger.js';
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const PROVIDER_ID = 'gewobag';
const BASE_URL = 'https://www.gewobag.de/';
const DEFAULT_URL = `${BASE_URL}fuer-mietinteressentinnen/mietangebote/?objekttyp%5B0%5D=wohnung`;
const MAX_PAGES = 20;
const HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'de-DE,de;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const text = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const numberInText = (value) => extractNumber(text(value).match(/\d+(?:[.\s]\d{3})*(?:,\d+)?/)?.[0]);

const absolute = (value, base = BASE_URL) => {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname.replace(/^www\./, '') === 'gewobag.de'
      ? url.href
      : null;
  } catch {
    return null;
  }
};

const directOfferLink = (value, base = BASE_URL) => {
  const url = absolute(value, base);
  if (!url) return null;
  return /^\/fuer-mietinteressentinnen\/mietangebote\/\d{4}-\d{5}-\d{4}-\d{4}\/?$/.test(new URL(url).pathname)
    ? url
    : null;
};

/**
 * Parse one server-rendered Gewobag result page.
 *
 * Search cards intentionally keep the total rent separate from Fredy's `price`: Gewobag exposes
 * Gesamtmiete on the result page while Fredy's existing rent filters interpret `price` as cold
 * rent. The detail page supplies Grundmiete before the second spec-filter pass.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{listings: object[], nextUrl: string|null}}
 */
export function parseSearchPage(html, pageUrl = DEFAULT_URL) {
  const $ = cheerio.load(html);
  const listings = [];

  $('article.angebot-big-box.gw-offer, article.angebot-big-box').each((_, element) => {
    const card = $(element);
    const link = directOfferLink(
      card.find('.angebot-footer a[href], a.read-more-link[href]').first().attr('href'),
      pageUrl,
    );
    if (!link) return;

    const area = text(card.find('.angebot-area td').first().text());
    const rooms = extractNumber(area.match(/\d+(?:[.,]\d+)?\s*Zimmer/i)?.[0]);
    const size = extractNumber(area.match(/\d+(?:[.,]\d+)?\s*m²/i)?.[0]);
    const totalRentText = text(card.find('.angebot-kosten td').first().text());
    const totalRent = numberInText(totalRentText);
    const availability = text(card.find('.availability td').first().text());
    const region = text(card.find('.angebot-region td').first().text());
    const features = card
      .find('.angebot-characteristics li')
      .map((__, item) => text($(item).text()))
      .get()
      .filter(Boolean);
    const wbsRequired = card
      .find('.gw-pictogram--wbs title, .gw-pictogram title')
      .toArray()
      .some((item) => /WBS.*erforderlich/i.test(text($(item).text())));
    const title = text(card.find('.angebot-title').first().text());
    const noWbs = /\b(?:ohne|kein)\s+WBS\b/i.test(title);
    const description = [
      region ? `Bezirk/Ortsteil: ${region}` : null,
      totalRent != null ? `Gesamtmiete: ${totalRent} €` : null,
      availability ? `Frei ab: ${availability}` : null,
      wbsRequired ? 'WBS: erforderlich' : noWbs ? 'WBS: nicht erforderlich' : null,
      features.length ? `Merkmale: ${features.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    listings.push({
      id: link,
      link,
      title,
      address: text(card.find('.angebot-address address, address').first().text()) || null,
      totalRent,
      size,
      rooms,
      image: absolute(card.find('img[src]').first().attr('src'), pageUrl),
      description: description || null,
      wbsRequirement: wbsRequired ? 'erforderlich' : noWbs ? 'nicht erforderlich' : undefined,
      providerName: 'Gewobag',
    });
  });

  const nextUrl = absolute($('a.next.page-numbers[href]').first().attr('href'), pageUrl);
  return { listings, nextUrl };
}

/**
 * Parse authoritative fields from a Gewobag detail page.
 *
 * @param {string} html
 * @param {object} listing
 * @returns {object}
 */
export function parseDetailPage(html, listing) {
  const $ = cheerio.load(html);
  const title = text($('h1').first().text());
  if (!title || /Mietangebot nicht gefunden/i.test(title)) return listing;

  const valueFor = (label) => {
    const wanted = label.toLocaleLowerCase('de-DE');
    const row = $('table tr')
      .filter((_, element) => text($(element).find('th').first().text()).toLocaleLowerCase('de-DE') === wanted)
      .first();
    return row.length ? text(row.find('td').first().text()) : null;
  };

  const objectDescription = text($('#objektbeschreibung').next('p').first().text());
  const locationDescription = text($('#lage').next('p').first().text());
  const features = $('table')
    .filter((_, table) =>
      /Merkmale/i.test(text($(table).find('th, caption').first().text()) + text($(table).text()).slice(0, 20)),
    )
    .first()
    .find('li')
    .map((_, item) => text($(item).text()))
    .get()
    .filter(Boolean);
  const totalRent = extractNumber(valueFor('Gesamtmiete'));
  const objectNumber = valueFor('Objektnummer');
  const noWbs = /\b(?:ohne|kein)\s+WBS\b/i.test([title, objectDescription].filter(Boolean).join(' '));
  const wbsRequired = /\bWBS\b.*\b(?:erforderlich|benötigt|notwendig)\b/i.test(
    [title, objectDescription].filter(Boolean).join(' '),
  );
  const description = [
    objectDescription,
    locationDescription,
    totalRent != null ? `Gesamtmiete: ${totalRent} €` : null,
    objectNumber ? `Objektnummer: ${objectNumber}` : null,
    features.length ? `Merkmale: ${features.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    ...listing,
    title: title || listing.title,
    price: extractNumber(valueFor('Grundmiete')) ?? listing.price,
    size: extractNumber(valueFor('Fläche in m²')) ?? listing.size,
    rooms: extractNumber(valueFor('Anzahl Zimmer')) ?? listing.rooms,
    address: valueFor('Anschrift') || listing.address,
    image: absolute($('.swiper img[src], main img[src]').first().attr('src'), listing.link) || listing.image,
    description: description || listing.description,
    wbsRequirement: wbsRequired ? 'erforderlich' : noWbs ? 'nicht erforderlich' : listing.wbsRequirement,
    providerName: 'Gewobag',
  };
}

async function getListings(url) {
  const listings = [];
  const seenPages = new Set();
  const seenLinks = new Set();
  let pageUrl = absolute(url || DEFAULT_URL) || DEFAULT_URL;

  for (let page = 1; page <= MAX_PAGES && pageUrl && !seenPages.has(pageUrl); page++) {
    seenPages.add(pageUrl);
    try {
      const response = await fetch(pageUrl, { headers: HEADERS });
      if (!response.ok) {
        logger.warn(`Gewobag search page ${page} returned HTTP ${response.status}.`);
        break;
      }
      const parsed = parseSearchPage(await response.text(), pageUrl);
      for (const listing of parsed.listings) {
        if (!seenLinks.has(listing.link)) {
          seenLinks.add(listing.link);
          listings.push(listing);
        }
      }
      pageUrl = parsed.nextUrl;
    } catch (error) {
      logger.warn(`Could not fetch Gewobag search page '${pageUrl}'.`, error?.message || error);
      break;
    }
  }

  return listings;
}

async function fetchDetails(listing) {
  try {
    const response = await fetch(listing.link, { headers: HEADERS });
    if (!response.ok) return listing;
    return parseDetailPage(await response.text(), listing);
  } catch (error) {
    logger.warn(`Could not fetch Gewobag detail page for listing '${listing.id}'.`, error?.message || error);
    return listing;
  }
}

async function activityProbe(link) {
  try {
    const response = await fetch(link, { headers: HEADERS, redirect: 'follow' });
    if ([404, 410].includes(response.status)) return 0;
    if ([401, 403, 429].includes(response.status)) return -1;
    if (!response.ok) return -1;
    const $ = cheerio.load(await response.text());
    const title = text($('h1').first().text());
    if (
      /Mietangebot nicht gefunden|Bewerbungsphase abgeschlossen/i.test(title) ||
      /Mietangebot nicht gefunden/i.test($('body').text())
    ) {
      return 0;
    }
    return $('body.single-immobilien, table').length > 0 && valueExists($, 'Objektnummer') ? 1 : -1;
  } catch {
    return -1;
  }
}

function valueExists($, label) {
  const wanted = label.toLocaleLowerCase('de-DE');
  return (
    $('table tr').filter(
      (_, element) => text($(element).find('th').first().text()).toLocaleLowerCase('de-DE') === wanted,
    ).length > 0
  );
}

function normalize(raw) {
  const link = directOfferLink(raw.link);
  return {
    id: buildHash(PROVIDER_ID, link || raw.id),
    link,
    title: text(raw.title),
    // Search cards show Gesamtmiete. Leave Fredy's cold-rent field empty until fetchDetails() reads
    // the authoritative Grundmiete, matching the existing WBM behavior.
    price: null,
    size: extractNumber(raw.size),
    rooms: extractNumber(raw.rooms),
    address: text(raw.address) || null,
    image: absolute(raw.image, link || DEFAULT_URL),
    description: raw.description || null,
    wbsRequirement: raw.wbsRequirement,
    providerName: 'Gewobag',
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
  requiredFieldNames: [
    'id',
    'link',
    'title',
    'price',
    'size',
    'rooms',
    'address',
    'image',
    'description',
    'wbsRequirement',
    'providerName',
  ],
  url: null,
  getListings,
  fetchDetails,
  fetchDetailsAlways: true,
  normalize,
  activityProbe,
};

export const createConfig = (sourceConfig, blacklist = []) => ({
  ...config,
  enabled: sourceConfig.enabled,
  url: sourceConfig.url || DEFAULT_URL,
  filter: (listing) => filter(listing, blacklist ?? []),
});

export const metaInformation = { countries: ['de'], name: 'Gewobag', baseUrl: BASE_URL, id: PROVIDER_ID };
export { config };
