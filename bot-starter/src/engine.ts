// Word search and letter valuation. Pure: no network, no clocks except the
// RNG passed in, so the simulator and the live bot share it.
//
// Racks and pools are `Counts`: 26 tile counts, index 0 = 'A'.

export type Counts = Int16Array;

export const LETTER_VALUE: readonly number[] = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4,
  10,
];

// The module's 98-tile bag (standard Scrabble, no blanks).
export const BAG: readonly number[] = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];

const A = 65;

export function emptyCounts(): Counts {
  return new Int16Array(26);
}

export function countsOf(letters: string): Counts {
  const c = emptyCounts();
  for (let i = 0; i < letters.length; i++) c[letters.charCodeAt(i) - A]!++;
  return c;
}

export function countsFromMap(rack: Map<string, number>): Counts {
  const c = emptyCounts();
  for (const [l, n] of rack) {
    const i = l.charCodeAt(0) - A;
    if (i >= 0 && i < 26) c[i]! += n;
  }
  return c;
}

export function total(c: Counts): number {
  let n = 0;
  for (let i = 0; i < 26; i++) n += c[i]!;
  return n;
}

export function letterIndex(letter: string): number {
  return letter.charCodeAt(0) - A;
}

// The module's reward: base score times the length multiplier, rounded down.
export function reward(word: string): number {
  let base = 0;
  for (let i = 0; i < word.length; i++) base += LETTER_VALUE[word.charCodeAt(i) - A]!;
  const len = word.length;
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

export interface Word {
  text: string;
  letters: Uint8Array; // letter indices, sorted, repeats kept
  reward: number;
}

export interface Lexicon {
  // Every word, best reward first.
  words: Word[];
}

export function buildLexicon(wordlist: Iterable<string>): Lexicon {
  const words: Word[] = [];
  for (const raw of wordlist) {
    const text = raw.trim().toUpperCase();
    if (text.length < 2 || !/^[A-Z]+$/.test(text)) continue;
    const letters = Uint8Array.from(text, (ch) => ch.charCodeAt(0) - A).sort();
    words.push({ text, letters, reward: reward(text) });
  }
  // Fewer tiles first among equal rewards: same points, more tiles kept.
  words.sort((a, b) => b.reward - a.reward || a.text.length - b.text.length);
  return { words };
}

// Words a rack can reach by buying a few tiles. Stored as flat arrays, one
// slot per word, rather than an object per word: a search can return
// 100,000 words, and that many small objects make garbage collection pause
// the bot for long enough to miss an auction.
interface CandidateSet {
  n: number;
  word: Uint32Array; // index into `Lexicon.words`, best reward first
  size: Uint8Array; // tiles to buy
  // The tiles to buy for word i, as (letter, count) pairs, in
  // pairLetter/pairCount[pairStart[i] .. pairStart[i + 1]).
  pairStart: Uint32Array;
  pairLetter: Uint8Array;
  pairCount: Uint8Array;
}

// The search over the whole lexicon is the slow part, and racks change less
// often than pools, so keep the last few results per lexicon.
const candidateCaches = new WeakMap<Lexicon, Map<string, CandidateSet>>();
const CANDIDATE_CACHE_SIZE = 12;

// Words the rack is at most `maxNeed` tiles short of, best reward first.
function candidates(
  lex: Lexicon,
  rack: Counts,
  maxNeed: number,
): CandidateSet {
  let cache = candidateCaches.get(lex);
  if (!cache) candidateCaches.set(lex, (cache = new Map()));
  const key = `${rack.join(",")}/${maxNeed}`;
  const hit = cache.get(key);
  if (hit) {
    // Re-insert so the oldest entry is the least recently used.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const out = searchCandidates(lex, rack, maxNeed);
  cache.set(key, out);
  if (cache.size > CANDIDATE_CACHE_SIZE) {
    cache.delete(cache.keys().next().value!);
  }
  return out;
}

function searchCandidates(
  lex: Lexicon,
  rack: Counts,
  maxNeed: number,
): CandidateSet {
  const wordIndex: number[] = [];
  const size: number[] = [];
  const pairStart: number[] = [0];
  const pairLetter: number[] = [];
  const pairCount: number[] = [];
  const maxLen = total(rack) + maxNeed;
  for (let w = 0; w < lex.words.length; w++) {
    const ls = lex.words[w]!.letters;
    if (ls.length > maxLen) continue;
    // Letters are sorted, so each run is one letter: the rack covers up to
    // its count of it, and the rest must be bought.
    let short = 0;
    for (let i = 0; i < ls.length && short <= maxNeed; ) {
      const l = ls[i]!;
      let k = i + 1;
      while (k < ls.length && ls[k] === l) k++;
      const gap = k - i - rack[l]!;
      if (gap > 0) short += gap;
      i = k;
    }
    if (short > maxNeed) continue;
    for (let i = 0; i < ls.length; ) {
      const l = ls[i]!;
      let k = i + 1;
      while (k < ls.length && ls[k] === l) k++;
      const gap = k - i - rack[l]!;
      if (gap > 0) {
        pairLetter.push(l);
        pairCount.push(gap);
      }
      i = k;
    }
    wordIndex.push(w);
    size.push(short);
    pairStart.push(pairLetter.length);
  }
  return {
    n: wordIndex.length,
    word: Uint32Array.from(wordIndex),
    size: Uint8Array.from(size),
    pairStart: Uint32Array.from(pairStart),
    pairLetter: Uint8Array.from(pairLetter),
    pairCount: Uint8Array.from(pairCount),
  };
}

// Words the rack can spell right now, best reward first.
export function playable(lex: Lexicon, rack: Counts): Word[] {
  const set = candidates(lex, rack, 0);
  return Array.from(set.word, (w) => lex.words[w]!);
}

export interface Outlook {
  // Expected net value of the best single word reachable from the rack
  // within the horizon: its reward less what buying its missing tiles costs.
  hold: number;
  // How much one extra tile of each letter, free, adds to `hold`.
  letterValue: Float64Array;
  // 1 for each letter that, added to the rack, spells a 7+ letter word.
  completes: Uint8Array;
  // In an endgame chase, for each letter, how many more tiles a word that
  // closes the gap would still need after winning it (see `closingNeeds`).
  chaseNeeds?: Uint8Array;
}

export interface OutlookParams {
  // Upcoming auctions to sample: the window the rack can buy from.
  horizon: number;
  // How many of those tiles the bot can expect to win.
  buys: number;
  samples: number;
  // What buying one tile of each letter costs, in points.
  cost: ArrayLike<number>;
}

// A candidate priced for one outlook.
interface Priced {
  net: number; // reward less the cost of its missing tiles
  // The most it could be worth with one of its missing tiles free.
  upper: number;
  size: number; // tiles to buy
  // Its (letter, count) pairs in the candidate set, [from, to).
  from: number;
  to: number;
}

// Most priced candidates scanned per sample: bounds the time an outlook
// takes when a rack is near many words.
const MAX_PRICED = 4000;

// Monte Carlo: sample the next `horizon` tiles from the unseen pool, assume
// the bot can buy up to `buys` of them at `cost` each, and take the best
// word it could then spell (or nothing, worth 0). A letter's value is how
// much getting one more of it, free, raises that on average: the purchase
// it saves, or the better word it opens up.
export function outlook(
  lex: Lexicon,
  rack: Counts,
  pool: Counts,
  p: OutlookParams,
  rng: () => number = Math.random,
): Outlook {
  const buys = Math.max(0, Math.min(p.buys, p.horizon));
  const set = candidates(lex, rack, buys + 1);
  const { pairStart, pairLetter, pairCount } = set;
  const net = new Float64Array(set.n);
  const upper = new Float64Array(set.n);
  const keep: number[] = [];
  // The search already holds every word one tile away, so which letters
  // complete a long word comes free; searching again per letter made the
  // bot pause for up to half a second.
  const completes = new Uint8Array(26);
  for (let c = 0; c < set.n; c++) {
    if (lex.words[set.word[c]!]!.letters.length >= 7) {
      if (set.size[c] === 0) completes.fill(1);
      else if (set.size[c] === 1) completes[pairLetter[pairStart[c]!]!] = 1;
    }
    let v = lex.words[set.word[c]!]!.reward;
    let maxCost = 0;
    for (let i = pairStart[c]!; i < pairStart[c + 1]!; i++) {
      const x = p.cost[pairLetter[i]!]!;
      v -= x * pairCount[i]!;
      if (x > maxCost) maxCost = x;
    }
    net[c] = v;
    upper[c] = v + maxCost;
    if (v + maxCost > 0) keep.push(c);
  }
  // Only the best MAX_PRICED are scanned. A rack rebuilding from nothing
  // can be near 100,000 words, and sorting them all with a comparator took
  // ~50 ms per outlook, so first cut to those at or above the
  // MAX_PRICED-th best `upper` with a native numeric sort.
  let kept = keep;
  if (keep.length > MAX_PRICED) {
    const uppers = Float64Array.from(keep, (c) => upper[c]!).sort();
    const cutoff = uppers[uppers.length - MAX_PRICED]!;
    kept = keep.filter((c) => upper[c]! >= cutoff);
  }
  // Scanning in `upper` order lets a sample stop at the first candidate
  // that can't beat what it already has.
  kept.sort((a, b) => upper[b]! - upper[a]!);
  if (kept.length > MAX_PRICED) kept.length = MAX_PRICED;
  const priced: Priced[] = kept.map((c) => ({
    net: net[c]!,
    upper: upper[c]!,
    size: set.size[c]!,
    from: pairStart[c]!,
    to: pairStart[c + 1]!,
  }));

  const poolList: number[] = [];
  for (let i = 0; i < 26; i++) for (let n = 0; n < pool[i]!; n++) poolList.push(i);
  const horizon = Math.min(p.horizon, poolList.length);
  const samples = horizon === 0 ? 1 : p.samples;

  const letterValue = new Float64Array(26);
  const window = new Int16Array(26);
  const best = new Float64Array(26);
  let holdSum = 0;

  for (let s = 0; s < samples; s++) {
    // Partial Fisher-Yates: the first `horizon` entries are the sample.
    window.fill(0);
    for (let i = 0; i < horizon; i++) {
      const j = i + Math.floor(rng() * (poolList.length - i));
      const t = poolList[i]!;
      poolList[i] = poolList[j]!;
      poolList[j] = t;
      window[poolList[i]!]!++;
    }

    let hold = 0;
    best.fill(0);
    for (const c of priced) {
      if (c.upper <= hold) break;
      // How many needed tiles the window can't supply, and of which letter.
      let short = 0;
      let shortLetter = -1;
      for (let i = c.from; i < c.to && short < 2; i++) {
        const l = pairLetter[i]!;
        const gap = pairCount[i]! - window[l]!;
        if (gap > 0) {
          short += gap;
          shortLetter = l;
        }
      }
      if (short === 0) {
        if (c.size <= buys && c.net > hold) hold = c.net;
        // A free copy of any needed letter saves buying it.
        for (let i = c.from; i < c.to; i++) {
          const l = pairLetter[i]!;
          const v = c.net + p.cost[l]!;
          if (v > best[l]!) best[l] = v;
        }
      } else if (short === 1) {
        // The window lacks one tile: a free copy of it makes the word.
        const v = c.net + p.cost[shortLetter]!;
        if (v > best[shortLetter]!) best[shortLetter] = v;
      }
    }
    holdSum += hold;
    for (let l = 0; l < 26; l++) {
      if (best[l]! > hold) letterValue[l]! += best[l]! - hold;
    }
  }
  for (let l = 0; l < 26; l++) letterValue[l]! /= samples;
  return { hold: holdSum / samples, letterValue, completes };
}

// No word worth enough is reachable with a letter: see `closingNeeds`.
export const UNREACHABLE = 255;

// For each letter: how many more tiles, after winning one of it, the rack
// would still need to spell a word worth at least `minReward`, buying at
// most `maxNeed` tiles in all, each still unseen in `pool`. UNREACHABLE if
// no such word uses the letter. One search, not one per letter.
export function closingNeeds(
  lex: Lexicon,
  rack: Counts,
  pool: Counts,
  minReward: number,
  maxNeed: number,
): Uint8Array {
  const needs = new Uint8Array(26).fill(UNREACHABLE);
  const set = candidates(lex, rack, maxNeed);
  const { pairStart, pairLetter, pairCount } = set;
  for (let c = 0; c < set.n; c++) {
    if (set.size[c] === 0) continue; // spellable already: nothing to buy
    if (lex.words[set.word[c]!]!.reward < minReward) continue;
    const from = pairStart[c]!;
    const to = pairStart[c + 1]!;
    // Winning one `l` leaves the rest to come from the unseen tiles.
    for (let i = from; i < to; i++) {
      const l = pairLetter[i]!;
      let ok = true;
      for (let j = from; j < to && ok; j++) {
        const want = pairCount[j]! - (j === i ? 1 : 0);
        if (want > pool[pairLetter[j]!]!) ok = false;
      }
      const rest = set.size[c]! - 1;
      if (ok && rest < needs[l]!) needs[l] = rest;
    }
  }
  return needs;
}

// Remove a word's tiles from a copy of the rack.
export function without(rack: Counts, word: Word): Counts {
  const r = Int16Array.from(rack);
  for (const l of word.letters) r[l]!--;
  return r;
}

// Play greedily: best reward first, until nothing spells. For the end of a
// match, when every tile left on the rack is worth nothing.
export function dump(lex: Lexicon, rack: Counts): Word[] {
  const out: Word[] = [];
  let r = rack;
  for (;;) {
    const w = playable(lex, r)[0];
    if (!w) return out;
    out.push(w);
    r = without(r, w);
  }
}
