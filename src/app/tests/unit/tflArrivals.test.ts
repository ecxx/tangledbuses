// The TfL client of the arrival times (prod_design 6.2). fetch is a mock: no network request.
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/data/load";
import { tflSource } from "../../src/data/tflArrivals";
import type { Patterns } from "../../src/data/types";
import { canRetry, hasLiveTimes, knownArrivals, mapPredictions } from "../../src/model/arrivals";
import {
  BACKOFF_MS, BIG_STATION_POLL_MS, GIVE_UP, POLL_MIN_MS, RATE_REFILL_MS, RATE_TOKENS, TokenBucket, backoffMs, nextPollDelay, parseRetryAfter,
  rateLimitWaitMs, shouldGiveUp,
} from "../../src/model/arrivalsSchedule";
import { HAS_EXPORT, TFL_STOP, getCore, tflArrivalsFixture } from "./fixtures";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

// A small export: line 1 outbound runs A, B, C. Line 2 inbound runs C, B (ends at B). Line 3 is a loop A, B, A.
const patterns: Patterns = {
  p1: ["1", "1", "outbound", "day", ["A", "B", "C"]],
  p2: ["2", "2", "inbound", "day", ["C", "B"]],
  p3: ["3", "3", "outbound", "day", ["A", "B", "A"]],
};
const small: Pick<Core, "patterns" | "stopPatterns"> = {
  patterns,
  stopPatterns: new Map([
    ["A", ["p1", "p3"]],
    ["B", ["p1", "p2", "p3"]],
    ["C", ["p1", "p2"]],
  ]),
};

const pred = (naptanId: string, lineId: string, direction: string, more: Record<string, unknown> = {}) => ({
  naptanId, lineId, lineName: lineId.toUpperCase(), direction, destinationName: "Z", expectedArrival: "2026-11-27T16:20:25Z", timeToStation: 100, ...more,
});

// A virtual clock: sleep moves the time at once.
function env(fetchFn: (url: string) => Promise<Response>) {
  const e = { t: 1_000_000_000_000, urls: [] as string[] };
  return {
    state: e,
    env: {
      fetch: (url: string) => (e.urls.push(url), fetchFn(url)),
      now: () => e.t,
      random: () => 0.5,
      sleep: async (ms: number) => void (e.t += ms),
    },
  };
}
const stopOf = (url: string) => url.split("/StopPoint/")[1]!.split("/")[0]!;

describe("TfL predictions to Arrival", () => {
  test("the fixture: 18 predictions, mapped, lowercase line ids, no field lost", () => {
    const raw = tflArrivalsFixture();
    expect(raw).toHaveLength(18);
    const a = mapPredictions(raw);
    expect(a).toHaveLength(18);
    expect(a[0]).toEqual({
      lineId: "1",
      lineName: "1",
      destinationName: "Canada Water",
      stopId: TFL_STOP,
      platformName: "S",
      direction: "outbound",
      expectedArrival: "2026-11-27T16:20:25Z",
      timeToStation: 162,
      vehicleId: "BV66VJD",
    });
    expect(new Set(a.map((x) => x.lineId))).toEqual(new Set(["1", "68", "76", "172", "188", "243", "341", "sl6"]));
    expect(a.every((x) => x.direction === "inbound" || x.direction === "outbound")).toBe(true);
  });

  test("an upper case line id is made lowercase; a bad direction or a bad record is dropped", () => {
    const a = mapPredictions([
      pred("A", "N5", "outbound"),
      pred("A", "n5", "clockwise"),
      pred("A", "n5", "inbound", { expectedArrival: "x" }),
      pred("A", "n5", "inbound", { timeToStation: "1" }),
      null,
      "x",
      { lineId: "n5" },
    ]);
    expect(a.map((x) => [x.lineId, x.lineName])).toEqual([["n5", "N5"]]);
  });

  test("the clock correction moves expectedArrival", () => {
    const [a] = mapPredictions([pred("A", "1", "outbound")], 120_000);
    expect(a!.expectedArrival).toBe("2026-11-27T16:18:25.000Z");
  });

  test("the prefixes 037 and 040 have no live times", () => {
    expect(["03700310", "040000001348", "490019703Z", "1500IM359", "40004406045B"].map(hasLiveTimes)).toEqual([false, false, true, true, true]);
  });
});

