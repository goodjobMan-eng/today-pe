/**
 * 오늘 체육 뭐 하지? — 구글 시트 DB (Apps Script 웹 앱)
 *
 * 탭 구성 (없으면 자동 생성, 기존 탭은 건드리지 않음)
 *   수업        : 사이트에 보이는 모든 수업. status 칸을 "숨김"으로 바꾸면 사이트에서 사라짐
 *   후기        : 선생님 후기. 등록 즉시 공개. deleted 칸이 Y면 숨김(관리자 삭제)
 *   추천        : 수업별 추천 수
 *   저장        : 수업별 저장 수
 *   반응기록    : 기기별 추천·저장 기록 (한 기기당 수업마다 추천 1번, 저장 1번. 취소하면 줄이 지워짐)
 *   새수업제안  : 새 수업 제안 (관리자 승인 후 수업 탭으로 이동)
 *   수정제안    : 기존 수업 설명 수정 제안 (관리자 승인 후 수업 탭에 반영)
 *
 * 관리자 비밀번호는 이 스크립트 안(스크립트 속성)에만 저장되고 사이트 소스에는 없습니다.
 */

const SHEET_ID = '1luIzrAEw2EQBuaMZv_5LvrvnMVsfEn6dZxUR7zPsQZI';
const DEFAULT_ADMIN_PIN = 'CHANGE_ME'; // 공개 저장소용 자리표시자. 실제 비밀번호는 Apps Script 편집기에서만 넣으세요
const TZ = 'Asia/Seoul';
const LANGS = ['ko', 'en', 'ja'];

const TABS = {
  activities: {
    name: '수업',
    headers: ['id', 'status', 'country', 'curriculumArea', 'playType', 'place', 'groupSize', 'slotKey', 'gradeGroup',
      'equipment', 'videoId', 'youtubeUrl', 'defaultDur',
      'title_ko', 'rules_ko', 'caution_ko', 'tip_ko', 'equip_ko',
      'title_en', 'rules_en', 'caution_en', 'tip_en', 'equip_en',
      'title_ja', 'rules_ja', 'caution_ja', 'tip_ja', 'equip_ja',
      'createdAt', 'updatedAt',
      'source', 'channel', 'videoTitle', 'evidence', 'confidence', 'ai_ko', 'ai_en', 'ai_ja']
  },
  reviews: {
    name: '후기',
    headers: ['reviewId', 'activityId', 'activityTitle', 'createdAt', 'teacher', 'grade', 'fitScore', 'rating', 'duration',
      'sessionType', 'lang', 'caution_ko', 'caution_en', 'caution_ja', 'tip_ko', 'tip_en', 'tip_ja', 'deleted', 'deviceId']
  },
  likes: {
    name: '추천',
    headers: ['activityId', 'count', 'updatedAt']
  },
  saves: {
    name: '저장',
    headers: ['activityId', 'count', 'updatedAt']
  },
  reactions: {
    name: '반응기록',
    headers: ['deviceId', 'activityId', 'kind', 'createdAt']
  },
  proposals: {
    name: '새수업제안',
    headers: ['proposalId', 'status', 'createdAt', 'title', 'lang', 'country', 'curriculumArea', 'playType', 'place',
      'groupSize', 'equipment', 'equipmentDetail', 'youtubeUrl', 'rules', 'duration', 'caution', 'resultActivityId']
  },
  reports: {
    name: '신고',
    headers: ['reportId', 'createdAt', 'kind', 'targetId', 'activityId', 'deviceId', 'reason', 'status']
  },
  edits: {
    name: '수정제안',
    headers: ['editId', 'status', 'createdAt', 'activityId', 'activityTitle', 'lang', 'proposer', 'reason',
      'title', 'rules', 'caution', 'tip', 'equip']
  }
};

const EDIT_FIELDS = ['title', 'rules', 'caution', 'tip', 'equip'];
const DEFAULT_TIP = {
  ko: '학급 인원과 공간에 맞춰 규칙을 조절해 보세요.',
  en: 'Adjust court size and number of balls for your class size.',
  ja: 'クラスの人数と場所に合わせてルールを調整してみてください。'
};

/* ----------------------------- 진입점 ----------------------------- */

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'data';
    if (action === 'data') return json_(publicData_());
    if (action === 'social') return json_(socialData_()); // 추천·저장·후기만 (수업 내용은 사이트의 data/*.json)
    if (action === 'videoReports') return json_(videoReports_()); // 데이터 발행 때 먼저 확인할 영상
    if (action === 'actTabs') return json_(actTabs_());             // 데이터 발행용: 수업 탭 목록과 줄 수
    if (action === 'acts') return json_(actsPage_(e.parameter));    // 데이터 발행용: 탭 하나를 나눠 받기
    if (action === 'reviewsPage') return json_(reviewsPage_(e.parameter)); // 데이터 발행용: 후기를 나눠 받기 (src=main 또는 연도)
    if (action === 'reviewSources') return json_(reviewSources_());       // 데이터 발행용: 지금 파일 + 연도별 보관 파일 목록
    if (action === 'counts') return json_({ ok: true, at: now_(), likes: countMap_('likes'), saves: countMap_('saves') });
    if (action === 'recent') return json_(recentReviews_(e.parameter)); // 사이트용: 마지막 발행 이후 새 후기만
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const a = body.action;

    // 누구나 가능
    if (a === 'addReview') return json_(withLock_(() => addReview_(body)));
    if (a === 'like') return json_(withLock_(() => like_(body.activityId)));
    if (a === 'react') return json_(withLock_(() => react_(body)));
    if (a === 'proposeActivity') return json_(withLock_(() => proposeActivity_(body.activity || {})));
    if (a === 'proposeEdit') return json_(withLock_(() => proposeEdit_(body.edit || {})));
    if (a === 'report') return json_(withLock_(() => report_(body)));
    if (a === 'checkPin') return json_({ ok: checkPin_(body.pin) });

    // 관리자만 가능
    if (!checkPin_(body.pin)) return json_({ ok: false, error: 'auth' });
    if (a === 'adminData') return json_(adminData_());
    if (a === 'deleteReview') return json_(withLock_(() => deleteReview_(body.reviewId)));
    if (a === 'resolveReport') return json_(withLock_(() => resolveReports_(body.targetId, body.kind)));
    if (a === 'approveProposal') return json_(withLock_(() => approveProposal_(body.proposalId)));
    if (a === 'rejectProposal') return json_(withLock_(() => setStatus_('proposals', 'proposalId', body.proposalId, '반려')));
    if (a === 'approveEdit') return json_(withLock_(() => approveEdit_(body.editId)));
    if (a === 'rejectEdit') return json_(withLock_(() => setStatus_('edits', 'editId', body.editId, '반려')));
    if (a === 'changePin') return json_(changePin_(body.newPin));
    if (a === 'archiveYear') return json_(withLock_(() => archiveYear_(Number(body.year))));
    if (a === 'archives') return json_({ ok: true, archives: getArchives_() });
    if (a === 'seedActivities') return json_(withLock_(() => seedActivities_(body.rows || [], !!body.force)));
    if (a === 'importActivities') return json_(withLock_(() => importActivities_(body.items || [])));

    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/* ----------------------------- 공개 데이터 ----------------------------- */

