# Faultline Command — Browser-RTS

Ein eigenständiges, browserbasiertes Multiplayer-Echtzeitstrategiespiel (eigenes IP) im Geist
klassischer industrieller Tactical-RTS-Titel. Basisbau, mehrstufige Rohstoffwirtschaft,
Land-/Luft-/See-Einheiten, zerstörbares Gelände, KI-Gegner und nahtloser Multiplayer mit
Join-in-Progress und KI-Übernahme.

> **Keine geschützten Marken, Namen, Modelle, Sounds oder Designs Dritter.** Setting,
> Fraktionen, Einheiten und Assets sind eigenständig und prozedural erzeugt.

## Schnellstart

```bash
pnpm install         # installiert ws
pnpm run server      # Server + Client auf http://localhost:8080
```

Browser öffnen → Sitz wählen (freier Platz oder **KI übernehmen**) → *Match beitreten*.

Mehrere Sitze:  `SLOTS=4 pnpm run server`

## Steuerung

| Eingabe | Wirkung |
|---|---|
| Linksklick + Ziehen | Auswahlrahmen |
| Linksklick | Einzelauswahl |
| Rechtsklick | Bewegen / Angriff (auf Feind) |
| Shift + Rechtsklick | Angriffsbewegung |
| 1–9 | Kontrollgruppe wählen · Ctrl/Cmd+1–9 zuweisen |
| S | Stopp |
| WASD / Pfeile | Kamera · Mausrad: Zoom · Minimap-Klick: springen |
| Bauleiste rechts | Gebäude bauen · Produktionsgebäude auswählen → Einheiten |

## Tests

```bash
pnpm test            # headless KI-vs-KI-Match (Performance, Speicher, Sieger)
pnpm run ai-coverage # KI-vs-KI-Durchlauf: jedes Gebaeude und jede Einheit einmal
pnpm run smoke       # Server-Kernlogik: Join-in-Progress, KI-Übernahme, Reconnect
pnpm run balance     # Datenkonsistenz + Mehrfach-Seed-Win-Raten
```

`pnpm test [ticks] [spieler] [seed]` für gezielte Läufe, z. B. `pnpm test 15000 4 42`.
`pnpm run ai-coverage -- [ticks] [seed]` testet die komplette Tech-Abdeckung.

## Architektur

```
data/      Datengetriebenes Balancing (JSON): Einheiten, Gebäude, Waffen, Ressourcen, Fraktionen
shared/    Deterministische Simulation (Node + Browser, ohne Abhängigkeiten)
           sim.js · world.js · terrain.js · pathfinding.js · systems/* · ai/ai.js
server/    Autoritative Spiel-Loop + WebSocket (match.js transportfrei → testbar)
client/    Three.js-Rendering, CC0-3D-Modelle (glTF) + prozedurale Texturen + WebAudio-SFX, Eingabe, UI (Minimap, Bauleiste, HUD, Lobby)
           client/assets/models/ — heruntergeladene CC0-Modelle (Quellen in CREDITS.md), Fallback auf prozedurale Meshes
test/      Headless-Tests
```

Server-autoritatives Netzmodell mit festem 10-Hz-Tick: Clients senden nur Befehle, der Server
sendet Snapshots, der Client interpoliert. Dadurch sind **Join-in-Progress**, **KI-Übernahme**
und **Reconnect** strukturell trivial.

Technische Details: [docs/TECHNICAL.md](docs/TECHNICAL.md) · Konzept: [docs/CONCEPT.md](docs/CONCEPT.md) · Ausbauplan: [docs/ROADMAP.md](docs/ROADMAP.md)

## Neu in v0.3: Umwelt & Infrastruktur (Phase 14)

- **Tag/Nacht-Zyklus** (4 min/Tag): Sonne wandert, nachts leuchten Gebäudefenster. Beleuchtung
  kostet nachts **+25 % Gebäudestrom**, Fahrzeuge verbrauchen **+50 % Öl** (Scheinwerfer).
- **Wetter**: Regen lässt Pegel & Flüsse steigen (Senken fluten, nach dem Regen läuft es ab),
  **Gewitter** mit Blitzen, die bevorzugt **hochgelegene Objekte, Gebäude und Flugzeuge** treffen.
- **Erdbeben**: an steilen Hängen rutscht Material ab (echte Geländeverformung, kann Flüsse
  umleiten), Gebäude/Einheiten im Bebengebiet nehmen Schaden, Kamera bebt.
- **Fünf zentrale Ressourcen**: **Öl** (Treibstoff & Kraftwerke), **Wasser** (Kühlung der
  Ölkraftwerke; aus Pumpwerken & Regen), **Erz** (Bau- und Produktionswährung), **Erde** (Baumaterial aus Graben-/
  Tunnel-Aushub — Bauen hinterlässt Löcher in der Landschaft), **Sonne** (Solarfelder: nachts
  und bei Regen kein Ertrag).
