// Globale Simulationskonstanten. Geteilt zwischen Server, Client und Tests.
export const TICK_RATE = 10;          // Simulationstakt (Hz) — autoritativ auf dem Server
export const DT = 1 / TICK_RATE;      // Sekunden pro Tick
export const MAX_UNITS_PER_PLAYER = 200;
export const TILE = 2;                // Weltmeter pro Tile
export const DEFAULT_MAP = { w: 192, h: 192 };  // Tiles (Phase 17: 4× Fläche, imposante Berge)
export const SNAPSHOT_RATE = TICK_RATE;        // Netzwerk-Snapshots pro Sekunde
export const AI_REPLAN_TICKS = 20;             // KI denkt alle 2s neu nach
export const HARVEST_DELIVER = 1.0;            // Erz→Credit-Umrechnung
export const POWER_LOW_PENALTY = 0.5;          // Produktionsfaktor bei Energiedefizit

// --- Dynamisches Wasser (Phase 8, Zellularautomat) ---
export const SEA_LEVEL = 0.28;                 // Höhe, bis zu der Becken mit Wasser gefüllt sind (= TT.WATER-Schwelle)
export const WET_DEPTH = 0.035;                // Wassertiefe ab der eine Zelle als „nass" gilt (Boden gesperrt)
export const FLOOD_DEPTH = 0.09;               // Tiefe ab der Landeinheiten ertrinken (Schaden + Verlangsamung)
export const BUILDER_WADE_DEPTH = FLOOD_DEPTH * 1.55; // Bagger dürfen für Arbeit kurzzeitig in moderates Wasser
export const BUILDER_WADE_TIME = 14;           // Sekunden Arbeitszeit im Wasser, danach sucht der Bagger Land
export const NAVIGABLE_DEPTH = 0.12;           // Tiefe ab der Wasser als echtes Fahrwasser für Schiffe zählt
export const WATER_STEP_TICKS = 2;             // Wasser-CA läuft alle N Ticks (5 Hz) — günstig & stabil
export const WATER_FLOW = 0.34;                // hydraulischer Ausgleich je Wasser-Schritt — bewusst niedrig: Wasser breitet sich langsam in kleinen Schritten aus
export const WATER_SEEP = 0.0035;              // sehr langsame Versickerung/Verdunstung; Wasser soll primär zum Meer abfließen
export const FLOOD_CAP_FRAC = 0.25;            // Zufluss-Stopp erst bei 25 % überflutetem Land — Worst-Case-Überschwemmungen dürfen groß werden
export const FLOOD_CAP_DRAIN = 0.05;           // Notabfluss/Schritt für überflutetes Land oberhalb des Deckels
export const WATER_SOURCE_RATE = 0.06;         // Zufluss (Tiefe/Schritt) je Quelle
export const WATER_SOURCES = 2;                // Anzahl Flussquellen je Karte
export const WATER_MAX_DEPTH = 0.7;            // normale Gameplay-Tiefe für Schaden/Schweregrad
export const WATER_STORAGE_MAX_DEPTH = 2.1;    // reiner Speicher-Backstop: sehr tiefe Löcher dürfen bis zur Kante volllaufen
export const FLOOD_DPS = 16;                   // Ertrinkungsschaden pro Sekunde in gefluteten Zellen
export const WATER_ERODE_DEPTH = 0.11;         // ab dieser Stautiefe trägt Wasser Land sichtbar ab
export const WATER_ERODE_EXCESS = 0.045;       // nur Wasser über Normalpegel erodiert Gelände
export const WATER_ERODE_RATE = 0.0060;        // Geländeabtrag pro Wasser-Schritt bei Stau
export const WATER_ERODE_MAX_STEP = 0.004;     // Abtrag pro Zelle/Schritt begrenzen

