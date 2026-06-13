# Iron Frontier — technische Dokumentation

Diese Datei beschreibt, wie die wichtigsten Systeme technisch funktionieren und wo der Code
liegt. Sie ist als Arbeitsreferenz gedacht: Einstieg oben, Details nach Systemen.

## Laufzeit und Start

- Das Projekt ist ein browserbasiertes RTS mit Node.js-Server und Three.js-Client.
- Es nutzt ES-Module (`"type": "module"`) und wird mit `pnpm` betrieben.
- Start: `pnpm install`, danach `pnpm run server`.
- Der Server liefert den Client statisch aus und öffnet WebSocket-Verbindungen auf demselben
  HTTP-Server. Standard-Port ist `8080`, überschreibbar mit `PORT=...`.
- Mehr Spielerslots: `SLOTS=4 pnpm run server`.

Wichtige Einstiegspunkte:

| Pfad | Aufgabe |
|---|---|
| `server/index.js` | HTTP-Server, statische Dateien, WebSocket-Protokoll |
| `server/match.js` | Transport-unabhängiger Match-Manager |
| `server/snapshot.js` | Init- und Snapshot-Serialisierung |
| `shared/sim.js` | deterministischer Tick-Orchestrator |
| `shared/world.js` | Weltaufbau, Entitäten, Platzierung, Kosten |
| `shared/terrain.js` | Heightmap, Tile-Typen, Rohstoff-/Wasser-Layer |
| `shared/systems/*` | einzelne Simulationssysteme |
| `shared/ai/ai.js` | KI-Entscheidungen |
| `client/js/main.js` | Client-Bootstrap |
| `client/js/renderer.js` | Three.js-Szene, Effekte, Mesh-Updates |
| `client/js/ui.js` | Lobby, HUD, Bauleiste, Menü, Tech-Tree |
| `client/js/input.js` | Auswahl, Befehle, Kamera |
| `data/*.json` | datengetriebenes Balancing |

## Simulationsmodell

Die Simulation ist server-autoritativ und läuft in festen Ticks:

1. Clients senden Befehle wie `move`, `attack`, `build`, `produce`.
2. `server/index.js` übergibt diese an `Match.command`.
3. `shared/sim.js` reiht sie in `world.cmdQueue` ein und verarbeitet sie am Tickrand.
4. Danach laufen KI und Systeme in fester Reihenfolge.
5. `server/snapshot.js` serialisiert den neuen Zustand.
6. Clients interpolieren/visualisieren die Snapshots, verändern aber nie den verbindlichen Zustand.

Die Tick-Reihenfolge in `shared/sim.js` ist absichtlich stabil: Environment, Economy,
Production, Water, Air, Movement, Recovery, Construction, Roads, Transport, Sonar, Garrison,
Combat, Regeneration. Dadurch bleiben Headless-Tests reproduzierbar.

## Datengetriebenes Balancing

Einheiten, Gebäude, Waffen, Ressourcen, Fraktionen und Veteranenstufen liegen in `data/*.json`.
`shared/data-node.js` lädt die Daten serverseitig; der Client bekommt sie über `/data`.

Die Simulation liest Definitionen aus `world.data`. Beispiele:

- `data/units.json`: HP, Geschwindigkeit, Domain, Waffen, Produktion.
- `data/buildings.json`: Größe, Kosten, Produktion, Pipeline-/Depot-Rollen.
- `data/weapons.json`: Reichweite, Schaden, Projektiltyp, Ziel-Domains.
- `data/factions.json`: Kosten-, HP-, Schaden- und Baugeschwindigkeitsmodifikatoren.
- `data/resources.json`: Ressourcennamen und Kapazitätslogik.

Kosten werden nicht hart verdrahtet, sondern über `effectiveCost` und Fraktionsmodifikatoren in
`shared/world.js` berechnet.

## Netzwerk und Snapshots

Beim Beitritt sendet der Server ein vollständiges `init`-Paket:

- Kartengröße, Heightmap, Tile-Typen.
- statische und initiale Wasser-/Öl-/Erz-/Schnee-/Straßenlayer.
- Spielerzustand und direkt anschließend ein vollständiger Snapshot.

Danach sendet der Server Snapshots:

- Entitäten als kompakte Arrays mit Kind-IDs.
- Projektile.
- dynamische Terrain-Deltas (`water`, `terra`, `ground`, `snow`, `roads`, `oil`).
- Umweltstatus (`env`) und Spielerressourcen.
- Events wie Treffer, Tod, Lawine, Washout, Industry-FX.

`server/snapshot.js` spart Bandbreite, indem große Layer nur als Deltas übertragen werden:
Wasser nur bei Abweichung von `baseWater`, Öl nur bei geänderten Feldern, Straßen nur wenn
`roadDirty` gesetzt ist.

## Terrain-Generierung

`shared/terrain.js` erzeugt die Karte deterministisch aus einem Seed:

