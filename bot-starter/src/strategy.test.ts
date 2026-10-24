// Checks for the engine and strategy. Run with `npm test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import {
  BAG,
  buildLexicon,
  countsOf,
  dump,
  letterIndex,
  outlook,
  playable,
  reward,
} from "./engine.js";
import {
  bidFor,
  chaseGap,
  choosePlays,
  DEFAULT_PARAMS,
  MARKET_PRICES,
  outlookFor,
  PRICE_PHASE,
  PROFILES,
  type MatchView,
} from "./strategy.js";

const fullLexicon = buildLexicon(
  fs
    .readFileSync(
      new URL("../../spacetimedb/wordlist.txt", import.meta.url),
      "utf8",
    )
    .split("\n"),
);
const pool = () => Int16Array.from(BAG);
const view = (rack: string, auctionsLeft: number, balance = 100): MatchView => ({
  rack: countsOf(rack),
  pool: pool(),
  auctionsLeft,
  balance,
});

test("reward matches the module's scoring", () => {
  assert.equal(reward("AT"), 2); // 1x
  assert.equal(reward("QUIT"), 19); // 13 * 1.5, rounded down
  assert.equal(reward("QUART"), 28); // 14 * 2
  assert.equal(reward("QUARTS"), 37); // 15 * 2.5, rounded down
  assert.equal(reward("QUARTET"), 48); // 16 * 3
  assert.equal(reward("QUARTETS"), 51); // 17 * 3, no more past 7
});

test("playable lists the words the rack spells, best first", () => {
  const lex = buildLexicon(["TACT", "CAT", "AT", "TACTS"]);
  assert.deepEqual(
    playable(lex, countsOf("TACT")).map((w) => w.text),
    ["TACT", "CAT", "AT"],
  );
  assert.deepEqual(playable(lex, countsOf("CX")), []);
});

test("dump plays words until nothing spells", () => {
  const lex = buildLexicon(["CAT", "DOG", "AT"]);
  assert.deepEqual(
    dump(lex, countsOf("CATDOGX"))
      .map((w) => w.text)
      .sort(),
    ["CAT", "DOG"],
  );
});

test("a letter that completes a word is worth about what it saves", () => {
  const lex = buildLexicon(["QUARTET"]);
  const cost = new Array(26).fill(5);
  const look = outlook(
    lex,
    countsOf("QUARTE"),
    pool(),
    { horizon: 10, buys: 2, samples: 200, cost },
    () => 0.5,
  );
  // Holding QUARTE: QUARTET if a T comes up (minus its cost), else nothing.
  // A free T makes it for sure.
  const t = look.letterValue[letterIndex("T")]!;
  assert.ok(t >= 5 && t <= 51, `T worth ${t}`);
  assert.equal(look.letterValue[letterIndex("Z")], 0);
});

test("the price phase covers a match: 98 tiles less 6 racks of 5", () => {
  assert.equal(PRICE_PHASE.length, 98 - 6 * 5);
  // Indexed by auctions left: the last auction, which nobody wants, first.
  assert.ok(PRICE_PHASE[0]! < 0.5);
  assert.ok(PRICE_PHASE[30]! < 1 && PRICE_PHASE[67]! > 1);
});

test("the price phase feeds into letter values", () => {
  // Mid-match tiles run cheaper than the median, so with the phase applied
  // a tile that saves a purchase is valued differently than at flat prices.
  const flat = { ...DEFAULT_PARAMS, phaseStrength: 0, samples: 300 };
  const phased = { ...DEFAULT_PARAMS, phaseStrength: 1, samples: 300 };
  const v = view("QUARE", 30);
  const rng = () => 0.37;
  const t = letterIndex("T");
  const flatValue = outlookFor(fullLexicon, v, flat, rng).letterValue[t]!;
  const phasedValue = outlookFor(fullLexicon, v, phased, rng).letterValue[t]!;
  assert.ok(phasedValue !== flatValue);
});

test("an empty rack still bids on ordinary letters", () => {
  // Planning only a few buys, an empty rack saw nothing but short words
  // and bid 0 on everything; it should plan to rebuild a long word.
  const v = view("", 55, 118);
  const look = outlookFor(fullLexicon, v);
  for (const letter of ["A", "E", "R", "S", "T"]) {
    assert.ok(bidFor(v, letter, look) > 0, `bid 0 on ${letter}`);
  }
});

