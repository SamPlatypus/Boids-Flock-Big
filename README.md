# Boids: Flocking Ecosystem

An offline-first, mobile-optimized flocking simulation on a full-bleed HTML5 canvas. Three prey species school in different ways, apex predators hunt them with a state machine, and panic waves sweep through the flock. You can push the water around with multi-touch.

On top of that runs an **ecosystem**. Food blooms and drifts, every agent burns energy as it swims, the well fed divide (with mutation), the hungry starve, and predators live off what they catch. Populations rise and fall in predator–prey cycles instead of staying fixed. A **glass control drawer** shows live metrics and a population chart, and has sliders, presets, colour palettes and glowing motion trails.

Everything is plain JavaScript ES modules with **zero runtime dependencies**. The whole app also ships as **one self-contained HTML file** that runs offline.

## Quick start

| How | Command / action |
| --- | --- |
| Single file, no server | Open `dist/boids.html` (or `index.html`, which forwards to it from disk). HTML, CSS and JS are all inline: nothing is fetched, so it works offline |
| Local dev server | `npm start` → <http://localhost:8080> |
| Test on a phone on the same Wi-Fi | `npm run start:lan`, then open the printed `Network:` URL |
| Installable / offline web app | Serve over HTTPS (e.g. GitHub Pages). After the first visit it works offline and can be added to the home screen |

There is no install step: Node ≥ 20 is only needed for the dev server, tests and build scripts. `npm install` fetches TypeScript, which is used only by `npm run typecheck`.

Browser support: iOS Safari 14.5+, Chrome / Edge 87+ and Firefox 78+. The glass blur needs Firefox 103+; older versions get solid panels.

**Gestures**

| Gesture | Effect |
| --- | --- |
| Tap | Scatter pulse: an expanding shockwave that pushes nearby prey outward and starts an alarm wave |
| Press & hold / drag | Beacon that follows the finger smoothly. One finger **attracts** (prey orbit it) |
| Two or more fingers | All beacons become **repulsors** (in the default `beaconMode: 'auto'`) |
| Mouse | Left button as above; right button or Shift+drag forces a repulsor |
| Keys (desktop) | `Space` pause · `D` debug overlay · `S` stats · `R` respawn |

Any config key can be preset in the URL, e.g. `?countSpecies1=600&debug=1`. Adding `&seed=42` makes a run reproducible.

## The control drawer

A floating **status pill** at the bottom shows the live frame rate (the dot turns amber, then red, as it drops), the number of boids and the number of active predators. Tap it to slide up the drawer. Swipe the handle down, tap ✕ or press `Esc` to close it.

The drawer is dark translucent glass (`backdrop-filter: blur(12px)`, with an opaque fallback where that is unsupported). It sits above the home indicator, docks as a side card on wide screens, and honours `prefers-reduced-motion`. Every touch target is at least 44 px. Pointer, touch, wheel and keyboard events inside it stop propagating, so dragging a slider never pokes the water or triggers a shortcut. The canvas stays fully interactive around the open drawer.

| Tab | Contents |
| --- | --- |
| **Flock** | Separation, Alignment, Cohesion, Max Speed, Turning force and Perception Radius sliders; beacon mode and touch strengths |
| **Ecosystem** | Live population chart (10 min). Per-species count, mean energy and evolved genes (generation, speed, sight). Births, starvations, catches and migrants. **− / +** steppers for each species and for predators (press and hold to repeat). Life-cycle switch, Food Spawn Rate, Energy Decay, Carrying Capacity. Predator speed, aggression, panic radius and scatter |
| **Scenes** | One-tap presets (below), Pause, Respawn, Reset all, time scale |
| **Style** | Palettes, motion trails, custom colours, stats overlay, debug view, resolution cap |

**Presets** set every behaviour key at once, so switching between them is predictable. Colours are left alone. Populations, capacity and food are scaled to the screen area.

