// 구글 시트(Apps Script)의 수업 데이터를 받아 사이트가 읽을 정적 파일로 나눠 저장한다.
//   data/meta.json            : 버전(만든 시각)·건수
//   data/list-{ko,en,ja}.json : 목록·검색용 (언어별 제목·활동 방법·준비물 + 분류)
//   data/detail/NN.json       : 상세 화면용 (유의점·팁·근거 등), 수업 id로 64묶음
//   data/social.json          : 추천·저장 수와 활동별 후기 요약(개수·평균) — 목록 카드·인기순용
//   data/reviews/NN.json      : 후기 본문, 활동 id로 64묶음 (상세 화면을 열 때만 받음). 활동당 최신 200개
//   data/video-status.json    : 영상 점검 기록(유튜브 oEmbed). 두 번 연속 안 나오면 목록에서 뺀다
//   a/{id}.html                : 활동별 공유 미리보기 페이지(카톡용). 검색엔진에는 안 나오게 함(noindex) —
//                                검색 손님은 원래 영상(제작자)으로 가야 하므로
//   channelUrl                 : 영상 점검 때 받은 유튜브 채널 주소. 사이트에서 채널 이름을 누르면 채널로 이동
// 사용: node scripts/build-data.mjs [Apps Script 주소]   (주소를 안 주면 GAS_URL 환경변수 → 기본 주소)
//   CHECK_VIDEOS=0 이면 영상 점검을 건너뜀, CHECK_PER_RUN 으로 한 번에 점검할 개수 지정(기본 1000)
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";

const GAS_URL = process.argv[2] || process.env.GAS_URL ||
  "https://script.google.com/macros/s/AKfycbwH8ParKOTqjbi1RuDj6LX-RYWRD6aH_9_WZ7nkxICsg_6XYrhJzAKm0t1Uid4XyFq3FA/exec";
const OUT = new URL("../data/", import.meta.url);
const ROOT = new URL("../", import.meta.url);
const SITE_URL = (process.env.SITE_URL || "https://today-pe.com/").replace(/\/?$/, "/");
const CHECK_VIDEOS = process.env.CHECK_VIDEOS !== "0";
const CHECK_PER_RUN = Number(process.env.CHECK_PER_RUN || 1000);
const BUCKETS = 64;
const LANGS = ["ko", "en", "ja"];
const COMMON = ["id", "country", "curriculumArea", "playType", "place", "groupSize", "slotKey", "gradeGroup",
  "equipment", "videoId", "youtubeUrl", "defaultDur", "channel", "channelUrl", "title_ko", "equip_ko",
  // 새 분류(2026-10): 시트에는 JSON 배열 문자열, 목록 파일에는 쉼표로 이어 붙인 값
  "playModes", "sportTypes", "lessonStages", "requiredEquipment", "optionalEquipment", "mediaNeeds",
  // 2022 개정 교육과정 영역(운동·스포츠·표현)
  "curriculum2022"];
const CUR2022 = ["운동", "스포츠", "표현"];
const TAX = ["playModes", "sportTypes", "lessonStages", "requiredEquipment", "optionalEquipment", "mediaNeeds"];

// 시트 칸 값(JSON 배열 문자열 또는 쉼표 문자열)을 배열로
export function parseList(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  const s = String(v === undefined || v === null ? "" : v).trim();
  if (!s) return [];
  if (s[0] === "[") { try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(x => String(x).trim()).filter(Boolean); } catch (e) {} }
  return s.split(",").map(x => x.trim()).filter(Boolean);
}
const DETAIL = ["caution_ko", "caution_en", "caution_ja", "tip_ko", "tip_en", "tip_ja", "source", "videoTitle",
  "evidence", "confidence", "ai_ko", "ai_en", "ai_ja", "transcriptVerified"];