- **Wasserleitungen** als strategisches Element: ferne Pumpwerke liefern nur über eine intakte
  Leitungskette — Leitungsbruch kappt die Kühlwasserversorgung.
- **Brücken** (Land über Wasser, Schiffe passieren darunter) und **Tunnel** (durch Klippen/Berge),
  beide zerstörbar → angreifbare Nachschublinien.
- **Schönerer Client**: detaillierte 3D-Modelle für alle Gebäude (Kühltürme, Bohrturm-Gitter,
  Kran, Solarpanels …), Schiffe schwimmen auf der Wasseroberfläche, Luftfahrzeuge schweben/bobben,
  weiche Drehinterpolation, Regen-/Blitz-/Beben-Effekte mit Sound, Tag/Nacht-Licht, schwebende
  UI-Panels statt schwarzer Leerbalken, Kamera an die Karte geklemmt + Ozean-Horizont.

## Neu in v0.4: Insel, Baufahrzeuge, Straßen, Lichter (Phase 15)

- **Insel-Karte**: zentraler **Schneeberg** (Schnee schmilzt bei Sonne → Schmelzwasser speist
  einen Fluss, der zu **zwei Seiten** Richtung Meer fließt), Karte vollständig **von Meer umgeben**,
  dazu **strategische Hochseen**, die man anstechen kann (Flutwelle). Flüsse lassen sich mit
  Staudamm, Wällen, Gräben und Terraforming umleiten/stauen. Neutrale Furten sichern die Landwege.
- **Baufahrzeuge**: Gebäude bauen sich nicht mehr von selbst — ein freies Baufahrzeug (oder ein
  Pionier) fährt zur Baustelle und errichtet sie nach und nach. **Terraforming ist jetzt intuitiv**:
  Aufschütten/Abgraben in der Bauleiste wählen, Zelle anklicken, ein freies Baufahrzeug übernimmt
  (Abgraben fördert Erde zutage).
- **Automatische Straßen** zwischen nahen Gebäuden. **Schwere Fahrzeuge** (Panzer, Artillerie,
  Harvester) sind auf Straßen schnell, **bleiben bei Regen im Gelände stecken** und **gehen im
  Wasser kaputt**. Fahrzeuge fahren physikalisch: erst drehen, dann beschleunigen — kein
  Seitwärtsgleiten mehr.
- **Strom-Lastabwurf**: Bei Energiedefizit fallen die größten Verbraucher zuerst aus —
  Produktion stoppt, **Lichter gehen aus**.
- **Lichter**: Alle Gebäude haben Hoflampen, die nachts die Umgebung beleuchten;
  Fahrzeuge haben **weiße Scheinwerfer vorn und rote Rückleuchten**.
- **Gebäude verfallen**, wenn sie zu lange im Wasser stehen; alle Gebäude stehen auf einem
  **Fundament** und damit gerade am Hang. **Wall und Deich sind eins** (Erdwall blockiert
  Bewegung und Wasser), der Schützengraben heißt jetzt schlicht **Graben**.

## Neu in v0.5: Physik, Wetter-Risiken, Lawinen (Phase 16)

- **Steigungs-Physik** (an der realen Hangverteilung kalibriert): Infanterie klettert fast überall,
  leichte Fahrzeuge schaffen moderate Hänge, schwere nur sanftes Gelände — **gebaute Straßen
  (Serpentinen) erlauben steilere Passagen**. Straßenbau funktioniert kettenbar auch **weit
  außerhalb der Basis**. Fahrzeuge legen sich sichtbar an die Hangneigung an (Nick/Roll).
- **Kollision**: massive Gebäude blockieren ihren Footprint (Pfadfindung weicht aus), Zerstörung
  gibt die Zellen frei. Fahrzeuge drehen erst und fahren dann — **kein Seitwärtsgleiten**.
- **Strömung**: fließendes Wasser **reißt Einheiten flussabwärts** (Schiffe halten besser dagegen);
  Fließrichtung ist durch treibende Schlieren-Partikel sichtbar.
- **Wetter bestimmt die Einheitenwahl**: ⛈ Wellengang beschädigt Überwasserschiffe (getauchte
  U-Boote sicher!), Sturmböen und Blitze gefährden die Luftflotte; 🌫 **Nebel** halbiert die
  Zielerfassung (riskant für Schiffe/Flieger) und legt dichten Sichtnebel über die Szene;
  Infanterie ist im Gelände am flexibelsten (kein Matsch, steile Hänge).
- **Schneelawinen**: Regen lässt den Schnee am Berg wachsen — überladene Steilhänge gehen als
  Lawine ab (beschädigt alles im Pfad, Schmelzwasser im Auslauf); Erdbeben lösen zusätzlich
  Lawinen neben den normalen Hangrutschen aus.
