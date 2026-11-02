// 매주 추천 검색어 만들기 → data/trending.json
// 근거: 선생님들이 실제로 누른 반응(추천·저장·후기)
//   - 이번 달·지난달 반응(data/social.json 의 monthly)을 크게, 전체 누적 추천·저장·후기는 작게 반영
//   - 후보 낱말이 제목(한국어)에 들어간 수업들의 점수를 더한 뒤, 수업 수가 많은 낱말이 무조건 이기지 않도록 √(수업 수)로 나눔
//   - 같은 기기가 여러 번 누른 것은 시트 단계에서 이미 1번으로 정리됨(추천·저장은 기기당 1회)
// 로그인이 없어서 기기 단위 집계다. 개인 맞춤이 아니라 전체 경향만 본다.
import { readFile, writeFile } from "node:fs/promises";

const OUT = new URL("../data/", import.meta.url);
const TOP = 9;

// 후보 낱말: 한국어 낱말로 제목을 찾고, 화면에는 언어별 이름을 보여 준다
const VOCAB = {
  "협동": { en: "Co-op", ja: "協力" },
  "가위바위보": { en: "Rock-Paper-Scissors", ja: "じゃんけん" },
  "훌라후프": { en: "Hula Hoop", ja: "フラフープ" },
  "피구": { en: "Dodgeball", ja: "ドッジボール" },
  "릴레이": { en: "Relay", ja: "リレー" },
  "술래잡기": { en: "Tag", ja: "鬼ごっこ" },
  "킨볼": { en: "Kin-Ball", ja: "キンボール" },
  "줄넘기": { en: "Jump Rope", ja: "なわとび" },
  "전래놀이": { en: "Traditional Play", ja: "伝統遊び" },
  "축구": { en: "Soccer", ja: "サッカー" },
  "농구": { en: "Basketball", ja: "バスケットボール" },
  "배구": { en: "Volleyball", ja: "バレーボール" },
  "티볼": { en: "T-ball", ja: "ティーボール" },
  "플로어볼": { en: "Floorball", ja: "フロアボール" },
  "플라잉디스크": { en: "Flying Disc", ja: "フライングディスク" },
  "배드민턴": { en: "Badminton", ja: "バドミントン" },
  "피클볼": { en: "Pickleball", ja: "ピックルボール" },
  "핸드볼": { en: "Handball", ja: "ハンドボール" },
  "럭비": { en: "Rugby", ja: "ラグビー" },
  "콩주머니": { en: "Beanbag", ja: "お手玉" },
  "풍선": { en: "Balloon", ja: "風船" },
  "파라슈트": { en: "Parachute", ja: "パラシュート" },
  "스카프": { en: "Scarf", ja: "スカーフ" },
  "매트": { en: "Mat", ja: "マット" },
  "뜀틀": { en: "Vaulting Box", ja: "跳び箱" },
  "철봉": { en: "Bar", ja: "鉄棒" },
  "평균대": { en: "Balance Beam", ja: "平均台" },
  "장애물": { en: "Obstacle Course", ja: "障害物" },
  "달리기": { en: "Running", ja: "かけっこ" },
  "던지기": { en: "Throwing", ja: "投げる" },
  "준비운동": { en: "Warm-Up", ja: "準備運動" },
  "표현": { en: "Expression", ja: "表現" },
  "리듬": { en: "Rhythm", ja: "リズム" },
  "댄스": { en: "Dance", ja: "ダンス" },
  "균형": { en: "Balance", ja: "バランス" },
  "팀빌딩": { en: "Team Building", ja: "チームビルディング" },
  "표적": { en: "Target", ja: "的当て" },
  "보물": { en: "Treasure", ja: "宝" },
  "얼음땡": { en: "Freeze Tag", ja: "氷鬼" },
};

async function readJson(name, def) {
  try { return JSON.parse(await readFile(new URL(name, OUT), "utf8")); } catch (e) { return def; }
}

function kstMonth(offset = 0) {
  const d = new Date(Date.now() + 9 * 3600e3);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.getUTCMonth() + 1;
}

async function main() {
  const list = await readJson("list-ko.json", null);
  const social = await readJson("social.json", {});
  if (!list || !list.r) throw new Error("data/list-ko.json 이 없습니다");
  const h = list.h, iId = h.indexOf("id"), iTitle = h.indexOf("title_ko");
  const likes = social.likes || {}, saves = social.saves || {}, stats = social.stats || {}, monthly = social.monthly || {};
  const thisM = monthly[String(kstMonth(0))] || {}, prevM = monthly[String(kstMonth(-1))] || {};

  // 수업별 점수: 최근 두 달 반응 ×3(이번 달) ×2(지난달) + 누적 저장 3·추천 2·후기 2 의 ×0.5
  const score = id => {
    const st = stats[id] || [];
    const reviews = Number(st[0]) || 0;
    const total = (Number(saves[id]) || 0) * 3 + (Number(likes[id]) || 0) * 2 + reviews * 2;
    return (Number(thisM[id]) || 0) * 3 + (Number(prevM[id]) || 0) * 2 + total * 0.5;
  };

  const rows = list.r.map(r => ({ id: r[iId], title: String(r[iTitle] || ""), s: score(r[iId]) })).filter(o => o.s > 0);
  const result = [];
  for (const [kw, lab] of Object.entries(VOCAB)) {
    const hit = list.r.filter(r => String(r[iTitle] || "").includes(kw)).length;
    if (hit < 5) continue; // 수업이 너무 적은 낱말은 눌러도 볼 게 없음
    const sum = rows.filter(o => o.title.includes(kw)).reduce((a, o) => a + o.s, 0);
    if (sum <= 0) continue;
    result.push({ ko: kw, en: lab.en, ja: lab.ja, score: Math.round(sum / Math.sqrt(hit) * 100) / 100, n: hit });
  }
  result.sort((a, b) => b.score - a.score || b.n - a.n);
  const top = result.slice(0, TOP);
  const out = { at: new Date().toISOString().slice(0, 10), basis: "추천·저장·후기(최근 두 달 가중)", keywords: top };
  await writeFile(new URL("trending.json", OUT), JSON.stringify(out, null, 1) + "\n");
  console.log("추천 검색어: " + top.map(k => `${k.ko}(${k.score})`).join(", "));
  if (top.length < 5) console.log("반응이 아직 적어 후보가 " + top.length + "개뿐입니다. 사이트는 부족한 만큼 기본 검색어로 채웁니다.");
}

main().catch(e => { console.error(e); process.exit(1); });