- Grundrauschen und Ridged-Noise erzeugen Hügelland und Grate.
- Ein hohes Zentralmassiv entsteht aus Gipfel, Schulter, Fuß, Graten und Rinnen.
- Zum Rand fällt das Gelände zuverlässig ins Meer ab.
- Kleine Hochplateaus außerhalb der Mitte werden als abgeflachte erhöhte Ellipsen eingearbeitet.
- Flüsse folgen vom Berg aus dem steilsten Abstieg und mäandern leicht.
- Hochseen, Trockentäler, Brücken/Furten, Klippen, Tunnel und Startterrassen werden in Layern
  ergänzt.
- Öl, Erz, Wald, Felsen, Gras, Tiere und Küsten-/Meeresdetails werden als zusätzliche Masken
  oder Client-Naturinstanzen abgeleitet.

Tile-Typen (`TT`) sind `LAND`, `HILL`, `CLIFF`, `WATER`, `BRIDGE`. Steigung und Höhe bestimmen
später Bewegung, Sicht, Deckung und Bauplatzregeln.

## Wasser-Simulation

`shared/systems/water.js` modelliert Wasser als Tiefe pro Zelle (`terrain.water[i]`).
Die Oberfläche ist `terrain.height[i] + terrain.water[i]`.

Technische Eckpunkte:

- 8-Nachbar-Zellularautomat: Wasser fließt entlang des stärksten Oberflächengefälles.
- `baseWater` beschreibt den Normalzustand von Meer, Flüssen und Seen.
- `waterActive` enthält nur instabile Zellen plus Nachbarn; ruhige Zellen werden nicht jedes Mal
  gerechnet.
- `waterBlock` sperrt Fluss an Dämmen, Deichen und Wasserbauwerken.
- Regen, Sturm, Schnee, Schneeschmelze, Seen und Quellen speisen Wasser ein.
- Trockene Phasen senken Flüsse und lassen Pfützen/Spuren schneller austrocknen.
- Das Meer und der Kartenrand wirken als Auslass.
- Starkes Wasser erzeugt Strömungsvektoren, zieht Einheiten mit und verursacht Washout-Events.
- Bei angestautem Wasser kann Land langsam erodieren; Höhenänderungen wecken benachbarte
  Wasserzellen erneut.

Der Client rendert das Wasser nicht als einzelne Kacheln. Stattdessen baut `client/js/renderer.js`
ein zusammenhängendes Wasser-Oberflächenmesh. Vertex-Attribute beschreiben Tiefe, Nässe,
Wellengang und Flussrichtung. Der Shader ist fast opak, färbt tiefes Wasser dunkler, zeigt
Stromschnellen bei starkem Fluss und mischt eine kleine prozedurale Wolkenspiegelung ein.

## Ressourcen und Industrie

`shared/systems/economy.js` verwaltet Energie, Rohstoffe, Pipelines und Logistik.

- Erz ist die direkte Bau-/Produktionswährung.
- Bagger/Radlader bauen Erz ab und legen Erzhaufen an.
- LKW holen Erz- und Erdhaufen ab und kippen sie an passenden Lagern ab.
- Ölbohrtürme pumpen Öl aus schwarzen Ölfeldern; die Flecken werden beim Abbau kleiner.
- Öl und Wasser werden nicht per LKW transportiert. Produzenten brauchen eine Leitungskette zu
  Öldepot bzw. Wasserturm.
- Ölkraftwerke verbrauchen Treibstoff und Kühlwasser; ohne eines davon fällt die Leistung.
- Solarfelder hängen von Tageslicht und Wetter ab.
- Bei Stromdefizit werden große Verbraucher zuerst abgeworfen; Produktion und Lichter fallen aus.

Die Pipeline-Konnektivität wird günstig in Intervallen geprüft: Produzent -> nahe Pipe ->
Pipe-Kette -> Depot.

## Bau, Terraforming und Infrastruktur

`shared/systems/construction.js` verwaltet Baustellen, Terraforming und Haufenlogistik.

- Gebäude entstehen nicht sofort: Bagger/Radlader fahren zur Baustelle und arbeiten sie ab.
- Fußsoldaten sind Kampfeinheiten; nur passende Bau-/Arbeitsfahrzeuge bauen Gebäude.
- Terraforming wird als geplante Zielhöhe gespeichert. Der Client zeigt den veränderten
  Untergrund direkt als blaue Vorschau, bis der Bagger die Arbeit umgesetzt hat.
- Wälle, Dämme, Gräben, Straßen, Brücken, Tunnel, Pipes und Gebäude beeinflussen Terrain,
  Pathfinding, Wasserfluss oder Ressourcenketten.
- Straßen können manuell gebaut werden; zusätzlich erzeugt `shared/systems/roads.js` ein
  automatisches Netz zwischen nahen Gebäuden.

## Bewegung und Pfadfindung

`shared/pathfinding.js` arbeitet auf dem Tile-Grid. Die Bewegungssysteme unterscheiden Domains:

