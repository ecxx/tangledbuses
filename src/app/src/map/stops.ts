// prod_design 5.3: the stops source. One point for each stop.
import type { FeatureCollection, Point } from "geojson";
import type { Core } from "../data/load";

// k: the stop key. s: the key of the station of the stop (for the spider graph filter and the stop names).
export function stopsSource(d: Core): FeatureCollection<Point> {
  const features: FeatureCollection<Point>["features"] = [];
  for (const [k, [, , lat, lon, s]] of Object.entries(d.stops)) {
    features.push({ type: "Feature", properties: { k, s }, geometry: { type: "Point", coordinates: [lon, lat] } });
  }
  return { type: "FeatureCollection", features };
}