describe("the export filter", () => {
  test("keeps a bus that leaves the stop; drops a wrong direction, a line that is not in the export, a bus that ends there", () => {
    const a = mapPredictions([
      pred("B", "1", "outbound"), // leaves B
      pred("B", "1", "inbound"), // line 1 has no inbound pattern
      pred("B", "10", "outbound"), // a line that is not in the export
      pred("B", "2", "inbound"), // line 2 ends at B
      pred("C", "2", "inbound"), // line 2 starts at C
      pred("C", "1", "outbound"), // line 1 ends at C
      pred("A", "3", "outbound"), // a loop: A is also the last stop, but the first stop leaves
      pred("X", "1", "outbound"), // a stop that is not in the export
    ]);
    expect(knownArrivals(small, a).map((x) => `${x.stopId}|${x.lineId}|${x.direction}`)).toEqual(["B|1|outbound", "C|2|inbound", "A|3|outbound"]);
  });

  describe.skipIf(!HAS_EXPORT)("export_131026", () => {
    let d: Core;
    beforeAll(async () => {
      d = await getCore();
    });
    test("the fixture agrees with the export: the real line ids and directions are kept", () => {
      const all = mapPredictions(tflArrivalsFixture());
      const kept = knownArrivals(d, all);
      // Each line-direction of the fixture is in the export at this stop.
      expect(kept.length).toBe(all.length);
      expect(new Set(kept.map((x) => x.lineId))).toEqual(new Set(["1", "68", "76", "172", "188", "243", "341", "sl6"]));
    });
    test("a prediction of a line that the export does not know is dropped", () => {
      const all = mapPredictions([...tflArrivalsFixture(), pred(TFL_STOP, "10", "outbound"), pred(TFL_STOP, "1", "inbound")]);
      const kept = knownArrivals(d, all);
      expect(all.length - kept.length).toBeGreaterThanOrEqual(1);
      expect(kept.some((x) => x.lineId === "10")).toBe(false);
    });
  });
});

describe("the TfL source: errors", () => {
  const run = async (res: () => Promise<Response>, stops = ["A"]) => {
    const m = env(res);
    const r = await tflSource(small, m.env)(stops);
    return { r, m };
  };

  test("a good response: the arrivals, Age and no error", async () => {
    const { r, m } = await run(async () => json([pred("A", "1", "outbound")], 200, { Age: "34", Date: new Date(1_000_000_000_000).toUTCString() }));
    expect(m.state.urls).toEqual(["https://api.tfl.gov.uk/StopPoint/A/Arrivals"]);
    expect(r.error).toBeUndefined();
    expect(r.arrivals).toHaveLength(1);
    expect(r.ageS).toBe(34);
    expect(r.clockOffsetMs).toBeUndefined();
  });

  test("HTTP 200 with [] is not an error", async () => {
    const { r } = await run(async () => json([]));
    expect(r).toMatchObject({ arrivals: [] });
    expect(r.error).toBeUndefined();
  });

  test("429 with Retry-After: rate_limited, the wait is Retry-After + 0 to 2 s", async () => {
    const { r } = await run(async () => json({ statusCode: 429 }, 429, { "Retry-After": "35" }));
    expect(r.error).toBe("rate_limited");
    expect(r.retryAfterMs).toBe(36_000); // random() = 0.5: +1 s
  });

  test("429 without Retry-After, or with a bad value: 60 s. A long Retry-After: at most 120 s", async () => {
    expect((await run(async () => json("", 429))).r.retryAfterMs).toBe(60_000);
    expect((await run(async () => json("", 429, { "Retry-After": "soon" }))).r.retryAfterMs).toBe(60_000);
    expect((await run(async () => json("", 429, { "Retry-After": "900" }))).r.retryAfterMs).toBe(120_000);
  });

  test("after a 429, no request is made until the wait is over (all stops)", async () => {
    let n = 0;
    const m = env(async () => (n++ === 0 ? json("", 429, { "Retry-After": "30" }) : json([])));
    const s = tflSource(small, m.env);
    expect((await s(["A"])).error).toBe("rate_limited");
    const again = await s(["B"]); // another stop, in the pause
    expect(again.error).toBe("rate_limited");
    expect(again.retryAfterMs).toBe(31_000);
    expect(m.state.urls).toHaveLength(1);
    m.state.t += 31_001;
    expect((await s(["B"])).error).toBeUndefined();
    expect(m.state.urls).toHaveLength(2);
  });

  test("fetch throws and the browser is offline: network", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect((await run(async () => Promise.reject(new TypeError("Failed to fetch")))).r.error).toBe("network");
  });

  test("fetch throws and the browser is online: blocked", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect((await run(async () => Promise.reject(new TypeError("Failed to fetch")))).r.error).toBe("blocked");
  });

  test("a 403 that the browser can read is the challenge too: blocked", async () => {
    expect((await run(async () => json("", 403))).r.error).toBe("blocked");
  });

  test("404: not_found, and the key is not requested again", async () => {
    const m = env(async () => json({ $type: "EntityNotFoundException" }, 404));
    const s = tflSource(small, m.env);
    expect((await s(["A"])).error).toBe("not_found");
    expect((await s(["A"])).error).toBe("not_found");
    expect(m.state.urls).toHaveLength(1);
  });

  test("500, another status, a body that is not JSON, a body that is not an array: unavailable", async () => {
    expect((await run(async () => json("", 500))).r.error).toBe("unavailable");
    expect((await run(async () => json("<html>"))).r.error).toBe("unavailable");
    expect((await run(async () => json({ a: 1 }))).r.error).toBe("unavailable");
  });

  test("the Date header: a clock error of more than 60 s corrects expectedArrival; a smaller error does not", async () => {
    const m = env(async () => json([pred("A", "1", "outbound")], 200, { Date: new Date(Date.parse("2026-11-27T16:20:25Z") + 0).toUTCString() }));
    // The device clock is far from 2026-11-27: the offset is large.
    const r = await tflSource(small, m.env)(["A"]);
    expect(r.clockOffsetMs).toBeDefined();
    const near = env(async () => json([pred("A", "1", "outbound")], 200, { Date: new Date(1_000_000_000_000 + 20_000).toUTCString() }));
    const r2 = await tflSource(small, near.env)(["A"]);
    expect(r2.clockOffsetMs).toBeUndefined();
    expect(r2.arrivals[0]!.expectedArrival).toBe("2026-11-27T16:20:25Z");
  });
});

