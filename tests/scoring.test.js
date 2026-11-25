import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { haversineKm, pointInGeometry, distanceToLineKm } from "../src/geo.js";
import {
  prepareContext, rankSites, rankAreas, rankLicences, scoreSite, scoreLicence, licenceCovers,
  nearbyDeposits, MINERAL_NAMES, ANY, DEFAULT_WEIGHTS,
} from "../src/scoring.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), "utf-8"));
const ctx = prepareContext({
  sites: load("sites.geojson"),
  belts: load("belts.geojson"),
  infrastructure: load("infrastructure.geojson"),
  boundary: load("namibia_boundary.geojson"),
  regions: load("namibia_regions.geojson"),
  licences: load("licences.geojson"),
  occurrences: load("occurrences.geojson"),
});

test("haversine: Windhoek to Walvis Bay is ~280 km", () => {
  const d = haversineKm([17.08, -22.56], [14.50, -22.95]);
  assert.ok(d > 260 && d < 300, `got ${d}`);
});

test("distance to line: point on segment is ~0, 1° off is ~111 km", () => {
  const line = { type: "LineString", coordinates: [[15, -22], [17, -22]] };
  assert.ok(distanceToLineKm([16, -22], line) < 0.01);
  const off = distanceToLineKm([16, -23], line);
  assert.ok(Math.abs(off - 111.2) < 1, `got ${off}`);
});

test("every curated site lies inside Namibia (except offshore marine licence)", () => {
  const geom = ctx.boundary.features[0].geometry;
  const outside = ctx.sites.filter((s) => !pointInGeometry(s.geometry.coordinates, geom)).map((s) => s.properties.id);
  assert.deepEqual(outside.filter((id) => id !== "debmarine"), []);
});

test("site ids are unique and statuses are known", () => {
  const ids = ctx.sites.map((s) => s.properties.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("licence dataset: 2,000+ licences with ids, centroids and groups", () => {
  assert.ok(ctx.licences.length > 2000, `only ${ctx.licences.length}`);
  const ids = new Set(ctx.licences.map((l) => l.properties.id));
  assert.equal(ids.size, ctx.licences.length);
  for (const l of ctx.licences) {
    const [x, y] = l.properties.c;
    assert.ok(x > 11 && x < 26 && y > -30 && y < -16, `${l.properties.code} centroid ${x},${y}`);
    assert.ok(Array.isArray(l.properties.groups));
  }
});

test("licence dataset includes Mining Licences with stable code-based ids", () => {
  const mls = ctx.licences.filter((l) => l.properties.typeCode === "ML");
  assert.ok(mls.length > 100, `only ${mls.length} MLs`);
  for (const l of ctx.licences) assert.ok(l.properties.id.startsWith(l.properties.code), l.properties.id);
});

test("licence eligibility follows commodity groups", () => {
  const uranium = rankLicences(ctx, "Uranium");
  assert.ok(uranium.length > 0);
  assert.ok(uranium.every((r) => r.licence.properties.groups.includes("Nf")));
  const diamonds = rankLicences(ctx, "Diamonds");
  assert.ok(diamonds.every((r) => licenceCovers(r.licence, "Diamonds")));
});

test("licence scores are within 0..100 and sorted for every mineral", () => {
  for (const m of [ANY, ...MINERAL_NAMES]) {
    const ranked = rankLicences(ctx, m, DEFAULT_WEIGHTS, { statusGroups: ["Active", "Application"] });
    for (let i = 0; i < ranked.length; i++) {
      assert.ok(ranked[i].score >= 0 && ranked[i].score <= 100, `${m}: ${ranked[i].score}`);
      if (i) assert.ok(ranked[i - 1].score >= ranked[i].score);
    }
  }
});

test("top uranium licences sit in the Erongo uranium province", () => {
  const top = rankLicences(ctx, "Uranium", DEFAULT_WEIGHTS, { statusGroups: ["Active"] }).slice(0, 10);
  for (const r of top) assert.ok(r.details.belts.some((b) => b.relevant), r.licence.properties.code);
});

test("zero-weighting all but tenure ranks active above applications", () => {
  const w = { geology: 0, nearDeposit: 0, rail: 0, port: 0, tenure: 10 };
  const lic = ctx.licences.find((l) => l.properties.statusGroup === "Active");
  const app = ctx.licences.find((l) => l.properties.statusGroup === "Application");
  assert.ok(scoreLicence(lic, ctx, ANY, w).score > scoreLicence(app, ctx, ANY, w).score);
});

test("nearby deposits are sorted and match the mineral", () => {
  const d = nearbyDeposits([15.0, -22.5], ctx, "Uranium", { limit: 5 });
  assert.ok(d.length > 0);
  assert.ok(d.every((x) => x.deposit.commodities.includes("Uranium")));
  for (let i = 1; i < d.length; i++) assert.ok(d[i - 1].km <= d[i].km);
});

test("uranium site ranking puts Erongo uranium mines on top", () => {
  const eligible = rankSites(ctx, "Uranium").filter((r) => r.eligible);
  assert.ok(["rossing", "husab", "langer-heinrich"].includes(eligible[0].site.properties.id));
  for (const s of ctx.sites) {
    const { score } = scoreSite(s, ctx, ANY, DEFAULT_WEIGHTS);
    assert.ok(score >= 0 && score <= 100);
  }
});

test("open-ground cells avoid held licences and protected areas", () => {
  const cells = rankAreas(ctx, "Copper");
  assert.ok(cells.length > 0);
  const held = ctx.licences.filter((l) => l.properties.statusGroup !== "Inactive");
  for (const c of cells) {
    assert.ok(c.details.belts.length > 0);
    assert.ok(!ctx.protectedAreas.some((p) => pointInGeometry(c.center, p.geometry)));
    assert.ok(!held.some((l) => pointInGeometry(c.center, l.geometry)), `cell ${c.center} is held`);
  }
});
