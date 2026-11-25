// Licence / site / open-ground scoring. Pure functions, no DOM: usable in the browser and in Node tests.
import { haversineKm, pointInGeometry, nearestPoint, nearestLine, bbox } from "./geo.js";

export const ANY = "Any";

/** The 13 target minerals and the Landfolio commodity groups that cover them. */
export const MINERALS = {
  Gold:          { groups: ["PM"] },
  Silver:        { groups: ["PM"] },
  Copper:        { groups: ["BRM"] },
  Zinc:          { groups: ["BRM"] },
  Lead:          { groups: ["BRM"] },
  Uranium:       { groups: ["Nf"] },
  Lithium:       { groups: ["BRM", "IM"] },
  Tin:           { groups: ["BRM"] },
  Tantalum:      { groups: ["BRM"] },
  "Rare Earths": { groups: ["BRM"] },
  Manganese:     { groups: ["BRM"] },
  Graphite:      { groups: ["IM"] },
  Diamonds:      { groups: ["PS"] },
};
export const MINERAL_NAMES = Object.keys(MINERALS);

export const GROUP_NAMES = {
  BRM: "Base & Rare Metals", PM: "Precious Metals", PS: "Precious Stones", SPS: "Semi-Precious Stones",
  IM: "Industrial Minerals", DS: "Dimension Stone", Nf: "Nuclear Fuel", Nnf: "Non-Nuclear Fuel",
};

export const FACTOR_LABELS = {
  geology: "Geology / belt",
  nearDeposit: "Nearby deposits",
  rail: "Rail access",
  port: "Port access",
  tenure: "Tenure status",
  maturity: "Project maturity",
};

export const DEFAULT_WEIGHTS = { geology: 35, nearDeposit: 25, rail: 15, port: 10, tenure: 15, maturity: 20 };

/** Which factors each recommendation mode uses. */
export const MODE_FACTORS = {
  licences: ["geology", "nearDeposit", "rail", "port", "tenure"],
  sites: ["geology", "rail", "port", "maturity"],
  areas: ["geology", "nearDeposit", "rail", "port"],
};

// Distance (km) at which a proximity factor falls to zero.
export const DECAY_KM = { port: 600, rail: 150, nearDeposit: 75 };

export const MATURITY = {
  Operating: 1.0, Processing: 0.9, Development: 0.8, "Care & Maintenance": 0.6, Exploration: 0.4,
};
export const TENURE = { Active: 1.0, Application: 0.6, Inactive: 0.3 };

const linear = (km, max) => Math.max(0, 1 - km / max);

// ---------- context ----------

/** Build the shared scoring context. `licences`, `occurrences` and `regions` are optional. */
export function prepareContext({ infrastructure, belts, sites, boundary, licences, occurrences, regions }) {
  const infra = infrastructure.features;
  const ctx = {
    ports: infra.filter((f) => f.properties.kind === "port"),
    rail: infra.filter((f) => f.properties.kind === "rail"),
    towns: infra.filter((f) => f.properties.kind === "town"),
    protectedAreas: infra.filter((f) => f.properties.kind === "protected"),
    belts: belts.features,
    sites: sites.features,
    boundary,
    regions: regions?.features ?? [],
    licences: licences?.features ?? [],
    occurrences: occurrences?.features ?? [],
    _licenceCache: new Map(),
    _depositDistCache: new Map(),
  };
  // Known deposits = curated sites + USGS MRDS occurrences, in one shape.
  ctx.deposits = [
    ...ctx.sites.map((s) => ({
      name: s.properties.name, commodities: s.properties.commodities, status: s.properties.status,
      source: "Portal sites", id: s.properties.id, geometry: s.geometry,
    })),
    ...ctx.occurrences.map((o) => ({
      name: o.properties.name, commodities: o.properties.commodities, status: o.properties.devStatus,
      source: "USGS MRDS", id: o.properties.id, url: o.properties.url, geometry: o.geometry,
    })),
  ];
  return ctx;
}

const matchesCommodity = (list, target) => target === ANY || list.includes(target);
const beltMatches = (belt, target) => matchesCommodity(belt.properties.commodities, target);

function protectedAt(pt, ctx) {
  return ctx.protectedAreas.find((p) => pointInGeometry(pt, p.geometry)) || null;
}

export function regionAt(pt, ctx) {
  const r = ctx.regions.find((f) => pointInGeometry(pt, f.geometry));
  return r ? r.properties.shapeName : null;
}

function weightedTotal(factors, weights) {
  let sum = 0, wsum = 0;
  for (const [k, v] of Object.entries(factors)) {
    const w = weights[k] ?? 0;
    sum += w * v;
    wsum += w;
  }
  return wsum ? (100 * sum) / wsum : 0;
}

