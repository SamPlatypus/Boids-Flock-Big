/**
 * Species profiles.
 *
 * A profile describes a species' character as multipliers of the global config
 * (`maxSpeed`, `maxForce`, `perceptionRadius`, rule weights, `panicRadius`,
 * `carryingCapacity`, …). The global sliders therefore scale every species at
 * once while each keeps its relative identity. Profiles are plain mutable
 * objects: the simulation holds live copies in `sim.species` and resolves them
 * every step, so they can be tuned at runtime. Colours come from the theme
 * config (`colorSpecies1` …), not from here.
 *
 * @module sim/species
 */

/** @typedef {import('../config.js').SimConfig} SimConfig */

/**
 * @typedef {object} SpeciesProfile
 * @property {string} key
 * @property {string} name
 * @property {'countSpecies1' | 'countSpecies2' | 'countSpecies3'} countKey Config key holding the population.
 * @property {'colorSpecies1' | 'colorSpecies2' | 'colorSpecies3'} colorKey Config key holding the colour.
 * @property {number} speed × maxSpeed: calm speed limit.
 * @property {number} cruise Preferred speed as a fraction of the calm limit.
 * @property {number} agility × maxForce: steering acceleration (turning) limit.
 * @property {number} perception × perceptionRadius: alignment / cohesion range.
 * @property {number} fieldOfView Degrees visible for alignment / cohesion (blind cone behind).
 *   Separation stays omnidirectional, like a fish's lateral line.
 * @property {number} personalSpace Separation radius in px (pairwise radii are averaged).
 * @property {number} separation × separationWeight.
 * @property {number} alignment × alignmentWeight.
 * @property {number} cohesion × cohesionWeight.
 * @property {number} panicCohesion Cohesion gain per unit of panic (> 0 compacts, < 0 scatters).
 * @property {number} wanderStrength Lateral wander force as a fraction of agility.
 * @property {number} wanderRate Mean-reversion rate of the wander process (1/s); higher is twitchier.
 * @property {number} burstRate Poisson rate of spontaneous speed bursts (1/s).
 * @property {number} burstBoost Speed-limit gain at the peak of a burst.
 * @property {number} burstDuration Decay time constant of a burst (s).
 * @property {number} burstKick Wander impulse at burst onset (sudden heading change).
 * @property {number} threatRadius × panicRadius: predator detection distance.
 * @property {number} flee Flee urgency gain.
 * @property {number} frightSpeed Speed-limit multiplier at full panic.
 * @property {number} alarmTransmission Fraction of a neighbour's panic adopted (shockwave reach).
 * @property {number} panicDecay Panic lost per second once the stimulus is gone.
 * @property {number} scatter Pull of the remembered escape heading while panicked (scatter distance).
 * @property {number} flashExpansion Personal-space growth at full panic (flash expansion).
 * @property {number} vulnerability Predator preference bonus when choosing a target.
 * @property {number} metabolism Energy (of 1) burned per second while cruising.
 * @property {number} forage Steering weight towards food when starving.
 * @property {number} forageRange × perception: distance at which food is noticed.
 * @property {number} mouth Eating reach as a multiple of half the body length.
 * @property {number} fertility Division rate (1/s) once energy is full, before crowding damping.
 * @property {number} capacityShare Share of `carryingCapacity` this species can fill.
 * @property {number} nutrition Energy a predator gains from eating one.
 * @property {number} length Body length in px (rendering, catch and eating reach).
 */

