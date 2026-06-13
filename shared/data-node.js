// Datenlader für Node (Server & Tests). Liest die JSON-Balancing-Dateien von Platte.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dir, '..', 'data');
const j = (f) => JSON.parse(readFileSync(join(dataDir, f), 'utf8'));

export function loadData() {
  return {
    units: j('units.json'),
    buildings: j('buildings.json'),
    weapons: j('weapons.json'),
    resources: j('resources.json'),
    factions: j('factions.json'),
    veterancy: j('veterancy.json'),
  };
}
