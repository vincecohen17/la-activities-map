import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";
import {
  parseCSV,
  splitValues,
  hasCoords,
  typeColor,
  primaryType,
  subCategory,
  priceColor,
  buildTypeGroups,
  matchesTypeSelection,
  googleLink,
  yelpLink,
  websiteLink,
  loadRatings,
  saveRating,
  clearRating,
} from "./helpers";

const LA_CENTER = [34.05, -118.33];

// Simple (non-type) multi-select chip filters. Each maps to a CSV column.
// `multi` means the cell itself can hold comma-separated values (best_time),
// so a row matches if ANY of its values is among the selected chips.
const CHIP_FILTERS = [
  { key: "price", label: "Price" },
  { key: "length", label: "Length" },
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
  const [mobilePane, setMobilePane] = useState("list"); // mobile only: "list" | "map"
  const [mapReady, setMapReady] = useState(false);
  const [activities, setActivities] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [search, setSearch] = useState("");
  // Multi-select filter state. Types/genres are Sets of strings; chipFilters is
  // an object of { columnKey: Set(values) }. Empty set = no constraint.
  const [selectedTypes, setSelectedTypes] = useState(() => new Set());
  const [selectedGenres, setSelectedGenres] = useState(() => new Set());
  const [chipFilters, setChipFilters] = useState({}); // key -> Set(values)
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

  // ---- Grouped type structure (type -> its genres) for the Type chip group ----
  const typeGroups = useMemo(() => buildTypeGroups(activities), [activities]);

  // ---- Distinct values for each simple chip filter ----
  const chipOptions = useMemo(() => {
    const opts = {};
    for (const f of CHIP_FILTERS) {
      const values = new Set();
      for (const a of activities) {
        const raw = a[f.key];
        if (f.multi) splitValues(raw).forEach((v) => values.add(v));
        else if (raw) values.add(raw);
      }
      opts[f.key] = [...values].sort();
    }
    return opts;
  }, [activities]);

  // ---- Toggle helpers (return a NEW Set so React re-renders) ----
  function toggleInSet(setter, value) {
    setter((prev) => {
      const next = new Set(prev);
      next.has(value) ? next.delete(value) : next.add(value);
      return next;
    });
  }
  function toggleChip(key, value) {
    setChipFilters((prev) => {
      const cur = new Set(prev[key] || []);
      cur.has(value) ? cur.delete(value) : cur.add(value);
      return { ...prev, [key]: cur };
    });
  }

  // ---- Apply search + all filters ----
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activities.filter((a) => {
      if (q && !a.name?.toLowerCase().includes(q)) return false;

      // Type/genre group (OR within, see matchesTypeSelection).
      if (!matchesTypeSelection(a, selectedTypes, selectedGenres)) return false;

      // Each simple chip filter: OR within a filter, AND across filters.
      for (const f of CHIP_FILTERS) {
        const sel = chipFilters[f.key];
        if (!sel || sel.size === 0) continue;
        if (f.multi) {
          const vals = splitValues(a[f.key]);
          if (!vals.some((v) => sel.has(v))) return false;
        } else {
          if (!sel.has(a[f.key])) return false;
        }
      }

      // Drive-time threshold.
      if (maxDrive) {
        const d = parseFloat(a.drive_min_from_dtla);
        if (Number.isNaN(d) || d > parseFloat(maxDrive)) return false;
      }
      return true;
    });
  }, [activities, search, selectedTypes, selectedGenres, chipFilters, maxDrive]);

  // ---- Create the map when the map view mounts; destroy it when leaving. ----
  // Destroying on leave is essential: when view switches to "ratings", React
  // unmounts the map container. If we kept the old Leaflet instance, on return
  // it would be bound to a destroyed DOM node and render blank. So we tear it
  // down and rebuild fresh each time the map view appears.
  useEffect(() => {
    if (view !== "map") return;
    if (!mapEl.current) return;

    const map = L.map(mapEl.current).setView(LA_CENTER, 11);
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      {
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
        subdomains: "abcd",
        maxZoom: 20,
      }
    ).addTo(map);
    mapRef.current = map;
    setMapReady(true);
    // Recalc size on the next tick once the container has its real dimensions.
    setTimeout(() => map.invalidateSize(), 0);

    return () => {
      map.remove();              // tear down Leaflet + its DOM/handlers
      mapRef.current = null;     // clear the ref so a fresh map is built on return
      markersRef.current.clear();
      setMapReady(false);
    };
  }, [view]);

  // Recalc size when the mobile pane flips to the map (container becomes visible).
  useEffect(() => {
    if (view === "map" && mapRef.current) {
      setTimeout(() => mapRef.current.invalidateSize(), 0);
    }
  }, [mobilePane]);

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
      const meta = [primaryType(a.activity_type), subCategory(a.activity_type), a.price, a.length]
        .filter(Boolean)
        .join(" · ");
      const site = websiteLink(a);
      const siteLink = site
        ? `<a href="${site}" target="_blank" rel="noopener">Website</a>`
        : "";
      marker.bindPopup(
        `<div class="popup-name">${a.name}</div>
         <div class="popup-meta">${meta}</div>
         <div class="popup-links">
           ${siteLink}
           <a href="${googleLink(a.name)}" target="_blank" rel="noopener">Google</a>
           <a href="${yelpLink(a.name)}" target="_blank" rel="noopener">Yelp</a>
         </div>`
      );
      markersRef.current.set(a.name, marker);
    });

    const filtersOn =
      search ||
      maxDrive ||
      selectedTypes.size > 0 ||
      selectedGenres.size > 0 ||
      Object.values(chipFilters).some((s) => s && s.size > 0);
    if (withCoords.length > 0 && filtersOn) {
      const bounds = L.latLngBounds(
        withCoords.map((a) => [parseFloat(a.latitude), parseFloat(a.longitude)])
      );
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
    }
  }, [filtered, search, selectedTypes, selectedGenres, chipFilters, maxDrive, view, mapReady]);

  function handleResultClick(a) {
    if (!hasCoords(a) || view !== "map") return;
    // On mobile the map is behind the List tab; surface it so the pin is visible.
    setMobilePane("map");
    const map = mapRef.current;
    const marker = markersRef.current.get(a.name);
    const lat = parseFloat(a.latitude);
    const lng = parseFloat(a.longitude);
    // Defer so the map pane is visible/sized (esp. on mobile) before centering.
    setTimeout(() => {
      map.invalidateSize();
      map.setView([lat, lng], 15);
      if (marker) marker.openPopup();
    }, 50);
  }

  const anyChipActive = Object.values(chipFilters).some((s) => s && s.size > 0);
  const anyFilterActive =
    search || maxDrive || selectedTypes.size > 0 || selectedGenres.size > 0 || anyChipActive;
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
    <>
      <div className="mobile-tabs">
        <button
          className={`mobile-tab ${mobilePane === "list" ? "active" : ""}`}
          onClick={() => setMobilePane("list")}
        >
          List
        </button>
        <button
          className={`mobile-tab ${mobilePane === "map" ? "active" : ""}`}
          onClick={() => setMobilePane("map")}
        >
          Map
        </button>
      </div>
      <div className="app">
        <aside className={`sidebar ${mobilePane === "map" ? "mobile-hidden" : ""}`}>
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

          {/* Grouped Type filter: type header chips with genre chips indented. */}
          <div className="chip-group">
            <div className="chip-group-label">Type</div>
            {typeGroups.map(({ type, genres }) => (
              <div className="type-block" key={type}>
                <button
                  className={`chip type-chip ${selectedTypes.has(type) ? "on" : ""}`}
                  style={
                    selectedTypes.has(type)
                      ? { background: typeColor(type), borderColor: typeColor(type) }
                      : { borderColor: typeColor(type) }
                  }
                  onClick={() => toggleInSet(setSelectedTypes, type)}
                >
                  <span className="chip-dot" style={{ background: typeColor(type) }} />
                  {type}
                </button>
                {genres.length > 0 && (
                  <div className="genre-chips">
                    {genres.map((g) => {
                      const id = `${type}|${g}`;
                      return (
                        <button
                          key={id}
                          className={`chip genre-chip ${selectedGenres.has(id) ? "on" : ""}`}
                          onClick={() => toggleInSet(setSelectedGenres, id)}
                        >
                          {g}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Simple multi-select chip filters: price, length, best time. */}
          {CHIP_FILTERS.map((f) => {
            const options = chipOptions[f.key] || [];
            if (options.length === 0) return null;
            const sel = chipFilters[f.key] || new Set();
            return (
              <div className="chip-group" key={f.key}>
                <div className="chip-group-label">{f.label}</div>
                <div className="chip-row">
                  {options.map((v) => (
                    <button
                      key={v}
                      className={`chip ${sel.has(v) ? "on" : ""}`}
                      onClick={() => toggleChip(f.key, v)}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Drive time stays a threshold dropdown (ordinal, not multi-select). */}
          <div className="chip-group">
            <div className="chip-group-label">Max drive from DTLA</div>
            <select
              className="filter-select"
              value={maxDrive}
              onChange={(e) => setMaxDrive(e.target.value)}
            >
              <option value="">Any</option>
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
                setSelectedTypes(new Set());
                setSelectedGenres(new Set());
                setChipFilters({});
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
                      {primaryType(a.activity_type)}
                    </span>
                  )}
                  {subCategory(a.activity_type) && (
                    <span className="genre-label">{subCategory(a.activity_type)}</span>
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

      <div
        className={`map ${mobilePane === "list" ? "mobile-hidden" : ""}`}
        ref={mapEl}
      />
      </div>
    </>
  );
}
