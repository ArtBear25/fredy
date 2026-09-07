/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const exampleDescription = `
Wohnungstyp: Etagenwohnung
Nutzfläche: 76 m²
Etage: 2 von 3
Schlafzimmer: 1
Badezimmer: 1
Bezugsfrei ab: 1.4.2026
Haustiere: Nein
Garage/Stellplatz: Tiefgarage
Anzahl Garage/Stellplatz: 1
Kaltmiete (zzgl. Nebenkosten): 1.000 €
Preis/m²: 13,16 €/m²
Nebenkosten: 230 €
Heizkosten in Nebenkosten enthalten: Ja
Gesamtmiete: 1.230 €
Kaution: 3.000,00
Preis pro Parkfläche: 60 €
Baujahr: 2000
Objektzustand: Modernisiert
Qualität der Ausstattung: Gehoben
Heizungsart: Fernwärme
Energieausweistyp: Verbrauchsausweis
Energieausweis: liegt vor
Endenergieverbrauch: 72 kWh/(m²∙a)
Baujahr laut Energieausweis: 2000

Diese moderne 3-Zimmer-Wohnung liegt direkt neben einem Park und nur wenige Minuten von der S-Bahn-Haltestelle entfernt. Das Stadtzentrum sowie Freizeiteinrichtungen sind 1,5 km entfernt.

Die Wohnung ist ideal für Paare oder kleine Familien geeignet.

Ausstattung:
- neuer hochwertiger Bodenbelag (Holzoptik) in allen Räumen außer Bad/Küche
- sonniger Balkon (Süd)
- Tiefgaragenstellplatz
- Kellerabteil
- gepflegtes Mehrfamilienhaus

Die Küche ist vom Mieter nach eigenen Wünschen einzurichten.

Vermietung direkt vom Eigentümer - provisionsfrei!

Lage:
• Park: 1 Minute zu Fuß
• S-Bahn Station: 2 Minuten zu Fuß
• Supermärkte, Restaurants, täglicher Bedarf in der Nähe
• Gute Anbindung Richtung Großstadt und Flughafen
`;

/**
 * The listing every "Try" button sends. One shared copy, so the pre-save test and the
 * test-an-existing-channel button cannot drift apart.
 * @type {Object}
 */
export const SAMPLE_LISTING = Object.freeze({
  address: 'Buttmannstr. 4, 13357 Berlin, Wedding',
  description: exampleDescription,
  id: 'test-buttmann',
  image: null,
  link: 'https://www.immobilienscout24.de/expose/170555494',
  officialProvider: 'gewobag',
  providerLink: 'https://www.gewobag.de/fuer-mietinteressentinnen/mietangebote/7100-79011-0101-0005',
  price: '693 €',
  size: '88 m²',
  title: 'Im Wedding!',
  travelTimes: [
    { label: 'DKB', transit: { minutes: 25 }, walk: { minutes: 38 } },
    { label: 'Kitty', transit: { minutes: 22 }, walk: { minutes: 83 } },
    { label: 'Supermarkt', walk: { minutes: 21 } },
    { label: 'Gym', walk: { minutes: 23 } },
  ],
});

/**
 * Fire one test notification through an adapter.
 *
 * Field values arrive in two shapes: the create form sends `{ key: { value } }` because it is
 * built straight from the adapter's field definitions, while the channel routes read plain values
 * out of the database. Both are accepted rather than making one caller reshape.
 *
 * `userId` matters for the browser adapter, which resolves its recipient from the job when it is
 * not told one. There is no job here, so without it a browser test would silently do nothing.
 *
 * @param {{config: {id: string}, send: Function}} adapter
 * @param {Record<string, any>} fields
 * @param {{userId?: string}} [options]
 * @returns {Promise<void>}
 */
export async function testFire(adapter, fields, { userId } = {}) {
  const values = {};
  for (const [key, raw] of Object.entries(fields ?? {})) {
    values[key] = raw != null && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  }

  await adapter.send({
    isTest: true,
    serviceName: 'TestCall',
    newListings: [SAMPLE_LISTING],
    notificationConfig: [{ id: adapter.config.id, enabled: true, fields: values }],
    jobKey: 'TestJob',
    userId,
  });
}
