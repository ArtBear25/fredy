# Bewerbungsmodul

Lokale Python-Anwendung für Fredy. Fredy sucht Wohnungen und übergibt Treffer per HTTP. Ein einzelner Selenium-Worker spielt pro Anbieter den einmal aufgezeichneten Bewerbungsablauf auf der konkreten Exposé-URL ab. Schritte und Ergebnisse liegen in SQLite. Die Anwendung enthält keine KI.

## Start unter Windows

Python 3.12 und ein Doppelklick auf `Bewerbungsmodul starten.cmd` genügen. Der Starter erstellt bei Bedarf `.venv` und installiert die festgeschriebenen Pakete aus `requirements-lock.txt` von PyPI. Unveränderte Pakete werden nicht erneut installiert. Das Konsolenfenster bleibt sichtbar, solange das Bewerbungsmodul läuft; `Strg+C` oder das Schließen dieses Fensters beendet den vollständigen Backend-Prozessbaum. Das Dashboard öffnet sich nach erfolgreichem Start auf dem lokalen Port 8765. Läuft dort bereits eine Instanz, wird sie nicht still weiterverwendet: der Starter zeigt den Konflikt im Konsolenfenster an.

Manuell aus diesem Verzeichnis mit `python -m venv .venv`, danach `.venv\Scripts\python.exe -m pip install -r requirements-lock.txt` und `.venv\Scripts\python.exe -m app.main` starten.

Beim ersten Browserlauf lädt Selenium Manager Chrome for Testing und den passenden ChromeDriver aus den offiziellen Downloadquellen. Das Paar wird unter `browser-cache` gespeichert und wiederverwendet. Seine Pfade stehen in `browser-runtime.json`. Der regulär installierte Chrome wird nicht für den Recorder verwendet. Browserupdates erfordern das Erneuern dieses Manifests bei gestopptem Dienst und anschließende Browsertests.

## Daten und Migration

Daten, Dokumente, Screenshots und Chrome-Profil liegen standardmäßig unter `%LOCALAPPDATA%/Wohnungsbot/Bewerbungsmodul`. Das Verschieben des Projekts ändert diesen Speicher nicht. `BEWERBUNGSMODUL_DATA_DIR` bestimmt einen anderen Datenspeicher, `BEWERBUNGSMODUL_PORT` einen anderen lokalen Port. Pro Datenspeicher darf nur ein Dienst laufen. Zugangsdaten im Windows Credential Manager werden durch einen anderen Datenpfad allein nicht getrennt.

Vor der Migration einer alten Datenbank entsteht eine Sicherung mit der Endung `.pre-v2.sqlite3`. Alte Workflow-Freigaben werden zurückgesetzt, weil sie keinen belastbaren Testnachweis enthalten. Frühere unterbrochene Versuche erhalten einen manuellen Haltepunkt. Vor erneutem Versand das Ergebnis beim Anbieter prüfen.

## Fredy einrichten

Zieladresse und Bearer-Token aus dem Dashboard in einem HTTP-Kanal hinterlegen und dem Suchauftrag zuweisen. Kanaltests, Preisänderungen und gewöhnliche Fundmeldungen erzeugen keine Bewerbung. Fredy sendet an diesen Kanal nur dann ein Bewerbungsereignis, wenn die Auto-Regel erfüllt ist oder der Nutzer in Telegram auf `Bewerben` gedrückt hat.

Fredy fragt über `/api/v1/fredy/workflows` mit demselben Bearer-Token ab, für welche Anbieter gerade ein aktiver Workflow existiert. Ein neu aufgenommener Workflow steht dadurch bei den nächsten Treffern automatisch zur Verfügung; ein fehlender Workflow ist ein normaler Zustand und startet keine Browseraktion.