test("a tile that finishes nothing yet is bid no higher than its price", () => {
  const v = view("ER", 40, 118);
  const look = outlookFor(fullLexicon, v);
  const z = bidFor(v, "Z", look);
  const cap = MARKET_PRICES[letterIndex("Z")]! * PRICE_PHASE[40]!;
  assert.ok(z <= Math.round(cap), `bid ${z} on Z, cap ${cap}`);
});

test("the outlook knows which letters complete a long word", () => {
  // Same answer as searching the rack plus each letter, which the outlook
  // already did as part of its own search.
  for (const rack of ["QUARTE", "AEINRS", "ER", "", "BCDFGHK", "QUARTET"]) {
    const look = outlookFor(fullLexicon, view(rack, 40));
    for (let l = 0; l < 26; l++) {
      const withIt = countsOf(rack);
      withIt[l]!++;
      const slow = playable(fullLexicon, withIt).some((w) => w.text.length >= 7);
      assert.equal(
        look.completes[l] === 1,
        slow,
        `${rack} + ${String.fromCharCode(65 + l)}`,
      );
    }
  }
});

test("a tile that completes a 7-letter word isn't capped", () => {
  // QUARTE + T spells QUARTET, so the T bid is the same with or without
  // the cap; the speculative Z is lower with it.
  const uncapped = { ...DEFAULT_PARAMS, speculativeCap: 0 };
  const v = view("QUARTE", 40, 100);
  const look = outlookFor(fullLexicon, v);
  assert.equal(
    bidFor(v, "T", look),
    bidFor(v, "T", look, uncapped),
  );
  const w = view("ER", 40, 118);
  const wl = outlookFor(fullLexicon, w);
  assert.ok(
    bidFor(w, "Z", wl) < bidFor(w, "Z", wl, uncapped),
  );
});

test("behind on tiles mid-match, the bot bids harder on letters it wants", () => {
  // 30 auctions left: 37 played, so a winner's pace is ~8 tiles.
  const behind = { ...view("AEINR", 30, 90), tilesWon: 3 };
  const onPace = { ...view("AEINR", 30, 90), tilesWon: 10 };
  const look = outlookFor(fullLexicon, behind);
  // Same outlook for both: only the pace differs. No letter's bid drops,
  // and some rise (letters at the speculative cap can't).
  let raised = 0;
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const b = bidFor(behind, letter, look);
    const o = bidFor(onPace, letter, look);
    assert.ok(b >= o, `${letter}: ${b} behind pace, ${o} on pace`);
    if (b > o) raised++;
  }
  assert.ok(raised > 0);
  // The boost never takes a bid into cash-in range: with 35 coins it adds
  // at most 10 (35 - 25), and never cuts a bid it would have made anyway.
  const low = { ...view("AEINR", 30, 35), tilesWon: 3 };
  const lowOnPace = { ...view("AEINR", 30, 35), tilesWon: 10 };
  const lowLook = outlookFor(fullLexicon, low);
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const b = bidFor(low, letter, lowLook);
    const o = bidFor(lowOnPace, letter, lowLook);
    assert.ok(b >= o && (b === o || b <= 35 - DEFAULT_PARAMS.cashInBalance));
  }
  // Early and late in the match there's no boost.
  const early = { ...view("AEINR", 60, 90), tilesWon: 0 };
  const earlyOnPace = { ...view("AEINR", 60, 90), tilesWon: 5 };
  const lookEarly = outlookFor(fullLexicon, early);
  assert.equal(bidFor(early, "S", lookEarly), bidFor(earlyOnPace, "S", lookEarly));
});

test("the endgame chase targets the next bot up, late only", () => {
  const at = (left: number, mine: number, others: number[]) => ({
    ...view("", left),
    scores: { mine, others },
  });
  assert.equal(chaseGap(at(4, 87, [96, 71, 69])), 9);
  assert.equal(chaseGap(at(4, 87, [120, 96, 71])), 9); // the next one up
  assert.equal(chaseGap(at(20, 87, [96])), undefined); // too early
  assert.equal(chaseGap(at(4, 100, [96, 71])), undefined); // leading
  assert.equal(chaseGap(view("", 4)), undefined); // scores unknown
});

