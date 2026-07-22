import React, { useState, useMemo, useCallback, useRef } from "react";
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import Papa from "papaparse";

/* ── tokens ─────────────────────────────────────────────────── */
const T = {
  bg: "#F5F6F8",
  panel: "#FFFFFF",
  ink: "#141A21",
  soft: "#636E7B",
  line: "#E4E7EB",
  xweave: "#1F4E9C",
  market: "#98A2B0",
  band: "rgba(31,78,156,0.08)",
  warn: "#B4642E",
  mono: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
  sans: "'Inter', -apple-system, system-ui, sans-serif",
};

// distinct colours for the provider comparison chart
const PROV_COLORS = ["#1F4E9C", "#0E8A6D", "#B4642E", "#8B5CB8", "#C0392B", "#2C7BB6"];

const LOW_SAMPLE = 500; // quotes below this → flag as thin data

/* ── helpers ────────────────────────────────────────────────── */
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
const fmtBps = (v) => (v == null || isNaN(v) ? "—" : `${v.toFixed(1)} bps`);

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

/* build a daily rate+bps series from an array of {t,xw,mkt} rows */
function dailySeries(rows) {
  const ms = 86400e3;
  const buckets = new Map();
  for (const r of rows) {
    const key = Math.floor(r.t / ms) * ms;
    let b = buckets.get(key);
    if (!b) { b = { t: key, xwSum: 0, mktSum: 0, n: 0 }; buckets.set(key, b); }
    b.xwSum += r.xw; b.mktSum += r.mkt; b.n += 1;
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t).map((b) => {
    const xw = b.xwSum / b.n, mkt = b.mktSum / b.n;
    return { t: b.t, xw, mkt, bps: ((mkt - xw) / mkt) * 1e4, n: b.n };
  });
}

/* attach a linear projection to a daily series */
function withProjection(series, projDays) {
  if (series.length < 7) return { chart: series, lastT: series.length ? series[series.length - 1].t : null };
  const dayMs = 86400e3;
  const t0 = series[0].t;
  const cut = series[Math.floor(series.length * 0.4)].t;
  const fit = series.filter((p) => p.t >= cut);
  const regM = linreg(fit.map((p) => ({ x: (p.t - t0) / dayMs, y: p.mkt })));
  const regX = linreg(fit.map((p) => ({ x: (p.t - t0) / dayMs, y: p.xw })));
  if (!regM || !regX) return { chart: series, lastT: series[series.length - 1].t };
  const lastT = series[series.length - 1].t;
  const chart = series.map((p) => ({ ...p }));
  for (let t = lastT + dayMs; t <= lastT + projDays * dayMs; t += dayMs) {
    const x = (t - t0) / dayMs;
    const xHat = regX.slope * x + regX.intercept;
    chart.push({ t, trendMkt: regM.slope * x + regM.intercept, trendXw: xHat, band: [xHat - 1.96 * regX.sd, xHat + 1.96 * regX.sd] });
  }
  const bridge = chart.find((p) => p.t === lastT);
  if (bridge) { bridge.trendMkt = bridge.mkt; bridge.trendXw = bridge.xw; bridge.band = [bridge.xw, bridge.xw]; }
  return { chart, lastT };
}

function statsFor(series) {
  if (!series.length) return null;
  const bps = series.map((s) => s.bps);
  const avg = bps.reduce((a, b) => a + b, 0) / bps.length;
  const sorted = [...bps].sort((a, b) => a - b);
  return {
    avg, median: sorted[Math.floor(sorted.length / 2)],
    last: bps[bps.length - 1],
    quotes: series.reduce((a, b) => a + b.n, 0),
    days: series.length,
  };
}