- **Effekte**: ballistische Trümmerbrocken bei Explosionen, Staubfahnen fahrender Fahrzeuge,
  Lawinen-Schneewolken, Fließrichtungs-Schlieren. **Render-Fixes**: kein Z-Fighting der
  Wasserflächen beim Rauszoomen, Gebäude versinken nicht mehr halb im Hang.

## Neu in v0.6: Große Karte, Hang-Erzbau, Linien-Bau (Phase 17)

- **Karte 4× so groß** (192×192) mit **imposantem Zentralmassiv** (steiler Hauptgipfel über
  breitem Bergfuß, kräftigere Grate, höhere vertikale Skalierung) und 4 Hochseen.
- **Erz steht an Hängen an** (rostbraune Felsbrocken statt Goldkugeln): Der **Erzbagger**
  trägt den Hang beim Fördern sichtbar ab — es entstehen Gräben und Löcher, der Oberhang
  **rutscht immer wieder nach** (Steinschlag beschädigt Einheiten in der Abbauzelle).
  Die „goldene" Nebenressource (Seltene Metalle) ist entfernt.
- **Sichtbarer Schneezyklus**: Regen fällt am Berg als Schnee und lässt die Schneedecke
  deutlich anwachsen; bei Sonne schmilzt sie sichtbar ab und die **Flüsse schwellen an**
  (Gesamtschmelze normalisiert — flutet die Karte nicht).
- **Linien-Bau**: Wall, Graben, Straße, Leitung und Damm zieht man per **Start→Endpunkt**
  (Vorschau-Geister beim Ziehen, Segmente verketten sich über ihren Bauradius, Baufahrzeuge
  arbeiten die Baustellen sichtbar ab). Gilt auch für Aufschütten/Abgraben.
- **Low-Poly-Soldaten**: das zu detaillierte Soldatenmodell ist durch stimmige kantige
  Box-Soldaten ersetzt (Schütze/Panzerabwehr/Pionier unterscheidbar).

## Neu in v0.7: Echte Wasseroberflächen, Erz als Währung (Phase 18)

- **Wasser-Rendering neu**: tiefenbasiertes Oberflächenmesh — Meer, Flüsse, **Hochseen und der
  Kratersee sind jetzt sichtbar** (vorher leer), mit **Wellengang** (Amplitude wächst mit Tiefe,
  Sturm verstärkt), lesbarer Wasserkante und ohne Z-Fighting beim Rauszoomen.
- **Die goldene Credits-Ressource ist weg**: **Erz ist die Währung** — vom Bagger an Hängen
  abgebaut, in Lagern (HQ/Raffinerie/Erzlager) begrenzt, direkt verbaut. Zentrale Ressourcen:
  Erz, Öl, Erde, Wasser, Sonne.
- **Kein Seitwärtsfahren mehr**: Fahrzeuge bewegen sich strikt entlang der Nase (Bögen,
  Pivot bei engen Wenden, großzügige Wegpunkt-Akzeptanz gegen Orbits).
- **Bagger-Überleben**: eigene Steinschläge treffen den Bagger nicht mehr; läuft die Abbaugrube
  mit Wasser voll, flieht er aufs Trockene und fördert woanders weiter.
- **Optik**: Low-Poly-Soldaten mit Geh-Animation, Baumfarb-Variation, brennende beschädigte
  Gebäude, Trümmer/Staub/Lawinen-Partikel.
- **Performance**: Wasser-CA legt geflutete Randzellen schlafen (34k→aktive Front), A*-Budget
  12 Suchen/Tick gegen Angriffswellen-Spikes (333 ms → 40 ms max).

> **Bekanntes offenes Thema (v0.7):** KI-Armeen erreichen den Gegner auf der großen Insel oft
> nicht geschlossen (Einzelverluste an Fluten/Wetter unterwegs) → viele KI-vs-KI-Matches enden
> unentschieden. Nächste Schritte: Wellen-Sammelpunkte, sichere Routenwahl (Straßen/Brücken im
> A* bevorzugen). Die Wirtschafts-Deadlocks der Lager-Logistik sind behoben (siehe Memory/Tests).

## Neu in v0.8: Tunnel, Kanäle, Nebel-Infrastruktur, Komfort (Phase 19)

- **Tunnel als durchgehende Röhre**: per Linie von **Hang zu Hang** durch Klippen/Berge gezogen
  (deutlich teurer als Straßen). **Fahrzeuge UND Wasser** kommen durch; Einheiten verschwinden in
  der Röhre (nur als Umriss sichtbar) und tauchen am anderen Ende wieder auf. Eine zerstörte
  Mündung **versiegelt** das Ende (Einheiten nutzen den intakten Ausgang), beide zerstört →
  **Einsturz** mit allen Einheiten darin. Wasser-Fluidsimulation fließt durch den Tunnel.
