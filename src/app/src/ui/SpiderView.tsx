// app_design 6.2, 6.3 and 6.4: the body of the station view and of the stop view, under the header.
// The stop chips, the filter chips and the list of routes.
import { useLayoutEffect, useState } from "preact/hooks";
import type { Core } from "../data/load";
import { spanTouch } from "../perf";
import type { StopKey } from "../data/types";
import { ETA_SHOWN, isStale, rowArrivals } from "../model/arrivals";
import { highlights } from "../model/hover";
import type { Filter } from "../model/spider";
import { stopLabel, stopRoundel } from "../model/text";
import { viewHash } from "../model/url";
import { arrivals, clock } from "../state/arrivals";
import { filter, highlight } from "../state/signals";
import type { Spider } from "../state/spider";
import { Caret, Eta, EtaWait, LiveBar, NextBuses } from "./Arrivals";
import { Badge, ChevronRight, Roundel } from "./marks";

const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["day", "Day"],
  ["night", "Night"],
];

function StopChip({ d, k, current }: { d: Core; k: StopKey; current: boolean }) {
  const r = stopRoundel(d, k);
  return (
    <a class="chip stop" href={viewHash({ kind: "stop", key: k })} aria-current={current ? "true" : undefined} data-stop={k}>
      <Roundel text={r.text} stand={r.stand} />
      {stopLabel(d, k)}
    </a>
  );
}

// The station view: one chip for each stop. The stop view: the chips if the station has two or more
// stops (the current stop is selected), and "All n", which opens the station view.
function StopChips({ d, s }: { d: Core; s: Spider }) {
  if (s.stop && s.pins.length < 2) return null;
  return (
    <div class="toolbar">
      <div class="chip-row" role="group" aria-label="Stops">
        {s.pins.map((k) => (
          <StopChip key={k} d={d} k={k} current={k === s.stop} />
        ))}
        {s.stop && (
          <a class="chip" href={viewHash({ kind: "station", key: s.station })}>
            All {s.pins.length}
          </a>
        )}
      </div>
    </div>
  );
}

// app_design 6.4: the pointer on a row highlights that direction of the route. The rows of the
// highlighted routes are marked, and the other rows are dimmed.
// app_design 6.8: the live bar under the filter chips, and the next times at the right of each row.
// The times are a button: it opens the row, with the next buses and the destination of each bus. One row is
// open at a time. A click on the rest of the row opens the route view, as before.
// The right end of a row: when one or more shown rows have times, a row with no time has "–". When no shown
// row has times, each row has the gray placeholder during the first fetch, else the chevron (no data, an error
// with no earlier times, no buses due).
export function SpiderView({ d, s }: { d: Core; s: Spider }) {
  const h = highlight.value;
  const a0 = arrivals.value;
  const a = a0?.key === s.selected.join(",") ? a0 : null; // not the times of the last view
  const now = clock.value;
  const live = a?.data?.arrivals ?? [];
  const sel = s.selected.join(",");
  const [open0, setOpen] = useState<string | null>(null); // "<selected stops>#<line>|<dir>"
  const open = open0?.startsWith(`${sel}#`) ? open0.slice(sel.length + 1) : null; // not the open row of the last view
  // The buses of each shown row. A row where all the patterns end here ("from") has none (app_design 6.8).
  const buses = s.shown.map((r) => (a?.data && r.to ? rowArrivals(live, r.line.id, r.dir, r.stops, now) : []));
  const withTimes = buses.some((b) => b.length > 0);
  const firstFetch = !!a && !a.data && !a.error;
  useLayoutEffect(() => spanTouch("spider"), [s]); // prod_design 9, step 15
  return (
    <>
      <StopChips d={d} s={s} />
      <div class="toolbar">
        <div class="chip-row" role="group" aria-label="Filter">
          {FILTERS.map(([f, label]) => (
            <button key={f} class="chip" type="button" aria-pressed={s.filter === f} onClick={() => (filter.value = f)}>
              {label} <span class="n">{s.counts[f]}</span>
            </button>
          ))}
        </div>
        {a && <LiveBar a={a} now={now} />}
      </div>
      {s.shown.length ? (
        <ul class={h ? "list services has-hot" : "list services"} onMouseLeave={() => (highlight.value = null)}>
          {s.shown.map((r, i) => {
            const rk = `${r.line.id}|${r.dir}`;
            const hot = highlights(h, r.line.id, r.dir);
            const list = buses[i]!;
            const times = list.slice(0, ETA_SHOWN).map((x) => x.s);
            const isOpen = open === rk && list.length > 0;
            const id = `next-${r.line.id}-${r.dir}`;
            const eta = withTimes && <Eta a={a!} times={times} now={now} />;
            return (
              <li
                key={rk}
                class={`svc${hot ? " is-hot" : ""}${isOpen ? " is-open" : ""}`}
                onMouseEnter={() => (highlight.value = { lines: [r.line.id], dir: r.dir })}
              >
                <a
                  class={hot ? "row is-hot" : "row"}
                  href={viewHash({ kind: "route", line: r.line.id, dir: r.dir, ctx: s.ctx })}
                  data-line={r.line.id}
                  data-dir={r.dir}
                >
                  <Badge line={r.line} />
                  <span class="row-main">
                    <span class="row-title">
                      <span class="to">{r.to ? "to" : "from"}</span>
                      {r.title}
                    </span>
                    <span class="row-sub">{r.sub}</span>
                  </span>
                  {withTimes ? !list.length && eta : firstFetch ? <EtaWait /> : <ChevronRight />}
                </a>
                {list.length > 0 && (
                  <button
                    class="eta-btn"
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={id}
                    title={isOpen ? "Hide the next buses" : "Show the destination of each bus"}
                    onClick={() => setOpen(isOpen ? null : `${sel}#${rk}`)}
                  >
                    {eta}
                    <Caret />
                  </button>
                )}
                {isOpen && (
                  <NextBuses
                    id={id}
                    list={list}
                    stale={isStale(a!.data!.fetchedAt, now) || !!a!.error}
                    stopText={r.stops.length > 1 ? (k) => stopLabel(d, k) : undefined}
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div class="empty">No buses call here.</div>
      )}
    </>
  );
}