| Preset | What it does |
| --- | --- |
| Tight Schooling | Strong cohesion (2.4) and alignment (2.2), no predators, fixed populations, light trails |
| Predator Chaos | 8 fast, maximally aggressive predators, wide panic radius and 2.2× panic scatter, fixed populations |
| Ecosystem Balance | The defaults: grazing, births, starvation and a self-sustaining predator–prey cycle |
| Zen Drift | Slow (70 px/s), wide-perception alignment ribbons, gentle scatter, long glowing trails (0.85) |

**Palettes**: Bioluminescent Abyss (midnight, electric cyan, violet, neon lime, crimson predators), Solarpunk Earth (warm slate, sage, clay amber, sunlit yellow), Cyberpunk Radar (true OLED black, monochrome greens and amber) and Minimal Monochrome (charcoal, silver, pearl, gold accent). Any of the six colours (background, three species, predator, food) can be changed with a hex field or the native colour picker. All derived colours (panic tints, strike and rest shades, glows) and the UI accent follow automatically.

**Motion trails**: switch on *Glowing wakes* and set the persistence. Instead of being cleared, each frame fades the previous ones toward the background, leaving bioluminescent wakes.

Settings are saved in `localStorage` (debounced, and flushed when the page closes), so a home-screen app reopens as you left it. Pause is not saved, and neither are live populations. With the life cycle on, each launch starts a fresh ecosystem scaled to the screen, so a crash at closing time can't carry over. Fixed populations (life cycle off) are saved. URL parameters override saved settings. *Reset all* restores the defaults.

## Configuration: `window.simConfig`

```js
simConfig.cohesionWeight = 2;          // takes effect on the next physics step
simConfig.countSpecies2 = 120;         // populations grow/shrink live
simConfig.$set({ predatorCount: 4, predatorAggression: 1 });
simConfig.$subscribe((key, value, previous) => console.log(key, previous, '→', value));
simConfig.$reset(['cohesionWeight']);  // or $reset() for everything
simConfig.$schema.maxSpeed;            // { type, default, min, max, step, unit, group, label, description }
```

Writes are validated: numbers are clamped to their range, integers are rounded, numeric strings (from `<input>` elements) are accepted, colours are normalized (`#ABC`, `abc` → `#aabbcc`), and unknown keys (typos) are rejected with a console warning instead of failing silently. The drawer is built from `$schema` and stays in sync through `$subscribe`, so changes made from the console show up in the UI.

With the life cycle on, the population counts are **live**: they track births and deaths, and writing one adds or removes agents immediately. With it off, they are fixed targets.