// --- Luftkampf: Bordmunition & Nachladen an der Luftbasis (Phase 4) ---
export const AIR_REARM_RANGE = 5;              // Distanz zur Luftbasis, ab der nachgeladen wird
export const AIR_REARM_RATE = 0.6;             // Bordmunition/Sekunde beim Nachladen an der Basis
export const AIR_RTB_THRESHOLD = 0;            // Bordmunition, ab der die Einheit zur Basis zurückkehrt (≤)

// --- Seekrieg: U-Boot-Tarnung (Phase 5) ---
export const SUB_DETECT_RANGE = 5;             // Reichweite, in der getauchte U-Boote entdeckt/angreifbar werden
export const SUB_EXPOSE_TIME = 2.0;            // Sekunden, die ein U-Boot nach eigenem Feuern sichtbar bleibt

// --- Amphibische/Lufttransporte: Ein-/Ausladen (Phase 5) ---
export const LOAD_RANGE = 2.6;                 // Weltmeter, ab der eine Landeinheit in den Transporter einsteigt
export const UNLOAD_RANGE = 2.4;               // Weltmeter zum Zielpunkt, ab der ausgeladen wird

// --- Tunnel: durchgehende Röhre durch Klippen/Berge (per Linie gebaut, wie Straße, aber teuer) ---
export const TUNNEL_MAX_LEN = 26;              // maximale Tunnellänge in Tiles (sonst zu mächtig/teuer)
export const TUNNEL_COST_ORE = 60;            // Erzkosten je Tunnel-Tile (deutlich teurer als Straße: 20)
export const TUNNEL_COST_MAT = 10;            // Materialkosten je Tunnel-Tile
export const TUNNEL_WATER_FLOW = 0.5;          // Anteil des Oberflächengefälles, der je Schritt durch die Röhre fließt

// --- Umwelt: Tag/Nacht & Wetter (Phase 14) ---
export const DAY_LENGTH = 240;                 // Sekunden pro vollem Tag/Nacht-Zyklus
export const NIGHT_LIGHT_POWER = 0.25;         // zusätzlicher Energieverbrauch der Gebäude nachts (Beleuchtung, Anteil)
export const NIGHT_FUEL_MULT = 0.5;            // zusätzlicher Treibstoffverbrauch der Fahrzeuge nachts (Scheinwerfer, Anteil)
export const RAIN_FRAC = 0.02;                 // Anteil der Kartenzellen, die je Wasser-Schritt Regen abbekommen (skaliert mit Kartengröße)
export const DROUGHT_RIVER_DRAIN = 0.0012;     // Wassertiefe je Wasser-Schritt, die aus Flussrinnen bei Trockenphase verschwindet

// --- Erzabbau am Hang (Phase 17) ---
export const ORE_SLOPE_MIN = 0.045;            // Mindesthangneigung, an der Erz ansteht
export const MINE_DIG = 0.00018;               // Hangabtrag (Höhe) je gefördertem Erz — gräbt Löcher/Gräben
export const MINE_SLIDE_CHANCE = 0.05;         // Chance je Förder-Tick, dass der Hang nachrutscht (Steinschlag)
export const MINE_SLIDE_AMT = 0.02;            // Höhenanteil, der dabei vom Oberhang nachrutscht
export const ROCKFALL_DMG = 7;                 // Schaden rollender Steine an Einheiten in der Zelle
export const RAIN_DEPTH = 0.009;               // Regenmenge (Tiefe) je getroffener Zelle und Schritt
export const STORM_RAIN_MULT = 2.2;            // Gewitter regnet stärker
export const CLOUD_SEED_RADIUS = 13;           // Weltmeter: lokale Starkregenwolke durch Silberjodid-Flugzeug
export const CLOUD_SEED_DURATION = 22;         // Sekunden Starkregen am Zielpunkt
export const CLOUD_SEED_RAIN_DEPTH = 0.0032;   // Wassertiefe je Simulationstick im Wolkenkern
export const LIGHTNING_MIN_GAP = 5.0;          // Sekunden Mindestabstand zwischen Blitzeinschlägen
export const LIGHTNING_DMG = 65;               // Schaden eines direkten Blitzeinschlags (gefährlich, nicht vernichtend)
export const QUAKE_INTERVAL = [180, 420];      // Sekunden zwischen Erdbeben (min, max; deterministisch)
export const QUAKE_DURATION = 3.5;             // Sekunden Bebendauer
export const QUAKE_RADIUS = 14;                // Tiles um das Epizentrum
export const QUAKE_SLOPE = 0.036;              // Hangneigung (Höhendiff. je Nachbarzelle), ab der Material abrutscht
export const QUAKE_SLIDE = 0.5;                // Anteil der Überneigung, der je Rutsch-Durchgang abrutscht
export const QUAKE_BUILDING_DMG = 60;          // Gebäudeschaden je Sekunde im Bebenradius auf Hangzellen
export const RAIN_SLIDE_SLOPE = 0.046;         // nasse Hänge werden ab dieser Neigung instabil
export const RAIN_SLIDE_CHANCE = 0.075;        // Stichprobenchance je Regenprüfung und Kandidat
export const RAIN_SLIDE_AMT = 0.38;            // Anteil der Überneigung, der bei Regen abrutscht

