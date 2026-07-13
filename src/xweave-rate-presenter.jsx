import React, { useState, useMemo, useCallback, useRef } from "react";
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import Papa from "papaparse";

/* ── tokens ────────────────────────────────────────────────── */
const T = {
  bg: "#FBFBFA",
  panel: "#FFFFFF",
  ink: "#151A21",
  soft: "#66707C",
  line: "#E6E8E6",
  xweave: "#1F4E9C",
  market: "#9AA4B0",
  proj: "#1F4E9C",
  bandFill: "rgba(31,78,156,0.08)",
  good: "#0E8A6D",
  mono: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
  sans: "'Inter', -apple-system, system-ui, sans-serif",
};

/* ── helpers ───────────────────────────────────────────────── */
const parseDate = (s) => {
  const d = new Date(String(s).replace(/,(\s\d{2}:\d{2})/, "$1"));
  return isNaN(d) ? null : d;
};
const fmtDay = (ts) =>
  new Date(ts).toLocaleDateString("en-SG", { month: "short", day: "numeric" });
const fmtDayTime = (ts) => {
  const d = new Date(ts);
  return fmtDay(ts) + " " + d.toTimeString().slice(0, 5);
};
const fmtRate = (v) => (v == null || isNaN(v) ? "—" : Number(v).toFixed(5));

function linreg(points) {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  let ss = 0;
  for (const p of points) { const r = p.y - (slope * p.x + intercept); ss += r * r; }
  return { slope, intercept, sd: Math.sqrt(ss / Math.max(1, n - 2)) };
}

const PAIR_LABEL = (raw) =>
  raw
    .replace("USDCETH", "USDC (Ethereum)")
    .replace("USDCMATIC", "USDC (Polygon)")
    .replace("USDCSOL", "USDC (Solana)")
    .replace("USDTETH", "USDT (Ethereum)")
    .replace("USDTSOL", "USDT (Solana)");