| Key | Default | Range | Description |
| --- | --- | --- | --- |
| **Flocking** | | | |
| `separationWeight` | 1.5 | 0 – 5 | Weight of the personal-space (collision avoidance) rule. |
| `alignmentWeight` | 1 | 0 – 5 | Weight of the velocity-matching rule. |
| `cohesionWeight` | 1 | 0 – 5 | Weight of the steer-to-local-centre rule. |
| `maxSpeed` | 140 | 20 – 500 px/s | Base prey speed limit; each species applies its own multiplier. |
| `maxForce` | 420 | 20 – 3000 px/s² | Base steering acceleration (turning) limit; species apply multipliers. |
| `perceptionRadius` | 48 | 10 – 200 px | Base neighbourhood radius for alignment, cohesion and foraging. |
| **Predators** | | | |
| `predatorSpeed` | 165 | 20 – 600 px/s | Pursuit speed. Patrol, rest and strike speeds are derived from it. |
| `predatorAggression` | 0.6 | 0 – 1 | Detection range, hunting threshold, persistence and rest length. |
| `panicRadius` | 110 | 0 – 400 px | Distance at which prey detect a predator and flee. |
| `panicScatter` | 1 | 0 – 3 × | Strength of the flee response, escape memory and flash expansion. |
| **Ecosystem** | | | |
| `ecosystem` | true | true / false | Food, energy, births and starvation. Off: fixed populations. |
| `foodSpawnRate` | 24 | 0 – 120 /s | Food particles bloomed per second. |
| `energyDecay` | 1 | 0.2 – 3 × | Metabolic rate. Energy drains faster at higher speed. |
| `carryingCapacity` | 480 | 50 – 2000 | Soft limit on total prey: births slow down as it fills. |
| **Population** | | | |
| `countSpecies1` | 160 | 0 – 3000 | Dartfish: fast, agile, tight bait balls. |
| `countSpecies2` | 40 | 0 – 1000 | Mantas: large, slow-turning, sweeping migration ribbons. |
| `countSpecies3` | 100 | 0 – 3000 | Skittish Foragers: erratic bursts, exaggerated scatter. |
| `predatorCount` | 3 | 0 – 40 | Number of apex predators. |
| **Interaction** | | | |
| `beaconMode` | `auto` | `auto` / `attract` / `repel` | Press-and-hold beacon: auto = one finger attracts, two or more fingers all repel. |
| `beaconStrength` | 1 | 0 – 3 × | Strength of press-and-hold attractors and repulsors. |
| `pulseStrength` | 1 | 0 – 3 × | Strength of the tap scatter shockwave. |
| **Appearance** | | | |
| `trails` | 0 | 0 – 0.95 | Trail persistence: 0 redraws crisply, higher values leave glowing wakes. |
| `colorBackground` | `#040d1a` | hex colour | Canvas background colour. |
| `colorSpecies1` | `#3cf2ff` | hex colour | Dartfish colour (also the UI accent). |
| `colorSpecies2` | `#a77bff` | hex colour | Manta colour. |
| `colorSpecies3` | `#b6ff3b` | hex colour | Forager colour. |
| `colorPredator` | `#ff2e4d` | hex colour | Predator colour. |
| `colorFood` | `#ff7ad9` | hex colour | Food / flora colour. |
| **Simulation** | | | |
| `paused` | false | true / false | Freeze the simulation (rendering continues). |
| `timeScale` | 1 | 0 – 4 × | Slow motion (< 1) or fast forward (> 1). The physics step stays fixed. |
| `maxPixelRatio` | 3 | 0.5 – 4 × | Upper bound on devicePixelRatio used for the canvas backing store. |
| `showStats` | false | true / false | Show the detailed FPS / timing overlay. |
| `debug` | false | true / false | Draw the spatial grid, perception radii, energy bars and predator state. |

The defaults describe a phone-sized world (412 × 839 CSS px). At startup, populations, carrying capacity and food rate are multiplied by the screen's area relative to that, clamped to 0.6 – 4×, so a desktop window gets a proportionally larger ecosystem with the same density and dynamics. Presets and *Reset all* scale the same way.

## Hooks: `window.sim`

`window.sim` is the controller returned by `createFlockingApp()` from [`src/app.js`](src/app.js). The same API can embed the engine elsewhere:

```js
import { createFlockingApp } from './src/app.js';
const app = createFlockingApp({ canvas, statsElement, config: { debug: true }, seed: 42 });
app.start();             // also: stop(), reset(seed?), step(n), destroy()
app.applyScenario('zen');  // 'schooling' | 'chaos' | 'balance' | 'zen', scaled to the screen
app.resetDefaults();

app.sim.on('catch', ({ predator, prey, species, x, y, time }) => { /* … */ });
app.sim.on('predatorState', ({ id, from, to, time }) => { /* patrol → pursue → strike → rest */ });
app.sim.on('birth', ({ species, id, parent, generation, x, y }) => { /* a prey divided */ });
app.sim.on('death', ({ species, cause, generation }) => { /* cause: 'eaten' | 'starved' */ });
app.sim.on('predatorBirth', (e) => {}); app.sim.on('predatorDeath', (e) => {});
app.sim.on('extinction', ({ kind, species }) => { /* a wanted population died out */ });
app.sim.on('immigration', ({ kind, species, count }) => { /* extinction rescue */ });
app.sim.addPulse(x, y);  // programmatic touch physics
app.sim.setBeacon('ui', x, y, 'repel');  app.sim.releaseBeacon('ui');
app.sim.species[0].cohesion = 4;   // species profiles are live and tunable at runtime
app.sim.speciesSummary();          // per species: count, mean energy, mean genes, max generation
app.sim.history;         // ring buffer of population samples (2 s apart, 10 minutes)
app.sim.stats;           // { catches, births, starvations, grazed, predatorBirths, … }
```

