/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Listing fingerprints
 *
 * Turns a listing into the small set of comparable signals that survive the trip through a German
 * real estate portal, and decides from those whether two listings are the same flat.
 *
 * Why this exists: dedup used to be an exact SHA-256 over `jobId|title|price|address`, which only
 * ever fires when two portals produce byte-identical strings. They never do. Every portal reads
 * its own field for the headline (`item.title` on ImmoScout, `mainDescription.headline` on
 * Immowelt, the result-card text node on Kleinanzeigen), builds its address line its own way, and
 * does not even agree on what the price means - ImmoScout is queried with
 * `pricetype=calculatedtotalrent` while Immowelt reports the Kaltmiete off `hardFacts.price`.
 * Three fields, three disagreements, so the hash never collided and "deduplication across
 * platforms" only worked by accident.
 *
 * What does survive the trip is the flat itself: its size, its room count, and where it is. Those
 * are the gate here. Title, price and description are only ever corroborating evidence, never
 * grounds to reject a match, because each of them is systematically different between portals.
 *
 * @module listingFingerprint
 */

/**
 * Widest disagreement in living space (m²) two portals may have and still be the same flat. Only
 * ever reached by flats big enough that a square metre is noise - see {@link sizeTolerance}.
 */
const MAX_SIZE_TOLERANCE_M2 = 1;

/** Share of the living space that counts as rounding rather than a different flat. */
const SIZE_TOLERANCE_RATIO = 0.02;

/** Relative price difference still considered "the same asking price". */
const PRICE_TOLERANCE = 0.02;

/** Jaccard similarity two title token sets need to corroborate a match. */
const TITLE_SIMILARITY_THRESHOLD = 0.45;

/** Jaccard similarity two locality token sets need to count as the same place. */
const LOCALITY_SIMILARITY_THRESHOLD = 0.5;

/** Estimated Jaccard two description sketches need to corroborate a match. */
const DESCRIPTION_SIMILARITY_THRESHOLD = 0.5;

/** A title needs at least this many meaningful tokens before its similarity means anything. */
const MIN_TITLE_TOKENS = 2;

/** Word count per description shingle. */
const SHINGLE_SIZE = 4;

/** Number of hashes kept in a description's bottom-k sketch. */
const SKETCH_SIZE = 32;

/** Only this many characters of a description are sketched, to bound hydration cost. */
const MAX_DESCRIPTION_CHARS = 2000;

/**
 * Street name endings that make a token recognisable as a street. Deliberately conservative:
 * `hof`, `berg` and `feld` are missing because they also end ordinary district names
 * ("Stadtamhof"), and a false street reading is far worse than a missing one.
 * Ordered longest-first so `strasse` wins over `str`.
 * @type {Array<{suffix: string, canonical: string}>}
 */
const STREET_SUFFIXES = [
  { suffix: 'strasse', canonical: 'str' },
  { suffix: 'promenade', canonical: 'promenade' },
  { suffix: 'chaussee', canonical: 'chaussee' },
  { suffix: 'graben', canonical: 'graben' },
  { suffix: 'allee', canonical: 'allee' },
  { suffix: 'gasse', canonical: 'gasse' },
  { suffix: 'platz', canonical: 'platz' },
  { suffix: 'steig', canonical: 'steig' },
  { suffix: 'zeile', canonical: 'zeile' },
  { suffix: 'anger', canonical: 'anger' },
  { suffix: 'markt', canonical: 'markt' },
  { suffix: 'damm', canonical: 'damm' },
  { suffix: 'pfad', canonical: 'pfad' },
  { suffix: 'ring', canonical: 'ring' },
  { suffix: 'ufer', canonical: 'ufer' },
  { suffix: 'weg', canonical: 'weg' },
  { suffix: 'str', canonical: 'str' },
];

/**
 * Words that appear in the address line without saying anything about *which* place it is.
 * @type {Set<string>}
 */
const ADDRESS_NOISE = new Set(['deutschland', 'germany', 'de', 'ot', 'ortsteil', 'stadtteil', 'bezirk', 'kreis']);