export function bucketOf(id) {
  let h = 5381;
  for (const ch of String(id)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h % BUCKETS;
}

function headersOf(tbl) {
  // 시트 머리글이 비어 있으면 updatedAt 뒤 두 칸을 channel, transcriptVerified로 본다(납품 32열 양식)
  const h = tbl.h.map(x => String(x || "").trim());
  const u = h.indexOf("updatedAt");
  if (u >= 0 && !h.includes("channel")) {
    if (!h[u + 1]) h[u + 1] = "channel";
    if (!h[u + 2] && !h.includes("transcriptVerified")) h[u + 2] = "transcriptVerified";
  }
  return h;
}

const gas = (q) => GAS_URL + (GAS_URL.includes("?") ? "&" : "?") + q + "&t=" + Date.now();
async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120000) });
      if (r.ok) return await r.json();
    } catch (e) {}
    await new Promise(res => setTimeout(res, 3000 * (i + 1)));
  }
  throw new Error("시트에서 받지 못했습니다: " + url.split("?")[1]);
}
const toObjs = tbl => { const h = headersOf(tbl); return tbl.r.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]).filter(([k]) => k))); };

// 수업 탭(수업, 수업2, 수업3…)을 탭마다 2,000줄씩 나눠 받는다. Apps Script가 예전 버전이면 한 번에 받는다.
async function fetchActivities() {
  const tabs = await getJson(gas("action=actTabs")).catch(() => null);
  if (tabs && tabs.ok && Array.isArray(tabs.tabs)) {
    const all = [];
    for (const t of tabs.tabs) {
      for (let off = 0; off < t.rows; off += 2000) {
        const page = await getJson(gas(`action=acts&tab=${encodeURIComponent(t.name)}&offset=${off}&limit=2000`));
        if (!page.ok) throw new Error(page.error || "탭 읽기 실패");
        all.push(...toObjs(page));
      }
      console.log(`탭 「${t.name}」 ${t.rows}줄`);
    }
    return { rows: all, at: new Date().toISOString().slice(0, 16).replace("T", " ") };
  }
  const data = await getJson(gas("action=data"));
  if (!data || !data.ok || !data.activities) throw new Error("시트 응답이 올바르지 않습니다: " + JSON.stringify(data).slice(0, 200));
  return { rows: toObjs(data.activities), at: data.at || "" };
}