The simulation core ([`src/sim`](src/sim), [`src/core`](src/core)) is DOM-free. It runs unchanged in Node (tests, benchmarks) and would run in a Web Worker.

## How it works

### Spatial hash: O(N) neighbour search

[`src/core/spatial-hash.js`](src/core/spatial-hash.js) is a toroidal uniform-grid bin lattice.

- **Build**: a two-pass counting sort of all agents into flat typed arrays every step. O(N + cells), no allocation.
- **Query**: "everything within radius *r*, or the *K* nearest if more qualify". Cells are scanned in square rings around the agent's cell while a max-heap keeps the K best. After each ring, the distance to the unvisited region is a lower bound on every remaining candidate, so once the heap is full and its farthest member beats that bound the search stops. Per-agent work is bounded even inside a dense bait ball, which keeps a step O(N) as density rises. A plain fixed-radius grid degrades toward O(N²) as agents crowd together.
- Cells tile the torus exactly (`cellWidth = W / cols`), so cell indices wrap with modular arithmetic and nothing straddles a seam.
- Prey use K = 16 nearest neighbours, a topological interaction as observed in real schools. Food lives in its own hash and is found with a K = 1 query. Tests compare every query against brute force, including worlds smaller than the query radius.

### Toroidal geometry

Every distance and direction (flocking, flee, pursuit, grazing, touch) uses the minimum-image convention, `dx = dx − W·round(dx/W)` and `dy = dy − H·round(dy/H)`, and positions wrap with `x mod W`. Render interpolation also follows the shortest path across a seam. Any agent or food particle whose drawing overlaps an edge is drawn again at its wrapped image(s), up to 3 extra copies in corners, so everything glides across edges and never pops.

### Steering and integration

All rules are smooth functions of distance, so neighbours entering or leaving a radius never cause force jumps:

- **Separation**: Σ (1 − d/r)² · û_away. Omnidirectional, like a fish's lateral line.
- **Alignment**: Σ kⱼ(vⱼ − v) / (Σkⱼ + c₀). The agent counts itself (c₀), which keeps the mean continuous.
- **Cohesion**: seek the soft local centre Σ kⱼΔxⱼ / (Σkⱼ + c₀), with urgency growing with its offset.
- **Kernel** kⱼ = (1 − d²/R²)² × field-of-view weight, which forms a smooth blind cone behind the agent.

Forces combine with Reynolds' **prioritized acceleration allocation**: (1) flee / alarm, (2) separation, (3) alignment + cohesion + grazing + wander + cruise control + attractors. Each claims budget up to its magnitude, so an urgent flee overrides alignment, cohesion and hunger.

Integration is **semi-implicit (symplectic) Euler** at a fixed 60 Hz step (`v' = clamp(v + a·dt)`, `x' = wrap(x + v'·dt)`), with render interpolation for 90/120 Hz displays. Two guarantees hold for every agent at every step, and the tests check them under extreme parameters, abrupt config changes and the full life cycle:

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
| Ecology | high metabolism, grazes close to the school | efficient filter feeder, slow to breed | forages far afield (2.8× sight), breeds fastest |