/* ── component ──────────────────────────────────────────────── */
export default function FXProviderAnalysis() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
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
        if (file.name.toLowerCase().endsWith(".json") || text.trim().startsWith("[")) recs = JSON.parse(text);
        else recs = Papa.parse(text, { header: true, skipEmptyLines: true }).data;
      } catch { setError("Couldn't read that file — export as JSON or CSV."); return; }
      if (!Array.isArray(recs) || !recs.length) { setError("No rows found."); return; }

      const km = {};
      for (const k of Object.keys(recs[0])) {
        const lk = k.trim().toLowerCase();
        if (lk === "date" || lk.includes("time")) km.date = k;
        else if (lk === "provider") km.prov = k;
        else if (lk.includes("xweave")) km.xw = k;
        else if (lk.includes("market")) km.mkt = k;
        else if (lk.includes("receive currency") || lk.includes("recvcurrency")) km.recv = k;
      }
      if (!km.date || !km.xw || !km.mkt) { setError("Expected at least Date, Xweave Rate and Market Rate columns."); return; }

      const clean = [];
      for (const r of recs) {
        const d = parseDate(r[km.date]);
        const xw = parseFloat(r[km.xw]);
        const mkt = parseFloat(r[km.mkt]);
        if (!d || isNaN(xw) || isNaN(mkt) || mkt === 0) continue;
        clean.push({
          t: d.getTime(), xw, mkt,
          prov: km.prov ? (r[km.prov] || "Unknown") : "All",
          recv: km.recv ? r[km.recv] : "",
        });
      }
      if (!clean.length) { setError("No valid rows after cleaning."); return; }
      clean.sort((a, b) => a.t - b.t);
      setRows(clean);
    };
    reader.readAsText(file);
  }, []);

  /* combined (all providers) */
  const combined = useMemo(() => {
    if (!rows) return null;
    const s = dailySeries(rows);
    return { series: s, ...withProjection(s, projDays), stats: statsFor(s) };
  }, [rows, projDays]);

  /* per provider */
  const providers = useMemo(() => {
    if (!rows) return [];
    const byProv = new Map();
    for (const r of rows) {
      if (!byProv.has(r.prov)) byProv.set(r.prov, []);
      byProv.get(r.prov).push(r);
    }
    return [...byProv.entries()]
      .map(([name, rs]) => {
        const s = dailySeries(rs);
        return { name, series: s, ...withProjection(s, projDays), stats: statsFor(s) };
      })
      .sort((a, b) => (b.stats?.quotes || 0) - (a.stats?.quotes || 0));
  }, [rows, projDays]);

  /* normalised: one row per day, a bps column per provider */
  const normalised = useMemo(() => {
    if (!providers.length) return { data: [], names: [] };
    const names = providers.map((p) => p.name);
    const dayMap = new Map();
    for (const p of providers) {
      for (const pt of p.series) {
        let row = dayMap.get(pt.t);
        if (!row) { row = { t: pt.t }; dayMap.set(pt.t, row); }
        row[p.name] = pt.bps;
      }
    }
    return { data: [...dayMap.values()].sort((a, b) => a.t - b.t), names };
  }, [providers]);

  /* ── styles ── */
  const S = {
    app: { minHeight: "100vh", background: T.bg, color: T.ink, fontFamily: T.sans, paddingBottom: 64 },
    shell: { maxWidth: 1100, margin: "0 auto", padding: "0 24px" },
    top: { display: "flex", alignItems: "baseline", gap: 12, padding: "26px 0 6px", flexWrap: "wrap" },
    h1: { fontSize: 20, fontWeight: 650, letterSpacing: "-0.01em", margin: 0 },
    sub: { fontSize: 13, color: T.soft, fontFamily: T.mono },
    chips: { display: "flex", gap: 8, margin: "14px 0", alignItems: "center", flexWrap: "wrap" },
    chip: (a) => ({
      padding: "6px 13px", fontSize: 12.5, borderRadius: 7, cursor: "pointer", fontFamily: T.mono,
      border: `1px solid ${a ? T.ink : T.line}`, background: a ? T.ink : T.panel, color: a ? "#fff" : T.ink,
    }),
    panel: { background: T.panel, border: `1px solid ${T.line}`, borderRadius: 12, padding: 20, marginBottom: 16 },
    secLabel: { fontSize: 12, fontWeight: 650, letterSpacing: "0.08em", textTransform: "uppercase", color: T.soft, margin: "26px 0 10px" },
    chartTitle: { fontSize: 15, fontWeight: 600, marginBottom: 2 },
    chartSub: { fontSize: 12.5, color: T.soft, fontFamily: T.mono, marginBottom: 12 },
    kpis: { display: "flex", gap: 22, flexWrap: "wrap", marginTop: 4 },
    kpi: { minWidth: 90 },
    kL: { fontSize: 10.5, color: T.soft, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 },
    kV: { fontSize: 17, fontFamily: T.mono, fontWeight: 600 },
    drop: {
      border: `2px dashed ${drag ? T.xweave : T.line}`, borderRadius: 14, padding: "84px 24px",
      textAlign: "center", cursor: "pointer", background: drag ? "rgba(31,78,156,0.03)" : T.panel, marginTop: 26,
    },
    err: { color: "#B4432E", fontSize: 13, marginTop: 12 },
    warnPill: { display: "inline-block", fontSize: 11, fontFamily: T.mono, color: T.warn, border: `1px solid ${T.warn}`, borderRadius: 5, padding: "1px 6px", marginLeft: 8 },
    explain: {
      background: "#EEF2F9", borderLeft: `4px solid ${T.xweave}`, borderRadius: 8,
      padding: "14px 16px", fontSize: 13, lineHeight: 1.6, color: "#25313f", marginBottom: 18,
    },
  };
  const tt = { background: "#fff", border: `1px solid ${T.line}`, borderRadius: 8, padding: "8px 10px", fontSize: 12, fontFamily: T.mono, boxShadow: "0 4px 14px rgba(0,0,0,0.06)" };

  const RateTip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const p = payload.reduce((a, e) => ({ ...a, [e.dataKey]: e.value }), {});
    return (
      <div style={tt}>
        <div style={{ color: T.soft, marginBottom: 4 }}>{fmtDayTime(label)}</div>
        {p.xw != null && <div style={{ color: T.xweave, fontWeight: 600 }}>Xweave {fmtRate(p.xw)}</div>}
        {p.mkt != null && <div style={{ color: T.soft }}>Mid-market {fmtRate(p.mkt)}</div>}
        {p.trendXw != null && p.xw == null && <div style={{ color: T.xweave }}>Xweave (proj) {fmtRate(p.trendXw)}</div>}
      </div>
    );
  };
  const BpsTip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={tt}>
        <div style={{ color: T.soft, marginBottom: 4 }}>{fmtDayTime(label)}</div>
        {payload.filter(e => e.value != null).map((e) => (
          <div key={e.dataKey} style={{ color: e.color }}>{e.dataKey} {fmtBps(e.value)}</div>
        ))}
      </div>
    );
  };

  /* one rate chart (used for combined + each provider) */
  const RateChart = ({ block, height = 300 }) => (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={block.chart} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={T.line} strokeDasharray="2 5" vertical={false} />
        <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]}
          tickFormatter={fmtDay} tick={{ fontSize: 11, fontFamily: T.mono, fill: T.soft }}
          axisLine={{ stroke: T.line }} tickLine={false} minTickGap={60} />
        <YAxis domain={["auto", "auto"]} tickFormatter={(v) => v.toFixed(4)}
          tick={{ fontSize: 11, fontFamily: T.mono, fill: T.soft }} axisLine={false} tickLine={false} width={72} />
        <Tooltip content={<RateTip />} />
        <Area dataKey="band" stroke="none" fill={T.band} connectNulls legendType="none" />
        <Line dataKey="mkt" stroke={T.market} dot={false} strokeWidth={1.6} connectNulls />
        <Line dataKey="xw" stroke={T.xweave} dot={false} strokeWidth={2} connectNulls />
        <Line dataKey="trendMkt" stroke={T.market} dot={false} strokeWidth={1.3} strokeDasharray="5 4" connectNulls />
        <Line dataKey="trendXw" stroke={T.xweave} dot={false} strokeWidth={1.5} strokeDasharray="5 4" connectNulls />
        {block.lastT && <ReferenceLine x={block.lastT} stroke={T.soft} strokeDasharray="3 3" />}
      </ComposedChart>
    </ResponsiveContainer>
  );

  const Kpis = ({ st }) => st && (
    <div style={S.kpis}>
      <div style={S.kpi}><div style={S.kL}>Avg spread</div><div style={S.kV}>{fmtBps(st.avg)}</div></div>
      <div style={S.kpi}><div style={S.kL}>Median</div><div style={S.kV}>{fmtBps(st.median)}</div></div>
      <div style={S.kpi}><div style={S.kL}>Latest day</div><div style={S.kV}>{fmtBps(st.last)}</div></div>
      <div style={S.kpi}><div style={S.kL}>Quotes</div><div style={S.kV}>{st.quotes.toLocaleString()}</div></div>
      <div style={S.kpi}><div style={S.kL}>Days</div><div style={S.kV}>{st.days}</div></div>
    </div>
  );

  const legend = (
    <div style={{ display: "flex", gap: 20, fontSize: 12, fontFamily: T.mono, color: T.soft, padding: "8px 2px 0" }}>
      <span><span style={{ display: "inline-block", width: 16, height: 3, background: T.xweave, verticalAlign: "middle", marginRight: 6 }} />Xweave executed</span>
      <span><span style={{ display: "inline-block", width: 16, height: 3, background: T.market, verticalAlign: "middle", marginRight: 6 }} />Mid-market</span>
      <span><span style={{ display: "inline-block", width: 16, borderTop: `2px dashed ${T.xweave}`, verticalAlign: "middle", marginRight: 6 }} />Projected</span>
    </div>
  );

  /* ── landing ── */
  if (!rows) {
    return (
      <div style={S.app}>
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;650&display=swap" rel="stylesheet" />
        <div style={S.shell}>
          <div style={S.top}><h1 style={S.h1}>FX Rate Analysis — by provider</h1><span style={S.sub}>internal</span></div>
          <div style={S.drop}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); e.dataTransfer.files?.[0] && ingest(e.dataTransfer.files[0]); }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Drop the rate export here</div>
            <div style={{ fontSize: 13, color: T.soft }}>JSON or CSV with Date, Provider, Xweave Rate, Market Rate</div>
            <input ref={inputRef} type="file" accept=".json,.csv" style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && ingest(e.target.files[0])} />
          </div>
          {error && <div style={S.err}>{error}</div>}
        </div>
      </div>
    );
  }

  /* ── loaded ── */
  return (
    <div style={S.app}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;650&display=swap" rel="stylesheet" />
      <div style={S.shell}>
        <div style={S.top}>
          <h1 style={S.h1}>FX Rate Analysis — by provider</h1>
          <span style={S.sub}>SGD → USDC · internal</span>
          <button style={{ ...S.chip(false), marginLeft: "auto" }} onClick={() => { setRows(null); setError(""); }}>Load another file</button>
        </div>

        <div style={S.chips}>
          <span style={{ fontSize: 12.5, color: T.soft, fontFamily: T.mono, marginRight: 4 }}>Projection</span>
          {[7, 14, 30].map((d) => (
            <button key={d} style={S.chip(projDays === d)} onClick={() => setProjDays(d)}>+{d}d</button>
          ))}
        </div>

        {/* combined */}
        <div style={S.secLabel}>Combined — all providers</div>
        <div style={S.panel}>
          <div style={S.chartTitle}>Executed rate vs mid-market</div>
          <div style={S.chartSub}>all providers blended · {combined.stats.quotes.toLocaleString()} quotes over {combined.stats.days} days</div>
          <RateChart block={combined} height={320} />
          {legend}
          <div style={{ marginTop: 14 }}><Kpis st={combined.stats} /></div>
        </div>

        {/* normalised bps comparison */}
        <div style={S.secLabel}>Normalised — spread comparison (bps)</div>
        <div style={S.panel}>
          <div style={S.chartTitle}>Daily spread by provider, like-for-like</div>
          <div style={S.chartSub}>lower is tighter to mid-market · same bps scale removes the rate-level difference between pairs</div>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={normalised.data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid stroke={T.line} strokeDasharray="2 5" vertical={false} />
              <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]}
                tickFormatter={fmtDay} tick={{ fontSize: 11, fontFamily: T.mono, fill: T.soft }}
                axisLine={{ stroke: T.line }} tickLine={false} minTickGap={60} />
              <YAxis tickFormatter={(v) => v.toFixed(0)} tick={{ fontSize: 11, fontFamily: T.mono, fill: T.soft }}
                axisLine={false} tickLine={false} width={56} label={{ value: "bps", angle: -90, position: "insideLeft", fontSize: 11, fill: T.soft }} />
              <Tooltip content={<BpsTip />} />
              <Legend wrapperStyle={{ fontSize: 12, fontFamily: T.mono }} />
              {normalised.names.map((name, i) => (
                <Line key={name} dataKey={name} stroke={PROV_COLORS[i % PROV_COLORS.length]}
                  dot={false} strokeWidth={1.8} connectNulls />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* per provider */}
        <div style={S.secLabel}>Provider-specific</div>
        {providers.map((p) => {
          const thin = (p.stats?.quotes || 0) < LOW_SAMPLE;
          return (
            <div key={p.name} style={S.panel}>
              <div style={S.chartTitle}>
                {p.name}
                {thin && <span style={S.warnPill}>low sample — {p.stats.quotes} quotes, trend unreliable</span>}
              </div>
              <div style={S.chartSub}>executed rate vs mid-market · {p.stats.quotes.toLocaleString()} quotes over {p.stats.days} days</div>
              <RateChart block={p} height={260} />
              {legend}
              <div style={{ marginTop: 14 }}><Kpis st={p.stats} /></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
