import React, { useEffect, useMemo, useReducer, useRef } from "react";
import "./App.css";

/**
 * LocalStorage schema versioning so we can evolve without breaking old saves.
 */
const STORAGE_KEY = "focus_music_state_v1";

/**
 * Sound definitions (no external audio files). We synthesize audio with WebAudio.
 * This avoids bundling assets while still providing an ambient mixer.
 */
const SOUND_DEFS = [
  { id: "rain", label: "Rain", kind: "noise", color: "cyan" },
  { id: "waves", label: "Waves", kind: "noise", color: "purple" },
  { id: "cafe", label: "Café", kind: "noise", color: "pink" },
  { id: "fan", label: "Fan", kind: "noise", color: "cyan" },
  { id: "synth", label: "Synth Pad", kind: "tone", color: "purple" }
];

/**
 * Built-in presets. Users can also save their own favorites.
 */
const BUILTIN_PRESETS = [
  {
    id: "deep-focus",
    name: "Deep Focus",
    mix: { rain: 0.55, waves: 0.0, cafe: 0.15, fan: 0.35, synth: 0.22 }
  },
  {
    id: "cozy-cafe",
    name: "Cozy Café",
    mix: { rain: 0.0, waves: 0.0, cafe: 0.65, fan: 0.22, synth: 0.15 }
  },
  {
    id: "ocean-night",
    name: "Ocean Night",
    mix: { rain: 0.08, waves: 0.62, cafe: 0.0, fan: 0.25, synth: 0.12 }
  }
];

const DEFAULT_STATE = {
  timer: {
    mode: "focus", // "focus" | "break"
    isRunning: false,
    focusMinutes: 25,
    breakMinutes: 5,
    remainingSeconds: 25 * 60
  },
  mixer: {
    masterMuted: false,
    playing: false,
    volumes: SOUND_DEFS.reduce((acc, s) => {
      acc[s.id] = 0;
      return acc;
    }, {})
  },
  favorites: {
    items: [] // { id, name, mix, createdAt }
  },
  history: {
    sessions: [] // { id, endedAt, mode, plannedMinutes, actualSeconds }
  },
  ui: {
    toast: null // string | null
  }
};

/**
 * Helpers
 */
function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function formatMMSS(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function safeParseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function minutesForMode(state, mode) {
  return mode === "focus" ? state.timer.focusMinutes : state.timer.breakMinutes;
}

function initialStateFromStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_STATE;
  const parsed = safeParseJSON(raw);
  if (!parsed || typeof parsed !== "object") return DEFAULT_STATE;

  // Very light validation + safe merging with defaults.
  const merged = {
    ...DEFAULT_STATE,
    ...parsed,
    timer: { ...DEFAULT_STATE.timer, ...(parsed.timer || {}) },
    mixer: { ...DEFAULT_STATE.mixer, ...(parsed.mixer || {}) },
    favorites: { ...DEFAULT_STATE.favorites, ...(parsed.favorites || {}) },
    history: { ...DEFAULT_STATE.history, ...(parsed.history || {}) },
    ui: { ...DEFAULT_STATE.ui, toast: null }
  };

  // Ensure required sound volume keys exist.
  const vol = { ...DEFAULT_STATE.mixer.volumes, ...(merged.mixer.volumes || {}) };
  merged.mixer.volumes = vol;

  // Clamp volumes.
  for (const k of Object.keys(merged.mixer.volumes)) {
    merged.mixer.volumes[k] = clamp01(Number(merged.mixer.volumes[k] ?? 0));
  }

  // Remaining seconds must be numeric.
  merged.timer.remainingSeconds = Math.max(0, Number(merged.timer.remainingSeconds || 0));

  return merged;
}

/**
 * Reducer
 */
