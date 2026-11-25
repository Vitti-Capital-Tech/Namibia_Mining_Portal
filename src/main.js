import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import {
  ANY, DEFAULT_WEIGHTS, MATURITY, MINERAL_NAMES, GROUP_NAMES, FACTOR_LABELS, MODE_FACTORS,
  prepareContext, scoreSite, rankSites, rankAreas, rankLicences, scoreLicence, licenceCovers,
  licenceMinerals, nearbyDeposits, holderPortfolio,
} from "./scoring.js";
import {
  esc, fmtKm, fmtDate, colorFor, STATUS_GROUP_COLORS, SCORE_RAMP, rampColor, expiryPosition, download, toCSV,
} from "./util.js";
import { desktopStudyHTML, shortlistHTML, openReport } from "./report.js";

// ---------- config ----------
const SITE_STATUSES = Object.keys(MATURITY);
const STATUS_GROUPS = ["Active", "Application", "Inactive"];
const LIC_TYPES = ["EPL", "ML", "Other"];
const LIC_TYPE_LABELS = { EPL: "Prospecting (EPL)", ML: "Mining (ML)", Other: "Other" };
const licType = (p) => (p.typeCode === "EPL" || p.typeCode === "ML" ? p.typeCode : "Other");
const STATUS_RADIUS = { Operating: 9, Processing: 8, Development: 8, "Care & Maintenance": 7, Exploration: 6 };
const PAGE = 50;
const LS_KEY = "nmp.shortlist.v1";
const statusClass = (s) => "status-" + String(s).split(" ")[0];
const $ = (id) => document.getElementById(id);
/** Lower-case and strip accents so "rossing" matches "Rössing". */
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// ---------- state ----------
const state = {
  tab: "explore",
  exploreKind: "licences",
  search: "",
  mineral: ANY,
  statusGroups: new Set(["Active", "Application"]),
  licTypes: new Set(LIC_TYPES),
  recLicTypes: new Set(LIC_TYPES),
  siteStatuses: new Set(SITE_STATUSES),
  recMineral: ANY,
  recMode: "licences",
  recStatusGroups: new Set(["Active", "Application"]),
  weights: { ...DEFAULT_WEIGHTS },
  slMineral: ANY,
  shortlist: loadShortlist(),
  selected: null, // { kind: "licence"|"site"|"area", id, cell? }
  explorePage: 1,
  rankPage: 1,
};
let ctx, map, snapshot, portfolio;
const licLayers = new Map(); // id -> L.Polygon
const shownLic = new Set();
const siteMarkers = new Map();
let licGroup, siteGroup, areaLayer;
let lastRanking = null; // { key, rows, byId }

function loadShortlist() {
  try { return new Set(JSON.parse(localStorage.getItem(LS_KEY) || "[]")); } catch { return new Set(); }
}
function saveShortlist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify([...state.shortlist])); } catch { /* storage unavailable */ }
  $("shortlist-count").textContent = state.shortlist.size;
}

// ---------- boot ----------
async function loadJSON(name) {
  const res = await fetch(`${import.meta.env.BASE_URL}data/${name}`);
  if (!res.ok) throw new Error(`Failed to load ${name}: ${res.status}`);
  return res.json();
}

async function init() {
  const names = ["sites", "belts", "infrastructure", "namibia_boundary", "namibia_regions", "licences", "occurrences"];
  const [sites, belts, infrastructure, boundary, regions, licences, occurrences] =
    await Promise.all(names.map((n) => loadJSON(`${n}.geojson`)));
  ctx = prepareContext({ sites, belts, infrastructure, boundary, regions, licences, occurrences });
  snapshot = licences.metadata.snapshot;
  portfolio = holderPortfolio(ctx);
  ctx.licById = new Map(ctx.licences.map((l) => [l.properties.id, l]));
  ctx.licByCode = new Map(ctx.licences.map((l) => [l.properties.code.toUpperCase(), l]));

  buildMap({ boundary, regions });
  buildControls();
  renderStats();
  const srcs = licences.metadata.sources || [{ name: licences.metadata.source, url: licences.metadata.sourceUrl }];
  const fromBcc = srcs.every((s) => (s.url || "").includes("benguelacc"));
  const srcHtml = fromBcc
    ? `MME Landfolio extract (public domain, via <a href="${esc(srcs[0].url)}" target="_blank" rel="noopener">BCC GeoNode</a>)`
    : srcs.map((s) => (s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name))).join("; ");
  ctx.sourceText = fromBcc ? "MME Landfolio extract (public domain, via Benguela Current Commission GeoNode)" : srcs.map((s) => s.name).join("; ");
  $("disclaimer").innerHTML =
    `Licences: ${srcHtml}, snapshot ${fmtDate(snapshot)}. ` +
    `Deposits: portal curation + <a href="https://mrdata.usgs.gov/mrds/" target="_blank" rel="noopener">USGS MRDS</a>. ` +
    `Mineral belts &amp; protected areas are schematic. Verify in the MME cadastre before relying on any information.`;
  saveShortlist();
  $("loading").classList.add("hidden");
  render();
  openFromHash();
}

