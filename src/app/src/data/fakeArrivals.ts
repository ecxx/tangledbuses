// The fake source of arrival times (data/arrivals.ts). It makes no network request.
//
// The arrivals come from the real patterns of the export, so the route numbers and the destinations
// agree with the spider graph. They are deterministic: the same stops and the same time give the
// same arrivals. Each line-direction at a stop has a headway and a phase from a hash of its key, thus
// the times count down from one fetch to the next, as live times do.
//
// ?fakeArrivals=<mode> selects a state for the review of the UI (prod_design 7).
import type { Core } from "./load";
import type { Arrival, ArrivalsSource, StopArrivals } from "./arrivals";
import type { LineInfo, PatternKey, StopKey } from "./types";
import { lastStopName, stopCode } from "../model/text";

export type FakeMode = "live" | "slow" | "loading" | "empty" | "rate_limited" | "network" | "blocked" | "not_found" | "not_available" | "unavailable";
const MODES: FakeMode[] = ["live", "slow", "loading", "empty", "rate_limited", "network", "blocked", "not_found", "not_available", "unavailable"];

const DELAY_MS = 350; // the time of a fake fetch
const SLOW_MS = 2500; // the time of a fake fetch in the mode "slow"
const WINDOW_S = 30 * 60; // TfL gives the predictions of approximately the next 30 minutes
const NO_DATA = 9; // 1 line-direction in NO_DATA has no prediction (the row shows "–")
const NIGHT_FROM = 23; // the night lines run from this hour to NIGHT_TO (local time of the browser)
const NIGHT_TO = 5;

// The mode from the URL. "error" is a short form of "rate_limited". Any other value is "live".
export function fakeMode(search: string): FakeMode {
  const v = new URLSearchParams(search).get("fakeArrivals");
  if (v === "error") return "rate_limited";
  if (v === "offline") return "network";
  return MODES.includes(v as FakeMode) ? (v as FakeMode) : "live";
}

// FNV-1a: a small hash, the same in each browser.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const runs = (line: LineInfo, hour: number): boolean => line.cls !== "night" || hour >= NIGHT_FROM || hour < NIGHT_TO;

// The arrivals at the stops at the time now (epoch ms).
export function fakeArrivals(d: Core, stopIds: StopKey[], now: number): Arrival[] {
  const hour = new Date(now).getHours();
  const nowS = Math.floor(now / 1000);
  const out: Arrival[] = [];
  for (const k of stopIds) {
    // The patterns that leave the stop, by line-direction. A pattern that ends at the stop has no departure.
    const groups = new Map<string, PatternKey[]>();
    for (const pid of d.stopPatterns.get(k) ?? []) {
      const stops = d.patterns[pid]![4];
      if (stops.indexOf(k) === stops.length - 1) continue;
      const [lineId, , dir] = d.patterns[pid]!;
      const g = `${lineId}|${dir}`;
      groups.set(g, [...(groups.get(g) ?? []), pid]);
    }
    const platformName = stopCode(d, k).code || undefined;
    for (const [g, pids] of groups) {
      const [lineId, , dir] = d.patterns[pids[0]!]!;
      const line = d.lines.get(lineId)!;
      const h0 = hash(`${k}|${g}`);
      if (h0 % NO_DATA === 0 || !runs(line, hour)) continue;
      const headway = (line.cls === "night" ? 15 + (h0 % 10) : 4 + (h0 % 12)) * 60; // s
      const phase = (h0 >>> 8) % headway;
      // The scheduled times are the times t where (t + phase) is a multiple of the headway. Start one
      // headway before now: a bus that is late to its scheduled time is still to come.
      let t = nowS + ((headway - ((nowS + phase) % headway)) % headway) - headway;
      for (; t - nowS < WINDOW_S; t += headway) {
        const h = hash(`${k}|${g}|${t}`);
        const at = t + (h % 81) - 40; // ±40 s of traffic
        const tts = at - nowS;
        if (tts < 0) continue;
        // Most buses go to the end of the main pattern. Some go to the end of a variant.
        const pid = pids.length > 1 && h % 5 === 0 ? pids[1 + ((h >>> 4) % (pids.length - 1))]! : pids[0]!;
        out.push({
          lineId,
          lineName: line.name,
          destinationName: lastStopName(d, pid),
          stopId: k,
          platformName,
          direction: dir,
          expectedArrival: new Date(at * 1000).toISOString(),
          timeToStation: tts,
          vehicleId: `LTZ${1000 + ((h >>> 12) % 9000)}`,
        });
      }
    }
  }
  return out;
}

const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

// The source for data/arrivals.ts.
export function fakeSource(d: Core, mode: FakeMode, clock: () => number = Date.now): ArrivalsSource {
  return async (stopIds): Promise<StopArrivals> => {
    if (mode === "loading") return new Promise(() => {}); // never resolves
    await wait(mode === "slow" ? SLOW_MS : DELAY_MS);
    const fetchedAt = clock();
    if (mode !== "live" && mode !== "slow" && mode !== "empty") return { stopIds, fetchedAt, arrivals: [], error: mode };
    return { stopIds, fetchedAt, arrivals: mode === "empty" ? [] : fakeArrivals(d, stopIds, fetchedAt) };
  };
}
