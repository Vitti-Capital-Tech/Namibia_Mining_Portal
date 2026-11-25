// Printable HTML reports (desktop study per licence, shortlist summary). Self-contained: inline CSS + SVG.
import { esc, fmtKm, fmtDate, colorFor, STATUS_GROUP_COLORS, expiryPosition, rampColor } from "./util.js";
import { FACTOR_LABELS, MODE_FACTORS, GROUP_NAMES, ANY, licenceMinerals, nearbyDeposits } from "./scoring.js";
import { bbox } from "./geo.js";

const REPORT_CSS = `
  *{box-sizing:border-box} body{font:13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2328;margin:0;background:#f6f5f1}
  .page{max-width:880px;margin:24px auto;background:#fff;padding:36px 44px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  h1{font-size:24px;margin:0 0 4px} h2{font-size:15px;margin:26px 0 8px;padding-bottom:4px;border-bottom:2px solid #b5651d;color:#7a3f12}
  .sub{color:#646b73;margin:0 0 14px} table{width:100%;border-collapse:collapse;margin:6px 0}
  th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #eee;vertical-align:top} th{color:#646b73;font-weight:600;width:190px}
  table.grid th{width:auto;background:#f6f5f1} .num{text-align:right;font-variant-numeric:tabular-nums}
  .score{font-size:40px;font-weight:750;color:#b5651d;line-height:1} .score small{font-size:15px;color:#646b73}
  .bar{display:grid;grid-template-columns:150px 1fr 40px;gap:10px;align-items:center;margin:4px 0}
  .track{height:8px;background:#eee;border-radius:4px;overflow:hidden} .fill{height:100%;background:#b5651d}
  .pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid #ddd;margin:0 4px 4px 0}
  .note{background:#fff7e8;border:1px solid #e9c48a;border-radius:6px;padding:8px 12px;font-size:12px;margin:12px 0}
  .muted{color:#646b73} .map{border:1px solid #ddd;border-radius:6px;display:block;width:100%;height:auto;background:#fbfaf7}
  .toolbar{position:sticky;top:0;background:#1f2328;color:#fff;padding:8px 16px;display:flex;gap:10px;align-items:center;z-index:2}
  .toolbar button{font:inherit;padding:5px 12px;border-radius:6px;border:0;background:#e08a3c;color:#fff;cursor:pointer}
  footer{margin-top:28px;font-size:11px;color:#646b73;border-top:1px solid #eee;padding-top:10px}
  @media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:0}.toolbar{display:none} h2{break-after:avoid} table,.map{break-inside:avoid}}
`;

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${REPORT_CSS}</style></head><body>
<div class="toolbar"><b style="flex:1">${esc(title)}</b><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="page">${body}</div></body></html>`;
}

/** Open an HTML string in a new tab. */
export function openReport(html) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const w = window.open(url, "_blank");
  if (!w) alert("Please allow pop-ups to open the report.");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------- SVG map ----------
function makeProjector([minX, minY, maxX, maxY], width) {
  const kx = Math.cos(((minY + maxY) / 2) * (Math.PI / 180));
  const w = (maxX - minX) * kx, h = maxY - minY;
  const height = Math.round((width * h) / w);
  const p = ([x, y]) => [((x - minX) * kx * width) / w, ((maxY - y) * height) / h];
  return { p, width, height };
}
const pathOf = (rings, p) =>
  rings.map((r) => "M" + r.map((c) => p(c).map((v) => v.toFixed(1)).join(",")).join("L") + "Z").join("");
const polyRings = (g) =>
  g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];

function svgMap(ctx, extent, { highlight = [], deposits = [], width = 800, showAllLicences = false } = {}) {
  const { p, height } = makeProjector(extent, width);
  const parts = [];
  parts.push(`<rect width="${width}" height="${height}" fill="#eaf2f7"/>`);
  for (const f of ctx.boundary.features)
    parts.push(`<path d="${pathOf(polyRings(f.geometry), p)}" fill="#fbf7ef" stroke="#b5651d" stroke-width="1.5"/>`);
  for (const b of ctx.belts) {
    const c = colorFor(b.properties.commodities[0]);
    parts.push(`<path d="${pathOf(polyRings(b.geometry), p)}" fill="${c}" fill-opacity=".12" stroke="${c}" stroke-dasharray="4 3"/>`);
  }
  for (const a of ctx.protectedAreas)
    parts.push(`<path d="${pathOf(polyRings(a.geometry), p)}" fill="#2f8f5b" fill-opacity=".12" stroke="#2f8f5b" stroke-width=".8"/>`);
  if (showAllLicences) {
    const [ex0, ey0, ex1, ey1] = extent;
    for (const l of ctx.licences) {
      if (l.properties.statusGroup === "Inactive") continue;
      const [a, b, c, d] = bbox(l.geometry);
      if (c < ex0 || a > ex1 || d < ey0 || b > ey1) continue; // outside the map frame
      parts.push(`<path d="${pathOf(polyRings(l.geometry), p)}" fill="none" stroke="#9aa" stroke-width=".4"/>`);
    }
  }
  for (const r of ctx.rail)
    parts.push(`<path d="M${r.geometry.coordinates.map((c) => p(c).map((v) => v.toFixed(1)).join(",")).join("L")}" fill="none" stroke="#333" stroke-width="1.6" stroke-dasharray="6 4"/>`);
  for (const h of highlight)
    parts.push(`<path d="${pathOf(polyRings(h.geometry), p)}" fill="${h.fill || "#b5651d"}" fill-opacity=".45" stroke="${h.stroke || "#7a1f0c"}" stroke-width="2"/>`);
  for (const d of deposits) {
    const [x, y] = p(d.deposit.geometry.coordinates);
    parts.push(`<g><rect x="${x - 4}" y="${y - 4}" width="8" height="8" transform="rotate(45 ${x} ${y})" fill="${colorFor(d.deposit.commodities[0])}" stroke="#fff"/>
      <text x="${x + 8}" y="${y + 4}" font-size="10" fill="#333">${esc(d.deposit.name)}</text></g>`);
  }
  for (const t of [...ctx.towns, ...ctx.ports]) {
    const [x, y] = p(t.geometry.coordinates);
    if (x < 0 || y < 0 || x > width || y > height) continue;
    parts.push(`<circle cx="${x}" cy="${y}" r="3" fill="#fff" stroke="#222"/><text x="${x + 5}" y="${y - 4}" font-size="10" fill="#222" font-weight="600">${esc(t.properties.name)}</text>`);
  }
  for (const h of highlight.filter((h) => h.label)) {
    const [x, y] = p(h.properties.c);
    parts.push(`<text x="${x}" y="${y}" font-size="11" font-weight="700" text-anchor="middle" fill="#1f2328" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(h.label)}</text>`);
  }
  return `<svg class="map" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img">${parts.join("")}</svg>`;
}

