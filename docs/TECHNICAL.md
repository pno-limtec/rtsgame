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

- Die Höhen entstehen aus einem signierten 3D-Dichtefeld im Stil von
  `EthanHermsey/nature`/Volumetric-terrain: Die bisherige 2D-Formel liefert nur noch die
  Zieloberfläche, anschließend wird die sichtbare Höhe als Zero-Crossing der Dichtefunktion
  extrahiert. Damit bleibt das serverautoritative Heightmap-Modell für Wasser, Pathfinding,
  Terraforming und Snapshots kompatibel, aber die Topografie wird nicht mehr direkt als
  hartes Zellraster aus Noise-Werten gesetzt.
- Grundrauschen und Ridged-Noise speisen dieses Volumenfeld und erzeugen Hügelland und Grate.
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
- Senken werden über die Wasseroberfläche behandelt: Wasser bleibt in einer Mulde stehen und
  nivelliert sich dort, bis der Spiegel die niedrigste Schwelle erreicht; erst dann läuft es in
  die nächste tiefere Ebene.
- `baseWater` beschreibt den Normalzustand von Meer, Flüssen und Seen.
- `waterActive` enthält nur instabile Zellen plus Nachbarn; ruhige Zellen werden nicht jedes Mal
  gerechnet.
- `waterBlock` sperrt Fluss an Dämmen, Deichen und Wasserbauwerken.
- Regen, Sturm, Schnee, Schneeschmelze, Seen und Quellen speisen Wasser ein. Regentropfen werden
  lokal einige Zellen talwärts zur niedrigsten erreichbaren Oberfläche geroutet; dadurch füllen
  sich normale Senken auch ohne vordefiniertes See-/Tal-Maskenfeld.
- Trockene Phasen senken Flüsse und lassen Pfützen/Spuren schneller austrocknen.
- Das Meer und der Kartenrand wirken als Auslass.
- Starkes Wasser erzeugt Strömungsvektoren, zieht Einheiten mit und verursacht Washout-Events.
- Bei angestautem Wasser kann Land langsam erodieren; Höhenänderungen wecken benachbarte
  Wasserzellen erneut.
- **Flutdeckel:** Höchstens ~`FLOOD_CAP_FRAC` (12 %) der Karte dürfen über dem Normalpegel
  geflutet sein (Messung alle 3 Wasser-Schritte). Wird der Wert überschritten, stoppt jeder
  weitere Zufluss (Regen, Schmelze, Quellen, See-/Tal-Zugewinn) und flach überflutetes Land mit
  Abflussmöglichkeit versickert beschleunigt (`FLOOD_CAP_DRAIN`). Hinter Dämmen impoundiertes
  Wasser ohne Gefälle bleibt davon unberührt — Aufstauen ist gewolltes Spielelement.
- **Schnee bleibt trocken:** Schmelzwasser sammelt sich nie auf der Schneedecke. Eine
  Kaskaden-Drainage am Ende jedes Wasser-Schritts leitet jegliches Wasser von Schneezellen (von
  hoch nach tief) zum Schneerand hinab und von dort als normaler Fluss ins Tal. Die Kappe zieht
  sich bei Sonne vom Rand nach innen zurück (Zentrum schmilzt zuletzt); Regen lässt sie wachsen.
  Die Schneegrenze (`SNOW_LINE`) liegt knapp unter dem Gipfel (MAX_HEIGHT≈1.68), sodass nur die
  echte Gipfelkappe (~5 % der Karte) verschneit ist — kein flächiger Schnee über das halbe Land.
- **Entwässerungsfurchen:** `terrain.js` kerbt neben den Hauptflüssen viele radiale Trockenrinnen
  (Canyons/Furchen) von der Bergschulter bis ins Meer. Sie führen normalerweise kein Wasser,
  geben Regen-/Schmelz-/Flutwasser aber einen klaren Weg zum Meer.