test("a tile that brings a place-gaining word within reach gets a chase bid", () => {
  // Match 1014: 9 behind 1st with 37 coins near the end. Holding IM, an E
  // leaves ITEM/TIME/EMIT (+9) one T away.
  const scores = { mine: 87, others: [96, 71] };
  const chasing = { ...view("IM", 3, 37), scores };
  const calm = view("IM", 3, 37);
  const e = bidFor(chasing, "E", outlookFor(fullLexicon, chasing));
  // 60% of 37, but 16 kept back for the T: 21.
  assert.ok(e >= 37 - DEFAULT_PARAMS.chaseRestCost, `chase bid ${e}`);
  assert.ok(e > bidFor(calm, "E", outlookFor(fullLexicon, calm)));
});

test("leading late with an empty rack, the bot still spends its coins", () => {
  // Match 1077: leading with 52 coins and an empty rack, it bid 0 on
  // nearly every one of its last 8 auctions and was passed.
  const leading = { ...view("", 6, 52), scores: { mine: 89, others: [86, 73] } };
  const look = outlookFor(fullLexicon, leading);
  const bids = "AEIORST".split("").map((l) => bidFor(leading, l, look));
  assert.ok(bids.filter((b) => b >= 10).length >= 4, `bids ${bids}`);
});

test("late, a short rack values the short words it can still make", () => {
  // No scores: the endgame chase is off. With 6 auctions left a 7-letter
  // rebuild is out of reach, so short words set the values, not 0.
  const v = view("", 6, 52);
  const look = outlookFor(fullLexicon, v);
  assert.ok(look.letterValue.some((x) => x > 1));
});

test("late in a match, speculation is worth less than its price", () => {
  // 2 auctions left, only an S: the cap on a Z has shrunk to the share of
  // `lateSpecWindow` left.
  const left = 2;
  const v = view("S", left, 50);
  const z = bidFor(v, "Z", outlookFor(fullLexicon, v));
  const market = Math.round(MARKET_PRICES[letterIndex("Z")]! * PRICE_PHASE[left]!);
  const cap = Math.round(market * Math.min(1, left / DEFAULT_PARAMS.lateSpecWindow));
  assert.ok(cap < market && z <= cap, `bid ${z} on Z, cap ${cap}, market ${market}`);
});

test("chase bids reach the going price but keep coins for the rest", () => {
  // Empty rack, 4 left, 5 behind, 21 coins (match 1187): a common letter
  // that starts a closing word gets at least its market price.
  const v = { ...view("", 4, 21), scores: { mine: 81, others: [86] } };
  const look = outlookFor(fullLexicon, v);
  for (const letter of ["A", "E", "O"]) {
    const l = letterIndex(letter);
    const rest = look.chaseNeeds?.[l];
    if (rest === undefined || rest > 2) continue;
    const b = bidFor(v, letter, look);
    const market = Math.round(MARKET_PRICES[l]! * PRICE_PHASE[4]!);
    const forRest = 21 - rest * DEFAULT_PARAMS.chaseRestCost;
    assert.ok(b >= Math.min(market, forRest), `${letter}: bid ${b}`);
    assert.ok(b <= Math.max(forRest, 0) || b < market, `${letter}: bid ${b}`);
  }
});

test("down by more than common letters can make, coins still go to a scoring word", () => {
  // Match 1495: 14 behind, empty rack, 51 coins, 8 left. Only Z/X/J words
  // reach 14 from a few tiles; ordinary letters should still get bids.
  const v = { ...view("", 7, 51), scores: { mine: 84, others: [98, 109] } };
  const look = outlookFor(fullLexicon, v);
  const bids = "AEIORNST".split("").map((l) => bidFor(v, l, look));
  assert.ok(bids.filter((b) => b >= 10).length >= 4, `bids ${bids}`);
});

