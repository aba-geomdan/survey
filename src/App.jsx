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

const STATUSES = ["상담예정", "등록", "미등록"];
function badgeClass(s) {
  if (s === "상담예정") return "badge-new";
  if (s === "미등록") return "badge-off";
  return "";
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
  if (s.expires_at && s.expires_at > nowSec + 300 && s.access_token) {
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
  return data;
}

async function rpc(name, body, useStaff) {
  const headers = useStaff ? await staffHeaders() : anonHeaders();
  const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(body || {}),
  });
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

async function loadChildren() {
  const headers = await staffHeaders();
  const url =
    SUPABASE_URL +
    "/rest/v1/aba_data?user_id=eq." +
    ABA_OWNER_ID +
    "&key=eq." +
    encodeURIComponent(CHILDREN_KEY) +
    "&select=value";
  const r = await fetch(url, { headers: headers });
  if (!r.ok) throw new Error("아동 목록을 읽지 못했습니다 (HTTP " + r.status + ")");
  const rows = await r.json();
  if (!rows || rows.length === 0) return [];
  let list = rows[0].value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch (e) {
      throw new Error("아동 목록의 형식을 읽지 못했습니다.");
    }
  }
  if (!Array.isArray(list)) return [];
  return list
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

async function createLink(child, assignedTo) {
  const headers = await staffHeaders();
  const r = await fetch(SUPABASE_URL + "/rest/v1/rein_links", {
    method: "POST",
    headers: Object.assign({}, headers, { Prefer: "return=representation" }),
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
  const headers = await staffHeaders();
  const url =
    SUPABASE_URL +
    "/rest/v1/rein_surveys?select=id,child_id,child_name,answers,assigned_to,submitted_at" +
    "&order=submitted_at.desc&limit=300";
  const r = await fetch(url, { headers: headers });
  if (!r.ok) throw new Error("응답을 읽지 못했습니다 (HTTP " + r.status + ")");
  return await r.json();
}

async function assignSurvey(id, userId) {
  const headers = await staffHeaders();
  const r = await fetch(SUPABASE_URL + "/rest/v1/rein_surveys?id=eq." + id, {
    method: "PATCH",
    headers: Object.assign({}, headers, { Prefer: "return=minimal" }),
    body: JSON.stringify({ assigned_to: userId || null }),
  });
  if (!r.ok) throw new Error("배정하지 못했습니다 (HTTP " + r.status + ")");
}

async function loadLinks() {
  const headers = await staffHeaders();
  const url =
    SUPABASE_URL +
    "/rest/v1/rein_links?select=token,child_id,child_name,owner_name,assigned_to,created_at,expires_at" +
    "&order=created_at.desc&limit=200";
  const r = await fetch(url, { headers: headers });
  if (!r.ok) throw new Error("링크 목록을 읽지 못했습니다 (HTTP " + r.status + ")");
  return await r.json();
}

async function loadInquiries() {
  const headers = await staffHeaders();
  const url =
    SUPABASE_URL +
    "/rest/v1/inquiries?select=*&order=created_at.desc&limit=300";
  const r = await fetch(url, { headers: headers });
  if (!r.ok) throw new Error("문의를 읽지 못했습니다 (HTTP " + r.status + ")");
  return await r.json();
}

async function patchInquiry(id, changes) {
  const headers = await staffHeaders();
  const r = await fetch(SUPABASE_URL + "/rest/v1/inquiries?id=eq." + id, {
    method: "PATCH",
    headers: Object.assign({}, headers, { Prefer: "return=representation" }),
    body: JSON.stringify(changes),
  });
  if (!r.ok) throw new Error("저장하지 못했습니다 (HTTP " + r.status + ")");
  const rows = await r.json();
  return rows && rows[0];
}

/* ══════════════════════════════════════════════════════════════════
   2. 문항 정의
   ══════════════════════════════════════════════════════════════════ */

const REIN_Q = [
  { sec: "작성 정보" },
  { id: "relation", n: 1, label: "아동과의 관계", type: "single",
    options: ["어머니", "아버지", "조부모"], etc: true, required: true },

  { sec: "안전 확인", note: "수업에서 반드시 지켜야 할 내용입니다." },
  { id: "allergy", n: 2, label: "알레르기가 있거나 먹으면 안 되는 음식이 있습니까?",
    type: "yesno", detailLabel: "어떤 음식인지 적어주세요", required: true },
  { id: "choking", n: 3, label: "삼킴 위험이나 질감 때문에 피해야 할 것이 있습니까?",
    type: "yesno", detailLabel: "예: 견과류, 작은 부품", required: true },

  { sec: "좋아하는 것", note: "해당하는 것을 모두 눌러주세요. 없으면 넘어가셔도 됩니다." },
  { id: "food", n: 4, label: "음식·간식", type: "multi",
    options: ["과자류", "초콜릿류", "젤리·사탕", "빵·케이크", "과일", "아이스크림", "시리얼"],
    etc: true, detailLabel: "구체적인 제품명을 아시면 적어주세요" },
  { id: "drink", n: 5, label: "음료", type: "multi",
    options: ["물", "우유", "주스", "요구르트", "탄산음료"], etc: true },
  { id: "toy", n: 6, label: "장난감·책", type: "multi",
    options: ["자동차·기차", "블록·레고", "인형·피규어", "퍼즐", "공", "그림책", "소리 나는 장난감"],
    etc: true, detailLabel: "특별히 좋아하는 이름이 있으면 적어주세요" },
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
  { id: "place", n: 11, label: "장소", type: "multi",
    options: ["놀이터", "키즈카페", "마트", "공원", "차 안", "집 특정 공간"], etc: true },
  { id: "person", n: 12, label: "가장 좋아하는 사람", type: "multi",
    options: ["엄마", "아빠", "형제자매", "조부모", "또래 친구"], etc: true },

  { sec: "순위", note: "앞에서 고르신 것들이 아래에 뜹니다. 눌러서 채우거나 직접 적어주세요." },
  { id: "rank", n: 13, label: "가장 좋아하는 것을 순서대로 적어주세요", type: "rank", required: true },

  { sec: "집에서는 어떤가요" },
  { id: "always", n: 14, label: "집에서 아이가 언제든 가질 수 있는 것", type: "pick" },
  { id: "special", n: 15, label: "특별한 때만 주는 것", type: "pick" },

  { sec: "수업에서의 사용" },
  { id: "avoid", n: 16, label: "수업에서 사용하지 않았으면 하는 것이 있습니까?",
    type: "yesno", detailLabel: "무엇을, 어떤 이유인지 적어주세요", required: true },
  { id: "unlimited", n: 17, label: "수업에서 제한 없이 사용해도 되는 것", type: "pick" },

  { sec: "그 밖에" },
  { id: "dislike", n: 18, label: "아이가 정말 싫어하는 것", type: "multi",
    options: ["큰 소리", "특정 촉감", "낯선 사람", "기다리기", "정리하기", "옷 갈아입기"], etc: true },
  { id: "extra", n: 19, label: "더 알려주고 싶은 것이 있으면 자유롭게 적어주세요", type: "text" },
];

const INQ_Q = [
  { sec: "아동 정보" },
  { id: "childName", n: 1, label: "아동 이름", type: "line", required: true },
  { id: "birth", n: 2, label: "생년월일", type: "date", required: true },
  { id: "sex", n: 3, label: "성별", type: "single", options: ["남", "여"] },

  { sec: "보호자 연락처" },
  { id: "guardian", n: 4, label: "보호자 성함", type: "line", required: true },
  { id: "relation", n: 5, label: "아동과의 관계", type: "single",
    options: ["어머니", "아버지", "조부모"], etc: true },
  { id: "phone", n: 6, label: "연락처", type: "tel", required: true,
    placeholder: "010-0000-0000" },
  { id: "callTime", n: 7, label: "연락 가능한 시간대", type: "single",
    options: ["오전", "오후", "저녁", "아무 때나"] },

  { sec: "현재 상황" },
  { id: "school", n: 8, label: "교육기관", type: "single",
    options: ["미등원", "어린이집", "유치원", "초등학교", "중학교 이상"] },
  { id: "grade", n: 9, label: "학년·반", type: "line" },
  { id: "classType", n: 10, label: "통합·특수 여부", type: "single",
    options: ["일반학급", "통합학급", "특수학급", "특수학교", "해당 없음"] },
  { id: "speech", n: 11, label: "말로 표현하는 수준", type: "single", required: true,
    options: ["아직 말이 나오지 않음", "단어 하나", "두세 단어 조합", "문장으로 말함", "잘 모르겠음"] },
  { id: "behavior", n: 12, label: "걱정되는 행동이 있습니까?", type: "multi",
    options: ["자해", "공격", "반복적인 행동·말", "물건 던지기·부수기", "없음"], etc: true },
  { id: "toilet", n: 13, label: "배변", type: "single",
    options: ["기저귀", "어른이 시간 맞춰 데려감", "스스로 표현함", "스스로 처리함"] },

  { sec: "희망 사항" },
  { id: "program", n: 14, label: "관심 있는 프로그램", type: "multi", required: true,
    options: ["ABA 개별수업", "SCERTS 짝수업", "ABA 조기교실", "언어치료", "학교준비반", "아직 모르겠음"] },
  { id: "days", n: 15, label: "희망 요일", type: "multi",
    options: ["월", "화", "수", "목", "금", "토"] },
  { id: "times", n: 16, label: "희망 시간대", type: "multi",
    options: ["오전", "이른 오후", "늦은 오후", "저녁"] },
  { id: "start", n: 17, label: "언제부터 시작하고 싶으신가요?", type: "single",
    options: ["바로", "1개월 내", "2~3개월 내", "아직 미정"] },

  { sec: "참고" },
  { id: "report", n: 18, label: "검사 보고서를 가지고 계십니까?", type: "single",
    options: ["있음", "없음", "진행 중"], note: "있으시면 상담 때 가져와 주세요." },
  { id: "prior", n: 19, label: "다른 기관에서 치료받은 경험이 있습니까?", type: "yesno",
    detailLabel: "어떤 치료를 얼마 동안 받으셨는지 간단히 적어주세요" },
  { id: "source", n: 20, label: "저희 센터를 어떻게 알게 되셨나요?", type: "single", required: true,
    options: ["홈페이지", "인스타그램", "블로그", "지인 소개", "인쇄물·현수막", "검색"], etc: true },
  { id: "question", n: 21, label: "궁금하신 점이나 미리 알려주실 내용", type: "text" },
];

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
  return pool;
}

function answerText(q, val) {
  if (!val) return "";
  if (q.type === "single") {
    const parts = [];
    if (val.v) parts.push(val.v);
    if (val.etc) parts.push(val.etc);
    return parts.join(" · ");
  }
  if (q.type === "multi" || q.type === "pick") {
    const parts = (val.v || []).slice();
    if (val.etc) parts.push(val.etc);
    if (val.detail) parts.push("→ " + val.detail);
    return parts.join(", ");
  }
  if (q.type === "yesno") {
    if (val.v === "있음") return "있음 — " + (val.detail || "(내용 없음)");
    return val.v || "";
  }
  if (q.type === "rank") {
    return (val.v || [])
      .map(function (t, i) {
        return t ? i + 1 + "위 " + t : "";
      })
      .filter(Boolean)
      .join("  /  ");
  }
  return val.v || "";
}

function validateAnswers(qs, answers) {
  const e = {};
  fieldsOf(qs).forEach(function (q) {
    if (!q.required) return;
    const a = answers[q.id];
    if (!a) return;
    if (q.type === "single" && !a.v && !a.etc) e[q.id] = "선택해 주세요.";
    if (q.type === "multi" && (a.v || []).length === 0 && !(a.etc || "").trim())
      e[q.id] = "하나 이상 선택해 주세요.";
    if (q.type === "yesno") {
      if (!a.v) e[q.id] = "선택해 주세요.";
      else if (a.v === "있음" && !(a.detail || "").trim()) e[q.id] = "내용을 적어주세요.";
    }
    if (q.type === "rank") {
      const filled = (a.v || []).filter(function (t) {
        return (t || "").trim();
      });
      if (filled.length < 3) e[q.id] = "적어도 3개는 적어주세요.";
    }
    if (q.type === "date") {
      const p = (a.v || "").split("-");
      if (p.length !== 3 || !p[0] || !p[1] || !p[2]) e[q.id] = "연도·월·일을 모두 골라주세요.";
    }
    if (q.type === "line" || q.type === "tel" || q.type === "text") {
      if (!(a.v || "").trim()) e[q.id] = "적어주세요.";
    }
  });
  return e;
}

/* ══════════════════════════════════════════════════════════════════
   3. 공통 UI
   ══════════════════════════════════════════════════════════════════ */

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
    const next =
      cur.indexOf(opt) === -1
        ? cur.concat([opt])
        : cur.filter(function (x) {
            return x !== opt;
          });
    patch(id, { v: next });
  }

  return (
    <div>
      {props.questions.map(function (q, idx) {
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
          required: q.required,
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
  const form = useForm(REIN_Q);

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
        setSendError((err && err.message) || "저장하지 못했습니다. 잠시 후 다시 눌러주세요.");
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
        <p className="hero-kicker">검단ABA언어행동연구소</p>
        <h1 className="hero-title">
          <span className="hero-name">{childName}</span> 아동이
          <br />
          좋아하는 것을 알려주세요
        </h1>
        <p className="hero-body">
          아이가 좋아하는 것을 수업에서 활용하기 위한 자료입니다. 약 5분 걸립니다.
          정답은 없으니 편하게 답해 주세요.
        </p>
        {prevCount > 0 ? (
          <p className="hero-warn">
            이 링크로 이미 {prevCount}번 제출된 기록이 있습니다. 다시 제출하시면 새
            답변으로 추가됩니다.
          </p>
        ) : null}
      </header>

      <QuestionList
        questions={REIN_Q}
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
        적어주신 내용은 담당 선생님만 볼 수 있으며, 수업 준비에만 사용됩니다.
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
  const form = useForm(INQ_Q);

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
        setSendError((err && err.message) || "보내지 못했습니다. 잠시 후 다시 눌러주세요.");
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
        <p className="hero-kicker">검단ABA언어행동연구소</p>
        <h1 className="hero-title">상담 전 사전 설문</h1>
        <p className="hero-body">
          상담 예약이 완료되었습니다. 상담 전에 아이에 대해 미리 알아두면 좋을
          내용을 여쭙습니다. 약 3분 걸립니다. 미리 작성해 주시면 상담 시간을 더
          충실하게 쓸 수 있습니다.
        </p>
      </header>

      <QuestionList
        questions={INQ_Q}
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
        적어주신 내용은 상담 준비에만 사용되며, 담당자만 확인합니다.
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
        <p className="hero-kicker">검단ABA언어행동연구소</p>
        <h1 className="hero-title">설문 관리</h1>
      </header>
      <div className="q">
        <input
          className="inp"
          placeholder="이메일"
          value={email}
          autoComplete="username"
          onChange={function (e) {
            setEmail(e.target.value);
          }}
        />
        <input
          className="inp"
          type="password"
          placeholder="비밀번호"
          value={pw}
          autoComplete="current-password"
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
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   7. 선생님 화면
   ══════════════════════════════════════════════════════════════════ */

function StaffConsole(props) {
  const admin = props.admin;
  const [tab, setTab] = useState(admin ? "inq" : "surveys");

  const [staff, setStaff] = useState([]);
  const [children, setChildren] = useState(null);
  const [childErr, setChildErr] = useState("");
  const [loadingChildren, setLoadingChildren] = useState(false);

  const [surveys, setSurveys] = useState(null);
  const [links, setLinks] = useState(null);
  const [inquiries, setInquiries] = useState(null);

  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(
    function () {
      if (!admin) return;
      staffList()
        .then(setStaff)
        .catch(function () {
          setStaff([]);
        });
    },
    [admin]
  );

  useEffect(
    function () {
      if (tab === "surveys" && surveys === null) {
        loadSurveys()
          .then(setSurveys)
          .catch(function (e) {
            setErr(e.message);
            setSurveys([]);
          });
      }
      if (tab === "links" && links === null) {
        loadLinks()
          .then(setLinks)
          .catch(function () {
            setLinks([]);
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
    [tab, surveys, links, inquiries]
  );

  function ensureChildren() {
    if (children !== null || loadingChildren) return;
    setLoadingChildren(true);
    setChildErr("");
    loadChildren()
      .then(function (list) {
        setChildren(list);
        setLoadingChildren(false);
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
    return window.location.origin + window.location.pathname + "?form=inquiry";
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

  const tabs = admin
    ? [
        ["inq", "문의 관리"],
        ["make", "링크 만들기"],
        ["surveys", "받은 응답"],
        ["links", "보낸 링크"],
      ]
    : [["surveys", "받은 응답"]];

  return (
    <div className="wrap">
      <header className="hero hero-staff">
        <p className="hero-kicker">검단ABA언어행동연구소</p>
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

      {tab === "inq" ? (
        <InquiryTab
          inquiries={inquiries}
          setInquiries={setInquiries}
          staff={staff}
          staffName={staffName}
          childList={children}
          ensureChildren={ensureChildren}
          childErr={childErr}
          loadingChildren={loadingChildren}
          linkUrl={linkUrl}
          publicUrl={publicFormUrl()}
          copy={copy}
          copied={copied}
          onLinkMade={function () {
            setLinks(null);
          }}
        />
      ) : null}

      {tab === "make" ? (
        <MakeTab
          childList={children}
          ensureChildren={ensureChildren}
          childErr={childErr}
          loadingChildren={loadingChildren}
          staff={staff}
          linkUrl={linkUrl}
          copy={copy}
          copied={copied}
          onMade={function () {
            setLinks(null);
          }}
        />
      ) : null}

      {tab === "surveys" ? (
        <SurveyTab
          surveys={surveys}
          admin={admin}
          staff={staff}
          staffName={staffName}
          onAssigned={function () {
            setSurveys(null);
          }}
        />
      ) : null}

      {tab === "links" ? (
        <div>
          {links === null ? (
            <p className="notice">불러오는 중입니다…</p>
          ) : links.length === 0 ? (
            <p className="notice">만든 링크가 없습니다.</p>
          ) : (
            <ul className="rows">
              {links.map(function (l) {
                const dead = new Date(l.expires_at) <= new Date();
                return (
                  <li className="row" key={l.token}>
                    <span>
                      <b>{l.child_name}</b>
                      <em className="row-sub">
                        {new Date(l.created_at).toLocaleDateString("ko-KR")} 생성
                        {l.assigned_to && staffName[l.assigned_to]
                          ? " · " + staffName[l.assigned_to] + " 담당"
                          : ""}
                        {dead ? " · 만료됨" : ""}
                      </em>
                    </span>
                    <button
                      className="submit sm"
                      onClick={function () {
                        copy(linkUrl(l.token), l.token);
                      }}
                    >
                      {copied === l.token ? "복사됨" : "복사"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ── 7-1. 문의 관리 ────────────────────────────────────────────── */

function InquiryTab(props) {
  const [filter, setFilter] = useState("전체");
  const [open, setOpen] = useState(null);

  const list = props.inquiries;
  const shown = useMemo(
    function () {
      if (!list) return [];
      if (filter === "전체") return list;
      return list.filter(function (x) {
        return x.status === filter;
      });
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

  return (
    <div>
      <div className="pub">
        <p className="pub-label">상담 전 사전 설문 주소</p>
        <p className="made-url">{props.publicUrl}</p>
        <button
          className="submit sm"
          onClick={function () {
            props.copy(props.publicUrl, "pub");
          }}
        >
          {props.copied === "pub" ? "복사했습니다" : "주소 복사"}
        </button>
        <p className="made-hint">
          상담 일정을 잡으신 뒤 학부모께 문자로 보내주세요. 주소는 하나로 고정이며
          만료되지 않습니다.
        </p>
      </div>

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

      {list === null ? (
        <p className="notice">불러오는 중입니다…</p>
      ) : shown.length === 0 ? (
        <p className="notice">해당하는 문의가 없습니다.</p>
      ) : (
        <ul className="rows">
          {shown.map(function (x) {
            return (
              <li className="row" key={x.id}>
                <span>
                  <b>{x.child_name || "(이름 없음)"}</b>
                  <em className="row-sub">
                    {new Date(x.created_at).toLocaleDateString("ko-KR")} · {x.phone}
                    {x.child_id ? " · 아동 연결됨" : ""}
                  </em>
                </span>
                <span className="row-right">
                  <em className={"badge " + badgeClass(x.status)}>{x.status}</em>
                  <button
                    className="submit sm"
                    onClick={function () {
                      setOpen(x);
                      props.ensureChildren();
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
          row={open}
          onClose={function () {
            setOpen(null);
          }}
          onSaved={refreshRow}
          staff={props.staff}
          childList={props.childList}
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
  const [childQuery, setChildQuery] = useState("");
  const [pickedChild, setPickedChild] = useState(null);
  const [pickedStaff, setPickedStaff] = useState("");
  const [madeUrl, setMadeUrl] = useState("");

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

  function save() {
    setBusy(true);
    setMsg("");
    patchInquiry(row.id, { memo: memo, status: status })
      .then(function (updated) {
        setBusy(false);
        setMsg("저장했습니다.");
        if (updated) props.onSaved(updated);
      })
      .catch(function (e) {
        setBusy(false);
        setMsg(e.message);
      });
  }

  function connectAndMakeLink() {
    if (!pickedChild) {
      setMsg("아동을 먼저 선택해 주세요.");
      return;
    }
    setBusy(true);
    setMsg("");
    createLink(pickedChild, pickedStaff || null)
      .then(function (link) {
        return patchInquiry(row.id, {
          child_id: pickedChild.id,
          status: "등록",
          memo: memo,
        }).then(function (updated) {
          setMadeUrl(props.linkUrl(link.token));
          setStatus("등록");
          setBusy(false);
          setMsg("연결했습니다. 아래 링크를 학부모께 보내주세요.");
          if (updated) props.onSaved(updated);
          props.onLinkMade();
        });
      })
      .catch(function (e) {
        setBusy(false);
        setMsg(e.message);
      });
  }

  return (
    <div className="modal" onClick={props.onClose}>
      <div
        className="sheet"
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

        <div className="admin-box">
          <p className="pub-label">진행 상태</p>
          <div className="chips">
            {STATUSES.map(function (s) {
              return (
                <Chip
                  key={s}
                  on={status === s}
                  onClick={function () {
                    setStatus(s);
                  }}
                >
                  {s}
                </Chip>
              );
            })}
          </div>
          <textarea
            className="inp ta"
            rows={3}
            placeholder="상담 메모"
            value={memo}
            onChange={function (e) {
              setMemo(e.target.value);
            }}
          />
          <button className="submit sm mt" onClick={save} disabled={busy}>
            {busy ? "저장 중…" : "상태·메모 저장"}
          </button>
        </div>

        <div className="admin-box">
          <p className="pub-label">등록 확정 · 아동 연결</p>
          {row.child_id ? (
            <p className="pool-hint">
              이미 연결된 문의입니다 (아동 id {row.child_id}). 새 링크가 필요하면
              [링크 만들기] 탭에서 만드세요.
            </p>
          ) : (
            <div>
              <p className="pool-hint">
                통합본에서 아동을 먼저 만드신 뒤, 여기서 그 아동을 골라 연결하세요.
              </p>
              {props.childList === null ? (
                <button
                  className="submit sm"
                  onClick={props.ensureChildren}
                  disabled={props.loadingChildren}
                >
                  {props.loadingChildren ? "불러오는 중…" : "아동 목록 불러오기"}
                </button>
              ) : (
                <div>
                  <input
                    className="inp"
                    placeholder="아동 이름으로 찾기"
                    value={childQuery}
                    onChange={function (e) {
                      setChildQuery(e.target.value);
                    }}
                  />
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
                  <p className="pub-label mt">담당 선생님</p>
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
                  <button
                    className="submit sm mt"
                    onClick={connectAndMakeLink}
                    disabled={busy}
                  >
                    {busy ? "처리 중…" : "연결하고 강화제 설문 링크 만들기"}
                  </button>
                </div>
              )}
              {props.childErr ? <p className="q-errmsg">{props.childErr}</p> : null}
            </div>
          )}
          {madeUrl ? (
            <div>
              <p className="made-url">{madeUrl}</p>
              <button
                className="submit sm"
                onClick={function () {
                  props.copy(madeUrl, "inq-link");
                }}
              >
                {props.copied === "inq-link" ? "복사했습니다" : "링크 복사"}
              </button>
            </div>
          ) : null}
          {msg ? <p className="pool-hint">{msg}</p> : null}
        </div>

        <Detail questions={INQ_Q} answers={row.answers} />
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

  useEffect(function () {
    props.ensureChildren();
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
        <p className="made-url">{made.url}</p>
        <div className="made-btns">
          <button
            className="submit sm"
            onClick={function () {
              props.copy(made.url, "make");
            }}
          >
            {props.copied === "make" ? "복사했습니다" : "링크 복사"}
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
        <p className="made-hint">이 링크를 학부모께 보내주세요. 30일 뒤 만료됩니다.</p>
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
          <input
            className="inp"
            placeholder="아동 이름 또는 담당 선생님으로 찾기"
            value={query}
            onChange={function (e) {
              setQuery(e.target.value);
            }}
          />
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
              <li className="row row-empty">찾는 아동이 없습니다.</li>
            ) : null}
          </ul>
          <p className="pub-label">담당 선생님 (응답을 볼 수 있는 계정)</p>
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
  const list = props.surveys;

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
                </em>
              </span>
              <button
                className="submit sm"
                onClick={function () {
                  setOpen(s);
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
                  풀립니다.
                </p>
              </div>
            ) : null}

            <Detail questions={REIN_Q} answers={open.answers} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Detail(props) {
  const answers = props.answers || {};
  return (
    <dl className="detail">
      {props.questions.map(function (q, i) {
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

export default function App() {
  const route = useMemo(function () {
    try {
      const p = new URLSearchParams(window.location.search);
      const t = p.get("t");
      if (t) return { kind: "rein", token: t };
      if (p.get("form") === "inquiry") return { kind: "inquiry" };
      return { kind: "staff" };
    } catch (e) {
      return { kind: "staff" };
    }
  }, []);

  const [loggedIn, setLoggedIn] = useState(function () {
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
.row-right { display: flex; align-items: center; gap: 8px; flex: none; }
.badge { font-style: normal; font-size: 12px; padding: 3px 8px; border-radius: 7px;
  background: var(--pkl); color: var(--pkd); white-space: nowrap; }
.badge-new { background: var(--pkd); color: #fff; }
.badge-off { background: #EFEDEE; color: var(--muted); }

.pub { background: var(--paper); border: 1px solid var(--pk); border-radius: 14px;
  padding: 16px 15px; margin-top: 16px; }
.pub-label { margin: 0 0 8px; font-size: 13px; color: var(--pkd); }
.pub-label.mt { margin-top: 14px; }

.made { background: var(--paper); border: 1px solid var(--pk); border-radius: 14px;
  padding: 20px 18px; margin-top: 16px; }
.made-name { margin: 0 0 10px; font-family: 'Jua', sans-serif; font-size: 18px; color: var(--pkd); }
.made-url { margin: 10px 0 12px; padding: 11px 13px; background: var(--pkl); border-radius: 10px;
  font-size: 13px; line-height: 1.6; word-break: break-all; color: var(--ink); }
.made-btns { display: flex; gap: 8px; align-items: center; }
.made-hint { margin: 12px 0 0; font-size: 13px; line-height: 1.6; color: var(--muted); }

.admin-box { background: #FFF9FA; border: 1px solid var(--line); border-radius: 12px;
  padding: 14px 14px; margin: 14px 0; }

.modal { position: fixed; inset: 0; background: rgba(61,52,58,.4);
  display: flex; align-items: flex-end; justify-content: center; z-index: 50; }
.sheet { width: 100%; max-width: 620px; max-height: 92vh; overflow-y: auto;
  background: #fff; border-radius: 18px 18px 0 0; padding: 20px 18px 40px; }
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
  .hero, .tabs, .rows, .sheet-btns, .submit, .ghost, .admin-box, .pub, .filter { display: none !important; }
  .modal { position: static; background: none; display: block; }
  .sheet { max-height: none; overflow: visible; border-radius: 0; padding: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .app * { transition: none !important; }
}
`;
