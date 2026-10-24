// Offline match simulator, for tuning ./strategy.ts without the live server.
//
//   npm run sim -- [matches] [param=value ...]
//   e.g. npm run sim -- 100 pointsPerCoin=0.5 maxBuys=4
//
// PROFILE=<name> starts from a profile in ./strategy.ts instead of the
// default. FIRST_PRICE=1 makes the winner pay its own bid; the market's
// bids stay as they were under Vickrey payment.
//
// It plays the module's rules for one bot: a 98-tile bag, 5 tiles dealt to
// each of 6 seats, one auction per remaining tile, Vickrey payment, and the
// match ending as the last auction closes. The other five seats are a
// market: the price to beat for each tile is a real one for that letter
// from about the same point in a past match (sim/market.json, from recent
// lobby matches; see its `source`). The market doesn't react to this bot,
// so treat results as relative, not absolute.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BAG,
  buildLexicon,
  emptyCounts,
  letterIndex,
  total,
  without,
  type Counts,
  type Lexicon,
} from "./engine.js";
import {
  bidFor,
  choosePlays,
  DEFAULT_PARAMS,
  outlookFor,
  PROFILES,
  type MatchView,
  type Params,
} from "./strategy.js";

const SEATS = 6;
const RACK = 5;
const START_BALANCE = 100;
const RESERVE = 1;

const here = path.dirname(fileURLToPath(import.meta.url));

// Seeded so runs with different params face the same tiles and prices.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Past top bids by letter, each with the auction's position in its match,
// and the final scores of each past match.
interface Market {
  bids: Map<string, { index: number; bid: number }[]>;
  scores: number[][];
}

export function loadMarket(): Market {
  const file = path.join(here, "..", "sim", "market.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
    bids: [number, string, number][];
    scores: number[][];
  };
  const bids: Market["bids"] = new Map();
  for (const [index, letter, bid] of data.bids) {
    let list = bids.get(letter);
    if (!list) bids.set(letter, (list = []));
    list.push({ index, bid });
  }
  return { bids, scores: data.scores };
}

// Where `score` would have finished in a past match, taking one of its six
// seats: 1 for first, with ties sharing the better place.
function placeIn(market: Market, score: number, rng: () => number): number {
  const past = market.scores[Math.floor(rng() * market.scores.length)]!;
  const others = [...past];
  others.splice(Math.floor(rng() * others.length), 1);
  return 1 + others.filter((s) => s > score).length;
}

// A past top bid for `letter` from within `spread` auctions of `index`,
// or from anywhere if there's none that close.
function priceToBeat(
  market: Market,
  letter: string,
  index: number,
  rng: () => number,
  spread = 8,
): number {
  const all = market.bids.get(letter) ?? [];
  const near = all.filter((b) => Math.abs(b.index - index) <= spread);
  const from = near.length > 0 ? near : all;
  if (from.length === 0) return 0;
  return from[Math.floor(rng() * from.length)]!.bid;
}

export interface MatchResult {
  score: number;
  place: number;
  won: number;
  spent: number;
  coinsLeft: number;
  tilesLeft: number;
  words: string[];
}