function reducer(state, action) {
  switch (action.type) {
    case "TOAST": {
      return { ...state, ui: { ...state.ui, toast: action.message } };
    }
    case "CLEAR_TOAST": {
      return { ...state, ui: { ...state.ui, toast: null } };
    }
    case "TIMER_SET_MODE": {
      const mode = action.mode;
      const minutes = minutesForMode(state, mode);
      return {
        ...state,
        timer: {
          ...state.timer,
          mode,
          isRunning: false,
          remainingSeconds: Math.round(minutes * 60)
        }
      };
    }
    case "TIMER_SET_MINUTES": {
      const { focusMinutes, breakMinutes } = action;
      const nextTimer = {
        ...state.timer,
        focusMinutes,
        breakMinutes
      };
      const minutes = minutesForMode({ ...state, timer: nextTimer }, nextTimer.mode);
      return {
        ...state,
        timer: {
          ...nextTimer,
          isRunning: false,
          remainingSeconds: Math.round(minutes * 60)
        }
      };
    }
    case "TIMER_TOGGLE": {
      return { ...state, timer: { ...state.timer, isRunning: !state.timer.isRunning } };
    }
    case "TIMER_RESET": {
      const minutes = minutesForMode(state, state.timer.mode);
      return {
        ...state,
        timer: {
          ...state.timer,
          isRunning: false,
          remainingSeconds: Math.round(minutes * 60)
        }
      };
    }
    case "TIMER_TICK": {
      const next = Math.max(0, state.timer.remainingSeconds - 1);
      return { ...state, timer: { ...state.timer, remainingSeconds: next } };
    }
    case "TIMER_FINISH": {
      // Log a session and switch mode (focus -> break -> focus).
      const now = Date.now();
      const plannedMinutes = minutesForMode(state, state.timer.mode);
      const elapsed = Math.round(plannedMinutes * 60) - state.timer.remainingSeconds;
      const session = {
        id: uid("session"),
        endedAt: now,
        mode: state.timer.mode,
        plannedMinutes,
        actualSeconds: Math.max(0, elapsed)
      };
      const nextMode = state.timer.mode === "focus" ? "break" : "focus";
      const nextMinutes = minutesForMode(state, nextMode);

      const sessions = [session, ...(state.history.sessions || [])].slice(0, 50);

      return {
        ...state,
        history: { ...state.history, sessions },
        timer: {
          ...state.timer,
          mode: nextMode,
          isRunning: false,
          remainingSeconds: Math.round(nextMinutes * 60)
        }
      };
    }
    case "MIXER_TOGGLE_PLAY": {
      return { ...state, mixer: { ...state.mixer, playing: !state.mixer.playing } };
    }
    case "MIXER_TOGGLE_MUTE": {
      return { ...state, mixer: { ...state.mixer, masterMuted: !state.mixer.masterMuted } };
    }
    case "MIXER_SET_VOLUME": {
      const { soundId, value } = action;
      return {
        ...state,
        mixer: {
          ...state.mixer,
          volumes: { ...state.mixer.volumes, [soundId]: clamp01(value) }
        }
      };
    }
    case "MIXER_APPLY_MIX": {
      const mix = action.mix || {};
      const nextVolumes = { ...state.mixer.volumes };
      for (const s of SOUND_DEFS) {
        const v = mix[s.id];
        if (typeof v === "number") nextVolumes[s.id] = clamp01(v);
      }
      return {
        ...state,
        mixer: { ...state.mixer, volumes: nextVolumes }
      };
    }
    case "FAV_ADD": {
      const name = (action.name || "").trim();
      if (!name) return state;

      const mix = { ...state.mixer.volumes };
      const item = { id: uid("fav"), name, mix, createdAt: Date.now() };
      const items = [item, ...(state.favorites.items || [])].slice(0, 25);
      return { ...state, favorites: { ...state.favorites, items }, ui: { ...state.ui, toast: "Saved to Favorites." } };
    }
    case "FAV_REMOVE": {
      const items = (state.favorites.items || []).filter((x) => x.id !== action.id);
      return { ...state, favorites: { ...state.favorites, items } };
    }
    case "HISTORY_CLEAR": {
      return { ...state, history: { ...state.history, sessions: [] } };
    }
    default:
      return state;
  }
}