/* ---------- 수업 탭 여러 개: 「수업」(1~5000), 「수업2」(5001~10000), 「수업3」… ----------
   이름이 '수업' 또는 '수업' + 숫자인 탭을 모두 수업 데이터로 읽는다. 새 수업(승인·등록)은 마지막 탭에 붙는다. */
const ACT_TAB_RE = /^수업(\d*)$/;

function activityTabs_() {
  const list = ss_().getSheets()
    .map(sh => ({ sh: sh, m: sh.getName().trim().match(ACT_TAB_RE) }))
    .filter(x => x.m)
    .map(x => ({ sh: x.sh, n: x.m[1] ? Number(x.m[1]) : 1 }))
    .sort((a, b) => a.n - b.n)
    .map(x => x.sh);
  if (!list.length) list.push(getTab_('activities'));
  return list;
}

// 머리글이 비어 있으면 updatedAt 뒤 두 칸을 channel, transcriptVerified로 본다(납품 32열 양식)
function actHeaders_(sh) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const h = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(x => String(x).trim());
  const u = h.indexOf('updatedAt');
  if (u >= 0 && h.indexOf('channel') < 0) {
    if (u + 1 < h.length && !h[u + 1]) h[u + 1] = 'channel';
    if (u + 2 < h.length && !h[u + 2] && h.indexOf('transcriptVerified') < 0) h[u + 2] = 'transcriptVerified';
  }
  return h;
}

// 모든 수업 탭을 하나로 합쳐 읽는다. where[i] = { sh, row(시트 줄 번호), h(그 탭의 머리글) }
function readAllActs_() {
  const headers = [];
  const parts = activityTabs_().map(sh => {
    const h = actHeaders_(sh);
    h.forEach(x => { if (x && headers.indexOf(x) < 0) headers.push(x); });
    const lastRow = sh.getLastRow();
    const values = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, h.length).getValues() : [];
    return { sh: sh, h: h, values: values };
  });
  const col = {};
  headers.forEach((x, i) => { col[x] = i; });
  const rows = [], where = [];
  parts.forEach(p => {
    p.values.forEach((v, i) => {
      const r = headers.map(() => '');
      p.h.forEach((x, j) => { if (x) r[col[x]] = cellOut_(v[j]); });
      rows.push(r);
      where.push({ sh: p.sh, row: i + 2, h: p.h });
    });
  });
  return { headers: headers, col: col, rows: rows, where: where };
}

// 시트의 마지막 n줄만 읽는다(후기처럼 아래로 계속 쌓이는 탭용)
function readLastRows_(key, n) {
  const sh = getTab_(key);
  const lastRow = sh.getLastRow(), lastCol = Math.max(sh.getLastColumn(), 1);
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const col = {};
  headers.forEach((h, i) => { if (h) col[h] = i; });
  const start = Math.max(2, lastRow - n + 1);
  const rows = lastRow >= 2 ? sh.getRange(start, 1, lastRow - start + 1, lastCol).getValues().map(r => r.map(cellOut_)) : [];
  return { sheet: sh, headers: headers, col: col, rows: rows, start: start };
}

function visibleReview_(t, r, hidden) {
  return String(r[t.col.reviewId] || '').trim() && String(r[t.col.deleted] || '').trim().toUpperCase() !== 'Y' && !hidden[String(r[t.col.reviewId])];
}

// 데이터 발행용: 공개 후기를 2,000줄씩 (기기 번호 제외)
function reviewsPage_(p) {
  const srcName = String((p && p.src) || 'main');
  let sh = getTab_('reviews');
  if (srcName !== 'main') {
    const a = getArchives_().find(x => String(x.year) === srcName);
    sh = a ? archiveSheet_(a, 'reviews') : null;
    if (!sh) return { ok: false, error: '보관 파일을 찾을 수 없습니다: ' + srcName };
  }
  const lastRow = sh.getLastRow(), lastCol = Math.max(sh.getLastColumn(), 1);
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const col = {};
  headers.forEach((h, i) => { if (h) col[h] = i; });
  const total = Math.max(lastRow - 1, 0);
  const offset = Math.max(0, Number(p && p.offset) || 0);
  const limit = Math.min(3000, Math.max(1, Number(p && p.limit) || 2000));
  const n = Math.max(0, Math.min(limit, total - offset));
  const t = { col: col };
  const hidden = hiddenReviewIds_();
  const rows = n > 0 ? sh.getRange(2 + offset, 1, n, lastCol).getValues().map(r => r.map(cellOut_)).filter(r => visibleReview_(t, r, hidden)) : [];
  return Object.assign({ ok: true, total: total, offset: offset }, publicTable_(headers, rows, ['deviceId']));
}

