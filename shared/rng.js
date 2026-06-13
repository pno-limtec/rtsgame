// Seedbarer, deterministischer RNG (mulberry32). Sichert reproduzierbare Matches/Tests.
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const fn = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  fn.int = (n) => Math.floor(fn() * n);
  fn.range = (lo, hi) => lo + fn() * (hi - lo);
  fn.pick = (arr) => arr[fn.int(arr.length)];
  fn.state = () => a >>> 0;
  fn.setState = (state) => { a = Number(state) >>> 0; return fn; };
  return fn;
}
