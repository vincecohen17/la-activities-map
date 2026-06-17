// helpers.js — pure logic, kept out of the component so it's easy to reason about.

// ---------- CSV parsing (handles quoted fields with commas) ----------
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (cells[idx] ?? "").trim();
    });
    return obj;
  });
}

// ---------- Multi-value fields ----------
// A cell like "Morning, Evening" becomes ["Morning", "Evening"].
export function splitValues(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- Coordinates present? ----------
export function hasCoords(a) {
  return (
    a.latitude &&
    a.longitude &&
    !Number.isNaN(parseFloat(a.latitude)) &&
    !Number.isNaN(parseFloat(a.longitude))
  );
}

// ---------- Activity-type color ----------
// Keys match the CSS custom properties; kept in JS too so pins can be colored.
const TYPE_COLORS = {
  Restaurant: "#e4572e",
  Bar: "#8e44ad",
  Cafe: "#c9863e",
  Hike: "#3a7d44",
  Outdoors: "#2e8b8b",
  Museum: "#3b6ea5",
  Activity: "#d4a017",
  Shopping: "#c2407a",
  "Day trip": "#5566cc",
};
export function typeColor(type) {
  return TYPE_COLORS[type] || "#777777";
}
export const TYPE_LEGEND = TYPE_COLORS;

// ---------- Price color scale (green -> red) ----------
// Free is its own green; $..$$$$ ramps green->red.
export function priceColor(price) {
  switch ((price || "").trim()) {
    case "Free":
      return "#2e8b57";
    case "$":
      return "#4ca64c";
    case "$$":
      return "#c8a415";
    case "$$$":
      return "#dd7711";
    case "$$$$":
      return "#cc3322";
    default:
      return "#888888";
  }
}

// ---------- External links (auto-built from the name) ----------
export function googleLink(name) {
  return `https://www.google.com/search?q=${encodeURIComponent(name + " Los Angeles")}`;
}
export function yelpLink(name) {
  return `https://www.yelp.com/search?find_desc=${encodeURIComponent(
    name
  )}&find_loc=Los+Angeles%2C+CA`;
}
// Uses the activity's own stored website if the CSV cell is filled; otherwise
// falls back to a Google search. So a blank website column still yields a
// working link, and a filled one gives the exact page.
export function websiteLink(a) {
  const url = (a.website || "").trim();
  if (!url) return null;
  // tolerate cells pasted without a scheme
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// ---------- localStorage ratings store ----------
// Shape: { [activityName]: { rating: 1-5, comment: string, visited: bool, ts: number } }
const STORE_KEY = "la_activities_ratings_v1";

export function loadRatings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveRating(name, entry) {
  const all = loadRatings();
  all[name] = { ...all[name], ...entry, ts: Date.now() };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch (e) {
    console.error("Could not save rating:", e);
  }
  return all;
}

export function clearRating(name) {
  const all = loadRatings();
  delete all[name];
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch (e) {
    console.error("Could not clear rating:", e);
  }
  return all;
}
