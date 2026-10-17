// 구글 시트(Apps Script)의 수업 데이터를 받아 사이트가 읽을 정적 파일로 나눠 저장한다.
//   data/meta.json            : 버전(만든 시각)·건수
//   data/list-{ko,en,ja}.json : 목록·검색용 (언어별 제목·활동 방법·준비물 + 분류)
//   data/detail/NN.json       : 상세 화면용 (유의점·팁·근거 등), 수업 id로 64묶음
// 사용: node scripts/build-data.mjs [Apps Script 주소]   (주소를 안 주면 GAS_URL 환경변수 → 기본 주소)
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";

const GAS_URL = process.argv[2] || process.env.GAS_URL ||
  "https://script.google.com/macros/s/AKfycbwH8ParKOTqjbi1RuDj6LX-RYWRD6aH_9_WZ7nkxICsg_6XYrhJzAKm0t1Uid4XyFq3FA/exec";
const OUT = new URL("../data/", import.meta.url);
const BUCKETS = 64;
const LANGS = ["ko", "en", "ja"];
const COMMON = ["id", "country", "curriculumArea", "playType", "place", "groupSize", "slotKey", "gradeGroup",
  "equipment", "videoId", "youtubeUrl", "defaultDur", "channel", "title_ko", "equip_ko"];
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

async function main() {
  const res = await fetch(GAS_URL + (GAS_URL.includes("?") ? "&" : "?") + "action=data&t=" + Date.now(), { redirect: "follow" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (!data || !data.ok || !data.activities) throw new Error("시트 응답이 올바르지 않습니다: " + JSON.stringify(data).slice(0, 200));

  const h = headersOf(data.activities);
  const rows = data.activities.r
    .map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]).filter(([k]) => k)))
    .filter(o => String(o.id || "").trim());
  if (rows.length < 10) throw new Error("수업이 " + rows.length + "건뿐이라 발행을 멈춥니다(시트 확인 필요).");

  const val = v => (v === null || v === undefined) ? "" : (typeof v === "string" ? v.trim() : v);
  await rm(new URL("detail/", OUT), { recursive: true, force: true });
  await mkdir(new URL("detail/", OUT), { recursive: true });

  for (const L of LANGS) {
    const cols = [...new Set([...COMMON, "title_" + L, "rules_" + L, "equip_" + L])];
    const out = { h: cols, r: rows.map(o => cols.map(c => val(o[c]))) };
    await writeFile(new URL(`list-${L}.json`, OUT), JSON.stringify(out));
  }

  const buckets = Array.from({ length: BUCKETS }, () => ({}));
  for (const o of rows) {
    const d = {};
    for (const c of DETAIL) { const v = val(o[c]); if (v !== "") d[c] = v; }
    buckets[bucketOf(o.id)][String(o.id).trim()] = d;
  }
  for (let i = 0; i < BUCKETS; i++) {
    await writeFile(new URL(`detail/${String(i).padStart(2, "0")}.json`, OUT), JSON.stringify(buckets[i]));
  }

  // 내용이 그대로면 버전을 바꾸지 않는다(불필요한 커밋·캐시 무효화 방지)
  const sig = JSON.stringify(rows).length + ":" + rows.length + ":" + simpleHash(JSON.stringify(rows));
  let prev = null;
  try { prev = JSON.parse(await readFile(new URL("meta.json", OUT), "utf8")); } catch (e) {}
  if (prev && prev.sig === sig) { console.log(`수업 ${rows.length}건, 변경 없음 (버전 ${prev.v})`); return; }
  const v = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  await writeFile(new URL("meta.json", OUT), JSON.stringify({ v, n: rows.length, at: data.at || "", buckets: BUCKETS, sig }));
  console.log(`수업 ${rows.length}건, 새 버전 ${v}`);
}

function simpleHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