export function simulateMatch(
  lex: Lexicon,
  market: Market,
  params: Params,
  seed: number,
  firstPrice = false,
): MatchResult {
  // Tiles and prices from one stream, the strategy's sampling from another,
  // so a change of params doesn't change the match it plays.
  const world = mulberry32(seed);
  const think = mulberry32(seed ^ 0x9e3779b9);

  const bag: number[] = [];
  BAG.forEach((n, l) => {
    for (let i = 0; i < n; i++) bag.push(l);
  });
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(world() * (i + 1));
    [bag[i], bag[j]] = [bag[j]!, bag[i]!];
  }
  let rack: Counts = emptyCounts();
  for (let i = 0; i < RACK; i++) rack[bag.pop()!]!++;
  // Opponents' starting tiles: dealt, never seen.
  bag.splice(bag.length - RACK * (SEATS - 1));

  // What the bot can see: the bag less its own tiles and everything
  // auctioned. Opponents' hidden tiles stay in, as they do live.
  const pool = Int16Array.from(BAG);
  for (let i = 0; i < 26; i++) pool[i]! -= rack[i]!;

  let balance = START_BALANCE;
  let score = 0;
  let won = 0;
  let spent = 0;
  const words: string[] = [];
  const auctions = bag.length;
  for (let index = 0; index < auctions; index++) {
    const tile = bag.pop()!;
    const letter = String.fromCharCode(65 + tile);
    pool[tile]!--;
    const view: MatchView = {
      rack,
      pool,
      auctionsLeft: auctions - index - 1,
      balance,
      tilesWon: won,
      firstPrice,
    };
    for (const w of choosePlays(lex, view, params, think)) {
      rack = without(rack, w);
      balance += w.reward;
      score += w.reward;
      words.push(w.text);
    }
    const after: MatchView = { ...view, rack, balance };
    const look = outlookFor(lex, after, params, think);
    const bid = bidFor(after, letter, look, params);
    const price = priceToBeat(market, letter, index, world);
    if (bid > price || (bid === price && bid > 0 && world() < 0.5)) {
      const paid = firstPrice ? bid : price > 0 ? price : Math.min(RESERVE, bid);
      balance -= paid;
      spent += paid;
      won++;
      rack = Int16Array.from(rack);
      rack[letterIndex(letter)]!++;
    }
  }
  return {
    score,
    place: placeIn(market, score, world),
    won,
    spent,
    coinsLeft: balance,
    tilesLeft: total(rack),
    words,
  };
}

export function parseParams(args: string[], base: Params = DEFAULT_PARAMS): Params {
  const params: Params = { ...base };
  for (const arg of args) {
    const [key, value] = arg.split("=");
    const isTable = key === "prices" || key === "phase";
    if (!key || value === undefined || !(key in params) || isTable) {
      throw new Error(`unknown param '${arg}'`);
    }
    (params as unknown as Record<string, number | boolean>)[key] =
      typeof params[key as keyof Params] === "boolean" ? value === "true" : Number(value);
  }
  return params;
}

function main() {
  const [first, ...rest] = process.argv.slice(2);
  const matches = first && !first.includes("=") ? Number(first) : 50;
  const profile = process.env.PROFILE ?? "current";
  const base = PROFILES[profile];
  if (!base) throw new Error(`unknown PROFILE '${profile}'`);
  const firstPrice = process.env.FIRST_PRICE === "1";
  const params = parseParams(first?.includes("=") ? [first, ...rest] : rest, base);
  const lex = buildLexicon(
    fs
      .readFileSync(path.join(here, "..", "..", "spacetimedb", "wordlist.txt"), "utf8")
      .split("\n"),
  );
  const market = loadMarket();
  const results: MatchResult[] = [];
  const start = performance.now();
  for (let i = 0; i < matches; i++) {
    results.push(simulateMatch(lex, market, params, 1000 + i, firstPrice));
  }
  const mean = (f: (r: MatchResult) => number) =>
    results.reduce((s, r) => s + f(r), 0) / results.length;
  const scores = results.map((r) => r.score).sort((a, b) => a - b);
  const q = (f: number) => scores[Math.floor(f * (scores.length - 1))];
  const lengths = new Map<number, number>();
  for (const r of results) {
    for (const w of r.words) lengths.set(w.length, (lengths.get(w.length) ?? 0) + 1);
  }
  console.log(
    JSON.stringify({
      matches,
      profile,
      firstPrice,
      score: Number(mean((r) => r.score).toFixed(1)),
      firsts: Number(mean((r) => (r.place === 1 ? 1 : 0)).toFixed(2)),
      place: Number(mean((r) => r.place).toFixed(2)),
      p10: q(0.1),
      p50: q(0.5),
      p90: q(0.9),
      won: Number(mean((r) => r.won).toFixed(1)),
      spent: Number(mean((r) => r.spent).toFixed(1)),
      coinsLeft: Number(mean((r) => r.coinsLeft).toFixed(1)),
      tilesLeft: Number(mean((r) => r.tilesLeft).toFixed(1)),
      wordLengths: Object.fromEntries([...lengths].sort((a, b) => a[0] - b[0])),
      secondsPerMatch: Number(((performance.now() - start) / 1000 / matches).toFixed(2)),
      params: { ...params, prices: undefined, phase: undefined },
    }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