// ---------- map ----------
function buildMap({ boundary, regions }) {
  map = L.map("map", { minZoom: 4, preferCanvas: true });
  const renderer = L.canvas({ padding: 0.5, tolerance: 3 });

  const basemaps = {
    Terrain: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17, attribution: "&copy; OpenTopoMap (CC-BY-SA), &copy; OpenStreetMap",
    }),
    Satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 18, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    }),
    Streets: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: "&copy; OpenStreetMap contributors",
    }),
  };
  basemaps.Terrain.addTo(map);

  const world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
  const outer = boundary.features[0].geometry;
  const rings = (outer.type === "Polygon" ? [outer.coordinates] : outer.coordinates).map((poly) => poly[0].map(([x, y]) => [y, x]));
  L.polygon([world, ...rings], { renderer, stroke: false, fillColor: "#1f2328", fillOpacity: 0.35, interactive: false }).addTo(map);
  const outline = L.geoJSON(boundary, { renderer, style: { color: "#b5651d", weight: 2.5, fill: false }, interactive: false }).addTo(map);

  const regionLayer = L.geoJSON(regions, {
    renderer, interactive: false, style: { color: "#555", weight: 0.8, dashArray: "3 4", fill: false },
  });

  const tip = (html) => ({ sticky: true, className: "site-tip" });
  const beltLayer = L.geoJSON(ctx.belts, {
    renderer,
    style: (f) => {
      const c = colorFor(f.properties.commodities[0]);
      return { color: c, weight: 1.5, fillColor: c, fillOpacity: 0.1, dashArray: "5 4" };
    },
    onEachFeature: (f, layer) =>
      layer.bindTooltip(`<b>${esc(f.properties.name)}</b><span>${esc(f.properties.commodities.join(", "))}</span>`, tip()),
  }).addTo(map);

  const protectedLayer = L.layerGroup(ctx.protectedAreas.map((f) =>
    L.geoJSON(f, { renderer, style: { color: "#2f8f5b", weight: 1, fillColor: "#2f8f5b", fillOpacity: 0.12 } })
      .bindTooltip(`<b>${esc(f.properties.name)}</b><span>Protected area – mining restricted</span>`, tip()),
  )).addTo(map);

  const railLayer = L.layerGroup(ctx.rail.map((f) =>
    L.polyline(f.geometry.coordinates.map(([x, y]) => [y, x]), { renderer, color: "#333", weight: 2.5, dashArray: "8 5", opacity: 0.85 })
      .bindTooltip(esc(f.properties.name), tip()),
  )).addTo(map);

  // Licences: one polygon per licence, added/removed from licGroup as filters change.
  licGroup = L.layerGroup().addTo(map);
  for (const lic of ctx.licences) {
    const latlngs = L.GeoJSON.coordsToLatLngs(lic.geometry.coordinates, 2);
    const poly = L.polygon(latlngs, { renderer, weight: 1 });
    poly.licId = lic.properties.id;
    poly.bindTooltip(() => licenceTooltip(lic), { sticky: true, className: "site-tip" });
    poly.on("click", () => select({ kind: "licence", id: lic.properties.id }));
    poly.on("mouseover", () => poly.setStyle({ weight: 2.5 }));
    poly.on("mouseout", () => poly.setStyle({ weight: licStyle(lic).weight }));
    licLayers.set(lic.properties.id, poly);
  }

  areaLayer = L.layerGroup().addTo(map);

  // Known sites (curated) as circle markers on the same canvas.
  siteGroup = L.layerGroup().addTo(map);
  for (const site of ctx.sites) {
    const p = site.properties;
    const [x, y] = site.geometry.coordinates;
    const m = L.circleMarker([y, x], { renderer, ...markerStyle(site) })
      .bindTooltip(`<b>${esc(p.name)}</b><span>${esc(p.commodities.join(", "))} · ${esc(p.status)}</span><br><span>${esc(p.holder)}</span>`,
        { direction: "top", offset: [0, -6], className: "site-tip" })
      .on("click", () => select({ kind: "site", id: p.id }));
    m.addTo(siteGroup);
    siteMarkers.set(p.id, m);
  }

  // USGS occurrences as small DOM diamonds (marker pane, above the canvas).
  const occLayer = L.layerGroup(ctx.occurrences.map((o) => {
    const [x, y] = o.geometry.coordinates;
    const c = colorFor(o.properties.commodities[0]);
    return L.marker([y, x], {
      icon: L.divIcon({ className: "occ-icon", html: `<span style="background:${c}"></span>`, iconSize: [10, 10] }),
      keyboard: false,
    })
      .bindTooltip(`<b>${esc(o.properties.name)}</b><span>${esc(o.properties.commodities.join(", ") || o.properties.codes.join(", "))} · ${esc(o.properties.devStatus)}</span><br><span>USGS MRDS</span>`,
        { direction: "top", className: "site-tip" })
      .bindPopup(`<b>${esc(o.properties.name)}</b><br>${esc(o.properties.commodities.join(", "))}<br>${esc(o.properties.devStatus)}<br><a href="${esc(o.properties.url)}" target="_blank" rel="noopener">USGS MRDS record ↗</a>`);
  })).addTo(map);

  const townLayer = L.layerGroup([
    ...ctx.towns.map((f) => {
      const [x, y] = f.geometry.coordinates;
      return L.circleMarker([y, x], { renderer, radius: f.properties.capital ? 5 : 3, color: "#222", weight: 1, fillColor: "#fff", fillOpacity: 1 })
        .bindTooltip(esc(f.properties.name), { direction: "top", className: "site-tip" });
    }),
    ...ctx.ports.map((f) => {
      const [x, y] = f.geometry.coordinates;
      return L.marker([y, x], { icon: L.divIcon({ className: "port-icon", html: "⚓", iconSize: [18, 18] }) })
        .bindTooltip(esc(f.properties.name), { direction: "top", className: "site-tip" });
    }),
  ]).addTo(map);

  L.control.layers(basemaps, {
    "Mineral licences": licGroup,
    "Mines & projects": siteGroup,
    "USGS deposits": occLayer,
    "Open-ground cells": areaLayer,
    "Mineral belts (schematic)": beltLayer,
    "Rail network": railLayer,
    "Protected areas": protectedLayer,
    "Towns & ports": townLayer,
    "Regions": regionLayer,
  }, { collapsed: true }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  map.fitBounds(outline.getBounds(), { padding: [10, 10] });
  map.setMaxBounds(outline.getBounds().pad(0.8));
}

function licenceTooltip(lic) {
  const p = lic.properties;
  const r = lastRanking?.byId.get(p.id);
  const score = state.tab === "recommend" && state.recMode === "licences" && r ? ` · score <b style="display:inline">${Math.round(r.score)}</b>` : "";
  return `<b>${esc(p.code)}${state.shortlist.has(p.id) ? " ★" : ""}</b><span>${esc(p.holder || "Holder not recorded")}</span><br>
    <span>${esc(p.status)} · ${p.areaKm2.toLocaleString()} km²${score}</span><br>
    <span>${esc(p.groups.map((g) => GROUP_NAMES[g] || g).join(", "))}</span>`;
}