// --- Karte: Zentralberg, Schnee, Randmeer (Phase 15) ---
export const SNOW_LINE = 1.34;                 // Höhe, ab der dauerhaft Schnee liegt — die echte Gipfelkappe (~4 % der Karte; MAX_HEIGHT≈1.92)
export const SNOW_FALL_LINE = 1.16;            // bis hierher kann sich bei Niederschlag Neuschnee ausbreiten (Schneegrenze sinkt im Sturm)
export const SNOW_INIT = 4.0;                  // Anfangsschnee = (h − SNOW_LINE) · SNOW_INIT
export const SNOW_MELT = 0.0007;               // Schmelze je Wasser-Schritt × Sonnenstärke — bewusst langsam: die Kappe braucht mehrere Tage Sonne
export const SNOW_FALL = 0.026;                // Schneefall je Wasser-Schritt bei Regen/Gewitter — sichtbares Anwachsen der Schneedecke
export const SNOW_BAND_CAP = 10;               // max. Schneetiefe je 1.0 Höhe über SNOW_FALL_LINE (Gipfel trägt dick, Band nur dünn)
export const MELT_WATER = 0.9;                 // Anteil der Schmelze, der als Wasser in die Zelle geht
export const EDGE_SEA = 0.085;                 // Anteil der Kartenbreite, der zum Randmeer abfällt