async function main() {
  const got = await fetchActivities();
  const data = { at: got.at };
  const seen = new Set();
  const rows = got.rows
    .filter(o => String(o.id || "").trim() && String(o.status || "").trim() !== "숨김")
    .filter(o => { const id = String(o.id).trim(); if (seen.has(id)) { console.log("id 중복으로 뒤의 것 제외: " + id); return false; } seen.add(id); return true; });
  if (rows.length < 10) throw new Error("수업이 " + rows.length + "건뿐이라 발행을 멈춥니다(시트 확인 필요).");

  // ---- 영상 점검: 신고된 영상 → 처음 보는 영상 → 오래전에 본 영상 순으로 일부씩 확인 ----
  const status = await readJson(new URL("video-status.json", OUT), {});
  if (CHECK_VIDEOS) {
    const reported = await fetchReported();
    const vids = [...new Set(rows.map(o => String(o.videoId || "").trim()).filter(v => /^[A-Za-z0-9_-]{11}$/.test(v)))];
    const order = vids.sort((a, b) => rank(b) - rank(a) || String((status[a] || {}).t || "").localeCompare(String((status[b] || {}).t || "")));
    function rank(v) { return (reported[v] ? 2 : 0) + (status[v] ? 0 : 1); }
    const todo = order.slice(0, CHECK_PER_RUN);
    const today = new Date().toISOString().slice(0, 10);
    let done = 0, bad = 0;
    await pool(todo, 8, async v => {
      const got = await checkVideo(v);
      const s = typeof got === "object" ? got.s : got;
      if (s === "err") return;
      const prev = status[v] || {};
      const u = (typeof got === "object" && got.u) || prev.u;
      status[v] = s === "ok" ? Object.assign({ s, c: 0, t: today }, u ? { u } : {}) : Object.assign({ s, c: (prev.s === s ? (prev.c || 0) : 0) + 1, t: today }, u ? { u } : {});
      done++; if (s !== "ok") bad++;
    });
    console.log(`영상 점검 ${done}개 (안 나옴 ${bad}개)`);
    const lines = Object.keys(status).sort().map(k => JSON.stringify(k) + ":" + JSON.stringify(status[k]));
    await mkdir(OUT, { recursive: true });
    await writeFile(new URL("video-status.json", OUT), "{\n" + lines.join(",\n") + "\n}\n");
  }
  const isHidden = v => { const s = status[String(v || "").trim()]; return !!(s && s.s !== "ok" && (s.c || 0) >= 2); };
  const hidden = rows.filter(o => isHidden(o.videoId)).map(o => ({ id: String(o.id), videoId: o.videoId, s: status[String(o.videoId).trim()].s }));
  if (hidden.length) console.log(`영상이 안 나와 숨긴 수업 ${hidden.length}건`);
  const visible = rows.filter(o => !isHidden(o.videoId));
  visible.forEach(o => { const st = status[String(o.videoId || "").trim()]; if (st && st.u) o.channelUrl = st.u; });

  const val = v => (v === null || v === undefined) ? "" : (typeof v === "string" ? v.trim() : v);

  // 새 분류: 시트 칸이 비어 있으면 저장소의 분류 파일(data/taxonomy-migration.json)로 채운다(시트 값이 우선)
  const mig = (await readJson(new URL("taxonomy-migration.json", OUT), { items: {} })).items || {};
  let fromSheet = 0, fromMig = 0;
  for (const o of visible) {
    const id = String(o.id).trim();
    const sheetHas = TAX.some(f => parseList(o[f]).length);
    const m = !sheetHas && mig[id];
    for (const f of TAX) o[f] = (m ? parseList(m[f]) : parseList(o[f])).join(",");
    if (sheetHas) fromSheet++; else if (m) fromMig++;
    // 교육과정 영역(2022): 시트 값이 맞으면 그대로, 비었으면 분류 파일 값
    const c = String(o.curriculum2022 || "").trim();
    o.curriculum2022 = CUR2022.includes(c) ? c : (mig[id] && CUR2022.includes(mig[id].curriculum2022) ? mig[id].curriculum2022 : "");
  }
  console.log(`새 분류: 시트 ${fromSheet}건, 분류 파일 ${fromMig}건, 없음 ${visible.length - fromSheet - fromMig}건`);
  await rm(new URL("detail/", OUT), { recursive: true, force: true });
  await mkdir(new URL("detail/", OUT), { recursive: true });

  for (const L of LANGS) {
    const cols = [...new Set([...COMMON, "title_" + L, "rules_" + L, "equip_" + L])];
    const out = { h: cols, r: visible.map(o => cols.map(c => val(o[c]))) };
    await writeFile(new URL(`list-${L}.json`, OUT), JSON.stringify(out));
  }

  const buckets = Array.from({ length: BUCKETS }, () => ({}));
  for (const o of visible) {
    const d = {};
    for (const c of DETAIL) { const v = val(o[c]); if (v !== "") d[c] = v; }
    buckets[bucketOf(o.id)][String(o.id).trim()] = d;
  }
  for (let i = 0; i < BUCKETS; i++) {
    await writeFile(new URL(`detail/${String(i).padStart(2, "0")}.json`, OUT), JSON.stringify(buckets[i]));
  }

  await writeSharePages(visible, val);
  const social = await buildSocial(new Set(visible.map(o => String(o.id).trim())));

  // 내용이 그대로면 버전을 바꾸지 않는다(불필요한 커밋·캐시 무효화 방지). 목록과 후기는 버전을 따로 둔다
  const sig = JSON.stringify(visible).length + ":" + visible.length + ":" + simpleHash(JSON.stringify(visible));
  let prev = null;
  try { prev = JSON.parse(await readFile(new URL("meta.json", OUT), "utf8")); } catch (e) {}
  const listSame = prev && prev.sig === sig;
  const socialSame = !social ? true : (prev && prev.ssig === social.sig);
  if (listSame && socialSame) { console.log(`수업 ${visible.length}건, 변경 없음 (버전 ${prev.v})`); return; }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const meta = {
    v: listSame ? prev.v : stamp, n: visible.length, at: listSame ? prev.at : (data.at || ""), buckets: BUCKETS, sig, hidden,
    social: !!(social || (prev && prev.social)),
    sv: social ? (socialSame && prev ? prev.sv : stamp) : (prev && prev.sv) || "",
    sAt: social ? (socialSame && prev ? prev.sAt : social.since) : (prev && prev.sAt) || "",
    ssig: social ? social.sig : (prev && prev.ssig) || ""
  };
  await writeFile(new URL("meta.json", OUT), JSON.stringify(meta));
  console.log(`수업 ${visible.length}건, 목록 버전 ${meta.v}, 후기 버전 ${meta.sv || "-"}`);
}