/** Official Berlin providers whose listings may be linked from a matching ImmoScout result. */
export const STRICT_OFFICIAL_PROVIDER_IDS = Object.freeze(['degewo', 'howoge', 'wbm', 'inberlinwohnen']);

/**
 * Direct-link hosts accepted for each supported official provider. InBerlinWohnen is an aggregator,
 * so only the seven partner domains named by the provider are accepted as a direct link; the
 * aggregator host itself is deliberately not one of them.
 * @type {Map<string, Set<string>>}
 */
const STRICT_DIRECT_HOSTS = new Map([
  ['degewo', new Set(['degewo.de'])],
  ['howoge', new Set(['howoge.de'])],
  ['wbm', new Set(['wbm.de'])],
  [
    'inberlinwohnen',
    new Set(['berlinovo.de', 'degewo.de', 'gesobau.de', 'gewobag.de', 'howoge.de', 'stadtundland.de', 'wbm.de']),
  ],
]);

const OFFICIAL_PROVIDER_BY_HOST = new Map([
  ['berlinovo.de', 'berlinovo'],
  ['degewo.de', 'degewo'],
  ['gesobau.de', 'gesobau'],
  ['gewobag.de', 'gewobag'],
  ['howoge.de', 'howoge'],
  ['stadtundland.de', 'stadtundland'],
  ['wbm.de', 'wbm'],
]);

/**
 * Words every second German listing headline carries. Left in, they inflate every title
 * comparison towards "similar" and the threshold stops meaning anything.
 * @type {Set<string>}
 */
const TITLE_NOISE = new Set(
  (
    'wohnung wohnungen zimmer zi zimmerwohnung raum miete mieten mietwohnung vermietung vermietet ' +
    'kauf kaufen kaufpreis haus apartment appartement wohnen immobilie immobilien objekt ' +
    'provisionsfrei provision courtagefrei erstbezug neubau neu renoviert saniert gepflegt gepflegte ' +
    'schoen schoene schoenes schoener hell helle helles heller modern moderne modernes moderner ' +
    'gross grosse grosses grosser grosszuegig grosszuegige toll tolle tolles ruhig ruhige ruhiges ' +
    'zentral zentrale zentrales gemuetlich gemuetliche exklusiv exklusive attraktiv attraktive ' +
    'mit ohne und oder in im am an auf aus bei fuer von vom zu zur zum der die das den dem des ' +
    'ein eine einer eines einem sowie ist sich als sehr nahe direkt ca qm m2 quadratmeter euro eur ' +
    'top jetzt hier ihre ihr wg zimmerig etage geschoss ' +
    'zwei drei vier fuenf sechs'
  ).split(' '),
);

/**
 * Fold a German string into a comparable ASCII form: lowercase, umlauts spelled out, every other
 * diacritic dropped, and anything that is not a letter or digit turned into a single space.
 *
 * @param {string|null|undefined} value
 * @returns {string} Normalized text, or an empty string for non-strings.
 */
export function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Validate a direct listing link for one of the supported official Berlin providers.
 * Redirects are never followed here: only the URL already present on the provider result is
 * considered, and its hostname has to be on the provider's fixed allowlist.
 *
 * @param {string} providerId
 * @param {string|null|undefined} link
 * @returns {string|null} Normalized allowed URL, or null when the URL must not be attached.
 */
