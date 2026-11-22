# Boids: Flocking Simulation Engine

An offline-first, mobile-optimized flocking simulation on a full-bleed HTML5 canvas. It has three prey species with distinct schooling behavior, apex predators driven by a hunting state machine, panic waves that sweep through the flock, and multi-touch physics. Everything is plain JavaScript ES modules with **zero runtime dependencies**.

This is **pass 1 of 2**: the simulation engine, spatial optimization, agent behaviors and touch physics. Every parameter is exposed through a reactive config object (`window.simConfig`) with full metadata, ready for the UI pass.

## Quick start

| How | Command / action |
| --- | --- |
| Local dev server | `npm start` → <http://localhost:8080> |
| Test on a phone on the same Wi-Fi | `npm run start:lan`, then open the printed `Network:` URL |
| No server at all | Open `index.html` (or `dist/boids.html`) directly; it falls back to the single-file build |
| Offline / installable | Serve over HTTPS (e.g. GitHub Pages). After the first visit it works offline and can be added to the home screen |

There is no install step: Node ≥ 20 is only needed for the dev server, tests and build scripts. `npm install` fetches TypeScript, which is used only by `npm run typecheck`.

**Gestures**

| Gesture | Effect |
| --- | --- |
| Tap | Scatter pulse: an expanding shockwave that pushes nearby prey outward and starts an alarm wave |
| Press & hold / drag | Beacon that follows the finger smoothly. One finger **attracts** (prey orbit it) |
| Two or more fingers | All beacons become **repulsors** (in the default `beaconMode: 'auto'`) |
| Mouse | Left button as above; right button or Shift+drag forces a repulsor |
| Keys (desktop) | `Space` pause · `D` debug overlay · `S` stats · `R` respawn |

Any config key can be preset in the URL, e.g. `?countSpecies1=600&debug=1`. Adding `&seed=42` makes a run reproducible.

## Configuration: `window.simConfig`

```js
simConfig.cohesionWeight = 2;          // takes effect on the next physics step
simConfig.countSpecies2 = 120;         // populations grow/shrink live
simConfig.$set({ predatorCount: 4, predatorAggression: 1 });
simConfig.$subscribe((key, value, previous) => console.log(key, previous, '→', value));
simConfig.$reset(['cohesionWeight']);  // or $reset() for everything
simConfig.$schema.maxSpeed;            // { type, default, min, max, step, unit, group, label, description }
```

Writes are validated: numbers are clamped to their range, integers are rounded, numeric strings (from `<input>` elements) are accepted, and unknown keys (typos) are rejected with a console warning instead of failing silently. `$schema` carries everything a UI needs to generate its controls.

| Key | Default | Range | Description |
| --- | --- | --- | --- |
| **Flocking** | | | |
| `separationWeight` | 1.5 | 0 – 5 | Weight of the personal-space (collision avoidance) rule. |
| `alignmentWeight` | 1 | 0 – 5 | Weight of the velocity-matching rule. |
| `cohesionWeight` | 1 | 0 – 5 | Weight of the steer-to-local-centre rule. |
| `maxSpeed` | 140 | 20 – 500 px/s | Base prey speed limit; each species applies its own multiplier. |
| `maxForce` | 420 | 20 – 3000 px/s² | Base steering acceleration (turning) limit; species apply multipliers. |
| `perceptionRadius` | 48 | 10 – 200 px | Base neighbourhood radius for alignment and cohesion. |
| **Predators** | | | |
| `predatorSpeed` | 165 | 20 – 600 px/s | Pursuit speed. Patrol, rest and strike speeds are derived from it. |
| `predatorAggression` | 0.6 | 0 – 1 | Detection range, hunting threshold, persistence and rest length. |
| `panicRadius` | 110 | 0 – 400 px | Distance at which prey detect a predator and flee. |
| **Population** | | | |
| `countSpecies1` | 160 | 0 – 3000 | Dartfish: fast, agile, tight bait balls. |
| `countSpecies2` | 40 | 0 – 1000 | Mantas: large, slow-turning, sweeping migration ribbons. |
| `countSpecies3` | 100 | 0 – 3000 | Skittish Foragers: erratic bursts, exaggerated scatter. |
| `predatorCount` | 2 | 0 – 12 | Number of apex predators. |
| **Interaction** | | | |
| `beaconMode` | `auto` | `auto` / `attract` / `repel` | Press-and-hold beacon: auto = one finger attracts, two or more fingers all repel. |
| `beaconStrength` | 1 | 0 – 3 | Strength of press-and-hold attractors and repulsors. |
| `pulseStrength` | 1 | 0 – 3 | Strength of the tap scatter shockwave. |
| **Simulation** | | | |
| `paused` | false | true / false | Freeze the simulation (rendering continues). |
| `timeScale` | 1 | 0 – 4 | Slow motion (< 1) or fast forward (> 1). The physics step stays fixed. |
| `maxPixelRatio` | 3 | 0.5 – 4 | Upper bound on devicePixelRatio used for the canvas backing store. |
| `showStats` | true | true / false | Show the FPS / timing overlay. |
| `debug` | false | true / false | Draw the spatial grid, perception radii and predator state. |

