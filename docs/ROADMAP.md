# Iron Frontier — Entwicklungs-Roadmap

Iterativer Ausbau. Jede Phase endet mit lauffähigem Code + headless KI-Tests.
Status: ✅ fertig · 🟡 in Arbeit · ⬜ offen

## Meilenstein 0 — Fundament (dieser Bootstrap)
- ✅ Konzept & Roadmap
- ✅ Datengetriebene Balancing-Dateien (`data/*.json`)
- ✅ Dependency-freie Simulation (Grid, A*-Pfadfindung, Terrain, fester Tick-Loop)
- ✅ Ökonomie (Erz-Harvesting → Credits, Energie-Defizit drosselt Produktion)
- ✅ Basisbau + Produktionswarteschlangen
- ✅ Landkampf (Bewegung, Zielerfassung, Projektile, Schaden, Tod)
- ✅ KI-Spieler (Wirtschaft, Produktion, Angriff)
- ✅ Headless KI-vs-KI-Testlauf + Balancing-Checks
- ✅ WebSocket-Server (autoritativ, Join-in-Progress, KI-Übernahme)
- ✅ Three.js-Client (Terrain, Einheiten, Auswahl, Befehle, Minimap, Bauleiste, HUD)

## Phase 1 — Ressourcen & Industrie (Ausbau)
- 🟡 Mehrere Rohstoffe aktiv (Öl/Treibstoff, Munitionsverbrauch im Kampf)
- ⬜ Pipelines & Nachschubdepots (Reichweiten-/Raten-Boni)
- ⬜ Lagerkapazitäten & Überlauf

## Phase 2 — Basenbau (Ausbau)
- 🟡 Bauradius um Bauhof, Energienetz, Reparatur
- ⬜ Tech-Tree / Forschung mit Voraussetzungen

## Phase 3 — Landkampf (Ausbau)
- ✅ Einheitentypen, Konter (Panzer↔Infanterie↔Flak): Zielpriorität nach Waffenwirksamkeit (`nearestEnemy` wählt das wirksamste statt des nächsten Ziels — Flak/SAM fokussieren Luft, Panzer fokussieren Fahrzeuge; Distanz sekundär)
- ✅ Deckungssystem (Phase 7)
- ✅ Veteranenstufen: XP durch Abschüsse → Rekrut/Veteran/Elite/Held; Boni auf Schaden, max. HP, Sicht; Held heilt sich selbst. Datengetrieben (`data/veterancy.json`), Client zeigt Rang-Chevrons.

## Phase 4 — Luftkampf
- ✅ Bordmunition + Nachladen an der Luftbasis (RTB-Schleife: leere Maschinen kehren zurück, laden auf, sammeln sich)
- ✅ Direktflug (Luft ignoriert Gelände, keine A*-Suche); Flak/SAM-Reichweiten als Konter
- ⬜ Mehrere Flughöhen, Treibstoff-Reichweite pro Maschine

## Phase 5 — Seekampf
- ✅ Wasser-Pathfinding-Layer (Marine spawnt & fährt nur auf Wasser; kein Beaching mehr)
- ✅ U-Boot-Tarnung (getaucht nur im Nahbereich oder kurz nach Feuern entdeckbar)
- ✅ Sonar-Station: ortet getauchte gegnerische U-Boote im Umkreis und macht sie für die eigene Flotte angreifbar (`def.sonarRange`, `stepSonar`); KI baut sie an der Küste bei U-Boot-Bedrohung
- ✅ Amphibische Anlandung / Transporte: `amphib_transport` (Wasser+Land) & `transport_air` (Luft) laden Landeinheiten ein (`load`) und setzen sie an passierbaren Landzellen ab (`unload`); Insassen behalten HP/Veteranenstufe, werden aus der Welt genommen (unsichtbar/unangreifbar) und beim Untergang des Transporters mitgerissen (`shared/systems/transport.js`, `stepTransport`). Client: Rechtsklick auf eigenen Transporter = einsteigen, Rechtsklick auf Boden mit beladenem Transporter = ausladen.
- ⬜ KI nutzt Transporter aktiv für Anlandungen (Doktrin offen)