// 추천·저장 수와 후기를 받아 요약 파일과 후기 묶음 파일을 만든다. Apps Script가 예전 버전이면 건너뜀(null)
async function buildSocial(ids) {
  const counts = await getJson(gas("action=counts")).catch(() => null);
  if (!counts || !counts.ok) { console.log("후기 요약: Apps Script 새 버전 배포 전이라 건너뜀"); return null; }
  // 발행 시작 시각(한국 시간, 시트의 createdAt과 같은 형식). 사이트는 이 시각 이후 후기만 시트에서 따로 받는다
  const kst = new Date(Date.now() + 9 * 3600 * 1000 - 5 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
  // 지금 파일 + 연도별 보관 파일(2026, 2027…)의 후기를 모두 모은다
  const srcs = await getJson(gas("action=reviewSources")).catch(() => null);
  const sources = srcs && srcs.ok ? srcs.sources : [{ src: "main", rows: null }];
  const all = [];
  for (const src of sources) {
    let total = src.rows === null ? 1 : src.rows;
    for (let off = 0; off < total; off += 2000) {
      const page = await getJson(gas(`action=reviewsPage&src=${encodeURIComponent(src.src)}&offset=${off}&limit=2000`));
      if (!page.ok) throw new Error(page.error || "후기 읽기 실패");
      total = page.total;
      all.push(...page.r.map(r => Object.fromEntries(page.h.map((k, i) => [k, r[i]]))));
    }
  }
  const H = ["reviewId", "activityId", "teacher", "grade", "fitScore", "rating", "duration", "sessionType",
    "caution_ko", "caution_en", "caution_ja", "tip_ko", "tip_en", "tip_ja", "createdAt"];
  const stats = {}, byAct = {};
  for (const r of all) {
    const a = String(r.activityId || "").trim();
    if (!ids.has(a)) continue;
    const st = stats[a] || (stats[a] = [0, 0, 0, 0, 0, 0, 0]); // 개수, 평점합, 적합도합, 시간합, 1~2·3~4·5~6학년
    st[0]++; st[1] += Number(r.rating) || 5; st[2] += Number(r.fitScore) || 5; st[3] += Number(r.duration) || 25;
    const gi = ["1~2학년", "3~4학년", "5~6학년"].indexOf(String(r.grade));
    if (gi >= 0) st[4 + gi]++;
    (byAct[a] = byAct[a] || []).push(H.map(k => r[k] === undefined || r[k] === null ? "" : r[k]));
  }
  const keep = id => ids.has(id);
  const likes = Object.fromEntries(Object.entries(counts.likes || {}).filter(([k, v]) => keep(k) && Number(v) > 0).map(([k, v]) => [k, Number(v)]));
  const saves = Object.fromEntries(Object.entries(counts.saves || {}).filter(([k, v]) => keep(k) && Number(v) > 0).map(([k, v]) => [k, Number(v)]));
  const socialJson = JSON.stringify({ likes, saves, stats });
  await writeFile(new URL("social.json", OUT), socialJson);

  await rm(new URL("reviews/", OUT), { recursive: true, force: true });
  await mkdir(new URL("reviews/", OUT), { recursive: true });
  const buckets = Array.from({ length: BUCKETS }, () => ({}));
  for (const [a, list] of Object.entries(byAct)) buckets[bucketOf(a)][a] = list.slice(-200);
  let bsig = "";
  for (let i = 0; i < BUCKETS; i++) {
    const txt = JSON.stringify({ h: H, acts: buckets[i] });
    bsig += simpleHash(txt);
    await writeFile(new URL(`reviews/${String(i).padStart(2, "0")}.json`, OUT), txt);
  }
  console.log(`후기 ${all.length}개, 추천 ${Object.keys(likes).length}·저장 ${Object.keys(saves).length}개 활동`);
  return { sig: simpleHash(socialJson + bsig), since: kst };
}

async function readJson(url, def) {
  try { return JSON.parse(await readFile(url, "utf8")); } catch (e) { return def; }
}

async function fetchReported() {
  try {
    const r = await fetch(GAS_URL + (GAS_URL.includes("?") ? "&" : "?") + "action=videoReports&t=" + Date.now(), { redirect: "follow" });
    const j = await r.json();
    return (j && j.ok && j.videos) || {};
  } catch (e) { return {}; }
}

// 유튜브 공식 oEmbed: 200 = 재생 가능, 401/403 = 퍼가기 막힘, 400/404 = 삭제·비공개
async function checkVideo(v) {
  const url = "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + v);
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (r.status === 200) {
        try { const j = await r.json(); if (j && /^https:\/\/www\.youtube\.com\//.test(j.author_url || "")) return { s: "ok", u: j.author_url }; } catch (e) {}
        return "ok";
      }
      if (r.status === 401 || r.status === 403) return "noembed";
      if (r.status === 400 || r.status === 404) return "gone";
    } catch (e) {}
    await new Promise(res => setTimeout(res, 1500));
  }
  return "err";
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } }));
}