/**
 * WebAudio synth utilities.
 * We use a single AudioContext and per-sound GainNodes to implement the mixer.
 */
function createNoiseSource(context, flavor) {
  const bufferSize = context.sampleRate * 2;
  const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
  const data = buffer.getChannelData(0);

  // Basic colored-ish noise variants by simple filtering per flavor.
  for (let i = 0; i < bufferSize; i += 1) {
    const white = Math.random() * 2 - 1;
    if (flavor === "fan") {
      // Slightly dampened
      data[i] = white * 0.35;
    } else if (flavor === "rain") {
      data[i] = white * 0.5;
    } else if (flavor === "waves") {
      data[i] = white * 0.45;
    } else if (flavor === "cafe") {
      data[i] = white * 0.4;
    } else {
      data[i] = white * 0.45;
    }
  }

  const src = context.createBufferSource();
  src.buffer = buffer;
  src.loop = true;

  // Filtering to differentiate sounds a bit.
  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value =
    flavor === "fan" ? 420 : flavor === "rain" ? 1400 : flavor === "waves" ? 700 : flavor === "cafe" ? 900 : 900;

  return { src, filter };
}

function createToneSource(context) {
  const osc = context.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 196; // G3

  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 520;

  // Slow movement for "pad" feel
  const lfo = context.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 0.08;
  const lfoGain = context.createGain();
  lfoGain.gain.value = 20;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);

  return { osc, filter, lfo };
}

/**
 * Hook: manages WebAudio mixer with per-sound gain nodes.
 * Note: No direct DOM manipulation; only WebAudio usage.
 */
function useAudioMixer({ playing, masterMuted, volumes }) {
  const audioRef = useRef({
    ctx: null,
    master: null,
    perSound: {} // soundId -> { gain, start, stop, kind }
  });

  // Start/stop engine based on `playing`.
  useEffect(() => {
    if (!playing) {
      // Suspend audio context if exists.
      const { ctx } = audioRef.current;
      if (ctx && ctx.state === "running") {
        ctx.suspend().catch(() => {});
      }
      return;
    }

    // Create context lazily only when user hits play.
    if (!audioRef.current.ctx) {
      const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContextImpl();
      const master = ctx.createGain();
      master.gain.value = masterMuted ? 0 : 1;
      master.connect(ctx.destination);

      audioRef.current.ctx = ctx;
      audioRef.current.master = master;

      // Create per sound nodes.
      for (const s of SOUND_DEFS) {
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.connect(master);

        if (s.kind === "noise") {
          audioRef.current.perSound[s.id] = {
            kind: "noise",
            gain,
            source: null,
            filter: null,
            start() {
              if (this.source) return;
              const { src, filter } = createNoiseSource(ctx, s.id);
              this.source = src;
              this.filter = filter;
              src.connect(filter);
              filter.connect(gain);
              src.start();
            },
            stop() {
              if (!this.source) return;
              try {
                this.source.stop();
              } catch {
                // ignore
              }
              this.source.disconnect();
              if (this.filter) this.filter.disconnect();
              this.source = null;
              this.filter = null;
            }
          };
        } else {
          audioRef.current.perSound[s.id] = {
            kind: "tone",
            gain,
            osc: null,
            filter: null,
            lfo: null,
            start() {
              if (this.osc) return;
              const { osc, filter, lfo } = createToneSource(ctx);
              this.osc = osc;
              this.filter = filter;
              this.lfo = lfo;
              osc.connect(filter);
              filter.connect(gain);
              lfo.start();
              osc.start();
            },
            stop() {
              if (!this.osc) return;
              try {
                this.lfo.stop();
                this.osc.stop();
              } catch {
                // ignore
              }
              this.osc.disconnect();
              if (this.filter) this.filter.disconnect();
              this.lfo.disconnect();
              this.osc = null;
              this.filter = null;
              this.lfo = null;
            }
          };
        }
      }
    }

    // Resume on play.
    const { ctx } = audioRef.current;
    if (ctx && ctx.state !== "running") {
      ctx.resume().catch(() => {});
    }

    // Ensure each sound has started, so gain changes take effect immediately.
    for (const s of SOUND_DEFS) {
      const node = audioRef.current.perSound[s.id];
      node?.start?.();
    }

    return () => {};
  }, [playing, masterMuted]);

  // Update gains whenever volumes/mute change.
  useEffect(() => {
    const { ctx, master, perSound } = audioRef.current;
    if (!ctx || !master) return;

    master.gain.value = masterMuted ? 0 : 1;

    for (const s of SOUND_DEFS) {
      const node = perSound[s.id];
      if (!node) continue;
      const v = clamp01(Number(volumes[s.id] || 0));
      // Smooth transitions to avoid clicks.
      const now = ctx.currentTime;
      node.gain.gain.cancelScheduledValues(now);
      node.gain.gain.setValueAtTime(node.gain.gain.value, now);
      node.gain.gain.linearRampToValueAtTime(v, now + 0.08);
    }
  }, [volumes, masterMuted]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      const { ctx, perSound } = audioRef.current;
      try {
        for (const s of Object.keys(perSound)) {
          perSound[s]?.stop?.();
        }
        ctx?.close?.();
      } catch {
        // ignore
      }
      audioRef.current = { ctx: null, master: null, perSound: {} };
    };
  }, []);
}