/* ── component ─────────────────────────────────────────────── */
export default function XweaveRatePresenter() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [pair, setPair] = useState("");
  const [projDays, setProjDays] = useState(14);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  const ingest = useCallback((file) => {
    setError("");
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      let recs = null;
      try {
        if (file.name.toLowerCase().endsWith(".json") || text.trim().startsWith("[")) {
          recs = JSON.parse(text);
        } else {
          recs = Papa.parse(text, { header: true, skipEmptyLines: true }).data;
        }
      } catch {
        setError("Couldn't read that file — export the query as JSON or CSV.");
        return;
      }
      if (!Array.isArray(recs) || !recs.length) { setError("No rows found in the file."); return; }
      const km = {};
      for (const k of Object.keys(recs[0])) {
        const lk = k.toLowerCase();
        if (lk.includes("date") || lk.includes("time")) km.date = k;
        else if (lk.includes("send")) km.send = k;
        else if (lk.includes("receive")) km.recv = k;
        else if (lk.includes("xweave")) km.xw = k;
        else if (lk.includes("market")) km.mkt = k;
      }
      if (!km.date || !km.xw || !km.mkt) {
        setError("Expected Date, Send Currency, Receive Currency, Xweave Rate and Market Rate columns.");
        return;
      }
      const clean = [];
      for (const r of recs) {
        const d = parseDate(r[km.date]);
        const xw = parseFloat(r[km.xw]);
        const mkt = parseFloat(r[km.mkt]);
        if (!d || isNaN(xw) || isNaN(mkt) || mkt === 0) continue;
        clean.push({ t: d.getTime(), pair: `${r[km.send] ?? "?"} → ${r[km.recv] ?? "?"}`, xw, mkt });
      }
      if (!clean.length) { setError("No valid rows after cleaning."); return; }
      clean.sort((a, b) => a.t - b.t);
      setRows(clean);
      setPair([...new Set(clean.map((r) => r.pair))][0]);
    };
    reader.readAsText(file);
  }, []);

  const pairs = useMemo(() => (rows ? [...new Set(rows.map((r) => r.pair))] : []), [rows]);

  /* daily buckets — calmer for a client audience */
  const series = useMemo(() => {
    if (!rows || !pair) return [];
    const ms = 86400e3;
    const buckets = new Map();
    for (const r of rows) {
      if (r.pair !== pair) continue;
      const key = Math.floor(r.t / ms) * ms;
      let b = buckets.get(key);
      if (!b) { b = { t: key, xwSum: 0, mktSum: 0, n: 0 }; buckets.set(key, b); }
      b.xwSum += r.xw; b.mktSum += r.mkt; b.n += 1;
    }
    return [...buckets.values()].sort((a, b) => a.t - b.t).map((b) => {
      const xw = b.xwSum / b.n, mkt = b.mktSum / b.n;
      return { t: b.t, xw, mkt, bps: ((mkt - xw) / mkt) * 1e4, n: b.n };
    });
  }, [rows, pair]);

  const proj = useMemo(() => {
    if (series.length < 7) return { chart: series, has: false };
    const dayMs = 86400e3;
    const t0 = series[0].t;
    const cut = series[Math.floor(series.length * 0.4)].t;
    const fit = series.filter((p) => p.t >= cut);
    const regM = linreg(fit.map((p) => ({ x: (p.t - t0) / dayMs, y: p.mkt })));
    const regX = linreg(fit.map((p) => ({ x: (p.t - t0) / dayMs, y: p.xw })));
    if (!regM || !regX) return { chart: series, has: false };
    const lastT = series[series.length - 1].t;
    const chart = series.map((p) => ({ ...p }));
    for (let t = lastT + dayMs; t <= lastT + projDays * dayMs; t += dayMs) {
      const x = (t - t0) / dayMs;
      const mHat = regM.slope * x + regM.intercept;
      const xHat = regX.slope * x + regX.intercept;
      chart.push({
        t,
        trendMkt: mHat,
        trendXw: xHat,
        band: [xHat - 1.96 * regX.sd, xHat + 1.96 * regX.sd],
      });
    }
    const bridge = chart.find((p) => p.t === lastT);
    if (bridge) {
      bridge.trendMkt = bridge.mkt;
      bridge.trendXw = bridge.xw;
      bridge.band = [bridge.xw, bridge.xw];
    }
    return { chart, has: true, lastT };
  }, [series, projDays]);

  const stats = useMemo(() => {
    if (!series.length) return null;
    const bps = series.map((s) => s.bps);
    const avg = bps.reduce((a, b) => a + b, 0) / bps.length;
    const sorted = [...bps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
      avg, median,
      last: bps[bps.length - 1],
      from: series[0].t, to: series[series.length - 1].t,
      days: series.length,
      quotes: series.reduce((a, b) => a + b.n, 0),
    };
  }, [series]);

  /* ── styles ── */
  const S = {
    app: { minHeight: "100vh", background: T.bg, color: T.ink, fontFamily: T.sans, paddingBottom: 56 },
    shell: { maxWidth: 1060, margin: "0 auto", padding: "0 24px" },
    topbar: { display: "flex", alignItems: "center", gap: 12, padding: "26px 0 8px" },
    brand: { fontSize: 15, fontWeight: 650, letterSpacing: "0.02em" },
    brandSub: { fontSize: 12.5, color: T.soft },
    hero: { padding: "34px 0 8px" },
    heroBig: { fontSize: 42, fontWeight: 650, letterSpacing: "-0.02em", lineHeight: 1.1, margin: 0 },
    heroBps: { fontFamily: T.mono, color: T.xweave },
    heroSub: { fontSize: 15, color: T.soft, marginTop: 10, maxWidth: 620, lineHeight: 1.55 },
    chips: { display: "flex", gap: 8, flexWrap: "wrap", margin: "22px 0 14px" },
    chip: (a) => ({
      padding: "8px 14px", fontSize: 13, borderRadius: 8, cursor: "pointer",
      fontFamily: T.sans, fontWeight: 500,
      border: `1px solid ${a ? T.xweave : T.line}`,
      background: a ? T.xweave : T.panel, color: a ? "#fff" : T.ink,
    }),
    panel: { background: T.panel, border: `1px solid ${T.line}`, borderRadius: 12, padding: 20 },
    row: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10, margin: "16px 0" },
    kpi: { background: T.panel, border: `1px solid ${T.line}`, borderRadius: 12, padding: "14px 16px" },
    kL: { fontSize: 11.5, color: T.soft, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 },
    kV: { fontSize: 21, fontFamily: T.mono, fontWeight: 600 },
    disclaimer: {
      fontSize: 12, color: T.soft, lineHeight: 1.6, marginTop: 14,
      borderTop: `1px solid ${T.line}`, paddingTop: 12,
    },
    drop: {
      border: `2px dashed ${drag ? T.xweave : T.line}`, borderRadius: 14,
      padding: "90px 24px", textAlign: "center", cursor: "pointer",
      background: drag ? "rgba(31,78,156,0.03)" : T.panel, transition: "all .15s",
      marginTop: 28,
    },
    err: { color: "#B4432E", fontSize: 13, marginTop: 12 },
    secT: { fontSize: 13.5, fontWeight: 650, margin: "24px 0 10px" },
  };

  const tt = {
    background: "#fff", border: `1px solid ${T.line}`, borderRadius: 8,
    padding: "9px 11px", fontSize: 12.5, fontFamily: T.mono,
    boxShadow: "0 4px 16px rgba(0,0,0,0.07)",
  };

  const RateTip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const p = payload.reduce((a, e) => ({ ...a, [e.dataKey]: e.value }), {});
    return (
      <div style={tt}>
        <div style={{ color: T.soft, marginBottom: 4 }}>{fmtDayTime(label)}</div>
        {p.xw != null && <div style={{ color: T.xweave, fontWeight: 600 }}>Xweave&nbsp;&nbsp;{fmtRate(p.xw)}</div>}
        {p.mkt != null && <div style={{ color: T.soft }}>Mid-market&nbsp;&nbsp;{fmtRate(p.mkt)}</div>}
        {p.trendXw != null && p.xw == null && (
          <div style={{ color: T.xweave }}>Indicative trend&nbsp;&nbsp;{fmtRate(p.trendXw)}</div>
        )}
      </div>
    );
  };

  /* ── landing ── */
  if (!rows) {
    return (
      <div style={S.app}>
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;650&display=swap" rel="stylesheet" />
        <div style={S.shell}>
          <div style={S.topbar}>
            <span style={S.brand}>XWEAVE</span>
            <span style={S.brandSub}>Rate performance</span>
          </div>
          <div style={S.hero}>
            <h1 style={S.heroBig}>How our executed rates<br />track the market.</h1>
            <div style={S.heroSub}>
              Load a rate export to see executed pricing against the mid-market
              benchmark over the period, and the indicative trend ahead.
            </div>
          </div>
          <div
            style={S.drop}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); e.dataTransfer.files?.[0] && ingest(e.dataTransfer.files[0]); }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Drop the rate export here</div>
            <div style={{ fontSize: 13, color: T.soft }}>JSON or CSV · nothing leaves this browser</div>
            <input ref={inputRef} type="file" accept=".json,.csv" style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && ingest(e.target.files[0])} />
          </div>
          {error && <div style={S.err}>{error}</div>}
        </div>
      </div>
    );
  }

  /* ── presentation view ── */
  return (
    <div style={S.app}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;650&display=swap" rel="stylesheet" />
      <div style={S.shell}>
        <div style={S.topbar}>
          <span style={S.brand}>XWEAVE</span>
          <span style={S.brandSub}>Rate performance · {fmtDay(stats.from)} – {fmtDay(stats.to)}</span>
          <button
            style={{ ...S.chip(false), marginLeft: "auto", fontSize: 12 }}
            onClick={() => { setRows(null); setError(""); }}
          >
            Load another file
          </button>
        </div>

        {/* headline */}
        <div style={S.hero}>
          <h1 style={S.heroBig}>
            Within <span style={S.heroBps}>{Math.abs(stats.avg).toFixed(0)} bps</span> of mid-market,
            <br />on average, across {stats.days} days.
          </h1>
          <div style={S.heroSub}>
            {PAIR_LABEL(pair)} · {stats.quotes.toLocaleString()} executed quotes ·
            median distance {Math.abs(stats.median).toFixed(0)} bps · most recent day {Math.abs(stats.last).toFixed(0)} bps
          </div>
        </div>

        {/* pair + projection controls */}
        <div style={S.chips}>
          {pairs.map((p) => (
            <button key={p} style={S.chip(p === pair)} onClick={() => setPair(p)}>{PAIR_LABEL(p)}</button>
          ))}
          <span style={{ flex: 1 }} />
          {[7, 14, 30].map((d) => (
            <button key={d} style={S.chip(projDays === d)} onClick={() => setProjDays(d)}>+{d} days</button>
          ))}
        </div>

        {/* chart */}
        <div style={S.panel}>
          <ResponsiveContainer width="100%" height={400}>
            <ComposedChart data={proj.chart} margin={{ top: 10, right: 10, bottom: 0, left: 10 }}>
              <CartesianGrid stroke={T.line} strokeDasharray="2 5" vertical={false} />
              <XAxis
                dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]}
                tickFormatter={fmtDay} tick={{ fontSize: 12, fontFamily: T.mono, fill: T.soft }}
                axisLine={{ stroke: T.line }} tickLine={false} minTickGap={70}
              />
              <YAxis
                domain={["auto", "auto"]} tickFormatter={(v) => v.toFixed(4)}
                tick={{ fontSize: 12, fontFamily: T.mono, fill: T.soft }}
                axisLine={false} tickLine={false} width={76}
              />
              <Tooltip content={<RateTip />} />
              <Area dataKey="band" stroke="none" fill={T.bandFill} connectNulls legendType="none" />
              <Line dataKey="mkt" name="Mid-market" stroke={T.market} dot={false} strokeWidth={1.7} connectNulls />
              <Line dataKey="xw" name="Xweave executed" stroke={T.xweave} dot={false} strokeWidth={2.2} connectNulls />
              <Line dataKey="trendMkt" stroke={T.market} dot={false} strokeWidth={1.4} strokeDasharray="6 5" connectNulls />
              <Line dataKey="trendXw" stroke={T.xweave} dot={false} strokeWidth={1.6} strokeDasharray="6 5" connectNulls />
              {proj.has && (
                <ReferenceLine
                  x={proj.lastT} stroke={T.soft} strokeDasharray="3 3"
                  label={{ value: "today", position: "insideTopRight", fontSize: 12, fontFamily: T.mono, fill: T.soft }}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>

          {/* legend, hand-rolled for control */}
          <div style={{ display: "flex", gap: 22, fontSize: 12.5, fontFamily: T.mono, color: T.soft, padding: "6px 4px 0" }}>
            <span><span style={{ display: "inline-block", width: 18, height: 3, background: T.xweave, verticalAlign: "middle", marginRight: 7 }} />Xweave executed rate</span>
            <span><span style={{ display: "inline-block", width: 18, height: 3, background: T.market, verticalAlign: "middle", marginRight: 7 }} />Mid-market benchmark</span>
            <span><span style={{ display: "inline-block", width: 18, height: 0, borderTop: `2px dashed ${T.xweave}`, verticalAlign: "middle", marginRight: 7 }} />Indicative trend</span>
          </div>

          <div style={S.disclaimer}>
            Indicative trend only — a statistical extension of the recent period, not a quoted,
            offered, or guaranteed rate. Executed rates depend on market conditions, size and
            timing at execution. Mid-market benchmark as captured at quote time.
          </div>
        </div>

        {/* supporting stats */}
        <div style={S.row}>
          <div style={S.kpi}>
            <div style={S.kL}>Average distance from mid</div>
            <div style={S.kV}>{Math.abs(stats.avg).toFixed(1)} bps</div>
          </div>
          <div style={S.kpi}>
            <div style={S.kL}>Median</div>
            <div style={S.kV}>{Math.abs(stats.median).toFixed(1)} bps</div>
          </div>
          <div style={S.kpi}>
            <div style={S.kL}>Most recent day</div>
            <div style={{ ...S.kV, color: Math.abs(stats.last) <= Math.abs(stats.avg) ? T.good : T.ink }}>
              {Math.abs(stats.last).toFixed(1)} bps
            </div>
          </div>
          <div style={S.kpi}>
            <div style={S.kL}>Executed quotes</div>
            <div style={S.kV}>{stats.quotes.toLocaleString()}</div>
          </div>
        </div>

        <div style={{ fontSize: 12, color: T.soft }}>
          Tip: use the browser's print / save-as-PDF for a snapshot of this view.
        </div>
      </div>
    </div>
  );
}
