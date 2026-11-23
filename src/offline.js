/**
 * The page's side of offline support: registers the service worker (sw.js)
 * and reports whether the app is saved on this device, which version runs,
 * and when a newer version is waiting.
 *
 * Only the hosted app (served over http(s) with its manifest) registers a
 * service worker. The single-file build runs offline by construction and
 * reports 'unsupported'.
 *
 * States:
 * - 'unsupported': no service worker here (single-file build, file://, an old
 *   browser, some private modes).
 * - 'saving': first visit; the app is being saved to the device.
 * - 'ready': the whole app is saved and runs offline.
 * - 'update': a newer version is saved and waiting. It starts the next time
 *   the app opens, or now through applyUpdate() (reloads the page).
 * - 'dev': the development server, where offline saving is off.
 * - 'error': the service worker could not be registered.
 *
 * @module offline
 */

/** @typedef {'unsupported' | 'saving' | 'ready' | 'update' | 'dev' | 'error'} OfflineState */

/**
 * @typedef {object} OfflineStatus
 * @property {OfflineState} state
 * @property {string | null} version Version running (or saved) on this device.
 * @property {string | null} nextVersion Version waiting to start ('update').
 * @property {number} files Files saved for offline use.
 * @property {boolean} online Whether the device currently has a network.
 */

/**
 * @typedef {object} Offline
 * @property {() => OfflineStatus} status
 * @property {(listener: (status: OfflineStatus) => void) => () => void} subscribe
 *   Called now and on every change.
 * @property {() => void} applyUpdate Switch to the waiting version and reload.
 */

/** How often an open app asks for a newer version (only sw.js is compared). */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** Whether the app runs installed (home screen / app window) rather than in a browser tab. */
export function isInstalled() {
  const nav = /** @type {Navigator & { standalone?: boolean }} */ (navigator);
  return nav.standalone === true || ['standalone', 'fullscreen', 'minimal-ui'].some((mode) => matchMedia(`(display-mode: ${mode})`).matches);
}

/**
 * Ask a service worker for its version.
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
  const status = { state: 'unsupported', version: null, nextVersion: null, files: 0, online: navigator.onLine };
  /** @type {Set<(status: OfflineStatus) => void>} */
  const listeners = new Set();
  const emit = () => {
    for (const listener of listeners) listener({ ...status });
  };
  const onNetwork = () => {
    status.online = navigator.onLine;
    emit();
  };
  addEventListener('online', onNetwork);
  addEventListener('offline', onNetwork);

  const container = navigator.serviceWorker;
  const hosted = location.protocol.startsWith('http') && document.querySelector('link[rel="manifest"]') !== null;
  let reloadOnTakeover = false;

  if (hosted && container) {
    status.state = 'saving';
    container.addEventListener('controllerchange', () => {
      if (reloadOnTakeover) location.reload();
    });
    container
      .register('./sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        /** @param {ServiceWorker} worker */
        const watchInstall = (worker) => {
          worker.addEventListener('statechange', async () => {
            // An update (not the first install) finished downloading.
            if (worker.state === 'installed' && container.controller) {
              status.nextVersion = (await ask(worker))?.version ?? null;
              status.state = 'update';
              emit();
            }
          });
        };
        if (registration.installing) watchInstall(registration.installing);
        registration.addEventListener('updatefound', () => {
          if (registration.installing) watchInstall(registration.installing);
        });
        setInterval(() => registration.update().catch(() => {}), UPDATE_CHECK_MS);
        return container.ready;
      })
      .then(async (registration) => {
        const info = await ask(registration.active);
        if (info?.dev) {
          status.state = 'dev';
        } else {
          status.version = info?.version ?? null;
          status.files = info?.files ?? 0;
          if (registration.waiting) {
            status.nextVersion = (await ask(registration.waiting))?.version ?? null;
            status.state = 'update';
          } else {
            status.state = 'ready';
          }
          // Ask the browser not to evict the saved copy under storage pressure
          // (granted silently for installed apps; never prompts in a tab).
          if (isInstalled()) navigator.storage?.persist?.().catch(() => {});
        }
        emit();
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
    applyUpdate() {
      container?.getRegistration().then((registration) => {
        if (!registration?.waiting) return;
        reloadOnTakeover = true;
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      });
    },
  };
}
