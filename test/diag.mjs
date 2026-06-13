import { createWorld, step } from '../shared/sim.js';
import { loadData } from '../shared/data-node.js';
const data = await loadData();
const factions = ['HLX','KBN','FLG'];
const base = parseInt(process.argv[2] || '1000', 10);
const mul  = parseInt(process.argv[3] || '97', 10);
const N = parseInt(process.argv[4] || '90', 10);
const pairWins = {}; const overall={HLX:0,KBN:0,FLG:0,draw:0};
for (let s=0;s<N;s++){
  const fa = factions[s%3], fb = factions[(s+1)%3];
  const players=[{id:0,faction:fa,controller:'ai'},{id:1,faction:fb,controller:'ai'}];
  const world=createWorld({data,seed:base+s*mul,players});
  let winner=null;
  for(let t=0;t<15000;t++){step(world);const al=world.players.filter(p=>!p.defeated);if(al.length<=1){winner=al[0];break;}}
  const key=[fa,fb].sort().join('_v_'); pairWins[key]=pairWins[key]||{};
  const w=winner?winner.faction:'draw'; pairWins[key][w]=(pairWins[key][w]||0)+1; overall[w]++;
}
for(const[k,v]of Object.entries(pairWins))console.log(k.padEnd(12), JSON.stringify(v));
const dec=overall.HLX+overall.KBN+overall.FLG;
console.log('OVERALL  HLX',(overall.HLX/dec*100).toFixed(0)+'%  KBN',(overall.KBN/dec*100).toFixed(0)+'%  FLG',(overall.FLG/dec*100).toFixed(0)+'%  (draws '+overall.draw+')');
