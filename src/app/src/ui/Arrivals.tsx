// The live arrival times of the station view and the stop view (app_design 6.8):
// the live bar under the filter chips, and the times column of each row of the spider graph.
import { arrivalsSourceName } from "../data/arrivals";
import type { StopKey } from "../data/types";
import { ERROR_TEXT, canRetry, etaLabel, etaParts, etaText, isStale, minutes, updatedText, type RowArrival } from "../model/arrivals";
import { refreshArrivals, type Arrivals } from "../state/arrivals";

// The state of the bar: "Getting live times…", "Live · Updated 12 s ago", "No buses due…", or an error.
export function LiveBar({ a, now }: { a: Arrivals; now: number }) {
  const sample = arrivalsSourceName() === "fake" && <span class="tag">Sample data</span>;
  if (a.error) {
    return (
      <div class="live is-error">
        <span class="live-warn" aria-hidden="true">!</span>
        <span class="live-text">
          {ERROR_TEXT[a.error]}
          {a.data && <span class="muted"> {updatedText(a.data.fetchedAt, now)}.</span>}
        </span>
        {canRetry(a.error, a.gaveUp) && (
          <button class="link" type="button" onClick={refreshArrivals} disabled={a.loading}>
            {a.loading ? "Retrying…" : "Retry"}
          </button>
        )}
      </div>
    );
  }
  if (!a.data) {
    return (
      <div class="live is-wait">
        <span class="live-dot" aria-hidden="true" />
        <span class="live-text">Getting live times…</span>
        {sample}
      </div>
    );
  }
  const stale = isStale(a.data.fetchedAt, now);
  return (
    <div class={stale ? "live is-stale" : "live"}>
      <span class="live-dot" aria-hidden="true" />
      <span class="live-text">
        {a.data.arrivals.length ? <b>Live</b> : <b>No buses due</b>}
        <span class="muted"> · {updatedText(a.data.fetchedAt, now)}</span>
      </span>
      {sample}
    </div>
  );
}

// The gray placeholder of the times column of a row, during the first fetch of a view (app_design 6.8).
export const EtaWait = () => (
  <span class="eta is-wait" aria-hidden="true">
    <span class="skel" />
    <span class="skel sm" />
  </span>
);

// The times column of a row, when one or more rows of the view have times (app_design 6.8). times: in s from
// now. No time: "–".
export function Eta({ a, times, now }: { a: Arrivals; times: number[]; now: number }) {
  if (!a.data) return null;
  const p = etaParts(times);
  const stale = isStale(a.data.fetchedAt, now) || !!a.error;
  if (!p) {
    return (
      <span class={stale ? "eta none is-stale" : "eta none"} title="No bus due in the next 30 minutes">
        <span aria-hidden="true">–</span>
        <span class="sr">No bus due</span>
      </span>
    );
  }
  return (
    <span class={stale ? "eta is-stale" : "eta"}>
      <span class={p.unit ? "eta-1" : "eta-1 due"} aria-hidden="true">
        {p.first}
        {p.unit && <small> {p.unit}</small>}
      </span>
      {p.rest && (
        <span class="eta-n" aria-hidden="true">
          {p.rest}
        </span>
      )}
      <span class="sr">{etaLabel(times)}</span>
    </span>
  );
}

// The caret of the times button of a row: down when the row is closed, up when it is open.
export const Caret = () => (
  <svg class="caret" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

// An open row: the next buses, each with the destination text of that bus as the source gives it
// (TfL: destinationName). stopText: the stop of each bus, only for a row of two or more stops (app_design 6.8).
export function NextBuses({
  id,
  list,
  stale,
  stopText,
}: {
  id: string;
  list: RowArrival[];
  stale: boolean;
  stopText?: (k: StopKey) => string;
}) {
  return (
    <ul class={stale ? "next is-stale" : "next"} id={id} aria-label="Next buses">
      {list.map((x, i) => (
        <li key={`${x.vehicleId ?? i}|${x.stopId}`}>
          <span class="next-to">
            <span class="to">to</span>
            {x.destinationName}
            {stopText && <span class="ind">{stopText(x.stopId)}</span>}
          </span>
          <span class={minutes(x.s) === 0 ? "next-t due" : "next-t"}>{etaText(x.s)}</span>
        </li>
      ))}
    </ul>
  );
}
