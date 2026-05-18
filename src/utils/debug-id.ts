/**
 * Runtime debug-ID resolver for the Next.js SDK.
 *
 * At build time, `injectDebugId()` appends `//# debugId=<uuid>` to every
 * JS bundle and writes the same UUID into the matching `.map`. The
 * self-registration snippet also populates
 * `globalThis._allstakDebugIds[url] = uuid` when the bundle executes in
 * the browser or on the edge.
 *
 * This module resolves debug IDs at runtime so each stack frame can be
 * attributed to the right source map on the backend.
 *
 * All globalThis access is guarded for SSR safety (Node, edge, browser).
 */

const REGISTRY_KEY = '_allstakDebugIds';

const cache = new Map<string, string | null>();

/**
 * Look up the debug-ID for a given filename (URL or absolute path).
 *
 * Returns `undefined` when no debug-ID is found. The symbolicator on
 * the backend handles missing debug IDs gracefully.
 */
export function resolveDebugId(filename: string | undefined): string | undefined {
  if (!filename) return undefined;

  if (cache.has(filename)) return cache.get(filename) ?? undefined;

  // Browser / edge registry — populated by the self-registration snippet
  // that `injectDebugId()` prepends to each bundle.
  if (typeof globalThis !== 'undefined') {
    const registry = (globalThis as { [REGISTRY_KEY]?: Record<string, string> })[REGISTRY_KEY];
    if (registry && typeof registry === 'object') {
      const hit = registry[filename];
      if (typeof hit === 'string' && hit.length > 0) {
        cache.set(filename, hit);
        return hit;
      }
    }
  }

  // Node disk read — read the tail of the bundle file to find the
  // `//# debugId=<uuid>` comment appended by injectDebugId().
  if (typeof process !== 'undefined' && process.versions?.node) {
    let path = filename;
    if (path.startsWith('file://')) path = path.slice('file://'.length);
    if (path.startsWith('/')) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs');
        const stat = fs.statSync(path);
        const tailSize = Math.min(stat.size, 4096);
        const fd = fs.openSync(path, 'r');
        try {
          const buf = Buffer.alloc(tailSize);
          fs.readSync(fd, buf, 0, tailSize, Math.max(0, stat.size - tailSize));
          const text = buf.toString('utf8');
          const m = /\/\/# debugId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/.exec(text);
          if (m && m[1]) {
            cache.set(filename, m[1]);
            return m[1];
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        /* ignore — file not readable */
      }
    }
  }

  cache.set(filename, null);
  return undefined;
}

/** Test-only: reset the per-process cache. */
export function _resetDebugIdCache(): void {
  cache.clear();
}
