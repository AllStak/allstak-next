// AllStak Next.js SDK offline / persistent event queue.
//
// Buffered telemetry must survive a process / app restart AND a network
// outage. When an event cannot be delivered (network error, retries
// exhausted, offline, or shutdown with events still buffered), the
// already-PII-scrubbed wire payload is written to a persistent store instead
// of being dropped. On the next SDK init the store is drained and the events
// are re-sent through the existing transport.
//
// Design notes mirroring @sentry's offline transport:
//   - Entries are stored as scrubbed JSON envelopes ({ path, body }), NEVER
//     unredacted data — the caller scrubs before calling persist().
//   - The store is BOUNDED by entry count, total bytes, AND max age. When full
//     the OLDEST entry is dropped. It never grows unbounded.
//   - Session lifecycle calls (/ingest/v1/sessions/start|end) are best-effort
//     live-only and are EXCLUDED from persistence — a replayed stale session
//     would skew durations.
//   - The whole layer is fail-open: a read-only FS, a serverless/sandboxed
//     runtime, or a missing localStorage degrades silently to in-memory.
//     persist()/drain() NEVER throw and NEVER block init or capture.

/** A scrubbed wire envelope queued for (re)delivery. */
export interface PersistedEnvelope {
  /** Ingest path, e.g. `/ingest/v1/errors`. */
  path: string;
  /** Already-scrubbed JSON request body. */
  body: string;
  /** Epoch ms when the envelope was queued (for max-age eviction). */
  ts: number;
}

/**
 * Pluggable persistence adapter. Mobile/RN and other embedders can supply a
 * custom backend (e.g. AsyncStorage) via `setPersistenceAdapter`. All methods
 * are synchronous and must be fail-open (never throw).
 */
export interface PersistenceAdapter {
  /** Load every persisted envelope (oldest first). */
  load(): PersistedEnvelope[];
  /** Replace the full set of persisted envelopes (oldest first). */
  save(envelopes: PersistedEnvelope[]): void;
  /** Drop everything (best-effort). */
  clear(): void;
  /** Whether this backend is actually usable in the current runtime. */
  isAvailable(): boolean;
}

export interface OfflineQueueLimits {
  /** Max number of envelopes retained. Default differs per platform. */
  maxCount: number;
  /** Max total serialized bytes retained. */
  maxBytes: number;
  /** Max envelope age in ms; older entries are dropped on load/save. */
  maxAgeMs: number;
}

/** Browser default: a small cap that comfortably fits in localStorage. */
export const BROWSER_LIMITS: OfflineQueueLimits = {
  maxCount: 50,
  maxBytes: 1_000_000, // ~1MB
  maxAgeMs: 48 * 60 * 60 * 1000, // 48h
};

/** Server (Node fs spool) default: a few MB is fine on disk. */
export const SERVER_LIMITS: OfflineQueueLimits = {
  maxCount: 100,
  maxBytes: 4_000_000, // ~4MB
  maxAgeMs: 48 * 60 * 60 * 1000, // 48h
};

/**
 * Session lifecycle paths are excluded from the persistent store: they are
 * best-effort live-only and a replayed stale session would skew durations.
 */
export function isPersistablePath(path: string): boolean {
  return !path.startsWith('/ingest/v1/sessions/');
}

const STORAGE_KEY = '__allstak_offline_queue__';