function padExtent([minX, minY, maxX, maxY], padDeg, aspect = null) {
  let e = [minX - padDeg, minY - padDeg, maxX + padDeg, maxY + padDeg];
  if (!aspect) return e;
  // Grow the shorter side so width/height (in projected units) equals `aspect`.
  const kx = Math.cos((((e[1] + e[3]) / 2) * Math.PI) / 180);
  const w = (e[2] - e[0]) * kx, h = e[3] - e[1];
  if (w / h < aspect) { const dx = ((h * aspect) / kx - (e[2] - e[0])) / 2; e = [e[0] - dx, e[1], e[2] + dx, e[3]]; }
  else { const dy = (w / aspect - h) / 2; e = [e[0], e[1] - dy, e[2], e[3] + dy]; }
  return e;
}

function factorBars(factors, mode) {
  return MODE_FACTORS[mode]
    .filter((k) => k in factors)
    .map((k) => `<div class="bar"><span>${FACTOR_LABELS[k]}</span><div class="track"><div class="fill" style="width:${Math.round(factors[k] * 100)}%"></div></div><span class="num">${Math.round(factors[k] * 100)}</span></div>`)
    .join("");
}

// ---------- desktop study ----------
export function desktopStudyHTML(lic, result, ctx, { target, snapshot, weights, portfolio, sourceText = "MME Landfolio cadastre extract" }) {
  const p = lic.properties;
  const d = result.details;
  const mineralLabel = target === ANY ? "all minerals" : target;
  const deposits = nearbyDeposits(p.c, ctx, target, { limit: 8 });
  const exp = expiryPosition(p, snapshot);
  const holderInfo = portfolio.get(p.holder);
  const extent = padExtent(bbox(lic.geometry), 0.35, 1.6);
  const generated = new Date().toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" });

  const body = `
  <h1>${esc(p.code)} – Desktop Study</h1>
  <p class="sub">${esc(p.type)} · ${esc(p.holder || "Holder not recorded")} · scored for <b>${esc(mineralLabel)}</b></p>

  <h2>1. Executive summary</h2>
  <table>
    <tr><th>Screening score</th><td><span class="score">${Math.round(result.score)}<small> / 100</small></span></td></tr>
    <tr><th>Status (at ${fmtDate(snapshot)})</th><td>${esc(p.status)} (${esc(p.statusGroup)})</td></tr>
    <tr><th>Expiry position</th><td>${esc(exp.label)}</td></tr>
    <tr><th>Prospective minerals</th><td>${licenceMinerals(lic).map((m) => `<span class="pill">${esc(m)}</span>`).join("") || "—"}</td></tr>
    <tr><th>Key geology</th><td>${d.belts.length ? d.belts.map((b) => `${esc(b.name)} (${Math.round(b.share * 100)}% of licence)`).join("<br>") : "Outside mapped metallogenic belts"}</td></tr>
    <tr><th>Nearest relevant deposit</th><td>${deposits[0] ? `${esc(deposits[0].deposit.name)} – ${fmtKm(deposits[0].km)}` : "None recorded"}</td></tr>
  </table>

  <h2>2. Location</h2>
  ${svgMap(ctx, extent, { highlight: [{ ...lic, label: p.code }], deposits, showAllLicences: true })}
  <p class="muted" style="font-size:11px">Licence (orange), neighbouring active licences/applications (grey outline), mineral belts (dashed, schematic), rail (dashed black), protected areas (green), deposits (◆).</p>
  <table>
    <tr><th>Region</th><td>${esc(d.region || "—")}</td></tr>
    <tr><th>Map reference</th><td>${esc(p.mapRef.join(", ") || "—")}</td></tr>
    <tr><th>Centroid</th><td>${p.c[1].toFixed(4)}°, ${p.c[0].toFixed(4)}°</td></tr>
    <tr><th>Area</th><td>${p.areaKm2.toLocaleString()} km² (${Math.round(p.areaKm2 * 100).toLocaleString()} ha)</td></tr>
    <tr><th>Protected area</th><td>${esc(d.protectedArea || "None (screening layer)")}</td></tr>
  </table>

  <h2>3. Tenure &amp; holder</h2>
  <table>
    <tr><th>Licence number</th><td>${esc(p.code)}</td></tr>
    <tr><th>Holder</th><td>${esc(p.holder || "—")}</td></tr>
    <tr><th>Holder portfolio</th><td>${holderInfo ? `${holderInfo.total} licence(s) in dataset, ${holderInfo.active} active` : "—"}</td></tr>
    <tr><th>Applied</th><td>${fmtDate(p.applied)}</td></tr>
    <tr><th>Granted</th><td>${fmtDate(p.granted)}</td></tr>
    <tr><th>Expires</th><td>${fmtDate(p.expires)}</td></tr>
    <tr><th>Commodity groups</th><td>${p.groups.map((g) => esc(GROUP_NAMES[g] || g)).join(", ") || "—"}</td></tr>
  </table>

  <h2>4. Geology &amp; nearby deposits</h2>
  <table>
    <tr><th>Metallogenic belts</th><td>${d.belts.length ? d.belts.map((b) => `${esc(b.name)}${b.relevant ? " ✓" : ""}`).join("<br>") : "None mapped"}</td></tr>
  </table>
  ${deposits.length ? `<table class="grid"><tr><th>Deposit / occurrence</th><th>Commodities</th><th>Status</th><th>Source</th><th class="num">Distance</th></tr>
    ${deposits.map((x) => `<tr><td>${esc(x.deposit.name)}</td><td>${esc(x.deposit.commodities.join(", "))}</td><td>${esc(x.deposit.status || "—")}</td><td>${esc(x.deposit.source)}</td><td class="num">${fmtKm(x.km)}</td></tr>`).join("")}</table>`
    : `<p class="muted">No known ${esc(mineralLabel)} deposits recorded.</p>`}

  <h2>5. Infrastructure</h2>
  <table>
    <tr><th>Nearest port</th><td>${esc(d.port.feature.properties.name)} – ${fmtKm(d.port.km)}</td></tr>
    <tr><th>Nearest rail line</th><td>${esc(d.rail.feature.properties.name)} – ${fmtKm(d.rail.km)}</td></tr>
    <tr><th>Nearest town</th><td>${esc(d.town.feature.properties.name)} – ${fmtKm(d.town.km)}</td></tr>
  </table>

  <h2>6. Score breakdown</h2>
  ${factorBars(result.factors, "licences")}
  <p class="muted" style="font-size:11px">Weights: ${MODE_FACTORS.licences.map((k) => `${FACTOR_LABELS[k]} ${weights[k]}`).join(" · ")}${d.protectedArea ? ". Score halved: inside a protected area." : ""}</p>

  <h2>7. Next steps</h2>
  <ul>
    <li>Confirm current status, holder and expiry in the MME mining cadastre (data snapshot ${fmtDate(snapshot)}).</li>
    <li>Request historic exploration reports for the licence area from the Geological Survey of Namibia.</li>
    <li>Review environmental clearance status and land access (farm ownership, conservancies).</li>
    <li>Approach the holder regarding farm-in, joint venture or acquisition terms.</li>
  </ul>

  <div class="note"><b>Screening only.</b> Licence data: ${esc(sourceText)}, snapshot ${fmtDate(snapshot)}. Deposits: portal curation + USGS MRDS. Mineral belts and protected areas are schematic. Not investment advice.</div>
  <footer>Generated ${esc(generated)} · Namibia Mining Portal</footer>`;
  return shell(`${p.code} – Desktop Study`, body);
}

