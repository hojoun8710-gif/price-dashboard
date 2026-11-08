import { lineChart, responsive } from "./chart.js";
import { AuthError, Repo } from "./github.js";
import {
  BASIS, compare, groups, indexIn, makeWeek, newId, parseDate, ratioOf, snapshot, todayKST, valueFor,
} from "./logic.js";

// ------------------------------------------------------------------ 저장 (이 기기에만)
const K = { repo: "pt.repo", token: "pt.token", cache: "pt.cache", ui: "pt.ui" };
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가(사파리 개인 정보 보호 모드 등) */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
  json(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
};

const S = {
  repo: null, canPush: true,
  prices: null, collect: null, pc: null, decisions: { version: 1, decisions: [] },
  ui: { view: "market", series: "lme", range: "1y", ...ls.json(K.ui, {}) },
  offline: false,
};
const saveUi = () => ls.set(K.ui, JSON.stringify(S.ui));

// ------------------------------------------------------------------ 표시 형식 (메일과 같은 자릿수)
const nf = (d) => new Intl.NumberFormat("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
const F = { 0: nf(0), 1: nf(1), 2: nf(2), 4: nf(4) };
const fmt = (v, d) => (v == null || Number.isNaN(v) ? "–" : F[d].format(v));
const signed = (v, d) => (v == null ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "±") + F[d].format(Math.abs(v)));
const pct = (v, d = 1) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${F[d === 2 ? 2 : 1].format(Math.abs(v * 100))}%`);
// 단가: 소수 2~4자리 (입력한 자릿수 유지). 금액(이득·손해): 1,000 이상은 정수.
const unitFmt = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const money = (cur, v) => (v == null ? "–" : `${cur} ${cur === "KRW" ? F[0].format(v) : unitFmt.format(v)}`);
// 계산된 단가(적정 단가)는 기준이 되는 입력 단가와 같은 자릿수로
const decimalsOf = (v) => { const t = String(v).split(".")[1]; return t ? t.length : 0; };
const moneyAs = (cur, v, ref) => (v == null ? "–" : cur === "KRW" ? `${cur} ${F[0].format(v)}`
  : `${cur} ${new Intl.NumberFormat("ko-KR", { minimumFractionDigits: Math.max(2, Math.min(4, decimalsOf(ref))), maximumFractionDigits: Math.max(2, Math.min(4, decimalsOf(ref))) }).format(v)}`);
const amount = (cur, v) => (v == null ? "–" : `${cur} ${Math.abs(v) >= 1000 || cur === "KRW" ? F[0].format(v) : F[2].format(v)}`);
const shortDate = (s) => s ? `${+s.slice(5, 7)}/${+s.slice(8, 10)}` : "–";
const when = (isoStr) => {
  if (!isoStr) return "–";
  const d = new Date(isoStr);
  if (Number.isNaN(d)) return isoStr;
  const k = new Date(d.getTime() + 9 * 3600e3);
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()} ${String(k.getUTCHours()).padStart(2, "0")}:${String(k.getUTCMinutes()).padStart(2, "0")}`;
};

const SERIES = {
  lme: { name: "LME CASH", tab: "LME", full: "알루미늄 LME CASH", unit: "USD/t", color: "var(--s-lme)", col: ["lme", 1], d: 1, cmp: "lme" },
  stock: { name: "LME 재고", tab: "LME 재고", full: "LME 알루미늄 재고", unit: "t", color: "var(--s-stock)", col: ["lme", 2], d: 0 },
  smm: { name: "SMM A00", tab: "SMM", full: "알루미늄 SMM A00", unit: "CNY/t", color: "var(--s-smm)", col: ["smm", 1], d: 0, cmp: "smm" },
  usdcny: { name: "USD/CNY", full: "USD/CNY 환율", unit: "", color: "var(--s-cny)", col: ["usdcny", 1], d: 4, cmp: "usdcny" },
  usdkrw: { name: "USD/KRW", full: "USD/KRW 환율", unit: "원", color: "var(--s-krw)", col: ["usdkrw", 1], d: 2, cmp: "usdkrw" },
};
const RANGES = [["3m", "3개월", 3], ["6m", "6개월", 6], ["1y", "1년", 12], ["all", "전체", 1200]];

// ------------------------------------------------------------------ DOM 도우미 (데이터는 항상 textContent 로)
const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

