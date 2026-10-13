# Homebox – eigene Version: Installation, Offline-Nutzung, Backup

Diese Version von Homebox (Fork von [sysadminsmedia/homebox](https://github.com/sysadminsmedia/homebox)) bringt zusätzlich mit:

- **Offline-Modus**: Inventar durchsuchen, Boxen und Inhalte ansehen, QR-Etiketten scannen und neue Artikel samt Fotos anlegen, auch ohne Netz. Was offline angelegt wurde, wird automatisch hochgeladen, sobald wieder Netz da ist.
- **Verliehen**: an wen, seit wann, zurück bis wann. Mit Badge auf jedem Artikel, Übersicht auf der Startseite und Markierung von Überfälligem.
- **Verschlüsseltes Backup nach OneDrive**: jede Nacht automatisch, mit Restore per Befehl.
- **Liquid-Glass-Design** im Stil von iOS, hell, dunkel oder automatisch passend zum iPhone. Auswahl unter **Profil → Theme**. Wer bisher Homebox genutzt hat, behält zunächst sein altes Theme und muss einmal umstellen.
- **Schnelle Statistiken** auf der Startseite lassen sich per Tipp auf die Überschrift einklappen.

---

## 1. Images bauen lassen (einmalig)

Die Images baut GitHub für dich. Auf deiner VM musst du nichts kompilieren.

1. Im Fork **github.com/Sv3n168/homebox** öffnest du **Actions** und klickst auf „I understand my workflows, go ahead and enable them“.
2. Links den Workflow **„Custom images“** wählen, dann **Run workflow** auf `main`. Danach baut er bei jedem Push auf `main` automatisch neu.
3. Die anderen, von Homebox übernommenen Workflows („Docker publish …“, „Binaries Publish“ …) sind für das Original gedacht. Sie schlagen im Fork fehl. Öffne jeden davon und wähle **… → Disable workflow**.
4. Nach dem ersten Lauf erscheinen unter **Profil → Packages** die Pakete `homebox` und `homebox-backup`. Bei beiden **Package settings → Change visibility → Public** einstellen. Dann braucht Portainer keine Zugangsdaten. Der Code ist ohnehin öffentlich (AGPL).

## 2. Stack in Portainer

**Vorher unbedingt eine Sicherung deiner bisherigen Homebox-Daten machen**, z. B. in Homebox selbst über *Sammlung → Werkzeuge → Export* oder als Snapshot der VM in Proxmox.

1. Portainer öffnen, **Stacks → Add stack**, Name `homebox`.
2. **Build method: Repository**
   - Repository URL: `https://github.com/Sv3n168/homebox`
   - Reference: `refs/heads/main`
   - Compose path: `deploy/docker-compose.yml`
   - Optional „GitOps updates“ aktivieren, damit Portainer Änderungen selbst holt.
3. **Environment variables → Advanced mode** und den Inhalt von [`stack.env.example`](stack.env.example) einfügen und ausfüllen:
   - `HBOX_AUTH_API_KEY_PEPPER`: **derselbe Wert wie in deinem bisherigen Homebox-Stack**, falls du dort einen gesetzt hattest. Sonst einen neuen zufälligen Wert (`openssl rand -hex 32`).
   - `HOMEBOX_DATA_VOLUME`: **der Name des bisherigen Daten-Volumes** (Portainer → Volumes, z. B. `homebox_homebox-data`). So übernimmt der neue Stack deine vorhandenen Daten. Hattest du statt eines Volumes einen Ordner eingebunden (`/pfad:/data`), ersetze in `docker-compose.yml` bei beiden Diensten `homebox-data:/data` durch diesen Pfad.
   - `BACKUP_PASSWORD` und `BACKUP_SALT`: zwei lange, zufällige Passphrasen. **Speichere beide sofort im Passwortmanager.** Ohne sie lässt sich kein Backup wiederherstellen, auch nicht von dir.
4. Den **alten Homebox-Stack stoppen** (nicht löschen, das Volume wird weiterverwendet) und den neuen Stack mit **Deploy the stack** starten.

Beim ersten Start passt Homebox die Datenbank automatisch an. Es kommen nur die neuen Spalten für „Verliehen“ hinzu, bestehende Daten bleiben unverändert.

### cloudflared

Homebox ist wie bisher auf Port `3100` der VM erreichbar. Zeigt dein Tunnel schon auf `http://<VM-IP>:3100`, ändert sich nichts.

Hängt dein cloudflared-Container stattdessen in einem eigenen Docker-Netzwerk, kannst du Homebox dort direkt einhängen und den Port weglassen. Dafür in `docker-compose.yml`:

```yaml
services:
  homebox:
    networks: [default, cloudflared]
    # ports: entfernen
networks:
  cloudflared:
    external: true   # Name des Netzwerks, in dem cloudflared hängt
```

Im Tunnel ist das Ziel dann `http://homebox:7745`.

## 3. Auf dem iPhone einrichten (Offline-Modus)

1. Homebox in **Safari** über die Tunnel-Adresse (https://…) öffnen.
2. Beim Anmelden **„Angemeldet bleiben“** anhaken. Sonst läuft die Sitzung ab und du müsstest dich im Keller neu anmelden, was ohne Netz nicht geht.
3. **Teilen → Zum Home-Bildschirm**. Ab jetzt Homebox **immer über dieses Icon** öffnen.
4. Einmal mit Netz öffnen und warten, bis das Wolken-Symbol oben rechts einen Haken zeigt. Ein Tipp darauf zeigt Fortschritt, Anzahl der offline verfügbaren Einträge und den Stand. Danach hält sich die Kopie bei jedem Öffnen mit Netz automatisch aktuell.

**Im Keller:** App über das Icon öffnen. Oben erscheint ein orangefarbener Hinweis „Offline – du siehst die gespeicherte Kopie“. Du kannst stöbern, suchen, Boxen öffnen und neue Artikel anlegen, auch mit Fotos. Neue Artikel tragen das Badge **„Nicht synchronisiert“**, bis sie hochgeladen sind. Das passiert automatisch, sobald wieder Netz da ist. Die Zahl am Wolken-Symbol zeigt, wie viel noch wartet.

**QR-Codes:** Scanne mit dem **Scanner-Knopf in der Homebox-App** (Symbol neben der Suche), **nicht mit der Kamera-App**. Die Kamera-App öffnet Links in Safari. Safari hat auf dem iPhone einen eigenen Speicher, getrennt von der Home-Bildschirm-App, und kennt die Offline-Kopie nicht. Der Scanner in der App öffnet die Box direkt, auch offline.

**Was offline nicht geht:** Bestehende Artikel bearbeiten, verschieben, verleihen oder löschen. Diese Aktionen sind ohne Netz gesperrt (mit Hinweis), damit sich keine widersprüchlichen Änderungen aufstauen. Fotos werden für alle Artikel als Vorschaubild offline gespeichert, Originalbilder und PDFs nur, wenn du sie einmal online geöffnet hast.

Android (Chrome) funktioniert genauso: Menü **⋮ → App installieren**.

## 4. Backup nach OneDrive einrichten (einmalig)

Die Backups werden **auf deiner VM verschlüsselt**, bevor sie hochgeladen werden. In OneDrive liegen nur unlesbare Dateien mit verschlüsselten Namen. Microsoft kann also weder die Inhalte noch die Dateinamen lesen. Gesichert wird alles: die Datenbank (als konsistente Kopie im laufenden Betrieb), alle Fotos und alle Anhänge.

### OneDrive verbinden

Dazu brauchst du kurz einen PC mit Browser.

1. **Am PC:** rclone von https://rclone.org/downloads/ laden und entpacken. Im Ordner ein Terminal öffnen und ausführen:
   ```
   rclone authorize "onedrive"
   ```
   Im Browser mit deinem Microsoft-Konto anmelden. Das Terminal gibt danach einen Text aus, der mit `{"access_token":` beginnt. Den **ganzen** Text kopieren.
2. **In Portainer:** Containers → `homebox-backup` → **Console** → Command `/bin/bash` → Connect, dann:
   ```
   rclone config
   ```
   - `n` (new remote), Name: **`onedrive`**
   - Storage: `onedrive` eintippen
   - `client_id`, `client_secret`: Enter (leer lassen)
   - region: `1` (Microsoft Cloud Global)
   - Advanced config: `n`
   - „Use web browser to automatically authenticate?“: **`n`**
   - Bei `config_token>` den kopierten Text vom PC einfügen
   - Typ: `1` (OneDrive Personal or Business), dann dein Laufwerk auswählen und mit `y` bestätigen
   - `q` zum Beenden
3. In derselben Konsole prüfen und das erste Backup sofort machen:
   ```
   hb-backup check
   hb-backup backup
   hb-backup verify latest
   ```
   `verify` lädt das Backup herunter, entschlüsselt es und prüft die Datenbank, ohne etwas zu verändern.

Danach läuft das Backup **jede Nacht um 3:30 Uhr** (`BACKUP_SCHEDULE`). Behalten werden die Backups der letzten 60 Tage, mindestens aber die letzten 10. Auf der VM liegen zusätzlich die letzten 3 für einen schnellen Restore. Die Protokolle siehst du in Portainer unter **Containers → homebox-backup → Logs**.

Wenn du gewarnt werden willst, falls die Backups ausbleiben: kostenlos auf https://healthchecks.io einen Check anlegen (Zeitraum 1 Tag) und dessen URL als `BACKUP_HEALTHCHECK_URL` eintragen.

## 5. Wiederherstellen

**Aus einem Backup zurückspielen:**

1. Portainer: Container **`homebox` stoppen**.
2. Containers → `homebox-backup` → Console (`/bin/bash`):
   ```
   hb-backup list                  # alle Backups anzeigen
   hb-backup restore latest --yes  # oder: hb-backup restore homebox-20261013-013000.tar.gz --yes
   ```
3. Container **`homebox` starten**.

Die bisherigen Daten werden nicht gelöscht. Sie landen in `/data/.pre-restore-<Zeitpunkt>` im Volume und können gelöscht werden, wenn alles passt. Läuft Homebox noch, verweigert der Restore den Start.

**Wenn die VM komplett weg ist:** Neue VM aufsetzen, Stack wie in Abschnitt 2 anlegen, mit **denselben** `BACKUP_PASSWORD` und `BACKUP_SALT` aus dem Passwortmanager. OneDrive wie in Abschnitt 4 verbinden. Dann wie oben `homebox` stoppen, `hb-backup restore latest --yes` ausführen und `homebox` wieder starten.

## 6. Updates vom Original übernehmen

Die eigenen Änderungen liegen in deinem Fork. Neue Versionen des Originals holst du so:

- Auf GitHub im Fork: **Sync fork → Update branch**. Bei Konflikten meldet GitHub das, dann am besten Claude bitten, den Merge zu machen.
- Danach baut „Custom images“ automatisch neue Images, und Portainer zieht sie per **Pull and redeploy** (oder automatisch mit GitOps).

Vor größeren Updates: einmal `hb-backup backup` ausführen.
