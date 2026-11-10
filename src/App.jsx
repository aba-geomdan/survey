import React, { useState, useEffect, useMemo, useRef } from "react";

/* ══════════════════════════════════════════════════════════════════
   검단ABA 설문 시스템  v2.0
   ──────────────────────────────────────────────────────────────────
   주소에 따라 세 화면으로 갈린다.

     ?t=<토큰>        → 강화제 평가 설문 (등록된 아동, 개별 링크)
     ?form=inquiry    → 상담 신청서 (공개 링크 · 홈페이지·인스타에 게시)
     (없음)           → 선생님 화면 (로그인)

   선생님 화면은 권한에 따라 다르다.
     관리자  : 문의 관리 · 링크 만들기 · 받은 응답(전체) · 보낸 링크
     선생님  : 받은 응답(본인 배정분만)

   흐름
     상담 신청 → 상담 → 등록 확정 → 통합본에서 아동 생성
       → 문의 관리에서 아동 연결 + 담당 선생님 배정 → 강화제 링크 발급
       → 학부모 제출 → 담당 선생님 화면에 표시
   ══════════════════════════════════════════════════════════════════ */

const SUPABASE_URL = "https://vdubgrxwijydwfabwpnk.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZkdWJncnh3aWp5ZHdmYWJ3cG5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MDk1ODgsImV4cCI6MjA5NzE4NTU4OH0.nqNO3vany3M6fzmG5BG6QVdvi8BW2UbhTDhxNnwvA88";

const ABA_OWNER_ID = "aecb8a9c-000e-4ad5-9805-83450e9bc585";
const CHILDREN_KEY = "gd-aba-v5-children";
const AUTH_SESSION_KEY = "sb-rein-auth-session";

const PK = "#F5A0B1";
const PKD = "#D4728A";
const PKL = "#FFF0F3";

const STATUSES = ["상담예정", "등록", "대기", "미등록"];
function badgeClass(s) {
  if (s === "상담예정") return "badge-new";
  if (s === "대기") return "badge-wait";
  if (s === "미등록") return "badge-off";
  return "";
}

/* 대기 목록에 바로 보여줄 희망 조건 — 자리가 났을 때 누구에게 연락할지 한눈에 */
function wishText(answers) {
  const a = answers || {};
  const days = (a.days && a.days.v) || [];
  const times = (a.times && a.times.v) || [];
  const parts = [];
  if (days.length > 0) parts.push(days.join("·"));
  if (times.length > 0) parts.push(times.join("·"));
  return parts.join(" / ");
}

/* 며칠째 기다리는지 */
function waitingDays(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}
function waitingText(iso) {
  const d = waitingDays(iso);
  if (d === null) return "";
  if (d < 7) return d + "일째";
  if (d < 30) return Math.floor(d / 7) + "주째";
  return Math.floor(d / 30) + "개월째";
}

/* ══════════════════════════════════════════════════════════════════
   1. Supabase 접근
   ══════════════════════════════════════════════════════════════════ */

function getSession() {
  try {
    const raw = sessionStorage.getItem(AUTH_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function saveSession(s) {
  try {
    if (s) sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(AUTH_SESSION_KEY);
  } catch (e) {
    /* 저장 실패해도 이번 세션은 계속 쓸 수 있다 */
  }
}

async function refreshSession(refreshToken) {
  try {
    const r = await fetch(
      SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }
    );
    if (!r.ok) return null;
    const data = await r.json();
    if (data && data.access_token) {
      saveSession(data);
      return data;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function getAccessToken() {
  const s = getSession();
  if (!s) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (s.expires_at && s.expires_at > nowSec + 60 && s.access_token) {
    return s.access_token;
  }
  if (s.refresh_token) {
    const fresh = await refreshSession(s.refresh_token);
    if (fresh && fresh.access_token) return fresh.access_token;
  }
  return s.access_token || null;
}

async function staffHeaders() {
  const token = await getAccessToken();
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: "Bearer " + (token || SUPABASE_ANON_KEY),
    "Content-Type": "application/json",
  };
}

/* 토큰이 만료됐으면 새로 받아 한 번 다시 시도한다.
   그래도 안 되면 세션을 비우고 로그인 화면으로 돌린다. */
async function forceRefresh() {
  const s = getSession();
  if (!s || !s.refresh_token) return null;
  return await refreshSession(s.refresh_token);
}

async function authedFetch(url, opts, retried) {
  const base = await staffHeaders();
  const o = opts || {};
  const r = await fetch(url, {
    method: o.method || "GET",
    headers: Object.assign({}, base, o.headers || {}),
    body: o.body,
  });
  if (r.status === 401 || r.status === 403) {
    if (!retried) {
      const fresh = await forceRefresh();
      if (fresh) return authedFetch(url, opts, true);
    }
    saveSession(null);
    try {
      window.location.reload();
    } catch (e) {
      /* 새로고침이 막혀 있어도 아래 오류로 알린다 */
    }
    throw new Error("로그인이 만료되었습니다. 다시 로그인해 주세요.");
  }
  return r;
}

function anonHeaders() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: "Bearer " + SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
  };
}

async function signIn(email, password) {
  const r = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email: email, password: password }),
  });
  const data = await r.json().catch(function () {
    return null;
  });
  if (!r.ok || !data || !data.access_token) {
    throw new Error(
      (data && (data.error_description || data.msg)) ||
        "로그인하지 못했습니다. 이메일과 비밀번호를 확인해 주세요."
    );
  }
  saveSession(data);
  try {
    sessionStorage.removeItem("rein-handoff-used");   // 직접 로그인했으면 넘겨받기 안내는 지운다
  } catch (e) {}
  return data;
}

async function rpc(name, body, useStaff) {
  const url = SUPABASE_URL + "/rest/v1/rpc/" + name;
  const payload = JSON.stringify(body || {});
  const r = useStaff
    ? await authedFetch(url, { method: "POST", body: payload })
    : await fetch(url, { method: "POST", headers: anonHeaders(), body: payload });
  if (!r.ok) {
    const t = await r.text().catch(function () {
      return "";
    });
    throw new Error("요청이 실패했습니다 (HTTP " + r.status + ") " + t);
  }
  return await r.json();
}

/* ── 학부모 ── */
async function reinOpen(token) {
  const rows = await rpc("rein_open", { p_token: token }, false);
  if (!rows || rows.length === 0) return null;
  return rows[0];
}
async function reinSubmit(token, answers) {
  return (await rpc("rein_submit", { p_token: token, p_answers: answers }, false)) === true;
}
async function inquirySubmit(answers) {
  return (await rpc("inquiry_submit", { p_answers: answers }, false)) === true;
}

/* ── 선생님 ── */
async function checkAdmin() {
  try {
    return (await rpc("is_admin", {}, true)) === true;
  } catch (e) {
    return false;
  }
}
async function staffList() {
  return await rpc("rein_staff_list", {}, true);
}

/* 아동 목록 읽기
   통합본은 아동을 `child:<id>` 키에 하나씩 저장한다.
   이름만 서버에서 뽑아 오므로 전송량이 작다 (아동 한 명당 수십 바이트).
   예전 방식(gd-aba-v5-children 한 덩어리)으로 저장된 경우도 대비해 둔다. */
/* 아동 목록 읽기
   서버 함수 rein_child_list() 가 이름·담당자만 뽑아 돌려준다.
   아동 데이터를 통째로 받지 않으므로 전송량이 거의 들지 않는다.
   함수가 아직 없는 환경을 대비해 예전 방식도 남겨 둔다. */
async function loadChildren() {
  // 1) 서버 함수
  try {
    const rows = await rpc("rein_child_list", {}, true);
    if (Array.isArray(rows) && rows.length > 0) {
      return rows.map(function (x) {
        return { id: x.id, name: x.name || "(이름 없음)", owner: x.owner || "" };
      });
    }
    if (Array.isArray(rows)) return [];
  } catch (e) {
    /* 함수가 없으면 아래 예전 방식으로 */
  }

  // 2) 예전 방식 — 한 덩어리로 저장된 경우
  const r2 = await authedFetch(
    SUPABASE_URL +
      "/rest/v1/aba_data?user_id=eq." +
      ABA_OWNER_ID +
      "&key=eq." +
      encodeURIComponent(CHILDREN_KEY) +
      "&select=value"
  );
  if (!r2.ok) throw new Error("아동 목록을 읽지 못했습니다 (HTTP " + r2.status + ")");
  const rows2 = await r2.json();
  if (!rows2 || rows2.length === 0) return [];
  let arr = rows2[0].value;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch (e) {
      throw new Error("아동 목록의 형식을 읽지 못했습니다.");
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(function (c) {
      if (!c || !c.id) return false;
      if (c.deletedAt) return false;
      if (c.info && c.info.archivedAt) return false;
      return true;
    })
    .map(function (c) {
      return {
        id: c.id,
        name: (c.info && c.info.name) || "(이름 없음)",
        owner: (c.info && c.info.ownerName) || "",
      };
    })
    .sort(function (a, b) {
      return a.name.localeCompare(b.name, "ko");
    });
}

/* ★ 보관 아동 id 읽기 — 통합본에서 보관한 아동을 '없는 아동'과 구분하려고 따로 받아 온다.
   서버 함수가 없거나 실패하면 null 을 돌려주고, 그때는 예전처럼 표시한다. */
async function loadArchivedIds() {
  try {
    const rows = await rpc("rein_archived_ids", {}, true);
    if (!Array.isArray(rows)) return null;
    return rows.map(function (x) {
      return x && typeof x === "object" ? x.id : x;
    }).filter(Boolean);
  } catch (e) {
    return null;
  }
}

/* ★ 통합본 담당 따라가기
   원장이 설문 앱을 열면 통합본 담당 치료사를 읽어 강화제 응답 배정을 맞춘다.
   보관한 아동도 포함한다. 이름이 계정과 맞지 않는 아동은 건드리지 않는다.
   서버 함수가 없거나 실패하면 아무것도 바꾸지 않는다. */
async function loadChildOwners() {
  try {
    const rows = await rpc("rein_child_owners", {}, true);
    return Array.isArray(rows) ? rows : null;
  } catch (e) {
    return null;
  }
}
function normName(n) {
  return String(n || "").replace(/\s+/g, "").replace(/(선생님|원장님|원장)$/, "");
}
async function syncAssignFromOwners(staff) {
  const owners = await loadChildOwners();
  if (!owners || !staff || staff.length === 0) return 0;
  // 선생님 이름 → 계정 (같은 이름이 둘이면 쓰지 않는다)
  const byName = {};
  const dup = {};
  staff.forEach(function (s) {
    const k = normName(s.name);
    if (!k) return;
    if (byName[k]) dup[k] = true;
    else byName[k] = s.id;
  });
  const ownerOf = {};
  owners.forEach(function (o) {
    if (!o || !o.id) return;
    const k = normName(o.owner);
    if (k && byName[k] && !dup[k]) ownerOf[o.id] = byName[k];
  });
  const surveys = await loadSurveys();
  let changed = 0;
  for (let i = 0; i < (surveys || []).length; i++) {
    const sv = surveys[i];
    const want = ownerOf[sv.child_id];
    if (!want || sv.assigned_to === want) continue;
    try {
      await assignSurvey(sv.id, want);
      changed++;
    } catch (e) {
      /* 한 건이 안 돼도 나머지는 계속한다 */
    }
  }
  return changed;
}

async function createLink(child, assignedTo) {
  const r = await authedFetch(SUPABASE_URL + "/rest/v1/rein_links", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      child_id: child.id,
      child_name: child.name,
      owner_name: child.owner || "",
      assigned_to: assignedTo || null,
    }),
  });
  if (!r.ok) throw new Error("링크를 만들지 못했습니다 (HTTP " + r.status + ")");
  const rows = await r.json();
  if (!rows || rows.length === 0) throw new Error("링크를 만들지 못했습니다.");
  return rows[0];
}

async function loadSurveys() {
  const url =
    SUPABASE_URL +
    "/rest/v1/rein_surveys?select=id,child_id,child_name,answers,assigned_to,submitted_at" +
    "&order=submitted_at.desc&limit=300";
  const r = await authedFetch(url);
  if (!r.ok) throw new Error("응답을 읽지 못했습니다 (HTTP " + r.status + ")");
  return await r.json();
}

async function assignSurvey(id, userId) {
  const r = await authedFetch(SUPABASE_URL + "/rest/v1/rein_surveys?id=eq." + id, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ assigned_to: userId || null }),
  });
  if (!r.ok) throw new Error("배정하지 못했습니다 (HTTP " + r.status + ")");
}

/* 등록 한 번에 — 통합본에 아동 생성 + 문의 연결 + 담당 배정 + 강화제 링크 */
async function registerChild(inquiryId, name, birth, ownerName, assignedTo, force) {
  const rows = await rpc(
    "rein_register_child",
    {
      p_inquiry_id: inquiryId || null,
      p_name: name,
      p_birth: birth || "",
      p_owner_name: ownerName || "",
      p_assigned_to: assignedTo || null,
      p_force: !!force,
    },
    true
  );
  if (!rows || rows.length === 0) throw new Error("등록하지 못했습니다.");
  return rows[0];
}

/* 이미 통합본에 있는 아동과 잇기 (되돌리기용) */
async function linkExistingChild(inquiryId, childId, childName, assignedTo) {
  return await rpc(
    "rein_link_existing",
    {
      p_inquiry_id: inquiryId || null,
      p_child_id: childId,
      p_child_name: childName || "",
      p_assigned_to: assignedTo || null,
    },
    true
  );
}

/* 연결 해제 — 통합본에서 아동을 지웠을 때 문의를 다시 '상담예정'으로 돌린다.
   그 아동 앞으로 나간 강화제 링크는 만료시켜, 없는 아동에게 응답이 쌓이지 않게 한다. */
async function unlinkInquiry(id, childId) {
  const r = await authedFetch(SUPABASE_URL + "/rest/v1/inquiries?id=eq." + id, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ child_id: null, status: "상담예정", assigned_to: null }),
  });
  if (!r.ok) throw new Error("연결을 해제하지 못했습니다 (HTTP " + r.status + ")");
  const rows = await r.json();
  if (childId) {
    await authedFetch(
      SUPABASE_URL + "/rest/v1/rein_links?child_id=eq." + encodeURIComponent(childId),
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ expires_at: new Date().toISOString() }),
      }
    );
  }
  return rows && rows[0];
}