function rowsOf(key) {
  const [s, c] = SERIES[key].col;
  return (S.prices?.series[s] || []).map((r) => [r[0], r[c]]).filter((r) => r[1] != null);
}

// ------------------------------------------------------------------ 시세 화면
function deltaEl(diff, last, d) {
  if (diff == null) return h("span", { class: "delta flat" }, "–");
  const cls = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "–";
  return h("span", { class: `delta ${cls}` }, `${arrow} ${signed(diff, d)}`, last ? ` (${pct(diff / last, 2)})` : "");
}

function renderCards() {
  const box = $("cards");
  box.replaceChildren();
  const c = S.prices.compare;
  for (const key of ["lme", "smm", "usdcny"]) {
    const s = SERIES[key];
    const x = c[key];
    const days = x.this_days.length;
    const notes = [];
    if (days && days < 5) notes.push(`${days}일 평균 (${x.this_days.map(shortDate).join(", ")})`);
    if (!x.has_wednesday && days) notes.push(`${shortDate(S.prices.week.end)}(수) 값 대기 중`);
    if (!days) notes.push(`이번 주 데이터 없음 · 최신 ${shortDate(x.latest)}`);
    box.append(h("article", { class: "card stat" },
      h("div", { class: "stat-head" }, keyEl(s.color), s.full),
      h("div", { class: "value num" }, fmt(x.this, s.d), s.unit ? h("span", { class: "unit" }, s.unit) : null),
      h("div", { class: "cmp" }, deltaEl(x.diff, x.last, s.d), h("span", { class: "muted" }, `지난주 ${fmt(x.last, s.d)}`)),
      notes.length ? h("p", { class: "note" }, notes.join(" · ")) : null));
  }
}
function keyEl(color) {
  const k = h("i", { class: "key", "aria-hidden": "true" });
  k.style.background = color;
  return k;
}

function renderSeriesTabs() {
  const tabs = $("series-tabs");
  tabs.replaceChildren(...Object.entries(SERIES)
    .filter(([k]) => k !== "usdkrw" || rowsOf("usdkrw").length)
    .map(([k, s]) => h("button", {
      role: "tab", "aria-selected": String(S.ui.series === k), type: "button",
      onclick: () => { S.ui.series = k; saveUi(); renderChart(); renderSeriesTabs(); renderTable(); },
    }, s.tab || s.name)));
  const rt = $("range-tabs");
  rt.replaceChildren(...RANGES.map(([k, label]) => h("button", {
    type: "button", "aria-pressed": String(S.ui.range === k),
    onclick: () => { S.ui.range = k; saveUi(); renderChart(); renderSeriesTabs(); },
  }, label)));
}

let chartRO;
function renderChart() {
  const key = SERIES[S.ui.series] ? S.ui.series : "lme";
  const s = SERIES[key];
  const all = rowsOf(key);
  $("chart-title").textContent = `${s.full}${s.unit ? ` (${s.unit})` : ""}`;
  const months = RANGES.find((r) => r[0] === S.ui.range)?.[2] ?? 12;
  let pts = all;
  if (all.length) {
    const end = parseDate(all[all.length - 1][0]);
    const from = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months, end.getUTCDate())).toISOString().slice(0, 10);
    pts = all.filter((p) => p[0] >= from);
  }
  const host = $("chart");
  const draw = () => lineChart(host, { points: pts, format: (v) => fmt(v, s.d), label: s.name, color: s.color, height: 230 });
  draw();
  chartRO?.disconnect();
  chartRO = responsive(host, draw);
  if (pts.length) {
    const vs = pts.map((p) => p[1]);
    const hi = Math.max(...vs);
    const lo = Math.min(...vs);
    const last = pts[pts.length - 1];
    $("chart-foot").textContent =
      `최근 ${fmt(last[1], s.d)} (${last[0].replaceAll("-", ".")}) · 기간 최고 ${fmt(hi, s.d)} · 최저 ${fmt(lo, s.d)}`;
  } else {
    $("chart-foot").textContent = "";
  }
}

