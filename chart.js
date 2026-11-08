// 가벼운 SVG 선 차트 (외부 라이브러리 없음 — 토큰이 있는 페이지라 외부 스크립트를 싣지 않는다).
// 한 차트에 한 시리즈. 십자선이 가장 가까운 날짜에 붙고, 툴팁에 값(강조)과 날짜를 보여 준다.
// 터치: 가로로 끌면 십자선 이동, 세로 스크롤은 그대로. 키보드: ←/→.

const NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function niceTicks(min, max, count = 4) {
  if (min === max) {
    const pad = Math.abs(min) * 0.01 || 1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi, ticks, step };
}

const MONTH = (s) => `${+s.slice(5, 7)}월`;
const YEAR = (s) => `’${s.slice(2, 4)}`;

/**
 * @param {HTMLElement} host  .chart 컨테이너 (position:relative)
 * @param {object} o
 *   points: [[dateStr, value]]  (정렬됨)
 *   format: v => string        값 표시
 *   label:  string             시리즈 이름 (접근성/툴팁)
 *   color:  CSS 색 (var(--series-1) 등)
 *   ref:    {value, label}?    가로 기준선 (예: 과거 평균)
 *   dots:   boolean            점 표시 (데이터가 적을 때)
 *   height: number
 *   tipExtra: (i) => string?   툴팁 둘째 줄
 */