- Land: Gelände, Steigung, Wasser, Matsch, Wald, Straßen, Brücken, Klippen.
- Wasser: Wasserflächen, Meer/Flüsse/Seen, Brücken darunter.
- Luft: direkte Bewegung, aber eigene Auswahl-/Höhenlogik und Wetterrisiken.

Fahrzeuge drehen erst zur Zielrichtung und fahren dann vorwärts. Spuren, Matsch und Pfützen
werden in Terrain-Layern geschrieben und an den Client übertragen.

## Kampf, Sicht und Spezialrollen

`shared/systems/combat.js` sucht Ziele über einen Spatial Hash und nutzt Waffenwirksamkeit,
Reichweite, Sicht, Veteranenboni und Ziel-Domains. Weitere Systeme ergänzen Speziallogik:

- `air.js`: Munition/Treibstoff, Rückkehr zur Luftbasis.
- `sonar.js`: U-Boot-/Unterwasserdrohnen-Erkennung.
- `transport.js`: Ein-/Ausladen von Truppen in Luft- und Wassertransportern.
- `garrison.js`: Gräben als Garnison/Deckung.
- `veterancy.js`: XP, Rangboni, Regeneration.

Unterwasserdrohnen sind für Gegner erst sichtbar, wenn Sonar/Nähe/Feuerereignisse sie verraten.

## KI

`shared/ai/ai.js` steuert Wirtschaftsaufbau, Tech, Produktion, Angriffswellen, Reparatur,
Befestigungen, Brücken, Pipelines und Mehrdomänen-Nutzung. Die KI läuft in derselben Simulation
wie Menschen und wird auch für Tests genutzt.

Im Zuschauermodus können KI-only-Matches beschleunigt werden. `server/match.js` begrenzt die
Tempoauswahl auf feste Stufen und erlaubt Tag/Nacht/Auto nur, wenn keine menschlichen Spieler
aktiv sind.

## Client-Rendering

`client/js/renderer.js` verwaltet die Three.js-Szene:

- Terrain als PlaneGeometry mit Heightmap und Vertex-Farben.
- Wasser als eigenes Mesh mit Shader-Uniforms für Zeit, Wetter, Tag/Nacht und Wolkenreflexion.
- Öl als instanzierte glänzende, schwarze Overlays plus dunkle Terrain-Vertex-Färbung.
- Schnee als Vertex-Farb-Mischung und separater Layer aus Snapshot-Daten.
- Straßen, Spuren, Matsch, Erz-/Erdhaufen und Terraforming-Vorschau als Instanced Meshes.
- Gebäude- und Einheitenmodelle aus GLB, mit prozeduralen Fallbacks.
- Partikel/Fakkeln/Rauch/Feuer/Regen/Schnee/Trümmer werden nach Qualitäts- und Zoomlevel
  gedrosselt.
- Dynamische Schatten sind bewusst begrenzt: nachts werfen nur Fahrzeugscheinwerfer Schatten,
  statische Sonne/Fahrzeuge werden mit separaten Refresh-Raten aktualisiert.

`client/js/textures.js` erzeugt prozedurale Canvas-Texturen: Boden, Gras, Metallpanel, Rauch,
Öl und Wolkenspiegelung. Dadurch braucht das Spiel keine externen Bilddownloads.

## UI, Menü und Saves

`client/js/ui.js` baut Lobby, HUD, Baumenü, Produktionsleiste, Ressourcenanzeige, Zuschauer-
Controls, Hauptmenü und Tech-Tree.

Savegames werden über `server/savegame.js` serialisiert. Das Menü kann:

- neues Spiel starten,
- neues Spiel mit gleicher Karte starten,
- Spielstand als JSON herunterladen,
- Spielstand laden,
- Grafikeinstellungen ändern,
- den visuellen Tech-Tree öffnen.

## Tests

Die wichtigsten lokalen Checks:

```bash
pnpm test
pnpm run ai-coverage
pnpm run smoke
pnpm run balance
```

- `pnpm test` simuliert ein KI-vs-KI-Match und misst Performance.
- `pnpm run ai-coverage` lässt KI-Spieler so lange laufen, bis jede Einheit und jedes Gebäude
  mindestens einmal vorkam.
- `pnpm run smoke` prüft Server-Kernlogik, Reconnect, KI-Übernahme und Spezialregressionen.
- `pnpm run balance` prüft Datenkonsistenz und grobe Winrate-Heuristiken.

Für visuelle Änderungen zusätzlich lokal `pnpm run server` starten und im Browser prüfen. Der
Client sollte ohne Konsolenfehler laden; bei 3D-/Shader-Änderungen ist ein Screenshot- oder
Canvas-Pixelcheck sinnvoll.

## Lokale Artefakte und Git

Nicht versioniert werden:

- `node_modules/`
- `.playwright-mcp/`
- `.claude/`
- Root-Screenshots und Root-Videos aus manuellen Checks
- Logdateien
- `package-lock.json` zugunsten von `pnpm-lock.yaml`

Versioniert werden Quellcode, Balancing-Daten, GLB-Assets, Dokumentation, Tests und
`pnpm-lock.yaml`.
