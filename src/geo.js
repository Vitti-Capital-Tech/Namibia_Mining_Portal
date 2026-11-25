// Lightweight geometry helpers (no dependencies). Coordinates are GeoJSON [lon, lat].

const R_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in km between two [lon, lat] points. */
export function haversineKm([lon1, lat1], [lon2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(a));
}

/** Ray-casting test for a point inside a single linear ring. */
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inPolygonCoords(pt, rings) {
  if (!inRing(pt, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(pt, rings[k])) return false; // holes
  return true;
}

/** True if [lon, lat] lies inside a GeoJSON Polygon/MultiPolygon geometry. */
export function pointInGeometry(pt, geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return inPolygonCoords(pt, geometry.coordinates);
  if (geometry.type === "MultiPolygon")
    return geometry.coordinates.some((poly) => inPolygonCoords(pt, poly));
  return false;
}

/**
 * Approximate shortest distance (km) from a point to a LineString / MultiLineString.
 * Uses a local equirectangular projection around the point, which is accurate to well
 * under 1% at the scales used here (< ~1000 km).
 */
export function distanceToLineKm(pt, geometry) {
  const lines =
    geometry.type === "LineString" ? [geometry.coordinates] :
    geometry.type === "MultiLineString" ? geometry.coordinates : [];
  const kx = R_KM * toRad(1) * Math.cos(toRad(pt[1]));
  const ky = R_KM * toRad(1);
  const project = ([lon, lat]) => [(lon - pt[0]) * kx, (lat - pt[1]) * ky];
  let best = Infinity;
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, ay] = project(line[i]);
      const [bx, by] = project(line[i + 1]);
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Nearest feature (by point distance) from a list of Point features. */
export function nearestPoint(pt, features) {
  let best = null;
  for (const f of features) {
    const d = haversineKm(pt, f.geometry.coordinates);
    if (!best || d < best.km) best = { feature: f, km: d };
  }
  return best;
}

/** Nearest line feature and its distance. */
export function nearestLine(pt, features) {
  let best = null;
  for (const f of features) {
    const d = distanceToLineKm(pt, f.geometry);
    if (!best || d < best.km) best = { feature: f, km: d };
  }
  return best;
}

/** Bounding box [minLon, minLat, maxLon, maxLat] of any GeoJSON geometry. */
export function bbox(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    } else c.forEach(walk);
  };
  walk(geometry.coordinates);
  return [minX, minY, maxX, maxY];
}
