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
  choosePlays,
  DEFAULT_PARAMS,
  MARKET_PRICES,
  outlookFor,
  PRICE_PHASE,
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
