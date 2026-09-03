# Bewerbungsmodul

Das Bewerbungsmodul ist eine lokale Python-3.12-Anwendung für Fredy. Es sucht keine Wohnungen. Fredy sendet passende Treffer per HTTP, anschließend führt genau ein Selenium-Worker einen zuvor aufgezeichneten und freigegebenen Bewerbungsablauf in einem sichtbaren Chrome-Fenster aus.

Das System enthält keine KI. Entscheidungen entstehen nur aus den sichtbaren Regeln und den aufgezeichneten Schritten.

## Start

Unter Windows genügt ein Doppelklick auf `Bewerbungsmodul starten.cmd`. Beim ersten Start wird eine virtuelle Python-Umgebung erstellt. Danach ist das Dashboard unter <http://127.0.0.1:8765> erreichbar.

Alternativ lässt sich die Anwendung so starten.

```powershell
cd bewerbungsmodul
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
python -m app.main
```

## Fredy einrichten

Im Dashboard stehen die lokale Zieladresse und der Bearer-Token. In Fredy wird ein HTTP-Benachrichtigungsadapter mit diesen beiden Werten angelegt. Die Erweiterung um `rooms` ist additiv, bestehende Empfänger bleiben kompatibel.

Jede Kombination aus Anbieterkennung und Objekt-ID wird nur einmal angenommen. Erneut gesendete Fredy-Ereignisse erzeugen keine weitere Bewerbung.

## Ersten Anbieter aufnehmen

1. Bewerberprofil und benötigte Dokumente hinterlegen.
2. Einen vorhandenen Workflow öffnen oder einen neuen Anbieter mit erlaubten Domains anlegen.
3. Eine echte Beispielwohnung öffnen und den Ablauf im separaten Chrome-Profil vormachen.
4. Aufgezeichnete Eingaben Profil-, Wohnungs-, Dokument- oder Zugangswerten zuordnen.
5. Regeln und die Absendegrenze kontrollieren.
6. Einen Dry-Run durchführen. Er stoppt vor der markierten Absendeschaltfläche.
7. Einen einmaligen Live-Test ausdrücklich bestätigen.
8. Den geprüften Workflow aktivieren.

Aktive Workflow-Versionen sind unveränderlich. Änderungen werden in einer neuen, erneut zu prüfenden Version vorgenommen.

## WEB.DE

IMAP muss im WEB.DE-Konto aktiviert sein. WEB.DE beschreibt die Aktivierung in den [POP3- und IMAP-Einstellungen](https://hilfe.web.de/pop-imap/einschalten.html). Für die Anwendung wird ein [anwendungsspezifisches Passwort](https://hilfe.web.de/sicherheit/2fa/anwendungsspezifisches-passwort.html) verwendet. Das Modul verbindet sich nach den [offiziellen IMAP-Serverdaten](https://hilfe.web.de/pop-imap/imap/imap-serverdaten.html) per IMAP-SSL mit `imap.web.de` auf Port `993`, liest neue Nachrichten mit `BODY.PEEK` und verändert weder Gelesen-Markierung noch Inhalt. Die Abfrage läuft alle 15 Sekunden.

WEB.DE kann den POP3- und IMAP-Zugriff bei längerer Nichtnutzung automatisch wieder ausschalten. In diesem Fall muss er im Postfach erneut aktiviert werden.

Eine Nachricht wird nur automatisch fortgesetzt, wenn genau eine offene Bewerbung und genau eine E-Mail-Regel passen. Links dürfen nur auf ausdrücklich freigegebene Domains führen. Eine Mustermail kann im Workflow ausgewählt werden, um den folgenden Browserablauf aufzunehmen.

## Sicherheitsgrenzen

- CAPTCHA, MFA, fehlende Dokumente, unbekannte Domains und mehrdeutige Elemente führen zu einem manuellen Haltepunkt.
- Es gibt kein automatisches Reparieren defekter Selektoren und keine CAPTCHA-Umgehung.
- Workflows können keinen Python-Code oder andere beliebige Programme ausführen.
- Mietverträge, Zahlungen, Kündigungen, digitale Unterschriften und Vertragsannahmen werden blockiert.
- Zugangsdaten und Verschlüsselungsschlüssel liegen im Windows Credential Manager.
- Dokumente liegen AES-GCM-verschlüsselt im lokalen Datenspeicher. Temporär entschlüsselte Upload-Dateien werden direkt nach dem Upload entfernt.
- Jeder Browser-Schritt wird mit Ergebnis, Zeitpunkt und Screenshot protokolliert.

Der Nutzer bleibt dafür verantwortlich, dass automatisierte Bewerbungen mit den Regeln des jeweiligen Anbieters vereinbar sind und die hinterlegten Angaben stimmen.

## Tests

```powershell
.\.venv\Scripts\python -m pytest
.\.venv\Scripts\ruff check app tests
```

Die automatisierten Browsertests arbeiten ausschließlich mit lokalen Testseiten und senden keine externe Bewerbung ab.

## WBM-Workflow

Der mitgelieferte WBM-Workflow wurde aus dem Selenium-Ablauf von [fischer-hub/wbmbot](https://github.com/fischer-hub/wbmbot) in das generische Format übertragen. Er ist absichtlich nicht aktiv und muss zunächst auf der aktuellen WBM-Seite per Dry-Run und bestätigtem Live-Test geprüft werden. Angaben zur verwendeten Vorlage stehen in `THIRD_PARTY_NOTICES.md`.