export function strictDirectProviderLink(providerId, link) {
  const allowedHosts = STRICT_DIRECT_HOSTS.get(providerId);
  if (!allowedHosts || typeof link !== 'string' || !link.trim()) return null;

  try {
    const url = new URL(link);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['http:', 'https:'].includes(url.protocol) || !allowedHosts.has(hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Resolve a validated direct listing URL to the canonical Berlin provider id.
 *
 * @param {string|null|undefined} link
 * @returns {string|null}
 */
export function officialProviderFromDirectLink(link) {
  if (typeof link !== 'string' || !link.trim()) return null;
  try {
    const url = new URL(link);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    return ['http:', 'https:'].includes(url.protocol) ? (OFFICIAL_PROVIDER_BY_HOST.get(hostname) ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Canonicalise a strict-match street name. Unlike the general fingerprint matcher this keeps the
 * house number separate, because a range such as "38-40" must never collapse onto "38".
 *
 * @param {string} street
 * @returns {string|null}
 */
function normalizeStrictStreet(street) {
  let value = normalizeText(street);
  if (!value) return null;
  value = value.replace(/\bstrasse\b/g, 'str').replace(/strasse$/g, 'str');
  return value.replace(/\s+/g, '') || null;
}

/**
 * Pull exactly the three hard address fields required by the Scout-to-provider matcher.
 * District/city additions and a trailing country are deliberately ignored; the postcode remains a
 * mandatory field, so a district-only Scout address cannot accidentally acquire a direct link.
 *
 * @param {string|null|undefined} address
 * @returns {{street:string|null, houseNumber:string|null, zip:string|null}}
 */
export function parseStrictAddress(address) {
  if (typeof address !== 'string' || !address.trim()) {
    return { street: null, houseNumber: null, zip: null };
  }

  const cleaned = address
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\bdeutschland\b/gi, '')
    .trim();
  const zip = cleaned.match(/\b\d{5}\b/)?.[0] ?? null;
  let street = null;
  let houseNumber = null;

  for (const part of cleaned.split(/[,;|]/)) {
    const withoutLocality = part.replace(/\b\d{5}\b.*$/, '').trim();
    const match = withoutLocality.match(
      /^(.+?\D)\s+(\d{1,4}(?:\s*[a-z])?(?:\s*[-/]\s*\d{1,4}(?:\s*[a-z])?)?)$/i,
    );
    if (!match) continue;
    street = normalizeStrictStreet(match[1]);
    houseNumber = match[2].toLowerCase().replace(/\s+/g, '');
    break;
  }

  return { street, houseNumber, zip };
}

/**
 * The hard Scout24-to-official-provider comparison. Identity is deliberately kept separate from
 * commercial data: Scout and the housing company may expose different rent types, rounded areas or
 * room metadata for the same advert. A provider link is therefore joined only on the normalized
 * listing title plus the exact normalized street, house number and postcode.
 *
 * @param {any} scout
 * @param {any} official
 * @returns {boolean}
 */
export function isStrictScoutProviderMatch(scout, official) {
  const scoutTitle = normalizeText(scout?.title);
  const officialTitle = normalizeText(official?.title);
  if (!scoutTitle || scoutTitle !== officialTitle) return false;

  const scoutAddress = parseStrictAddress(scout?.address);
  const officialAddress = parseStrictAddress(official?.address);
  return Boolean(
    scoutAddress.street &&
      scoutAddress.houseNumber &&
      scoutAddress.zip &&
      officialAddress.street &&
      officialAddress.houseNumber &&
      officialAddress.zip &&
      scoutAddress.street === officialAddress.street &&
      scoutAddress.houseNumber === officialAddress.houseNumber &&
      scoutAddress.zip === officialAddress.zip,
  );
}

/**
 * Attach providerLink to the canonical Scout listings only where the run produced an unambiguous,
 * one-to-one strict match. Official listings consumed by such a pair are withheld from their later
 * notification batch; every ambiguous or unmatched listing remains untouched.
 *
 * @param {any[]} scoutListings
 * @param {Array<{providerId:string,listings:any[]}>} officialBatches
 * @returns {{scoutListings:any[], remainingByProvider:Map<string, any[]>}}
 */
export function mergeScoutWithOfficialListings(scoutListings = [], officialBatches = []) {
  // One direct URL is one candidate, even when (for example) HOWOGE itself and InBerlinWohnen
  // both surfaced it in the same run. Keep every source key so consuming the match suppresses every
  // duplicate notification, while retaining all listing variants for the hard comparison.
  const candidatesByLink = new Map();
  for (const { providerId, listings = [] } of officialBatches) {
    listings.forEach((listing, index) => {
      const directLink = strictDirectProviderLink(providerId, listing?.link);
      const officialProvider = officialProviderFromDirectLink(directLink);
      if (!directLink || !officialProvider) return;
      const sourceKey = `${providerId}:${index}`;
      const existing = candidatesByLink.get(directLink);
      if (existing) {
        existing.sourceKeys.push(sourceKey);
        existing.listings.push(listing);
        return;
      }
      candidatesByLink.set(directLink, {
        key: directLink,
        directLink,
        officialProvider,
        sourceKeys: [sourceKey],
        listings: [listing],
      });
    });
  }
  const candidates = [...candidatesByLink.values()];

  const matchesByScout = scoutListings.map((scout) =>
    candidates.filter((candidate) => {
      if (scout?.officialProvider && scout.officialProvider !== candidate.officialProvider) return false;
      return candidate.listings.some((listing) => isStrictScoutProviderMatch(scout, listing));
    }),
  );
  const matchingScoutCount = new Map();
  for (const matches of matchesByScout) {
    for (const candidate of matches) {
      matchingScoutCount.set(candidate.key, (matchingScoutCount.get(candidate.key) ?? 0) + 1);
    }
  }

  const consumed = new Set();
  const mergedScouts = scoutListings.map((scout, index) => {
    const matches = matchesByScout[index];
    if (matches.length !== 1 || matchingScoutCount.get(matches[0].key) !== 1) return scout;
    for (const sourceKey of matches[0].sourceKeys) consumed.add(sourceKey);
    const wbsRequirements = [scout.wbsRequirement, ...matches[0].listings.map((listing) => listing?.wbsRequirement)]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);
    const uniqueWbsRequirements = [...new Set(wbsRequirements)];
    const wbsRequirement =
      uniqueWbsRequirements.length === 1 ? uniqueWbsRequirements[0] : uniqueWbsRequirements.length > 1 ? 'unklar' : null;
    const wbsSourceText = matches[0].listings
      .flatMap((listing) => [listing?.title, listing?.description])
      .map((value) => String(value ?? '').trim())
      .filter((value) => /\bwbs\b|\beinkommensgrenz/i.test(value))
      .join('\n');
    return {
      ...scout,
      officialProvider: scout.officialProvider ?? matches[0].officialProvider,
      providerLink: matches[0].directLink,
      ...(wbsRequirement ? { wbsRequirement } : {}),
      ...(wbsSourceText ? { wbsSourceText } : {}),
    };
  });

  const remainingByProvider = new Map();
  for (const { providerId, listings = [] } of officialBatches) {
    remainingByProvider.set(
      providerId,
      listings.filter((_, index) => !consumed.has(`${providerId}:${index}`)),
    );
  }

  return { scoutListings: mergedScouts, remainingByProvider };
}

/**
 * Strip the parenthesized suffix portals append to an address ("Main 1 (Mitte)").
 *
 * Kept as its own step because the persisted `address` column is written with the suffix and the
 * cache is hydrated from it - the two have to agree on this or a restart changes the answer.
 *
 * @param {string|null|undefined} address
 * @returns {string|null|undefined} The address without parenthesized suffixes.
 */
export function stripAddressSuffix(address) {
  return typeof address === 'string' ? address.replace(/\s*\([^)]*\)/g, '') : address;
}

/**
 * True when the token reads as a German house number ("12", "12a", "12-14").
 *
 * @param {string|undefined} token
 * @returns {boolean}
 */
function isHouseNumber(token) {
  return typeof token === 'string' && /^\d{1,4}(?:[a-z]|\s*-\s*\d{1,4})?$/.test(token);
}

/**
 * Canonicalise a street token, collapsing the many spellings of the same ending
 * ("Prüfeninger Straße", "Prüfeningerstrasse", "Prüfeninger Str.") onto one string.
 *
 * @param {string} token A normalized token that ends in a known street suffix.
 * @param {string|undefined} previousToken The token before it, used for the split spelling.
 * @returns {string|null} Canonical street name, or null when the token is not a street.
 */
function canonicalStreet(token, previousToken) {
  for (const { suffix, canonical } of STREET_SUFFIXES) {
    if (!token.endsWith(suffix)) continue;
    const stem = token.slice(0, -suffix.length);
    // A bare "strasse" carries no name of its own - the word before it is the name.
    if (stem.length === 0) {
      if (!previousToken || previousToken.length < 2 || /^\d/.test(previousToken)) return null;
      return `${previousToken}${canonical}`;
    }
    if (stem.length < 2) return null;
    return `${stem}${canonical}`;
  }
  return null;
}

/**
 * Pull the structured parts out of a portal's address line.
 *
 * The three portals write the same address three ways ("Prüfeninger Straße 12, 93059 Regensburg",
 * "93059 Regensburg - Stadtamhof", "Stadtamhof, Regensburg"), so nothing here may assume an order
 * or a separator - each part is recognised by its own shape.
 *
 * A street is only reported when a house number follows it. Without one it is not precise enough
 * to be a signal at all, and "Stadtamhof" would read as a street.
 *
 * `precise` says whether that number names one door. A range - "Mindener Straße 102-110" - names a
 * whole complex, and a complex of micro-apartments is precisely where a dozen near-identical units
 * share an address without being the same flat.
 *
 * @param {string|null|undefined} address
 * @returns {{street: string|null, precise: boolean, zip: string|null, locality: Set<string>}}
 */
export function parseAddress(address) {
  const raw = stripAddressSuffix(address);
  const tokens = normalizeText(raw).split(' ').filter(Boolean);
  const result = { street: null, precise: false, zip: null, locality: new Set() };
  if (tokens.length === 0) return result;

  // Normalization turns "102-110" into two separate tokens, so the range has to be recognised in
  // the raw text before it is lost. Only the number a range starts at is recorded - that is the one
  // the token scan below will pick up as the house number.
  const rangeStarts = new Set([...String(raw ?? '').matchAll(/\b(\d{1,4})\s*-\s*\d{1,4}\b/g)].map((match) => match[1]));

  const consumed = new Set();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (result.zip == null && /^\d{5}$/.test(token)) {
      result.zip = token;
      consumed.add(i);
      continue;
    }
    if (result.street == null && isHouseNumber(tokens[i + 1] ?? '')) {
      const street = canonicalStreet(token, tokens[i - 1]);
      if (street != null) {
        const houseNumber = tokens[i + 1].replace(/\s+/g, '');
        result.street = `${street} ${houseNumber}`;
        result.precise = !houseNumber.includes('-') && !rangeStarts.has(houseNumber);
        consumed.add(i).add(i + 1);
        if (street.startsWith(tokens[i - 1] ?? ' ')) consumed.add(i - 1);
      }
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const token = tokens[i];
    if (token.length < 3 || ADDRESS_NOISE.has(token) || /^\d+$/.test(token)) continue;
    result.locality.add(token);
  }

  return result;
}

/**
 * Reduce a headline to the words that actually distinguish it from the next listing's headline.
 *
 * @param {string|null|undefined} title
 * @returns {Set<string>} Meaningful tokens.
 */
export function titleTokens(title) {
  const tokens = normalizeText(title).split(' ').filter(Boolean);
  return new Set(tokens.filter((token) => token.length >= 3 && !TITLE_NOISE.has(token)));
}

/**
 * 32-bit FNV-1a. Not cryptographic - it only has to spread word shingles evenly across the bottom-k
 * sketch, and it has to be fast enough to run over every stored description on every cache reload.
 *
 * @param {string} value
 * @returns {number} Unsigned 32-bit hash.
 */
function hash32(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Build a bottom-k sketch of a description, so two of them can be compared in constant space.
 *
 * Broker copy is usually pasted verbatim into every portal, which makes the description the one
 * signal that reliably agrees across providers when the address does not. Storing the full text
 * for every listing in the cache is not worth it, so each description is reduced to the
 * {@link SKETCH_SIZE} smallest shingle hashes; the share of those two listings have in common
 * estimates the Jaccard similarity of their full shingle sets.
 *
 * @param {string|null|undefined} description
 * @returns {number[]} Ascending hashes, empty when the text is too short to sketch.
 */
export function descriptionSketch(description) {
  if (typeof description !== 'string' || description.length === 0) return [];
  const words = normalizeText(description.slice(0, MAX_DESCRIPTION_CHARS)).split(' ').filter(Boolean);
  if (words.length < SHINGLE_SIZE) return [];

  const hashes = new Set();
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
    hashes.add(hash32(words.slice(i, i + SHINGLE_SIZE).join(' ')));
  }
  return [...hashes].sort((a, b) => a - b).slice(0, SKETCH_SIZE);
}

/**
 * How much the two living-space figures may differ and still describe one flat.
 *
 * Portals round square metres differently, so a flat needs some slack - but a fixed square metre is
 * rounding on a 78 m² family flat and a whole 4% on a 25 m² micro-apartment, and buildings full of
 * micro-apartments are exactly where near-identical units sit next to each other. The slack is
 * therefore a share of the flat, capped at a square metre and floored at nothing.
 *
 * @param {number} a Rounded living space of one listing.
 * @param {number} b Rounded living space of the other.
 * @returns {number} Tolerated difference in m².
 */
function sizeTolerance(a, b) {
  return Math.min(MAX_SIZE_TOLERANCE_M2, Math.floor(Math.min(a, b) * SIZE_TOLERANCE_RATIO));
}

/**
 * Jaccard similarity of two sets. Zero when either side is empty, so an absent signal can never
 * push a comparison towards "duplicate".
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} Between 0 and 1.
 */
export function jaccard(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set) || a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) {
    if (large.has(value)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * Estimated Jaccard similarity of two bottom-k sketches.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} Between 0 and 1.
 */
function sketchSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const set = new Set(a);
  let shared = 0;
  for (const value of b) {
    if (set.has(value)) shared++;
  }
  return shared / Math.min(a.length, b.length);
}

/**
 * Coerce a value to a finite number, or null.
 *
 * @param {any} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (value == null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

/**
 * @typedef {Object} SimilarityRecord
 * @property {string} jobId Job the listing belongs to. Dedup never crosses jobs.
 * @property {string|null|undefined} [provider] Provider id the listing came from.
 * @property {string|null|undefined} title
 * @property {string|null|undefined} address
 * @property {number|string|null|undefined} price
 * @property {number|string|null|undefined} [size] Living space in m².
 * @property {number|string|null|undefined} [rooms]
 * @property {string|null|undefined} [description]
 */

/**
 * @typedef {Object} Fingerprint
 * @property {string} jobId
 * @property {string|null} provider
 * @property {number|null} size Rounded living space in m².
 * @property {number|null} rooms Rounded to the nearest half room.
 * @property {number|null} price
 * @property {string|null} street Canonical street name plus house number.
 * @property {boolean} streetPrecise Whether that house number names one door rather than a range.
 * @property {string|null} zip
 * @property {Set<string>} locality
 * @property {Set<string>} title
 * @property {number[]} description Bottom-k sketch.
 * @property {string|null} blockKey Bucket the listing is indexed under, null when unbucketable.
 */

/**
 * Build the comparable form of a listing.
 *
 * @param {SimilarityRecord} record
 * @returns {Fingerprint}
 */
export function buildFingerprint(record) {
  const rawSize = toNumber(record?.size);
  const rawRooms = toNumber(record?.rooms);
  // Portals round living space differently and SQLite hands integers back for the same column, so
  // both sides have to be pinned to the same grid before they can be compared or bucketed.
  const size = rawSize == null ? null : Math.round(rawSize);
  const rooms = rawRooms == null ? null : Math.round(rawRooms * 2) / 2;
  const { street, precise, zip, locality } = parseAddress(record?.address);

  return {
    jobId: record?.jobId ?? null,
    provider: record?.provider ?? null,
    size,
    rooms,
    price: toNumber(record?.price),
    street,
    streetPrecise: precise,
    zip,
    locality,
    title: titleTokens(record?.title),
    description: descriptionSketch(record?.description),
    blockKey: size == null || rooms == null || record?.jobId == null ? null : `${record.jobId}|${rooms}|${size}`,
  };
}

/**
 * Every bucket a fingerprint has to be compared against.
 *
 * Buckets are keyed on the exact rounded size, so honouring the size tolerance means probing the
 * neighbouring buckets too rather than widening the key and losing its selectivity. The probe is
 * always the widest tolerance {@link sizeTolerance} can return; a narrower one simply rejects the
 * extra candidates on comparison.
 *
 * @param {Fingerprint} fingerprint
 * @returns {string[]} Bucket keys, empty when the listing cannot be bucketed.
 */
export function candidateBlockKeys(fingerprint) {
  if (fingerprint?.blockKey == null) return [];
  const keys = [];
  for (let delta = -MAX_SIZE_TOLERANCE_M2; delta <= MAX_SIZE_TOLERANCE_M2; delta++) {
    keys.push(`${fingerprint.jobId}|${fingerprint.rooms}|${fingerprint.size + delta}`);
  }
  return keys;
}

/**
 * Decide whether two fingerprints describe the same flat on two different portals.
 *
 * The rule, in order:
 *
 * 1. **Gate.** Same job, *different* providers, living space within {@link sizeTolerance}, same room
 *    count. Size and rooms are the only two numbers every portal reports the same way, so they are
 *    the hard requirement. Restricting the whole comparison to cross-provider pairs is what keeps
 *    two genuinely different flats in one building - listed side by side on one portal, often with
 *    the same size, rooms and copy - from collapsing into one.
 * 2. **Place.** The same street and house number, or the same postcode, or overlapping locality
 *    words. Without any of them the listings are not comparable at all.
 * 3. **Corroboration.** A street plus a *door* number is precise enough on its own. Anything
 *    coarser - a postcode, a district, or a house number spanning a whole complex - needs one more
 *    agreeing signal: the asking price, the headline wording, or the advertising copy. Any *one*
 *    suffices, because each is independently unreliable across portals - the price especially,
 *    since Fredy asks ImmoScout for the total rent and Immowelt for the Kaltmiete.
 *
 * @param {Fingerprint} a
 * @param {Fingerprint} b
 * @returns {boolean} True when the two should be treated as the same listing.
 */
export function isLikelyDuplicate(a, b) {
  if (a == null || b == null) return false;
  if (a.jobId == null || a.jobId !== b.jobId) return false;
  // Cross-provider only. Two ads on the same portal are the portal's business, not ours.
  if (a.provider == null || b.provider == null || a.provider === b.provider) return false;
  if (a.size == null || b.size == null || Math.abs(a.size - b.size) > sizeTolerance(a.size, b.size)) return false;
  if (a.rooms == null || b.rooms == null || a.rooms !== b.rooms) return false;

  const sameStreet = a.street != null && a.street === b.street;
  const sameZip = a.zip != null && a.zip === b.zip;
  const sameLocality = jaccard(a.locality, b.locality) >= LOCALITY_SIMILARITY_THRESHOLD;
  if (!sameStreet && !sameZip && !sameLocality) return false;
  if (sameStreet && a.streetPrecise && b.streetPrecise) return true;

  const samePrice =
    a.price != null && b.price != null && Math.abs(a.price - b.price) <= Math.max(a.price, b.price) * PRICE_TOLERANCE;
  const sameTitle =
    a.title.size >= MIN_TITLE_TOKENS &&
    b.title.size >= MIN_TITLE_TOKENS &&
    jaccard(a.title, b.title) >= TITLE_SIMILARITY_THRESHOLD;
  const sameDescription = sketchSimilarity(a.description, b.description) >= DESCRIPTION_SIMILARITY_THRESHOLD;

  return samePrice || sameTitle || sameDescription;
}