function licStyle(lic) {
  const p = lic.properties;
  const selected = state.selected?.kind === "licence" && state.selected.id === p.id;
  const starred = state.shortlist.has(p.id);
  let s;
  if (state.tab === "recommend" && state.recMode === "licences") {
    // Colour relative to this result set so differences stay visible when scores bunch together.
    const r = lastRanking?.byId.get(p.id);
    const span = Math.max(1, lastRanking.max - lastRanking.min);
    const c = rampColor(r ? ((r.score - lastRanking.min) / span) * 99.9 : 0);
    s = { color: "#7a1f0c", weight: 0.6, fillColor: c, fillOpacity: 0.6, opacity: 0.7 };
  } else if (state.tab === "recommend" && state.recMode === "areas") {
    s = { color: "#777", weight: 0.6, fillColor: "#999", fillOpacity: 0.12, opacity: 0.6 };
  } else {
    const c = STATUS_GROUP_COLORS[p.statusGroup];
    s = { color: c, weight: 1, fillColor: c, fillOpacity: p.statusGroup === "Inactive" ? 0.05 : 0.18, opacity: p.statusGroup === "Inactive" ? 0.5 : 0.9 };
  }
  if (p.typeCode === "ML") s = { ...s, weight: Math.max(s.weight, 2.2), opacity: 1, dashArray: null };
  else if (p.typeCode && p.typeCode !== "EPL") s = { ...s, dashArray: "4 3" };
  if (starred) s = { ...s, color: "#b5651d", weight: 2.2, opacity: 1 };
  if (selected) s = { ...s, color: "#000", weight: 3, opacity: 1 };
  return s;
}

function markerStyle(site, { score = null, dim = false, selected = false } = {}) {
  const p = site.properties;
  const radius = score !== null ? 5 + (score / 100) * 9 : STATUS_RADIUS[p.status] ?? 6;
  return {
    radius,
    color: selected ? "#000" : "#fff",
    weight: selected ? 3 : 1.5,
    dashArray: p.status === "Exploration" || p.status === "Development" ? "3 2" : null,
    fillColor: colorFor(p.commodities[0]),
    fillOpacity: dim ? 0.15 : 0.95,
    opacity: dim ? 0.3 : 1,
  };
}

/** Show exactly the licences in `ids` and restyle them. */
function setVisibleLicences(ids) {
  for (const id of [...shownLic]) {
    if (!ids.has(id)) { licGroup.removeLayer(licLayers.get(id)); shownLic.delete(id); }
  }
  for (const id of ids) {
    const layer = licLayers.get(id);
    if (!shownLic.has(id)) { licGroup.addLayer(layer); shownLic.add(id); }
    layer.setStyle(licStyle(ctx.licById.get(id)));
  }
  // keep sites drawn above licence polygons on the shared canvas
  siteMarkers.forEach((m) => m.bringToFront());
  if (state.selected?.kind === "licence" && shownLic.has(state.selected.id)) licLayers.get(state.selected.id).bringToFront();
}

// ---------- controls ----------
function mineralOptions() {
  return [ANY, ...MINERAL_NAMES].map((c) => `<option value="${esc(c)}">${c === ANY ? "All minerals" : esc(c)}</option>`).join("");
}

function chipButtons(values, active, attr, colors = {}) {
  return values.map((s) => `<button type="button" class="chip ${statusClass(s)}" data-${attr}="${esc(s)}" aria-pressed="${active.has(s)}">
    <span class="dot" style="background:${colors[s] || "currentColor"}"></span>${esc(s)}</button>`).join("");
}

function buildControls() {
  $("filter-mineral").innerHTML = mineralOptions();
  $("rec-mineral").innerHTML = mineralOptions();
  $("sl-mineral").innerHTML = mineralOptions();

  let searchTimer;
  $("search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = norm(e.target.value.trim()); state.explorePage = 1; render(); }, 150);
  });
  $("filter-mineral").addEventListener("change", (e) => { state.mineral = e.target.value; state.explorePage = 1; render(); });
  $("rec-mineral").addEventListener("change", (e) => { state.recMineral = e.target.value; state.rankPage = 1; render(); fitToResults(); });
  $("sl-mineral").addEventListener("change", (e) => { state.slMineral = e.target.value; render(); });

  $("filter-status").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-status]");
    if (!btn) return;
    const set = state.exploreKind === "licences" ? state.statusGroups : state.siteStatuses;
    const s = btn.dataset.status;
    set.has(s) ? set.delete(s) : set.add(s);
    state.explorePage = 1;
    render();
  });
  const typeToggle = (set, after) => (e) => {
    const btn = e.target.closest("[data-type]");
    if (!btn) return;
    const t = btn.dataset.type;
    set.has(t) ? set.delete(t) : set.add(t);
    after();
    render();
  };
  $("filter-type").addEventListener("click", typeToggle(state.licTypes, () => { state.explorePage = 1; }));
  $("rec-type").addEventListener("click", typeToggle(state.recLicTypes, () => { state.rankPage = 1; }));
  $("rec-status").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-status]");
    if (!btn) return;
    const s = btn.dataset.status;
    state.recStatusGroups.has(s) ? state.recStatusGroups.delete(s) : state.recStatusGroups.add(s);
    state.rankPage = 1;
    render();
  });

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    state.tab = t.dataset.tab;
    document.querySelectorAll(".tab").forEach((x) => { x.classList.toggle("active", x === t); x.setAttribute("aria-selected", x === t); });
    closeDetail(false);
    render();
    if (state.tab === "shortlist") fitToResults();
  }));

  segmented("[data-explore]", (v) => { state.exploreKind = v; state.explorePage = 1; $("search").value = ""; state.search = ""; render(); });
  segmented("[data-mode]", (v) => { state.recMode = v; state.rankPage = 1; render(); });

  renderWeights();
  $("reset-weights").addEventListener("click", () => { state.weights = { ...DEFAULT_WEIGHTS }; renderWeights(); render(); });
  $("detail-back").addEventListener("click", () => closeDetail());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
  $("explore-more").addEventListener("click", () => { state.explorePage++; render(); });
  $("rank-more").addEventListener("click", () => { state.rankPage++; render(); });

  $("sl-csv").addEventListener("click", exportShortlistCSV);
  $("sl-report").addEventListener("click", () => {
    const rows = shortlistRows();
    if (!rows.length) return alert("Your shortlist is empty. Star licences to add them.");
    openReport(shortlistHTML(rows, ctx, { target: state.slMineral, snapshot, sourceText: ctx.sourceText }));
  });
  $("sl-clear").addEventListener("click", () => {
    if (state.shortlist.size && confirm(`Remove all ${state.shortlist.size} licences from the shortlist?`)) {
      state.shortlist.clear(); saveShortlist(); render();
    }
  });

  // Delegated clicks for all lists (open item / toggle star).
  for (const listId of ["explore-list", "rank-list", "shortlist-list"]) {
    const list = $(listId);
    list.addEventListener("click", (e) => {
      const star = e.target.closest("[data-star]");
      if (star) { e.stopPropagation(); toggleStar(star.dataset.star); return; }
      const item = e.target.closest("[data-kind]");
      if (item) openItem(item);
    });
    list.addEventListener("keydown", (e) => {
      const item = e.target.closest("[data-kind]");
      if (item && e.key === "Enter") openItem(item);
    });
    list.addEventListener("mouseover", (e) => hoverItem(e.target.closest("[data-kind]"), true));
    list.addEventListener("mouseout", (e) => hoverItem(e.target.closest("[data-kind]"), false));
  }
  $("detail-body").addEventListener("click", (e) => {
    const star = e.target.closest("[data-star]");
    if (star) toggleStar(star.dataset.star);
    const rep = e.target.closest("[data-report]");
    if (rep) openDesktopStudy(rep.dataset.report);
    const dep = e.target.closest("[data-deposit-site]");
    if (dep) select({ kind: "site", id: dep.dataset.depositSite }, { fly: true });
  });

  window.addEventListener("hashchange", openFromHash);
}

