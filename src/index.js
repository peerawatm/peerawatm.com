const ALLOWED_HOSTS = new Set([
  "peerawatm.com",
  "www.peerawatm.com",
  // `wrangler dev` serves the Worker from here.
  "localhost",
  "127.0.0.1",
]);

const PROBE_PREFIXES = ["/wp-", "/.env", "/.git"];

const FETCH_MODES = new Set(["navigate", "cors", "no-cors", "same-origin"]);

function isAllowedHost(hostname) {
  return ALLOWED_HOSTS.has(hostname);
}

function isHumanPayload(body) {
  if (typeof body.p !== "string" || !body.p.startsWith("/")) return false;
  if (typeof body.tz !== "string" || body.tz.length < 3) return false;
  if (!Number.isFinite(body.w) || !Number.isFinite(body.h)) return false;
  if (body.w < 320 || body.h < 240 || body.w > 10000 || body.h > 10000) return false;
  if (!Number.isFinite(body.ms) || body.ms < 0 || body.ms > 86400000) return false;
  if (typeof body.cid !== "string" || body.cid.length < 8) return false;
  return true;
}

function flagPayload(body, ua) {
  const flags = [];
  if (!body.tz || body.tz.startsWith("Etc/") || body.tz === "Unknown") flags.push("tz");
  if (body.w <= 800 && body.h <= 600) flags.push("viewport");
  if (/HeadlessChrome|PhantomJS|Selenium|Playwright/i.test(ua)) flags.push("headless");
  if (/\bEdge\/\d/i.test(ua)) flags.push("ua_edge");
  if (body.ms < 3000) flags.push("dwell");
  if (body.wd === true) flags.push("webdriver");
  return flags.join(",");
}

async function handleHit(request, env, ctx, url) {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  // Browsers always send Sec-Fetch-Mode (sendBeacon uses no-cors). curl,
  // scanners, and most crawlers send none, so this rejects them cheaply.
  const mode = request.headers.get("sec-fetch-mode");
  if (!mode || !FETCH_MODES.has(mode)) {
    return new Response(null, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  if (!body || !isHumanPayload(body)) {
    return new Response(null, { status: 204 });
  }

  const self =
    url.hostname === "me.peerawatm.com" ||
    url.searchParams.get("me") === "1" ||
    (request.headers.get("cookie") || "").includes("me=1") ||
    (request.headers.get("user-agent") || "").includes("PeerawatAgent");

  const ua = request.headers.get("user-agent") || "";
  const flags = flagPayload(body, ua);

  const insert = env.DB.prepare(
    `INSERT INTO hits (ts, path, referrer, country, asn, ua, tz, webdriver, width, height, self, ms, cid, flags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      Date.now(),
      body.p.slice(0, 128),
      String(body.r || "").slice(0, 256),
      request.cf?.country || "",
      String(request.cf?.asn || ""),
      ua.slice(0, 256),
      body.tz.slice(0, 64),
      body.wd === true ? 1 : 0,
      body.w,
      body.h,
      self,
      Math.round(body.ms),
      body.cid.slice(0, 64),
      flags
    )
    .run();

  // The response returns immediately; waitUntil keeps the isolate alive long
  // enough for D1 to commit the row.
  ctx.waitUntil(insert.catch((err) => console.error("hit insert failed", err)));

  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!isAllowedHost(url.hostname)) {
      return new Response("Not found", { status: 404 });
    }

    if (PROBE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/hit") {
      return handleHit(request, env, ctx, url);
    }

    return env.ASSETS.fetch(request);
  },
};