function renderTable() {
  const key = SERIES[S.ui.series] ? S.ui.series : "lme";
  const s = SERIES[key];
  const rows = rowsOf(key);
  $("table-title").textContent = `주차별 평균 — ${s.name}`;
  const cur = S.prices.week;
  const out = [];
  let start = parseDate(cur.start);
  for (let i = 0; i < 9; i++) {
    const w = makeWeek(start);
    const v = valueFor(rows, 1, w.start, w.end);
    out.push({ w, v: v.approx ? null : v.value, days: v.days });
    start = new Date(start.getTime() - 7 * 864e5);
  }
  const t = $("week-table");
  t.replaceChildren(
    h("thead", {}, h("tr", {}, h("th", {}, "주차"), h("th", { class: "r" }, "평균"), h("th", { class: "r" }, "지난주 대비"), h("th", { class: "r" }, "일수"))),
    h("tbody", {}, out.slice(0, 8).map((r, i) => {
      const prev = out[i + 1];
      const diff = r.v != null && prev?.v != null ? r.v - prev.v : null;
      return h("tr", {},
        h("td", {}, r.w.label, h("div", { class: "muted sub" }, r.w.span)),
        h("td", { class: "r" }, fmt(r.v, s.d)),
        h("td", { class: "r" }, deltaEl(diff, null, s.d)),
        h("td", { class: "r muted" }, r.days ? `${r.days}일` : "–"));
    })));
}

// ------------------------------------------------------------------ 실행 상태
const TRIGGER = { schedule: "정기", workflow_dispatch: "수동", "pc-fallback": "PC 보충", manual: "수동", test: "시험", push: "푸시" };
const COLLECT_STATE = {
  complete: ["good", "✓", "수집 완료"],
  partial: ["warning", "!", "일부 대기"],
  failed: ["critical", "✕", "수집 실패"],
};
const PC_STATE = {
  sent: ["good", "✓", "발송 완료"],
  test_sent: ["neutral", "✓", "시험 발송"],
  dry_run: ["neutral", "·", "시험 실행"],
  deferred: ["warning", "Ⅱ", "1차 보류"],
  not_sent: ["critical", "✕", "미발송"],
  send_failed: ["critical", "✕", "발송 실패"],
  error: ["critical", "✕", "오류"],
};
const chip = ([cls, icon, label]) => h("span", { class: `status-chip ${cls}` }, h("i", { "aria-hidden": "true" }, icon), label);
const SRC_NAME = { LME: "LME", SMM: "SMM", FX: "USD/CNY", KRW: "USD/KRW" };

function renderStatus() {
  const cbox = $("collect-status");
  const runs = S.collect?.runs || [];
  cbox.replaceChildren();
  if (!runs.length) {
    cbox.append(h("article", { class: "card" }, h("p", { class: "muted" }, "아직 수집 기록이 없습니다. GitHub → Actions → 시세 수집 → Run workflow 로 한 번 실행해 보세요.")));
  } else {
    const r = runs[0];
    const st = COLLECT_STATE[r.state] || ["neutral", "·", r.state];
    const label = r.state === "partial" && r.missing_wednesday?.length ? [...st.slice(0, 2), `수요일 값 대기 (${r.missing_wednesday.join(", ")})`] : st;
    cbox.append(h("article", { class: "card status-card" },
      chip(label),
      h("p", { class: "meta" }, `${when(r.at)} · ${TRIGGER[r.trigger] || r.trigger} · ${r.week} (${r.span})${r.dry_run ? " · 시험" : ""}`),
      h("div", { class: "src-rows" }, Object.entries(r.sources || {}).map(([k, v]) => h("div", { class: "src-row" },
        h("b", {}, SRC_NAME[k] || k),
        h("span", {}, v.skipped ? `건너뜀 — ${v.reason}` : v.ok
          ? `${v.source || ""} · 최신 ${shortDate(v.latest)} · ${v.added.length ? `${v.added.length}일 추가` : "새 값 없음"}`
          : `실패 — ${v.error}`)))),
      [...(r.problems || []), ...(r.notes || [])].length ? h("ul", {}, [...(r.problems || []), ...(r.notes || [])].map((p) => h("li", {}, p))) : null,
      history(runs.slice(1, 8), (x) => [`${when(x.at)} ${TRIGGER[x.trigger] || x.trigger}`, (COLLECT_STATE[x.state] || ["", "", x.state])[2]])));
  }

  const pbox = $("pc-status");
  const pr = S.pc?.runs || [];
  pbox.replaceChildren();
  if (!pr.length) {
    pbox.append(h("article", { class: "card" }, h("p", { class: "muted" }, "아직 PC 실행 기록이 없습니다. PC 설정을 마치면 목요일 18:00·22:00에 실행됩니다.")));
  } else {
    const r = pr[0];
    const reasons = r.status === "deferred" ? r.deferred_reason || [] : r.problems || [];
    pbox.append(h("article", { class: "card status-card" },
      chip(PC_STATE[r.status] || ["neutral", "·", r.status]),
      h("p", { class: "meta" }, `${when(r.at)} · ${r.week} (${r.span})${r.round ? ` · ${r.round}` : ""}${r.file ? ` · ${r.file}` : ""}`),
      reasons.length ? h("ul", {}, reasons.map((p) => h("li", {}, p))) : null,
      (r.warnings || []).length ? h("ul", {}, r.warnings.map((p) => h("li", { class: "muted" }, p))) : null,
      history(pr.slice(1, 8), (x) => [`${when(x.at)} ${x.week}`, (PC_STATE[x.status] || ["", "", x.status])[2]])));
  }
  $("conn-repo").textContent = S.repo?.full || "";
  $("conn-info").textContent = `${S.canPush ? "읽기·쓰기 권한" : "읽기 전용 토큰 (구매 결정 저장 불가)"} · 시세 업데이트 ${when(S.prices?.generated_at)}`;
  const bad = runs[0]?.state === "failed" || ["not_sent", "send_failed", "error"].includes(pr[0]?.status);
  $("status-dot").hidden = !bad;
}
function history(list, fn) {
  if (!list.length) return null;
  return h("div", { class: "history" }, list.map((x) => { const [a, b] = fn(x); return h("div", {}, h("span", {}, a), h("span", {}, b)); }));
}

