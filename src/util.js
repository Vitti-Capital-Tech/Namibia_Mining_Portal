export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const fmtKm = (km) => (!Number.isFinite(km) ? "—" : (km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString()) + " km");

export const fmtDate = (d) =>
  d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";

export const COMMODITY_COLORS = {
  Uranium: "#9bbd1c", Gold: "#e0a100", Diamonds: "#3aa7d6", Copper: "#c8642e",
  Zinc: "#6f86a6", Lead: "#5d5d82", Silver: "#a9b3bd", Lithium: "#a457c4",
  Tin: "#7f9296", Tantalum: "#556b6f", "Rare Earths": "#d6457f", Graphite: "#4a4a4a",
  Fluorspar: "#2f9c80", Manganese: "#8b5a3c", Limestone: "#bfa77f", Salt: "#9fb6c4",
  Vanadium: "#7a3f8f", Molybdenum: "#4f7a5a",
};
export const colorFor = (c) => COMMODITY_COLORS[c] || "#888";

export const STATUS_GROUP_COLORS = { Active: "#2f8f5b", Application: "#3a7bd5", Inactive: "#9a9a9a" };

export const SCORE_RAMP = ["#fde7c8", "#f6b26b", "#e07b2c", "#b5461a", "#7a1f0c"];
export const rampColor = (s) => SCORE_RAMP[Math.min(SCORE_RAMP.length - 1, Math.floor((s / 100) * SCORE_RAMP.length))];

/**
 * Describe a licence's expiry position relative to the data snapshot and today.
 * Returns { label, tone } where tone is good | warn | bad | muted.
 */
export function expiryPosition(props, snapshot, today = new Date().toISOString().slice(0, 10)) {
  const exp = props.expires;
  if (props.statusGroup === "Application") return { label: "Application – not yet granted (at snapshot)", tone: "muted" };
  if (!exp) return { label: "No expiry date recorded", tone: "muted" };
  if (props.statusGroup === "Inactive") return { label: `Inactive (${props.status}); ground may be open`, tone: "muted" };
  if (exp < snapshot) return { label: `Expired ${fmtDate(exp)} – renewal pending at snapshot`, tone: "warn" };
  if (exp < today) return { label: `Expiry date ${fmtDate(exp)} has passed – check renewal`, tone: "warn" };
  const months = Math.round((new Date(exp) - new Date(today)) / (30.44 * 864e5));
  return { label: `Expires ${fmtDate(exp)} (${months} months left)`, tone: months < 12 ? "warn" : "good" };
}

export function download(filename, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toCSV(rows) {
  const cell = (v) => {
    const s = Array.isArray(v) ? v.join("; ") : String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  return [keys.join(","), ...rows.map((r) => keys.map((k) => cell(r[k])).join(","))].join("\n");
}