describe("the TfL source: stops and stations", () => {
  test("037 and 040: no request. All such stops: not_available. Else they are skipped", async () => {
    const m = env(async () => json([pred("A", "1", "outbound")]));
    const s = tflSource(small, m.env);
    const none = await s(["03700310", "040000001348"]);
    expect(none.error).toBe("not_available");
    expect(m.state.urls).toHaveLength(0);
    const some = await s(["03700310", "A"]);
    expect(some.error).toBeUndefined();
    expect(m.state.urls.map(stopOf)).toEqual(["A"]);
  });

  test("mixed results: the arrivals of the stops that gave them, and no error", async () => {
    const m = env(async (u) => {
      const k = stopOf(u);
      return k === "A" ? json([pred("A", "1", "outbound")]) : k === "B" ? json("", 500) : json("", 404);
    });
    const r = await tflSource(small, m.env)(["A", "B", "C"]);
    expect(r.error).toBeUndefined();
    expect(r.arrivals.map((x) => x.stopId)).toEqual(["A"]);
  });

  test("no stop gave arrivals: the first error of the list. All 404: not_found", async () => {
    const m = env(async (u) => (stopOf(u) === "A" ? json("", 500) : json("", 404)));
    expect((await tflSource(small, m.env)(["A", "B"])).error).toBe("unavailable");
    const m2 = env(async () => json("", 404));
    expect((await tflSource(small, m2.env)(["A", "B"])).error).toBe("not_found");
    const m3 = env(async (u) => (stopOf(u) === "A" ? json("", 429, { "Retry-After": "10" }) : json("", 404)));
    expect((await tflSource(small, m3.env)(["A", "B"])).error).toBe("rate_limited");
  });

  test("a 429 at one stop of a station: the arrivals of the others stay, retryAfterMs is set", async () => {
    const m = env(async (u) => (stopOf(u) === "A" ? json([pred("A", "1", "outbound")]) : json("", 429, { "Retry-After": "20" })));
    const r = await tflSource(small, m.env)(["A", "B"]);
    expect(r.error).toBeUndefined();
    expect(r.arrivals).toHaveLength(1);
    expect(r.retryAfterMs).toBe(21_000);
  });

  test("at most 2 requests at the same time", async () => {
    let active = 0, max = 0;
    const m = env(async () => {
      max = Math.max(max, ++active);
      await new Promise((ok) => setTimeout(ok, 5));
      active--;
      return json([]);
    });
    const ids = ["A", "B", "C", "D", "E", "F"];
    await tflSource(small, m.env)(ids);
    expect(m.state.urls).toHaveLength(6);
    expect(max).toBe(2);
  });

  test("the cache: a second view in 25 s makes no request. A station, a stop, the station: one request for each stop", async () => {
    const m = env(async () => json([]));
    const s = tflSource(small, m.env);
    await s(["A", "B"]);
    await s(["A"]);
    await s(["A", "B"]);
    expect(m.state.urls).toHaveLength(2);
    m.state.t += 25_001;
    await s(["A"]);
    expect(m.state.urls).toHaveLength(3);
  });

  test("a request in flight is shared", async () => {
    let n = 0;
    const m = env(async () => (n++, await new Promise((ok) => setTimeout(ok, 5)), json([])));
    const s = tflSource(small, m.env);
    await Promise.all([s(["A"]), s(["A", "B"])]);
    expect(m.state.urls.map(stopOf).sort()).toEqual(["A", "B"]);
  });

  test("the cap: a request waits for a token", async () => {
    const m = env(async () => json([]));
    const s = tflSource(small, m.env);
    // Use all the tokens with distinct keys, then a stop that has none.
    const keys = Array.from({ length: RATE_TOKENS }, (_, i) => `K${i}`);
    for (let i = 0; i < keys.length; i += 2) await s(keys.slice(i, i + 2));
    expect(m.state.urls).toHaveLength(RATE_TOKENS);
    const t0 = m.state.t;
    const r = await s(["A"]); // waits one refill
    expect(r.error).toBeUndefined();
    expect(m.state.t - t0).toBeGreaterThanOrEqual(1);
    expect(m.state.urls).toHaveLength(RATE_TOKENS + 1);
  });

  test("the cap: a newer view cancels the waiting request of the older view; only the newest view's request is sent", async () => {
    const m = env(async () => json([]));
    const s = tflSource(small, m.env);
    const keys = Array.from({ length: RATE_TOKENS }, (_, i) => `K${i}`);
    for (let i = 0; i < keys.length; i += 2) await s(keys.slice(i, i + 2));
    const older = s(["A"]); // waits for a token
    const newer = s(["B"]);
    expect((await older).arrivals).toEqual([]);
    expect((await newer).error).toBeUndefined();
    expect(m.state.urls.map(stopOf).slice(RATE_TOKENS)).toEqual(["B"]);
  });
});