// ------------------------------------------------------------------ 구매 결정
function verdict(c) {
  if (c.ratio == null) return h("span", { class: "verdict base" }, "비교 불가");
  if (!c.n) return h("span", { class: "verdict base" }, "비교 기준");
  if (Math.abs(c.pct) < 0.001) return h("span", { class: "verdict base" }, "≈ 같음");
  const good = c.pct < 0;
  return h("span", { class: `verdict ${good ? "good" : "bad"}` }, `${good ? "✓ 유리" : "✕ 불리"} ${pct(c.pct)}`);
}
function verdictDetail(c, d) {
  if (c.ratio == null) return "환산할 시세(환율)가 없어 비교할 수 없습니다.";
  if (!c.n) return "같은 품목의 첫 기록 — 다음 결정부터 이 기록과 비교합니다.";
  const parts = [`과거 ${c.basisKind} ${c.n}건 평균 대비`, `적정 단가 ${moneyAs(d.currency, c.fair, d.unit_price)}`];
  if (c.effect != null && d.kind === "발주") parts.push(`${c.effect >= 0 ? "이득" : "손해"} 약 ${amount(d.currency, Math.abs(c.effect))}`);
  return parts.join(" · ");
}

function renderDecisions() {
  const list = $("decision-list");
  list.replaceChildren();
  const all = S.decisions.decisions || [];
  $("new-decision").disabled = !S.canPush || !S.prices;
  if (!all.length) {
    list.append(h("article", { class: "card empty" },
      h("p", {}, "아직 기록된 구매 결정이 없습니다."),
      h("p", { class: "small-text" }, "‘+ 기록하기’로 품목·단가·수량을 남기면 그 주의 시세가 함께 저장되고, 다음 결정부터 과거와 비교됩니다.")));
    return;
  }
  for (const g of groups(all)) {
    const card = h("article", { class: "card group" });
    const orders = g.list.filter((d) => d.kind === "발주").length;
    card.append(h("div", { class: "group-head" },
      h("h2", {}, g.item),
      h("p", { class: "muted small-text" }, `${g.currency} · 기준 지표 ${BASIS[g.basis]?.name || g.basis} · 단위 ${g.qty_unit} · ${g.list.length}건${orders ? ` (발주 ${orders})` : ""}`)));
    const withRatio = g.list.filter((d) => ratioOf(d) != null);
    if (withRatio.length >= 2) {
      const first = ratioOf(withRatio[0]);
      const pts = withRatio.map((d) => [d.date, (ratioOf(d) / first) * 100]);
      const ordersR = withRatio.filter((d) => d.kind === "발주").map(ratioOf);
      const avg = ordersR.length ? (ordersR.reduce((a, b) => a + b, 0) / ordersR.length / first) * 100 : null;
      const host = h("div", { class: "chart", "aria-label": "시세 대비 단가 지수" });
      card.append(h("p", { class: "small-text muted" }, "시세 대비 단가 지수 (첫 기록 = 100, 낮을수록 유리)"), host);
      const draw = () => lineChart(host, {
        points: pts, format: (v) => fmt(v, 1), label: "시세 대비 단가", color: "var(--s-lme)", dots: true, height: 150,
        ref: avg != null ? { value: avg, label: `발주 평균 ${fmt(avg, 1)}` } : null,
        tipExtra: (i) => `${withRatio[i].kind} · ${money(withRatio[i].currency, withRatio[i].unit_price)}`,
      });
      requestAnimationFrame(draw);
      responsive(host, draw);
    }
    for (const d of [...g.list].reverse()) {
      const c = compare(d, all);
      card.append(h("button", { class: "decision", type: "button", onclick: () => openForm(d) },
        h("div", { class: "line1" },
          h("span", {}, `${d.date.replaceAll("-", ".")} `, h("span", { class: "kind" }, d.kind), d.supplier ? ` · ${d.supplier}` : ""),
          h("span", {}, d.snapshot?.week_label ? `근거 ${d.snapshot.week_label}` : "")),
        h("div", { class: "line2" },
          h("span", { class: "price" }, money(d.currency, d.unit_price), d.qty ? h("span", { class: "muted qty" }, ` × ${fmt(d.qty, d.qty % 1 ? 2 : 0)}${d.qty_unit}`) : null),
          verdict(c)),
        h("div", { class: "small-text muted" }, verdictDetail(c, d)),
        d.memo ? h("div", { class: "memo" }, d.memo) : null));
    }
    list.append(card);
  }
}