## Hooks: `window.sim`

`window.sim` is the controller returned by `createFlockingApp()` from [`src/app.js`](src/app.js). The same API can embed the engine elsewhere:

```js
import { createFlockingApp } from './src/app.js';
const app = createFlockingApp({ canvas, statsElement, config: { debug: true }, seed: 42 });
app.start();             // also: stop(), reset(seed?), step(n), destroy()

app.sim.on('catch', ({ predator, prey, species, x, y, time }) => { /* … */ });
app.sim.on('predatorState', ({ id, from, to, time }) => { /* patrol → pursue → strike → rest */ });
app.sim.addPulse(x, y);  // programmatic touch physics
app.sim.setBeacon('ui', x, y, 'repel');  app.sim.releaseBeacon('ui');
app.sim.species[0].cohesion = 4;   // species profiles are live and tunable at runtime
app.sim.stats;           // { pairChecks, catches }; app.stats.snapshot → { fps, stepMs, renderMs }
```

The simulation core ([`src/sim`](src/sim), [`src/core`](src/core)) is DOM-free. It runs unchanged in Node (tests, benchmarks) and would run in a Web Worker.

## How it works

### Spatial hash: O(N) neighbour search

[`src/core/spatial-hash.js`](src/core/spatial-hash.js) is a toroidal uniform-grid bin lattice.

- **Build**: a two-pass counting sort of all agents into flat typed arrays every step. O(N + cells), no allocation.
- **Query**: "everything within radius *r*, or the *K* nearest if more qualify". Cells are scanned in square rings around the agent's cell while a max-heap keeps the K best. After each ring, the distance to the unvisited region is a lower bound on every remaining candidate, so once the heap is full and its farthest member beats that bound the search stops. Per-agent work is bounded even inside a dense bait ball, which keeps a step O(N) as density rises. A plain fixed-radius grid degrades toward O(N²) as agents crowd together.
- Cells tile the torus exactly (`cellWidth = W / cols`), so cell indices wrap with modular arithmetic and nothing straddles a seam.
- Prey use K = 16 nearest neighbours, a topological interaction as observed in real schools. Tests compare every query against brute force, including worlds smaller than the query radius.

### Toroidal geometry

Every distance and direction (flocking, flee, pursuit, touch) uses the minimum-image convention, `dx = dx − W·round(dx/W)` and `dy = dy − H·round(dy/H)`, and positions wrap with `x mod W`. Render interpolation also follows the shortest path across a seam. Any agent whose silhouette overlaps an edge is drawn again at its wrapped image(s), up to 3 extra copies in corners, so agents glide across edges and never pop.

### Steering and integration

All rules are smooth functions of distance, so neighbours entering or leaving a radius never cause force jumps:

- **Separation**: Σ (1 − d/r)² · û_away. Omnidirectional, like a fish's lateral line.
- **Alignment**: Σ kⱼ(vⱼ − v) / (Σkⱼ + c₀). The agent counts itself (c₀), which keeps the mean continuous.
- **Cohesion**: seek the soft local centre Σ kⱼΔxⱼ / (Σkⱼ + c₀), with urgency growing with its offset.
- **Kernel** kⱼ = (1 − d²/R²)² × field-of-view weight, which forms a smooth blind cone behind the agent.

