// The live arrival times of the selected stops (app_design 6.8, prod_design 6.2).
//
// This file is the seam between the panel and the source of the arrival times. The panel and the state
// call only getArrivals. The source is set one time at the start (main.tsx):
//   - the development server: the fake source of data/fakeArrivals.ts. It makes no network request.
//   - the TfL client of data/tflArrivals.ts (GET /StopPoint/{naptanId}/Arrivals), which maps the TfL
//     Prediction records to Arrival, and gives an error kind in place of an exception.
import type { Direction, LineId, StopKey } from "./types";

// One predicted arrival of one vehicle at one stop. The fields have the names of the TfL Prediction
// record, so that the TfL client is a direct map.
export interface Arrival {
  lineId: LineId; // the line ID of the export, for example "88" or "n5"
  lineName: string; // the line name, for example "N5"
  destinationName: string;
  stopId: StopKey; // the NaPTAN ID of the stop: the stop key of the export
  platformName?: string; // the stop code, for example "C"
  direction?: Direction;
  expectedArrival: string; // ISO 8601
  timeToStation: number; // s, at fetchedAt
  vehicleId?: string;
}

// rate_limited: HTTP 429. network: no connection. blocked: the request fails while the browser is online
// (for example the challenge of the TfL CDN). not_found: HTTP 404 (no stop of that id). not_available: no live
// times for these stops (the stops of the prefixes 037 and 040). unavailable: HTTP 5xx, another status, or a bad body.
export type ArrivalsError = "rate_limited" | "network" | "blocked" | "not_found" | "not_available" | "unavailable";

export interface StopArrivals {
  stopIds: StopKey[];
  fetchedAt: number; // epoch ms
  arrivals: Arrival[]; // all the arrivals at the stops, in no specified order
  error?: ArrivalsError; // the source did not get the arrivals: arrivals is empty
  retryAfterMs?: number; // rate_limited: the time until the requests are allowed again (the source pauses all the requests)
  ageS?: number; // the Age header of the response (s). It gives the time of the next poll (model/arrivalsSchedule.ts).
  clockOffsetMs?: number; // server time − device time, when it is more than 60 s. The expectedArrival of the arrivals is corrected by it.
}

export type ArrivalsSource = (stopIds: StopKey[]) => Promise<StopArrivals>;

// No source: the arrival times are not available.
const noSource: ArrivalsSource = async (stopIds) => ({ stopIds, fetchedAt: Date.now(), arrivals: [], error: "unavailable" });

let source: ArrivalsSource = noSource;
let sourceName: "none" | "fake" | "tfl" = "none";

export function setArrivalsSource(s: ArrivalsSource, name: "fake" | "tfl"): void {
  source = s;
  sourceName = name;
}

// The panel shows a "Sample" tag when the times are fake.
export const arrivalsSourceName = (): "none" | "fake" | "tfl" => sourceName;

// The arrivals at the stops. An exception of the source (a fault: the sources give the errors as a result) gives "unavailable".
export async function getArrivals(stopIds: StopKey[]): Promise<StopArrivals> {
  try {
    return await source(stopIds);
  } catch {
    return { stopIds, fetchedAt: Date.now(), arrivals: [], error: "unavailable" };
  }
}