function segmented(selector, onChange) {
  const buttons = document.querySelectorAll(selector);
  buttons.forEach((b) => b.addEventListener("click", () => {
    buttons.forEach((x) => { x.classList.toggle("active", x === b); x.setAttribute("aria-checked", x === b); });
    onChange(b.dataset[Object.keys(b.dataset)[0]]);
  }));
}

function openItem(el) {
  const { kind, id } = el.dataset;
  if (kind === "area") showArea(Number(id), { fly: true });
  else select({ kind, id }, { fly: true });
}

function hoverItem(el, on) {
  if (!el) return;
  const layer = el.dataset.kind === "licence" ? licLayers.get(el.dataset.id) : el.dataset.kind === "site" ? siteMarkers.get(el.dataset.id) : null;
  if (!layer || !map.hasLayer(layer)) return;
  if (on) layer.openTooltip(layer.getBounds ? layer.getBounds().getCenter() : undefined);
  else layer.closeTooltip();
}

function toggleStar(id) {
  state.shortlist.has(id) ? state.shortlist.delete(id) : state.shortlist.add(id);
  saveShortlist();
  render();
  if (state.selected?.kind === "licence" && state.selected.id === id) renderDetail();
}

function renderWeights() {
  const keys = state.recMode ? MODE_FACTORS[state.recMode] : Object.keys(DEFAULT_WEIGHTS);
  $("weights").innerHTML = keys.map((k) => `
    <label class="weight-row">
      <span>${FACTOR_LABELS[k]}</span>
      <input type="range" min="0" max="50" step="5" value="${state.weights[k]}" data-weight="${k}" />
      <output>${state.weights[k]}</output>
    </label>`).join("");
  $("weights").querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => {
    state.weights[inp.dataset.weight] = Number(inp.value);
    inp.nextElementSibling.textContent = inp.value;
    scheduleRender();
  }));
}

let raf = 0;
function scheduleRender() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(render);
}

function renderStats() {
  const g = (s) => ctx.licences.filter((l) => l.properties.statusGroup === s).length;
  $("stats").innerHTML = [
    [ctx.licences.length, "Licences"],
    [g("Active"), "Active"],
    [g("Application"), "Applications"],
    [ctx.licences.filter((l) => l.properties.typeCode === "ML").length, "Mining licences"],
    [ctx.deposits.length, "Known deposits"],
  ].map(([n, l]) => `<div class="stat"><b>${n.toLocaleString()}</b><span>${l}</span></div>`).join("");
}

// ---------- render ----------
function render() {
  if (!ctx) return;
  siteMarkers.forEach((m) => m.closeTooltip());
  for (const t of ["explore", "recommend", "shortlist"]) $(`panel-${t}`).classList.toggle("hidden", state.tab !== t);
  areaLayer.clearLayers();
  if (state.tab === "explore") renderExplore();
  else if (state.tab === "recommend") renderRecommend();
  else renderShortlist();
  renderLegend();
  // keep an open licence/site panel in sync with the current mineral and weights
  if (!$("detail").classList.contains("hidden") && ["licence", "site"].includes(state.selected?.kind)) renderDetail();
}

function licenceMatchesSearch(p, q) {
  if (!q) return true;
  return norm([p.code, p.holder, ...p.mapRef].join(" ")).includes(q) ||
    p.code.toLowerCase().replace("epl-", "") === q.replace(/^epl[- ]?/, "");
}

const GROUP_ORDER = { Active: 0, Application: 1, Inactive: 2 };

function renderExplore() {
  const q = state.search;
  const statusWrap = $("filter-status");
  $("filter-type-wrap").classList.toggle("hidden", state.exploreKind !== "licences");
  if (state.exploreKind === "licences") {
    statusWrap.innerHTML = chipButtons(STATUS_GROUPS, state.statusGroups, "status", STATUS_GROUP_COLORS);
    $("filter-type").innerHTML = typeChips(state.licTypes);
    const filtered = ctx.licences.filter((l) => {
      const p = l.properties;
      return state.statusGroups.has(p.statusGroup) && state.licTypes.has(licType(p)) &&
        licenceCovers(l, state.mineral) && licenceMatchesSearch(p, q);
    }).sort((a, b) => GROUP_ORDER[a.properties.statusGroup] - GROUP_ORDER[b.properties.statusGroup] ||
      parseInt(b.properties.code.replace(/\D/g, ""), 10) - parseInt(a.properties.code.replace(/\D/g, ""), 10));
    setVisibleLicences(new Set(filtered.map((l) => l.properties.id)));
    styleSites(() => ({}));
    $("result-count").textContent = `${filtered.length.toLocaleString()} of ${ctx.licences.length.toLocaleString()} licences`;
    const page = filtered.slice(0, state.explorePage * PAGE);
    $("explore-list").innerHTML = page.map((l) => licenceRow(l)).join("") || `<li class="hint">No licences match these filters.</li>`;
    $("explore-more").classList.toggle("hidden", page.length >= filtered.length);
  } else {
    statusWrap.innerHTML = chipButtons(SITE_STATUSES, state.siteStatuses, "status");
    const visible = ctx.sites.filter((s) => {
      const p = s.properties;
      if (!state.siteStatuses.has(p.status)) return false;
      if (state.mineral !== ANY && !p.commodities.includes(state.mineral)) return false;
      return !q || norm([p.name, p.holder, p.nearestTown, p.region, ...p.commodities].join(" ")).includes(q);
    }).sort((a, b) => a.properties.name.localeCompare(b.properties.name));
    const ids = new Set(visible.map((s) => s.properties.id));
    setVisibleLicences(new Set());
    styleSites((s) => ({ dim: !ids.has(s.properties.id) }));
    $("result-count").textContent = `${visible.length} of ${ctx.sites.length} mines & projects`;
    $("explore-list").innerHTML = visible.map((s) => {
      const p = s.properties;
      return `<li class="site-item ${isSel("site", p.id) ? "active" : ""}" data-kind="site" data-id="${esc(p.id)}" tabindex="0">
        <span class="dot" style="background:${colorFor(p.commodities[0])}"></span>
        <div><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.commodities.join(", "))} · ${esc(p.region)}</div></div>
        <span class="badge ${statusClass(p.status)}">${esc(p.status)}</span></li>`;
    }).join("") || `<li class="hint">No sites match these filters.</li>`;
    $("explore-more").classList.add("hidden");
  }
}

