/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as cheerio from 'cheerio';
import { buildHash, isOneOf } from '../utils.js';
import { extractNumber } from '../utils/extract-number.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

const PROVIDER_ID = 'gewobe';
const BASE_URL = 'https://www.gewobe.de/';
const DEFAULT_URL = `${BASE_URL}leistungen/immobilienangebote`;
const PORTAL_BASE_URL = 'https://portal.immobilienscout24.de/';
const PORTAL_ACCOUNT_ID = '54212102';
const PORTAL_URL = `${PORTAL_BASE_URL}ergebnisliste/${PORTAL_ACCOUNT_ID}`;
const REQUEST_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toAbsolutePortalUrl(value) {
  if (!value) return null;
  try {
    return new URL(value, PORTAL_BASE_URL).href;
  } catch {
    return null;
  }
}

function portalNumber(value) {
  const match = cleanText(value).match(/-?[\d.]+(?:,\d+)?/);
  return extractNumber(match?.[0] ?? null);
}

function readScore($, card, labelPattern) {
  const item = card
    .find('.result__list__element__infos--list > li')
    .filter((_, element) => labelPattern.test(cleanText($(element).find('h4').first().text())))
    .first();
  return cleanText(item.find('.result__list__element__infos__list--score').first().text()) || null;
}

/**
 * Parse the static result list embedded by gewobe after marketing-cookie consent.
 * The iframe is an ImmoScout24 provider portal dedicated to gewobe (account 54212102).
 *
 * @param {string} html
 * @returns {any[]}
 */
export function parseExposeAddress(html) {
  const $ = cheerio.load(html);
  return cleanText($('.expose--text__address').first().text()) || null;
}

export function parseListings(html) {
  const $ = cheerio.load(html);

  return $('.result__list--element')
    .map((_, element) => {
      const card = $(element);
      const anchor = card.find('.result__list__element__infos--figcaption a[href]').first();
      const href = anchor.attr('href');
      const id = href?.match(new RegExp(`/expose/${PORTAL_ACCOUNT_ID}/(\\d+)/`))?.[1] ?? null;
      const title = cleanText(anchor.text());
      const link = toAbsolutePortalUrl(href);
      const address = cleanText(card.find('.result__list__element__infos--location').first().text());
      const price = readScore($, card, /^(kaltmiete|warmmiete|miete(?: pro monat)?)$/i);
      const size = readScore($, card, /^(wohnfläche|nutzfläche)$/i);
      const rooms = readScore($, card, /^zimmer$/i);
      const image = toAbsolutePortalUrl(card.find('.result__list__element--image img').first().attr('src'));
      const type = cleanText(card.find('.result__list__element--infos > p').first().text());

      if (!id || !title || !link || !address || !price || !size || !rooms) return null;

      return { id, title, link, address, price, size, rooms, image, description: type || null };
    })
    .get();
}

async function getListings(url) {
  const fetchUrl = String(url || '').includes('portal.immobilienscout24.de') ? url : PORTAL_URL;
  try {
    const response = await fetch(fetchUrl, { headers: REQUEST_HEADERS, redirect: 'follow' });
    if (!response.ok) {
      logger.warn(`gewobe offers returned HTTP ${response.status}.`);
      return [];
    }
    const listings = parseListings(await response.text());
    await Promise.all(
      listings.map(async (listing) => {
        try {
          const detailResponse = await fetch(listing.link, { headers: REQUEST_HEADERS, redirect: 'follow' });
          if (!detailResponse.ok) return;
          const address = parseExposeAddress(await detailResponse.text());
          if (address) listing.address = address;
        } catch (error) {
          logger.debug?.(`Could not enrich gewobe offer ${listing.id}: ${error?.message || error}`);
        }
      }),
    );
    return listings;
  } catch (error) {
    logger.warn('Could not fetch gewobe offers.', error?.message || error);
    return [];
  }
}

function normalize(listing) {
  const sourceId = cleanText(listing.id || listing.link);
  const address = cleanText(listing.address);

  return {
    id: sourceId ? buildHash(PROVIDER_ID, sourceId) : null,
    link: toAbsolutePortalUrl(listing.link),
    title: cleanText(listing.title),
    price: portalNumber(listing.price),
    size: portalNumber(listing.size),
    rooms: portalNumber(listing.rooms),
    address: address ? (/\bdeutschland\b/i.test(address) ? address : `${address}, Deutschland`) : null,
    image: toAbsolutePortalUrl(listing.image),
    description: listing.description || null,
  };
}

function applyBlacklist(listing, blacklist = []) {
  return (
    !isOneOf(listing.title, blacklist) &&
    !isOneOf(listing.description, blacklist) &&
    !isOneOf(listing.address, blacklist)
  );
}

/** @type {ProviderConfig} */
const config = {
  requiredFieldNames: ['id', 'link', 'title', 'price', 'size', 'rooms', 'address'],
  url: null,
  getListings,
  normalize,
};

export const metaInformation = {
  countries: ['de'],
  name: 'gewobe',
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