// 사이트용: since(마지막 발행 시각) 이후에 쓴 후기만. 최근 500줄만 보므로 후기가 아무리 많아도 가볍다
function recentReviews_(p) {
  const since = String((p && p.since) || '').trim();
  const t = readLastRows_('reviews', 500);
  const hidden = hiddenReviewIds_();
  const rows = t.rows.filter(r => visibleReview_(t, r, hidden) && (!since || String(r[t.col.createdAt] || '') >= since));
  return { ok: true, at: now_(), hidden: Object.keys(hidden), reviews: publicTable_(t.headers, rows, ['deviceId']) };
}

function appendAct_(obj) {
  const tabs = activityTabs_();
  const sh = tabs[tabs.length - 1];
  const h = actHeaders_(sh);
  sh.appendRow(h.map(x => safeCell_(!x || obj[x] === undefined || obj[x] === null ? '' : obj[x])));
}

function actTabs_() {
  return { ok: true, tabs: activityTabs_().map(sh => ({ name: sh.getName(), rows: Math.max(sh.getLastRow() - 1, 0) })) };
}

function actsPage_(p) {
  const name = String((p && p.tab) || '').trim();
  const sh = activityTabs_().find(x => x.getName() === name);
  if (!sh) return { ok: false, error: '탭을 찾을 수 없습니다: ' + name };
  const total = Math.max(sh.getLastRow() - 1, 0);
  const offset = Math.max(0, Number(p.offset) || 0);
  const limit = Math.min(3000, Math.max(1, Number(p.limit) || 2000));
  const n = Math.max(0, Math.min(limit, total - offset));
  const h = actHeaders_(sh);
  const r = n > 0 ? sh.getRange(2 + offset, 1, n, h.length).getValues().map(row => row.map(cellOut_)) : [];
  return { ok: true, tab: name, total: total, offset: offset, h: h, r: r };
}

function publicData_() {
  const acts = readAllActs_();
  const actRows = acts.rows.filter(r => String(r[acts.col.id] || '').trim() && String(r[acts.col.status] || '').trim() !== '숨김');

  const revs = readTab_('reviews');
  const hidden = hiddenReviewIds_();
  const revRows = revs.rows.filter(r => filled_(revs, r, 'reviewId') && String(r[revs.col.deleted] || '').trim().toUpperCase() !== 'Y' && !hidden[String(r[revs.col.reviewId])]);

  return {
    ok: true,
    at: now_(),
    activities: { h: acts.headers, r: actRows },
    reviews: publicTable_(revs.headers, revRows, ['deviceId']),
    likes: countMap_('likes'),
    saves: countMap_('saves')
  };
}

// 사이트가 매번 받는 가벼운 데이터: 수업 내용은 빼고 추천·저장 수와 후기만
function socialData_() {
  const revs = readTab_('reviews');
  const hidden = hiddenReviewIds_();
  const revRows = revs.rows.filter(r => filled_(revs, r, 'reviewId') && String(r[revs.col.deleted] || '').trim().toUpperCase() !== 'Y' && !hidden[String(r[revs.col.reviewId])]);
  return {
    ok: true,
    at: now_(),
    reviews: publicTable_(revs.headers, revRows, ['deviceId']),
    likes: countMap_('likes'),
    saves: countMap_('saves')
  };
}

/* ----------------------------- 후기 ----------------------------- */

function addReview_(b) {
  const r = b.review || {};
  const activityId = clean_(b.activityId, 40);
  if (!activityId) return { ok: false, error: '수업 정보가 없습니다.' };
  const caution = clean_(r.caution, 1000);
  const tip = clean_(r.upgradeTip, 1000);
  if (!caution && !tip) return { ok: false, error: '내용을 입력해 주세요.' };
  const lang = LANGS.indexOf(r.lang) >= 0 ? r.lang : 'ko';
  const deviceId = /^[A-Za-z0-9-]{8,64}$/.test(String(b.deviceId || '')) ? String(b.deviceId) : '';

  // 같은 기기에서 하루(24시간)에 쓸 수 있는 후기는 5개까지 (후기가 많아져도 빠르게: 최근 2,000줄만 확인)
  if (deviceId) {
    const since = Utilities.formatDate(new Date(Date.now() - 24 * 3600 * 1000), TZ, 'yyyy-MM-dd HH:mm');
    const t = readLastRows_('reviews', 2000);
    const recent = t.rows.filter(x => String(x[t.col.deviceId] || '') === deviceId && String(x[t.col.createdAt] || '') >= since).length;
    if (recent >= REVIEW_DAILY_LIMIT) return { ok: false, error: '후기는 하루에 ' + REVIEW_DAILY_LIMIT + '개까지 쓸 수 있습니다. 내일 다시 써 주세요.' };
  }

  const row = {
    reviewId: 'rv-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000),
    activityId: activityId,
    activityTitle: clean_(b.title, 200),
    createdAt: now_(),
    teacher: clean_(r.teacher, 40) || '익명',
    grade: clean_(r.grade, 20),
    fitScore: clampNum_(r.fitScore, 1, 5, 5),
    rating: clampNum_(r.rating, 1, 5, 5),
    duration: clampNum_(r.duration, 5, 80, 25),
    sessionType: clean_(r.sessionType, 20),
    lang: lang,
    deleted: '',
    deviceId: deviceId
  };
  const c3 = translateAll_(caution, lang);
  const t3 = translateAll_(tip, lang);
  LANGS.forEach(l => { row['caution_' + l] = c3[l]; row['tip_' + l] = t3[l]; });

  appendObj_('reviews', row);
  const pub = Object.assign({}, row);
  delete pub.deviceId;
  return { ok: true, review: pub };
}

function deleteReview_(reviewId) {
  // 지금 파일과 연도별 보관 파일에서 후기 번호로 찾아 '삭제' 표시
  const sheets = [getTab_('reviews')].concat(getArchives_().map(a => archiveSheet_(a, 'reviews')).filter(Boolean));
  for (const sh of sheets) {
    if (sh.getLastRow() < 2) continue;
    const h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    const cId = h.indexOf('reviewId') + 1, cDel = h.indexOf('deleted') + 1;
    if (cId < 1 || cDel < 1) continue;
    const hit = sh.getRange(2, cId, sh.getLastRow() - 1, 1).createTextFinder(String(reviewId)).matchEntireCell(true).findNext();
    if (hit) { sh.getRange(hit.getRow(), cDel).setValue('Y'); return { ok: true }; }
  }
  return { ok: false, error: '후기를 찾을 수 없습니다.' };
}

