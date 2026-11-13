// SubFill subtitle proxy — Cloudflare Worker (v2: InnerTube clients + watch-page fallback)
// GET https://<your-worker>.workers.dev/?v=VIDEO_ID[&lang=en][&debug=1]
export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Headers": "Content-Type" } });
    const url = new URL(req.url);
    if (url.pathname === "/transcribe") return transcribe(req, env, cors);
    const v = (url.searchParams.get("v") || "").trim();
    const lang = (url.searchParams.get("lang") || "en").trim();
    const debug = url.searchParams.get("debug") === "1";
    if (!/^[\w-]{11}$/.test(v)) return json({ error: "Thiếu hoặc sai tham số v (ID video 11 ký tự)." }, 400, cors);

    // Cache: a successful result is kept 30 days, so one lucky fetch serves everyone after.
    const cacheKey = new Request(`https://subfill-cache/${v}/${lang}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) { const h = new Headers(hit.headers); h.set("X-SubFill-Cache", "hit"); return new Response(hit.body, { status: 200, headers: h }); }

    const log = [];
    try {
      let tracks = [], title = v;
      for (let attempt = 1; attempt <= 3 && !tracks.length; attempt++) {
        for (const client of CLIENTS) {
          try {
            const r = await innertube(v, client);
            log.push(`#${attempt} ${client.name}: status=${r.status}${r.reason ? " (" + r.reason + ")" : ""}, tracks=${r.tracks.length}`);
            if (r.tracks.length) { tracks = r.tracks; title = r.title || title; break; }
          } catch (e) { log.push(`#${attempt} ${client.name}: lỗi ${e.message}`); }
        }
        if (!tracks.length && attempt < 3) await new Promise(r => setTimeout(r, 700 * attempt));
      }
      if (!tracks.length) {
        try {
          const r = await watchPage(v);
          log.push(`watchpage: tracks=${r.tracks.length}${r.flag ? " " + r.flag : ""}`);
          if (r.tracks.length) { tracks = r.tracks; title = r.title || title; }
        } catch (e) { log.push("watchpage: lỗi " + e.message); }
      }
      if (!tracks.length) return json({ error: "Không lấy được danh sách phụ đề từ YouTube.", log }, 404, cors);

      let cand = tracks.filter(t => (t.languageCode || "").startsWith(lang));
      if (!cand.length) return json({ error: "Không có phụ đề " + lang + ". Có: " + tracks.map(t => t.languageCode).join(", "), log }, 404, cors);
      cand.sort((a, b) => (a.kind === "asr") - (b.kind === "asr"));

      let segs = [], used = null;
      for (const t of cand) {
        const base = t.baseUrl.replace(/\\u0026/g, "&");
        for (const fmt of ["", "&fmt=srv3", "&fmt=json3"]) {
          const resp = await fetch(base + fmt, { headers: UA });
          const body = await resp.text();
          log.push(`timedtext ${t.kind || "manual"}${fmt || " (xml)"}: http=${resp.status}, bytes=${body.length}`);
          segs = fmt === "&fmt=json3" ? parseJson3(body) : parseXml(body);
          if (segs.length) { used = t; break; }
        }
        if (segs.length) break;
      }
      if (!segs.length) return json({ error: "Có danh sách phụ đề nhưng YouTube trả nội dung rỗng (thường do chặn IP máy chủ).", log }, 502, cors);

      const out = { id: v, title, kind: used.kind === "asr" ? "auto" : "manual", segs };
      const okHeaders = { ...cors, "Cache-Control": "public, max-age=2592000", "X-SubFill-Cache": "miss" };
      await cache.put(cacheKey, json(out, 200, okHeaders)).catch(() => {});
      if (debug) out.log = log;
      return json(out, 200, okHeaders);
    } catch (e) {
      return json({ error: "Worker lỗi: " + (e && e.message), log }, 502, cors);
    }
  },
};

/* POST /transcribe  (body: raw audio bytes, Content-Type audio/*; optional ?lang=en)
   Uses Cloudflare Workers AI Whisper. Needs an AI binding named "AI" on this Worker (Settings → Bindings → Workers AI). */