The flocking profiles were tuned against measured shape statistics, not by eye alone. Dartfish school elongation (principal-axis ratio) is ≈1.6 versus ≈2.8 before tuning. After an identical startle, foragers spread ≈2.5× farther than the other species within a second.

### Panic waves

Each prey has a panic level in [0, 1]. It rises toward max(direct threat, transmission × loudest neighbour's panic) through a first-order lag and then decays. The lag sets how fast the shockwave travels (≈400 px/s), and transmission < 1 makes it fade with distance. Panicked agents flee (overriding alignment, cohesion and grazing), copy their panicked neighbours' escape velocity (which carries the threat's direction beyond the range where it is visible), sprint, steer harder, and grow their personal space (flash expansion). `panicScatter` scales the flee strength, escape memory and flash expansion. Panic is double-buffered, so contagion is independent of agent order.

### Apex predator

[`src/sim/predator.js`](src/sim/predator.js) runs a state machine: **patrol** (smooth wander) → **pursue** → **strike** → **rest**.

- **Pursue** locks the most vulnerable nearby prey: close, isolated (confusion effect), ahead, slow species. Hysteresis prevents dithering between targets. It steers toward the **predicted intercept**, the smallest t > 0 solving |r + v·t| = s·t, i.e. `(v·v − s²)t² + 2(r·v)t + r·r = 0`, falling back to Reynolds' pursuit estimate when no solution exists.
- **Strike** is a 0.45 s lunge at 1.75× speed. Contact during pursuit or strike is a catch. It emits a `catch` event and sends the predator into a satiated rest. With the life cycle on, the prey is eaten and its nutrition feeds the predator. With it off, the prey respawns elsewhere so populations stay fixed.
- **Stamina** drains while pursuing and fast while striking, recovers in patrol and rest, and a catch restores some.
- **Aggression** scales detection range, the stamina needed to start a hunt, persistence and rest length. With the life cycle on, a well-fed predator is choosier and a hungry one hunts sooner.
- **Prey switching**: species that are more common than an even share are preferred (frequency-dependent predation), which takes pressure off rare species and stabilises coexistence.
- Prey read intent: a resting predator is far less alarming than a hunting one, and prey flee from where it is about to be, not where it is.

### Ecosystem

[`src/sim/food.js`](src/sim/food.js) and [`src/sim/ecology.js`](src/sim/ecology.js):

- **Food** blooms in clusters: blooms start as a Poisson process at `foodSpawnRate` and release 6 – 13 particles over a second, with an 18 px Gaussian spread. Particles live about 45 s, at most 420 per phone screen. They drift on a current given by the curl of a periodic stream function. The flow is divergence-free, so food neither piles up nor leaves voids, and it is seamless across the torus edges.
- **Energy** E ∈ [0, 1] drains at `m · (0.35 + 0.65·(|v| / v_cruise)²)` per second: a basal share plus a drag-like term, so fleeing and sprinting are expensive. `energyDecay` scales m.
- **Grazing**: a hungry agent steers to the nearest food within its sight × forage range, with weight ∝ hunger², and eats what its mouth touches. Hunger pulls individuals away from the school toward food patches; panic suppresses it.
- **Division (mitosis)**: once full (E ≥ 0.95) an agent splits at rate `fertility · (1 − n/K)⁺`. K is the species' share of `carryingCapacity`, and the (1 − n/K) factor is the soft capacity damping (logistic growth). Mother and daughter each keep E/2. The daughter's speed and perception genes mutate log-normally (σ = 4 %, kept within 0.7 – 1.4), so selection acts on them: the drawer shows their mean drift and the generation count. Newborns grow in visibly.
- **Starvation** at E = 0: the agent dies where it is, leaving a fading speck.
- **Predators** burn `metabolism + effortCost · (v / v_pursuit)²`, and each catch restores the prey's nutrition. A full predator divides at a rate damped by `(1 − P / (prey / 16))`: the prey supply sets the predator capacity. At E = 0 it starves and despawns, so predators can never wipe out the flock and persist.
- **Extinction rescue**: if a species you still want (its count was above zero) dies out, a small school of migrants arrives after 15 s, and a predator migrates in once prey are plentiful again. Setting a count to zero yourself removes that species for good.

This is the Rosenzweig–MacArthur picture: prey boom on food, predators feed and multiply, prey crash, predators starve, prey recover. Logistic prey growth turns the neutral Lotka–Volterra orbits into oscillations around a stable equilibrium, and the stochastic, spatial dynamics keep them excited.

Measured with the defaults on a phone-sized world (three seeds, 20 simulated minutes each), every prey species persisted in every run. Predators rose and fell between about 6 and 12, with 14 – 16 population peaks per run. Each run saw ≈1,800 births, ≈560 starvations and ≈1,280 catches, and lineages reached 21 – 28 generations. Extinction rescue fired 0, 1 and 2 times, always for predators. After a crash they died out and migrants re-seeded them, while the prey they had been holding down surged (foragers 30 → 167 in one run). Scaled to a 1440 × 900 desktop world (15 minutes), it held roughly 800 – 1,000 prey and 25 – 40 predators with no rescue needed.

With the life cycle off, populations are fixed: caught prey respawn elsewhere, and the remaining food fades out within 3 s.

### Touch physics

A tap creates a pulse with push(d, t) = strength · e^(−t/τ) · (1 − u²)², where u = (d − c·t)/thickness. This is a smooth wavefront travelling outward at 540 px/s with exponential decay, and it also induces panic. Beacons ease toward the finger, ramp in and out instead of popping, and act on toroidal distance. Repulsors also push predators, so you can defend a school.

### Rendering

[`src/render/renderer.js`](src/render/renderer.js):

- **Silhouettes**: one `Path2D` per species is drawn per agent with a single `setTransform` + `fill`, with agents bucketed by species and panic tint. I measured this against alternatives. One giant path per colour rasterizes superlinearly when silhouettes overlap in dense schools (21 ms vs 7 ms at 2000 agents), and rotated sprite `drawImage` was slower still. Reusing identical path geometry is also what GPU canvas backends cache best. Food is a pre-rendered glow sprite.
- **Sharpness**: the backing store tracks CSS size × `devicePixelRatio`, using `device-pixel-content-box` when it is trustworthy, and reacts to DPR changes from zoom or moving between monitors.
- **Theming**: every drawing colour is derived from the six config colours. The vignette is multiplicative, so true black stays black on OLED screens.
- **Vignette**: it is the canvas element's CSS background, rebuilt only when the colour or size changes, and each frame starts with `clearRect`. Filling a full-screen radial gradient into the canvas every frame cut a 4× CPU-throttled phone emulation from 60 to 20 fps, because wherever canvas pixels are drawn by the CPU the gradient is re-evaluated for every pixel of every frame.
- **Trails**: instead of clearing, each frame paints the flat background colour at alpha `1 − trails^(dt·60)`, which is frame-rate independent. I measured what alternatives leave behind on a black background. Translucent *gradient* fills and `destination-out` fades stall a few 8-bit levels above their target, and the result was ghost trails burned into up to 74 % of the screen. Flat source-over fills converge exactly. When trails are switched on, the same fills crossfade away from the vignette. Two seconds later a single opaque `lighten` fill lifts the pixels that stalled below the background, so no map of old paths is left behind. Additive (`lighter`) blending was tried and rejected, because overlapping agents saturate to white and the species lose their colours.

## Performance

`npm run bench` (Node, no rendering) on the development machine:

| Neighbour search, constant density | 500 | 1000 | 2000 | 4000 agents |
| --- | --- | --- | --- | --- |
| Spatial hash | 0.18 ms | 0.39 ms | 0.81 ms | 1.7 ms |
| Naive all-pairs | 3.7 ms | 19 ms | 78 ms | 319 ms |

| Full step, constant density, µs per agent | 300 | 1000 | 2500 | 5000 agents |
| --- | --- | --- | --- | --- |
| Flocking only (life cycle off) | 1.59 | 1.47 | 1.33 | 1.33 |
| With the ecosystem (food, grazing, life cycle) | 1.85 | 1.93 | 1.84 | 1.57 |

Cost per agent stays flat as N grows, so a step is O(N). The ecosystem adds about 0.3–0.5 µs per agent, mostly the food lookup.

In the browser, measured in headless Chromium with Pixel 7 emulation (DPR 2.625) at the defaults (≈320 prey, 3–6 predators, food), the JavaScript cost per frame is:

| CPU | Simulation step | Drawing | Total per frame |
| --- | --- | --- | --- |
| 1× (desktop-class) | 0.65 ms | 0.21 ms | 0.9 ms |
| 4× throttled (mid-range phone) | 2.75 ms | 0.96 ms | 3.7 ms |
| 6× throttled (low-end phone) | 4.40 ms | 1.68 ms | 6.1 ms |

That is well inside the 16.7 ms budget of a 60 Hz frame. With the drawer open, its live metrics add ≈0.5 ms of style and layout per frame at 4×, and the chart redraws once a second.

These are emulation measurements on a desktop-class CPU without a GPU, not real-device numbers. The headless browser composites in software, and CPU throttling inflates that pixel work too: at 4× it takes ≈14 ms of every frame, which phones do on the GPU. So the frame rate under throttling understates a real phone. The JavaScript times above exclude it. Treat them as indicative and check on real hardware.

## Project layout

```
index.html               full-bleed canvas shell (touch-action: none, safe areas, PWA meta)
src/main.js              browser entry: boots the app and the HUD, exposes window.simConfig / window.sim
src/app.js               controller: config + simulation + canvas + renderer + input + loop
src/config.js            reactive, validated, self-describing config store
src/presets.js           one-tap scenarios and screen-area scaling
src/themes.js            colour palettes
src/persist.js           settings persistence (localStorage)
src/loop.js              fixed-timestep loop with interpolation and spiral-of-death guard
src/stats.js             FPS / timing overlay
src/core/                torus maths, spatial hash, seeded PRNG, colour maths, scalar helpers, event emitter
src/sim/                 simulation, species, prey pool (struct of arrays), flocking, predator, interactions,
                         food field, ecology (life cycle), population history
src/render/              DPR-aware surface, silhouettes, renderer
src/input/               multi-touch gestures → simulation API
src/ui/                  glass HUD: pill + drawer, schema-bound controls, population chart, styles
sw.js, manifest.webmanifest, icons/   offline-first PWA shell
dist/boids.html          generated single-file build (all JS and CSS inline; runs from file://)
scripts/                 serve.mjs (dev server) · build.mjs (zero-dependency bundler) · bench.mjs
test/                    node:test suites (run headless, no browser needed)
```

## Development

```sh
npm test            # 57 tests: torus maths, spatial hash vs brute force, config validation,
                    # integrator invariants, determinism, panic waves, predator FSM, ecosystem
                    # (metabolism, grazing, division, mutation, starvation, capacity, predator
                    # energetics, rescue, food), presets, palettes, persistence, PWA + build freshness
npm run typecheck   # strict TypeScript checking of the JSDoc-annotated sources (needs npm install)
npm run build       # regenerate dist/boids.html (a test fails if it is stale)
npm run bench       # headless performance benchmark
```

Notes for contributors:

- The sources are plain ES modules. The browser runs `src/` as-is, so there is no compile step.
- When adding a module or stylesheet, also list it in `PRECACHE` in `sw.js` (a test enforces this).
- The zero-dependency bundler supports named imports and `export` declarations only, and fails loudly on anything else. It also inlines `<link rel="stylesheet">` files.