Fredy übergibt numerische Originalwerte. Einmal eingereihte Bewerbungsereignisse bleiben bei Fehlern in `http_delivery_outbox` gespeichert und werden mit zunehmendem Abstand erneut zugestellt, auch nach Neustarts. Jeder Versuch verwendet die aktuellen Zugangsdaten des gespeicherten Kanals. Ein entfernter oder geänderter Empfänger bleibt als offener Fehler erhalten. Zugangstoken werden nicht in die Warteschlange kopiert. Einen Abbruch zwischen Fredys Speicherung eines Treffers und dessen Einreihung zum HTTP-Versand deckt sie nicht ab.

Wiederholte Anbieter-/Objekt-IDs und übereinstimmende normalisierte URLs werden erkannt. Live-Tests zählen bereits als Bewerbung. Unterschiedliche Portal-IDs und URLs für dieselbe Wohnung lassen sich dadurch nicht zuverlässig zusammenführen.

## Workflow aufnehmen

1. Im Dashboard Name, Anbieterkennung und die URL einer Beispielwohnung eintragen und `Workflow aufnehmen` wählen.
2. Das Modul öffnet die Beispielwohnung in Chrome. Den vollständigen Bewerbungsablauf einmal normal vormachen: Buttons anklicken, Formulare ausfüllen, Checkboxen und Auswahlen setzen und gegebenenfalls durch Modal, Frame oder neuen Tab gehen.
3. `Aufzeichnung beenden und übernehmen` wählen. Die tatsächlich verwendeten Domains werden automatisch aus der Aufnahme übernommen; URL-Muster oder Domainlisten müssen nicht gepflegt werden.
4. Die Aufnahme wird gespeichert und direkt für diese Anbieterkennung aktiviert. Eine neue vollständige Aufnahme erzeugt eine neue Version und ersetzt erst nach erfolgreichem Speichern die bisher aktive Version.
5. Bei späteren Treffern wählt das Modul den Workflow ausschließlich über die Anbieterkennung. Für Scout-Treffer mit bestätigtem Direktanbieter verwendet es `providerLink`, ansonsten die von Fredy gelieferte Exposé-URL. Die Beispiel-URL aus der Aufnahme wird nicht wiederverwendet.

Normale Texteingaben werden so gespeichert, wie sie beim Vormachen eingegeben wurden. Es gibt keinen verpflichtenden Mapping-, Dry-Run-, Live-Test- oder Aktivierungsschritt. Passwörter werden weiterhin nicht im Klartext aufgezeichnet. Technische Schrittbearbeitung, Regeln und E-Mail-Fortsetzungen bleiben optional verfügbar.

## Haltepunkte und Neustarts

Im Dashboard können Nutzer die Verarbeitung pausieren oder Workflows deaktivieren. Der aktuelle Schritt endet noch. Bei einem manuellen Haltepunkt bleibt der Browser für diese Bewerbung reserviert. Browserläufe blockieren den HTTP-Server nicht.

Versuche speichern Workflow-Version, Profil, Phase, nächsten Schritt und Versandstatus. Vor dem Absenden wird eine Versandabsicht gespeichert. Bleibt nach einem Abbruch offen, ob der Anbieter den Vorgang angenommen hat, wird nicht automatisch erneut gesendet.

Auf der Bewerbungsseite stehen Fortsetzen, Profil vor dem Versand aktualisieren, externen Erfolg bestätigen und Abbrechen bereit. Erneutes Absenden verlangt die ausdrückliche Bestätigung, dass der vorherige Versuch nichts abgesendet hat.

Neustarts halten unterbrochene Läufe zur Prüfung an. Dauerhaft zugeordnete, noch nicht begonnene E-Mail-Fortsetzungen bleiben ausführbar. Vorbereitungsschritte können mit frischem Browser wiederholt werden. Ein verlorener Browserzustand nach Versand wird nicht durch erneutes Absenden rekonstruiert.

## E-Mail-Fortsetzungen