/* ----------------------------- 연도별 보관 (후기·추천 기록) -----------------------------
   후기와 추천·저장 기록은 계속 쌓이므로, 지난 연도 것은 따로 구글 시트 파일(예: 「2026 후기·추천 기록 - 오늘 체육 뭐 하지」)로 옮긴다.
   수업 데이터와 추천·저장 수(합계)는 지금 파일에 그대로 둔다. 보관한 후기도 사이트에는 그대로 보인다. */
const ARCHIVE_PROP = 'REVIEW_ARCHIVES';

function getArchives_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(ARCHIVE_PROP) || '[]'); } catch (e) { return []; }
}

function archiveSheet_(a, key) {
  try { return SpreadsheetApp.openById(a.id).getSheetByName(TABS[key].name); } catch (e) { return null; }
}

function archiveYear_(year) {
  const thisYear = Number(Utilities.formatDate(new Date(), TZ, 'yyyy'));
  if (!year || year >= thisYear) return { ok: false, error: '지난 연도만 보관할 수 있습니다. (올해: ' + thisYear + ')' };
  const archives = getArchives_();
  let entry = archives.find(a => Number(a.year) === year);
  let file;
  if (entry) file = SpreadsheetApp.openById(entry.id);
  else {
    file = SpreadsheetApp.create(year + ' 후기·추천 기록 - 오늘 체육 뭐 하지');
    entry = { year: year, id: file.getId(), name: file.getName() };
  }
  const moved = {};
  ['reviews', 'reactions'].forEach(key => {
    const src = getTab_(key);
    const lastRow = src.getLastRow(), lastCol = Math.max(src.getLastColumn(), 1);
    const headers = src.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    const cAt = headers.indexOf('createdAt');
    let dst = file.getSheetByName(TABS[key].name);
    if (!dst) {
      dst = file.insertSheet(TABS[key].name);
      dst.getRange(1, 1, 1, headers.length).setValues([headers]);
      dst.setFrozenRows(1);
    }
    if (lastRow < 2 || cAt < 0) { moved[key] = 0; return; }
    // 기록은 시간순으로 아래에 쌓이므로, 위에서부터 그 연도 이하인 줄을 한 덩어리로 옮긴다
    const values = src.getRange(2, 1, lastRow - 1, lastCol).getValues();
    let n = 0;
    while (n < values.length && String(cellOut_(values[n][cAt])).slice(0, 4) !== '' && Number(String(cellOut_(values[n][cAt])).slice(0, 4)) <= year) n++;
    if (n > 0) {
      dst.getRange(dst.getLastRow() + 1, 1, n, lastCol).setValues(values.slice(0, n));
      src.deleteRows(2, n);
    }
    moved[key] = n;
  });
  // 기본 시트 1이 남아 있으면 지운다
  const blank = file.getSheetByName('Sheet1') || file.getSheetByName('시트1');
  if (blank && file.getSheets().length > 1) file.deleteSheet(blank);
  if (!archives.find(a => Number(a.year) === year)) archives.push(entry);
  archives.sort((a, b) => a.year - b.year);
  PropertiesService.getScriptProperties().setProperty(ARCHIVE_PROP, JSON.stringify(archives));
  return { ok: true, year: year, url: file.getUrl(), reviews: moved.reviews, reactions: moved.reactions };
}

function reviewSources_() {
  const out = [{ src: 'main', rows: Math.max(getTab_('reviews').getLastRow() - 1, 0) }];
  getArchives_().forEach(a => {
    const sh = archiveSheet_(a, 'reviews');
    if (sh) out.push({ src: String(a.year), rows: Math.max(sh.getLastRow() - 1, 0) });
  });
  return { ok: true, sources: out };
}

/* ----------------------------- 신고 (후기·영상) ----------------------------- */

const REVIEW_DAILY_LIMIT = 5;
const REVIEW_HIDE_REPORTS = 3; // 서로 다른 기기 3곳에서 신고하면 관리자가 보기 전까지 숨김

function report_(b) {
  const kind = String(b.kind || '');
  if (['review', 'video', 'takedown'].indexOf(kind) < 0) return { ok: false, error: 'bad request' };
  const targetId = clean_(b.targetId, 200);
  const deviceId = String(b.deviceId || '').trim();
  if (!targetId || !/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) return { ok: false, error: 'bad request' };
  const t = readTab_('reports');
  const dup = t.rows.some(r => String(r[t.col.kind]) === kind && String(r[t.col.targetId]) === targetId && String(r[t.col.deviceId]) === deviceId);
  if (dup) return { ok: true, already: true };
  appendObj_('reports', {
    reportId: 'rp-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000),
    createdAt: now_(),
    kind: kind,
    targetId: targetId,
    activityId: clean_(b.activityId, 40),
    deviceId: deviceId,
    reason: clean_(b.reason, 300),
    status: '대기'
  });
  return { ok: true };
}

// 공개 응답에서 기기 번호처럼 밖에 보이면 안 되는 칸을 뺀다
function publicTable_(headers, rows, drop) {
  const keep = headers.map((h, i) => drop.indexOf(h) < 0 ? i : -1).filter(i => i >= 0);
  return { h: keep.map(i => headers[i]), r: rows.map(r => keep.map(i => r[i])) };
}

function openReports_() {
  const t = readTab_('reports');
  return t.rows.filter(r => filled_(t, r, 'reportId') && String(r[t.col.status] || '').trim() === '대기').map(r => rowToObj_(t, r));
}

function hiddenReviewIds_() {
  const devices = {};
  openReports_().filter(o => o.kind === 'review').forEach(o => {
    (devices[o.targetId] = devices[o.targetId] || {})[o.deviceId] = true;
  });
  const out = {};
  Object.keys(devices).forEach(id => { if (Object.keys(devices[id]).length >= REVIEW_HIDE_REPORTS) out[id] = true; });
  return out;
}

