/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getGeocoordinatesByAddress } from '../storage/listingsStorage.js';
import { geocode as nominatimGeocode, isPaused as isNominatimPaused } from './client/nominatimClient.js';
import { DEFAULT_COUNTRIES } from '../providers/countries.js';
import { getProviderIdsForCountries } from '../providers/providerCountries.js';
import logger from '../logger.js';

/**
 * An address with a trailing parenthesis removed, or null when there is nothing to remove.
 *
 * Kleinanzeigen writes how far a listing is from the searched point into the address, so what
 * reaches the geocoder is `40217 Unterbilk (0.6 km)`. Nominatim treats the distance as part of the
 * place name and answers "no such place", which is not an error: the listing is stored without
 * coordinates, so no area filter can judge it and no travel time is computed.
 *
 * Only the last parenthesis, only at the end, and only if something is left. Anything a portal puts
 * after the address is the portal talking about the listing rather than naming the place.
 *
 * @param {string} address
 * @returns {string|null}
 */
function withoutTrailingParenthesis(address) {
  const trimmed = address.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return trimmed.length > 0 && trimmed !== address.trim() ? trimmed : null;
}

/**
 * Remove a multi-letter building qualifier appended directly to a house number.
 *
 * Some direct-provider feeds expose internal building labels as part of the number, for example
 * `Weserstraße 215QU, 12047 Berlin`. Nominatim cannot resolve that spelling although the postal
 * address `Weserstraße 215, 12047 Berlin` is valid. A normal one-letter suffix such as `12A` is a
 * legitimate house number and is deliberately kept.
 *
 * Only the street segment before the first comma is touched, and only after the complete address
 * has already returned "not found", so the provider's original display address remains unchanged.
 *
 * @param {string} address
 * @returns {string|null}
 */
function withoutBuildingQualifier(address) {
  const comma = address.indexOf(',');
  const streetPart = comma === -1 ? address : address.slice(0, comma);
  const suffix = comma === -1 ? '' : address.slice(comma);
  const strippedStreet = streetPart.replace(/(\d+)[A-Za-zÄÖÜäöüß]{2,}\s*$/u, '$1').trimEnd();
  const trimmed = `${strippedStreet}${suffix}`.trim();
  return trimmed.length > 0 && trimmed !== address.trim() ? trimmed : null;
}

/**
 * Geocodes an address using Nominatim or cached results from the database.
 *
 * @param {string} address - The address to geocode.
 * @param {string[]} [countries] - ISO 3166-1 alpha-2 codes to search in. Defaults to Germany, which
 *   is what every provider that declares nothing resolves to.
 * @returns {Promise<{lat: number, lng: number}|null>} The geocoordinates or null if error. {lat: -1, lng: -1} if not found.
 */
export async function geocodeAddress(address, countries = DEFAULT_COUNTRIES) {
  if (!address) {
    return null;
  }

  try {
    // 1. Check if we already have this address geocoded in our database. Scoped to the providers
    // of the countries being asked about: the cache matches on the address text alone, so an
    // identically written street in a neighbouring country would otherwise answer for this one.
    const cachedCoordinates = getGeocoordinatesByAddress(address, await getProviderIdsForCountries(countries));
    if (cachedCoordinates) {
      logger.debug(`Found cached geocoordinates for address: ${address}`);
      return cachedCoordinates;
    }

    // 2. If not, use Nominatim
    const coordinates = await nominatimGeocode(address, countries);

    // 3. Nothing found. Retry only with safe portal-noise variants. A null means the geocoder could
    // not be reached or is standing off after a 429, and asking again would double the requests
    // exactly when Nominatim has said to stop. Never retry when the complete address worked either:
    // a simplified address can resolve somewhere else, and `_filterByArea` could then delete a good
    // listing on the strength of the worse coordinate.
    if (coordinates != null && coordinates.lat === -1 && coordinates.lng === -1) {
      const candidates = [];
      const withoutParenthesis = withoutTrailingParenthesis(address);
      if (withoutParenthesis != null) candidates.push(withoutParenthesis);

      const withoutQualifier = withoutBuildingQualifier(withoutParenthesis ?? address);
      if (withoutQualifier != null && !candidates.includes(withoutQualifier)) candidates.push(withoutQualifier);

      for (const candidate of candidates) {
        logger.debug(`No coordinates for '${address}'. Trying '${candidate}'.`);
        const retry = await nominatimGeocode(candidate, countries);
        if (retry == null || retry.lat !== -1 || retry.lng !== -1) {
          return retry;
        }
      }
    }

    return coordinates;
  } catch (error) {
    logger.error('Error during geocoding:', error);
    return null;
  }
}

/**
 * Checks if we are currently in a rate limit pause.
 * @returns {boolean}
 */
export function isGeocodingPaused() {
  return isNominatimPaused();
}
