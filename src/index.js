const ALLOWED_HOSTS = new Set([
  "peerawatm.com",
  "www.peerawatm.com",
  // `wrangler dev` serves the Worker from here.
  "localhost",
  "127.0.0.1",
]);

const PROBE_PREFIXES = ["/wp-", "/.env", "/.git"];

const FETCH_MODES = new Set(["navigate", "cors", "no-cors", "same-origin"]);

const MAX_PAYLOAD_BYTES = 2048;

const RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

function isAllowedHost(hostname) {
  return ALLOWED_HOSTS.has(hostname);
}

function isHumanPayload(body) {
  if (!body || typeof body !== "object") return false;
  if (typeof body.p !== "string" || !body.p.startsWith("/")) return false;
  if (typeof body.tz !== "string" || body.tz.length < 3) return false;
  if (!Number.isFinite(body.w) || !Number.isFinite(body.h)) return false;
  if (body.w < 320 || body.h < 240 || body.w > 10000 || body.h > 10000) return false;
  if (!Number.isFinite(body.ms) || body.ms < 0 || body.ms > 86400000) return false;
  if (typeof body.cid !== "string" || body.cid.length < 8) return false;
  return true;
}

// Stream with a hard cap so an oversized or chunked body cannot be buffered.
async function readJson(request, max) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return undefined;
  if (!request.body) return null;
  let reader;
  try {
    reader = request.body.getReader();
  } catch {
    return null;
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
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

// Weekly check: stay quiet unless a row survives the human filter.
const HUMAN_FILTER = `self = 0 AND webdriver = 0 AND COALESCE(flags, '') = ''
    AND ts > ?`;
const HUMAN_SQL = `SELECT ts, country, path, cid, ms FROM hits
  WHERE ${HUMAN_FILTER}
  ORDER BY ts DESC LIMIT 10`;
const HUMAN_COUNT_SQL = `SELECT COUNT(*) AS n FROM hits WHERE ${HUMAN_FILTER}`;
const PRUNE_SQL = `DELETE FROM hits WHERE ts < ?`;

function oneLine(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ");
}

function formatHits(rows) {
  return rows
    .map((row) => {
      const when = new Date(row.ts).toISOString().slice(0, 16).replace("T", " ");
      const country = oneLine(row.country) || "??";
      const cid = oneLine(row.cid) || "-";
      return `${when}Z ${country} ${oneLine(row.path)} ${row.ms}ms ${cid}`;
    })
    .join("\n");
}

async function notify(env, title, text) {
  if (!env.HITS_WEBHOOK) return;
  const hook = new URL(env.HITS_WEBHOOK);
  const isNtfy = hook.hostname === "ntfy.sh" || hook.hostname.endsWith(".ntfy.sh");
  const res = await fetch(
    env.HITS_WEBHOOK,
    isNtfy
      ? {
          method: "POST",
          body: text,
          headers: { title, tags: "eyes" },
          signal: AbortSignal.timeout(10000),
        }
      : {
          method: "POST",
          body: JSON.stringify({ content: `${title}\n\`\`\`\n${text}\n\`\`\`` }),
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(10000),
        }
  );
  if (!res.ok) console.error("alert failed", res.status, await res.text());
}

async function handleHit(request, env, ctx, url) {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  // Advisory only: pre-2023 Safari omits sec-fetch-mode, so absence is allowed.
  const mode = request.headers.get("sec-fetch-mode");
  if (mode !== null && !FETCH_MODES.has(mode)) {
    return new Response(null, { status: 400 });
  }

  const body = await readJson(request, MAX_PAYLOAD_BYTES);
  if (body === undefined) {
    return new Response(null, { status: 413 });
  }
  if (!body || !isHumanPayload(body)) {
    return new Response(null, { status: 204 });
  }

  const self =
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

  // waitUntil keeps the isolate alive for the D1 write.
  ctx.waitUntil(insert.catch((err) => console.error("hit insert failed", err)));

  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export { flagPayload, formatHits, isHumanPayload, readJson };

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

  async scheduled(event, env, ctx) {
    // Eight days: a weekly run cannot miss edge rows; overlaps may double-report.
    const since = Date.now() - 8 * 24 * 60 * 60 * 1000;
    try {
      const count = Number(await env.DB.prepare(HUMAN_COUNT_SQL).bind(since).first("n")) || 0;
      const { results } = await env.DB.prepare(HUMAN_SQL).bind(since).all();
      console.log("hits cron", { since, count });
      await env.DB.prepare(PRUNE_SQL).bind(Date.now() - RETENTION_MS).run();
      if (count) {
        await notify(env, `peerawatm.com: ${count} human hit(s)`, formatHits(results));
      }
    } catch (err) {
      console.error("hits cron failed", err);
    }
  },
};