/** Deposits relevant to a mineral, nearest first. */
export function nearbyDeposits(pt, ctx, target = ANY, { limit = 5, maxKm = Infinity } = {}) {
  return ctx.deposits
    .filter((d) => matchesCommodity(d.commodities, target))
    .map((d) => ({ deposit: d, km: haversineKm(pt, d.geometry.coordinates) }))
    .filter((d) => d.km <= maxKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, limit);
}

function nearestDepositKm(pt, ctx, target) {
  let best = Infinity;
  for (const d of ctx.deposits) {
    if (!matchesCommodity(d.commodities, target)) continue;
    const km = haversineKm(pt, d.geometry.coordinates);
    if (km < best) best = km;
  }
  return best;
}

// ---------- licences ----------

/** Licence eligible for a mineral if one of its commodity groups covers it. */
export function licenceCovers(lic, target) {
  if (target === ANY) return true;
  const groups = MINERALS[target]?.groups ?? [];
  return lic.properties.groups.some((g) => groups.includes(g));
}

/** Minerals (of the 13) a licence's commodity groups allow. */
export function licenceMinerals(lic) {
  return MINERAL_NAMES.filter((m) => licenceCovers(lic, m));
}

/** Sample points: centroid + up to ~24 vertices of the largest polygon's outer ring. */
function samplePoints(lic) {
  const polys = lic.geometry.coordinates;
  let ring = polys[0][0];
  for (const p of polys) if (p[0].length > ring.length) ring = p[0];
  const step = Math.max(1, Math.floor(ring.length / 24));
  const pts = [lic.properties.c];
  for (let i = 0; i < ring.length - 1; i += step) pts.push(ring[i]);
  return pts;
}

/** Geometry-only facts about a licence, computed once and cached. */
function licenceFacts(lic, ctx) {
  const id = lic.properties.id;
  let f = ctx._licenceCache.get(id);
  if (f) return f;
  const pt = lic.properties.c;
  const samples = samplePoints(lic);
  // For each belt, the fraction of sample points inside it.
  const beltShare = ctx.belts
    .map((b) => ({ belt: b, share: samples.filter((s) => pointInGeometry(s, b.geometry)).length / samples.length }))
    .filter((x) => x.share > 0);
  f = {
    port: nearestPoint(pt, ctx.ports),
    rail: nearestLine(pt, ctx.rail),
    town: nearestPoint(pt, ctx.towns),
    region: regionAt(pt, ctx),
    protectedArea: protectedAt(pt, ctx)?.properties.name ?? null,
    beltShare,
  };
  ctx._licenceCache.set(id, f);
  return f;
}

function depositKmCached(lic, ctx, target) {
  const key = lic.properties.id + "|" + target;
  let km = ctx._depositDistCache.get(key);
  if (km === undefined) {
    km = nearestDepositKm(lic.properties.c, ctx, target);
    ctx._depositDistCache.set(key, km);
  }
  return km;
}

export function scoreLicence(lic, ctx, target = ANY, weights = DEFAULT_WEIGHTS) {
  const f = licenceFacts(lic, ctx);
  const relevantBelts = f.beltShare.filter((x) => beltMatches(x.belt, target));
  const geology = Math.min(1, relevantBelts.reduce((s, x) => s + x.share, 0));
  const depKm = depositKmCached(lic, ctx, target);
  const factors = {
    geology,
    nearDeposit: Number.isFinite(depKm) ? linear(depKm, DECAY_KM.nearDeposit) : 0,
    rail: linear(f.rail.km, DECAY_KM.rail),
    port: linear(f.port.km, DECAY_KM.port),
    tenure: TENURE[lic.properties.statusGroup] ?? 0.3,
  };
  const eligible = licenceCovers(lic, target);
  let score = eligible ? weightedTotal(factors, pick(weights, MODE_FACTORS.licences)) : 0;
  if (f.protectedArea) score *= 0.5;
  return {
    score, eligible, factors,
    details: {
      ...f,
      depositKm: depKm,
      belts: f.beltShare.map((x) => ({ name: x.belt.properties.name, share: x.share, relevant: beltMatches(x.belt, target) })),
    },
  };
}

/**
 * Rank licences for a mineral. `statusGroups` filters (e.g. ["Active","Application"]).
 * Returns eligible licences only, highest score first.
 */