// --- 입력 폼
let editing = null;
function formData() {
  const f = $("decision-form");
  const v = Object.fromEntries(new FormData(f).entries());
  return {
    date: v.date, kind: v.kind, item: (v.item || "").trim(), supplier: (v.supplier || "").trim(),
    unit_price: v.unit_price === "" ? null : Number(v.unit_price), currency: v.currency, basis: v.basis,
    qty: v.qty === "" ? null : Number(v.qty), qty_unit: v.qty_unit, memo: (v.memo || "").trim(),
  };
}
function openForm(d = null) {
  editing = d;
  const f = $("decision-form");
  f.reset();
  const all = S.decisions.decisions || [];
  $("item-list").replaceChildren(...[...new Set(all.map((x) => x.item))].map((x) => h("option", { value: x })));
  $("supplier-list").replaceChildren(...[...new Set(all.map((x) => x.supplier).filter(Boolean))].map((x) => h("option", { value: x })));
  const last = all[all.length - 1];
  const init = d || { date: todayKST(), kind: "발주", currency: last?.currency || "USD", basis: last?.basis || "SMM", qty_unit: last?.qty_unit || "개" };
  for (const [k, v] of Object.entries(init)) if (f.elements[k] && v != null && typeof v !== "object") f.elements[k].value = v;
  $("decision-form-title").textContent = d ? "구매 결정 수정" : "구매 결정 기록";
  $("decision-delete").hidden = !d;
  $("decision-error").hidden = true;
  $("decision-save").disabled = !S.canPush;
  updatePreview();
  $("decision-dialog").showModal();
}