function videoReports_() {
  const map = {};
  openReports_().filter(o => o.kind === 'video').forEach(o => { map[o.targetId] = (map[o.targetId] || 0) + 1; });
  return { ok: true, videos: map };
}

// 관리자가 신고를 처리(후기 삭제 또는 문제없음)하면 그 대상의 신고를 모두 '처리'로 바꾼다
function resolveReports_(targetId, kind) {
  const t = readTab_('reports');
  let n = 0;
  t.rows.forEach((r, i) => {
    if (String(r[t.col.targetId]) === String(targetId) && (!kind || String(r[t.col.kind]) === kind) && String(r[t.col.status]) === '대기') {
      t.sheet.getRange(i + 2, t.col.status + 1).setValue('처리');
      n++;
    }
  });
  return { ok: true, resolved: n };
}

/* ----------------------------- 추천 (이전 버전 사이트용, 기기 기록 없음) ----------------------------- */

function like_(activityId) {
  activityId = clean_(activityId, 40);
  if (!activityId) return { ok: false };
  const t = readTab_('likes');
  const idx = t.rows.findIndex(r => String(r[t.col.activityId]) === activityId);
  let count;
  if (idx < 0) {
    count = 1;
    appendObj_('likes', { activityId: activityId, count: 1, updatedAt: now_() });
  } else {
    count = (Number(t.rows[idx][t.col.count]) || 0) + 1;
    t.sheet.getRange(idx + 2, t.col.count + 1).setValue(count);
    t.sheet.getRange(idx + 2, t.col.updatedAt + 1).setValue(now_());
  }
  return { ok: true, count: count };
}

/* ----------------------------- 추천·저장 (기기당 1번, 취소 가능) ----------------------------- */

const REACT_TABS = { like: 'likes', save: 'saves' };

/**
 * body: { kind: 'like'|'save', activityId, deviceId, on: true|false, legacy?: true }
 * 같은 기기가 같은 수업에 두 번 눌러도 한 번만 셉니다. 취소하면 기록을 지우고 1 줄입니다.
 * legacy: 기기 기록이 생기기 전(이전 버전)에 누른 추천을 취소할 때만 씁니다.
 */
function react_(b) {
  const kind = String(b.kind || '');
  const countKey = REACT_TABS[kind];
  const activityId = clean_(b.activityId, 40);
  const deviceId = String(b.deviceId || '').trim();
  if (!countKey || !activityId || !/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) return { ok: false, error: 'bad request' };
  const on = b.on === true;

  // 기록이 많아져도 빠르게: 기기 번호 칸에서 그 기기의 줄만 찾아 확인한다
  const sh = getTab_('reactions');
  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const cDev = hdr.indexOf('deviceId') + 1, cAct = hdr.indexOf('activityId') + 1, cKind = hdr.indexOf('kind') + 1;
  let rowNum = -1;
  if (sh.getLastRow() > 1) {
    const hits = sh.getRange(2, cDev, sh.getLastRow() - 1, 1).createTextFinder(deviceId).matchEntireCell(true).findAll();
    for (const h of hits) {
      const r = h.getRow();
      if (String(sh.getRange(r, cAct).getValue()) === activityId && String(sh.getRange(r, cKind).getValue()) === kind) { rowNum = r; break; }
    }
  }

  if (on) {
    if (rowNum > 0) return { ok: true, on: true, count: getCount_(countKey, activityId) };
    appendObj_('reactions', { deviceId: deviceId, activityId: activityId, kind: kind, createdAt: now_() });
    return { ok: true, on: true, count: addCount_(countKey, activityId, 1) };
  }

  if (rowNum < 0 && !on) {
    // 지난 연도에 누른 추천·저장이면 보관 파일에서 지운다
    for (const a of getArchives_()) {
      const ash = archiveSheet_(a, 'reactions');
      if (!ash || ash.getLastRow() < 2) continue;
      const ah = ash.getRange(1, 1, 1, ash.getLastColumn()).getValues()[0].map(String);
      const hits = ash.getRange(2, ah.indexOf('deviceId') + 1, ash.getLastRow() - 1, 1).createTextFinder(deviceId).matchEntireCell(true).findAll();
      const hit = hits.find(h => String(ash.getRange(h.getRow(), ah.indexOf('activityId') + 1).getValue()) === activityId &&
        String(ash.getRange(h.getRow(), ah.indexOf('kind') + 1).getValue()) === kind);
      if (hit) { ash.deleteRow(hit.getRow()); return { ok: true, on: false, count: addCount_(countKey, activityId, -1) }; }
    }
  }

  if (rowNum > 0) {
    sh.deleteRow(rowNum);
    return { ok: true, on: false, count: addCount_(countKey, activityId, -1) };
  }
  if (kind === 'like' && b.legacy === true) {
    return { ok: true, on: false, count: addCount_(countKey, activityId, -1) };
  }
  return { ok: true, on: false, count: getCount_(countKey, activityId) };
}

function countMap_(key) {
  const t = readTab_(key);
  const map = {};
  t.rows.filter(r => filled_(t, r, 'activityId')).forEach(r => { map[r[t.col.activityId]] = Number(r[t.col.count]) || 0; });
  return map;
}

function getCount_(key, activityId) {
  const t = readTab_(key);
  const row = t.rows.find(r => String(r[t.col.activityId]) === activityId);
  return row ? (Number(row[t.col.count]) || 0) : 0;
}

function addCount_(key, activityId, delta) {
  const t = readTab_(key);
  const idx = t.rows.findIndex(r => String(r[t.col.activityId]) === activityId);
  if (idx < 0) {
    const count = Math.max(0, delta);
    appendObj_(key, { activityId: activityId, count: count, updatedAt: now_() });
    return count;
  }
  const count = Math.max(0, (Number(t.rows[idx][t.col.count]) || 0) + delta);
  t.sheet.getRange(idx + 2, t.col.count + 1).setValue(count);
  t.sheet.getRange(idx + 2, t.col.updatedAt + 1).setValue(now_());
  return count;
}

