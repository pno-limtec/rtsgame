# Iron Frontier — Technisches Konzept

> Eigenständiges, browserbasiertes Multiplayer-Echtzeitstrategiespiel im Geist klassischer
> 2D/2.5D-Tactical-RTS-Titel. **Eigene Marke, eigenes Setting, eigene Assets.** Keine
> geschützten Namen, Modelle, Sounds oder Designs Dritter.

## 1. Setting & Fraktionen (eigenes IP)

**Welt:** Nach einem Klimakollaps kämpfen industrielle Großverbände um die letzten nutzbaren
Rohstoffadern der ausgetrockneten *Iron-Frontier*-Region.

Fraktionen (eigenständig, ausbalanciert, nicht an reale Marken angelehnt):

| Fraktion | Kürzel | Identität | Stärke | Schwäche |
|----------|--------|-----------|--------|----------|
| **Helix-Kollektiv** | HLX | Hochtechnisierte Drohnen-/Energiewirtschaft | Luft & Energie, schnelle Forschung | teure Einheiten, dünne Panzerung |
| **Karbon-Pakt** | KBN | Schwerindustrie, billige Massenproduktion | günstige Panzer, robuste Logistik | langsam, schwache Luftabwehr |
| **Freie Flutgilde** | FLG | Wasser-/Amphibik-Spezialisten | See & Geländekontrolle (Wassergräben) | landgebundene Schwäche im offenen Feld |

## 2. Architektur (strikt modular)

```
data/        Datengetriebene Balancing-Definitionen (JSON) — Einheiten, Gebäude, Waffen, Ressourcen
shared/      Deterministische Simulation (läuft in Node UND im Browser, KEINE Abhängigkeiten)
  ├─ sim.js          Welt + fester Tick-Loop, Befehlsverarbeitung, System-Reihenfolge
  ├─ systems/        Economy, Production, Movement, Water, Combat, Construction, Air, Sonar ...
  ├─ pathfinding.js  A* auf Tile-Grid mit Budgetierung
  ├─ terrain.js      Heightmap, Tile-Typen, Erz/Oel/Wasser-Masken, Bruecken/Tunnel
  └─ ai/ai.js        Computergegner (auch für automatisierte Tests)
server/      Autoritative Spiel-Loop + WebSocket-Matchmanager (Join-in-Progress, KI-Übernahme)
client/      Three.js-Rendering, Input, UI (Minimap, Bauleiste, Warteschlangen, HUD)
test/        Headless KI-vs-KI-Simulation, Performance- & Balancing-Checks
```

**Trennung der Belange:** Rendering ↔ Simulation ↔ Netzwerk ↔ UI ↔ KI ↔ Physik ↔ Daten sind
getrennte Module. Die Simulation kennt weder Three.js noch WebSockets.

## 3. Netzwerkmodell — Server-autoritativ

- **Fester Simulationstakt** (Standard 10 Hz) läuft ausschließlich auf dem Server.
- Clients senden **Befehle** (move/attack/build/produce), niemals Zustand.
- Server wendet Befehle an Tick-Grenzen an und sendet **Snapshots** (10 Hz) an alle Clients.
- Client **interpoliert** zwischen Snapshots für flüssiges Rendering (60 fps entkoppelt vom Sim-Takt).
- **Join-in-Progress:** neuer Client bekommt einen vollständigen Snapshot → sofort spielbereit.
- **KI-Übernahme:** ein Spieler-Slot hat ein `controller`-Feld (`human|ai`). Tritt ein Mensch
  bei, wird der Slot von `ai` auf `human` umgeschaltet — Basis & Einheiten bleiben erhalten.
- **Reconnect:** Slot bleibt bei Verbindungsabbruch erhalten und fällt nach Timeout auf KI zurück.

Vorteil dieses Modells: Join-in-Progress, KI-Übernahme und Reconnect sind strukturell trivial,
weil der Server jederzeit den vollständigen, verbindlichen Weltzustand besitzt.

## 4. Ressourcen & Industrie

Mehrstufige, aber überschaubare Ketten (Details in `data/resources.json`):

```
Erz   ──Bagger──▶ Erzhaufen ──LKW──▶ Lager/Raffinerie/HQ ──▶ Baukosten & Produktion
Erde  ──Terraforming/Abbau──▶ Erdhaufen ──LKW──▶ Materiallager ──▶ Waelle, Strassen, Bau
Öl    ──Bohrturm + Pipeline──▶ Öldepot ──▶ Treibstoff/Kraftwerk
Wasser──Pumpwerk + Pipeline──▶ Wasserturm ──▶ Kuehlung der Ölkraftwerke
Sonne ──Solarkraftwerk──▶ Energie (abhaengig von Tageszeit und Wetter)
```

Ressourcen: **Erz, Erde/Baumaterial, Öl, Wasser, Treibstoff, Munition, Energie und Sonne**.
Erz ist die direkte Währung; es gibt keine separate Credits-/Seltene-Metalle-Schicht mehr.
Öl und Wasser werden nicht per LKW transportiert, sondern über angreifbare Leitungsnetze zu
Depot/Wasserturm gebracht. Logistik ist strategisch relevant, aber bewusst nicht
mikromanagement-lastig.

## 5. Einheiten (Auszug, datengetrieben in `data/units.json`)

- **Land:** Radlader/Baufahrzeug, LKW/Harvester/Traktor, Infanterie, Späher, Panzer, Artillerie, Raketenwerfer, mobile Flak.
- **Luft:** Aufklärungsdrohne, Kampfhubschrauber, Bomber, Transporter.
- **See:** Patrouillenboot, Zerstörer, U-Boot, Amphibientransport, mobile Wasserbau-Einheit.

Obergrenze **200 Einheiten/Spieler** (in `constants.js`, im Sim erzwungen).

## 6. Gelände & Taktik

- **Höhenkarte** beeinflusst Sicht- und Waffenreichweite (Hügel = Bonus), Bewegung (Steigung = langsamer).
- **Tile-Typen:** Land, Hügel, Klippe (unpassierbar), Wasser, Brücke.
- **Deckung:** Wälle/Schützengräben senken erlittenen Schaden in der Zelle.
- **Dynamisches Wasser:** Wassergräben/Kanäle können aufgestaut, umgeleitet, geflutet oder
  trockengelegt werden. Das System nutzt einen deterministischen 8-Nachbar-Zellularautomaten
  mit aktiven Zellen, Basistiefen, Wasserblockern und langsamer Versickerung statt eines vollen
  Fluidsolvers. Details stehen in [TECHNICAL.md](TECHNICAL.md).
- **Zerstörbar:** Brücken, Dämme, Schleusen, Gebäude, Geländeobjekte.

## 7. KI

Verhaltensbaum-/Zustandsbasierter Gegner: Wirtschaft hochfahren → Armee aufbauen →
Angriffswellen → Verteidigung → Rückzug bei Unterzahl → Flankieren → Wiederaufbau/Reparatur.
Dieselbe KI treibt die automatisierten Tests (deterministische Seeds).

## 8. Determinismus & Tests

- Seedbarer RNG (`shared/rng.js`), feste Tick-Reihenfolge → reproduzierbare Matches.
- `test/sim-test.js` simuliert komplette KI-vs-KI-Matches headless, misst Tick-Zeit,
  Speicher, Einheitenzahlen und Siegbedingung.
- `test/balance-check.js` prüft Datenkonsistenz und grobe Balance-Heuristiken.

Siehe `docs/ROADMAP.md` für den iterativen Ausbauplan.