Forces combine with Reynolds' **prioritized acceleration allocation**: (1) flee / alarm, (2) separation, (3) alignment + cohesion + wander + cruise control + attractors. Each claims budget up to its magnitude, so an urgent flee overrides alignment and cohesion.

Integration is **semi-implicit (symplectic) Euler** at a fixed 60 Hz step (`v' = clamp(v + a·dt)`, `x' = wrap(x + v'·dt)`), with render interpolation for 90/120 Hz displays. Two guarantees hold for every agent at every step, and the tests check them under extreme parameters and abrupt config changes:

1. `|v| ≤ maxSpeed_eff`. The speed cap is a hard clamp.
2. `|Δv| ≤ maxForce_eff · dt`. The turning limit is never exceeded. The radial clamp is a projection onto a convex disk, hence non-expansive. When a speed limit drops (calming down, a slider moved), it is rate-limited and the force budget reserves the deceleration, so the bound still holds.

Velocity Verlet was considered, but its second-order accuracy does not survive velocity-dependent, clamped steering forces, and its half-step velocity would need its own clamp. Symplectic Euler gives exact limits at one force evaluation per step.

### Species

Each species is a profile of **multipliers on the global config**, so the global sliders scale every species while each keeps its character ([`src/sim/species.js`](src/sim/species.js)). Heading comes from θ = atan2(vy, vx), applied as (cos θ, sin θ) = v/|v|.

| | Dartfish | Mantas | Skittish Foragers |
| --- | --- | --- | --- |
| Speed / agility | 1.3× / 2.4× (fast, hyper-agile) | 0.8× / 0.32× (slow turning) | 1.0× / 1.3×, plus random sprint bursts |
| Perception / FOV | 0.75× / 360° | 1.7× / 180° (forward-biased) | 0.95× / 320° |
| Rule mix | strong cohesion (3×) + separation | alignment-dominated (2.5×) | twitchy Ornstein–Uhlenbeck wander |
| Threat response | compacts under threat (bait ball), flash expansion | moderate | detects at 1.7× range, long panic memory |
| Emergent form | tight round bait balls | sweeping ribbons and arcs | loose foraging groups that scatter |

These were tuned against measured shape statistics, not by eye alone. Dartfish school elongation (principal-axis ratio) is ≈1.6 versus ≈2.8 before tuning. After an identical startle, foragers spread ≈2.5× farther than the other species within a second.

### Panic waves

