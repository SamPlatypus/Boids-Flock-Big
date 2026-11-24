// Type declarations for the globals installed by src/main.js (type checking only;
// never loaded by the browser).
import type { ReactiveConfig } from './config.js';
import type { FlockingApp } from './app.js';
import type { createHud } from './ui/hud.js';

declare global {
  interface Window {
    /** Reactive simulation configuration. */
    simConfig: ReactiveConfig;
    /** Simulation controller (sim, renderer, loop, input, …). */
    sim: FlockingApp;
    /** The controls (open, close, isOpen, toast); used by the Android app's back button. */
    boidsHud: ReturnType<typeof createHud>;
  }
}

export {};