- **Kanal-Schiff**: das Bau-Schiff hebt per Linie einen **schiffbaren Kanal** durch Land aus.
- **Nebel des Krieges** verbirgt jetzt auch **gegnerische Pipelines, Straßen, Brücken und Tunnel**;
  der **Sichtradius ist größer**, besonders bei Gebäuden. Eigene Infrastruktur bleibt sichtbar.
- **Pumpwerk nur im Süßwasser**: Pumpwerke dürfen nur in **Fluss/See** (nicht im Meer) stehen und
  fördern **nur, solange sie tatsächlich im Wasser stehen** (Dürre legt sie still). Pumpwerke und
  Bohrtürme lassen sich als **Außenposten fernab der Basis** errichten.
- **Bau-Radius-Kreis**: beim Platzieren eines reichweitengebundenen Gebäudes zeigen geländefolgende
  Ringe, **wo gebaut werden darf**; frei platzierbare Bauten (Pumpe/Bohrturm/Leitung/Straße)
  zeigen keinen Kreis. Der Bau-Geist wird außerhalb der erlaubten Zone rot.
- **LKW-Transportmodus** umstellbar (Auto / nur Erz / nur Baumaterial) per Auswahlknopf.
- **Flugeinheiten anklickbar**: Picking trifft sie auf ihrer Flughöhe (Box-Auswahl, Klick,
  Doppelklick, Befehlsziel).
- **Ressourcenanzeige**: Klick auf eine **Öl- oder Erzquelle** zeigt die **verbleibende Menge**
  (Erz-Restmengen werden live gestreamt); Klick auf Lager/LKW zeigt Bestand/Ladung.
- **Animierter Pipeline-Durchfluss**: bei angeschlossener, fördernder Leitung wandern leuchtende
  Bänder durch die Röhre; flexibler Schlauch am Pumpwerk/Bohrturm/Depot-Anschluss.
- **Brücken** überspannen Schluchten auf **Uferniveau** (mit Pfeilern) statt in den Graben zu tauchen.
- **KI-Strategien & Sekundärziele**: wechselnde Doktrinen (kombiniert, Luftschlag, Marine, Sturm,
  Belagerung, Überfall, Nacht, **Fluten**), defensiver **Wasserwall** um die Basis, Flutkanäle
  Richtung Gegner; **gesamtes Fahrzeugspektrum** statt Infanterie-Schwärme; KI baut sinnvolle
  Brücken/Tunnel/Pipelines und gräbt sich per Deadlock-Cheat aus echten Klemmen.
- **Audio**: durchgängig **rockiger Soundtrack** (treibender Rock im Hintergrund, harter Rock im
  Gefecht) und **wuchtigere SFX** (geschichtete Synth-Schüsse/Explosionen + Samples).
- **Komfort**: größere Icons in Baumenü & Techtree, Straßen ohne HP-Balken, schwimmende
  Werft/Pumpwerk/Boote, Wall/Graben als steile Sperren (nur per Brücke/Tunnel passierbar).

## Stand (v0.2) & bekannte Punkte

Lauffähiger, getesteter vertikaler Schnitt: Wirtschaft (Erz als Bau- und Produktionswährung, Energie, Munitions-/
Treibstoff-Logistik), Basisbau, Landkampf mit Projektilen & Flächenschaden, Deckung &
Befestigungen (**garnisonierbare Schützengräben**: eingegrabene Infanterie nimmt weniger Schaden
und wird feldrepariert), **dynamisches Wasser** (Zellularautomat: fließende Flüsse, Aufstauen/Fluten/
Trockenlegen über Deich & Staudamm, Flutschaden), **Luftkampf mit Bordmunition & Nachladen an
der Luftbasis**, **Seekrieg** (Marine fährt nur auf Wasser, U-Boot-Tarnung, **Sonar-Ortung**), **KI mit
Mehrdomänen-Doktrin** (techt zu Luftbasis/Werft hoch, baut Luft-/Seeflotten, Marine-Angriffs-
gruppen gegen Küstenziele, geordneter Bau ohne Überbau), Multiplayer + KI-Übernahme, 3D-Client.
KI-Matches sind entscheidend und laufen weit schneller als Echtzeit (~550–900× headless).

**Bekannte Schwächen (nächste Iterationen):** Wasserbau (Dämme/Deiche) wird von der KI noch
nicht taktisch genutzt; Luft- und Landwellen werden getrennt geführt (noch nicht koordiniert);
zerstörbare Brücken/Schleusen, Veteranenstufen und Tech-Tree sind angelegt, aber noch nicht voll
ausgebaut; vereinzelte Tick-Spitzen bei gleichzeitigem Massen-Repathing. Siehe ROADMAP.