const isSel = (kind, id) => state.selected?.kind === kind && state.selected.id === id;

function starButton(id) {
  const on = state.shortlist.has(id);
  return `<button type="button" class="star ${on ? "on" : ""}" data-star="${esc(id)}" aria-pressed="${on}" title="${on ? "Remove from" : "Add to"} shortlist">${on ? "★" : "☆"}</button>`;
}

function typeChips(active) {
  const counts = Object.fromEntries(LIC_TYPES.map((t) => [t, ctx.licences.filter((l) => licType(l.properties) === t).length]));
  return LIC_TYPES.filter((t) => counts[t] > 0).map((t) =>
    `<button type="button" class="chip" data-type="${t}" aria-pressed="${active.has(t)}">${esc(LIC_TYPE_LABELS[t])} <span class="sub">${counts[t].toLocaleString()}</span></button>`).join("");
}

function licenceRow(l, { rank = null, score = null } = {}) {
  const p = l.properties;
  const lead = rank !== null ? `<span class="rank-num">${rank}</span>` : `<span class="dot" style="background:${STATUS_GROUP_COLORS[p.statusGroup]}"></span>`;
  const tail = score !== null ? `<span class="score">${Math.round(score)}</span>` : `<span class="badge ${statusClass(p.statusGroup)}">${esc(p.status)}</span>`;
  return `<li class="${rank !== null ? "rank-item" : "site-item"} lic ${isSel("licence", p.id) ? "active" : ""}" data-kind="licence" data-id="${esc(p.id)}" tabindex="0">
    ${lead}
    <div><div class="name">${esc(p.code)}</div><div class="sub">${esc(p.holder || "—")} · ${esc(p.mapRef[0] || "")}${p.areaKm2 ? ` · ${p.areaKm2.toLocaleString()} km²` : ""}</div></div>
    <div class="row-end">${tail}${starButton(p.id)}</div></li>`;
}

function styleSites(fn) {
  for (const site of ctx.sites) {
    const m = siteMarkers.get(site.properties.id);
    const opts = fn(site) || {};
    m.setStyle(markerStyle(site, { ...opts, selected: isSel("site", site.properties.id) }));
    m.setRadius(markerStyle(site, opts).radius);
  }
}

function getRanking() {
  const key = [state.recMineral, [...state.recStatusGroups].sort().join(), [...state.recLicTypes].sort().join(), JSON.stringify(state.weights)].join("|");
  if (lastRanking?.key !== key) {
    const rows = rankLicences(ctx, state.recMineral, state.weights, { statusGroups: [...state.recStatusGroups] })
      .filter((r) => state.recLicTypes.has(licType(r.licence.properties)));
    const scores = rows.map((r) => r.score);
    lastRanking = {
      key, rows,
      min: scores.length ? Math.min(...scores) : 0,
      max: scores.length ? Math.max(...scores) : 100,
      byId: new Map(rows.map((r, i) => [r.licence.properties.id, { ...r, rank: i + 1 }])),
    };
  }
  return lastRanking;
}

const MODE_HINTS = {
  licences: "Scores every licence whose commodity groups cover the mineral on geology, nearby deposits, rail and port access, and tenure. Darker = higher.",
  sites: "Scores known mines and projects producing the mineral on geology, logistics and project maturity. Larger markers rank higher.",
  areas: "Finds 0.25° cells (~27 km) inside prospective belts that are NOT covered by an active licence or application (at the snapshot) and lie outside protected areas.",
};