/** @type {SpeciesProfile[]} */
const PROFILES = [
  {
    key: 'dartfish',
    name: 'Dartfish',
    countKey: 'countSpecies1',
    colorKey: 'colorSpecies1',
    // Fast and agile with a short sensory range: tight, hyper-reactive bait balls.
    speed: 1.3,
    cruise: 0.72,
    agility: 2.4,
    perception: 0.75,
    fieldOfView: 360, // all-round awareness: round balls rather than follow-the-leader streams
    personalSpace: 9,
    separation: 1,
    alignment: 0.5,
    cohesion: 3,
    panicCohesion: 0.6, // bait ball: compact under threat
    wanderStrength: 0.08,
    wanderRate: 1.5,
    burstRate: 0.05,
    burstBoost: 0.4,
    burstDuration: 0.25,
    burstKick: 1,
    threatRadius: 0.9,
    flee: 2,
    frightSpeed: 1.3,
    alarmTransmission: 0.9,
    panicDecay: 1.5,
    scatter: 0.15,
    flashExpansion: 0.9,
    vulnerability: 0.1,
    metabolism: 0.012,
    forage: 1.6,
    forageRange: 1.8,
    mouth: 1,
    fertility: 0.2,
    capacityShare: 0.5,
    nutrition: 0.22,
    length: 11,
  },
  {
    key: 'manta',
    name: 'Mantas',
    countKey: 'countSpecies2',
    colorKey: 'colorSpecies2',
    // Large, slow turning, wide perception, alignment-dominated: sweeping ribbons.
    speed: 0.8,
    cruise: 0.85,
    agility: 0.32,
    perception: 1.7,
    fieldOfView: 180, // forward-biased: each follows those ahead, which draws ribbons
    personalSpace: 26,
    separation: 1,
    alignment: 2.5,
    cohesion: 0.8,
    panicCohesion: -0.3,
    wanderStrength: 0.25,
    wanderRate: 0.25,
    burstRate: 0,
    burstBoost: 0,
    burstDuration: 0.5,
    burstKick: 0,
    threatRadius: 1.05,
    flee: 1.2,
    frightSpeed: 1.2,
    alarmTransmission: 0.75,
    panicDecay: 0.8,
    scatter: 0.2,
    flashExpansion: 0.3,
    vulnerability: 0,
    metabolism: 0.008, // big, slow, efficient filter feeders
    forage: 1.2,
    forageRange: 1.2,
    mouth: 1.6, // wide filter-feeding mouth
    fertility: 0.15,
    capacityShare: 0.15,
    nutrition: 0.35,
    length: 18,
  },
  {
    key: 'forager',
    name: 'Skittish Foragers',
    countKey: 'countSpecies3',
    colorKey: 'colorSpecies3',
    // Medium build, twitchy wander, random speed bursts, early detection and a
    // long panic memory: exaggerated scatter. The best food finders.
    speed: 1,
    cruise: 0.6,
    agility: 1.3,
    perception: 0.95,
    fieldOfView: 320,
    personalSpace: 14,
    separation: 1.2,
    alignment: 0.7,
    cohesion: 0.9,
    panicCohesion: -1, // scatter: cohesion vanishes in panic
    wanderStrength: 0.3,
    wanderRate: 3,
    burstRate: 0.5,
    burstBoost: 0.6,
    burstDuration: 0.35,
    burstKick: 2,
    threatRadius: 1.7,
    flee: 2.6,
    frightSpeed: 1.4,
    alarmTransmission: 0.93,
    panicDecay: 0.35,
    scatter: 0.9,
    flashExpansion: 1.2,
    vulnerability: 0.2,
    metabolism: 0.008,
    forage: 2.4,
    forageRange: 2.8,
    mouth: 1.1,
    fertility: 0.25,
    capacityShare: 0.35,
    nutrition: 0.3,
    length: 13,
  },
];

/**
 * Default species profiles, frozen. The simulation works on live copies
 * (`sim.species`).
 * @type {readonly Readonly<SpeciesProfile>[]}
 */
export const SPECIES = Object.freeze(PROFILES.map((profile) => Object.freeze(profile)));

export const SPECIES_COUNT = SPECIES.length;

/**
 * Per-step resolved parameters of a species: profile × global config, in world
 * units. Recomputed every step (cheap: one struct per species), so config and
 * profile edits apply immediately. Per-individual genes (speed, perception)
 * scale some of these again in the steering loop.
 */
export class SpeciesRuntime {
  constructor() {
    this.maxSpeed = 0;
    this.cruiseSpeed = 0;
    this.maxForce = 0;
    this.perception = 0;
    /** smoothstep band on cos(angle to neighbour) implementing the blind cone */
    this.fovCosLow = -3;
    this.fovCosHigh = -2;
    /** Calm separation radius against each species (pairwise average). */
    this.separationRadius = new Float64Array(SPECIES_COUNT);
    /** Query radius needed by fully flash-expanded separation. */
    this.separationQuery = 0;
    /** Neighbour query radius for an agent with neutral genes. */
    this.queryRadius = 0;
    this.wSeparation = 0;
    this.wAlignment = 0;
    this.wCohesion = 0;
    this.panicCohesion = 0;
    this.wanderStrength = 0;
    this.wanderRate = 0;
    /** Diffusion of the Ornstein–Uhlenbeck wander process, √(2θ) for unit variance. */
    this.wanderSigma = 0;
    this.burstRate = 0;
    this.burstBoost = 0;
    /** Per-step multiplicative burst decay, exp(−dt / duration). */
    this.burstDecay = 0;
    this.burstKick = 0;
    this.threatRadius = 0;
    this.threatRadiusSq = 0;
    this.flee = 0;
    this.frightSpeed = 1;
    this.alarmTransmission = 0;
    this.panicDecay = 0;
    this.scatter = 0;
    this.flashExpansion = 0;
    this.vulnerability = 0;
    /** Energy burned per second at cruise speed (includes energyDecay). */
    this.metabolism = 0;
    this.forage = 0;
    this.forageRange = 0;
    /** Eating reach (px) from the body centre. */
    this.mouthRadius = 0;
    this.fertility = 0;
    /** Soft population limit of this species. */
    this.capacity = 0;
    this.nutrition = 0;
  }