## Phase 6 — Gelände & Höhe
- ✅ Dramatische Geländegenerierung: Kontrast-Spreizung + ridged Grat-Rauschen → Hügellandschaften, Gebirgsketten (Klippen) und ausgeprägte Seen/Küsten; steilster-Abstieg-Flüsse von Bergquellen ins Meer (`carveRiver`). Auf ~46% Land / 25% Hügel / 11% Berg / 18% Wasser getunt (bespielbar + abwechslungsreich).
- ✅ Terraforming zur Laufzeit: Wall/Deich/Damm heben das Gelände an, Schützengraben senkt es (`def.terraform`, `applyHeightDelta`); Höhenänderung wird an den Client gestreamt (`serializeTerraform` → `snap.terra`) und ins Geländemesh übernommen (`renderer.updateTerraform`, nur geänderte Vertices + Normalen-Neuberechnung).
- 🟡 Höhe beeinflusst Sicht/Reichweite (Grundgerüst)
- ⬜ Steigungs-Bewegungskosten

## Phase 7 — Schützengräben & Wälle
- ✅ Natürliche Deckung (Wald-Cluster, Hügel) in der Geländegenerierung
- ✅ Baubare Befestigungen: Wall (blockiert Boden + Deckung), Schützengraben (Deckung)
- ✅ Deckung mindert Schaden (Infanterie voll, Fahrzeuge anteilig); Wall sperrt Pfadfindung
- ✅ KI baut Befestigungen an der Front & stellt Infanterie in Deckung
- ✅ Aufräumen bei Zerstörung (Deckung/Sperre werden freigegeben)
- ✅ Garnisonierbare Gräben: eingegrabene Infanterie (bis `garrison`-Kapazität) nimmt zusätzlich zur Deckung weniger Schaden (`GARRISON_DAMAGE_MULT`) und wird feldrepariert (`stepGarrison`); KI sammelt Infanterie in Gräben
- ⬜ Veteranen-Deckung

## Phase 8 — Dynamische Wassergräben
- ✅ Zellularautomat (Oberflächen-Ausgleich, Aktiv-Zellen-Set, deterministisch, alle 2 Ticks)
- ✅ Flussquellen + Versickerung → fließende Flüsse/Becken, Fluten laufen mit der Zeit ab
- ✅ Aufstauen/Umleiten/Fluten/Trockenlegen via Deich (`levee`) & Staudamm (`dam`) — zusätzlich verändern alle Bauten jetzt die Geländehöhe (Terraforming, Phase 6), sodass auch Wälle/Gräben Wasser umleiten (der CA fließt nach Oberflächenhöhe). Headless-getestet: gestautes Becken überwindet einen Bergrücken erst, nachdem ein Graben ihn durchsticht.
- ✅ Wassersperre (`waterBlock`) staut auf; Zerstörung setzt aufgestautes Wasser frei (Flutwelle)
- ✅ Geflutetes Land sperrt Boden-Pathfinding, öffnet See; Landeinheiten ertrinken (Schaden + Verlangsamung)
- ✅ Client-Rendering: instanzierte Flutflächen aus Snapshot-Deltas; Deich/Damm-Meshes
- ⬜ Zerstörbare Brücken/Schleusen; KI nutzt Wasserbau taktisch

## Phase 9 — Multiplayer (Härtung)
- 🟡 Snapshot-Sync, Lobby
- ⬜ Reconnect-Timeouts, Lag-Kompensation, Snapshot-Delta-Kompression

## Phase 10 — KI-Gegner (Ausbau)
- 🟡 Build-Order, Angriffswellen
- ✅ Mehrdomänen-Doktrin: KI techt zu Luftbasis/Werft hoch (Spar-Reserve), produziert Luft/See (gedeckelte Flottengrößen), führt Marine-Angriffsgruppen gegen Küstenziele
- ✅ Geordneter Bau (max. 2 Baustellen, nie dasselbe Gebäude doppelt) — behebt Kraftwerk-Überbau; baut Öltürme + Flak-Stellungen
- ⬜ Flankieren, Geländenutzung, Rückzug-Heuristik, Wiederaufbau

## Phase 11 — KI-Übernahme durch Spieler
- ✅ Slot-Controller-Umschaltung (Grundgerüst)
- ⬜ UI-Flow in der Lobby