Der Leser nutzt WEB.DE-IMAP über SSL auf Port 993, alle 15 Sekunden, mit schreibgeschütztem Postfach und `BODY.PEEK`. IMAP muss im Konto aktiviert sein. Benutzername und Anwendungspasswort werden in der Oberfläche hinterlegt und im Windows Credential Manager gespeichert.

Kontokennung, Postfach, UIDVALIDITY und UID bestimmen die Identität. Speicherung erfolgt vor dem Fortschreiben der UID. Ein Abbruch dazwischen verliert die Nachricht nicht. Beim ersten Abruf einer Postfachgeneration werden höchstens die jüngsten 100 Nachrichten eingelesen.

Automatische Zuordnung verlangt einen eindeutigen Bezug zur Wohnung, Eingang nach Beginn der Bewerbung und genau eine passende Regel. Der Anbietername allein reicht nicht. HTML-Anker bleiben erhalten. Mehrdeutige Nachrichten warten auf eine ausdrückliche Zuordnung auf der Bewerbungsseite.

Die Fortsetzung beginnt mit dem freigegebenen Bestätigungslink. Sein Öffnen gilt als Absendegrenze, da bereits ein GET eine Bestätigung auslösen kann. Eine Erfolgskontrolle danach ist erforderlich. Zuordnung und Einreihung werden gemeinsam gespeichert. Wiederholtes Lesen erzeugt keine zweite Fortsetzung.

## Grenzen

Unbekannte Domains, CAPTCHA, zusätzliche Anmeldung, fehlende Dokumente und mehrdeutige Elemente halten den Ablauf an. Es gibt keine CAPTCHA-Umgehung oder automatische Selektorreparatur. Gleichzeitig geöffnete, nicht eindeutig unterscheidbare Tabs benötigen eine manuelle Prüfung. Formulare mit mehreren echten Submit-Schaltflächen benötigen eine Erweiterung des Ausführungsmodells.

Der lokale Dienst prüft Host, Herkunft und CSRF-Token. Fredy und Recorder verwenden getrennte Bearer-Token. Das schützt nicht vor anderen Programmen unter demselben Windows-Konto.

Dokumente werden verschlüsselt gespeichert und für Uploads kurzzeitig entschlüsselt. Versuche und Schritte erhalten Protokolle und nach Möglichkeit Screenshots. Screenshots, Profile, E-Mail-Inhalte und Browserdaten können persönliche Angaben enthalten und liegen ohne zusätzliche Verschlüsselung durch die Anwendung lokal vor.

Bekannte Vertrags-, Zahlungs-, Kündigungs- und Unterschriftsaktionen werden anhand von Text und Elementen blockiert. Die Erkennung ersetzt keine inhaltliche Prüfung. Angaben und die Zulässigkeit der Automatisierung vor der Freigabe prüfen.

## Entwicklung und Tests

Die Laufzeit bleibt bei FastAPI, SQLite und einem Browser-Worker. Es gibt keinen zusätzlichen Broker. Modelle, Regeln, Persistenz, Browserausführung, Recorder, Postfach und HTTP-Routen liegen in eigenen Modulen.

Mit `.venv\Scripts\python.exe -m pip install -r requirements-dev-lock.txt` die Testumgebung installieren. Dann `.venv\Scripts\python.exe -m pytest -q` und `.venv\Scripts\ruff.exe check app tests` ausführen.

Lokale Integrationstests verwenden echte HTTP-Formulare, Selenium und die tatsächliche Recorder-Erweiterung. Sie prüfen die Wiedergabe auf unterschiedlichen Exposé-URLs, gespeicherte E-Mail-Fortsetzungen, Frames und Tabs. Externe Bewerbungen und echte Postfächer werden nicht verwendet. Browserdownloads können beim ersten Testlauf erforderlich sein.

Der mitgelieferte WBM-Entwurf bleibt inaktiv und sollte vor Verwendung auf der aktuellen Anbieterseite neu aufgenommen werden. Herkunft und Lizenz stehen in `THIRD_PARTY_NOTICES.md`.