const esc = s => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const short = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

// 활동마다 작은 공유 페이지: 카톡·문자에 붙이면 제목·설명·영상 썸네일이 미리보기로 뜨고, 열면 사이트의 그 활동으로 이동
async function writeSharePages(list, val) {
  const dir = new URL("a/", ROOT);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const urls = [];
  for (const o of list) {
    const id = String(o.id).trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
    const title = val(o.title_ko) || val(o.title_en) || id;
    const desc = short([val(o.rules_ko), val(o.equip_ko) && "준비물: " + val(o.equip_ko)].filter(Boolean).join(" "), 160);
    const page = SITE_URL + "a/" + id + ".html";
    const vid = String(o.videoId || "").trim();
    const html = `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | 오늘 체육 뭐 하지?</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="noindex, follow">
<meta property="og:type" content="article"><meta property="og:site_name" content="오늘 체육 뭐 하지?">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(page)}">${vid ? `
<meta property="og:image" content="https://i.ytimg.com/vi/${esc(vid)}/hqdefault.jpg">` : ""}
<meta name="twitter:card" content="summary_large_image">
<script>location.replace("../?id=${encodeURIComponent(id)}" + location.hash);</script>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6;color:#111827}a{color:#2563eb}</style>
</head><body>
<h1>${esc(title)}</h1>
<p>${esc(short(val(o.rules_ko), 600))}</p>
<p><a href="../?id=${encodeURIComponent(id)}">「오늘 체육 뭐 하지?」에서 수업 보기</a>${vid ? ` · <a href="https://www.youtube.com/watch?v=${esc(vid)}">원본 영상(${esc(val(o.channel) || "YouTube")})</a>` : ""}</p>
</body></html>
`;
    await writeFile(new URL(id + ".html", dir), html);
    urls.push(page);
  }
  // 사이트맵에는 첫 화면만 넣는다(활동별 페이지는 공유용이라 검색 노출 안 함)
  const sm = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${esc(SITE_URL)}</loc></url>
</urlset>
`;
  await writeFile(new URL("sitemap.xml", ROOT), sm);
  await writeFile(new URL("robots.txt", ROOT), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`);
}

function simpleHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