/** localStorage-backed adapter (browser). Fail-open if storage is blocked. */
class LocalStorageAdapter implements PersistenceAdapter {
  isAvailable(): boolean {
    try {
      const ls = (globalThis as { localStorage?: Storage }).localStorage;
      if (!ls) return false;
      // Some browsers expose localStorage but throw on access (private mode,
      // disabled cookies). Probe with a no-op read.
      ls.getItem(STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  load(): PersistedEnvelope[] {
    try {
      const ls = (globalThis as { localStorage?: Storage }).localStorage;
      const raw = ls?.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isEnvelope) : [];
    } catch {
      return [];
    }
  }

  save(envelopes: PersistedEnvelope[]): void {
    try {
      const ls = (globalThis as { localStorage?: Storage }).localStorage;
      if (!ls) return;
      if (envelopes.length === 0) {
        ls.removeItem(STORAGE_KEY);
        return;
      }
      ls.setItem(STORAGE_KEY, JSON.stringify(envelopes));
    } catch {
      // quota exceeded / blocked — fail-open
    }
  }

  clear(): void {
    try {
      (globalThis as { localStorage?: Storage }).localStorage?.removeItem(STORAGE_KEY);
    } catch {
      // fail-open
    }
  }
}

/**
 * Filesystem spool adapter (Node server). One JSON file per envelope under a
 * spool directory; ordering is by filename (monotonic timestamp prefix). Fully
 * fail-open if the directory is not writable.
 */
class FsSpoolAdapter implements PersistenceAdapter {
  private readonly dir: string;
  private fs: typeof import('node:fs') | null;
  private path: typeof import('node:path') | null;
  private counter = 0;

  constructor(dir: string) {
    this.dir = dir;
    try {
      // Guarded require so the edge/browser bundle never needs node:fs.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.fs = require('node:fs') as typeof import('node:fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.path = require('node:path') as typeof import('node:path');
    } catch {
      this.fs = null;
      this.path = null;
    }
  }

  isAvailable(): boolean {
    if (!this.fs) return false;
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      // Probe writability.
      this.fs.accessSync(this.dir, this.fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  load(): PersistedEnvelope[] {
    if (!this.fs || !this.path) return [];
    try {
      const files = this.fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .sort(); // filename prefix is a monotonic timestamp → chronological
      const out: PersistedEnvelope[] = [];
      for (const file of files) {
        try {
          const raw = this.fs.readFileSync(this.path.join(this.dir, file), 'utf8');
          const parsed = JSON.parse(raw);
          if (isEnvelope(parsed)) out.push(parsed);
        } catch {
          // corrupt entry — skip (don't let one bad file block drain)
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  save(envelopes: PersistedEnvelope[]): void {
    if (!this.fs || !this.path) return;
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      // Rewrite the spool to exactly match `envelopes` (the bounded set):
      // remove existing files, then write the survivors in order.
      const existing = this.fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
      for (const file of existing) {
        try {
          this.fs.unlinkSync(this.path.join(this.dir, file));
        } catch {
          /* ignore */
        }
      }
      for (const env of envelopes) {
        const name = `${String(env.ts).padStart(16, '0')}-${(this.counter++).toString(36)}.json`;
        this.fs.writeFileSync(this.path.join(this.dir, name), JSON.stringify(env));
      }
    } catch {
      // read-only FS / no space — fail-open
    }
  }

  clear(): void {
    if (!this.fs || !this.path) return;
    try {
      for (const file of this.fs.readdirSync(this.dir)) {
        if (file.endsWith('.json')) {
          try {
            this.fs.unlinkSync(this.path.join(this.dir, file));
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      // fail-open
    }
  }
}

/** Always-available no-op-ish in-memory adapter (edge / sandboxed degrade). */
class MemoryAdapter implements PersistenceAdapter {
  private store: PersistedEnvelope[] = [];
  isAvailable(): boolean {
    return true;
  }
  load(): PersistedEnvelope[] {
    return [...this.store];
  }
  save(envelopes: PersistedEnvelope[]): void {
    this.store = [...envelopes];
  }
  clear(): void {
    this.store = [];
  }
}

function isEnvelope(v: unknown): v is PersistedEnvelope {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as PersistedEnvelope).path === 'string' &&
    typeof (v as PersistedEnvelope).body === 'string' &&
    typeof (v as PersistedEnvelope).ts === 'number'
  );
}

/** Embedder-supplied adapter (e.g. RN AsyncStorage wrapper). */
let customAdapter: PersistenceAdapter | null = null;

/**
 * Provide a custom persistence backend (mobile/RN, custom embedders). Pass
 * `null` to clear it. The adapter must be fail-open. Takes effect on the next
 * queue construction (i.e. next client init).
 */
export function setPersistenceAdapter(adapter: PersistenceAdapter | null): void {
  customAdapter = adapter;
}

/** @internal test seam */
export function _getPersistenceAdapter(): PersistenceAdapter | null {
  return customAdapter;
}

export interface OfflineQueueOptions {
  /** Custom spool directory for the Node fs backend. */
  spoolDir?: string;
  /** Override the bounds (count / bytes / age). */
  limits?: Partial<OfflineQueueLimits>;
  /** Force a specific adapter (tests / embedders). Bypasses runtime detection. */
  adapter?: PersistenceAdapter;
}

/**
 * Pick the idiomatic backend for the current runtime:
 *   - explicit adapter (option / global) wins
 *   - browser → localStorage (if usable)
 *   - Node server → fs spool under the configured/temp dir (if writable)
 *   - everything else (edge, sandboxed) → in-memory degrade
 */
function selectAdapter(options: OfflineQueueOptions): PersistenceAdapter {
  if (options.adapter) return options.adapter;
  if (customAdapter) return customAdapter;

  // Browser: localStorage.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const ls = new LocalStorageAdapter();
    if (ls.isAvailable()) return ls;
    return new MemoryAdapter();
  }

  // Node server (not edge): fs spool.
  const proc = (globalThis as {
    process?: { versions?: { node?: string }; env?: Record<string, string | undefined> };
  }).process;
  const isNodeServer = !!proc?.versions?.node && proc.env?.NEXT_RUNTIME !== 'edge';
  if (isNodeServer) {
    const dir = options.spoolDir || defaultSpoolDir();
    if (dir) {
      const fs = new FsSpoolAdapter(dir);
      if (fs.isAvailable()) return fs;
    }
  }

  // Edge / sandboxed: degrade to in-memory.
  return new MemoryAdapter();
}

function defaultSpoolDir(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    return path.join(os.tmpdir(), 'allstak-next-spool');
  } catch {
    return null;
  }
}

/**
 * Bounded, fail-open persistent queue for scrubbed telemetry envelopes. Sits
 * on top of a {@link PersistenceAdapter}. Caps by count, bytes, and age,
 * dropping the OLDEST entries first. Excludes session lifecycle paths.
 */
export class OfflineQueue {
  private readonly adapter: PersistenceAdapter;
  private readonly limits: OfflineQueueLimits;

  constructor(options: OfflineQueueOptions = {}) {
    this.adapter = selectAdapter(options);
    const base =
      typeof window !== 'undefined' && typeof document !== 'undefined'
        ? BROWSER_LIMITS
        : SERVER_LIMITS;
    this.limits = { ...base, ...options.limits };
  }

  /** Whether persistence is backed by a real (non-memory) store. */
  isBacked(): boolean {
    return !(this.adapter instanceof MemoryAdapter);
  }

  /**
   * Persist a single scrubbed envelope. Session lifecycle paths are silently
   * ignored. Never throws. Enforces the bounds (drop oldest).
   */
  persist(path: string, body: string): void {
    if (!isPersistablePath(path)) return;
    try {
      const envelopes = this.bound(this.adapter.load());
      envelopes.push({ path, body, ts: Date.now() });
      this.adapter.save(this.bound(envelopes));
    } catch {
      // fail-open
    }
  }

  /** Load all persisted envelopes (bounded by age), oldest first. */
  loadAll(): PersistedEnvelope[] {
    try {
      return this.bound(this.adapter.load());
    } catch {
      return [];
    }
  }

  /** Replace the persisted set (used by drain to write back survivors). */
  replaceAll(envelopes: PersistedEnvelope[]): void {
    try {
      this.adapter.save(this.bound(envelopes));
    } catch {
      // fail-open
    }
  }

  /** Drop everything. */
  clear(): void {
    try {
      this.adapter.clear();
    } catch {
      // fail-open
    }
  }

  /**
   * Apply bounds in priority order: drop entries older than maxAge, then drop
   * the OLDEST until under both the count and byte caps. Pure w.r.t. input.
   */
  private bound(input: PersistedEnvelope[]): PersistedEnvelope[] {
    const now = Date.now();
    let out = input.filter((e) => now - e.ts <= this.limits.maxAgeMs);
    // Drop oldest beyond the count cap.
    if (out.length > this.limits.maxCount) {
      out = out.slice(out.length - this.limits.maxCount);
    }
    // Drop oldest until under the byte cap.
    let bytes = out.reduce((sum, e) => sum + byteLen(e.body), 0);
    while (out.length > 1 && bytes > this.limits.maxBytes) {
      bytes -= byteLen(out[0].body);
      out = out.slice(1);
    }
    return out;
  }
}

function byteLen(s: string): number {
  // Approximate UTF-8 byte length without pulling in TextEncoder polyfills on
  // every runtime; `.length` is a safe upper-bound-ish proxy for ASCII-heavy
  // JSON and good enough for a soft cap.
  try {
    const TE = (globalThis as { TextEncoder?: typeof TextEncoder }).TextEncoder;
    if (TE) return new TE().encode(s).length;
  } catch {
    /* fall through */
  }
  return s.length;
}