function renderRecommend() {
  const target = state.recMineral;
  $("mode-hint").textContent = MODE_HINTS[state.recMode];
  $("rec-status-wrap").classList.toggle("hidden", state.recMode !== "licences");
  $("rec-status").innerHTML = chipButtons(STATUS_GROUPS, state.recStatusGroups, "status", STATUS_GROUP_COLORS);
  $("rec-type-wrap").classList.toggle("hidden", state.recMode !== "licences");
  $("rec-type").innerHTML = typeChips(state.recLicTypes);
  if ($("weights").dataset.mode !== state.recMode) { renderWeights(); $("weights").dataset.mode = state.recMode; }
  $("rank-more").classList.add("hidden");

  if (state.recMode === "licences") {
    const { rows } = getRanking();
    setVisibleLicences(new Set(rows.map((r) => r.licence.properties.id)));
    styleSites(() => ({ dim: true }));
    $("rank-count").textContent = `${rows.length.toLocaleString()} licences ranked for ${target === ANY ? "all minerals" : target}`;
    const page = rows.slice(0, state.rankPage * PAGE);
    $("rank-list").innerHTML = page.map((r, i) => licenceRow(r.licence, { rank: i + 1, score: r.score })).join("") ||
      `<li class="hint">No licences cover this mineral with the selected statuses.</li>`;
    $("rank-more").classList.toggle("hidden", page.length >= rows.length);
  } else if (state.recMode === "sites") {
    setVisibleLicences(new Set());
    const ranked = rankSites(ctx, target, state.weights);
    const byId = new Map(ranked.map((r) => [r.site.properties.id, r]));
    styleSites((s) => { const r = byId.get(s.properties.id); return { score: r.score, dim: !r.eligible }; });
    const eligible = ranked.filter((r) => r.eligible);
    $("rank-count").textContent = `${eligible.length} known mines & projects`;
    $("rank-list").innerHTML = eligible.map((r, i) => {
      const p = r.site.properties;
      return `<li class="rank-item ${isSel("site", p.id) ? "active" : ""}" data-kind="site" data-id="${esc(p.id)}" tabindex="0">
        <span class="rank-num">${i + 1}</span>
        <div><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.commodities.join(", "))} · ${esc(p.status)}</div></div>
        <span class="score">${Math.round(r.score)}</span></li>`;
    }).join("") || `<li class="hint">No known mines produce this mineral.</li>`;
  } else {
    // Show held ground (active + applications) faintly so open ground stands out.
    setVisibleLicences(new Set(ctx.licences.filter((l) => l.properties.statusGroup !== "Inactive").map((l) => l.properties.id)));
    styleSites((s) => ({ dim: !(target === ANY || s.properties.commodities.includes(target)) }));
    const cells = rankAreas(ctx, target, state.weights);
    state.cells = cells;
    cells.forEach((c, i) => {
      L.rectangle(c.bounds, { color: rampColor(c.score), weight: 1.5, fillColor: rampColor(c.score), fillOpacity: 0.6 })
        .bindTooltip(`<b>Open ground #${i + 1} · score ${Math.round(c.score)}</b><span>${esc(c.details.belts.join(", "))}</span>`, { sticky: true, className: "site-tip" })
        .on("click", () => showArea(i))
        .addTo(areaLayer);
    });
    $("rank-count").textContent = `Top ${cells.length} open-ground cells`;
    $("rank-list").innerHTML = cells.map((c, i) => `<li class="rank-item" data-kind="area" data-id="${i}" tabindex="0">
        <span class="rank-num">${i + 1}</span>
        <div><div class="name">${c.center[1].toFixed(2)}°, ${c.center[0].toFixed(2)}°</div>
        <div class="sub">${esc(c.details.belts.join(", "))} · near ${esc(c.details.town.feature.properties.name)}</div></div>
        <span class="score">${Math.round(c.score)}</span></li>`).join("") ||
      `<li class="hint">No unlicensed prospective ground found for this mineral. Try another mineral or lower the geology weight to 0.</li>`;
  }
}

function shortlistRows() {
  return [...state.shortlist]
    .map((id) => ctx.licById.get(id))
    .filter(Boolean)
    .map((l) => ({ licence: l, ...scoreLicence(l, ctx, state.slMineral, state.weights) }))
    .sort((a, b) => b.score - a.score);
}

function renderShortlist() {
  const rows = shortlistRows();
  setVisibleLicences(new Set(rows.map((r) => r.licence.properties.id)));
  styleSites(() => ({ dim: true }));
  $("shortlist-list").innerHTML = rows.map((r, i) => licenceRow(r.licence, { rank: i + 1, score: r.eligible ? r.score : 0 })).join("") ||
    `<li class="hint">No licences shortlisted yet. Use ☆ on any licence.</li>`;
}

