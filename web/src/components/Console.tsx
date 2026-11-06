import { AnimatePresence, MotionConfig } from "motion/react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Arrivals } from "./Arrivals";
import { DeviceTable } from "./DeviceTable";
import { Findings } from "./Findings";
import { Inspector } from "./Inspector";
import { FilmCaption, GraphKey, Ledger } from "./Overlays";
import { Places } from "./Places";
import { Setup } from "./Setup";
import { Timeline } from "./Timeline";
import { useDeviceDetail } from "@/hooks/useDeviceDetail";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useSnapshot } from "@/hooks/useSnapshot";
import type { ActionRequest } from "@core/types";
import { findingFor, statusLine, visiblePlaces } from "@/lib/view";

const Scene = lazy(() => import("./graph/Scene"));

type View = "graph" | "list";

// In step with --inspector, and the width where it stops overlaying the stage.
const INSPECTOR_WIDTH = 368;
const STACKED_QUERY = "(max-width: 1100px)";

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 5 28 11.5 16 18 4 11.5Z" fill="var(--ink)" />
      <path d="M4 18.5 16 25l12-6.5" fill="none" stroke="var(--ink)" strokeWidth="2.4" strokeLinejoin="round" />
    </svg>
  );
}

function hasWebGL(): boolean {
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

async function postAction(request: ActionRequest): Promise<void> {
  const response = await fetch("/v1/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error("Action failed");
}

export function Console() {
  const [reveal, setReveal] = useState(false);
  const [view, setView] = useState<View>("graph");
  const [film, setFilm] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [webgl, setWebgl] = useState(true);
  const [version, setVersion] = useState(0);
  const { snapshot, connected, act: dispatch } = useSnapshot(reveal);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const wide = !useMediaQuery(STACKED_QUERY);

  useEffect(() => {
    const available = hasWebGL();
    setWebgl(available);
    if (!available) setView("list");
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || event.metaKey || event.ctrlKey) return;
      if (event.key === "Escape") {
        setSelectedId(null);
        setFilm(false);
      }
      if (event.key === "g" && webgl) setView("graph");
      if (event.key === "l") setView("list");
      if (event.key === "f" && webgl) {
        setView("graph");
        setFilm((current) => !current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [webgl]);

  const places = useMemo(() => (snapshot ? visiblePlaces(snapshot.places) : []), [snapshot]);
  const device = snapshot?.devices.find((candidate) => candidate.id === selectedId) ?? null;
  const finding = snapshot && device ? findingFor(snapshot.findings, device.id) : undefined;
  const detail = useDeviceDetail(selectedId, (device?.lastSeen ?? 0) + version);

  const act = useCallback(
    async (request: ActionRequest) => {
      await dispatch(request, postAction);
      setVersion((current) => current + 1);
    },
    [dispatch],
  );

  const rename = useCallback(
    (placeId: number, label: string) => act({ action: "rename-place", placeId, label }),
    [act],
  );

  const offline = !connected || snapshot?.status.sensor === "offline";
  const state = !connected ? "offline" : (snapshot?.status.sensor ?? "stale");
  const here = places.find((place) => place.current);
  const inRange = snapshot?.devices.filter((candidate) => candidate.live).length ?? 0;

  return (
    <MotionConfig reducedMotion="user">
      <main className="console" data-film={film}>
        <header className="topbar">
          <div className="brand">
            <Logo />
            <h1 className="wordmark">palantiny</h1>
          </div>
          <div className="status" data-state={state} role="status">
            <i className="status-mark" key={snapshot?.status.lastEventAt ?? 0} aria-hidden="true" />
            <span>
              {!connected ? "Console disconnected" : snapshot ? statusLine(snapshot) : "Connecting"}
              {here && !offline && ` at ${here.label ?? here.code}`}
            </span>
            {snapshot && !offline && <span className="in-range"><span className="data">{inRange}</span> in range</span>}
          </div>
          <div className="topbar-end">
            {snapshot?.fixture && <span className="flag">Test data, not real sightings</span>}
            {reveal && <span className="flag">Names visible, don't record</span>}
            <div className="segmented" role="group" aria-label="View">
              <button className="segment" aria-pressed={view === "graph"} disabled={!webgl} onClick={() => setView("graph")}>
                Graph <kbd>G</kbd>
              </button>
              <button
                className="segment"
                aria-pressed={view === "list"}
                onClick={() => {
                  setView("list");
                  setFilm(false);
                }}
              >
                List <kbd>L</kbd>
              </button>
            </div>
            <button className="btn" aria-pressed={film} disabled={!webgl} onClick={() => { setView("graph"); setFilm(!film); }}>
              Film <kbd>F</kbd>
            </button>
            <button className="switch" role="switch" aria-checked={!reveal} onClick={() => setReveal(!reveal)}>
              <i className="switch-track" aria-hidden="true" />
              Screenshot mode
            </button>
          </div>
        </header>

        <nav className="left" aria-label="Findings and places">
          {snapshot ? (
            <>
              <Findings findings={snapshot.findings} places={snapshot.places} devices={snapshot.devices} selectedId={selectedId} onSelect={setSelectedId} />
              <Places places={snapshot.places} inRange={inRange} now={snapshot.generatedAt} onRename={rename} />
              <Arrivals devices={snapshot.devices} selectedId={selectedId} onSelect={setSelectedId} now={snapshot.generatedAt} />
            </>
          ) : (
            <section className="section" aria-busy="true">
              <div className="skeleton" />
              <div className="skeleton" style={{ width: "80%" }} />
            </section>
          )}
        </nav>

        <div className="stage">
          {snapshot && places.length > 0 && view === "graph" && webgl && (
            <Suspense fallback={null}>
              <Scene
                places={places}
                devices={snapshot.devices}
                findings={snapshot.findings}
                selectedId={selectedId}
                onSelect={setSelectedId}
                film={film}
                reducedMotion={reducedMotion}
                inset={device && !film && wide ? INSPECTOR_WIDTH : 0}
              />
            </Suspense>
          )}
          {snapshot && places.length > 0 && view === "list" && (
            <DeviceTable
              devices={snapshot.devices}
              findings={snapshot.findings}
              selectedId={selectedId}
              onSelect={setSelectedId}
              now={snapshot.generatedAt}
            />
          )}
          {snapshot && places.length > 0 && view === "graph" && <Ledger totals={snapshot.totals} />}
          {snapshot && places.length > 0 && view === "graph" && <GraphKey />}
          {snapshot && film && <FilmCaption place={here} findings={snapshot.findings} devices={snapshot.devices} />}
          {snapshot && places.length === 0 && <Setup snapshot={snapshot} />}
        </div>

        {snapshot && (
          <Timeline
            places={places}
            visits={snapshot.visits}
            device={device}
            detail={detail}
            flagged={finding?.severity === "high"}
            now={snapshot.generatedAt}
          />
        )}

        <AnimatePresence>
          {snapshot && device && (
            <Inspector
              key="inspector"
              snapshot={snapshot}
              device={device}
              finding={finding}
              detail={detail}
              onAction={act}
              onClose={() => setSelectedId(null)}
            />
          )}
        </AnimatePresence>
      </main>
    </MotionConfig>
  );
}
