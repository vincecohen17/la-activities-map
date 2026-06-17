#!/usr/bin/env python3
"""
geocode.py — fills latitude/longitude for an activities CSV using
OpenStreetMap's Nominatim (free, no API key).

Usage:
    python3 geocode.py activities_seed.csv activities.csv

- Reads the input CSV.
- For every row with BLANK latitude/longitude, looks up `geocode_query`.
- Writes results to the output CSV.
- Rows it couldn't resolve confidently get coords left blank and a note
  added to the `notes` column so you can fix them by hand.

Re-running is safe: rows that already have coordinates are skipped, so any
you correct manually won't be overwritten.

Nominatim usage policy (important — don't remove the throttle or header):
  https://operations.osmfoundation.org/policies/nominatim/
  - Max 1 request/second  -> enforced by time.sleep below
  - A valid User-Agent identifying your app is required
"""

import csv
import sys
import time
import json
import urllib.parse
import urllib.request

# ---- EDIT THIS: put a real contact (email or repo URL) per Nominatim policy ----
USER_AGENT = "LA-Activities-Map/1.0 (vincecohen17 on GitHub)"
# --------------------------------------------------------------------------------

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

# Rough bounding box for the greater LA area (south,west,north,east-ish).
# Used only as a sanity check to FLAG suspicious results, not to reject them —
# day trips like Ojai/Catalina legitimately fall outside it.
LA_BOUNDS = {"lat_min": 33.5, "lat_max": 34.5, "lon_min": -119.0, "lon_max": -117.5}


def geocode(query):
    """Return (lat, lon, display_name, raw_importance) or None."""
    params = {
        "q": query,
        "format": "json",
        "limit": 1,
        "addressdetails": 0,
    }
    url = f"{NOMINATIM_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.load(resp)
    except Exception as e:
        print(f"    ! request failed: {e}")
        return None
    if not data:
        return None
    top = data[0]
    return (
        float(top["lat"]),
        float(top["lon"]),
        top.get("display_name", ""),
        float(top.get("importance", 0)),
    )


def in_la_bounds(lat, lon):
    return (
        LA_BOUNDS["lat_min"] <= lat <= LA_BOUNDS["lat_max"]
        and LA_BOUNDS["lon_min"] <= lon <= LA_BOUNDS["lon_max"]
    )


def main():
    if len(sys.argv) != 3:
        print("Usage: python3 geocode.py <input.csv> <output.csv>")
        sys.exit(1)

    in_path, out_path = sys.argv[1], sys.argv[2]

    with open(in_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
        fieldnames = list(rows[0].keys()) if rows else []

    for field in ("latitude", "longitude", "geocode_query", "notes"):
        if field not in fieldnames:
            print(f"ERROR: input CSV is missing required column '{field}'")
            sys.exit(1)

    resolved, skipped, failed = 0, 0, 0

    for i, row in enumerate(rows, 1):
        name = row.get("name", "(unnamed)")

        # Already has coordinates -> leave it alone.
        if row["latitude"].strip() and row["longitude"].strip():
            print(f"[{i}/{len(rows)}] {name}: already has coords, skipping")
            skipped += 1
            continue

        query = row["geocode_query"].strip()
        if not query:
            print(f"[{i}/{len(rows)}] {name}: no geocode_query, skipping")
            row["notes"] = (row.get("notes", "") + " | NO QUERY").strip(" |")
            failed += 1
            continue

        print(f"[{i}/{len(rows)}] {name}: looking up \"{query}\"")
        result = geocode(query)
        time.sleep(1.1)  # Nominatim: max 1 req/sec. Do not lower.

        if result is None:
            print("    -> no result, left blank for manual fix")
            row["notes"] = (row.get("notes", "") + " | GEOCODE FAILED").strip(" |")
            failed += 1
            continue

        lat, lon, display, importance = result
        row["latitude"] = f"{lat:.6f}"
        row["longitude"] = f"{lon:.6f}"
        resolved += 1
        print(f"    -> {lat:.5f}, {lon:.5f}")

        flags = []
        if not in_la_bounds(lat, lon):
            flags.append("OUTSIDE LA BOUNDS (ok for day trips, verify others)")
        # NOTE: we deliberately do NOT flag on Nominatim's "importance" score.
        # importance measures global fame (a country ranks high, a neighborhood
        # taco shop ranks low), not match correctness — so a perfect hit on a
        # small venue scores low and would false-alarm. The matched display name
        # is recorded below so you can eyeball correctness yourself.
        if flags:
            note = "; ".join(flags) + f" [matched: {display[:60]}]"
            row["notes"] = (row.get("notes", "") + " | " + note).strip(" |")
            print(f"    !! {note}")
        else:
            # Always record what it matched, so every pin is checkable.
            row["notes"] = (row.get("notes", "") + f" | matched: {display[:50]}").strip(" |")

    # Normalize every row to exactly the header fields. DictReader can pick up
    # stray keys (e.g. from trailing commas / ragged rows); extrasaction="ignore"
    # plus this rebuild guarantees the writer never sees an unexpected field.
    clean_rows = [{k: row.get(k, "") for k in fieldnames} for row in rows]

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(clean_rows)

    print("\n" + "=" * 50)
    print(f"Done. Wrote {out_path}")
    print(f"  resolved this run: {resolved}")
    print(f"  skipped (had coords): {skipped}")
    print(f"  failed/blank: {failed}")
    if failed:
        print("  -> search the notes column for FAILED / NO QUERY and fix by hand")
    print("  -> also eyeball any row flagged LOW CONFIDENCE or OUTSIDE LA BOUNDS")


if __name__ == "__main__":
    main()