/* ----------------------------- 새 수업 제안 ----------------------------- */

function proposeActivity_(p) {
  const title = clean_(p.title, 200);
  const rules = clean_(p.rules, 3000);
  if (!title || !rules) return { ok: false, error: '활동명과 활동 내용을 입력해 주세요.' };
  const row = {
    proposalId: 'pr-' + new Date().getTime(),
    status: '대기',
    createdAt: now_(),
    title: title,
    lang: LANGS.indexOf(p.lang) >= 0 ? p.lang : 'ko',
    country: clean_(p.country, 20) || '한국',
    curriculumArea: clean_(p.curriculumArea, 20),
    playType: clean_(p.playType, 40),
    place: listStr_(p.place),
    groupSize: clean_(p.groupSize, 40),
    equipment: listStr_(p.equipment),
    equipmentDetail: clean_(p.equipmentDetail, 300),
    youtubeUrl: clean_(p.youtubeUrl, 300),
    rules: rules,
    duration: clampNum_(p.duration, 5, 80, 25),
    caution: clean_(p.caution, 1000),
    resultActivityId: ''
  };
  appendObj_('proposals', row);
  return { ok: true };
}

function approveProposal_(proposalId) {
  const t = readTab_('proposals');
  const idx = t.rows.findIndex(r => String(r[t.col.proposalId]) === String(proposalId));
  if (idx < 0) return { ok: false, error: '제안을 찾을 수 없습니다.' };
  const p = rowToObj_(t, t.rows[idx]);
  if (p.status !== '대기') return { ok: false, error: '이미 처리된 제안입니다.' };

  const lang = LANGS.indexOf(p.lang) >= 0 ? p.lang : 'ko';
  const dur = Number(p.duration) || 25;
  const id = 'pe-u' + new Date().getTime();
  const act = {
    id: id,
    status: '게시',
    country: p.country || '한국',
    curriculumArea: p.curriculumArea,
    playType: p.playType,
    place: p.place,
    groupSize: p.groupSize,
    slotKey: dur <= 16 ? '도입·자투리' : (dur <= 28 ? '반차시' : '1차시'),
    gradeGroup: '1~2학년,3~4학년,5~6학년',
    equipment: p.equipment,
    videoId: youtubeId_(p.youtubeUrl),
    youtubeUrl: p.youtubeUrl,
    defaultDur: dur,
    source: '교사 제안',
    createdAt: now_(),
    updatedAt: now_()
  };
  const fields = { title: p.title, rules: p.rules, caution: p.caution, equip: p.equipmentDetail };
  Object.keys(fields).forEach(f => {
    const tr = translateAll_(fields[f], lang);
    LANGS.forEach(l => { act[f + '_' + l] = tr[l]; });
  });
  LANGS.forEach(l => { act['tip_' + l] = DEFAULT_TIP[l]; });

  appendAct_(act);
  t.sheet.getRange(idx + 2, t.col.status + 1).setValue('승인');
  t.sheet.getRange(idx + 2, t.col.resultActivityId + 1).setValue(id);
  return { ok: true, activityId: id };
}

/* ----------------------------- 수정 제안 ----------------------------- */

function proposeEdit_(p) {
  const activityId = clean_(p.activityId, 40);
  if (!activityId) return { ok: false, error: '수업 정보가 없습니다.' };
  const row = {
    editId: 'ed-' + new Date().getTime(),
    status: '대기',
    createdAt: now_(),
    activityId: activityId,
    activityTitle: clean_(p.activityTitle, 200),
    lang: LANGS.indexOf(p.lang) >= 0 ? p.lang : 'ko',
    proposer: clean_(p.proposer, 40) || '익명',
    reason: clean_(p.reason, 500)
  };
  let changed = 0;
  EDIT_FIELDS.forEach(f => {
    row[f] = clean_(p[f], 3000);
    if (row[f]) changed++;
  });
  if (!changed) return { ok: false, error: '바꿀 내용이 없습니다.' };
  appendObj_('edits', row);
  return { ok: true };
}

function approveEdit_(editId) {
  const et = readTab_('edits');
  const eIdx = et.rows.findIndex(r => String(r[et.col.editId]) === String(editId));
  if (eIdx < 0) return { ok: false, error: '수정 제안을 찾을 수 없습니다.' };
  const ed = rowToObj_(et, et.rows[eIdx]);
  if (ed.status !== '대기') return { ok: false, error: '이미 처리된 제안입니다.' };

  const at = readAllActs_();
  const aIdx = at.rows.findIndex(r => String(r[at.col.id]) === String(ed.activityId));
  if (aIdx < 0) return { ok: false, error: '수업 탭에서 해당 수업을 찾을 수 없습니다. 먼저 기본 수업을 시트에 올려 주세요.' };

  // 그 수업이 들어 있는 탭의 줄을 그대로 읽어 고친다(탭마다 칸 순서가 달라도 머리글 이름으로 찾음)
  const w = at.where[aIdx];
  const tcol = {};
  w.h.forEach((x, i) => { if (x) tcol[x] = i; });
  const lang = LANGS.indexOf(ed.lang) >= 0 ? ed.lang : 'ko';
  const row = w.sh.getRange(w.row, 1, 1, w.h.length).getValues()[0];
  EDIT_FIELDS.forEach(f => {
    const val = String(ed[f] || '').trim();
    if (!val || tcol[f + '_' + lang] === undefined) return;
    if (String(row[tcol[f + '_' + lang]] || '') === val) return; // 바뀐 칸만 반영
    const tr = translateAll_(val, lang);
    LANGS.forEach(l => { if (tcol[f + '_' + l] !== undefined) row[tcol[f + '_' + l]] = safeCell_(tr[l]); });
  });
  if (tcol.updatedAt !== undefined) row[tcol.updatedAt] = now_();
  w.sh.getRange(w.row, 1, 1, row.length).setValues([row.map(safeCell_)]);
  et.sheet.getRange(eIdx + 2, et.col.status + 1).setValue('승인');
  return { ok: true };
}

