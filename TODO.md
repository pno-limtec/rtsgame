# Faultline Command — offene TODOs

Stand: 2026-06-16. Build gesund: `node test/smoke.js` → **354/0**.
Regel für KI-/Wirtschafts-/Gelände-Änderungen: vor dem Übernehmen mit `node test/match-sim.js 12 12000`
prüfen — **entschieden ≥ Baseline (67–75 %)**, sonst zurückrollen. Schnelle Diagnose: `node test/ai-analyze.js`.

## Offen

### 1. Fahrzeug-Konnektivität / entscheidende KI-Kämpfe (#46 / #49) — IMPLEMENTIERT, GATE AUSSTEHEND
- Viadukt-Pass Basis→Basis ist in `shared/world.js` (`ensureVehicleRoute`/`stampViaduct`, vom Nutzer auf 5 breit erweitert); Brücken queren jetzt Klippe/Wasser/Steigung (`isPassable`/`slopeOk`-Ausnahme `onBridge` in `terrain.js`).
- Messung (vor den jüngsten Brücken-/Wasser-V2-Änderungen): **13/14 Seeds fahrzeug-verbunden bei tick 900 / Live-Wetter** (Baseline ~2/14), flutsicher.
- **TODO:** `match-sim 12 12000` laufen lassen und bestätigen, dass `decided` ≥ Baseline steigt **und** der Sieger-Archetyp „armor"/„combined" auftritt (bisher fast nur „infantry/tiny"). Bei Regression zurückrollen.

### 2. KI baut sinnvolle Brücken über den Fluss (#58)
- Brückenbaulogik wurde zuletzt (Nutzer) geändert. **TODO:** prüfen, dass die KI weiterhin/zuverlässig eine echte Querung baut und sich nicht mit dem Viadukt-Pass beißt (keine verstreuten Pfeiler). Mit `ai-analyze.js` (Kontakt-/Kampf-Heatmap) verifizieren.

### 3. Wall/Graben: KI zieht sie als LINIE und nur AUSSERHALB der Basis (#47)
- Spieler-Linienbau steht bereits (`LINE_KINDS`). **Offen:** KI baut Wall/Graben als zusammenhängende Linie an Engstellen der gegnerischen Zufahrt (außerhalb der eigenen Basis), statt verstreuter Einzelteile. Achtung: Wälle sperren auch eigene Einheiten → Lücke/Flanke lassen. Match-sim-gegated.

### 4. KI-Schutzaufschüttungen gegen Überschwemmung (#48)
- KI hebt auf der Bergseite einen Damm/Levee, der Lager/Basis vor Flut schützt (relevant mit Wasser V2). Terraform-basiert, niedriges Risiko, aber match-sim-gegated.

### 5. Ölkraftwerk an Öl- UND Wasserpipeline anbinden (#51b)
- Umbenennung Raffinerie→Stahlwerk ist erledigt. **Offen:** `power_plant` soll Leistung nur bei Pipeline-Anschluss an Öl UND Wasser bringen (analog Bohrturm/Pumpe), nicht aus globalem Ressourcenpool. HOHES Risiko (KI kann Strom-Kaskade auslösen, wenn sie die Pipelines nicht legt) → KI muss das Anbinden lernen; sehr sorgfältig gaten.

### 6. Pipeline/Brücke an Steilhängen + Optik (#23, Restposten)
- Bagger meistert Steigung zur Bau-Baustelle: umgesetzt. **Offen/prüfen:** Brücke überspannt Schlucht in passender Höhe (mit Wasser V2 neu prüfen) und Flexschlauch Pipeline→Pumpwerk/Station optisch sauber.

## Dauerziele (match-sim, bisher NIE erreicht — keine Regressionen, sondern Reifegrad)
- `Immer ein Sieger` ≥ 90 % (aktuell ~67 %). Hängt an #46/#49 (Panzer erreichen den Gegner → entscheidende Schlachten).
- `Keine Stagnation` ≤ 5 %.
- `Dauer-Vielfalt` CV ≥ 0.2.
- `Strategie-Vielfalt` ≥ 3 Sieger-Archetypen.

## Werkzeuge
- `node test/ai-analyze.js [seed] [maxTicks] [grid] [facA] [facB]` — EINE KI-Partie unter stabilen Bedingungen
  (konstanter Mittag, klares Wetter); Raster-Heatmaps (Kampf/Kontakt/Wald/Klippen), Tote-Zonen, Basis↔Basis-
  Erreichbarkeit für Infanterie UND Fahrzeug. **Bevorzugtes Diagnose-Tool** für alle KI-Themen.
- `node test/match-sim.js [matches] [maxTicks]` — Zielwert-Gate (decided/Stagnation/Balance/Vielfalt), ~10–15 min.
- `node test/smoke.js` — 354 Asserts. `node test/sim-test.js [ticks] [n] [seed]` — Crash/Echtzeit-Check.