// ---------- shortlist report ----------
export function shortlistHTML(rows, ctx, { target, snapshot, sourceText = "MME Landfolio cadastre extract" }) {
  const mineralLabel = target === ANY ? "all minerals" : target;
  const generated = new Date().toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" });
  const extent = padExtent(bbox(ctx.boundary.features[0].geometry), 0.3);
  const highlight = rows.map((r, i) => ({ ...r.licence, label: String(i + 1), fill: rampColor(r.score), stroke: "#7a1f0c" }));
  const body = `
  <h1>Licence Shortlist</h1>
  <p class="sub">${rows.length} licence(s) · scored for <b>${esc(mineralLabel)}</b> · data snapshot ${fmtDate(snapshot)}</p>
  ${svgMap(ctx, extent, { highlight, width: 800, showAllLicences: true })}
  <h2>Ranking</h2>
  <table class="grid">
    <tr><th>#</th><th>Licence</th><th>Holder</th><th>Status</th><th>Region</th><th class="num">km²</th><th class="num">Score</th></tr>
    ${rows.map((r, i) => {
      const p = r.licence.properties;
      return `<tr><td>${i + 1}</td><td><b>${esc(p.code)}</b></td><td>${esc(p.holder || "—")}</td>
        <td><span class="pill" style="border-color:${STATUS_GROUP_COLORS[p.statusGroup]}">${esc(p.status)}</span><br><span class="muted">${esc(expiryPosition(p, snapshot).label)}</span></td>
        <td>${esc(r.details.region || "—")}</td><td class="num">${p.areaKm2.toLocaleString()}</td><td class="num"><b>${Math.round(r.score)}</b></td></tr>`;
    }).join("")}
  </table>
  <h2>Factor scores</h2>
  <table class="grid">
    <tr><th>Licence</th>${MODE_FACTORS.licences.map((k) => `<th class="num">${FACTOR_LABELS[k]}</th>`).join("")}<th>Nearest deposit</th><th>Rail / port</th></tr>
    ${rows.map((r) => {
      const dep = nearbyDeposits(r.licence.properties.c, ctx, target, { limit: 1 })[0];
      return `<tr><td>${esc(r.licence.properties.code)}</td>${MODE_FACTORS.licences.map((k) => `<td class="num">${Math.round(r.factors[k] * 100)}</td>`).join("")}
        <td>${dep ? `${esc(dep.deposit.name)} (${fmtKm(dep.km)})` : "—"}</td><td>${fmtKm(r.details.rail.km)} / ${fmtKm(r.details.port.km)}</td></tr>`;
    }).join("")}
  </table>
  <div class="note"><b>Screening only.</b> Licence data: ${esc(sourceText)}, snapshot ${fmtDate(snapshot)}. Verify every licence in the Ministry's cadastre before acting. Mineral belts are schematic.</div>
  <footer>Generated ${esc(generated)} · Namibia Mining Portal</footer>`;
  return shell("Licence Shortlist", body);
}