async function transcribe(req, env, cors) {
  if (req.method !== "POST") return json({ error: "Dùng POST với nội dung là file audio." }, 405, cors);
  if (!env || !env.AI) return json({ error: "Worker chưa có binding Workers AI. Vào Cloudflare → Worker subfill → Settings → Bindings → Add → Workers AI, đặt tên biến là AI, rồi Deploy lại." }, 501, cors);
  const buf = await req.arrayBuffer();
  if (buf.byteLength < 1000) return json({ error: "File audio rỗng." }, 400, cors);
  if (buf.byteLength > 25 * 1024 * 1024) return json({ error: "File quá lớn (giới hạn 25 MB). Hãy cắt ngắn hoặc nén 64 kbps." }, 413, cors);
  const lang = new URL(req.url).searchParams.get("lang") || "en";
  // 1) whisper-large-v3-turbo: base64 input, returns segments + word timestamps
  try {
    const b64 = toBase64(buf);
    const r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: b64, task: "transcribe", language: lang, vad_filter: "true" });
    const segs = (r.segments || []).map(s => ({ start: +s.start, end: +s.end, text: (s.text || "").trim(), nsp: s.no_speech_prob,
      words: (s.words || []).map(w => ({ w: (w.word || "").trim(), s: +w.start, e: +w.end })) })).filter(s => s.text);
    if (segs.length) return json({ model: "whisper-large-v3-turbo", text: r.text, segs }, 200, cors);
  } catch (e) { var err1 = e && e.message; }
  // 2) fallback: classic whisper (byte array input, word timestamps only)
  try {
    const r = await env.AI.run("@cf/openai/whisper", { audio: [...new Uint8Array(buf)] });
    const words = (r.words || []).map(w => ({ w: (w.word || "").trim(), s: +w.start, e: +w.end })).filter(w => w.w);
    if (words.length) return json({ model: "whisper", text: r.text, segs: [{ start: words[0].s, end: words[words.length - 1].e, text: r.text, words }] }, 200, cors);
    return json({ error: "Whisper không nhận ra lời nói nào trong file." }, 422, cors);
  } catch (e) {
    return json({ error: "Whisper lỗi: " + (err1 ? err1 + " / " : "") + (e && e.message) }, 502, cors);
  }
}
function toBase64(buf) {
  const bytes = new Uint8Array(buf); let bin = ""; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};
const CLIENTS = [
  { name: "ANDROID", ctx: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en", gl: "US" }, ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip", idName: 3 },
  { name: "TVHTML5", ctx: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0", hl: "en", gl: "US" }, ua: UA["User-Agent"], idName: 85, embed: true },
  { name: "IOS", ctx: { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82", hl: "en", gl: "US" }, ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)", idName: 5 },
  { name: "WEB", ctx: { clientName: "WEB", clientVersion: "2.20250312.04.00", hl: "en", gl: "US" }, ua: UA["User-Agent"], idName: 1 },
];

async function innertube(v, client) {
  const body = { context: { client: client.ctx }, videoId: v, contentCheckOk: true, racyCheckOk: true };
  if (client.embed) body.context.thirdParty = { embedUrl: "https://www.youtube.com/" };
  const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": client.ua, "X-YouTube-Client-Name": String(client.idName), "X-YouTube-Client-Version": client.ctx.clientVersion, "Accept-Language": "en-US,en;q=0.9", "Origin": "https://www.youtube.com" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return { status: data?.playabilityStatus?.status || r.status, reason: data?.playabilityStatus?.reason, tracks, title: data?.videoDetails?.title };
}

async function watchPage(v) {
  const html = await (await fetch(`https://www.youtube.com/watch?v=${v}&hl=en&bpctr=9999999999&has_verified=1`, { headers: { ...UA, Cookie: "CONSENT=YES+cb; SOCS=CAI" } })).text();
  const flag = /confirm you.re not a bot|consent\.youtube\.com/i.test(html) ? "(bị chặn bot/consent)" : "";
  const tm = html.match(/<title>(.*?)<\/title>/);
  return { tracks: extractTracks(html), title: tm ? decode(tm[1]).replace(/\s*-\s*YouTube\s*$/, "").trim() : "", flag };
}

function json(obj, status, headers) { return new Response(JSON.stringify(obj), { status, headers }); }

function extractTracks(html) {
  const key = '"captionTracks":';
  const i = html.indexOf(key); if (i < 0) return [];
  let j = i + key.length, depth = 0; const start = j;
  for (; j < html.length; j++) { const c = html[j]; if (c === "[") depth++; else if (c === "]") { depth--; if (depth === 0) { j++; break; } } }
  try { return JSON.parse(html.slice(start, j)); } catch { return []; }
}

function decode(s) {
  const map = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  const once = t => t.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return String.fromCodePoint(n); }
    return map[e.toLowerCase()] ?? m;
  });
  return once(once(s));
}
const clean = s => decode(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

function parseXml(xml) {
  const out = []; let m;
  const re = /<text start="([\d.]+)"(?: dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  while ((m = re.exec(xml))) { const text = clean(m[3]); if (text) out.push({ start: +m[1], dur: m[2] ? +m[2] : 3, text }); }
  if (!out.length) {
    const re3 = /<p t="(\d+)"(?: d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
    while ((m = re3.exec(xml))) { const text = clean(m[3]); if (text) out.push({ start: +m[1] / 1000, dur: m[2] ? +m[2] / 1000 : 3, text }); }
  }
  return out;
}
function parseJson3(txt) {
  try {
    const d = JSON.parse(txt); const out = [];
    for (const ev of d.events || []) {
      const text = (ev.segs || []).map(s => s.utf8).join("").replace(/\s+/g, " ").trim();
      if (text) out.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 3000) / 1000, text });
    }
    return out;
  } catch { return []; }
}
