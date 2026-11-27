import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/500.css";
import "@fontsource/hanken-grotesk/600.css";
import "@fontsource/hanken-grotesk/700.css";
import "@fontsource/hanken-grotesk/800.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { effect } from "@preact/signals";
import { render } from "preact";
import { setArrivalsSource } from "./data/arrivals";
import { FormatError, loadCore, loadLinesInWorker, type Core } from "./data/load";
import { tflSource } from "./data/tflArrivals";
import { startMap } from "./map/map";
import { mark, showPerf } from "./perf";
import { startArrivals } from "./state/arrivals";
import { startRouter } from "./state/router";
import { chosenScheme, core, lines, loadError, scheme } from "./state/signals";
import { App } from "./ui/App";

mark("script"); // after the evaluation of the imported modules (prod_design 9, step 15)

// app_design 3.1: the scheme that the URL or the user chose overrides the system colour scheme.
effect(() => {
  const root = document.documentElement;
  if (chosenScheme.value) root.dataset.theme = chosenScheme.value;
  else delete root.dataset.theme;
  root.dataset.scheme = scheme.value;
});

render(<App />, document.getElementById("app")!);
startRouter();
startMap(document.getElementById("map")!);
showPerf();

// The live times (prod_design 6.2, 7).
//   Build: the TfL source. ?arrivals=off turns the feature off.
//   Development server: the fake source (no network request). ?arrivals=live uses the TfL source,
//   ?arrivals=off or ?fakeArrivals=off turns the feature off, ?fakeArrivals=<mode> selects a state of the fake source.
// The fake source is behind import.meta.env.DEV: Vite removes it from the build.
async function startLiveTimes(c: Core): Promise<void> {
  const q = new URLSearchParams(location.search);
  const flag = q.get("arrivals");
  if (flag === "off") return;
  if (import.meta.env.DEV && flag !== "live") {
    if (q.get("fakeArrivals") === "off") return;
    const f = await import("./data/fakeArrivals");
    setArrivalsSource(f.fakeSource(c, f.fakeMode(location.search)), "fake");
  } else {
    setArrivalsSource(tflSource(c), "tfl");
  }
  startArrivals();
}

// prod_design 4.1: the panel operates after stops, stations and patterns. The lines come after.
(async () => {
  try {
    const c = await loadCore();
    mark("core");
    core.value = c;
    void startLiveTimes(c); // after the core: the panel does not wait for it
    lines.value = await loadLinesInWorker(c);
  } catch (err) {
    console.error(err);
    loadError.value = err instanceof FormatError ? err.message : "The bus data did not load. Reload the page.";
  }
})();
