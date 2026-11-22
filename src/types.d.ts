// Type declarations for the globals installed by src/main.js (type checking only;
// never loaded by the browser).
import type { ReactiveConfig } from './config.js';
import type { FlockingApp } from './app.js';

declare global {
  interface Window {
    /** Reactive simulation configuration. */
    simConfig: ReactiveConfig;
    /** Simulation controller (sim, renderer, loop, input, …). */
    sim: FlockingApp;
  }
}

export {};