// --- Straßen & Fahrzeugphysik (Phase 15) ---
export const ROAD_RECALC_TICKS = 50;           // Straßennetz alle 5 s neu verbinden
export const ROAD_MAX_DIST = 20;               // max. Tile-Distanz für automatische Straßen zwischen Gebäuden
export const PONTOON_SPEED = 0.4;              // Pontonbrücken sind nur langsam befahrbar (wackelig/improvisiert)
export const ROAD_SPEED = 1.65;                // Tempobonus auf Straßen (Infanterie zu Fuß)
export const ROAD_SPEED_VEHICLE = 7.5;         // Fahrzeuge fahren auf Straßen deutlich schneller als im Gelände
export const ROAD_SPEED_HEAVY = 7.5;           // (Alt-Name, = Fahrzeug-Bonus)
export const MUD_SPEED_HEAVY = 0.3;            // schwere Fahrzeuge abseits der Straße bei Regen (Matsch)
export const HEAVY_WATER_DPS = 14;             // Schaden/s für schwere Fahrzeuge in nassen Zellen
export const TURN_RATE_VEHICLE = 3.4;          // rad/s Drehrate Fahrzeuge (erst drehen, dann fahren)
export const TURN_RATE_NAVAL = 1.8;            // rad/s Drehrate Schiffe
export const VEHICLE_ACCEL = 2.0;              // Anteil der Höchstgeschw. pro Sekunde Beschleunigung
export const TRACK_GAIN_LIGHT = 0.010;         // Spurtiefe je gefahrenem Meter leichter Fahrzeuge
export const TRACK_GAIN_HEAVY = 0.032;         // schwere Fahrzeuge schneiden deutlichere Spurrillen
export const TRACK_DECAY_CLEAR = 0.00035;      // trockene Spuren glätten sich langsam; Sonne beschleunigt
export const TRACK_DEPRESSION = 0.055;         // effektive Rinnen-Tiefe für Wasserfluss/Pfützen
export const TRACK_PUDDLE_MIN = 0.18;          // ab dieser Spurtiefe sammelt Regen sichtbar Wasser
export const TRACK_RAIN_MULT = 3.0;            // Regen sammelt sich in Rillen deutlich stärker als auf offenem Boden (sichtbare Pfützen)
export const MUD_GAIN_HEAVY = 0.16;            // Matschzuwachs je Meter schweres Fahrzeug in nasser Rille
export const MUD_DRY_CLEAR = 0.0020;           // Matsch trocknet bei klarem Wetter ab; Sonne beschleunigt
export const MUD_IMPASSABLE = 0.82;            // ab hier bleiben schwere Fahrzeuge stecken/planen drumherum
export const MUD_SPEED_MIN = 0.18;             // lokale Mindestgeschwindigkeit in tiefem Matsch

// --- Steigungen & Kollision (Phase 16) ---
// Kalibriert an der realen Hangverteilung der Karte (Median-Δh ≈ 0.05/Tile):
// Infanterie ~96 % des Landes, leichte Fahrzeuge ~90 %, schwere ~84 % — die steilsten
// Hänge (Bergflanken, Hügelkämme) sind für Fahrzeuge nur über Straßen passierbar.
export const SLOPE_INFANTRY = 0.16;            // max. Höhendifferenz je Tile-Schritt: Infanterie klettert fast überall
export const SLOPE_VEHICLE = 0.105;            // leichte Fahrzeuge schaffen moderate Hänge
export const SLOPE_HEAVY = 0.085;              // schwere Fahrzeuge brauchen sanftes Gelände …
export const SLOPE_BUILDER = 0.150;            // Bagger/Radlader kommen als Arbeitsfahrzeuge auch steilere Hänge hoch
export const SLOPE_ON_ROAD = 0.135;            // … außer auf Straßen: Serpentinen-Effekt
export const SLOPE_TERRAFORM_BUILDER = 0.18;   // Bagger kommen über die steilen Kanten eigener Erdarbeiten
export const STEEP_BUILD_SLOPE = 0.34;         // Bagger meistert sehr steile Hänge, um Pipeline/Brücke dort zu bauen

// --- Strömung: fließendes Wasser reißt mit (Phase 16) ---
export const CURRENT_MIN_DEPTH = 0.04;         // ab dieser Tiefe wirkt Strömung
export const CURRENT_DRAG = 9.0;               // Drift (m/s) pro Einheit Oberflächengefälle
export const CURRENT_MAX = 2.6;                // maximale Driftgeschwindigkeit (m/s)

// --- Wetter-Risiken je Domäne (Phase 16) ---
export const WAVE_DPS = 3.5;                   // Wellengang: Schaden/s für Überwasserschiffe bei Gewitter
export const STORM_AIR_DPS = 4.5;              // Sturmböen: Schaden/s für Luftfahrzeuge bei Gewitter
export const RAIN_AIR_SLOW = 0.85;             // Luft fliegt bei Regen langsamer
export const STORM_NAVAL_SLOW = 0.7;           // Schiffe bei Gewitter langsamer
export const FOG_SIGHT_MULT = 0.45;            // Nebel: Zielerfassungs-Reichweite aller Einheiten
export const FOG_NAVAL_SLOW = 0.8;             // Schiffe tasten sich im Nebel voran
export const FOG_NAVAL_DRIFT = 0.95;           // m/s Kursdrift für Schiffe im Nebel
export const FOG_NAVAL_CRASH_DMG = 900;        // Küstenkontakt im Nebel: Schiffe zerschellen

