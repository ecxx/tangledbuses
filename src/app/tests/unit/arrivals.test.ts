import { beforeAll, describe, expect, test } from "vitest";
import type { Arrival } from "../../src/data/arrivals";
import type { Core } from "../../src/data/load";
import { fakeArrivals, fakeMode, fakeSource } from "../../src/data/fakeArrivals";
import { etaLabel, etaParts, etaText, isStale, rowTimes, updatedText } from "../../src/model/arrivals";
import { spiderRows } from "../../src/model/spider";
import { HAS_EXPORT, getCore } from "./fixtures";

const T0 = Date.parse("2026-10-13T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const arr = (lineId: string, s: number, more: Partial<Arrival> = {}): Arrival => ({
  lineId,
  lineName: lineId.toUpperCase(),
  destinationName: "X",
  stopId: "A",
  direction: "outbound",
  expectedArrival: at(s),
  timeToStation: s,
  ...more,
});

describe("arrival times (app_design 6.8, prod_design 6.1)", () => {
  test("full minutes, and less than 1 minute is Due", () => {
    expect([0, 59, 60, 179, 725].map(etaText)).toEqual(["Due", "Due", "1 min", "2 min", "12 min"]);
  });

  test("the column of a row: the first time large, the next times small", () => {
    expect(etaParts([30, 480, 900])).toEqual({ first: "Due", unit: "", rest: "8, 15 min" });
    expect(etaParts([200])).toEqual({ first: "3", unit: "min", rest: "" });
    expect(etaParts([])).toBeNull();
    expect(etaLabel([30, 480])).toBe("Next buses: due, 8 min");
  });

  test("the times of a row: its line, its direction and its stops, sorted, at most 3", () => {
    const list = [
      arr("88", 900),
      arr("88", 60),
      arr("88", 300, { direction: "inbound" }),
      arr("88", 400, { stopId: "B" }),
      arr("88", 500, { direction: undefined }), // no direction: both directions
      arr("88", -60), // the bus has left
      arr("88", -10), // late by 10 s: Due
      arr("24", 120),
      arr("88", 1500),
    ];
    expect(rowTimes(list, "88", "outbound", ["A"], T0)).toEqual([0, 60, 500]);
    expect(rowTimes(list, "88", "outbound", ["A", "B"], T0, 9)).toEqual([0, 60, 400, 500, 900, 1500]);
    // Between two fetches, the times count down from the expected arrival.
    expect(rowTimes(list, "24", "outbound", ["A"], T0 + 50_000)).toEqual([70]);
  });

  test("the live bar texts", () => {
    expect(updatedText(T0, T0 + 4_000)).toBe("Updated just now");
    expect(updatedText(T0, T0 + 42_000)).toBe("Updated 42 s ago");
    expect(updatedText(T0, T0 + 130_000)).toBe("Updated 2 min ago");
    expect(isStale(T0, T0 + 60_000)).toBe(false);
    expect(isStale(T0, T0 + 120_000)).toBe(true);
  });

  test("the fake modes of ?fakeArrivals", () => {
    expect(
      ["", "?fakeArrivals", "?fakeArrivals=empty", "?fakeArrivals=error", "?fakeArrivals=offline", "?x=1&fakeArrivals=loading", "?fakeArrivals=blocked", "?fakeArrivals=not_found", "?fakeArrivals=not_available"].map(fakeMode),
    ).toEqual(["live", "live", "empty", "rate_limited", "network", "loading", "blocked", "not_found", "not_available"]);
  });
});

describe.skipIf(!HAS_EXPORT)("fake arrivals of data_131026", () => {
  let d: Core;
  beforeAll(async () => {
    d = await getCore();
  });
  const STOP = "490019703Z"; // Aldwych / Drury Lane, Stop S
  const NOON = Date.parse("2026-10-13T12:00:00"); // local time: the day lines run, the night lines do not

  test("deterministic, and the lines are the lines of the spider graph", () => {
    const a = fakeArrivals(d, [STOP], NOON);
    expect(a.length).toBeGreaterThan(10);
    expect(fakeArrivals(d, [STOP], NOON)).toEqual(a);
    const rows = spiderRows(d, [STOP], false);
    const keys = new Set(rows.map((r) => `${r.line.id}|${r.dir}`));
    for (const x of a) {
      expect(keys.has(`${x.lineId}|${x.direction}`)).toBe(true);
      expect(x.stopId).toBe(STOP);
      expect(x.timeToStation).toBeGreaterThanOrEqual(0);
      expect(x.timeToStation).toBeLessThan(30 * 60 + 40);
      expect(Date.parse(x.expectedArrival)).toBe(NOON - (NOON % 1000) + x.timeToStation * 1000);
    }
    // At noon, the night lines have no arrivals.
    expect(a.some((x) => d.lines.get(x.lineId)!.cls === "night")).toBe(false);
  });

  test("the times count down: 2 minutes later, the same buses are 2 minutes nearer", () => {
    const a = fakeArrivals(d, [STOP], NOON);
    const b = fakeArrivals(d, [STOP], NOON + 120_000);
    const key = (x: Arrival) => `${x.lineId}|${x.vehicleId}|${x.expectedArrival}`;
    const later = new Set(b.map(key));
    const kept = a.filter((x) => x.timeToStation >= 120);
    expect(kept.length).toBeGreaterThan(0);
    for (const x of kept) expect(later.has(key(x))).toBe(true);
  });

  test("the first bus of a line-direction is not always Due", () => {
    // The first times are spread over the headway: less than half are under 1 minute.
    let due = 0, n = 0;
    for (let m = 0; m < 60; m += 7) {
      const now = NOON + m * 60_000;
      for (const r of spiderRows(d, [STOP], false)) {
        const t = rowTimes(fakeArrivals(d, [STOP], now), r.line.id, r.dir, [STOP], now);
        if (!t.length) continue;
        n++;
        if (t[0]! < 60) due++;
      }
    }
    expect(due / n).toBeLessThan(0.3);
  });

  test("the error modes give an error and no arrivals", async () => {
    const r = await fakeSource(d, "rate_limited", () => NOON)([STOP]);
    expect(r).toEqual({ stopIds: [STOP], fetchedAt: NOON, arrivals: [], error: "rate_limited" });
    const e = await fakeSource(d, "empty", () => NOON)([STOP]);
    expect(e.arrivals).toEqual([]);
    expect(e.error).toBeUndefined();
  });
});
