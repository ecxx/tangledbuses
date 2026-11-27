// The live arrival times of a spider graph (app_design 6.8): the times of each
// row and the texts of the live bar. Pure functions: no DOM, no fetch.
import type { Arrival, ArrivalsError } from "../data/arrivals";
import type { Direction, LineId, PatternKey, Patterns, StopKey } from "../data/types";

export const ETA_SHOWN = 3; // the number of times in a row
export const ETA_OPEN = 6; // the number of buses in an open row (the list of the next buses)
export const STALE_MS = 90_000; // older times are dimmed: the last fetch is older than 3 refresh periods
const GONE_S = -30; // a bus that is late by more than this to the predicted time has left

// One bus of a row: s from now, and the destination of that bus (it can differ from the row title).
export interface RowArrival {
  s: number;
  destinationName: string;
  stopId: StopKey;
  vehicleId?: string;
}

// The buses of the row of a line-direction, sorted by time, at most n. A row of a station has the
// arrivals at each of its stops. An arrival with no direction matches both directions of its line.
export function rowArrivals(
  arrivals: Arrival[],
  lineId: LineId,
  dir: Direction,
  stops: StopKey[],
  now: number,
  n = ETA_OPEN,
): RowArrival[] {
  const at = new Set(stops);
  const out: RowArrival[] = [];
  for (const a of arrivals) {
    if (a.lineId !== lineId || !at.has(a.stopId) || (a.direction && a.direction !== dir)) continue;
    const s = (Date.parse(a.expectedArrival) - now) / 1000;
    if (s >= GONE_S) out.push({ s: Math.max(0, s), destinationName: a.destinationName, stopId: a.stopId, vehicleId: a.vehicleId });
  }
  return out.sort((a, b) => a.s - b.s).slice(0, n);
}

// The times of the row, in s from now, sorted, at most n.
export const rowTimes = (arrivals: Arrival[], lineId: LineId, dir: Direction, stops: StopKey[], now: number, n = ETA_SHOWN): number[] =>
  rowArrivals(arrivals, lineId, dir, stops, now, n).map((a) => a.s);

// Full minutes, as the TfL Countdown signs: less than 1 minute is "Due".
export const minutes = (s: number): number => Math.floor(s / 60);
export const etaText = (s: number): string => (minutes(s) === 0 ? "Due" : `${minutes(s)} min`);

// The column of a row: the first time large, the next times small. "Due" / "3 min" / "8, 15 min".
export function etaParts(times: number[]): { first: string; unit: string; rest: string } | null {
  const [t, ...more] = times;
  if (t === undefined) return null;
  const m = minutes(t);
  const rest = more.map(minutes);
  return {
    first: m === 0 ? "Due" : String(m),
    unit: m === 0 ? "" : "min",
    rest: rest.length ? `${rest.map((x) => (x === 0 ? "Due" : String(x))).join(", ")}${rest.at(-1) === 0 ? "" : " min"}` : "",
  };
}

// The text for a screen reader: "Next buses: due, 8 min, 15 min".
export const etaLabel = (times: number[]): string => `Next buses: ${times.map(etaText).join(", ").replace(/^Due/, "due")}`;

export function updatedText(fetchedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (s < 10) return "Updated just now";
  if (s < 60) return `Updated ${s} s ago`;
  return `Updated ${Math.floor(s / 60)} min ago`;
}

export const isStale = (fetchedAt: number, now: number): boolean => now - fetchedAt > STALE_MS;

export const ERROR_TEXT: Record<ArrivalsError, string> = {
  rate_limited: "Too many requests. Live times show again in a minute.",
  network: "You are offline. Live times show when you connect again.",
  blocked: "Live times can't load on this network right now.",
  not_found: "No live times for this stop.",
  not_available: "Live times aren't available for this stop.",
  unavailable: "Live times are not available now.",
};

// The Retry button of the live bar. network and blocked: always (the user can know that the network is back).
// unavailable: only after the scheduler gave up (before, it tries again by itself). The others: never.
export const canRetry = (error: ArrivalsError, gaveUp: boolean): boolean =>
  error === "network" || error === "blocked" || (error === "unavailable" && gaveUp);


// ---- The TfL data (prod_design 6.2) ----

// TfL gives `200 []` for the stops with these prefixes (Slough, Denham), also when buses are due (prod_design 6.3).
// The client sends no request for them.
const NO_LIVE_PREFIXES = ["037", "040"];
export const hasLiveTimes = (k: StopKey): boolean => !NO_LIVE_PREFIXES.some((p) => k.startsWith(p));

// The Arrival records of the TfL Prediction records of one response. A record that has no usable
// fields, or has a direction that is not inbound or outbound, is dropped. lineId: lowercase, as in the export.
// clockOffsetMs: server time − device time. The expectedArrival is moved by it, thus the countdown (which uses
// the device clock) is right (prod_design 6.2).
export function mapPredictions(raw: unknown[], clockOffsetMs = 0): Arrival[] {
  const out: Arrival[] = [];
  for (const r of raw) {
    const p = r as Record<string, unknown> | null;
    if (!p || typeof p !== "object") continue;
    const { lineId, lineName, naptanId, direction, destinationName, expectedArrival, timeToStation, platformName, vehicleId } = p;
    if (typeof lineId !== "string" || typeof naptanId !== "string" || typeof expectedArrival !== "string") continue;
    if (direction !== "inbound" && direction !== "outbound") continue;
    const t = Date.parse(expectedArrival);
    if (!Number.isFinite(t) || typeof timeToStation !== "number") continue;
    out.push({
      lineId: lineId.toLowerCase(),
      lineName: typeof lineName === "string" ? lineName : lineId.toUpperCase(),
      destinationName: typeof destinationName === "string" ? destinationName : "",
      stopId: naptanId,
      platformName: typeof platformName === "string" && platformName ? platformName : undefined,
      direction,
      expectedArrival: clockOffsetMs ? new Date(t - clockOffsetMs).toISOString() : expectedArrival,
      timeToStation,
      vehicleId: typeof vehicleId === "string" ? vehicleId : undefined,
    });
  }
  return out;
}

// The arrivals that the export knows: the export has a pattern of that line and direction that contains the
// stop and does not end there (a bus that ends there does not take passengers; a line that is not in the
// export has no row). The spider graph shows no other arrival.
export function knownArrivals(d: { patterns: Patterns; stopPatterns: Map<StopKey, PatternKey[]> }, arrivals: Arrival[]): Arrival[] {
  const groups = new Map<StopKey, Set<string>>(); // the line-directions that leave a stop
  const leaves = (k: StopKey): Set<string> => {
    let g = groups.get(k);
    if (!g) {
      g = new Set();
      for (const pid of d.stopPatterns.get(k) ?? []) {
        const [lineId, , dir, , stops] = d.patterns[pid]!;
        if (stops.some((x, i) => x === k && i < stops.length - 1)) g.add(`${lineId}|${dir}`);
      }
      groups.set(k, g);
    }
    return g;
  };
  return arrivals.filter((a) => a.direction && leaves(a.stopId).has(`${a.lineId}|${a.direction}`));
}