describe("the policy helpers", () => {
  test("parseRetryAfter", () => {
    expect([parseRetryAfter("35"), parseRetryAfter(" 0 "), parseRetryAfter("1.5"), parseRetryAfter("soon"), parseRetryAfter(""), parseRetryAfter(null), parseRetryAfter("-3")]).toEqual([35, 0, 1.5, null, null, null, null]);
  });

  test("rateLimitWaitMs: Retry-After + random 0 to 2 s, default 60 s, at most 120 s", () => {
    expect(rateLimitWaitMs("35", () => 0)).toBe(35_000);
    expect(rateLimitWaitMs("35", () => 0.999)).toBe(36_998);
    expect(rateLimitWaitMs(null)).toBe(60_000);
    expect(rateLimitWaitMs("x")).toBe(60_000);
    expect(rateLimitWaitMs("119", () => 0.999)).toBe(120_000);
    expect(rateLimitWaitMs("5000")).toBe(120_000);
  });

  test("nextPollDelay: max(30 s, 60 s - Age); a station with more than 3 stops: 60 s", () => {
    expect([0, 10, 30, 34, 59].map((age) => nextPollDelay(age, 1))).toEqual([60_000, 50_000, 30_000, 30_000, 30_000]);
    expect(nextPollDelay(undefined, 2)).toBe(POLL_MIN_MS);
    expect(nextPollDelay(Number.NaN, 2)).toBe(POLL_MIN_MS);
    expect(nextPollDelay(50, 3)).toBe(30_000);
    expect(nextPollDelay(50, 4)).toBe(BIG_STATION_POLL_MS);
    expect(nextPollDelay(0, 11)).toBe(60_000);
  });

  test("backoff: 30, 60, 120, 240, then 300 s. Give up after 4 failures", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
    expect(BACKOFF_MS).toHaveLength(5);
    expect([0, 1, 3, 4, 5].map(shouldGiveUp)).toEqual([false, false, false, true, true]);
    expect(GIVE_UP).toBe(4);
  });

  test("the Retry button", () => {
    expect((["rate_limited", "network", "blocked", "not_found", "not_available", "unavailable"] as const).map((e) => [canRetry(e, false), canRetry(e, true)])).toEqual([
      [false, false], [true, true], [true, true], [false, false], [false, false], [false, true],
    ]);
  });

  test("the token bucket: 20 tokens, one back each 3 s", () => {
    let t = 0;
    const b = new TokenBucket(RATE_TOKENS, RATE_REFILL_MS, () => t);
    for (let i = 0; i < RATE_TOKENS; i++) expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    expect(b.waitMs()).toBe(RATE_REFILL_MS);
    t += 1000;
    expect(b.waitMs()).toBe(2000);
    t += 2000;
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    t += 10 * RATE_REFILL_MS;
    let n = 0;
    while (b.take()) n++;
    expect(n).toBe(10);
    t += 1e9; // the bucket does not hold more than its size
    n = 0;
    while (b.take()) n++;
    expect(n).toBe(RATE_TOKENS);
    t += 1e9;
    b.empty();
    expect(b.take()).toBe(false);
  });
});