function updatePreview() {
  const box = $("preview");
  box.replaceChildren();
  const v = formData();
  if (!S.prices || !v.date) return;
  const snap = editing && editing.date === v.date && editing.snapshot ? editing.snapshot : snapshot(S.prices, v.date);
  box.append(h("div", {}, h("b", {}, `근거 시세 · ${snap.week_label} (${snap.week_span}) 평균${snap.approx ? " — 일부는 최근 값" : ""}`)),
    h("div", { class: "muted" }, `SMM ${fmt(snap.smm, 0)} CNY/t · LME ${fmt(snap.lme, 1)} USD/t · USD/CNY ${fmt(snap.usdcny, 4)}${snap.usdkrw ? ` · USD/KRW ${fmt(snap.usdkrw, 2)}` : ""}`));
  const idx = indexIn(snap, v.basis, v.currency);
  if (idx == null) {
    box.append(h("div", { class: "error" }, v.currency === "KRW" ? "원/달러 환율 데이터가 없어 원화 단가는 시세와 비교할 수 없습니다." : "이 주의 기준 지표 데이터가 없습니다."));
    return;
  }
  box.append(h("div", {}, `기준 지표 ${BASIS[v.basis].name} 환산: `, h("b", {}, `${fmt(idx, v.currency === "KRW" ? 0 : 1)} ${v.currency}/t`)));
  if (!v.item || v.unit_price == null || !(v.unit_price > 0)) return;
  const draft = { ...v, id: editing?.id || "__draft__", snapshot: snap, created_at: editing?.created_at || new Date().toISOString() };
  const others = (S.decisions.decisions || []).filter((x) => x.id !== draft.id).concat([draft]);
  const c = compare(draft, others);
  if (!c.n) {
    box.append(h("div", { class: "muted" }, "같은 품목·통화·기준 지표·단위의 이전 기록이 없어, 이번 기록이 다음 비교의 기준이 됩니다."));
    return;
  }
  const good = c.pct < 0;
  box.append(
    h("div", {}, `과거 ${c.basisKind} ${c.n}건 평균 조건을 이 시세에 적용한 적정 단가: `, h("b", {}, moneyAs(v.currency, c.fair, v.unit_price))),
    h("div", {}, "입력 단가는 ", h("b", { class: `verdict ${good ? "good" : "bad"}` }, `${pct(c.pct)} ${good ? "유리" : "불리"}`),
      c.effect != null ? ` · 수량 기준 약 ${amount(v.currency, Math.abs(c.effect))} ${c.effect >= 0 ? "이득" : "손해"}` : "",
      c.prev && c.prevPct != null ? h("span", { class: "muted" }, ` · 직전(${c.prev.date}) 대비 ${pct(c.prevPct)}`) : ""));
}

async function saveForm(e) {
  e.preventDefault();
  const v = formData();
  const err = $("decision-error");
  err.hidden = true;
  if (!v.item || !(v.unit_price > 0)) {
    err.textContent = "품목과 단가를 입력하세요.";
    err.hidden = false;
    return;
  }
  const now = new Date().toISOString();
  const snap = editing && editing.date === v.date && editing.snapshot ? editing.snapshot : snapshot(S.prices, v.date);
  const rec = { ...(editing || {}), ...v, id: editing?.id || newId(), snapshot: snap, created_at: editing?.created_at || now, updated_at: now };
  const btn = $("decision-save");
  btn.disabled = true;
  try {
    const doc = await S.repo.update("data/decisions.json", (cur) => {
      const d = cur || { version: 1, decisions: [] };
      d.decisions = (d.decisions || []).filter((x) => x.id !== rec.id).concat([rec]);
      d.decisions.sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at));
      return d;
    }, `구매 결정 ${editing ? "수정" : "추가"} (${v.date})`);
    S.decisions = doc;
    cacheSave();
    $("decision-dialog").close();
    renderDecisions();
  } catch (ex) {
    err.textContent = `저장하지 못했습니다: ${ex.message}`;
    err.hidden = false;
  } finally {
    btn.disabled = !S.canPush;
  }
}

async function deleteDecision() {
  if (!editing) return;
  if (!confirm(`${editing.date} ${editing.item} 기록을 삭제할까요? (저장소 기록 이력에는 남습니다)`)) return;
  try {
    const id = editing.id;
    S.decisions = await S.repo.update("data/decisions.json", (cur) => {
      const d = cur || { version: 1, decisions: [] };
      d.decisions = (d.decisions || []).filter((x) => x.id !== id);
      return d;
    }, `구매 결정 삭제 (${editing.date})`);
    cacheSave();
    $("decision-dialog").close();
    renderDecisions();
  } catch (ex) {
    $("decision-error").textContent = `삭제하지 못했습니다: ${ex.message}`;
    $("decision-error").hidden = false;
  }
}

// ------------------------------------------------------------------ 화면 전환 / 전체 그리기
function setView(view) {
  S.ui.view = view;
  saveUi();
  for (const b of document.querySelectorAll(".tabbar button")) b.setAttribute("aria-selected", String(b.dataset.view === view));
  for (const v of ["market", "decisions", "status"]) $(`view-${v}`).hidden = v !== view;
  if (view === "market") renderChart();
  if (view === "decisions") renderDecisions();
  window.scrollTo(0, 0);
}