test("rebuilding with a middling balance, the rebuild profile still bids", () => {
  // Match 1761: empty rack, 58 coins, 43 left. Current pricing makes every
  // rebuild look like a loss; the rebuild profile bids near market.
  const v = view("", 43, 58);
  const current = PROFILES.current!;
  const rebuild = PROFILES.rebuild!;
  const before = "AEIRST".split("").map((l) => bidFor(v, l, outlookFor(fullLexicon, v, current), current));
  const after = "AEIRST".split("").map((l) => bidFor(v, l, outlookFor(fullLexicon, v, rebuild), rebuild));
  assert.ok(after.filter((b) => b >= 8).length >= 4, `rebuild bids ${after}`);
  assert.ok(after.reduce((a, b) => a + b) > before.reduce((a, b) => a + b));
  // A full rack isn't rebuilding: same bids either way.
  const full = view("AEIRST", 43, 58);
  const look = outlookFor(fullLexicon, full, current, () => 0.5);
  const look2 = outlookFor(fullLexicon, full, rebuild, () => 0.5);
  assert.equal(bidFor(full, "N", look, current), bidFor(full, "N", look2, rebuild));
});

test("no chase bids when the rack already spells enough", () => {
  // EEFLSY spells FLEYS (+22): playing it closes a 9-point gap.
  const scores = { mine: 87, others: [96] };
  const v = { ...view("EEFLSY", 5, 37), scores };
  assert.equal(outlookFor(fullLexicon, v).chaseNeeds, undefined);
});

test("a playable word that closes the gap is played at once", () => {
  const plays = choosePlays(fullLexicon, {
    ...view("TIMEZ", 6, 60),
    scores: { mine: 87, others: [96] },
  });
  const total = plays.reduce((s, w) => s + w.reward, 0);
  assert.ok(total >= 9, `played ${plays.map((w) => w.text)} for ${total}`);
});

test("the last auction gets no bid: its tile can't be played", () => {
  const v = view("QUARTE", 0);
  const look = outlookFor(fullLexicon, v);
  assert.equal(bidFor(v, "T", look), 0);
});

test("bids never exceed the balance", () => {
  const v = view("QUARTE", 30, 7);
  const look = outlookFor(fullLexicon, v);
  assert.ok(bidFor(v, "T", look) <= 7);
});

test("a 7-letter word is played as soon as it spells", () => {
  const plays = choosePlays(fullLexicon, view("QUARTETZ", 50));
  assert.equal(plays[0]?.text.length, 7);
});

test("a broke bot cashes in a decent word at any point", () => {
  // Match 537 held MYXOID (+47) for 30 auctions with 14 coins.
  const broke = choosePlays(fullLexicon, view("DIMOXY", 30, 14));
  assert.equal(broke[0]?.text, "MYXOID");
  // Exactly at the threshold counts as broke: the boost stops there.
  const atLimit = choosePlays(fullLexicon, view("DIMOXY", 30, 25));
  assert.equal(atLimit[0]?.text, "MYXOID");
  // With coins to buy the rest of a longer word, it holds out early on.
  assert.deepEqual(choosePlays(fullLexicon, view("DIMOXY", 30, 100)), []);
});

test("a broke bot one affordable tile short of 7 letters keeps holding", () => {
  // QUARTE + T is QUARTET; 14 coins buys a T, so QUART isn't cashed in.
  assert.deepEqual(choosePlays(fullLexicon, view("QUARTE", 30, 14)), []);
});

test("short words are held early and dumped at the end", () => {
  assert.deepEqual(choosePlays(fullLexicon, view("CAT", 50)), []);
  const end = choosePlays(fullLexicon, view("CATDOG", 0));
  assert.ok(end.length >= 1);
});

// The bot can't see a match move on while it thinks, so a slow outlook
// means bids that miss their 1-second auction.
test("an outlook takes well under an auction", () => {
  // Empty and short racks plan the most buys, over the longest horizon.
  for (const rack of ["", "Y", "AEINR", "EEIOUA", "AEIRST", "BCDFGHK", "STRAINDX"]) {
    const v = view(rack, 40);
    const start = performance.now();
    outlookFor(fullLexicon, v, DEFAULT_PARAMS);
    const ms = performance.now() - start;
    assert.ok(ms < 250, `outlook for ${rack} took ${ms.toFixed(0)} ms`);
  }
});
