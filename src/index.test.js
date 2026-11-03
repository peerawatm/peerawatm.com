import test from "node:test";
import assert from "node:assert/strict";

import worker, { flagPayload, formatHits, isHumanPayload, readJson } from "./index.js";

const hit = {
  p: "/",
  tz: "Asia/Bangkok",
  w: 1440,
  h: 900,
  ms: 12000,
  cid: "abcdefgh",
};

test("accepts a well-formed hit", () => {
  assert.equal(isHumanPayload(hit), true);
});

test("rejects malformed hits", () => {
  assert.equal(isHumanPayload({ ...hit, p: "outlier" }), false);
  assert.equal(isHumanPayload({ ...hit, tz: "~" }), false);
  assert.equal(isHumanPayload({ ...hit, w: "1440" }), false);
  assert.equal(isHumanPayload({ ...hit, w: 10001 }), false);
  assert.equal(isHumanPayload({ ...hit, ms: -1 }), false);
  assert.equal(isHumanPayload({ ...hit, cid: "short" }), false);
  assert.equal(isHumanPayload(null), false);
});

test("flags a clean desktop visit", () => {
  assert.equal(flagPayload(hit, "Mozilla/5.0 (Macintosh) Chrome/140.0 Safari/537.36"), "");
});

test("flags automation and short dwells", () => {
  assert.equal(flagPayload({ ...hit, ms: 100 }, "HeadlessChrome/140"), "headless,dwell");
  assert.equal(flagPayload({ ...hit, ms: 100 }, "Mozilla/5.0 Edge/18.19041"), "ua_edge,dwell");
  assert.equal(flagPayload({ ...hit, wd: true }, "Mozilla/5.0"), "webdriver");
  assert.equal(flagPayload({ ...hit, w: 800, h: 600 }, "Mozilla/5.0"), "viewport");
  assert.equal(flagPayload({ ...hit, tz: "Etc/UTC" }, "Mozilla/5.0"), "tz");
});

test("readJson parses within the cap", async () => {
  const request = new Request("https://www.peerawatm.com/hit", {
    method: "POST",
    body: JSON.stringify(hit),
  });
  assert.deepEqual(await readJson(request, 2048), hit);
});

test("readJson rejects an oversized body", async () => {
  const request = new Request("https://www.peerawatm.com/hit", {
    method: "POST",
    body: "x".repeat(4096),
  });
  assert.equal(await readJson(request, 2048), undefined);
});

test("readJson returns null for invalid JSON", async () => {
  const request = new Request("https://www.peerawatm.com/hit", {
    method: "POST",
    body: "{",
  });
  assert.equal(await readJson(request, 2048), null);
});

test("readJson returns null when the body stream fails", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error("boom"));
    },
  });
  const request = new Request("https://www.peerawatm.com/hit", {
    method: "POST",
    body,
    duplex: "half",
  });
  assert.equal(await readJson(request, 2048), null);
});

test("formatHits keeps attacker-controlled fields on one line", () => {
  const text = formatHits([
    { ts: 0, country: "TH", path: "/a\nforged", ms: 5000, cid: "x\ny" },
  ]);
  assert.equal(text.includes("\n"), false);
  assert.match(text, /\/a forged/);
});

const env = {
  DB: {
    prepare() {
      throw new Error("DB must not be touched for invalid requests");
    },
  },
  ASSETS: { fetch: () => new Response("asset") },
};
const ctx = { waitUntil() {} };

test("/hit rejects non-POST with Allow", async () => {
  const res = await worker.fetch(
    new Request("https://www.peerawatm.com/hit"),
    env,
    ctx
  );
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("/hit rejects a non-beacon fetch mode", async () => {
  const res = await worker.fetch(
    new Request("https://www.peerawatm.com/hit", {
      method: "POST",
      headers: { "sec-fetch-mode": "script" },
      body: "{}",
    }),
    env,
    ctx
  );
  assert.equal(res.status, 400);
});

test("/hit rejects an oversized body", async () => {
  const res = await worker.fetch(
    new Request("https://www.peerawatm.com/hit", {
      method: "POST",
      headers: { "sec-fetch-mode": "no-cors" },
      body: "x".repeat(4096),
    }),
    env,
    ctx
  );
  assert.equal(res.status, 413);
});

test("/hit accepts malformed JSON without inserting", async () => {
  const res = await worker.fetch(
    new Request("https://www.peerawatm.com/hit", {
      method: "POST",
      headers: { "sec-fetch-mode": "no-cors" },
      body: "{",
    }),
    env,
    ctx
  );
  assert.equal(res.status, 204);
});