## Phase 12 — Grafik & Effekte
- 🟡 Prozedurale Platzhalter-Meshes
- ✅ Prozedurale Texturen (CC0/eigenerstellt, keine Downloads): körnige Boden-Detailtextur (moduliert die Vertex-Farben) + getöntes Metall-/Panel-Material je Fraktionsfarbe auf Einheiten/Gebäuden (`client/js/textures.js`); Einheiten/Gebäude nutzen `MeshStandardMaterial` (roughness/metalness) statt flachem Lambert.
- ✅ Partikel-Effekte: Explosion = additiver Blitz + aufsteigende Rauchwölkchen + nach außen spritzende Funken (Sprite-Partikel mit weicher Puff-Textur), Mündungsblitz an Schüssen; Effekt-Backstop (max. 480) gegen Flut in Großschlachten.
- ✅ Prozedurale Audio-Engine (`client/js/audio.js`): WebAudio-synthetisierte SFX (CC0/eigenerstellt) für Schüsse je Waffenklasse (Gewehr/Kanone/Rakete/Bombe/Autokanone), Explosionen, Baufertig/Einheit-bereit-Chime, Niederlage; distanzabhängige Lautstärke zum Kamerafokus, Pro-Frame-Drossel; Lazy-Init nach erstem Nutzer-Gesture.
- ✅ Echte 3D-Modelle (CC0, aus freier Datenbank Poly Pizza heruntergeladen): `client/js/models.js` (`ModelLibrary`) lädt glTF-Modelle via `GLTFLoader`, normalisiert sie (Footprint-/Höhen-Skalierung, Zentrierung, Bodenausrichtung, Blickrichtungs-Yaw), mischt die Fraktionsfarbe ein (Teamfarbe) und teilt Geometrie/Material über Instanzen. Aktive Modelle: Soldat (Infanterie), Panzer, Leichtpanzer (Scout), Jeep (Flak), LKW (Harvester), Helikopter (Gunship), Militärboot (Marine). Asynchrones Laden mit automatischem **Fallback auf das prozedurale Mesh** (fehlende Datei/Ladefehler) und Mesh-Neuaufbau, sobald ein Modell bereit ist. Lizenzen in `client/assets/models/CREDITS.md`.
- ⬜ Restliche Kinds modellieren (Artillerie, Drohne/Bomber, U-Boot, Gebäude), echte Trümmer-Physik, dynamische Tag/Nacht-Beleuchtung

## Phase 13 — Balancing
- 🟡 Heuristik-Checks
- ✅ Fraktions-Asymmetrie verdrahtet & ausbalanciert: `costMult`/`research`/`armorMult` lagen tot in `factions.json` (nur `hpMult` war aktiv → HLX nur 8 % Siege). Jetzt zentral in `world.js` angewandt (`effectiveCost`, `buildSpeedMult`, `dmgTakenMult`), KI rechnet mit effektiven Kosten, fraktionsabhängige KI-Doktrin (HLX baut Bomber/Panzerabwehr). Über ~270 Validierungs-Matches auf unabhängigen Seeds: HLX ~33 % · KBN ~34 % · FLG ~32 % (vorher 8/33/58).
- ⬜ Auto-Tuning über Massensimulationen (`test/diag.mjs` liefert Matchup-Matrix)

## Phase 14 — Performance
- 🟡 Flache Datenstrukturen, Spatial-Hash für Zielerfassung
- ⬜ Instanced Rendering, LOD, Snapshot-Interest-Management

## Phase 15 — Automatisierte KI-Tests
- ✅ Headless-Matchlauf
- ⬜ CI-taugliche Regressionssuite, Balancing-Telemetrie über viele Seeds

---
### Nächste sinnvolle Schritte (Priorität)
1. ✅ KI nutzt Luft-/Seeeinheiten aktiv (Mehrdomänen-Doktrin). Offen: KI baut Dämme/Deiche taktisch (Wasserbau).
2. ✅ Garnisonierbare Gräben (Phase 7) & ✅ Sonar gegen U-Boote (Phase 5).
3. Zerstörbare Brücken/Schleusen (Phase 8 Vertiefung).
4. Reconnect-Timeout + Lobby-UI für KI-Übernahme (Phase 9/11).
5. 🟡 Kombinierte Wellen: Land+Luft fahren bereits in einer Welle; ✅ SAM/Flak feuern jetzt gezielt auf Luftziele (Zielpriorität nach Wirksamkeit). Offen: explizit koordinierte Eskorte/Timing.
6. ✅ Amphibische Anlandung (Transport lädt Landeinheiten ein und setzt sie über Wasser ab, Phase 5). Offen: KI-Anlandungsdoktrin.