// --- Schneelawinen (Phase 16) ---
export const AVAL_SNOW = 0.22;                 // Schneetiefe, ab der ein Hang lawinengefährdet ist (leichter auslösbar)
export const AVAL_SLOPE = 0.034;               // Mindesthangneigung für Lawinenabgang
export const AVAL_CHANCE = 0.028;              // Auslösewahrscheinlichkeit je Prüfung und Kandidat (bei Schneefall höher)
export const AVAL_DMG = 180;                   // Schaden an Einheiten/Gebäuden im Lawinenpfad
export const AVAL_LEN = 32;                    // maximale Lauflänge (Tiles)
export const AVAL_ERODE = 0.05;               // Lawinen schürfen oben Material ab (deutlich sichtbar)
export const AVAL_DEPOSIT = 0.038;             // und lagern es in der Auslaufzone an

// --- Gebäude im Wasser & Strom-Lastabwurf (Phase 15) ---
export const BUILDING_FLOOD_GRACE = 12;        // Sekunden im Wasser, bevor ein Gebäude Schaden nimmt
export const BUILDING_FLOOD_DPS = 8;           // Gebäudeschaden/s bei dauerhafter Überflutung

// --- Bagger & Terraforming-Aufträge (Phase 15) ---
export const CONSTRUCT_RANGE = 3.0;            // Weltmeter (+Gebäudegröße), ab der ein Bagger baut
export const TERRA_JOB_DELTA = 0.12;           // Höhenänderung eines Aufschütt-/Abgrab-Auftrags (gesamt)
export const TERRA_JOB_RATE = 0.18;            // Höhenänderung pro Sekunde Arbeit
export const TERRA_RAISE_COST = 8;             // Erde (materials) je Aufschütt-Auftrag
export const TERRA_LOWER_YIELD = 6;            // Erde aus einem Abgrab-Auftrag

// --- Wasserwirtschaft: Pumpwerke & Leitungen (Phase 14) ---
export const PUMP_RATE_WATER = 1.2;            // Wasser/s eines Pumpwerks direkt am Gewässer
export const PUMP_RATE_GROUND = 0.3;           // Wasser/s aus Grundwasser (ohne Gewässeranschluss)
export const PUMP_RAIN_BONUS = 0.6;            // zusätzliches Wasser/s je Pumpwerk bei Regen
export const PIPE_LINK_RANGE = 2;              // Tiles Überbrückung zwischen Leitungssegmenten/Gebäuden
export const PLANT_WATER_USE = 0.15;           // Kühlwasser/s je Ölkraftwerk
export const PLANT_FUEL_USE = 0.2;             // Öl(Treibstoff)/s je Ölkraftwerk
export const PLANT_NO_WATER_MULT = 0.6;        // Leistungsfaktor ohne Kühlwasser
export const PLANT_NO_FUEL_MULT = 0.45;        // Leistungsfaktor ohne Brennstoff
export const TRENCH_EARTH_YIELD = 40;          // Baumaterial (Erde) aus dem Aushub eines Grabens

// --- Garnisonierbare Schützengräben (Phase 7) ---
export const GARRISON_RADIUS = 2.2;            // Weltmeter um den Graben, in denen Infanterie als eingegraben gilt
export const GARRISON_DAMAGE_MULT = 0.6;       // Schadensfaktor auf eingegrabene Infanterie (zusätzlich zur Deckung)
export const GARRISON_REGEN = 5;               // HP/s Feldreparatur für stationierte Infanterie