function render() {
  const p = S.prices;
  $("week-title").textContent = p ? `${p.week.label} (${p.week.span})` : "원자재 가격 동향";
  $("week-sub").textContent = p ? `지난주 ${p.prev_week.label}와 비교 · 업데이트 ${when(p.generated_at)}` : "";
  const banner = $("banner");
  const msgs = [];
  if (S.offline) msgs.push("연결할 수 없어 마지막으로 받은 데이터를 보여 줍니다.");
  if (S.error) msgs.push(S.error);
  if (p && Date.now() - Date.parse(p.generated_at) > 8 * 864e5) msgs.push(`시세가 ${when(p.generated_at)} 이후 갱신되지 않았습니다. 실행 상태를 확인하세요.`);
  banner.textContent = msgs.join(" ");
  banner.hidden = !msgs.length;
  if (p) {
    renderCards();
    renderSeriesTabs();
    renderTable();
  }
  renderStatus();
  setView(S.ui.view);
}

// ------------------------------------------------------------------ 데이터 읽기
function cacheSave() {
  ls.set(K.cache, JSON.stringify({ prices: S.prices, collect: S.collect, pc: S.pc, decisions: S.decisions }));
}

async function load() {
  const btn = $("refresh");
  btn.classList.add("spinning");
  try {
    const [prices, collect, pc, decisions] = await Promise.all([
      S.repo.readJson("data/prices.json"),
      S.repo.readJson("data/status/collect.json"),
      S.repo.readJson("data/status/pc.json"),
      S.repo.readJson("data/decisions.json"),
    ]);
    if (!prices) throw new Error("data/prices.json 이 아직 없습니다. Actions 에서 ‘시세 수집’을 한 번 실행하세요.");
    Object.assign(S, { prices, collect, pc, decisions: decisions || { version: 1, decisions: [] }, offline: false, error: null });
    cacheSave();
  } catch (e) {
    if (e instanceof AuthError) {
      showSetup(e.message);
      return;
    }
    const c = ls.json(K.cache, null);
    if (c?.prices) Object.assign(S, c, { offline: true });
    S.error = e.message;
  } finally {
    btn.classList.remove("spinning");
  }
  render();
}

function showSetup(msg) {
  $("app").hidden = true;
  $("setup").hidden = false;
  $("setup-repo").value = ls.get(K.repo) || "";
  $("setup-error").textContent = msg || "";
  $("setup-error").hidden = !msg;
}

async function connect(repoName, token) {
  const repo = new Repo(repoName, token);
  const info = await repo.check();
  S.repo = repo;
  S.canPush = info.canPush;
  ls.set(K.repo, repo.full);
  ls.set(K.token, repo.token);
  $("setup").hidden = true;
  $("app").hidden = false;
  await load();
}

// ------------------------------------------------------------------ 시작
function init() {
  $("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector("button");
    btn.disabled = true;
    try {
      await connect($("setup-repo").value, $("setup-token").value);
      $("setup-token").value = "";
    } catch (ex) {
      showSetup(ex.message);
    } finally {
      btn.disabled = false;
    }
  });
  for (const b of document.querySelectorAll(".tabbar button")) b.addEventListener("click", () => setView(b.dataset.view));
  $("refresh").addEventListener("click", load);
  $("new-decision").addEventListener("click", () => openForm());
  $("decision-form").addEventListener("submit", saveForm);
  $("decision-form").addEventListener("input", updatePreview);
  $("decision-form").addEventListener("change", updatePreview);
  $("decision-cancel").addEventListener("click", () => $("decision-dialog").close());
  $("decision-delete").addEventListener("click", deleteDecision);
  $("disconnect").addEventListener("click", () => {
    if (!confirm("이 기기에서 토큰과 저장된 데이터를 지울까요?")) return;
    ls.del(K.token);
    ls.del(K.cache);
    S.repo = null;
    showSetup();
  });

  const repo = ls.get(K.repo);
  const token = ls.get(K.token);
  if (repo && token) {
    S.repo = new Repo(repo, token);
    $("app").hidden = false;
    const c = ls.json(K.cache, null);
    if (c?.prices) { Object.assign(S, c); render(); } // 먼저 지난 데이터로 바로 그리고
    S.repo.check().then((i) => { S.canPush = i.canPush; }).catch(() => {}).finally(load); // 최신으로 갱신
  } else {
    showSetup();
  }

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