export function lineChart(host, o) {
  host.replaceChildren();
  const pts = o.points.filter((p) => p[1] != null);
  if (!pts.length) {
    const p = document.createElement("p");
    p.className = "muted chart-empty";
    p.textContent = "표시할 데이터가 없습니다.";
    host.appendChild(p);
    return;
  }
  const W = Math.max(280, host.clientWidth || 320);
  const H = o.height || 220;
  const m = { t: 14, r: 12, b: 24, l: 8 };

  const vals = pts.map((p) => p[1]).concat(o.ref && o.ref.value != null ? [o.ref.value] : []);
  const { lo, hi, ticks } = niceTicks(Math.min(...vals), Math.max(...vals));
  // y 라벨 폭 (대략)
  const labelW = Math.max(...ticks.map((t) => o.format(t).length)) * 6.6 + 6;
  m.l = labelW;

  const t0 = Date.parse(pts[0][0]);
  const t1 = Date.parse(pts[pts.length - 1][0]);
  const x = (s) => m.l + (t1 === t0 ? (W - m.l - m.r) / 2 : ((Date.parse(s) - t0) / (t1 - t0)) * (W - m.l - m.r));
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${o.label} 일별 추이` });
  host.appendChild(svg);

  // 격자와 y 라벨
  const grid = el("g", { class: "grid" }, svg);
  for (const t of ticks) {
    el("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }, grid);
    const tx = el("text", { x: m.l - 6, y: y(t) + 4, "text-anchor": "end", class: "tick" }, grid);
    tx.textContent = o.format(t);
  }

  // x 라벨: 월 경계 (너무 촘촘하면 건너뜀)
  const xg = el("g", { class: "xaxis" }, svg);
  const months = [];
  for (let i = 1; i < pts.length; i++) if (pts[i][0].slice(0, 7) !== pts[i - 1][0].slice(0, 7)) months.push(pts[i][0]);
  const spanDays = (t1 - t0) / 864e5;
  const every = spanDays > 900 ? 6 : spanDays > 400 ? 3 : spanDays > 200 ? 2 : 1;
  let lastX = -Infinity;
  months.forEach((s) => {
    const mon = +s.slice(5, 7);
    if ((mon - 1) % every !== 0) return;
    const px = x(s);
    if (px - lastX < 34 || px > W - m.r - 10) return;
    lastX = px;
    el("line", { x1: px, x2: px, y1: H - m.b, y2: H - m.b + 4, class: "tickmark" }, xg);
    const tx = el("text", { x: px, y: H - 6, "text-anchor": "middle", class: "tick" }, xg);
    tx.textContent = mon === 1 ? YEAR(s) : MONTH(s);
  });
  el("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: "baseline" }, svg);

  // 기준선
  if (o.ref && o.ref.value != null) {
    el("line", { x1: m.l, x2: W - m.r, y1: y(o.ref.value), y2: y(o.ref.value), class: "refline" }, svg);
    const rt = el("text", { x: W - m.r, y: y(o.ref.value) - 5, "text-anchor": "end", class: "reflabel" }, svg);
    rt.textContent = o.ref.label;
  }

  // 선
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const line = el("path", { d, class: "series-line", fill: "none" }, svg);
  line.style.stroke = o.color;
  if (o.dots || pts.length < 30) {
    for (const p of pts) {
      const c = el("circle", { cx: x(p[0]), cy: y(p[1]), r: 4, class: "dot" }, svg);
      c.style.fill = o.color;
    }
  }

  // 마지막 값 직접 표시
  const last = pts[pts.length - 1];
  const lx = x(last[0]);
  const ly = y(last[1]);
  const endDot = el("circle", { cx: lx, cy: ly, r: 4, class: "dot" }, svg);
  endDot.style.fill = o.color;

  // 십자선 + 툴팁
  const cross = el("line", { y1: m.t, y2: H - m.b, class: "crosshair", visibility: "hidden" }, svg);
  const focus = el("circle", { r: 5, class: "dot focus", visibility: "hidden" }, svg);
  focus.style.fill = o.color;
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  const tv = document.createElement("strong");
  const tl = document.createElement("span");
  const te = document.createElement("span");
  te.className = "tip-extra";
  tip.append(tv, tl, te);
  host.appendChild(tip);

  const xs = pts.map((p) => x(p[0]));
  let cur = -1;
  function show(i) {
    cur = Math.max(0, Math.min(pts.length - 1, i));
    const [ds, v] = pts[cur];
    const px = xs[cur];
    cross.setAttribute("x1", px);
    cross.setAttribute("x2", px);
    cross.setAttribute("visibility", "visible");
    focus.setAttribute("cx", px);
    focus.setAttribute("cy", y(v));
    focus.setAttribute("visibility", "visible");
    tv.textContent = o.format(v);
    tl.textContent = `${ds.replaceAll("-", ".")} · ${o.label}`;
    const extra = o.tipExtra ? o.tipExtra(cur) : "";
    te.textContent = extra || "";
    te.hidden = !extra;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(px - tw / 2, 0), W - tw)}px`;
    tip.style.top = `${Math.max(0, y(v) - tip.offsetHeight - 12)}px`;
  }
  function hide() {
    cur = -1;
    cross.setAttribute("visibility", "hidden");
    focus.setAttribute("visibility", "hidden");
    tip.hidden = true;
  }
  function nearest(clientX) {
    const r = svg.getBoundingClientRect();
    const px = clientX - r.left;
    let a = 0;
    let b = xs.length - 1;
    while (b - a > 1) {
      const mid = (a + b) >> 1;
      if (xs[mid] < px) a = mid;
      else b = mid;
    }
    return Math.abs(xs[a] - px) <= Math.abs(xs[b] - px) ? a : b;
  }
  const hit = el("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent", tabindex: 0, class: "hit",
    "aria-label": `${o.label}. 좌우 화살표로 날짜 이동` }, svg);
  hit.addEventListener("pointermove", (e) => show(nearest(e.clientX)));
  hit.addEventListener("pointerdown", (e) => show(nearest(e.clientX)));
  hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
  hit.addEventListener("focus", () => show(cur < 0 ? pts.length - 1 : cur));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { show(cur - 1); e.preventDefault(); }
    if (e.key === "ArrowRight") { show(cur + 1); e.preventDefault(); }
    if (e.key === "Escape") hide();
  });
}

/** 크기가 바뀌면 다시 그린다. */
export function responsive(host, render) {
  let w = 0;
  const ro = new ResizeObserver(() => {
    if (Math.abs(host.clientWidth - w) > 4) {
      w = host.clientWidth;
      render();
    }
  });
  ro.observe(host);
  return ro;
}