function exportShortlistCSV() {
  const rows = shortlistRows();
  if (!rows.length) return alert("Your shortlist is empty.");
  const csv = toCSV(rows.map((r) => {
    const p = r.licence.properties;
    const dep = nearbyDeposits(p.c, ctx, state.slMineral, { limit: 1 })[0];
    return {
      licence: p.code, holder: p.holder, status: p.status, status_group: p.statusGroup,
      applied: p.applied, granted: p.granted, expires: p.expires, area_km2: p.areaKm2,
      region: r.details.region, map_ref: p.mapRef, commodity_groups: p.groups.map((g) => GROUP_NAMES[g] || g),
      target_mineral: state.slMineral, score: Math.round(r.score),
      ...Object.fromEntries(MODE_FACTORS.licences.map((k) => [`f_${k}`, Math.round(r.factors[k] * 100)])),
      belts: r.details.belts.map((b) => b.name), nearest_deposit: dep ? `${dep.deposit.name} (${Math.round(dep.km)} km)` : "",
      rail_km: Math.round(r.details.rail.km), port_km: Math.round(r.details.port.km),
      centroid_lat: p.c[1], centroid_lon: p.c[0],
    };
  }));
  download(`namibia-shortlist-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv");
}

function renderLegend() {
  const scoreLegend = (title) => `<h4>${title}</h4><div class="grad" style="background:linear-gradient(90deg,${SCORE_RAMP.join(",")})"></div><div class="ends"><span>0</span><span>100</span></div>`;
  let html = "";
  if (state.tab === "recommend" && state.recMode === "licences") {
    const { min, max } = getRanking();
    html = `<h4>Licence score</h4><div class="grad" style="background:linear-gradient(90deg,${SCORE_RAMP.join(",")})"></div>
      <div class="ends"><span>${Math.round(min)}</span><span>${Math.round(max)}</span></div><div class="row sub">Colour stretched to this result set</div>`;
  }
  else if (state.tab === "recommend" && state.recMode === "areas")
    html = scoreLegend("Open-ground score") + `<div class="row"><span class="sw" style="background:#9994;border-color:#777"></span>Held ground (active/application)</div>`;
  else if (state.tab === "recommend")
    html = `<h4>Known mines</h4><div class="row">Marker size = score; colour = primary commodity</div>`;
  else
    html = `<h4>Licence status</h4>` + STATUS_GROUPS.map((g) => `<div class="row"><span class="sw" style="background:${STATUS_GROUP_COLORS[g]}33;border-color:${STATUS_GROUP_COLORS[g]}"></span>${g}</div>`).join("") +
      `<div class="row"><span class="sw" style="border:2.5px solid #2f8f5b"></span>Mining licence (thick outline)</div>` +
      `<div class="row"><span class="sw" style="border:2px solid #b5651d"></span>Shortlisted</div>`;
  html += `<h4 style="margin-top:8px">Deposits</h4>
    <div class="row"><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="#c8642e" stroke="#fff" stroke-width="1.5"/></svg>Mine / project</div>
    <div class="row"><span class="occ-icon static"><span style="background:#c8642e"></span></span>USGS deposit</div>`;
  $("legend").innerHTML = html;
}

// ---------- selection & detail ----------
function select(sel, { fly = false } = {}) {
  state.selected = sel;
  if (sel.kind === "licence") history.replaceState(null, "", "#" + ctx.licById.get(sel.id).properties.code);
  renderDetail();
  openDetail();
  render();
  if (sel.kind === "licence") {
    const layer = licLayers.get(sel.id);
    if (!map.hasLayer(layer)) { licGroup.addLayer(layer); shownLic.add(sel.id); layer.setStyle(licStyle(ctx.licById.get(sel.id))); }
    if (fly) map.flyToBounds(layer.getBounds(), { maxZoom: 10, padding: [40, 40], duration: 0.8 });
    layer.bringToFront();
  } else if (sel.kind === "site") {
    const m = siteMarkers.get(sel.id);
    if (fly) map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 8), { duration: 0.8 });
    m.bringToFront();
  }
}

function currentTarget() {
  return state.tab === "recommend" ? state.recMineral : state.tab === "shortlist" ? state.slMineral : state.mineral;
}

function renderDetail() {
  const sel = state.selected;
  if (!sel) return;
  if (sel.kind === "licence") $("detail-body").innerHTML = licenceDetailHTML(ctx.licById.get(sel.id));
  else if (sel.kind === "site") $("detail-body").innerHTML = siteDetailHTML(ctx.sites.find((s) => s.properties.id === sel.id));
}

function factorBars(factors, mode) {
  return MODE_FACTORS[mode].filter((k) => k in factors).map((k) => `
    <div class="bar"><span>${FACTOR_LABELS[k]}</span>
      <div class="track"><div class="fill" style="width:${Math.round(factors[k] * 100)}%"></div></div>
      <span>${Math.round(factors[k] * 100)}</span></div>`).join("");
}

function depositList(pt, target) {
  const deps = nearbyDeposits(pt, ctx, target, { limit: 5 });
  if (!deps.length) return `<p class="hint">No known ${target === ANY ? "" : esc(target) + " "}deposits recorded.</p>`;
  return `<ul class="dep-list">${deps.map((d) => {
    const dep = d.deposit;
    const name = dep.source === "Portal sites"
      ? `<button type="button" class="link" data-deposit-site="${esc(dep.id)}">${esc(dep.name)}</button>`
      : dep.url ? `<a href="${esc(dep.url)}" target="_blank" rel="noopener">${esc(dep.name)}</a>` : esc(dep.name);
    return `<li><span class="dot" style="background:${colorFor(dep.commodities[0])}"></span>
      <div>${name}<div class="sub">${esc(dep.commodities.join(", "))} · ${esc(dep.status || "")} · ${esc(dep.source)}</div></div>
      <span class="km">${fmtKm(d.km)}</span></li>`;
  }).join("")}</ul>`;
}

function licenceDetailHTML(lic) {
  const p = lic.properties;
  const target = currentTarget();
  const r = scoreLicence(lic, ctx, target, state.weights);
  const d = r.details;
  const exp = expiryPosition(p, snapshot);
  const hp = portfolio.get(p.holder);
  const rank = state.tab === "recommend" && state.recMode === "licences" ? lastRanking?.byId.get(p.id)?.rank : null;
  return `
    <h2>${esc(p.code)}</h2>
    <div class="tags">
      <span class="badge ${statusClass(p.statusGroup)}">${esc(p.status)}</span>
      ${licenceMinerals(lic).map((m) => `<span class="chip"><span class="dot" style="background:${colorFor(m)}"></span>${esc(m)}</span>`).join("")}
    </div>
    <div class="btn-row">
      <button type="button" class="btn ${state.shortlist.has(p.id) ? "" : "primary"}" data-star="${esc(p.id)}">${state.shortlist.has(p.id) ? "★ Shortlisted" : "☆ Add to shortlist"}</button>
      <button type="button" class="btn" data-report="${esc(p.id)}">Desktop study ↗</button>
    </div>
    <div class="section-title">Score${target !== ANY ? ` for ${esc(target)}` : ""}${rank ? ` · rank ${rank.toLocaleString()} of ${lastRanking.rows.length.toLocaleString()}` : ""}</div>
    ${r.eligible
      ? `<div class="big-score">${Math.round(r.score)}<small> / 100</small></div>${factorBars(r.factors, "licences")}${d.protectedArea ? `<p class="hint">Score halved: inside ${esc(d.protectedArea)}.</p>` : ""}`
      : `<p class="hint">This licence's commodity groups do not cover ${esc(target)}.</p>`}
    <div class="section-title">Holder &amp; tenure</div>
    <dl class="kv">
      <dt>Holder</dt><dd>${esc(p.holder || "—")}${hp ? `<div class="sub">${hp.total} licence(s) in dataset, ${hp.active} active</div>` : ""}</dd>
      <dt>Type</dt><dd>${esc(p.type)}</dd>
      <dt>Applied</dt><dd>${fmtDate(p.applied)}</dd>
      <dt>Granted</dt><dd>${fmtDate(p.granted)}</dd>
      <dt>Expires</dt><dd>${fmtDate(p.expires)}</dd>
      <dt>Expiry position</dt><dd class="tone-${exp.tone}">${esc(exp.label)}</dd>
      <dt>Commodity groups</dt><dd>${esc(p.groups.map((g) => GROUP_NAMES[g] || g).join(", ") || "—")}</dd>
    </dl>
    <div class="section-title">Location</div>
    <dl class="kv">
      <dt>Region</dt><dd>${esc(d.region || "—")}</dd>
      <dt>Map reference</dt><dd>${esc(p.mapRef.join(", ") || "—")}</dd>
      <dt>Area</dt><dd>${p.areaKm2.toLocaleString()} km²</dd>
      <dt>Centroid</dt><dd>${p.c[1].toFixed(3)}°, ${p.c[0].toFixed(3)}°</dd>
    </dl>
    <div class="section-title">Geology</div>
    ${d.belts.length ? `<ul class="belt-list">${d.belts.map((b) => `<li>${b.relevant && target !== ANY ? "✓ " : ""}${esc(b.name)} <span class="sub">${Math.round(b.share * 100)}% of licence</span></li>`).join("")}</ul>` : `<p class="hint">Outside mapped metallogenic belts.</p>`}
    <div class="section-title">Nearby ${target === ANY ? "" : esc(target) + " "}deposits</div>
    ${depositList(p.c, target)}
    <div class="section-title">Infrastructure</div>
    <dl class="kv">
      <dt>Nearest port</dt><dd>${esc(d.port.feature.properties.name)} · ${fmtKm(d.port.km)}</dd>
      <dt>Nearest rail</dt><dd>${fmtKm(d.rail.km)}</dd>
      <dt>Nearest town</dt><dd>${esc(d.town.feature.properties.name)} · ${fmtKm(d.town.km)}</dd>
      <dt>Protected area</dt><dd>${esc(d.protectedArea || "None")}</dd>
    </dl>
    <div class="warnbox">Status as at ${fmtDate(snapshot)} data snapshot. Verify the current holder, status and expiry in the MME cadastre.</div>`;
}

function siteDetailHTML(site) {
  const p = site.properties;
  const target = currentTarget();
  const r = scoreSite(site, ctx, target, state.weights);
  const d = r.details;
  return `
    <h2>${esc(p.name)}</h2>
    <div class="tags">
      ${p.commodities.map((c) => `<span class="chip"><span class="dot" style="background:${colorFor(c)}"></span>${esc(c)}</span>`).join("")}
      <span class="badge ${statusClass(p.status)}">${esc(p.status)}</span>
    </div>
    <p>${esc(p.description)}</p>
    <dl class="kv">
      <dt>Holder</dt><dd>${esc(p.holder)}</dd>
      <dt>Site type</dt><dd>${esc(p.siteType)}</dd>
      <dt>Region</dt><dd>${esc(p.region)}</dd>
      <dt>Nearest town</dt><dd>${esc(p.nearestTown)}</dd>
      <dt>Since</dt><dd>${p.since ?? "—"}</dd>
      <dt>Coordinates</dt><dd>${site.geometry.coordinates[1].toFixed(3)}°, ${site.geometry.coordinates[0].toFixed(3)}° (approx.)</dd>
    </dl>
    ${p.verify?.length ? `<div class="warnbox"><b>Verify against cadastre:</b> ${esc(p.verify.join(", "))}</div>` : ""}
    <div class="section-title">Location &amp; logistics</div>
    <dl class="kv">
      <dt>Nearest port</dt><dd>${esc(d.port.feature.properties.name)} · ${fmtKm(d.port.km)}</dd>
      <dt>Nearest rail</dt><dd>${fmtKm(d.rail.km)}</dd>
      <dt>Mineral belt</dt><dd>${esc(d.belts.join(", ") || "Outside mapped belts")}</dd>
      <dt>Protected area</dt><dd>${esc(d.protectedArea || "None")}</dd>
    </dl>
    <div class="section-title">Score${target !== ANY ? ` for ${esc(target)}` : ""}</div>
    ${r.eligible ? `<div class="big-score">${Math.round(r.score)}<small> / 100</small></div>${factorBars(r.factors, "sites")}`
      : `<p class="hint">This site does not produce ${esc(target)}.</p>`}`;
}

function showArea(i, { fly = false } = {}) {
  const c = state.cells?.[i];
  if (!c) return;
  state.selected = { kind: "area", id: String(i) };
  const d = c.details;
  const target = state.recMineral;
  $("detail-body").innerHTML = `
    <h2>Open ground #${i + 1}</h2>
    <p class="hint">0.25° × 0.25° cell (~27 × 27 km) centred on ${c.center[1].toFixed(3)}°, ${c.center[0].toFixed(3)}°${d.region ? ` · ${esc(d.region)} Region` : ""}</p>
    <div class="big-score">${Math.round(c.score)}<small> / 100</small></div>
    ${factorBars(c.factors, "areas")}
    <div class="section-title">Why here</div>
    <dl class="kv">
      <dt>Mineral belt</dt><dd>${esc(d.belts.join(", "))}</dd>
      <dt>Nearest port</dt><dd>${esc(d.port.feature.properties.name)} · ${fmtKm(d.port.km)}</dd>
      <dt>Nearest rail</dt><dd>${fmtKm(d.rail.km)}</dd>
      <dt>Nearest town</dt><dd>${esc(d.town.feature.properties.name)} · ${fmtKm(d.town.km)}</dd>
    </dl>
    <div class="section-title">Nearby ${target === ANY ? "" : esc(target) + " "}deposits</div>
    ${depositList(c.center, target)}
    <div class="warnbox">Not covered by an active licence or application in the ${fmtDate(snapshot)} snapshot. Ground may have been licensed since. Check the MME cadastre before applying for an EPL.</div>`;
  openDetail();
  if (fly) map.flyToBounds(c.bounds, { maxZoom: 9, duration: 0.8 });
}

function openDesktopStudy(id) {
  const lic = ctx.licById.get(id);
  const target = currentTarget();
  const result = scoreLicence(lic, ctx, target, state.weights);
  openReport(desktopStudyHTML(lic, result, ctx, { target, snapshot, weights: state.weights, portfolio, sourceText: ctx.sourceText }));
}

function openDetail() { $("detail").classList.remove("hidden"); $("detail").scrollTop = 0; }
function closeDetail(rerender = true) {
  if ($("detail").classList.contains("hidden")) return;
  $("detail").classList.add("hidden");
  state.selected = null;
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  if (rerender) render();
}

function fitToResults() {
  let layers = [];
  if (state.tab === "shortlist") layers = [...state.shortlist].map((id) => licLayers.get(id)).filter(Boolean);
  else if (state.tab === "recommend" && state.recMode === "licences") layers = getRanking().rows.slice(0, 25).map((r) => licLayers.get(r.licence.properties.id));
  else if (state.tab === "recommend" && state.recMode === "sites")
    layers = ctx.sites.filter((s) => state.recMineral === ANY || s.properties.commodities.includes(state.recMineral)).map((s) => siteMarkers.get(s.properties.id));
  if (!layers.length) return;
  const b = L.latLngBounds([]);
  layers.forEach((l) => b.extend(l.getBounds ? l.getBounds() : l.getLatLng()));
  map.flyToBounds(b.pad(0.2), { maxZoom: 9, duration: 0.8 });
}

function openFromHash() {
  const code = decodeURIComponent(location.hash.slice(1)).toUpperCase();
  if (!code) return;
  const lic = ctx.licByCode.get(code);
  if (lic && !isSel("licence", lic.properties.id)) select({ kind: "licence", id: lic.properties.id }, { fly: true });
}

init().catch((err) => {
  console.error(err);
  $("loading").textContent = `Could not load map data: ${err.message}`;
});