Each prey has a panic level in [0, 1]. It rises toward max(direct threat, transmission × loudest neighbour's panic) through a first-order lag and then decays. The lag sets how fast the shockwave travels (≈400 px/s), and transmission < 1 makes it fade with distance. Panicked agents flee (overriding alignment and cohesion), copy their panicked neighbours' escape velocity (which carries the threat's direction beyond the range where it is visible), sprint, steer harder, and grow their personal space (flash expansion). Panic is double-buffered, so contagion is independent of agent order.

### Apex predator

[`src/sim/predator.js`](src/sim/predator.js) runs a state machine: **patrol** (smooth wander) → **pursue** → **strike** → **rest**.

- **Pursue** locks the most vulnerable nearby prey: close, isolated (confusion effect), ahead, slow species. Hysteresis prevents dithering between targets. It steers toward the **predicted intercept**, the smallest t > 0 solving |r + v·t| = s·t, i.e. `(v·v − s²)t² + 2(r·v)t + r·r = 0`, falling back to Reynolds' pursuit estimate when no solution exists.
- **Strike** is a 0.45 s lunge at 1.75× speed. A catch respawns the prey elsewhere, so populations stay at their configured size, emits a `catch` event, and sends the predator into a longer, satiated rest.
- **Stamina** drains while pursuing and fast while striking, and recovers in patrol and rest.
- **Aggression** scales detection range, the stamina needed to start a hunt, persistence and rest length.
- Prey read intent: a resting predator is far less alarming than a hunting one, and prey flee from where it is about to be, not where it is.

### Touch physics

A tap creates a pulse with push(d, t) = strength · e^(−t/τ) · (1 − u²)², where u = (d − c·t)/thickness. This is a smooth wavefront travelling outward at 540 px/s with exponential decay, and it also induces panic. Beacons ease toward the finger, ramp in and out instead of popping, and act on toroidal distance. Repulsors also push predators, so you can defend a school.

### Rendering

[`src/render/renderer.js`](src/render/renderer.js):

- **Silhouettes**: one `Path2D` per species is drawn per agent with a single `setTransform` + `fill`, with agents bucketed by species and panic tint. I measured this against alternatives. One giant path per colour rasterizes superlinearly when silhouettes overlap in dense schools (21 ms vs 7 ms at 2000 agents), and rotated sprite `drawImage` was slower still. Reusing identical path geometry is also what GPU canvas backends cache best.
- **Sharpness**: the backing store tracks CSS size × `devicePixelRatio`, using `device-pixel-content-box` when it is trustworthy, and reacts to DPR changes from zoom or moving between monitors.

## Performance

`npm run bench` (Node, no rendering) on the development machine:

| Neighbour search, constant density | 500 | 1000 | 2000 | 4000 agents |
| --- | --- | --- | --- | --- |
| Spatial hash | 0.18 ms | 0.38 ms | 0.79 ms | 1.6 ms |
| Naive all-pairs | 3.7 ms | 20 ms | 77 ms | 311 ms |

| Full step, constant density | 300 | 1000 | 2500 | 5000 agents |
| --- | --- | --- | --- | --- |
| µs per agent | 1.41 | 1.37 | 1.28 | 1.24 |

Cost per agent stays flat as N grows, so a step is O(N).

In the browser, measured in headless Chromium with Pixel 7 emulation (DPR 2.625) and the default 300 agents: 60 fps with ≈0.45 ms simulation + ≈0.15 ms drawing per frame. With Chrome's CPU throttling as a stand-in for slower phones, the engine needs ≈2.2 ms/frame at 4× (mid-range) and ≈3.5 ms/frame at 6× (low-end), well inside the 16.7 ms budget of a 60 Hz frame. 600 agents use ≈5 ms/frame at 4×.

These are emulation measurements on a desktop-class CPU without a GPU, not real-device numbers. The headless browser rasterizes the canvas in software, and that pixel cost is excluded from the throttled figures because phones do it on the GPU. Treat them as indicative and check on real hardware.

## Project layout

```
index.html               full-bleed canvas shell (touch-action: none, safe areas, PWA meta)
src/main.js              browser entry: boots the app, exposes window.simConfig / window.sim
src/app.js               controller: config + simulation + canvas + renderer + input + loop
src/config.js            reactive, validated, self-describing config store
src/loop.js              fixed-timestep loop with interpolation and spiral-of-death guard
src/stats.js             FPS / timing overlay
src/core/                torus maths, spatial hash, seeded PRNG, scalar helpers, event emitter
src/sim/                 simulation, species, prey pool (struct of arrays), flocking, predator, interactions
src/render/              DPR-aware surface, silhouettes, renderer
src/input/               multi-touch gestures → simulation API
sw.js, manifest.webmanifest, icons/   offline-first PWA shell
dist/boids.html          generated single-file build (runs from file://)
scripts/                 serve.mjs (dev server) · build.mjs (zero-dependency bundler) · bench.mjs
test/                    node:test suites (run headless, no browser needed)
```

## Development

```sh
npm test            # 32 tests: torus maths, spatial hash vs brute force, config validation,
                    # integrator invariants, determinism, panic waves, predator FSM, PWA + build freshness
npm run typecheck   # strict TypeScript checking of the JSDoc-annotated sources (needs npm install)
npm run build       # regenerate dist/boids.html (a test fails if it is stale)
npm run bench       # headless performance benchmark
```

Notes for contributors:

- The sources are plain ES modules. The browser runs `src/` as-is, so there is no compile step.
- When adding a module, also list it in `PRECACHE` in `sw.js` (a test enforces this).
- The zero-dependency bundler supports named imports and `export` declarations only, and fails loudly on anything else.