export function rankLicences(ctx, target = ANY, weights = DEFAULT_WEIGHTS, { statusGroups = null } = {}) {
  const out = [];
  for (const lic of ctx.licences) {
    if (statusGroups && !statusGroups.includes(lic.properties.statusGroup)) continue;
    if (!licenceCovers(lic, target)) continue;
    out.push({ licence: lic, ...scoreLicence(lic, ctx, target, weights) });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------- known sites ----------

export function scoreSite(site, ctx, target = ANY, weights = DEFAULT_WEIGHTS) {
  const pt = site.geometry.coordinates;
  const p = site.properties;
  const hits = ctx.belts.filter((b) => pointInGeometry(pt, b.geometry));
  const relevant = hits.filter((b) => beltMatches(b, target));
  const port = nearestPoint(pt, ctx.ports);
  const rail = nearestLine(pt, ctx.rail);
  const prot = protectedAt(pt, ctx);
  const factors = {
    geology: relevant.length ? 1 : 0,
    rail: linear(rail.km, DECAY_KM.rail),
    port: linear(port.km, DECAY_KM.port),
    maturity: MATURITY[p.status] ?? 0.3,
  };
  const eligible = matchesCommodity(p.commodities, target);
  let score = eligible ? weightedTotal(factors, pick(weights, MODE_FACTORS.sites)) : 0;
  if (prot) score *= 0.5;
  return {
    score, eligible, factors,
    details: {
      port, rail, town: nearestPoint(pt, ctx.towns),
      belts: hits.map((b) => b.properties.name),
      protectedArea: prot?.properties.name ?? null,
    },
  };
}

export function rankSites(ctx, target = ANY, weights = DEFAULT_WEIGHTS) {
  return ctx.sites
    .map((site) => ({ site, ...scoreSite(site, ctx, target, weights) }))
    .sort((a, b) => b.eligible - a.eligible || b.score - a.score);
}

// ---------- open ground ----------

/**
 * Screen a regular grid for prospective ground NOT covered by an Active or Application licence
 * (as at the licence snapshot) and outside protected areas. Returns the top `limit` cells.
 */
export function rankAreas(ctx, target = ANY, weights = DEFAULT_WEIGHTS, { cellDeg = 0.25, limit = 25 } = {}) {
  const geom = ctx.boundary.features[0].geometry;
  const [minX, minY, maxX, maxY] = bbox(geom);
  const held = ctx.licences
    .filter((l) => l.properties.statusGroup !== "Inactive")
    .map((l) => ({ l, bb: bbox(l.geometry) }));
  const isHeld = ([x, y]) =>
    held.some(({ l, bb }) => x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3] && pointInGeometry([x, y], l.geometry));

  const w = pick(weights, MODE_FACTORS.areas);
  const cells = [];
  for (let x = minX; x < maxX; x += cellDeg) {
    for (let y = minY; y < maxY; y += cellDeg) {
      const pt = [x + cellDeg / 2, y + cellDeg / 2];
      if (!pointInGeometry(pt, geom) || protectedAt(pt, ctx)) continue;
      const relevant = ctx.belts.filter((b) => beltMatches(b, target) && pointInGeometry(pt, b.geometry));
      if (!relevant.length && w.geology > 0) continue; // only recommend prospective ground
      if (isHeld(pt)) continue;
      const port = nearestPoint(pt, ctx.ports);
      const rail = nearestLine(pt, ctx.rail);
      const depKm = nearestDepositKm(pt, ctx, target);
      const factors = {
        geology: relevant.length ? 1 : 0,
        nearDeposit: Number.isFinite(depKm) ? linear(depKm, DECAY_KM.nearDeposit) : 0,
        rail: linear(rail.km, DECAY_KM.rail),
        port: linear(port.km, DECAY_KM.port),
      };
      cells.push({
        center: pt,
        bounds: [[y, x], [y + cellDeg, x + cellDeg]], // Leaflet [lat, lon]
        score: weightedTotal(factors, w),
        factors,
        details: {
          port, rail,
          town: nearestPoint(pt, ctx.towns),
          region: regionAt(pt, ctx),
          belts: relevant.map((b) => b.properties.name),
          deposits: nearbyDeposits(pt, ctx, target, { limit: 3 }),
        },
      });
    }
  }
  return cells.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------- misc ----------

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k] ?? 0]));
}

/** Sorted unique list of commodities across curated sites. */
export function listCommodities(ctx) {
  const set = new Set();
  ctx.sites.forEach((s) => s.properties.commodities.forEach((c) => set.add(c)));
  return [...set].sort();
}

/** Number of licences per holder (for "holder portfolio" context). */
export function holderPortfolio(ctx) {
  const m = new Map();
  for (const l of ctx.licences) {
    const h = l.properties.holder;
    if (!h) continue;
    const e = m.get(h) || { total: 0, active: 0 };
    e.total++;
    if (l.properties.statusGroup === "Active") e.active++;
    m.set(h, e);
  }
  return m;
}

export { haversineKm };