- **Küstenglättung:** Nach der Generierung wird das Gelände unterhalb der Wasserlinie mehrfach
  geglättet (`smoothBelow`), damit keine zerklüfteten Unterwasser-Rippen durch die flache
  Wasserfläche stoßen (sonst entsteht ein „Labyrinth"-Look statt einer homogenen Fläche).

**Permanente Flüsse:** Jede Karte hat genau zwei breite Hauptflüsse (`WATER_SOURCES`). Ihre Quellen speisen
in jedem Wasser-Schritt — auch bei Flut-Deckel und Trockenheit (gedrosselt, aber nie null) —,
sodass die Flüsse nie versiegen und dauerhaft zum Meer entwässern. In der Trockenphase trägt
`dryRiverBeds` nur den Überschuss über dem Grundpegel (`baseWater` entlang der Rinne) ab; die
Flussbetten bleiben also wasserführend, werden nur schmaler.

Der Client rendert das Wasser nicht als einzelne Kacheln. Stattdessen baut `client/js/renderer.js`
ein zusammenhängendes Wasser-Oberflächenmesh. Vertex-Attribute beschreiben Tiefe, Nässe,
Meer/Binnenwasser (`aSea`), Flussrichtung (`aFlow`) und Wellenamplitude (`aAmp`). Der Shader
(`makeWaterMaterial`, eigenständige Umsetzung im Stil
stilisierter Wasser-Shader) gibt **Meer und Seen** Leben: der Vertex-Shader hebt die Fläche mit
zwei gekreuzten Wellenzügen (geometrische Dünung) an, der Fragment-Shader legt pro Pixel ein
feines, bewegtes Wellenrelief aus mehreren gescrollten Sinus-Oktaven darüber (eigene
`rippleGrad`-Funktion → analytische Normale). Daraus entstehen **Fresnel-Himmelspiegelung** entlang
der reflektierten Blickrichtung (`skyColor`-Verlauf), **Sonnen-Glitzern** (Blinn-Phong, `uSunDir`)
und **Schaumkronen** auf den Wellenspitzen. Flüsse nutzen die echten Strömungsvektoren aus der
Simulation für langgezogene Schlieren und Stromschnellen statt punktigem Rauschen; das Meer
bekommt breite wandernde Bänder und eine dezente Wolkenspiegelung. Dazu kommen tiefenabhängige
Farbe (flach türkis → tief marineblau) sowie Tag/Nacht-, Sturm- und Nebel-Tönung. `aAmp` steuert
die Stärke: Meer voll, Seen sanft, flache Flüsse/Flutfilme = 0. Shadertoy-artiges Vollbild-
Raymarching wird bewusst vermieden, weil es die Terrain-/Flussdaten nicht kennt und pro Pixel
deutlich teurer wäre.

Das Ripple-Relief ist ZWEISTUFIG (`g1` grob + `g2` feiner, doppelte Frequenz) und IMMER aktiv
(nicht an `vCrest`/Wellenhöhe gekoppelt) — so verschwinden auch bei ruhigem, flachem Wasser die
Low-Poly-Facetten des Meshs, die das Wasser sonst „flach/plattig" wirken lassen. Das Wasser ist
**leicht transparent**: die Deckkraft steigt mit der Tiefe (`alpha = mix(0.58, 0.90, depthF)`,
Fresnel + Schaum erhöhen sie zusätzlich) → flaches Wasser lässt den Grund durchscheinen, tiefes
Wasser ist dichter; „leicht" heißt Mindestdeckkraft ~0.58, nicht durchsichtig-trüb. Ein konstanter
Himmel-Ambient-Term (`col += sky * …`) hebt auch senkrecht von oben betrachtetes Wasser an, damit
tiefes Wasser nicht flach-dunkel/„murky" wirkt.

Gegen das „Labyrinth"/Ausfransen aus halbnassen Zellen kombiniert der Renderer drei Maßnahmen:
(1) Binnenwasser wird erst ab echter Tiefe gezeigt (über `WET_DEPTH`, Hysterese SHOW/HIDE +
Mindestzahl nasser Nachbarn) — dünne Feuchtefilme werden gar nicht gezeichnet; (2) die
Wasseroberfläche wird über einen 5×5-Bereich gaußartig geglättet (`_smoothedWaterSurface`) → ein
Fluss/See wird zu einer durchgehenden, schräg verlaufenden Fläche statt einer Zell-Treppe;
(3) isolierte nasse Einzelzellen werden über `_neighborWetFactor` ausgeblendet, zusammenhängendes
Wasser (auch ein 1 Zelle breiter Fluss) bleibt voll. Das offene Meer ist von (1)/(3) ausgenommen.
Schmelzwasser-Runoff wird besonders zurückhaltend visualisiert: dünne Bergabflüsse erscheinen
höchstens als dunklere Feuchte, während sichtbare Wasserflächen vor allem dort entstehen, wo sich
Wasser in Senken staut oder aus einem Gewässer überläuft.

**Kein Gras↔Wasser-Flimmern:** Wasser- und Geländemesh teilen dasselbe xz-Gitter UND dieselbe
Triangulierung. Damit gilt: liegt jeder Wasservertex über seiner Geländespalte um mindestens
`CLEAR` (= 0.14 Welt-Einheiten), dann liegt — wegen linearer Interpolation über jedes gemeinsame
Dreieck — die gesamte gezeichnete Wasserfläche überall ≥ `CLEAR` über dem Boden, inklusive der
Übergangsdreiecke an der Uferlinie. Deshalb nutzen NASSE *und* TROCKENE Vertices denselben
Mindestabstand: nasse auf `max(geglättete_Oberfläche − 0.045, terrainY + CLEAR)`, trockene exakt
auf `terrainY + CLEAR` (nur unsichtbar via `vWet=0`/Shader-discard). Der Wellenhub wird zusätzlich
durch den Spitzenwert ~1.8 geteilt (`headroom = (surf − terrainY − 0.04) / 1.8`), damit auch ein
Wellental in flachem Wasser nicht unter das Terrain taucht. Verifiziert: über alle gezeichneten
Vertices bleibt der Abstand zum Boden selbst im tiefsten Wellental ≥ 0.14, 0 Vertices darunter →
keine koinzidenten Tiefen → kein Z-Fighting/Flimmern.

WICHTIG (frühere Fehlannahme): ein bloßes „kein Vertex unter dem Terrain" reicht NICHT. Trockene
Randvertices knapp über dem Boden (z. B. `+0.02`) erzeugen ein schmales Übergangsband, dessen
Wasseroberfläche fast deckungsgleich mit dem Gelände ist → genau dort flimmert es. Der Mindest-
abstand muss für ALLE gezeichneten Dreiecke gelten, nicht nur „nicht negativ" sein.

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
- Wälle/Gräben/Straßen/Leitungen/Dämme werden per Linie (Start→Endpunkt) gezogen und dürfen
  beliebig schräg verlaufen. Pipes richten sich im Renderer (`_orientPipe`) an ihren Nachbarn
  aus und wirken so als durchgehende — auch diagonale — Leitung statt als lose Einzelstücke.
- Erdaushub aus Gräben/Abgrabungen sammelt sich an EINEM Erdhaufen je Arbeitsbereich; LKW
  fahren ihn zum Materiallager. Erdhaufen haben kein Licht/Fundament.

### Tunnel (`shared/systems/tunnel.js`)

Ein Tunnel ist EINE verknüpfte Struktur (nicht N Einzelgebäude): er wird wie eine Straße per Linie
gezogen, ist aber deutlich teurer (Kosten je Tile, `TUNNEL_COST_ORE/MAT`). Der Client sendet einen
einzigen Befehl `{type:'tunnel', sx,sy,ex,ey}`; `placeTunnel` validiert über `validateTunnel`:
**beide Enden müssen an einem Hang liegen** (Land/Hügel, das orthogonal an eine Klippe grenzt), das
Innere muss eine Klippe/einen Hügel durchqueren, Länge ≤ `TUNNEL_MAX_LEN`. Es entstehen zwei
zerstörbare **Mündungsgebäude** (kind `tunnel`, je eigene HP), die wie Brücken von Baggern gebaut
werden. Sind BEIDE fertig, stempelt `activateTunnelIfReady` die Innen-Tiles begehbar (`t.tunnel`),
und die Röhre ist offen für **Land, Fahrzeuge UND Wasser** (`isPassable` lässt die water-Domäne durch
Tunnel; die Wasser-Fluidsimulation fließt über `stepTunnelWater` zwischen den Mündungen entlang des
Oberflächengefälles). Einheiten auf Innen-Tiles gelten als `inTunnel`: sie sind **verborgen** (Client
zeichnet nur einen Umriss-Geist), nicht anvisierbar und ohne Separation — sie verschwinden in einer
Mündung und tauchen an der anderen wieder auf. **Zerstörung:** eine zerstörte Mündung versiegelt nur
dieses Ende (das angrenzende Innen-Tile wird entstempelt — Einheiten darin nutzen den intakten
Ausgang); sind BEIDE Mündungen zerstört, **kollabiert** der Tunnel (Innen-Tiles wieder unpassierbar,
alle Einheiten darin sterben). Der Zustand lebt in `world.tunnels` (+ `world.tunnelTiles`-Map) und ist
Teil der deterministischen Simulation; der Renderer zeichnet die durchgehende Röhre als ein
`_makeRibbonGeometry`-Mesh. Die KI baut Tunnel gezielt, wenn ihre Route an einem Klippen-Riegel
scheitert (`planTunnelOverRidge`).

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