  /**
   * @param {number} index Species index.
   * @param {readonly SpeciesProfile[]} profiles All profiles (for pairwise radii).
   * @param {SimConfig} config
   * @param {number} dt Fixed step (s).
   */
  resolve(index, profiles, config, dt) {
    const p = profiles[index];
    const scatter = config.panicScatter;
    this.maxSpeed = config.maxSpeed * p.speed;
    this.cruiseSpeed = this.maxSpeed * p.cruise;
    this.maxForce = config.maxForce * p.agility;
    this.perception = config.perceptionRadius * p.perception;

    if (p.fieldOfView >= 359.9) {
      this.fovCosLow = -3; // everything visible
      this.fovCosHigh = -2;
    } else {
      const c = Math.cos(((p.fieldOfView / 2) * Math.PI) / 180);
      this.fovCosLow = c - 0.12;
      this.fovCosHigh = c + 0.12;
    }

    let maxSeparation = 0;
    for (let t = 0; t < profiles.length; t++) {
      const r = 0.5 * (p.personalSpace + profiles[t].personalSpace);
      this.separationRadius[t] = r;
      if (r > maxSeparation) maxSeparation = r;
    }
    this.flashExpansion = p.flashExpansion * scatter;
    this.separationQuery = maxSeparation * (1 + this.flashExpansion);
    this.queryRadius = Math.max(this.perception, this.separationQuery);

    this.wSeparation = config.separationWeight * p.separation;
    this.wAlignment = config.alignmentWeight * p.alignment;
    this.wCohesion = config.cohesionWeight * p.cohesion;
    this.panicCohesion = p.panicCohesion;
    this.wanderStrength = p.wanderStrength;
    this.wanderRate = p.wanderRate;
    this.wanderSigma = Math.sqrt(2 * p.wanderRate);
    this.burstRate = p.burstRate;
    this.burstBoost = p.burstBoost;
    this.burstDecay = Math.exp(-dt / Math.max(1e-3, p.burstDuration));
    this.burstKick = p.burstKick;
    this.threatRadius = config.panicRadius * p.threatRadius;
    this.threatRadiusSq = this.threatRadius * this.threatRadius;
    this.flee = p.flee * scatter;
    this.frightSpeed = p.frightSpeed;
    this.alarmTransmission = p.alarmTransmission;
    this.panicDecay = p.panicDecay;
    this.scatter = p.scatter * scatter;
    this.vulnerability = p.vulnerability;
    this.metabolism = p.metabolism * config.energyDecay;
    this.forage = p.forage;
    this.forageRange = p.forageRange;
    this.mouthRadius = 0.5 * p.length * p.mouth + 4;
    this.fertility = p.fertility;
    this.capacity = config.carryingCapacity * p.capacityShare;
    this.nutrition = p.nutrition;
  }
}

/**
 * @typedef {object} PredatorProfile
 * @property {number} length Body length (px).
 * @property {number} agility × maxForce: steering limit while patrolling / pursuing.
 * @property {number} strikeAgility × predator steering limit during a strike (lunge).
 * @property {number} patrolSpeed × predatorSpeed.
 * @property {number} restSpeed × predatorSpeed.
 * @property {number} strikeSpeed × predatorSpeed.
 * @property {number} huntRadius Detection radius (px) at aggression 0.5.
 * @property {number} strikeRange Distance (px) that triggers a strike, at aggression 0.5.
 * @property {number} strikeDuration Lunge duration (s).
 * @property {number} strikeCooldown Recovery after a missed strike before the next (s).
 * @property {number} catchRadius Contact distance (px) at which a hunting predator eats prey.
 * @property {number} patrolRegen Stamina gained per second while patrolling.
 * @property {number} restRegen Stamina gained per second while resting.
 * @property {number} pursuitDrain Stamina spent per second while pursuing.
 * @property {number} strikeDrain Stamina spent per second while striking.
 * @property {number} catchStamina Stamina regained per catch.
 * @property {number} satiation Rest-length multiplier after a catch.
 * @property {number} preySwitching Preference for prey species above an even share of the population.
 * @property {number} metabolism Energy (of 1) burned per second at rest.
 * @property {number} effortCost Extra energy per second at full pursuit speed (∝ speed²).
 * @property {number} fertility Division rate (1/s) once energy is full.
 * @property {number} preyPerPredator Prey the ecosystem needs per predator (soft predator capacity).
 * @property {number} wanderStrength
 * @property {number} wanderRate
 * @property {{ patrol: number, pursue: number, strike: number, rest: number }} threatLevel
 *   How alarming the predator is to prey in each state (prey read intent).
 */

/** @type {Readonly<PredatorProfile>} */
export const PREDATOR_PROFILE = Object.freeze({
  length: 36,
  agility: 0.75,
  strikeAgility: 1.5,
  patrolSpeed: 0.5,
  restSpeed: 0.28,
  strikeSpeed: 1.75,
  huntRadius: 210,
  strikeRange: 62,
  strikeDuration: 0.45,
  strikeCooldown: 0.8,
  catchRadius: 13,
  patrolRegen: 0.05,
  restRegen: 0.24,
  pursuitDrain: 0.09,
  strikeDrain: 0.6,
  catchStamina: 0.25,
  satiation: 1.5,
  preySwitching: 0.8,
  metabolism: 0.022,
  effortCost: 0.02,
  fertility: 0.4,
  preyPerPredator: 16,
  wanderStrength: 0.35,
  wanderRate: 0.6,
  threatLevel: Object.freeze({ patrol: 0.65, pursue: 1, strike: 1, rest: 0.3 }),
});