/* ----------------------------- AI 수집 자료 일괄 등록 ----------------------------- */

const ALLOWED = {
  curriculumArea: ['건강', '도전', '경쟁', '표현', '안전·인성'],
  playType: ['준비운동·코디네이션', '팀빌딩·협동형', '술래잡기·태그형', '피구·투척형', '축구·발구기형', '농구·핸드볼형',
    '럭비·보물탈환형', '네트·라켓형', '필드·티볼·야구형', '플라잉디스크·하키형', '줄넘기·리듬스텝형',
    '육상·릴레이·순발력형', '표적·컬링·보치아형', '전래·전통놀이형'],
  place: ['교실', '강당', '운동장'],
  groupSize: ['소규모·짝·모둠 (2~10명)', '학급 전체 (15~30명)', '대집단·합동 (30명+)'],
  grades: ['1~2학년', '3~4학년', '5~6학년'],
  equipment: ['없음(맨손)', '폼볼/피구공', '축구/농구/배구공', '럭비공/태그벨트', '큰공(짐볼/킨볼)', '풍선/탱탱볼/비치볼',
    '콩주머니(빈백)/보치아', '플라잉디스크(원반)', '줄넘기/긴줄/고무줄', '라켓/스틱(플로어볼/패드민턴)', '훌라후프',
    '접시콘/라바콘', '원마커(스팟)', '펀스틱(스펀지봉)', '미트/스태킹컵(종이컵)', '스카프/꼬리끈', '스텝래더(사다리)/허들',
    '파라슈트(낙하산)/타프', '팀조끼', '스쿠터보드/매트', '의자/책상'],
  country: ['한국', '일본', '미국', '캐나다', '호주', '영국', '독일', '스페인', '프랑스', '글로벌', '미확인'],
  confidence: ['높음', '중간', '낮음']
};

/**
 * 하네스(argon-harness.txt) 형식의 항목 배열을 받아
 * 1) 형식·허용값 검사 2) 시트 안 중복 검사 3) 유튜브에 영상이 실제로 있는지 확인
 * 을 모두 통과한 것만 번역해서 '수업' 탭에 추가한다.
 */
function importActivities_(items) {
  if (!Array.isArray(items) || !items.length) return { ok: false, error: '등록할 항목이 없습니다.' };
  if (items.length > 15) return { ok: false, error: '한 번에 15개까지만 등록할 수 있습니다. (번역 시간 때문)' };

  const at = readAllActs_();
  const usedVideos = {};
  at.rows.forEach(r => { const v = String(r[at.col.videoId] || ''); if (v) usedVideos[v] = true; });

  const results = [];
  const toAdd = [];
  items.forEach((it, i) => {
    const vid = String((it && it.videoId) || '').trim();
    const res = { index: i, videoId: vid, title: clean_(it && it.title_ko, 200) };
    const problems = validateImportItem_(it);
    if (!problems.length && usedVideos[vid]) problems.push('이미 등록된 영상');
    if (!problems.length) {
      const yt = youtubeLookup_(vid);
      if (!yt) problems.push('유튜브에 없는 영상');
      else { res.channel = yt.author_name; res.videoTitle = yt.title; }
    }
    if (problems.length) { res.ok = false; res.problems = problems; results.push(res); return; }
    usedVideos[vid] = true;
    res.ok = true;
    results.push(res);
    toAdd.push({ it: it, yt: { channel: res.channel, title: res.videoTitle } });
  });

  toAdd.forEach((x, n) => {
    const it = x.it;
    const act = {
      id: 'pe-' + it.videoId,
      status: '게시',
      country: it.country,
      curriculumArea: it.curriculumArea,
      playType: it.playType,
      place: it.place.join(','),
      groupSize: it.groupSize,
      slotKey: '',
      gradeGroup: it.grades.join(','),
      equipment: it.equipment.join(','),
      videoId: it.videoId,
      youtubeUrl: 'https://www.youtube.com/watch?v=' + it.videoId,
      defaultDur: '',
      source: 'AI 수집',
      channel: x.yt.channel,          // 유튜브에서 직접 확인한 값
      videoTitle: x.yt.title,         // 유튜브에서 직접 확인한 값
      evidence: (it.quotes || []).map(q => clean_(q, 300)).join('\n'),
      confidence: it.confidence,
      createdAt: now_(),
      updatedAt: now_()
    };
    const fields = { title: it.title_ko, rules: it.rules_ko, caution: it.caution_ko, tip: it.tip_ko, equip: it.equipment_ko };
    Object.keys(fields).forEach(f => {
      const tr = translateAll_(clean_(fields[f], 3000), 'ko');
      LANGS.forEach(l => { act[f + '_' + l] = tr[l]; });
    });
    const ideas = (it.aiIdeas || []).map(s => clean_(s, 300)).filter(Boolean).join('\n');
    const trIdeas = translateAll_(ideas, 'ko');
    LANGS.forEach(l => { act['ai_' + l] = trIdeas[l]; });
    appendAct_(act);
  });

  return { ok: true, added: toAdd.length, rejected: results.filter(r => !r.ok).length, results: results };
}

function validateImportItem_(it) {
  const p = [];
  if (!it || typeof it !== 'object') return ['항목 형식이 아님'];
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(it.videoId || ''))) p.push('videoId 형식 오류');
  ['title_ko', 'rules_ko', 'channel', 'videoTitle'].forEach(k => { if (!String(it[k] || '').trim()) p.push(k + ' 비어 있음'); });
  if (!Array.isArray(it.quotes) || it.quotes.filter(q => String(q || '').trim()).length < 2) p.push('자막 근거(quotes) 2개 미만');
  ['curriculumArea', 'playType', 'groupSize', 'country', 'confidence'].forEach(k => {
    if (ALLOWED[k].indexOf(it[k]) < 0) p.push(k + ' 허용값 아님: ' + it[k]);
  });
  ['place', 'grades', 'equipment'].forEach(k => {
    if (!Array.isArray(it[k]) || !it[k].length) p.push(k + ' 비어 있음');
    else it[k].forEach(v => { if (ALLOWED[k].indexOf(v) < 0) p.push(k + ' 허용값 아님: ' + v); });
  });
  return p;
}

