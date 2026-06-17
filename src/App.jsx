import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";
import {
  parseCSV,
  splitValues,
  hasCoords,
  typeColor,
  priceColor,
  googleLink,
  yelpLink,
  websiteLink,
  loadRatings,
  saveRating,
  clearRating,
} from "./helpers";

const LA_CENTER = [34.05, -118.33];

// Filterable columns. Multi-value fields are marked so filtering matches ANY value.
const FILTER_FIELDS = [
  { key: "activity_type", label: "Type", multi: false },
  { key: "price", label: "Price", multi: false },
  { key: "length", label: "Length", multi: false },
  { key: "best_time", label: "Best time", multi: true },
];

// Build a colored teardrop pin for a given activity type.
function makePinIcon(type) {
  return L.divIcon({
    className: "",
    html: `<div class="pin" style="background:${typeColor(type)}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 18],
    popupAnchor: [0, -16],
  });
}

export default function App() {
  const [view, setView] = useState("map"); // "map" | "ratings"
  const [activities, setActivities] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({});
  const [maxDrive, setMaxDrive] = useState(""); // "" = any; else minutes threshold
  const [ratings, setRatings] = useState(() => loadRatings());

  const mapRef = useRef(null);
  const mapEl = useRef(null);
  const markersRef = useRef(new Map());

  // ---- Load CSV once ----
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}activities.csv`)
      .then((r) => {
        if (!r.ok) throw new Error(`Could not load activities.csv (${r.status})`);
        return r.text();
      })
      .then((text) => setActivities(parseCSV(text)))
      .catch((e) => setLoadError(e.message));
  }, []);

  // ---- Build dropdown options from data (multi-value fields contribute each value) ----
  const filterOptions = useMemo(() => {
    const opts = {};
    for (const { key, multi } of FILTER_FIELDS) {
      const values = new Set();
      for (const a of activities) {
        if (multi) splitValues(a[key]).forEach((v) => values.add(v));
        else if (a[key]) values.add(a[key]);
      }
      opts[key] = [...values].sort();
    }
    return opts;
  }, [activities]);

  // ---- Apply search + filters ----
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activities.filter((a) => {
      if (q && !a.name?.toLowerCase().includes(q)) return false;
      for (const { key, multi } of FILTER_FIELDS) {
        const want = filters[key];
        if (!want) continue;
        if (multi) {
          if (!splitValues(a[key]).includes(want)) return false;
        } else if (a[key] !== want) {
          return false;
        }
      }
      // Drive-time threshold: keep rows whose estimate is <= the chosen max.
      // Rows with a blank drive estimate are kept only when no max is set.
      if (maxDrive) {
        const d = parseFloat(a.drive_min_from_dtla);
        if (Number.isNaN(d) || d > parseFloat(maxDrive)) return false;
      }
      return true;
    });
  }, [activities, search, filters, maxDrive]);

  // ---- Init map once (only when map view is mounted) ----
  useEffect(() => {
    if (view !== "map") return;
    if (mapRef.current || !mapEl.current) return;
    const map = L.map(mapEl.current).setView(LA_CENTER, 11);
    // CARTO Positron: clean basemap, no freeway exit shields, free, no key.
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; OpenStreetMap contributors &copy; CARTO',
        subdomains: "abcd",
        maxZoom: 20,
      }
    ).addTo(map);
    mapRef.current = map;
  }, [view]);

  // If we leave and return to the map view, Leaflet needs a size recalc.
  useEffect(() => {
    if (view === "map" && mapRef.current) {
      setTimeout(() => mapRef.current.invalidateSize(), 0);
    }
  }, [view]);

  // ---- Sync markers to filtered list ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || view !== "map") return;

    markersRef.current.forEach((m) => map.removeLayer(m));
    markersRef.current.clear();

    const withCoords = filtered.filter(hasCoords);
    withCoords.forEach((a) => {
      const lat = parseFloat(a.latitude);
      const lng = parseFloat(a.longitude);
      const marker = L.marker([lat, lng], { icon: makePinIcon(a.activity_type) }).addTo(map);
      const meta = [a.activity_type, a.price, a.length].filter(Boolean).join(" · ");
      marker.bindPopup(
        `<div class="popup-name">${a.name}</div>
         <div class="popup-meta">${meta}</div>
         <div class="popup-links">
           <a href="${googleLink(a.name)}" target="_blank" rel="noopener">Google</a>
           <a href="${yelpLink(a.name)}" target="_blank" rel="noopener">Yelp</a>
         </div>`
      );
      markersRef.current.set(a.name, marker);
    });

    if (withCoords.length > 0 && (search || maxDrive || Object.values(filters).some(Boolean))) {
      const bounds = L.latLngBounds(
        withCoords.map((a) => [parseFloat(a.latitude), parseFloat(a.longitude)])
      );
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
    }
  }, [filtered, search, filters, view]);

  function handleResultClick(a) {
    if (!hasCoords(a) || view !== "map") return;
    const map = mapRef.current;
    const marker = markersRef.current.get(a.name);
    map.setView([parseFloat(a.latitude), parseFloat(a.longitude)], 15);
    if (marker) marker.openPopup();
  }

  const anyFilterActive = search || maxDrive || Object.values(filters).some(Boolean);
  const plottedCount = filtered.filter(hasCoords).length;

  // ---------- Ratings view ----------
  if (view === "ratings") {
    const rated = Object.entries(ratings).sort((a, b) => b[1].ts - a[1].ts);
    return (
      <div className="app">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="brand-row">
              <h1>LA Activities</h1>
              <button className="nav-toggle" onClick={() => setView("map")}>
                ← Map
              </button>
            </div>
            <div className="count">{rated.length} rated on this device</div>
          </div>
          <div className="results">
            <div className="empty" style={{ textAlign: "left", padding: "12px" }}>
              Your ratings are saved only in this browser, on this device. They
              aren't shared and won't appear on another device.
            </div>
          </div>
        </aside>
        <div className="ratings-page">
          <h2>My Ratings</h2>
          <div className="sub">Places you've rated, most recent first.</div>
          {rated.length === 0 && (
            <div className="empty">
              No ratings yet. Open the map, pick a place, and rate it.
            </div>
          )}
          {rated.map(([name, entry]) => (
            <div className="rating-item" key={name}>
              <div className="name">{name}</div>
              {entry.rating > 0 && (
                <div className="stars">{"★".repeat(entry.rating)}{"☆".repeat(5 - entry.rating)}</div>
              )}
              {entry.visited && <div className="meta">✓ Visited</div>}
              {entry.comment && <div className="comment">{entry.comment}</div>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ---------- Map view ----------
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand-row">
            <h1>LA Activities</h1>
            <button className="nav-toggle" onClick={() => setView("ratings")}>
              My Ratings →
            </button>
          </div>
          <div className="count">
            {filtered.length} shown · {plottedCount} on map
          </div>
        </div>

        <div className="controls">
          <input
            className="search-input"
            type="text"
            placeholder="Search activities…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="filter-row">
            {FILTER_FIELDS.map(({ key, label }) => (
              <select
                key={key}
                className="filter-select"
                value={filters[key] || ""}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, [key]: e.target.value }))
                }
              >
                <option value="">{label}: all</option>
                {(filterOptions[key] || []).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ))}
            <select
              className="filter-select"
              value={maxDrive}
              onChange={(e) => setMaxDrive(e.target.value)}
            >
              <option value="">Drive: any</option>
              <option value="15">≤ 15 min</option>
              <option value="30">≤ 30 min</option>
              <option value="45">≤ 45 min</option>
              <option value="60">≤ 60 min</option>
              <option value="120">≤ 2 hrs</option>
            </select>
          </div>
          {anyFilterActive && (
            <button
              className="clear-btn"
              onClick={() => {
                setSearch("");
                setFilters({});
                setMaxDrive("");
              }}
            >
              Clear all
            </button>
          )}
        </div>

        <div className="results">
          {loadError && <div className="empty">{loadError}</div>}
          {!loadError && filtered.length === 0 && (
            <div className="empty">No activities match. Try clearing filters.</div>
          )}
          {filtered.map((a, i) => {
            const plottable = hasCoords(a);
            const times = splitValues(a.best_time);
            const mine = ratings[a.name];
            return (
              <div
                key={a.name + i}
                className={`result-card ${plottable ? "" : "no-coords"}`}
                onClick={() => handleResultClick(a)}
              >
                <div className="result-name">
                  {a.name}
                  {mine?.rating > 0 && <span className="my-star">★ {mine.rating}</span>}
                  {a.visited === "yes" && <span className="visited-dot">✓</span>}
                </div>
                <div className="result-meta">
                  {a.activity_type && (
                    <span className="type-tag">
                      <span
                        className="type-dot"
                        style={{ background: typeColor(a.activity_type) }}
                      />
                      {a.activity_type}
                    </span>
                  )}
                  {a.price && (
                    <span className="price-chip" style={{ background: priceColor(a.price) }}>
                      {a.price}
                    </span>
                  )}
                  {a.length && <span>{a.length}</span>}
                  {times.length > 0 && <span className="time-vals">{times.join(" / ")}</span>}
                  {a.drive_min_from_dtla && (
                    <span className="time-vals">~{a.drive_min_from_dtla} min</span>
                  )}
                  {!plottable && <span className="no-loc-label">no location yet</span>}
                </div>
                <div className="links-row" onClick={(e) => e.stopPropagation()}>
                  {websiteLink(a) && (
                    <a className="ext-link" href={websiteLink(a)} target="_blank" rel="noopener">
                      Website ↗
                    </a>
                  )}
                  <a className="ext-link" href={googleLink(a.name)} target="_blank" rel="noopener">
                    Google ↗
                  </a>
                  <a className="ext-link" href={yelpLink(a.name)} target="_blank" rel="noopener">
                    Yelp ↗
                  </a>
                </div>

                <div className="rate-block" onClick={(e) => e.stopPropagation()}>
                  <div className="star-row">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        className={`star ${mine?.rating >= n ? "filled" : ""}`}
                        onClick={() => setRatings(saveRating(a.name, { rating: n }))}
                        aria-label={`${n} star${n > 1 ? "s" : ""}`}
                      >
                        ★
                      </button>
                    ))}
                  </div>
                  <label className="visited-toggle">
                    <input
                      type="checkbox"
                      checked={!!mine?.visited}
                      onChange={(e) =>
                        setRatings(saveRating(a.name, { visited: e.target.checked }))
                      }
                    />
                    I've been here
                  </label>
                  <textarea
                    className="comment-input"
                    placeholder="Add a note…"
                    defaultValue={mine?.comment || ""}
                    onBlur={(e) => {
                      if (e.target.value !== (mine?.comment || "")) {
                        setRatings(saveRating(a.name, { comment: e.target.value }));
                      }
                    }}
                  />
                  {mine && (
                    <div className="rate-actions">
                      <button
                        className="rate-clear"
                        onClick={() => setRatings(clearRating(a.name))}
                      >
                        Clear my rating
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      <div className="map" ref={mapEl} />
    </div>
  );
}