/**
 * UI Components
 */
function Card({ title, right, children }) {
  return (
    <section className="card">
      <div className="cardHeader">
        <div className="cardTitle">{title}</div>
        {right ? <div>{right}</div> : null}
      </div>
      <div className="cardBody">{children}</div>
    </section>
  );
}

function Kbd({ children }) {
  return <span className="badge">{children}</span>;
}

/**
 * PUBLIC_INTERFACE
 * App: Focus timer + ambient mixer frontend (no backend).
 */
function App() {
  const [state, dispatch] = useReducer(reducer, undefined, initialStateFromStorage);

  const totalSecondsForMode = useMemo(() => {
    const minutes = minutesForMode(state, state.timer.mode);
    return Math.round(minutes * 60);
  }, [state]);

  const progressPct = useMemo(() => {
    const total = Math.max(1, totalSecondsForMode);
    const done = total - state.timer.remainingSeconds;
    return Math.min(100, Math.max(0, (done / total) * 100));
  }, [state.timer.remainingSeconds, totalSecondsForMode]);

  // Persist to localStorage (excluding ephemeral UI state).
  useEffect(() => {
    const { ui, ...persistable } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
  }, [state]);

  // Timer ticking effect.
  useEffect(() => {
    if (!state.timer.isRunning) return;

    const t = window.setInterval(() => {
      dispatch({ type: "TIMER_TICK" });
    }, 1000);

    return () => window.clearInterval(t);
  }, [state.timer.isRunning]);

  // When timer hits 0, finish session.
  useEffect(() => {
    if (!state.timer.isRunning) return;
    if (state.timer.remainingSeconds !== 0) return;

    dispatch({ type: "TIMER_FINISH" });
    dispatch({ type: "TOAST", message: "Session complete. Mode switched." });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.timer.remainingSeconds, state.timer.isRunning]);

  // Toast auto-clear.
  useEffect(() => {
    if (!state.ui.toast) return;
    const t = window.setTimeout(() => dispatch({ type: "CLEAR_TOAST" }), 2600);
    return () => window.clearTimeout(t);
  }, [state.ui.toast]);

  // Keyboard shortcuts.
  useEffect(() => {
    function handler(e) {
      // Ignore typing in inputs/selects.
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "select" || tag === "textarea") return;

      if (e.code === "Space") {
        e.preventDefault();
        dispatch({ type: "TIMER_TOGGLE" });
        return;
      }
      if (e.key === "m" || e.key === "M") {
        dispatch({ type: "MIXER_TOGGLE_MUTE" });
        return;
      }
      if (e.key === "p" || e.key === "P") {
        dispatch({ type: "MIXER_TOGGLE_PLAY" });
        return;
      }
      if (e.key === "r" || e.key === "R") {
        dispatch({ type: "TIMER_RESET" });
        return;
      }
      if (e.key === "f" || e.key === "F") {
        dispatch({ type: "TIMER_SET_MODE", mode: "focus" });
        return;
      }
      if (e.key === "b" || e.key === "B") {
        dispatch({ type: "TIMER_SET_MODE", mode: "break" });
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // WebAudio mixer hook.
  useAudioMixer({
    playing: state.mixer.playing,
    masterMuted: state.mixer.masterMuted,
    volumes: state.mixer.volumes
  });

  const modeBadge = (
    <span className="badge" title="Current timer mode">
      <span className={state.timer.mode === "focus" ? "badgeDot" : "badgeDot badgeDotBreak"} />
      {state.timer.mode === "focus" ? "FOCUS" : "BREAK"}
    </span>
  );

  return (
    <div className="App">
      <div className="container">
        <div className="header">
          <div className="brand">
            <div className="brandTitle">Focus // Mixer</div>
            <div className="brandSub">Pomodoro timer + retro ambient soundboard (local only)</div>
          </div>

          <div className="kbdHint" aria-label="Keyboard shortcuts">
            <div>
              <Kbd>Space</Kbd> start/pause timer
            </div>
            <div>
              <Kbd>R</Kbd> reset timer · <Kbd>F</Kbd> focus · <Kbd>B</Kbd> break
            </div>
            <div>
              <Kbd>P</Kbd> play/pause mixer · <Kbd>M</Kbd> mute
            </div>
          </div>
        </div>

        <div className="grid">
          <Card title="Timer" right={modeBadge}>
            <div className="timerDisplay" aria-live="polite">
              {formatMMSS(state.timer.remainingSeconds)}
            </div>
            <div className="progressWrap" aria-label="Timer progress">
              <div className="progressBar" style={{ width: `${progressPct}%` }} />
            </div>

            <div className="btnRow" role="group" aria-label="Timer controls">
              <button className="btn btnPrimary" onClick={() => dispatch({ type: "TIMER_TOGGLE" })}>
                {state.timer.isRunning ? "Pause" : "Start"}
              </button>
              <button className="btn btnGhost" onClick={() => dispatch({ type: "TIMER_RESET" })}>
                Reset
              </button>
              <button className="btn" onClick={() => dispatch({ type: "TIMER_SET_MODE", mode: "focus" })}>
                Focus
              </button>
              <button className="btn" onClick={() => dispatch({ type: "TIMER_SET_MODE", mode: "break" })}>
                Break
              </button>
            </div>

            <hr className="hr" />

            <div className="formGrid" aria-label="Timer settings">
              <div className="field">
                <label className="label" htmlFor="focusMinutes">
                  Focus (min)
                </label>
                <input
                  id="focusMinutes"
                  className="input"
                  type="number"
                  min={1}
                  max={180}
                  value={state.timer.focusMinutes}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(180, Number(e.target.value || 0)));
                    dispatch({ type: "TIMER_SET_MINUTES", focusMinutes: v, breakMinutes: state.timer.breakMinutes });
                  }}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="breakMinutes">
                  Break (min)
                </label>
                <input
                  id="breakMinutes"
                  className="input"
                  type="number"
                  min={1}
                  max={60}
                  value={state.timer.breakMinutes}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(60, Number(e.target.value || 0)));
                    dispatch({ type: "TIMER_SET_MINUTES", focusMinutes: state.timer.focusMinutes, breakMinutes: v });
                  }}
                />
              </div>
            </div>

            <p className="sectionNote">
              Sessions auto-log on completion (when it hits 00:00). All settings persist in <span className="mini">localStorage</span>.
            </p>

            {state.ui.toast ? (
              <div className="toast" role="status" aria-live="polite">
                {state.ui.toast}
              </div>
            ) : null}
          </Card>

          <Card
            title="Ambient Mixer"
            right={
              <span className="badge" title="Mixer state">
                <span className="badgeDot" style={{ opacity: state.mixer.playing ? 1 : 0.25 }} />
                {state.mixer.playing ? "LIVE" : "IDLE"}
              </span>
            }
          >
            <div className="btnRow" role="group" aria-label="Mixer controls">
              <button className="btn btnPrimary" onClick={() => dispatch({ type: "MIXER_TOGGLE_PLAY" })}>
                {state.mixer.playing ? "Pause Mixer" : "Play Mixer"}
              </button>
              <button className="btn" onClick={() => dispatch({ type: "MIXER_TOGGLE_MUTE" })}>
                {state.mixer.masterMuted ? "Unmute" : "Mute"}
              </button>
              <button
                className="btn btnGhost"
                onClick={() => {
                  dispatch({ type: "MIXER_APPLY_MIX", mix: {} });
                  dispatch({ type: "TOAST", message: "Mixer cleared." });
                }}
              >
                Clear
              </button>
            </div>

            <hr className="hr" />

            <div className="soundList" aria-label="Sound channels">
              {SOUND_DEFS.map((s) => {
                const v = state.mixer.volumes[s.id] ?? 0;
                return (
                  <div className="soundRow" key={s.id}>
                    <div className="soundMeta">
                      <div className="soundName">
                        <span>{s.label}</span>
                        <span className="mini">{Math.round(v * 100)}%</span>
                      </div>
                      <div className="sliderWrap">
                        <input
                          className="slider"
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={v}
                          onChange={(e) =>
                            dispatch({ type: "MIXER_SET_VOLUME", soundId: s.id, value: Number(e.target.value) })
                          }
                          aria-label={`${s.label} volume`}
                        />
                      </div>
                    </div>

                    <div className="listItemBtns">
                      <button
                        className="btn btnSmall"
                        onClick={() => dispatch({ type: "MIXER_SET_VOLUME", soundId: s.id, value: clamp01(v + 0.1) })}
                        aria-label={`Increase ${s.label}`}
                      >
                        +10
                      </button>
                      <button
                        className="btn btnSmall"
                        onClick={() => dispatch({ type: "MIXER_SET_VOLUME", soundId: s.id, value: clamp01(v - 0.1) })}
                        aria-label={`Decrease ${s.label}`}
                      >
                        -10
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <hr className="hr" />

            <div className="cardTitle" style={{ marginBottom: 10 }}>
              Presets
            </div>
            <div className="presetRow" role="group" aria-label="Built-in presets">
              {BUILTIN_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className="btn"
                  onClick={() => {
                    dispatch({ type: "MIXER_APPLY_MIX", mix: p.mix });
                    dispatch({ type: "TOAST", message: `Applied preset: ${p.name}` });
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>

            <hr className="hr" />

            <Favorites
              items={state.favorites.items}
              onSave={(name) => dispatch({ type: "FAV_ADD", name })}
              onApply={(mix, name) => {
                dispatch({ type: "MIXER_APPLY_MIX", mix });
                dispatch({ type: "TOAST", message: `Applied favorite: ${name}` });
              }}
              onRemove={(id) => dispatch({ type: "FAV_REMOVE", id })}
            />
          </Card>
        </div>

        <div className="footerGrid">
          <Card title="Session History" right={<span className="badge">{(state.history.sessions || []).length} items</span>}>
            <History
              sessions={state.history.sessions}
              onClear={() => {
                dispatch({ type: "HISTORY_CLEAR" });
                dispatch({ type: "TOAST", message: "History cleared." });
              }}
            />
          </Card>

          <Card title="Tips" right={<span className="badge">Local-only</span>}>
            <p className="sectionNote" style={{ marginTop: 0 }}>
              This app is frontend-only and stores everything in <span className="mini">localStorage</span>.
            </p>
            <div className="list">
              <div className="listItem">
                <div>
                  <div className="listItemTitle">Audio permission</div>
                  <div className="listItemSub">
                    Browsers require a user gesture to start audio. Hit <span className="mini">Play Mixer</span> to start sound.
                  </div>
                </div>
              </div>
              <div className="listItem">
                <div>
                  <div className="listItemTitle">Workflow</div>
                  <div className="listItemSub">
                    Start the timer (Space), pick a preset, then save it to Favorites for quick reuse.
                  </div>
                </div>
              </div>
              <div className="listItem">
                <div>
                  <div className="listItemTitle">Keyboard shortcuts</div>
                  <div className="listItemSub">
                    Space = start/pause timer · P = mixer play/pause · M = mute · R = reset · F/B = focus/break
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Favorites({ items, onSave, onApply, onRemove }) {
  const [name, setName] = React.useState("");

  return (
    <div>
      <div className="cardTitle" style={{ marginBottom: 10 }}>
        Favorites
      </div>

      <div className="field" style={{ marginBottom: 10 }}>
        <label className="label" htmlFor="favName">
          Save current mix
        </label>
        <input
          id="favName"
          className="input"
          placeholder="e.g., Neon Rain"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="btnRow" style={{ justifyContent: "flex-start" }}>
        <button
          className="btn btnPrimary"
          onClick={() => {
            onSave(name);
            setName("");
          }}
          disabled={!name.trim()}
        >
          Save Favorite
        </button>
      </div>

      <hr className="hr" />

      <div className="list" aria-label="Favorite mixes">
        {(items || []).length === 0 ? (
          <div className="listItem">
            <div>
              <div className="listItemTitle">No favorites yet</div>
              <div className="listItemSub">Save your go-to mixes here for 1-click recall.</div>
            </div>
          </div>
        ) : (
          (items || []).map((f) => (
            <div className="listItem" key={f.id}>
              <div>
                <div className="listItemTitle">{f.name}</div>
                <div className="listItemSub">
                  Saved{" "}
                  {new Date(f.createdAt).toLocaleString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit"
                  })}
                </div>
              </div>
              <div className="listItemBtns">
                <button className="btn btnSmall" onClick={() => onApply(f.mix, f.name)}>
                  Apply
                </button>
                <button className="btn btnSmall btnDanger" onClick={() => onRemove(f.id)}>
                  Remove
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function History({ sessions, onClear }) {
  return (
    <div>
      <div className="btnRow" style={{ justifyContent: "flex-start", marginTop: 0 }}>
        <button className="btn btnSmall btnDanger" onClick={onClear} disabled={!sessions || sessions.length === 0}>
          Clear history
        </button>
      </div>

      <hr className="hr" />

      <div className="list" aria-label="Session history list">
        {!sessions || sessions.length === 0 ? (
          <div className="listItem">
            <div>
              <div className="listItemTitle">No sessions logged yet</div>
              <div className="listItemSub">Complete a focus or break cycle to see it here.</div>
            </div>
          </div>
        ) : (
          sessions.map((s) => (
            <div className="listItem" key={s.id}>
              <div>
                <div className="listItemTitle">{s.mode === "focus" ? "Focus" : "Break"} session</div>
                <div className="listItemSub">
                  Ended{" "}
                  {new Date(s.endedAt).toLocaleString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit"
                  })}{" "}
                  · planned {s.plannedMinutes}m · ran {Math.round((s.actualSeconds / 60) * 10) / 10}m
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default App;
