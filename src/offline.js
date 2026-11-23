/**
 * The page's side of offline support: registers the service worker (sw.js)
 * and reports whether Boids is saved on this device, and which version.
 *
 * This module makes no network requests. After the first visit the service
 * worker answers every request from the saved copy, and a device stays at
 * the version it saved first (no updates).
 *
 * Only the hosted app (served over http(s) with its manifest) registers a
 * service worker. The single-file build runs offline by construction and
 * reports 'unsupported'.
 *
 * States:
 * - 'unsupported': no service worker here (single-file build, file://, an old
 *   browser, some private modes).
 * - 'saving': first visit; the app is being saved to the device.
 * - 'ready': the whole app is saved; it runs with no network.
 * - 'dev': the development server, where offline saving is off.
 * - 'error': the app could not be saved this time (registration failed, or
 *   the first download was interrupted or corrupted). It retries the next
 *   time the app opens online.
 *
 * @module offline
 */

/** @typedef {'unsupported' | 'saving' | 'ready' | 'dev' | 'error'} OfflineState */

/**
 * @typedef {object} OfflineStatus
 * @property {OfflineState} state
 * @property {string | null} version Version saved on this device.
 * @property {number} files Files saved.
 */

/**
 * @typedef {object} Offline
 * @property {() => OfflineStatus} status
 * @property {(listener: (status: OfflineStatus) => void) => () => void} subscribe
 *   Called now and on every change.
 */

/** Whether the app runs installed (home screen / app window) rather than in a browser tab. */
export function isInstalled() {
  const nav = /** @type {Navigator & { standalone?: boolean }} */ (navigator);
  return nav.standalone === true || ['standalone', 'fullscreen', 'minimal-ui'].some((mode) => matchMedia(`(display-mode: ${mode})`).matches);
}

/**
 * Ask a service worker which version it serves (a message, not a request).
 * @param {ServiceWorker | null} worker
 * @returns {Promise<{ version?: string, files?: number, dev?: boolean } | null>}
 */
function ask(worker) {
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 3000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.postMessage({ type: 'STATUS' }, [channel.port2]);
  });
}

/** @returns {Offline} */
export function startOffline() {
  /** @type {OfflineStatus} */
  const status = { state: 'unsupported', version: null, files: 0 };
  /** @type {Set<(status: OfflineStatus) => void>} */
  const listeners = new Set();
  const emit = () => {
    for (const listener of listeners) listener({ ...status });
  };
  /** @param {ServiceWorker | null} worker */
  const describe = async (worker) => {
    const info = await ask(worker);
    if (info?.dev) {
      status.state = 'dev';
    } else {
      status.state = 'ready';
      status.version = info?.version ?? status.version;
      status.files = info?.files ?? status.files;
    }
    emit();
  };

  const container = navigator.serviceWorker;
  const hosted = location.protocol.startsWith('http') && document.querySelector('link[rel="manifest"]') !== null;
  if (hosted && container) {
    status.state = 'saving';
    // A device moving off an earlier, updating build switches workers once.
    container.addEventListener('controllerchange', () => describe(container.controller));
    container
      // 'all': the browser's own re-checks of sw.js may be answered from its
      // HTTP cache instead of the network.
      .register('./sw.js', { updateViaCache: 'all' })
      .then((registration) => {
        const installing = registration.installing;
        installing?.addEventListener('statechange', () => {
          // The first save failed (connection lost, corrupted file).
          if (installing.state === 'redundant' && !registration.active) {
            status.state = 'error';
            emit();
          }
        });
        return container.ready;
      })
      .then(async (registration) => {
        await describe(registration.active);
        // Ask the browser not to evict the saved copy under storage pressure
        // (granted silently for installed apps; never prompts in a tab).
        if (isInstalled()) navigator.storage?.persist?.().catch(() => {});
      })
      .catch(() => {
        status.state = 'error';
        emit();
      });
  }

  return {
    status: () => ({ ...status }),
    subscribe(listener) {
      listeners.add(listener);
      listener({ ...status });
      return () => listeners.delete(listener);
    },
  };
}