/* 문의 삭제 */
async function deleteInquiry(id) {
  const r = await authedFetch(SUPABASE_URL + "/rest/v1/inquiries?id=eq." + id, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  if (!r.ok) throw new Error("삭제하지 못했습니다 (HTTP " + r.status + ")");
}

/* 강화제 응답 삭제 */
async function deleteSurvey(id) {
  const r = await authedFetch(SUPABASE_URL + "/rest/v1/rein_surveys?id=eq." + id, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  if (!r.ok) throw new Error("삭제하지 못했습니다 (HTTP " + r.status + ")");
}

async function loadInquiries() {
  const url =
    SUPABASE_URL +
    "/rest/v1/inquiries?select=*&order=created_at.desc&limit=300";
  const r = await authedFetch(url);
  if (!r.ok) throw new Error("문의를 읽지 못했습니다 (HTTP " + r.status + ")");
  return await r.json();
}

async function patchInquiry(id, changes) {
  const r = await authedFetch(SUPABASE_URL + "/rest/v1/inquiries?id=eq." + id, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(changes),
  });
  if (!r.ok) throw new Error("저장하지 못했습니다 (HTTP " + r.status + ")");
  const rows = await r.json();
  return rows && rows[0];
}

/* ── 설문 현황판 (원장·실장) ── */
async function loadBoard() {
  return await rpc("survey_board", {}, true);
}
/* 열어 본 설문은 '새로 들어옴'에서 '확인 끝남'으로 — 실패해도 화면은 그대로 쓴다 */
function markChecked(kind, id) {
  return rpc("survey_mark_checked", { p_kind: kind, p_id: id }, true).catch(function () {
    return false;
  });
}
/* 메일·시간표 앱이 이 주소로 연결되도록 설문 앱 주소를 적어 둔다 */
function saveAppUrl() {
  const url = window.location.origin + window.location.pathname;
  return rpc("survey_set_app_url", { p_url: url }, true).catch(function () {
    return false;
  });
}

/* ══════════════════════════════════════════════════════════════════
   2. 문항 정의
   ══════════════════════════════════════════════════════════════════ */

const REIN_Q = [
  { sec: "작성 정보" },
  { id: "relation", n: 1, label: "아동과의 관계", type: "single",
    options: ["어머니", "아버지", "조부모"], etc: true, required: true },

  { sec: "안전 확인", note: "수업에서 반드시 지켜야 할 내용입니다." },
  { id: "allergy", n: 2, label: "알레르기가 있거나 먹으면 안 되는 음식이 있나요?",
    type: "yesno", detailLabel: "어떤 음식인지 적어 주세요", required: true },
  { id: "choking", n: 3, label: "삼킴 위험이나 질감 때문에 피해야 할 것이 있나요?",
    type: "yesno", detailLabel: "예: 견과류, 작은 부품", required: true },

  { sec: "좋아하는 것", note: "해당하는 것을 모두 눌러 주세요. 없으면 넘어가셔도 됩니다." },
  { id: "food", n: 4, label: "음식·간식", type: "multi",
    options: ["과자류", "초콜릿류", "젤리·사탕", "빵·케이크", "과일", "아이스크림", "시리얼"],
    etc: true, detailLabel: "구체적인 제품명을 아시면 적어 주세요" },
  { id: "drink", n: 5, label: "음료", type: "multi",
    options: ["물", "우유", "주스", "요구르트", "탄산음료"], etc: true },
  { id: "toy", n: 6, label: "장난감·책", type: "multi",
    options: ["자동차·기차", "블록·레고", "인형·피규어", "퍼즐", "공", "그림책", "소리 나는 장난감"],
    etc: true, detailLabel: "특별히 좋아하는 이름이 있으면 적어 주세요" },
  { id: "media", n: 7, label: "영상·노래·캐릭터", type: "multi",
    options: ["유튜브", "TV 만화", "노래·동요", "특정 캐릭터"],
    etc: true, detailLabel: "채널명·프로그램명·캐릭터 이름" },
  { id: "activity", n: 8, label: "활동", type: "multi",
    options: ["비눗방울", "트램폴린", "그네·미끄럼틀", "물놀이", "그림 그리기", "블록 쌓기", "산책", "춤추기", "까꿍놀이"],
    etc: true },
  { id: "sensory", n: 9, label: "감각 자극", type: "multi",
    options: ["꽉 안아주기", "빙글빙글 돌기", "진동", "물·모래 만지기", "특정 촉감의 천·인형", "불빛 보기", "소리 듣기"],
    etc: true },
  { id: "social", n: 10, label: "사회적·신체적 접촉", type: "multi",
    options: ["간지럽히기", "머리 쓰다듬기", "안아주기", "하이파이브", "박수·칭찬", "비행기 태우기"],
    etc: true },

  { sec: "요즘 달라진 것", note: "없으면 비워 두셔도 됩니다." },
  { id: "new_like", n: 11, label: "요즘 새로 좋아하게 된 것", type: "text" },
  { id: "faded", n: 12, label: "예전에는 좋아했는데 요즘 시들해진 것", type: "text" },

  { sec: "순위", note: "앞에서 고르신 것들이 아래에 뜹니다. 눌러서 채우거나 직접 적어 주세요." },
  { id: "rank", n: 13, label: "가장 좋아하는 것 5가지를 순서대로 적어 주세요 (3가지 이상)", type: "rank", required: true },

  { sec: "집에서는 어떤가요" },
  { id: "always", n: 14, label: "집에서 아이가 언제든 가질 수 있는 것", type: "pick" },
  { id: "special", n: 15, label: "특별한 때만 주는 것", type: "pick" },

  { sec: "수업에서의 사용" },
  { id: "avoid", n: 16, label: "수업에서 사용하지 않았으면 하는 것이 있나요?",
    type: "yesno", detailLabel: "무엇을, 어떤 이유인지 적어 주세요", required: true },
  { id: "unlimited", n: 17, label: "수업에서 제한 없이 사용해도 되는 것", type: "pick" },
  { id: "token", n: 18, label: "스티커판·토큰판처럼 모아서 받는 보상을 써 본 적이 있나요?", type: "single",
    options: ["써 봤고 잘 맞았다", "써 봤지만 잘 안 맞았다", "써 본 적 없다"] },

  { sec: "싫어하는 것" },
  { id: "dislike_sense", n: 19, label: "싫어하는 소리·촉감·환경", type: "multi",
    options: ["큰 소리", "특정 촉감", "밝은 빛", "사람 많은 곳", "낯선 사람"], etc: true },
  { id: "dislike_task", n: 20, label: "싫어하는 활동·상황", type: "multi",
    options: ["기다리기", "정리하기", "옷 갈아입기", "손 씻기·양치", "자리에 앉아 있기", "하던 것 멈추기"], etc: true },

  { sec: "그 밖에" },
  { id: "extra", n: 21, label: "더 알려주고 싶은 것이 있으면 자유롭게 적어 주세요", type: "text" },

  // ── 예전 설문에만 있던 문항 — 새 설문에는 나오지 않고, 예전 응답을 볼 때 답이 있을 때만 보인다 ──
  { sec: "예전 설문 항목", legacy: true },
  { id: "place", n: "참고", label: "장소", type: "multi", legacy: true,
    options: ["놀이터", "키즈카페", "마트", "공원", "차 안", "집 특정 공간"], etc: true },
  { id: "person", n: "참고", label: "좋아하는 사람", type: "multi", legacy: true,
    options: ["엄마", "아빠", "형제자매", "조부모", "또래 친구"], etc: true },
  { id: "mand_how", n: "참고", label: "원하는 것이 있을 때 알리는 방법", type: "multi", legacy: true,
    options: ["말로 한다", "가리킨다", "손을 끌고 간다", "그림·카드를 준다", "몸짓·수어", "직접 가져간다", "울거나 떼를 쓴다"], etc: true },
  { id: "dislike", n: "참고", label: "아이가 정말 싫어하는 것", type: "multi", legacy: true,
    options: ["큰 소리", "특정 촉감", "낯선 사람", "기다리기", "정리하기", "옷 갈아입기"], etc: true },
];

/* 학부모가 작성하는 화면에는 예전 문항(legacy)을 빼고 보여 준다 */
const REIN_FORM_Q = REIN_Q.filter(function (q) {
  return !q.legacy;
});

/* 상담 전 사전 설문 — 9번(신경 쓰이는 부분) 선택에 따라 뒤 문항이 갈린다.
   showIf 가 붙은 문항·구역은 그 값을 고른 사람에게만 보인다. */
const CONCERNS = [
  "말·의사소통",
  "도움이 필요한 행동",
  "또래·사회성",
  "학습·학교 준비",
  "일상생활",
  "감각(소리·촉감 등에 예민함)",
  "아직 잘 모르겠음",
];

const INQ_Q = [
  { sec: "아동 정보" },
  { id: "childName", n: 1, label: "아동 이름", type: "line", required: true },
  { id: "birth", n: 2, label: "생년월일", type: "date", required: true },
  { id: "sex", n: 3, label: "성별", type: "single", options: ["남", "여"] },
  { id: "siblings", n: 4, label: "형제자매", type: "line", placeholder: "예: 2살 위 누나 · 없음" },
  { id: "school", n: 5, label: "교육기관", type: "single",
    options: ["미등원", "어린이집", "유치원", "초등학교", "중학교 이상"] },

  { sec: "보호자 연락처" },
  { id: "guardian", n: 6, label: "보호자 성함과 관계", type: "line", required: true,
    placeholder: "예: 김○○ (어머니)" },
  { id: "phone", n: 7, label: "연락처", type: "tel", required: true,
    placeholder: "010-0000-0000" },

  { sec: "발달·치료 이력", note: "알고 계신 만큼만 적어 주시면 됩니다." },
  { id: "diagnosis", n: 8, label: "발달 관련 검사나 진단을 받은 적이 있나요?", type: "single",
    options: ["없음", "검사만 받음", "진단 받음", "진행 중"],
    note: "진단명은 적지 않으셔도 됩니다. 검사 보고서가 있으시면 상담 때 가져와 주세요." },
  { id: "therapy", n: 9, label: "받고 있거나 받았던 치료·교육이 있나요?", type: "multi",
    options: ["언어치료", "감각통합치료", "놀이치료", "미술·음악치료", "ABA·행동치료", "없음"], etc: true,
    exclusive: ["없음"] },

  { sec: "요즘 아이 모습" },
  { id: "requestHow", n: 10, label: "원하는 것이 있을 때 주로 어떻게 알리나요?", type: "multi",
    options: ["말로 한다", "가리킨다", "손을 끌고 간다", "그림·카드를 쓴다", "몸짓으로 알린다", "울거나 떼를 쓴다"],
    etc: true },
  { id: "hardest", n: 11, label: "요즘 가장 어려운 점과, 주로 어떤 때 그런지 적어 주세요", type: "text",
    note: "예: 원하는 걸 못 하게 하면 울면서 누워요 · 어린이집 등원할 때 힘들어해요" },
  { id: "concern", n: 12, label: "도움이 필요한 부분을 모두 골라 주세요", type: "multi",
    options: CONCERNS, required: true, note: "고르신 것에 맞는 짧은 질문이 아래에 나옵니다." },

  /* ── 고른 부분마다 2문항 ─────────────────────────────── */
  { sec: "말·의사소통에 대해", showIf: { id: "concern", anyOf: ["말·의사소통"] } },
  { id: "lExpress", n: "L1", label: "지금 어떻게 표현하나요?", type: "single",
    options: ["아직 말이 나오지 않음", "단어 하나", "두세 단어 조합", "문장으로 말함"],
    showIf: { id: "concern", anyOf: ["말·의사소통"] } },
  { id: "lUnderstand", n: "L2", label: "어른의 말은 얼마나 이해하나요?", type: "single",
    options: ["이름 부르면 반응", "간단한 지시를 따름", "두 단계 지시를 따름", "잘 모르겠음"],
    showIf: { id: "concern", anyOf: ["말·의사소통"] } },

  { sec: "도움이 필요한 행동에 대해", showIf: { id: "concern", anyOf: ["도움이 필요한 행동", "행동"] } },
  { id: "bHow", n: "B1", label: "어떤 모습으로 나타나나요?", type: "multi",
    options: ["울거나 소리 지름", "바닥에 눕거나 버팀", "물건을 던지거나 부숨",
      "사람을 때리거나 밈", "자기 몸을 때리거나 부딪침", "자리를 벗어남", "말로 거칠게 표현함"],
    etc: true, showIf: { id: "concern", anyOf: ["도움이 필요한 행동", "행동"] } },
  { id: "bInjury", n: "B2", label: "다치거나 다치게 한 적이 있나요?", type: "yesno",
    detailLabel: "어떤 상황이었는지 간단히 적어 주세요",
    showIf: { id: "concern", anyOf: ["도움이 필요한 행동", "행동"] } },

  { sec: "또래·사회성에 대해", showIf: { id: "concern", anyOf: ["또래·사회성"] } },
  { id: "sPeer", n: "S1", label: "또래와 있을 때 어떤가요?", type: "single",
    options: ["관심 없어 보임", "관심은 있는데 다가가지 못함", "다가가지만 방식이 서툼", "잘 어울림"],
    showIf: { id: "concern", anyOf: ["또래·사회성"] } },
  { id: "sEye", n: "S2", label: "눈맞춤은 어떤가요?", type: "single",
    options: ["잘 안 함", "가끔 함", "자주 함"],
    showIf: { id: "concern", anyOf: ["또래·사회성"] } },

  { sec: "학습·학교 준비에 대해", showIf: { id: "concern", anyOf: ["학습·학교 준비"] } },
  { id: "aSit", n: "A1", label: "앉아서 하는 활동을 얼마나 유지하나요?", type: "single",
    options: ["1분도 어려움", "1~2분", "5분쯤", "10분 이상"],
    showIf: { id: "concern", anyOf: ["학습·학교 준비"] } },
  { id: "aHard", n: "A2", label: "어려워하는 부분", type: "multi",
    options: ["지시 따르기", "차례 기다리기", "집중 유지", "글자·숫자", "손 쓰는 활동"],
    etc: true, showIf: { id: "concern", anyOf: ["학습·학교 준비"] } },

  { sec: "일상생활에 대해", showIf: { id: "concern", anyOf: ["일상생활"] } },
  { id: "dToilet", n: "D1", label: "배변", type: "single",
    options: ["아직 기저귀를 사용해요", "어른이 시간 맞춰 데려가요", "스스로 표현해요", "스스로 해결해요"],
    showIf: { id: "concern", anyOf: ["일상생활"] } },
  { id: "dDaily", n: "D2", label: "식사·수면에서 어려운 점", type: "multi",
    options: ["혼자 먹기 어려움", "편식이 심함", "잠들기 어려움", "자주 깸", "특별히 없음"],
    etc: true, exclusive: ["특별히 없음"], showIf: { id: "concern", anyOf: ["일상생활"] } },

  { sec: "희망 사항" },
  { id: "days", n: 13, label: "희망 요일", type: "multi",
    options: ["월", "화", "수", "목", "금"] },
  { id: "times", n: 14, label: "희망 시간대", type: "multi",
    options: ["오전", "이른 오후 (12~3시)", "늦은 오후 (3~6시)"] },
  { id: "source", n: 15, label: "저희를 어떻게 알게 되셨나요?", type: "single", required: true,
    options: ["홈페이지", "인스타그램", "블로그", "지인 소개", "인쇄물·현수막", "검색"], etc: true },
  { id: "question", n: 16, label: "상담에서 가장 알고 싶은 점이나 기대하시는 도움", type: "text" },

  // ── 예전 신청서에만 있던 문항 — 새 신청서에는 나오지 않고, 예전 신청서를 볼 때 답이 있을 때만 보인다 ──
  { sec: "예전 신청서 항목", legacy: true },
  { id: "relation", n: "참고", label: "아동과의 관계", type: "single", legacy: true, options: ["어머니", "아버지", "조부모"], etc: true },
  { id: "grade", n: "참고", label: "학년·반", type: "line", legacy: true },
  { id: "report", n: "참고", label: "검사 보고서를 가지고 계신가요?", type: "single", legacy: true, options: ["있음", "없음", "진행 중"] },
  { id: "lEcho", n: "참고", label: "들은 말을 그대로 따라 하는 경우", type: "single", legacy: true, options: ["거의 없음", "가끔 있음", "자주 있음"] },
  { id: "lAac", n: "참고", label: "말 외에 쓰는 방법", type: "multi", legacy: true, options: ["손짓·가리키기", "그림카드", "기기", "없음"], etc: true },
  { id: "bWhen", n: "참고", label: "행동이 주로 나타나는 상황", type: "multi", legacy: true, options: [], etc: true },
  { id: "bFreq", n: "참고", label: "행동 빈도", type: "single", legacy: true, options: [] },
  { id: "bResponse", n: "참고", label: "그럴 때 보호자 대응", type: "text", legacy: true },
  { id: "bGood", n: "참고", label: "잘 지내는 상황", type: "text", legacy: true },
  { id: "sHard", n: "참고", label: "특별히 어려워하는 상황(또래)", type: "text", legacy: true },
  { id: "aFeedback", n: "참고", label: "학교·유치원에서 들은 이야기", type: "text", legacy: true },
  { id: "dMeal", n: "참고", label: "식사", type: "single", legacy: true, options: [] },
  { id: "dPicky", n: "참고", label: "편식", type: "single", legacy: true, options: [] },
  { id: "dSleep", n: "참고", label: "수면", type: "single", legacy: true, options: [] },
  { id: "dHard", n: "참고", label: "특별히 힘든 부분(일상생활)", type: "text", legacy: true },
  { id: "start", n: "참고", label: "시작 희망 시기", type: "single", legacy: true, options: [] },
];

/* 학부모가 작성하는 화면에는 예전 문항(legacy)을 빼고 보여 준다 */
const INQ_FORM_Q = INQ_Q.filter(function (q) {
  return !q.legacy;
});

/* 분기 판정 — showIf 가 없으면 항상 보인다 */
function isVisible(q, answers) {
  const c = q && q.showIf;
  if (!c) return true;
  const a = answers && answers[c.id];
  if (!a) return false;
  const picked = Array.isArray(a.v) ? a.v : (a.v ? [a.v] : []);
  return (c.anyOf || []).some(function (x) {
    return picked.indexOf(x) !== -1;
  });
}

function fieldsOf(qs) {
  return qs.filter(function (q) {
    return q.id;
  });
}

function blankAnswers(qs) {
  const a = {};
  fieldsOf(qs).forEach(function (q) {
    if (q.type === "single") a[q.id] = { v: "", etc: "" };
    else if (q.type === "multi") a[q.id] = { v: [], etc: "", detail: "" };
    else if (q.type === "yesno") a[q.id] = { v: "", detail: "" };
    else if (q.type === "rank") a[q.id] = { v: ["", "", "", "", ""] };
    else if (q.type === "pick") a[q.id] = { v: [], etc: "" };
    else a[q.id] = { v: "" };
  });
  return a;
}

function collectPool(answers) {
  const pool = [];
  const push = function (s) {
    const t = (s || "").trim();
    if (t && pool.indexOf(t) === -1) pool.push(t);
  };
  ["food", "drink", "toy", "media", "activity", "sensory", "social", "place", "person"].forEach(
    function (id) {
      const a = answers[id];
      if (!a) return;
      (a.v || []).forEach(push);
      if (a.etc) a.etc.split(/[,·]/).forEach(push);
      if (a.detail) a.detail.split(/[,·]/).forEach(push);
    }
  );
  // 요즘 새로 좋아하게 된 것(글로 적는 칸)도 쉼표·줄바꿈으로 나눠 보기에 넣는다
  const nl = answers.new_like;
  if (nl && typeof nl.v === "string") nl.v.split(/[,·\n]/).forEach(push);
  return pool;
}

function answerText(q, val) {
  // 값의 모양이 예상과 달라도 절대 멈추지 않게 — 통합본 화면 전체를 지키기 위해
  try {
    if (!val || typeof val !== "object") return val == null ? "" : String(val);
    const str = (x) => (x == null ? "" : String(x));
    const list = (x) => (Array.isArray(x) ? x.map(str).filter(Boolean) : (x ? [str(x)] : []));
    if (q.type === "single") {
      return [str(val.v), str(val.etc)].filter(Boolean).join(" · ");
    }
    if (q.type === "multi" || q.type === "pick") {
      const parts = list(val.v);
      if (val.etc) parts.push(str(val.etc));
      if (val.detail) parts.push("→ " + str(val.detail));
      return parts.join(", ");
    }
    if (q.type === "yesno") {
      if (val.v === "있음") return "있음 — " + (str(val.detail) || "(내용 없음)");
      return str(val.v);
    }
    if (q.type === "rank") {
      return list(val.v).length === 0 ? "" : (Array.isArray(val.v) ? val.v : [val.v])
        .map((t, i) => (t ? i + 1 + "위 " + str(t) : ""))
        .filter(Boolean)
        .join("  /  ");
    }
    return str(val.v);
  } catch (e) {
    return "";
  }
}

function validateAnswers(qs, answers) {
  const e = {};
  fieldsOf(qs).forEach(function (q) {
    if (!q.required) return;
    if (!isVisible(q, answers)) return;   // 안 보이는 문항은 검사하지 않는다
    const a = answers[q.id];
    if (!a) return;
    if (q.type === "single" && !a.v && !a.etc) e[q.id] = "선택해 주세요.";
    if (q.type === "multi" && (a.v || []).length === 0 && !(a.etc || "").trim())
      e[q.id] = "하나 이상 선택해 주세요.";
    if (q.type === "yesno") {
      if (!a.v) e[q.id] = "선택해 주세요.";
      else if (a.v === "있음" && !(a.detail || "").trim()) e[q.id] = "내용을 적어 주세요.";
    }
    if (q.type === "rank") {
      const filled = (a.v || []).filter(function (t) {
        return (t || "").trim();
      });
      if (filled.length < 3) e[q.id] = "적어도 3개는 적어 주세요.";
    }
    if (q.type === "date") {
      const p = (a.v || "").split("-");
      if (p.length !== 3 || !p[0] || !p[1] || !p[2]) e[q.id] = "연도·월·일을 모두 골라 주세요.";
    }
    if (q.type === "line" || q.type === "tel" || q.type === "text") {
      if (!(a.v || "").trim()) e[q.id] = "적어 주세요.";
    }
  });
  return e;
}

/* ══════════════════════════════════════════════════════════════════
   3. 공통 UI
   ══════════════════════════════════════════════════════════════════ */

/* ★ [로고] 센터 로고 (통합본과 같은 그림) */
const CENTER_LOGO = "data:image/png;base64,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";

/* ★ [문구 복사] 링크를 보낼 때 안내 문구까지 한 번에 복사한다 */
function msgCallName(full) {
  // '김하늘(형)'처럼 괄호가 있으면 괄호 앞까지만, 띄어쓰기는 지운다
  // 숫자·기호(예: 김하늘2)도 지운다
  var n = String(full || "").split("(")[0].replace(/[\s0-9_.\-·,]+/g, "").trim();
  if (/^[가-힣]+$/.test(n)) {
    if (n.length >= 3 && /^(남궁|황보|제갈|독고|사공)/.test(n)) n = n.slice(2);       // 거의 늘 두 글자 성
    else if (n.length >= 4 && /^(선우|서문)/.test(n)) n = n.slice(2);               // '선'·'서'는 한 글자 성도 많아 4글자일 때만
    else if (n.length >= 2) n = n.slice(1);                                       // 이름은 늘 성까지 적는다 (김솔 → 솔)
  }
  if (!n) return "아이";
  var c = n.charCodeAt(n.length - 1);
  if (c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0) return n + "이";
  return n;
}
function inquiryMessage(url) {
  return "안녕하세요. 검단ABA언어행동연구소입니다.\n" +
    "상담을 예약해 주셔서 감사합니다. 😊\n" +
    "보다 깊이 있고 의미 있는 상담을 위해, 상담 전 아래 설문 작성을 부탁드립니다.\n" +
    "작성해 주신 내용은 상담 전에 미리 살펴보고, 상담 시간에는 아이의 특성과 발달에 대해 함께 이야기 나누며 아이에게 필요한 지원과 방향을 찾아가고자 합니다.\n" +
    "감사합니다. 💛\n" + url;
}
function reinMessage(childName, url) {
  return "어머님, 안녕하세요. 검단ABA언어행동연구소입니다.\n" +
    msgCallName(childName) + "가 좋아하는 간식, 장난감, 놀이를 알아보려고 설문을 보내드립니다.\n" +
    "수업 때 활용할 수 있도록 작성 부탁드립니다.\n" + url;
}

function Chip(props) {
  return (
    <button
      type="button"
      className={"chip" + (props.on ? " chip-on" : "")}
      onClick={props.onClick}
      aria-pressed={props.on ? "true" : "false"}
    >
      {props.children}
    </button>
  );
}

/* 생년월일 — 달력을 넘기지 않고 연·월·일을 골라서 넣는다 */
function DatePick(props) {
  const parts = (props.value || "").split("-");
  const y = parts[0] || "";
  const m = parts[1] || "";
  const d = parts[2] || "";

  const thisYear = new Date().getFullYear();
  const years = [];
  for (let i = thisYear; i >= thisYear - 25; i--) years.push(String(i));

  const months = [];
  for (let i = 1; i <= 12; i++) months.push(i < 10 ? "0" + i : String(i));

  function daysIn(yy, mm) {
    if (!yy || !mm) return 31;
    return new Date(Number(yy), Number(mm), 0).getDate();
  }
  const days = [];
  for (let i = 1; i <= daysIn(y, m); i++) days.push(i < 10 ? "0" + i : String(i));

  function set(ny, nm, nd) {
    // 2월 30일 같은 값이 남지 않도록 일자를 잘라낸다
    let dd = nd;
    if (ny && nm && dd) {
      const max = daysIn(ny, nm);
      if (Number(dd) > max) dd = String(max);
    }
    props.onChange(ny || nm || dd ? [ny, nm, dd].join("-") : "");
  }

  return (
    <div className="dpick">
      <select
        className="inp sel"
        value={y}
        onChange={function (e) {
          set(e.target.value, m, d);
        }}
      >
        <option value="">연도</option>
        {years.map(function (v) {
          return (
            <option key={v} value={v}>
              {v}년
            </option>
          );
        })}
      </select>
      <select
        className="inp sel"
        value={m}
        onChange={function (e) {
          set(y, e.target.value, d);
        }}
      >
        <option value="">월</option>
        {months.map(function (v) {
          return (
            <option key={v} value={v}>
              {Number(v)}월
            </option>
          );
        })}
      </select>
      <select
        className="inp sel"
        value={d}
        onChange={function (e) {
          set(y, m, e.target.value);
        }}
      >
        <option value="">일</option>
        {days.map(function (v) {
          return (
            <option key={v} value={v}>
              {Number(v)}일
            </option>
          );
        })}
      </select>
    </div>
  );
}

function Field(props) {
  return (
    <div className={"q" + (props.error ? " q-err" : "")} ref={props.innerRef}>
      <div className="q-head">
        <span className="q-n">{props.n}</span>
        <span className="q-label">
          {props.label}
          {props.required ? <em className="q-req">필수</em> : null}
        </span>
      </div>
      {props.note ? <p className="q-note">{props.note}</p> : null}
      {props.children}
      {props.error ? <p className="q-errmsg">{props.error}</p> : null}
    </div>
  );
}

/* 문항 목록을 그리는 공통 렌더러 — 강화제 설문과 상담 신청서가 함께 쓴다 */
function QuestionList(props) {
  const answers = props.answers;
  const errors = props.errors;
  const patch = props.patch;
  const pool = props.pool || [];

  function toggleMulti(id, opt) {
    const cur = answers[id].v || [];
    let next =
      cur.indexOf(opt) === -1
        ? cur.concat([opt])
        : cur.filter(function (x) {
            return x !== opt;
          });
    // exclusive(예: '없음')를 고르면 나머지를 풀고, 다른 것을 고르면 exclusive를 푼다
    const q = props.questions.find(function (x) {
      return x.id === id;
    });
    const ex = (q && q.exclusive) || [];
    if (ex.length && next.indexOf(opt) !== -1) {
      next = ex.indexOf(opt) !== -1
        ? [opt]
        : next.filter(function (x) {
            return ex.indexOf(x) === -1;
          });
    }
    patch(id, { v: next });
  }

  return (
    <div>
      {props.questions.filter(function (q) {
        return isVisible(q, answers);
      }).map(function (q, idx) {
        if (q.sec) {
          return (
            <div className="sec" key={"s" + idx}>
              <h2 className="sec-title">{q.sec}</h2>
              {q.note ? <p className="sec-note">{q.note}</p> : null}
            </div>
          );
        }
        const a = answers[q.id];
        const err = errors[q.id];
        const setRef = function (el) {
          props.refs.current[q.id] = el;
        };
        const common = {
          n: q.n,
          label: q.label,
          note: q.note,
          required: q.required && !props.hideRequired,   // ★ 상담 신청서는 '필수' 표시를 숨김 (검사는 그대로)
          error: err,
          innerRef: setRef,
        };

        if (q.type === "single") {
          return (
            <Field key={q.id} {...common}>
              <div className="chips">
                {q.options.map(function (opt) {
                  return (
                    <Chip
                      key={opt}
                      on={a.v === opt}
                      onClick={function () {
                        patch(q.id, { v: a.v === opt ? "" : opt });
                      }}
                    >
                      {opt}
                    </Chip>
                  );
                })}
              </div>
              {q.etc ? (
                <input
                  className="inp"
                  placeholder="기타 (직접 입력)"
                  value={a.etc}
                  onChange={function (e) {
                    patch(q.id, { etc: e.target.value });
                  }}
                />
              ) : null}
            </Field>
          );
        }

        if (q.type === "multi") {
          return (
            <Field key={q.id} {...common}>
              <div className="chips">
                {q.options.map(function (opt) {
                  return (
                    <Chip
                      key={opt}
                      on={(a.v || []).indexOf(opt) !== -1}
                      onClick={function () {
                        toggleMulti(q.id, opt);
                      }}
                    >
                      {opt}
                    </Chip>
                  );
                })}
              </div>
              {q.etc ? (
                <input
                  className="inp"
                  placeholder="기타 (직접 입력)"
                  value={a.etc}
                  onChange={function (e) {
                    patch(q.id, { etc: e.target.value });
                  }}
                />
              ) : null}
              {q.detailLabel ? (
                <input
                  className="inp"
                  placeholder={q.detailLabel}
                  value={a.detail}
                  onChange={function (e) {
                    patch(q.id, { detail: e.target.value });
                  }}
                />
              ) : null}
            </Field>
          );
        }

        if (q.type === "yesno") {
          return (
            <Field key={q.id} {...common}>
              <div className="chips">
                {["없음", "있음"].map(function (opt) {
                  return (
                    <Chip
                      key={opt}
                      on={a.v === opt}
                      onClick={function () {
                        patch(q.id, { v: opt, detail: opt === "없음" ? "" : a.detail });
                      }}
                    >
                      {opt}
                    </Chip>
                  );
                })}
              </div>
              {a.v === "있음" ? (
                <textarea
                  className="inp ta"
                  rows={2}
                  placeholder={q.detailLabel}
                  value={a.detail}
                  onChange={function (e) {
                    patch(q.id, { detail: e.target.value });
                  }}
                />
              ) : null}
            </Field>
          );
        }

        if (q.type === "rank") {
          return (
            <Field key={q.id} {...common}>
              <div className="ranks">
                {[0, 1, 2, 3, 4].map(function (i) {
                  return (
                    <div className="rank-row" key={i}>
                      <span className="rank-no">{i + 1}위</span>
                      <input
                        className="inp rank-inp"
                        value={a.v[i]}
                        placeholder={i < 3 ? "" : "(선택)"}
                        onChange={function (e) {
                          const next = a.v.slice();
                          next[i] = e.target.value;
                          patch(q.id, { v: next });
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              {pool.length > 0 ? (
                <div className="pool">
                  <p className="pool-hint">눌러서 빈 칸에 넣기</p>
                  <div className="chips">
                    {pool.map(function (item) {
                      const used = a.v.indexOf(item) !== -1;
                      return (
                        <Chip
                          key={item}
                          on={used}
                          onClick={function () {
                            const next = a.v.slice();
                            if (used) next[next.indexOf(item)] = "";
                            else {
                              const slot = next.indexOf("");
                              if (slot === -1) return;
                              next[slot] = item;
                            }
                            patch(q.id, { v: next });
                          }}
                        >
                          {item}
                        </Chip>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </Field>
          );
        }

        if (q.type === "pick") {
          return (
            <Field key={q.id} {...common}>
              {pool.length > 0 ? (
                <div className="chips">
                  {pool.map(function (item) {
                    return (
                      <Chip
                        key={item}
                        on={(a.v || []).indexOf(item) !== -1}
                        onClick={function () {
                          toggleMulti(q.id, item);
                        }}
                      >
                        {item}
                      </Chip>
                    );
                  })}
                </div>
              ) : (
                <p className="pool-empty">앞에서 좋아하는 것을 고르시면 여기에 나타납니다.</p>
              )}
              <input
                className="inp"
                placeholder="직접 입력"
                value={a.etc}
                onChange={function (e) {
                  patch(q.id, { etc: e.target.value });
                }}
              />
            </Field>
          );
        }

        if (q.type === "text") {
          return (
            <Field key={q.id} {...common}>
              <textarea
                className="inp ta"
                rows={3}
                value={a.v}
                onChange={function (e) {
                  patch(q.id, { v: e.target.value });
                }}
              />
            </Field>
          );
        }

        if (q.type === "date") {
          return (
            <Field key={q.id} {...common}>
              <DatePick
                value={a.v}
                onChange={function (val) {
                  patch(q.id, { v: val });
                }}
              />
            </Field>
          );
        }

        return (
          <Field key={q.id} {...common}>
            <input
              className="inp"
              type={q.type === "tel" ? "tel" : "text"}
              inputMode={q.type === "tel" ? "tel" : undefined}
              placeholder={q.placeholder || ""}
              value={a.v}
              onChange={function (e) {
                patch(q.id, { v: e.target.value });
              }}
            />
          </Field>
        );
      })}
    </div>
  );
}

/* 폼 상태를 다루는 훅 — 두 설문이 공유한다 */
function useForm(questions) {
  const [answers, setAnswers] = useState(function () {
    return blankAnswers(questions);
  });
  const [errors, setErrors] = useState({});
  const refs = useRef({});

  function patch(id, next) {
    setAnswers(function (prev) {
      const copy = Object.assign({}, prev);
      copy[id] = Object.assign({}, prev[id], next);
      return copy;
    });
    setErrors(function (prev) {
      if (!prev[id]) return prev;
      const c = Object.assign({}, prev);
      delete c[id];
      return c;
    });
  }

  function validate() {
    const e = validateAnswers(questions, answers);
    setErrors(e);
    const first = Object.keys(e)[0];
    if (first && refs.current[first]) {
      refs.current[first].scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return Object.keys(e).length === 0;
  }

  return { answers: answers, errors: errors, patch: patch, validate: validate, refs: refs };
}

/* ══════════════════════════════════════════════════════════════════
   4. 학부모 — 강화제 평가 설문
   ══════════════════════════════════════════════════════════════════ */

function ReinSurvey(props) {
  const token = props.token;
  const [phase, setPhase] = useState("loading");
  const [childName, setChildName] = useState("");
  const [prevCount, setPrevCount] = useState(0);
  const [sendError, setSendError] = useState("");
  const form = useForm(REIN_FORM_Q);

  useEffect(
    function () {
      let alive = true;
      reinOpen(token)
        .then(function (row) {
          if (!alive) return;
          if (!row) {
            setPhase("bad");
            return;
          }
          setChildName(row.child_name || "");
          setPrevCount(row.prev_count || 0);
          setPhase(row.expired ? "expired" : "form");
        })
        .catch(function () {
          if (alive) setPhase("bad");
        });
      return function () {
        alive = false;
      };
    },
    [token]
  );

  const pool = useMemo(
    function () {
      return collectPool(form.answers);
    },
    [form.answers]
  );

  function submit() {
    if (!form.validate()) return;
    setSendError("");
    setPhase("sending");
    reinSubmit(token, form.answers)
      .then(function (ok) {
        if (ok) setPhase("done");
        else {
          setSendError("링크가 만료되었습니다. 선생님께 새 링크를 요청해 주세요.");
          setPhase("form");
        }
      })
      .catch(function (err) {
        setSendError((err && err.message) || "저장하지 못했습니다. 잠시 후 다시 눌러 주세요.");
        setPhase("form");
      });
  }

  if (phase === "loading")
    return (
      <div className="wrap">
        <p className="notice">불러오는 중입니다…</p>
      </div>
    );
  if (phase === "bad")
    return (
      <Msg title="링크를 찾을 수 없습니다">
        주소가 잘린 채로 열렸을 수 있습니다. 받으신 링크를 다시 눌러보시고, 그래도
        같으면 선생님께 말씀해 주세요.
      </Msg>
    );
  if (phase === "expired")
    return <Msg title="기한이 지난 링크입니다">선생님께 새 링크를 요청해 주세요.</Msg>;
  if (phase === "done")
    return (
      <Msg title="제출되었습니다">
        {childName} 아동의 답변이 담당 선생님께 전달되었습니다. 수업에
        반영하겠습니다. 감사합니다.
      </Msg>
    );

  return (
    <div className="wrap">
      <header className="hero">
        <img className="hero-logo" src={CENTER_LOGO} alt="검단ABA언어행동연구소" />
        <h1 className="hero-title">
          <span className="hero-name">{childName}</span> 아동이
          <br />
          좋아하는 것을 알려 주세요!
        </h1>
        <p className="hero-body">
          아이가 좋아하는 음식, 놀이, 활동 등을 알아보고 수업에 활용하기 위한 설문입니다.
          <br />
          작성에는 약 5분 정도 소요됩니다. 정답은 없으니 평소 아이가 좋아하는 것과 즐거워하는 모습을 떠올리며 편하게 답해 주세요. 😊
        </p>
        {prevCount > 0 ? (
          <p className="hero-warn">
            이 링크로 이미 {prevCount}번 제출된 기록이 있습니다. 다시 제출하시면 새
            답변으로 추가됩니다.
          </p>
        ) : null}
      </header>

      <QuestionList
        questions={REIN_FORM_Q}
        answers={form.answers}
        errors={form.errors}
        patch={form.patch}
        refs={form.refs}
        pool={pool}
      />

      {sendError ? <p className="send-err">{sendError}</p> : null}
      <button className="submit" onClick={submit} disabled={phase === "sending"}>
        {phase === "sending" ? "보내는 중…" : "제출하기"}
      </button>
      <p className="foot">
        적어 주신 내용은 담당 선생님과 원장만 볼 수 있으며, 수업 준비에만 사용됩니다.
      </p>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   5. 학부모 — 상담 신청서 (공개)
   ══════════════════════════════════════════════════════════════════ */

function InquiryForm() {
  const [phase, setPhase] = useState("form");
  const [sendError, setSendError] = useState("");
  const form = useForm(INQ_FORM_Q);

  function submit() {
    if (!form.validate()) return;
    setSendError("");
    setPhase("sending");
    inquirySubmit(form.answers)
      .then(function (ok) {
        if (ok) setPhase("done");
        else {
          setSendError("이름과 연락처를 확인해 주세요.");
          setPhase("form");
        }
      })
      .catch(function (err) {
        setSendError((err && err.message) || "보내지 못했습니다. 잠시 후 다시 눌러 주세요.");
        setPhase("form");
      });
  }

  if (phase === "done")
    return (
      <Msg title="작성해 주셔서 감사합니다">
        상담 때 뵙겠습니다.
      </Msg>
    );

  return (
    <div className="wrap">
      <header className="hero">
        <img className="hero-logo" src={CENTER_LOGO} alt="검단ABA언어행동연구소" />
        <h1 className="hero-title">상담 전 사전 설문</h1>
        <p className="hero-body">
          안녕하세요. 검단ABA언어행동연구소입니다.
          <br />
          아이에게 더욱 알맞은 상담을 위해 간단한 사전 설문을 준비했습니다.
          <br />
          작성 시간은 약 3분 정도이며, 미리 작성해 주시면 아이의 특성과 필요를 이해하고 상담 시간에 더 깊이 있는 이야기를 나누는 데 도움이 됩니다.
          <br />
          감사합니다. 😊
        </p>
      </header>

      <QuestionList
        hideRequired
        questions={INQ_FORM_Q}
        answers={form.answers}
        errors={form.errors}
        patch={form.patch}
        refs={form.refs}
      />

      {sendError ? <p className="send-err">{sendError}</p> : null}
      <button className="submit" onClick={submit} disabled={phase === "sending"}>
        {phase === "sending" ? "보내는 중…" : "제출하기"}
      </button>
      <p className="foot">
        적어 주신 내용은 상담 준비에만 사용되며, 원장과 담당 선생님만 확인합니다.
      </p>
    </div>
  );
}

function Msg(props) {
  return (
    <div className="wrap">
      <div className="card-msg">
        <h2>{props.title}</h2>
        <p>{props.children}</p>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   6. 로그인
   ══════════════════════════════════════════════════════════════════ */

// ★ 브라우저에 저장된 이메일·비밀번호가 저절로 채워지지 않게 (autoComplete off / new-password)
function LoginBox(props) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function go() {
    setBusy(true);
    setErr("");
    signIn(email.trim(), pw)
      .then(function () {
        setBusy(false);
        props.onDone();
      })
      .catch(function (e) {
        setBusy(false);
        setErr(e.message);
      });
  }

  return (
    <div className="wrap">
      <header className="hero">
        <img className="hero-logo" src={CENTER_LOGO} alt="검단ABA언어행동연구소" />
        <h1 className="hero-title">설문 관리</h1>
      </header>
      <div className="q">
        <input
          className="inp"
          placeholder="이메일"
          value={email}
          name="sv-staff-id"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={function (e) {
            setEmail(e.target.value);
          }}
        />
        <input
          className="inp"
          type="password"
          placeholder="비밀번호"
          value={pw}
          name="sv-staff-pw"
          autoComplete="new-password"
          onChange={function (e) {
            setPw(e.target.value);
          }}
          onKeyDown={function (e) {
            if (e.key === "Enter") go();
          }}
        />
        {err ? <p className="q-errmsg">{err}</p> : null}
      </div>
      <button className="submit" onClick={go} disabled={busy}>
        {busy ? "확인 중…" : "로그인"}
      </button>
      {schedNote() ? <p className="foot">{schedNote()}</p> : null}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   7. 선생님 화면
   ══════════════════════════════════════════════════════════════════ */

function StaffConsole(props) {
  const admin = props.admin;
  const [tab, setTab] = useState(admin ? "board" : "rein");
  const [focus, setFocus] = useState(null);   // ★ 현황판에서 [답변 보기]로 넘어갈 때 바로 열 설문 { kind, id }
  const [showMake, setShowMake] = useState(false);   // 강화제 탭의 [아동에게 링크 보내기] 펼침

  const [staff, setStaff] = useState([]);
  const [staffErr, setStaffErr] = useState("");
  const [staffBusy, setStaffBusy] = useState(false);
  const [children, setChildren] = useState(null);
  const [archivedIds, setArchivedIds] = useState([]);   // ★ 통합본에서 보관한 아동 id
  const [childErr, setChildErr] = useState("");
  const [loadingChildren, setLoadingChildren] = useState(false);

  const [surveys, setSurveys] = useState(null);
  const [inquiries, setInquiries] = useState(null);

  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  const [syncNote, setSyncNote] = useState("");   // ★ 통합본 담당에 맞춘 결과
  const synced = useRef(false);

  useEffect(
    function () {
      if (!admin || synced.current || staff.length === 0) return;
      synced.current = true;
      syncAssignFromOwners(staff)
        .then(function (n) {
          if (n > 0) {
            setSyncNote("통합본 담당 치료사에 맞춰 강화제 설문 " + n + "건의 배정을 바꿨습니다.");
            setSurveys(null);   // 바뀐 배정으로 목록을 새로 불러온다
          }
        })
        .catch(function () {
          /* 맞추지 못해도 화면은 그대로 쓴다 */
        });
    },
    [admin, staff]
  );

  function fetchStaff() {
    setStaffBusy(true);
    setStaffErr("");
    staffList()
      .then(function (list) {
        setStaff(Array.isArray(list) ? list : []);
        setStaffBusy(false);
        if (!list || list.length === 0) {
          setStaffErr("선생님 계정을 찾지 못했습니다.");
        }
      })
      .catch(function (e) {
        setStaff([]);
        setStaffBusy(false);
        setStaffErr((e && e.message) || "선생님 목록을 불러오지 못했습니다.");
      });
  }

  useEffect(
    function () {
      if (!admin) return;
      fetchStaff();
      saveAppUrl();
    },
    [admin]
  );

  useEffect(
    function () {
      if (tab === "rein" && surveys === null) {
        loadSurveys()
          .then(setSurveys)
          .catch(function (e) {
            setErr(e.message);
            setSurveys([]);
          });
      }
      if (tab === "inq" && inquiries === null) {
        loadInquiries()
          .then(setInquiries)
          .catch(function (e) {
            setErr(e.message);
            setInquiries([]);
          });
      }
    },
    [tab, surveys, inquiries]
  );

  function ensureChildren(force) {
    if (loadingChildren) return;
    if (children !== null && !force) return;
    setLoadingChildren(true);
    setChildErr("");
    loadChildren()
      .then(function (list) {
        setChildren(list);
        setLoadingChildren(false);
        loadArchivedIds().then(function (ids) {
          setArchivedIds(ids || []);
        });
      })
      .catch(function (e) {
        setChildErr(e.message);
        setLoadingChildren(false);
      });
  }

  function linkUrl(token) {
    return window.location.origin + window.location.pathname + "?t=" + token;
  }
  function publicFormUrl() {
    // ★ 카톡 미리보기에 '상담 신청서'로 뜨도록 전용 주소(inquiry/)로 보낸다. 열면 ?form=inquiry 로 넘어간다.
    return window.location.origin + window.location.pathname.replace(/[^/]*$/, "") + "inquiry/";
  }

  function copy(text, tag) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          setCopied(tag);
        },
        function () {
          setCopied("");
        }
      );
    }
  }

  const staffName = useMemo(
    function () {
      const m = {};
      staff.forEach(function (s) {
        m[s.id] = s.name || s.email;
      });
      return m;
    },
    [staff]
  );

  /* 설문 두 개 = 탭 두 개. 원장·선생님 화면이 같은 이름을 쓴다.
     원장(관리자)에게는 맨 앞에 [설문 현황]이 붙는다. */
  const tabs = (admin ? [["board", "설문 현황"]] : []).concat([
    ["inq", "상담 신청서"],
    ["rein", "강화제 설문"],
  ]);

  /* 현황판 [답변 보기] — 해당 탭으로 옮기고 그 설문을 바로 연다 */
  function openFromBoard(kind, id) {
    setFocus({ kind: kind, id: id });
    if (kind === "inq") setInquiries(null);   // 새로 들어온 것까지 보이게 다시 불러온다
    else setSurveys(null);
    setTab(kind);
  }

  return (
    <div className="wrap">
      <header className="hero hero-staff">
        <img className="hero-logo" src={CENTER_LOGO} alt="검단ABA언어행동연구소" />
        <h1 className="hero-title">설문 관리</h1>
        <button
          className="ghost"
          onClick={function () {
            saveSession(null);
            window.location.reload();
          }}
        >
          로그아웃
        </button>
      </header>

      {tabs.length > 1 ? (
        <nav className="tabs">
          {tabs.map(function (t) {
            return (
              <button
                key={t[0]}
                className={"tab" + (tab === t[0] ? " tab-on" : "")}
                onClick={function () {
                  setTab(t[0]);
                }}
              >
                {t[1]}
              </button>
            );
          })}
        </nav>
      ) : null}

      {err ? <p className="q-errmsg">{err}</p> : null}
      {syncNote ? <p className="pool-hint">{syncNote}</p> : null}

      {tab === "board" && admin ? (
        <BoardTab
          staffName={staffName}
          linkUrl={linkUrl}
          publicUrl={publicFormUrl()}
          copy={copy}
          copied={copied}
          onOpen={openFromBoard}
        />
      ) : null}

      {tab === "inq" ? (
        <InquiryTab
          admin={admin}
          inquiries={inquiries}
          setInquiries={setInquiries}
          staff={staff}
          staffErr={staffErr}
          staffBusy={staffBusy}
          refetchStaff={fetchStaff}
          staffName={staffName}
          childList={children}
          archivedIds={archivedIds}
          ensureChildren={ensureChildren}
          childErr={childErr}
          loadingChildren={loadingChildren}
          linkUrl={linkUrl}
          publicUrl={publicFormUrl()}
          copy={copy}
          copied={copied}
          onLinkMade={function () {}}
          focusId={focus && focus.kind === "inq" ? focus.id : null}
          onFocused={function () {
            setFocus(null);
          }}
        />
      ) : null}

      {tab === "rein" ? (
        <div>
          {admin ? (
            showMake ? (
              <div className="make-panel">
                <div className="make-head">
                  <p className="pub-label inline">아동에게 강화제 설문 링크 보내기</p>
                  <button
                    className="ghost"
                    onClick={function () {
                      setShowMake(false);
                    }}
                  >
                    닫기
                  </button>
                </div>
                <p className="pool-hint">
                  이미 다니고 있는 아동이나 재평가가 필요한 아동에게 씁니다. 새로 등록하는
                  아동은 [상담 신청서]에서 등록할 때 링크가 함께 만들어집니다.
                </p>
                <MakeTab
                  childList={children}
                  ensureChildren={ensureChildren}
                  childErr={childErr}
                  loadingChildren={loadingChildren}
                  staff={staff}
                  staffErr={staffErr}
                  staffBusy={staffBusy}
                  refetchStaff={fetchStaff}
                  linkUrl={linkUrl}
                  copy={copy}
                  copied={copied}
                  onMade={function () {}}
                />
              </div>
            ) : (
              <button
                className="submit sm open-make"
                onClick={function () {
                  setShowMake(true);
                }}
              >
                + 아동에게 링크 보내기
              </button>
            )
          ) : null}

          <p className="pub-label list-label">받은 응답</p>
          <SurveyTab
            surveys={surveys}
            setSurveys={setSurveys}
            childList={children}
            archivedIds={archivedIds}
            ensureChildren={ensureChildren}
            admin={admin}
            staff={staff}
            staffName={staffName}
            onAssigned={function () {
              setSurveys(null);
            }}
            focusId={focus && focus.kind === "rein" ? focus.id : null}
            onFocused={function () {
              setFocus(null);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/* ── 7-0. 설문 현황 (원장·실장 첫 화면) ──────────────────────────────
   보낸 것 / 들어온 것을 한 줄씩 보여 준다.
     새로 들어옴 : 학부모가 냈는데 아직 아무도 안 열어 봄
     기다리는 중 : 강화제 링크를 보냈는데 아직 답이 없음 (7일 넘으면 빨간색)
     확인 끝남   : 열어 본 것 (최근 30일)
   상담 신청서는 모두 같은 링크를 쓰므로 '기다리는 중'이 없다. */

const BOARD_STATE = {
  new: { label: "새로 들어옴", cls: "badge-fresh" },
  wait: { label: "기다리는 중", cls: "badge-wait" },
  old: { label: "7일 넘음", cls: "badge-old" },
  done: { label: "확인 끝남", cls: "badge-off" },
};

function boardWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const hm = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "오늘 " + hm;
  if (d.toDateString() === yest.toDateString()) return "어제 " + hm;
  return (d.getMonth() + 1) + "/" + d.getDate();
}

function BoardTab(props) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("all");
  const [busyId, setBusyId] = useState("");

  function load() {
    setErr("");
    loadBoard()
      .then(function (d) {
        setData(d || { rows: [] });
      })
      .catch(function (e) {
        setErr((e && e.message) || "현황을 불러오지 못했습니다.");
        setData({ rows: [] });
      });
  }

  useEffect(function () {
    load();
    // 켜 둔 채로 있어도 1분마다 새로 들어온 것을 반영한다
    const t = setInterval(function () {
      if (document.visibilityState === "visible") load();
    }, 60000);
    return function () {
      clearInterval(t);
    };
  }, []);

  const rows = (data && data.rows) || [];
  const count = { new: 0, wait: 0, old: 0, done: 0 };
  rows.forEach(function (r) {
    if (count[r.state] !== undefined) count[r.state]++;
  });
  const shown = rows.filter(function (r) {
    return filter === "all" || r.kind === filter;
  });

  function view(r) {
    setBusyId(r.id);
    const p = r.state === "new" ? markChecked(r.kind, r.id) : Promise.resolve(true);
    p.then(function () {
      setBusyId("");
      props.onOpen(r.kind, r.id);
    });
  }

  return (
    <div>
      <div className="pub board-top">
        <p className="pub-label inline">상담 신청서 보낼 때</p>
        <button
          className="submit sm"
          onClick={function () {
            props.copy(inquiryMessage(props.publicUrl), "board-pub");
          }}
        >
          {props.copied === "board-pub" ? "복사했습니다" : "문구와 주소 복사"}
        </button>
      </div>

      {data && data.mail_error ? (
        <div className="mail-err">
          <b>알림 메일이 안 나가고 있습니다.</b>
          <span>
            네이버 메일 → 환경설정 → POP3/IMAP 설정에서 "POP3/SMTP 사용"이 "사용함"인지 확인해 주세요.
            {data.mail_error_at ? " (" + boardWhen(data.mail_error_at) + ")" : ""}
          </span>
          <em>{data.mail_error}</em>
        </div>
      ) : null}

      {err ? <p className="q-errmsg">{err}</p> : null}

      <div className="board-metrics">
        <div className="metric">
          <span>새로 들어옴</span>
          <b className="m-fresh">{count.new}</b>
        </div>
        <div className="metric">
          <span>기다리는 중</span>
          <b>{count.wait}</b>
        </div>
        <div className="metric">
          <span>7일 넘게 안 옴</span>
          <b className="m-old">{count.old}</b>
        </div>
        <div className="metric">
          <span>확인 끝남</span>
          <b className="m-done">{count.done}</b>
        </div>
      </div>

      <div className="chips filter board-filter">
        {[
          ["all", "전체"],
          ["rein", "강화제 설문"],
          ["inq", "상담 신청서"],
        ].map(function (f) {
          return (
            <button
              key={f[0]}
              className={"chip" + (filter === f[0] ? " chip-on" : "")}
              onClick={function () {
                setFilter(f[0]);
              }}
            >
              {f[1]}
            </button>
          );
        })}
        <button className="ghost board-reload" onClick={load}>
          새로고침
        </button>
      </div>

      {data === null ? (
        <p className="notice">불러오는 중입니다…</p>
      ) : shown.length === 0 ? (
        <p className="notice">표시할 설문이 없습니다.</p>
      ) : (
        <ul className="rows">
          {shown.map(function (r) {
            const st = BOARD_STATE[r.state] || BOARD_STATE.done;
            const kindLabel = r.kind === "rein" ? "강화제 설문" : "상담 신청서";
            const who = r.kind === "rein"
              ? r.assigned_to
                ? " · 담당 " + (props.staffName[r.assigned_to] || "배정됨")
                : " · 미배정"
              : "";
            const waiting = r.state === "wait" || r.state === "old";
            const when = waiting
              ? boardWhen(r.at) + " 보냄 · " + (waitingDays(r.at) || 0) + "일째"
              : boardWhen(r.at) + " 도착";
            return (
              <li className={"row" + (r.state === "done" ? " row-dim" : "")} key={r.kind + r.id}>
                <span className="board-main">
                  <em className={"badge " + st.cls}>{st.label}</em>
                  <span>
                    <b>{r.child_name}</b>
                    <em className="row-sub">
                      {kindLabel}
                      {who} · {when}
                    </em>
                  </span>
                </span>
                {waiting ? (
                  <button
                    className="ghost"
                    onClick={function () {
                      props.copy(reinMessage(r.child_name, props.linkUrl(r.token)), "re-" + r.id);
                    }}
                  >
                    {props.copied === "re-" + r.id ? "복사했습니다" : "다시 보낼 문구"}
                  </button>
                ) : (
                  <button
                    className="submit sm"
                    disabled={busyId === r.id}
                    onClick={function () {
                      view(r);
                    }}
                  >
                    답변 보기
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ── 7-1. 문의 관리 ────────────────────────────────────────────── */

function InquiryTab(props) {
  const [filter, setFilter] = useState("전체");
  const [open, setOpen] = useState(null);

  useEffect(function () {
    if (props.admin) props.ensureChildren();
  }, []);

  // ★ 현황판에서 넘어왔으면 그 신청서를 바로 연다
  useEffect(
    function () {
      if (!props.focusId || !props.inquiries) return;
      const hit = props.inquiries.find(function (x) {
        return x.id === props.focusId;
      });
      if (hit) setOpen(hit);
      if (props.onFocused) props.onFocused();
    },
    [props.focusId, props.inquiries]
  );

  const list = props.inquiries;
  const shown = useMemo(
    function () {
      if (!list) return [];
      const base = filter === "전체"
        ? list
        : list.filter(function (x) {
            return x.status === filter;
          });
      // 대기 목록은 오래 기다린 순으로 — 자리가 나면 위에서부터 연락하시면 됩니다
      if (filter === "대기") {
        return base.slice().sort(function (a, b) {
          return String(a.created_at || "").localeCompare(String(b.created_at || ""));
        });
      }
      return base;
    },
    [list, filter]
  );

  function refreshRow(row) {
    props.setInquiries(function (prev) {
      if (!prev) return prev;
      return prev.map(function (x) {
        return x.id === row.id ? row : x;
      });
    });
    setOpen(row);
  }

  function removeRow(id) {
    props.setInquiries(function (prev) {
      if (!prev) return prev;
      return prev.filter(function (x) {
        return x.id !== id;
      });
    });
    setOpen(null);
  }

  return (
    <div>
      {props.admin ? (
      <div className="pub">
        <p className="pub-label">상담 전 사전 설문 주소</p>
        <p className="made-url msg-box">{inquiryMessage(props.publicUrl)}</p>
        <button
          className="submit sm"
          onClick={function () {
            props.copy(inquiryMessage(props.publicUrl), "pub");
          }}
        >
          {props.copied === "pub" ? "복사했습니다" : "문구와 주소 복사"}
        </button>
        <button
          className="linkish"
          onClick={function () {
            props.copy(props.publicUrl, "pub-url");
          }}
        >
          {props.copied === "pub-url" ? "주소만 복사했습니다" : "주소만 복사"}
        </button>
        <p className="made-hint">
          상담 일정을 잡으신 뒤 학부모께 문자로 보내 주세요. 주소는 하나로 고정이며
          만료되지 않습니다.
        </p>
      </div>
      ) : null}

      <div className="chips filter">
        {["전체"].concat(STATUSES).map(function (s) {
          return (
            <Chip
              key={s}
              on={filter === s}
              onClick={function () {
                setFilter(s);
              }}
            >
              {s}
            </Chip>
          );
        })}
      </div>

      {filter === "대기" && shown.length > 0 ? (
        <p className="wait-note">
          오래 기다린 순입니다. 자리가 나면 희망 요일·시간이 맞는 아동에게 연락하세요.
        </p>
      ) : null}

      {list === null ? (
        <p className="notice">불러오는 중입니다…</p>
      ) : shown.length === 0 ? (
        <p className="notice">
          {props.admin ? "해당하는 문의가 없습니다." : "배정된 상담 신청서가 없습니다."}
        </p>
      ) : (
        <ul className="rows">
          {shown.map(function (x) {
            return (
              <li className="row" key={x.id}>
                <span>
                  <b>{x.child_name || "(이름 없음)"}</b>
                  {x.status === "대기" ? (
                    <em className="row-sub wish">
                      {wishText(x.answers) || "희망 요일·시간 미기재"}
                      <span className="wait-days">{waitingText(x.created_at)} 대기</span>
                    </em>
                  ) : null}
                  <em className="row-sub">
                    {new Date(x.created_at).toLocaleDateString("ko-KR")} · {x.phone}
                    {x.child_id
                      ? props.childList && !props.childList.some(function (c) {
                          return c.id === x.child_id;
                        })
                        ? (props.archivedIds || []).indexOf(x.child_id) !== -1
                          ? " · 🗄️ 보관 아동"
                          : " · ⚠ 통합본에 없는 아동"
                        : " · 아동 연결됨"
                      : ""}
                  </em>
                </span>
                <span className="row-right">
                  <em className={"badge " + badgeClass(x.status)}>{x.status}</em>
                  <button
                    className="submit sm"
                    onClick={function () {
                      setOpen(x);
                      props.ensureChildren();
                      if (props.admin) markChecked("inq", x.id);
                    }}
                  >
                    보기
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {open ? (
        <InquirySheet
          key={open.id}
          admin={props.admin}
          row={open}
          onClose={function () {
            setOpen(null);
          }}
          onSaved={refreshRow}
          onDeleted={removeRow}
          staff={props.staff}
          staffErr={props.staffErr}
          staffBusy={props.staffBusy}
          refetchStaff={props.refetchStaff}
          childList={props.childList}
          archivedIds={props.archivedIds}
          childErr={props.childErr}
          loadingChildren={props.loadingChildren}
          ensureChildren={props.ensureChildren}
          linkUrl={props.linkUrl}
          copy={props.copy}
          copied={props.copied}
          onLinkMade={props.onLinkMade}
        />
      ) : null}
    </div>
  );
}

function InquirySheet(props) {
  const row = props.row;
  const [memo, setMemo] = useState(row.memo || "");
  const [status, setStatus] = useState(row.status);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  /* 자동 저장 — 타이핑을 멈추면 알아서 저장한다. 저장 버튼이 따로 없다. */
  const [saveState, setSaveState] = useState("");   // "" | saving | saved | error
  const saveTimer = useRef(null);
  const latest = useRef({ memo: row.memo || "", status: row.status });

  useEffect(function () {
    return function () {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function pushSave(next) {
    latest.current = Object.assign({}, latest.current, next || {});
    setSaveState("saving");
    patchInquiry(row.id, {
      memo: latest.current.memo,
      status: latest.current.status,
    })
      .then(function (updated) {
        setSaveState("saved");
        if (updated) props.onSaved(updated);
      })
      .catch(function (e) {
        setSaveState("error");
        setMsg(e.message);
      });
  }

  function onMemoChange(v) {
    setMemo(v);
    latest.current.memo = v;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(function () {
      pushSave({ memo: v });
    }, 800);
  }

  function onStatusPick(v) {
    setStatus(v);
    latest.current.status = v;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    pushSave({ status: v });
  }
  const [childQuery, setChildQuery] = useState("");
  const [pickedChild, setPickedChild] = useState(null);
  const [pickedStaff, setPickedStaff] = useState("");
  const [madeUrl, setMadeUrl] = useState("");
  const [madeName, setMadeName] = useState("");
  /* 등록 — 상담 신청서에 적힌 이름·생년월일을 그대로 쓰되 고칠 수 있게 둔다 */
  const [regName, setRegName] = useState(row.child_name || "");
  const [regBirth, setRegBirth] = useState(
    (row.answers && row.answers.birth && row.answers.birth.v) || ""
  );
  const [dupWarn, setDupWarn] = useState("");   // 같은 이름이 있을 때 한 번 더 확인
  const [useExisting, setUseExisting] = useState(false);

  const filtered = useMemo(
    function () {
      const list = props.childList || [];
      const q = childQuery.trim();
      if (!q) return list.slice(0, 30);
      return list.filter(function (c) {
        return c.name.indexOf(q) !== -1;
      });
    },
    [props.childList, childQuery]
  );

  /* 등록 버튼 — 통합본에 아동을 만들고, 문의를 잇고, 링크까지 한 번에 */
  function doRegister(force) {
    const nm = (regName || "").trim();
    if (!nm) {
      setMsg("아동 이름을 확인해 주세요.");
      return;
    }
    if (!pickedStaff) {
      setMsg("담당 선생님을 골라 주세요.");
      return;
    }
    const teacher = (props.staff || []).find(function (x) {
      return x.id === pickedStaff;
    });
    setBusy(true);
    setMsg("");
    registerChild(row.id, nm, regBirth, teacher ? teacher.name : "", pickedStaff, force)
      .then(function (res) {
        setMadeUrl(props.linkUrl(res.token));
        setMadeName(nm);
        if (props.ensureChildren) props.ensureChildren(true); // ★ 방금 통합본에 만든 아동이 명단에 바로 보이게 새로 불러옴
        setStatus("등록");
        setDupWarn("");
        setBusy(false);
        setMsg("등록했습니다. 통합본에 아동이 만들어졌습니다. 아래 링크를 학부모께 보내 주세요.");
        props.onSaved(
          Object.assign({}, row, {
            child_id: res.child_id,
            status: "등록",
            assigned_to: pickedStaff,
          })
        );
        props.onLinkMade();
      })
      .catch(function (e) {
        setBusy(false);
        const t = e && e.message ? e.message : "";
        if (t.indexOf("한 번 더") !== -1) {
          const m = t.match(/이미 (\d+) ?명/);
          setDupWarn(
            "통합본에 같은 이름의 아동이 " + (m ? m[1] : "여러") +
            "명 있습니다. 다른 아동이 맞으면 아래 버튼을 한 번 더 눌러 주세요."
          );
          setMsg("");
        } else {
          setMsg(t || "등록하지 못했습니다.");
        }
      });
  }

  /* 연결 해제 — 통합본에서 아동을 지운 뒤 문의를 다시 쓸 수 있게 */
  function doUnlink() {
    const ok = window.confirm(
      "이 문의의 아동 연결을 해제할까요?\n\n" +
      "· 상태가 '상담예정'으로 돌아갑니다\n" +
      "· 이 아동 앞으로 보낸 강화제 링크는 만료됩니다\n" +
      "· 통합본의 아동 기록은 건드리지 않습니다"
    );
    if (!ok) return;
    setBusy(true);
    setMsg("");
    unlinkInquiry(row.id, row.child_id)
      .then(function (updated) {
        setBusy(false);
        setStatus("상담예정");
        latest.current.status = "상담예정";
        setMadeUrl("");
        setPickedStaff("");
        setDupWarn("");
        setUseExisting(false);
        setMsg("연결을 해제했습니다. 필요하면 다시 등록하세요.");
        props.onSaved(
          updated ||
            Object.assign({}, row, { child_id: null, status: "상담예정", assigned_to: null })
        );
      })
      .catch(function (e) {
        setBusy(false);
        setMsg(e.message);
      });
  }

  /* 문의 삭제 */
  function doDelete() {
    const ok = window.confirm(
      (row.child_name || "이") + " 문의를 삭제할까요?\n\n" +
      "상담 신청서 답변과 상담 메모가 모두 지워지며 되돌릴 수 없습니다.\n" +
      "통합본의 아동 기록은 건드리지 않습니다."
    );
    if (!ok) return;
    setBusy(true);
    deleteInquiry(row.id)
      .then(function () {
        setBusy(false);
        props.onDeleted(row.id);
      })
      .catch(function (e) {
        setBusy(false);
        setMsg(e.message);
      });
  }

  /* 되돌리기용 — 이미 통합본에 있는 아동과 잇기 */
  function connectExisting() {
    if (!pickedChild) {
      setMsg("아동을 먼저 선택해 주세요.");
      return;
    }
    if (!pickedStaff) {
      setMsg("담당 선생님을 골라 주세요.");
      return;
    }
    setBusy(true);
    setMsg("");
    linkExistingChild(row.id, pickedChild.id, pickedChild.name, pickedStaff)
      .then(function (token) {
        setMadeUrl(props.linkUrl(token));
        setMadeName(pickedChild.name || "");
        if (props.ensureChildren) props.ensureChildren(true); // ★ 명단 새로 불러옴
        setStatus("등록");
        setBusy(false);
        setMsg("연결했습니다. 아래 링크를 학부모께 보내 주세요.");
        props.onSaved(
          Object.assign({}, row, {
            child_id: pickedChild.id,
            status: "등록",
            assigned_to: pickedStaff,
          })
        );
        props.onLinkMade();
      })
      .catch(function (e) {
        setBusy(false);
        setMsg(e.message);
      });
  }

  return (
    <div className="modal" onClick={props.onClose}>
      <div
        className="sheet sheet-wide"
        onClick={function (e) {
          e.stopPropagation();
        }}
      >
        <div className="sheet-head">
          <h2>
            {row.child_name} · 상담 신청
            <em>
              {new Date(row.created_at).toLocaleString("ko-KR")} · {row.phone}
            </em>
          </h2>
          <div className="sheet-btns">
            <button
              className="ghost"
              onClick={function () {
                window.print();
              }}
            >
              인쇄
            </button>
            <button className="ghost" onClick={props.onClose}>
              닫기
            </button>
          </div>
        </div>

        <div className="admin-box status-row">
          <span className="pub-label inline">진행 상태</span>
          <div className="chips">
            {STATUSES.map(function (s) {
              return (
                <Chip
                  key={s}
                  on={status === s}
                  onClick={function () {
                    if (props.admin) onStatusPick(s);
                  }}
                >
                  {s}
                </Chip>
              );
            })}
          </div>
          <span className={"savetag savetag-" + (props.admin ? (saveState || "idle") : "idle")}>
            {!props.admin
              ? "보기 전용"
              : saveState === "saving"
              ? "저장 중…"
              : saveState === "saved"
              ? "✓ 저장됨"
              : saveState === "error"
              ? "저장 실패"
              : "자동 저장"}
          </span>
        </div>

        <div className="split">
          <div className="split-main">
            <p className="pub-label">학부모가 보내온 답변</p>
            <Detail questions={INQ_Q} answers={row.answers} />
          </div>
          <aside className="split-side">
            <p className="pub-label">상담 메모</p>
            <textarea
              className="inp ta memo-pad"
              readOnly={!props.admin}
              placeholder={
                props.admin
                  ? "상담하면서 바로 적으세요. 타이핑을 멈추면 자동으로 저장됩니다."
                  : "원장님이 남긴 상담 메모가 여기 표시됩니다."
              }
              value={memo}
              onChange={function (e) {
                if (props.admin) onMemoChange(e.target.value);
              }}
            />
            <p className="pool-hint">
              {!props.admin
                ? "원장님이 작성하는 칸입니다."
                : saveState === "saving"
                ? "저장 중…"
                : saveState === "saved"
                ? "✓ 저장되었습니다"
                : saveState === "error"
                ? "저장하지 못했습니다. 인터넷 연결을 확인해 주세요."
                : "적으시면 자동으로 저장됩니다."}
            </p>
          </aside>
        </div>

        {props.admin ? (
        <div className="admin-box">
          <p className="pub-label">등록 확정</p>
          {row.child_id ? (
            <div>
              {props.childList &&
              !props.childList.some(function (c) {
                return c.id === row.child_id;
              }) &&
              (props.archivedIds || []).indexOf(row.child_id) !== -1 ? (
                <p className="pool-hint">
                  통합본에서 보관한 아동입니다. 통합본에서 ↺ 복구하면 그대로 다시
                  이어지니 [연결 해제]는 누르지 않으셔도 됩니다.
                </p>
              ) : props.childList &&
              !props.childList.some(function (c) {
                return c.id === row.child_id;
              }) ? (
                <p className="dup-warn">
                  이 문의에 연결된 아동이 통합본에 없습니다. 통합본에서 지우셨다면
                  아래 [연결 해제]를 누르세요. 다시 등록할 수 있는 상태로 돌아갑니다.
                </p>
              ) : (
                <p className="pool-hint">
                  이미 등록된 문의입니다. 새 강화제 링크가 필요하면 [링크 만들기] 탭에서
                  만드세요.
                </p>
              )}
              <div className="made-btns mt">
                <button className="ghost" onClick={doUnlink} disabled={busy}>
                  {busy ? "처리 중…" : "연결 해제"}
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p className="pool-hint">
                버튼 하나로 통합본에 아동이 만들어지고, 담당 선생님 배정과 강화제 설문
                링크까지 함께 처리됩니다. 수업 시작일·회기 시간·목표는 담당 선생님이
                통합본에서 채우시면 됩니다.
              </p>

              <div className="reg-row mt">
                <div className="reg-col">
                  <span className="reg-lab">아동 이름</span>
                  <input
                    className="inp"
                    value={regName}
                    onChange={function (e) {
                      setRegName(e.target.value);
                      setDupWarn("");
                    }}
                  />
                </div>
                <div className="reg-col">
                  <span className="reg-lab">생년월일</span>
                  <input
                    className="inp"
                    type="date"
                    value={regBirth}
                    onChange={function (e) {
                      setRegBirth(e.target.value);
                    }}
                  />
                </div>
              </div>

              <p className="pub-label mt">담당 선생님</p>
              {props.staff && props.staff.length > 0 ? (
                <div className="chips">
                  {props.staff.map(function (s) {
                    return (
                      <Chip
                        key={s.id}
                        on={pickedStaff === s.id}
                        onClick={function () {
                          setPickedStaff(pickedStaff === s.id ? "" : s.id);
                          setMsg("");
                        }}
                      >
                        {s.name}
                      </Chip>
                    );
                  })}
                </div>
              ) : (
                <div className="staff-empty">
                  <p className="pool-hint">
                    {props.staffBusy
                      ? "선생님 목록을 불러오는 중입니다…"
                      : "선생님 목록을 불러오지 못했습니다. 아래 버튼을 눌러 다시 시도해 주세요."}
                  </p>
                  {props.staffErr ? (
                    <p className="q-errmsg small">{props.staffErr}</p>
                  ) : null}
                  <button
                    className="submit sm mt"
                    onClick={props.refetchStaff}
                    disabled={props.staffBusy}
                  >
                    {props.staffBusy ? "불러오는 중…" : "선생님 목록 다시 불러오기"}
                  </button>
                </div>
              )}

              {dupWarn ? <p className="dup-warn">{dupWarn}</p> : null}

              {!useExisting ? (
                <div>
                  <button
                    className="submit sm mt"
                    onClick={function () {
                      doRegister(!!dupWarn);
                    }}
                    disabled={busy}
                  >
                    {busy
                      ? "처리 중…"
                      : dupWarn
                      ? "그래도 새 아동으로 등록하기"
                      : "등록하고 강화제 설문 링크 만들기"}
                  </button>
                  <button
                    className="linkish"
                    onClick={function () {
                      setUseExisting(true);
                      setDupWarn("");
                      setMsg("");
                      props.ensureChildren();
                    }}
                  >
                    이미 통합본에 있는 아동과 잇기
                  </button>
                </div>
              ) : (
                <div className="mt">
                  <p className="pool-hint">
                    이미 통합본에 있는 아동을 고르세요. 새 아동은 만들어지지 않습니다.
                  </p>
                  {props.childList === null ? (
                    <button
                      className="submit sm"
                      onClick={function () {
                        props.ensureChildren();
                      }}
                      disabled={props.loadingChildren}
                    >
                      {props.loadingChildren ? "불러오는 중…" : "아동 목록 불러오기"}
                    </button>
                  ) : (
                    <div>
                      <div className="reload-row">
                        <input
                          className="inp"
                          placeholder="아동 이름으로 찾기"
                          value={childQuery}
                          onChange={function (e) {
                            setChildQuery(e.target.value);
                          }}
                        />
                        <button
                          className="ghost"
                          onClick={function () {
                            props.ensureChildren(true);
                          }}
                          disabled={props.loadingChildren}
                        >
                          {props.loadingChildren ? "…" : "다시 불러오기"}
                        </button>
                      </div>
                      <div className="chips mt">
                        {filtered.map(function (c) {
                          return (
                            <Chip
                              key={c.id}
                              on={pickedChild && pickedChild.id === c.id}
                              onClick={function () {
                                setPickedChild(c);
                              }}
                            >
                              {c.name}
                              {c.owner ? " (" + c.owner + ")" : ""}
                            </Chip>
                          );
                        })}
                      </div>
                      <button
                        className="submit sm mt"
                        onClick={connectExisting}
                        disabled={busy}
                      >
                        {busy ? "처리 중…" : "이 아동과 잇고 링크 만들기"}
                      </button>
                    </div>
                  )}
                  <button
                    className="linkish"
                    onClick={function () {
                      setUseExisting(false);
                      setMsg("");
                    }}
                  >
                    ← 새 아동으로 등록하기
                  </button>
                  {props.childErr ? <p className="q-errmsg">{props.childErr}</p> : null}
                </div>
              )}
            </div>
          )}
          {madeUrl ? (
            <div>
              <p className="made-url msg-box">{reinMessage(madeName || regName, madeUrl)}</p>
              <button
                className="submit sm"
                onClick={function () {
                  props.copy(reinMessage(madeName || regName, madeUrl), "inq-link");
                }}
              >
                {props.copied === "inq-link" ? "복사했습니다" : "문구와 링크 복사"}
              </button>
              <button
                className="linkish"
                onClick={function () {
                  props.copy(madeUrl, "inq-link-url");
                }}
              >
                {props.copied === "inq-link-url" ? "링크만 복사했습니다" : "링크만 복사"}
              </button>
            </div>
          ) : null}
          {msg ? <p className="pool-hint">{msg}</p> : null}
          <button className="linkish danger" onClick={doDelete} disabled={busy}>
            이 문의 삭제
          </button>
        </div>
        ) : null}

      </div>
    </div>
  );
}

/* ── 7-2. 링크 만들기 ──────────────────────────────────────────── */

function MakeTab(props) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(null);
  const [pickedStaff, setPickedStaff] = useState("");
  const [made, setMade] = useState(null);
  const [err, setErr] = useState("");

  // ★ 링크 만들기를 열 때마다 통합본 아동 명단을 새로 불러옴 (방금 등록한 아동도 바로 보이게)
  useEffect(function () {
    props.ensureChildren(true);
  }, []);

  const filtered = useMemo(
    function () {
      const list = props.childList || [];
      const q = query.trim();
      if (!q) return list;
      return list.filter(function (c) {
        return c.name.indexOf(q) !== -1 || (c.owner || "").indexOf(q) !== -1;
      });
    },
    [props.childList, query]
  );

  function make() {
    if (!picked) {
      setErr("아동을 선택해 주세요.");
      return;
    }
    setErr("");
    createLink(picked, pickedStaff || null)
      .then(function (row) {
        setMade({ child: picked, url: props.linkUrl(row.token) });
        props.onMade();
      })
      .catch(function (e) {
        setErr(e.message);
      });
  }

  if (made) {
    return (
      <div className="made">
        <p className="made-name">{made.child.name} 아동</p>
        <p className="made-url msg-box">{reinMessage(made.child.name, made.url)}</p>
        <div className="made-btns">
          <button
            className="submit sm"
            onClick={function () {
              props.copy(reinMessage(made.child.name, made.url), "make");
            }}
          >
            {props.copied === "make" ? "복사했습니다" : "문구와 링크 복사"}
          </button>
          <button
            className="ghost"
            onClick={function () {
              props.copy(made.url, "make-url");
            }}
          >
            {props.copied === "make-url" ? "링크만 복사했습니다" : "링크만 복사"}
          </button>
          <button
            className="ghost"
            onClick={function () {
              setMade(null);
              setPicked(null);
            }}
          >
            다른 아동
          </button>
        </div>
        <p className="made-hint">이 링크를 학부모께 보내 주세요. 30일 뒤 만료됩니다.</p>
      </div>
    );
  }

  return (
    <div>
      {props.childList === null ? (
        <div className="q">
          <p className="sec-note">통합본에 등록된 아동 목록을 불러옵니다.</p>
          <button
            className="submit"
            onClick={props.ensureChildren}
            disabled={props.loadingChildren}
          >
            {props.loadingChildren ? "불러오는 중…" : "아동 목록 불러오기"}
          </button>
          {props.childErr ? <p className="q-errmsg">{props.childErr}</p> : null}
        </div>
      ) : (
        <div>
          <div className="reload-row">
            <input
              className="inp"
              placeholder="아동 이름 또는 담당 선생님으로 찾기"
              value={query}
              onChange={function (e) {
                setQuery(e.target.value);
              }}
            />
            <button
              className="ghost"
              onClick={function () {
                props.ensureChildren(true);
              }}
              disabled={props.loadingChildren}
            >
              {props.loadingChildren ? "…" : "다시 불러오기"}
            </button>
          </div>
          {props.childErr ? <p className="q-errmsg">{props.childErr}</p> : null}
          <ul className="rows">
            {filtered.map(function (c) {
              return (
                <li
                  className={"row row-tap" + (picked && picked.id === c.id ? " row-on" : "")}
                  key={c.id}
                  onClick={function () {
                    setPicked(c);
                  }}
                >
                  <span>
                    <b>{c.name}</b>
                    {c.owner ? <em className="row-sub">{c.owner} 선생님</em> : null}
                  </span>
                </li>
              );
            })}
            {filtered.length === 0 ? (
              <li className="row row-empty">
                {query.trim()
                  ? "찾는 아동이 없습니다."
                  : "아동 목록이 비어 있습니다. [다시 불러오기]를 눌러 보세요."}
              </li>
            ) : null}
          </ul>
          <p className="pub-label">담당 선생님 (응답을 볼 수 있는 계정)</p>
          {props.staff && props.staff.length > 0 ? (
            <div className="chips">
              {props.staff.map(function (s) {
                return (
                  <Chip
                    key={s.id}
                    on={pickedStaff === s.id}
                    onClick={function () {
                      setPickedStaff(pickedStaff === s.id ? "" : s.id);
                    }}
                  >
                    {s.name}
                  </Chip>
                );
              })}
            </div>
          ) : (
            <div className="staff-empty">
              <p className="pool-hint">
                {props.staffBusy
                  ? "선생님 목록을 불러오는 중입니다…"
                  : "선생님 목록을 불러오지 못했습니다."}
              </p>
              {props.staffErr ? <p className="q-errmsg small">{props.staffErr}</p> : null}
              <button
                className="submit sm mt"
                onClick={props.refetchStaff}
                disabled={props.staffBusy}
              >
                {props.staffBusy ? "불러오는 중…" : "선생님 목록 다시 불러오기"}
              </button>
            </div>
          )}
          {err ? <p className="q-errmsg">{err}</p> : null}
          <button className="submit" onClick={make}>
            링크 만들기
          </button>
        </div>
      )}
    </div>
  );
}

/* ── 7-3. 받은 응답 ────────────────────────────────────────────── */

function SurveyTab(props) {
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const list = props.surveys;

  // 통합본에서 지운 아동의 응답을 가려내려고 아동 목록을 함께 불러온다
  useEffect(function () {
    if (props.admin) props.ensureChildren();
  }, []);

  // ★ 현황판에서 넘어왔으면 그 응답을 바로 연다
  useEffect(
    function () {
      if (!props.focusId || !list) return;
      const hit = list.find(function (x) {
        return x.id === props.focusId;
      });
      if (hit) setOpen(hit);
      if (props.onFocused) props.onFocused();
    },
    [props.focusId, list]
  );

  // ★ 보관한 아동은 '없는 아동'이 아니다
  function isArchived(childId) {
    return (props.archivedIds || []).indexOf(childId) !== -1;
  }

  function isOrphan(childId) {
    if (!props.childList) return false;   // 목록을 못 불러왔으면 표시하지 않는다
    if (isArchived(childId)) return false;
    return !props.childList.some(function (c) {
      return c.id === childId;
    });
  }

  function removeOne(row) {
    const ok = window.confirm(
      row.child_name + " 아동의 강화제 응답을 삭제할까요?\n\n" +
      "학부모가 보낸 답변이 지워지며 되돌릴 수 없습니다.\n" +
      "통합본의 아동 기록은 건드리지 않습니다."
    );
    if (!ok) return;
    setBusy(true);
    setErr("");
    deleteSurvey(row.id)
      .then(function () {
        setBusy(false);
        setOpen(null);
        props.setSurveys(function (prev) {
          if (!prev) return prev;
          return prev.filter(function (x) {
            return x.id !== row.id;
          });
        });
      })
      .catch(function (e) {
        setBusy(false);
        setErr(e.message);
      });
  }

  function assign(id, userId) {
    setBusy(true);
    assignSurvey(id, userId)
      .then(function () {
        setBusy(false);
        setOpen(null);
        props.onAssigned();
      })
      .catch(function () {
        setBusy(false);
      });
  }

  if (list === null) return <p className="notice">불러오는 중입니다…</p>;
  if (list.length === 0)
    return (
      <p className="notice">
        {props.admin ? "아직 받은 응답이 없습니다." : "배정된 응답이 없습니다."}
      </p>
    );

  return (
    <div>
      <ul className="rows">
        {list.map(function (s) {
          return (
            <li className="row" key={s.id}>
              <span>
                <b>{s.child_name}</b>
                <em className="row-sub">
                  {new Date(s.submitted_at).toLocaleString("ko-KR")}
                  {props.admin
                    ? s.assigned_to
                      ? " · " + (props.staffName[s.assigned_to] || "배정됨")
                      : " · 미배정"
                    : ""}
                  {props.admin && isOrphan(s.child_id) ? " · ⚠ 통합본에 없는 아동" : ""}
                  {props.admin && isArchived(s.child_id) ? " · 🗄️ 보관 아동" : ""}
                </em>
              </span>
              <button
                className="submit sm"
                onClick={function () {
                  setOpen(s);
                  if (props.admin) markChecked("rein", s.id);
                }}
              >
                보기
              </button>
            </li>
          );
        })}
      </ul>

      {open ? (
        <div
          className="modal"
          onClick={function () {
            setOpen(null);
          }}
        >
          <div
            className="sheet"
            onClick={function (e) {
              e.stopPropagation();
            }}
          >
            <div className="sheet-head">
              <h2>
                {open.child_name} · 강화제 설문
                <em>{new Date(open.submitted_at).toLocaleString("ko-KR")}</em>
              </h2>
              <div className="sheet-btns">
                <button
                  className="ghost"
                  onClick={function () {
                    window.print();
                  }}
                >
                  인쇄
                </button>
                <button
                  className="ghost"
                  onClick={function () {
                    setOpen(null);
                  }}
                >
                  닫기
                </button>
              </div>
            </div>

            {props.admin ? (
              <div className="admin-box">
                <p className="pub-label">담당 선생님 배정</p>
                <div className="chips">
                  {props.staff.map(function (s) {
                    return (
                      <Chip
                        key={s.id}
                        on={open.assigned_to === s.id}
                        onClick={function () {
                          if (busy) return;
                          assign(open.id, open.assigned_to === s.id ? null : s.id);
                        }}
                      >
                        {s.name}
                      </Chip>
                    );
                  })}
                </div>
                <p className="pool-hint">
                  배정된 선생님만 이 응답을 볼 수 있습니다. 다시 누르면 배정이
                  풀립니다. 통합본에 담당 치료사가 있는 아동은 설문 앱을 열 때 그
                  선생님으로 다시 맞춰지므로, 담당을 바꾸려면 통합본에서 바꿔 주세요.
                </p>
              </div>
            ) : null}

            {props.admin && isArchived(open.child_id) ? (
              <p className="pool-hint">
                통합본에서 보관한 아동입니다. 응답은 그대로 두시면 되고, 통합본에서
                ↺ 복구하면 아동 카드에 다시 나타납니다.
              </p>
            ) : null}

            {props.admin && isOrphan(open.child_id) ? (
              <p className="dup-warn">
                이 응답의 아동이 통합본에 없습니다. 통합본에서 지우셨다면 아래
                [이 응답 삭제]로 정리하세요.
              </p>
            ) : null}

            <Detail questions={REIN_Q} answers={open.answers} />

            {props.admin ? (
              <div>
                {err ? <p className="q-errmsg">{err}</p> : null}
                <button
                  className="linkish danger"
                  onClick={function () {
                    removeOne(open);
                  }}
                  disabled={busy}
                >
                  이 응답 삭제
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Detail(props) {
  const answers = props.answers || {};
  // 예전 문항(legacy)은 답이 있을 때만 보인다
  const legacyShown = props.questions.some(function (q) {
    return q.legacy && q.id && answerText(q, answers[q.id]);
  });
  return (
    <dl className="detail">
      {props.questions.filter(function (q) {
        if (q.legacy) return q.id ? !!answerText(q, answers[q.id]) : legacyShown;
        return isVisible(q, answers);
      }).map(function (q, i) {
        if (q.sec)
          return (
            <h3 className="detail-sec" key={"ds" + i}>
              {q.sec}
            </h3>
          );
        const txt = answerText(q, answers[q.id]);
        return (
          <div className="detail-row" key={q.id}>
            <dt>
              {q.n}. {q.label}
            </dt>
            <dd>{txt || "—"}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/* ══════════════════════════════════════════════════════════════════
   8. 진입점
   ══════════════════════════════════════════════════════════════════ */

/* ★ 시간표 앱 [설문 현황 열기]로 넘겨받는 로그인
   시간표 앱이 이 창을 열면서 1시간짜리 출입증을 넣어 둔다. 있으면 로그인 화면 없이 들어간다.
   출입증이 끝나면(약 1시간) 평소처럼 로그인 화면이 나온다. 시간표 앱 로그인에는 영향이 없다. */
const SCHED_USED_KEY = "rein-handoff-used";   // 넘겨받은 출입증으로 들어간 적이 있음 (문제 찾기용)
let schedNoteText = "";
function schedNote() {
  if (schedNoteText) return schedNoteText;
  try {
    if (sessionStorage.getItem(SCHED_USED_KEY)) {
      return "시간표에서 넘겨받기: 출입증이 만료되었거나 받아들여지지 않았습니다. 시간표 앱에서 다시 눌러 주세요.";
    }
  } catch (e) {}
  return "";
}
function takeSchedHandoff() {
  let opened = false;
  try {
    opened = !!window.opener;
  } catch (e) {}
  try {
    const raw = sessionStorage.getItem("rein-handoff");
    if (!raw) {
      if (opened && !getSession()) schedNoteText = "시간표에서 넘겨받기: 창은 열렸지만 출입증이 오지 않았습니다.";
      return;
    }
    sessionStorage.removeItem("rein-handoff");
    const h = JSON.parse(raw);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!h || !h.access_token || !h.expires_at || h.expires_at <= nowSec + 60) {
      schedNoteText = "시간표에서 넘겨받기: 받은 출입증이 이미 만료되었습니다.";
      return;
    }
    saveSession({
      access_token: h.access_token,
      expires_at: h.expires_at,
      token_type: "bearer",
      user: { id: h.user_id || "" },
    });
    sessionStorage.setItem(SCHED_USED_KEY, "1");
  } catch (e) {
    schedNoteText = "시간표에서 넘겨받기: 오류 (" + ((e && e.message) || e) + ")";
  }
}

export default function App() {
  const route = useMemo(function () {
    try {
      const p = new URLSearchParams(window.location.search);
      const t = p.get("t");
      if (t) return { kind: "rein", token: t };
      if (p.get("form") === "inquiry") {
        try { document.title = "상담 신청서 · 검단ABA언어행동연구소"; } catch (e) {}
        return { kind: "inquiry" };
      }
      return { kind: "staff" };
    } catch (e) {
      return { kind: "staff" };
    }
  }, []);

  const [loggedIn, setLoggedIn] = useState(function () {
    takeSchedHandoff();
    return !!getSession();
  });
  const [admin, setAdmin] = useState(null);

  useEffect(
    function () {
      if (route.kind !== "staff" || !loggedIn) return;
      let alive = true;
      checkAdmin().then(function (ok) {
        if (alive) setAdmin(ok);
      });
      return function () {
        alive = false;
      };
    },
    [route.kind, loggedIn]
  );

  let body;
  if (route.kind === "rein") body = <ReinSurvey token={route.token} />;
  else if (route.kind === "inquiry") body = <InquiryForm />;
  else if (!loggedIn)
    body = (
      <LoginBox
        onDone={function () {
          setLoggedIn(true);
        }}
      />
    );
  else if (admin === null)
    body = (
      <div className="wrap">
        <p className="notice">불러오는 중입니다…</p>
      </div>
    );
  else body = <StaffConsole admin={admin} />;

  return (
    <div className="app">
      <style>{CSS}</style>
      {body}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   9. 스타일
   ══════════════════════════════════════════════════════════════════ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Gowun+Dodum&family=Jua&display=swap');

.app { --pk: ${PK}; --pkd: ${PKD}; --pkl: ${PKL};
  --ink: #3D343A; --muted: #948A90; --line: #F0DCE2; --paper: #FFFFFF;
  font-family: 'Gowun Dodum', -apple-system, BlinkMacSystemFont, sans-serif;
  color: var(--ink); background: #FFFBFC; min-height: 100vh;
  -webkit-text-size-adjust: 100%;
}
.app * { box-sizing: border-box; }
.wrap { max-width: 600px; margin: 0 auto; padding: 20px 18px 72px; }

.hero { padding: 24px 0 20px; border-bottom: 2px solid var(--pkl); margin-bottom: 8px; }
.hero-kicker { margin: 0 0 10px; font-size: 13px; color: var(--pkd); letter-spacing: .04em; }
.hero-title { font-family: 'Jua', sans-serif; font-weight: 400; font-size: 26px;
  line-height: 1.45; margin: 0 0 12px; }
.hero-name { color: var(--pkd); }
.hero-body { margin: 0; font-size: 15px; line-height: 1.75; color: var(--muted); }
.hero-warn { margin: 12px 0 0; padding: 10px 12px; background: var(--pkl);
  border-radius: 10px; font-size: 14px; line-height: 1.6; color: var(--pkd); }
.hero-staff { position: relative; }
.hero-staff .ghost { position: absolute; top: 24px; right: 0; }

.sec { margin: 34px 0 4px; }
.sec-title { font-family: 'Jua', sans-serif; font-weight: 400; font-size: 19px;
  margin: 0; color: var(--pkd); }
.sec-note { margin: 6px 0 0; font-size: 14px; line-height: 1.65; color: var(--muted); }

.q { background: var(--paper); border: 1px solid var(--line); border-radius: 14px;
  padding: 16px 15px; margin-top: 12px; }
.q-err { border-color: var(--pk); box-shadow: 0 0 0 3px var(--pkl); }
.q-head { display: flex; gap: 9px; align-items: baseline; margin-bottom: 12px; }
.q-n { flex: none; min-width: 24px; height: 24px; border-radius: 8px; background: var(--pkl);
  color: var(--pkd); font-size: 13px; display: inline-flex; align-items: center;
  justify-content: center; padding: 0 6px; }
.q-label { font-size: 16px; line-height: 1.55; }
.q-req { font-style: normal; font-size: 12px; color: var(--pkd); margin-left: 6px;
  background: var(--pkl); border-radius: 6px; padding: 2px 6px; white-space: nowrap; }
.q-note { margin: -4px 0 10px 33px; font-size: 13px; color: var(--muted); }
.q-errmsg { margin: 10px 0 0; font-size: 14px; color: var(--pkd); }

.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chips.mt, .mt { margin-top: 10px; }
.filter { margin: 16px 0 4px; }
.chip { font: inherit; font-size: 15px; padding: 9px 14px; border-radius: 999px;
  border: 1px solid var(--line); background: #fff; color: var(--ink);
  cursor: pointer; transition: background .12s, border-color .12s, color .12s; }
.chip:hover { border-color: var(--pk); }
.chip:focus-visible { outline: 2px solid var(--pkd); outline-offset: 2px; }
.chip-on { background: var(--pk); border-color: var(--pk); color: #fff; }

.inp { display: block; width: 100%; font: inherit; font-size: 16px; margin-top: 10px;
  padding: 11px 13px; border: 1px solid var(--line); border-radius: 10px;
  background: #fff; color: var(--ink); }
.inp:focus { outline: none; border-color: var(--pk); box-shadow: 0 0 0 3px var(--pkl); }
.ta { resize: vertical; line-height: 1.7; }
.dpick { display: flex; gap: 8px; }
.reload-row { display: flex; gap: 8px; align-items: flex-end; }
.reload-row .inp { flex: 1; min-width: 0; }
.reload-row .ghost { flex: none; white-space: nowrap; margin-bottom: 1px; }
.sel { flex: 1; min-width: 0; appearance: none; -webkit-appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, var(--pkd) 50%),
    linear-gradient(135deg, var(--pkd) 50%, transparent 50%);
  background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
  padding-right: 30px; }

.ranks { display: flex; flex-direction: column; gap: 2px; }
.rank-row { display: flex; align-items: center; gap: 10px; }
.rank-no { flex: none; width: 34px; font-size: 14px; color: var(--pkd); }
.rank-inp { margin-top: 8px; }
.pool { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--line); }
.pool-hint { margin: 10px 0 0; font-size: 13px; line-height: 1.6; color: var(--muted); }
.pool-empty { margin: 0; font-size: 14px; color: var(--muted); }

.submit { display: block; width: 100%; margin-top: 26px; font: inherit; font-size: 17px;
  font-family: 'Jua', sans-serif; padding: 15px; border: none; border-radius: 12px;
  background: var(--pkd); color: #fff; cursor: pointer; }
.submit:disabled { opacity: .55; cursor: default; }
.submit.sm { width: auto; margin: 0; font-size: 14px; padding: 8px 14px; border-radius: 9px; }
.submit.sm.mt { margin-top: 12px; }
.ghost { font: inherit; font-size: 14px; padding: 8px 12px; border-radius: 9px;
  border: 1px solid var(--line); background: #fff; color: var(--muted); cursor: pointer; }
.send-err { margin: 20px 0 0; padding: 12px 14px; background: var(--pkl);
  border-radius: 10px; font-size: 15px; color: var(--pkd); }
.foot { margin: 18px 0 0; font-size: 13px; line-height: 1.7; color: var(--muted); text-align: center; }
.notice { padding: 30px 0; text-align: center; color: var(--muted); }

.card-msg { margin-top: 60px; background: var(--paper); border: 1px solid var(--line);
  border-radius: 16px; padding: 30px 24px; text-align: center; }
.card-msg h2 { font-family: 'Jua', sans-serif; font-weight: 400; font-size: 21px;
  margin: 0 0 12px; color: var(--pkd); }
.card-msg p { margin: 0; font-size: 15px; line-height: 1.8; color: var(--muted); }

.tabs { display: flex; gap: 6px; margin: 18px 0 6px; }
.tab { flex: 1; font: inherit; font-size: 14px; padding: 11px 6px; border-radius: 10px;
  border: 1px solid var(--line); background: #fff; color: var(--muted); cursor: pointer; }
.tab-on { background: var(--pkl); border-color: var(--pk); color: var(--pkd); }

.rows { list-style: none; margin: 12px 0 0; padding: 0; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  background: var(--paper); border: 1px solid var(--line); border-radius: 12px;
  padding: 13px 15px; margin-bottom: 8px; font-size: 15px; }
.row-tap { cursor: pointer; }
.row-on { border-color: var(--pk); background: var(--pkl); }
.row-sub { display: block; font-style: normal; font-size: 13px; color: var(--muted); margin-top: 3px; }
.row-empty { justify-content: center; color: var(--muted); }
.row-sub.wish { color: #9A6410; font-weight: 600; margin-top: 4px; }
.wait-days { margin-left: 8px; padding: 1px 7px; border-radius: 7px;
  background: #FFF1DC; color: #9A6410; font-size: 11px; font-weight: 600; }
.wait-note { margin: 10px 0 0; padding: 9px 12px; background: #FFF8EE;
  border: 1px solid #F0DCB8; border-radius: 8px; font-size: 12px;
  line-height: 1.6; color: #8A6410; }

.row-right { display: flex; align-items: center; gap: 8px; flex: none; }
.badge { font-style: normal; font-size: 12px; padding: 3px 8px; border-radius: 7px;
  background: var(--pkl); color: var(--pkd); white-space: nowrap; }
.badge-new { background: var(--pkd); color: #fff; }
.badge-off { background: #EFEDEE; color: var(--muted); }
.badge-wait { background: #FFF1DC; color: #9A6410; }
.badge-fresh { background: #EAF3DE; color: #3B6D11; }
.badge-old { background: #FCEBEB; color: #A32D2D; }

.board-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.mail-err { margin-top: 14px; padding: 12px 14px; background: #FCEBEB; border: 1px solid #F09595;
  border-radius: 10px; font-size: 14px; line-height: 1.6; color: #791F1F; }
.mail-err b { display: block; }
.mail-err em { display: block; font-style: normal; font-size: 12px; color: #A32D2D; margin-top: 4px; word-break: break-all; }
.board-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 16px; }
.metric { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
.metric span { display: block; font-size: 12px; color: var(--muted); }
.metric b { display: block; font-size: 22px; margin-top: 2px; }
.metric .m-fresh { color: #3B6D11; }
.metric .m-old { color: #A32D2D; }
.metric .m-done { color: var(--muted); }
.board-filter { align-items: center; }
.board-reload { margin-left: auto; }
.board-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.board-main .badge { flex: none; }
.row-dim { background: #FCFBFB; }
@media (max-width: 520px) {
  .board-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

.pub { background: var(--paper); border: 1px solid var(--pk); border-radius: 14px;
  padding: 16px 15px; margin-top: 16px; }
.pub-label { margin: 0 0 8px; font-size: 13px; color: var(--pkd); }
.pub-label.mt { margin-top: 14px; }

.made { background: var(--paper); border: 1px solid var(--pk); border-radius: 14px;
  padding: 20px 18px; margin-top: 16px; }
.made-name { margin: 0 0 10px; font-family: 'Jua', sans-serif; font-size: 18px; color: var(--pkd); }
.made-url { margin: 10px 0 12px; padding: 11px 13px; background: var(--pkl); border-radius: 10px;
  font-size: 13px; line-height: 1.6; word-break: break-all; color: var(--ink); }
.hero-logo { display: block; width: 168px; max-width: 60%; height: auto; margin: 0 0 18px; }
.made-btns { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.made-url.msg-box { white-space: pre-wrap; word-break: keep-all; overflow-wrap: anywhere; }
.made-hint { margin: 12px 0 0; font-size: 13px; line-height: 1.6; color: var(--muted); }

.status-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pub-label.inline { margin: 0; white-space: nowrap; }
.savetag { margin-left: auto; font-size: 11px; padding: 3px 9px; border-radius: 8px;
  background: #F2F2F0; color: #8A857D; white-space: nowrap; }
.savetag-saving { background: var(--pkl); color: var(--pkd); }
.savetag-saved { background: #EAF3DE; color: #4A7316; }
.savetag-error { background: #FDECEC; color: #A83232; }

.reg-row { display: flex; gap: 10px; }
.open-make { margin-top: 14px; }
.make-panel { margin-top: 14px; padding: 14px; background: #FFF9FA;
  border: 1px solid var(--line); border-radius: 12px; }
.make-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.list-label { margin-top: 20px; }
.staff-empty { padding: 10px 12px; background: #FFF6E6; border: 1px solid #E8B866;
  border-radius: 8px; margin-top: 4px; }
.q-errmsg.small { font-size: 12px; margin-top: 6px; }
.reg-col { flex: 1; min-width: 0; }
.reg-lab { font-size: 11px; color: var(--muted); }
.reg-col .inp { margin-top: 4px; }
.dup-warn { margin: 10px 0 0; padding: 9px 11px; background: #FFF6E6;
  border: 1px solid #E8B866; border-radius: 8px; font-size: 12px;
  line-height: 1.6; color: #8A5A10; }
.linkish { display: block; margin-top: 10px; padding: 0; border: none;
  background: none; color: var(--muted); font: inherit; font-size: 12px;
  text-decoration: underline; cursor: pointer; }
.linkish.danger { margin-top: 18px; color: #B04A4A; }

.split { display: flex; gap: 14px; align-items: flex-start; margin-top: 12px; }
.split-main { flex: 1 1 0; min-width: 0; }
.split-side { flex: 0 0 320px; position: sticky; top: 4px; }
.memo-pad { min-height: 340px; line-height: 1.8; }
@media (max-width: 820px) {
  .split { flex-direction: column; }
  .split-side { position: static; flex: 1 1 auto; width: 100%; }
  .memo-pad { min-height: 200px; }
}

.admin-box { background: #FFF9FA; border: 1px solid var(--line); border-radius: 12px;
  padding: 14px 14px; margin: 14px 0; }

.modal { position: fixed; inset: 0; background: rgba(61,52,58,.4);
  display: flex; align-items: flex-end; justify-content: center; z-index: 50; }
.sheet { width: 100%; max-width: 620px; max-height: 92vh; overflow-y: auto;
  background: #fff; border-radius: 18px 18px 0 0; padding: 20px 18px 40px; }
.sheet-wide { max-width: 1040px; }
.sheet-head { display: flex; justify-content: space-between; align-items: flex-start;
  gap: 12px; border-bottom: 2px solid var(--pkl); padding-bottom: 14px; margin-bottom: 4px; }
.sheet-head h2 { font-family: 'Jua', sans-serif; font-weight: 400; font-size: 18px; margin: 0; }
.sheet-head em { display: block; font-style: normal; font-size: 13px;
  color: var(--muted); margin-top: 5px; }
.sheet-btns { display: flex; gap: 6px; flex: none; }
.detail { margin: 0; }
.detail-sec { font-family: 'Jua', sans-serif; font-weight: 400; font-size: 16px;
  color: var(--pkd); margin: 22px 0 2px; }
.detail-row { padding: 11px 0; border-bottom: 1px solid var(--line); }
.detail-row dt { font-size: 14px; color: var(--muted); margin-bottom: 5px; }
.detail-row dd { margin: 0; font-size: 15px; line-height: 1.7; }

@media print {
  .app { background: #fff; }
  .hero, .tabs, .rows, .sheet-btns, .submit, .ghost, .admin-box, .pub, .filter,
  .savetag { display: none !important; }
  /* 인쇄는 종이 폭이 좁으니 2단을 위아래로 편다 — 답변 다음에 상담 메모 */
  .split { display: block !important; }
  .split-main, .split-side { width: 100% !important; position: static !important; }
  .split-side { margin-top: 10pt; break-inside: avoid; }
  .memo-pad { min-height: 0 !important; border: 1px solid var(--line) !important;
    background: #fff !important; height: auto !important; }
  .modal { position: static; background: none; display: block; }
  .sheet { max-height: none; overflow: visible; border-radius: 0; padding: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .app * { transition: none !important; }
}
`;
