// 계산 로직 (화면과 무관한 순수 함수). 주차 규칙은 src/weeks.py 와 같아야 한다.

const DAY = 86400000;

export function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function iso(dt) {
  return dt.toISOString().slice(0, 10);
}
const mmdd = (dt) => `${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${String(dt.getUTCDate()).padStart(2, "0")}`;

/** 목~수 한 주. label 은 목요일이 속한 달의 몇 번째 목요일인지. */
export function makeWeek(startThu) {
  const end = new Date(startThu.getTime() + 6 * DAY);
  return {
    start: iso(startThu),
    end: iso(end),
    label: `${startThu.getUTCMonth() + 1}월 ${Math.floor((startThu.getUTCDate() - 1) / 7) + 1}주차`,
    span: `${mmdd(startThu)}~${mmdd(end)}`,
  };
}

/** 그 날짜 기준 직전 수요일로 끝나는 주 (src/weeks.py target_week 와 같음). */
export function targetWeek(dateStr) {
  let d = new Date(parseDate(dateStr).getTime() - DAY);
  while (d.getUTCDay() !== 3) d = new Date(d.getTime() - DAY);
  return makeWeek(new Date(d.getTime() - 6 * DAY));
}

export function todayKST() {
  return iso(new Date(Date.now() + 9 * 3600 * 1000));
}

/** rows: [[date, v1, v2…]] 정렬됨. [start, end] 평균, 없으면 end 이전 마지막 값(approx). */
export function valueFor(rows, col, start, end) {
  const vals = rows.filter((r) => r[0] >= start && r[0] <= end && r[col] != null).map((r) => r[col]);
  if (vals.length) return { value: vals.reduce((a, b) => a + b, 0) / vals.length, days: vals.length, approx: false };
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][0] <= end && rows[i][col] != null) return { value: rows[i][col], days: 0, approx: true, asOf: rows[i][0] };
  }
  return { value: null, days: 0, approx: true };
}

/** 결정 날짜 기준 근거 시세: 그날 보고 있던 주간 보고(직전 완료 주차)의 평균. */
export function snapshot(prices, dateStr) {
  const w = targetWeek(dateStr);
  const s = prices.series;
  const lme = valueFor(s.lme, 1, w.start, w.end);
  const smm = valueFor(s.smm, 1, w.start, w.end);
  const cny = valueFor(s.usdcny, 1, w.start, w.end);
  const krw = valueFor(s.usdkrw || [], 1, w.start, w.end);
  const approx = [lme, smm, cny, krw].some((x) => x.approx && x.value != null);
  return {
    week_label: w.label, week_span: w.span, week_end: w.end,
    lme: lme.value, smm: smm.value, usdcny: cny.value, usdkrw: krw.value, approx,
  };
}

export const BASIS = {
  SMM: { name: "SMM A00", unit: "CNY/t" },
  LME: { name: "LME CASH", unit: "USD/t" },
};
export const CURRENCIES = ["USD", "CNY", "KRW"];

/** 기준 지표(톤당)를 단가 통화로 환산. 환산에 필요한 환율이 없으면 null. */
export function indexIn(snap, basis, currency) {
  const { lme, smm, usdcny, usdkrw } = snap;
  if (basis === "SMM") {
    if (smm == null) return null;
    if (currency === "CNY") return smm;
    if (!usdcny) return null;
    if (currency === "USD") return smm / usdcny;
    if (currency === "KRW") return usdkrw ? (smm / usdcny) * usdkrw : null;
  } else if (basis === "LME") {
    if (lme == null) return null;
    if (currency === "USD") return lme;
    if (currency === "CNY") return usdcny ? lme * usdcny : null;
    if (currency === "KRW") return usdkrw ? lme * usdkrw : null;
  }
  return null;
}

export const normItem = (s) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();
export const groupKey = (d) => [normItem(d.item), d.currency, d.basis, d.qty_unit].join("|");

/** 단가 ÷ 기준 지표 (같은 시세 조건에서 얼마나 싸게 샀는지 보는 비율). */
export function ratioOf(d) {
  const idx = d.snapshot && indexIn(d.snapshot, d.basis, d.currency);
  return idx ? d.unit_price / idx : null;
}

const byTime = (a, b) => (a.date === b.date ? (a.created_at || "").localeCompare(b.created_at || "") : a.date.localeCompare(b.date));

/**
 * 결정 d 를 같은 품목·통화·기준지표·수량단위의 '더 이전' 결정들과 비교한다.
 * 기준선 = 이전 '발주' 결정들의 비율 평균 (발주가 없으면 이전 결정 전체).
 *  pct < 0  → 같은 시세 조건에서 과거보다 싸다 (이득)
 *  fair     → 과거 평균 조건을 지금 시세에 적용한 단가
 *  effect   → (fair − 단가) × 수량. 양수면 이득 (발주일 때만 의미 있음)
 */
export function compare(d, all) {
  const r = ratioOf(d);
  const key = groupKey(d);
  const earlier = all.filter((x) => x.id !== d.id && groupKey(x) === key && byTime(x, d) < 0 && ratioOf(x) != null).sort(byTime);
  const orders = earlier.filter((x) => x.kind === "발주");
  const base = orders.length ? orders : earlier;
  const idx = d.snapshot ? indexIn(d.snapshot, d.basis, d.currency) : null;
  const out = { ratio: r, index: idx, n: base.length, basisKind: orders.length ? "발주" : "전체", prev: earlier[earlier.length - 1] || null };
  if (r == null || !base.length) return out;
  const baseRatio = base.reduce((a, x) => a + ratioOf(x), 0) / base.length;
  out.baseRatio = baseRatio;
  out.pct = r / baseRatio - 1;
  out.fair = baseRatio * idx;
  out.effect = d.qty ? (out.fair - d.unit_price) * d.qty : null;
  if (out.prev) {
    const pr = ratioOf(out.prev);
    out.prevPct = r / pr - 1;
  }
  return out;
}

export function groups(decisions) {
  const map = new Map();
  for (const d of [...decisions].sort(byTime)) {
    const k = groupKey(d);
    if (!map.has(k)) map.set(k, { key: k, item: d.item.trim(), currency: d.currency, basis: d.basis, qty_unit: d.qty_unit, list: [] });
    map.get(k).list.push(d);
  }
  return [...map.values()].sort((a, b) => b.list[b.list.length - 1].date.localeCompare(a.list[a.list.length - 1].date));
}

export function newId() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