function youtubeLookup_(videoId) {
  try {
    const res = UrlFetchApp.fetch('https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + videoId), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    return JSON.parse(res.getContentText());
  } catch (e) {
    return null;
  }
}

/* ----------------------------- 관리자 ----------------------------- */

function adminData_() {
  const p = readTab_('proposals');
  const e = readTab_('edits');
  return {
    ok: true,
    proposals: p.rows.map(r => rowToObj_(p, r)).filter(o => o.status === '대기'),
    edits: e.rows.map(r => rowToObj_(e, r)).filter(o => o.status === '대기'),
    reports: openReports_().map(o => { delete o.deviceId; return o; })
  };
}

function setStatus_(key, idField, idVal, status) {
  const t = readTab_(key);
  const idx = t.rows.findIndex(r => String(r[t.col[idField]]) === String(idVal));
  if (idx < 0) return { ok: false, error: '항목을 찾을 수 없습니다.' };
  t.sheet.getRange(idx + 2, t.col.status + 1).setValue(status);
  return { ok: true };
}

function checkPin_(pin) {
  if (!pin) return false;
  const saved = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') || DEFAULT_ADMIN_PIN;
  return String(pin) === saved;
}

function changePin_(newPin) {
  newPin = String(newPin || '').trim();
  if (newPin.length < 4) return { ok: false, error: '4글자 이상으로 입력해 주세요.' };
  PropertiesService.getScriptProperties().setProperty('ADMIN_PIN', newPin);
  return { ok: true };
}

function seedActivities_(rows, force) {
  const t = readTab_('activities');
  const existing = t.rows.filter(r => filled_(t, r, 'id')).length;
  if (existing > 0 && !force) {
    return { ok: false, error: '수업 탭에 이미 ' + existing + '건이 있습니다.', existing: existing };
  }
  if (t.rows.length > 0) t.sheet.getRange(2, 1, t.rows.length, t.headers.length).clearContent();
  if (!rows.length) return { ok: true, count: 0 };
  const stamp = now_();
  const values = rows.map(o => t.headers.map(h => {
    if (h === 'status') return o.status || '게시';
    if (h === 'createdAt' || h === 'updatedAt') return o[h] || stamp;
    return safeCell_(o[h] === undefined || o[h] === null ? '' : o[h]);
  }));
  t.sheet.getRange(2, 1, values.length, t.headers.length).setValues(values);
  return { ok: true, count: values.length };
}

/* ----------------------------- 시트 도우미 ----------------------------- */

function ss_() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function getTab_(key) {
  const def = TABS[key];
  const ss = ss_();
  let sh = ss.getSheetByName(def.name);
  if (!sh) {
    sh = ss.insertSheet(def.name);
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
    sh.setFrozenRows(1);
    return sh;
  }
  // 빠진 머리글이 있으면 오른쪽에 추가 (기존 칸 순서는 유지)
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const cur = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  if (cur.every(h => !h)) {
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
    sh.setFrozenRows(1);
  } else {
    const missing = def.headers.filter(h => cur.indexOf(h) < 0);
    if (missing.length) sh.getRange(1, cur.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function readTab_(key) {
  const sh = getTab_(key);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  const values = lastRow > 0 ? sh.getRange(1, 1, lastRow, lastCol).getValues() : [[]];
  const headers = values[0].map(String);
  const col = {};
  headers.forEach((h, i) => { if (h) col[h] = i; });
  // rows[i] 는 시트의 (i + 2)번째 줄. 빈 줄도 위치 유지를 위해 그대로 둠
  const rows = values.slice(1).map(r => r.map(cellOut_));
  return { sheet: sh, headers: headers, col: col, rows: rows };
}

function appendObj_(key, obj) {
  const sh = getTab_(key);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  sh.appendRow(headers.map(h => safeCell_(obj[h] === undefined || obj[h] === null ? '' : obj[h])));
}

function filled_(t, row, idField) {
  return String(row[t.col[idField]] || '').trim() !== '';
}

function rowToObj_(t, row) {
  const o = {};
  t.headers.forEach((h, i) => { if (h) o[h] = row[i]; });
  return o;
}

// 시트에 '2026-10-17 18:02' 같은 글자를 넣으면 시트가 자기 시간대로 날짜로 바꿔 저장한다.
// 그래서 읽을 때도 시트의 시간대로 풀어야 쓴 그대로 돌아온다(서울로 풀면 시트 시간대 차이만큼 밀림).
let SHEET_TZ_ = null;
function sheetTz_() {
  if (!SHEET_TZ_) { try { SHEET_TZ_ = ss_().getSpreadsheetTimeZone() || TZ; } catch (e) { SHEET_TZ_ = TZ; } }
  return SHEET_TZ_;
}
function cellOut_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, sheetTz_(), 'yyyy-MM-dd HH:mm');
  return v;
}

function safeCell_(v) {
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function now_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
}

function clean_(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max || 500);
}

function clampNum_(v, min, max, def) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function listStr_(v) {
  if (Array.isArray(v)) return v.map(x => clean_(x, 60)).filter(Boolean).join(',');
  return clean_(v, 300);
}

function youtubeId_(url) {
  const m = String(url || '').match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : '';
}

function translateAll_(text, src) {
  const out = {};
  LANGS.forEach(l => {
    if (!text) { out[l] = ''; return; }
    if (l === src) { out[l] = text; return; }
    try { out[l] = LanguageApp.translate(text, src, l); } catch (e) { out[l] = text; }
  });
  return out;
}

/** 편집기에서 한 번 실행하면 권한 승인과 탭 생성이 끝납니다. */
function setup() {
  Object.keys(TABS).forEach(getTab_);
  LanguageApp.translate('안녕하세요', 'ko', 'en');
  UrlFetchApp.fetch('https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=IpcjL_xvkQY');
}
