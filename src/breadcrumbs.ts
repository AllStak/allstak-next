/**
 * Automatic browser breadcrumb collectors for @allstak/next.
 *
 * Installs lightweight, fail-open collectors that record a trail of recent
 * activity onto the active scope, so any error captured afterwards carries the
 * "what happened just before" context automatically — no manual
 * `addBreadcrumb` calls needed:
 *
 *   - console   — `console.{debug,info,warn,error}` calls (level-mapped).
 *   - navigation — SPA route changes via History API (pushState/replaceState)
 *                  and `popstate`, plus the initial `load`.
 *   - fetch     — outbound `fetch` calls (method + URL + status), without
 *                 re-implementing the trace-propagation wrapper.
 *
 * All collectors are default-ON in the browser bootstrap and individually
 * toggleable. Each is idempotent and fully fail-open: a collector error never
 * affects the host page. No-op outside the browser.
 */

import { scopeManager } from './scope';
import type { ScopeBreadcrumb } from './scope';

export type BeforeBreadcrumb = (breadcrumb: ScopeBreadcrumb) => ScopeBreadcrumb | null | undefined;

export interface BreadcrumbCollectorOptions {
  /** Record `console.*` calls as breadcrumbs. Default true. */
  console?: boolean;
  /** Record SPA navigations (History API + popstate). Default true. */
  navigation?: boolean;
  /** Record outbound fetch calls (method + URL + status). Default true. */
  fetch?: boolean;
  /** Record privacy-safe UI click breadcrumbs. Default true. */
  click?: boolean;
  /** Last-mile hook to edit/drop auto breadcrumbs before they are stored. */
  beforeBreadcrumb?: BeforeBreadcrumb;
  /** Maximum selector summary length for click breadcrumbs. Default 160. */
  maxSelectorLength?: number;
}

interface CollectorState {
  teardowns: Array<() => void>;
  beforeBreadcrumb?: BeforeBreadcrumb;
  maxSelectorLength: number;
}

let state: CollectorState | null = null;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function addCrumb(type: string, message: string, level: string, data?: Record<string, unknown>): void {
  try {
    const crumb: ScopeBreadcrumb = { type, category: type, message, level, data };
    const finalCrumb = state?.beforeBreadcrumb ? state.beforeBreadcrumb(crumb) : crumb;
    if (finalCrumb) scopeManager.getCurrentScope().addBreadcrumb(finalCrumb);
  } catch {
    // fail-open
  }
}

/**
 * Install the auto-breadcrumb collectors in the browser. Idempotent and fully
 * fail-open. No-op on the server/edge. Returns a teardown that removes every
 * installed collector.
 */
export function installAutoBreadcrumbs(options: BreadcrumbCollectorOptions = {}): () => void {
  if (!isBrowser()) return () => {};
  if (state) return () => teardownAll();

  state = {
    teardowns: [],
    beforeBreadcrumb: options.beforeBreadcrumb,
    maxSelectorLength: Math.max(32, options.maxSelectorLength ?? 160),
  };

  if (options.console !== false) safeInstall(installConsoleBreadcrumbs);
  if (options.navigation !== false) safeInstall(installNavigationBreadcrumbs);
  if (options.fetch !== false) safeInstall(installFetchBreadcrumbs);
  if (options.click !== false) safeInstall(installClickBreadcrumbs);

  return () => teardownAll();
}

/** Whether the auto-breadcrumb collectors are currently installed. */
export function areAutoBreadcrumbsInstalled(): boolean {
  return state !== null;
}

function safeInstall(install: () => () => void): void {
  try {
    state?.teardowns.push(install());
  } catch {
    // fail-open
  }
}

function teardownAll(): void {
  if (!state) return;
  for (const t of state.teardowns) {
    try {
      t();
    } catch {
      // fail-open
    }
  }
  state = null;
}

// ── click ───────────────────────────────────────────────────────────────────

function installClickBreadcrumbs(): () => void {
  const doc = document as Document & {
    addEventListener?: Document['addEventListener'];
    removeEventListener?: Document['removeEventListener'];
  };
  if (typeof doc.addEventListener !== 'function') return () => {};

  const handler = (event: Event) => {
    try {
      const rawTarget = (event as { target?: unknown }).target;
      const target = closestClickable(rawTarget);
      if (!target || isSensitiveClickable(target)) return;
      const selector = selectorSummary(target, state?.maxSelectorLength ?? 160);
      if (!selector) return;
      addCrumb('ui', `click ${selector}`, 'info', {
        action: 'click',
        selector,
        tag: tagName(target),
      });
    } catch {
      // fail-open
    }
  };

  doc.addEventListener('click', handler, true);
  return () => {
    try {
      doc.removeEventListener?.('click', handler, true);
    } catch {
      // fail-open
    }
  };
}

function closestClickable(target: unknown): Element | null {
  let el = asElement(target);
  while (el) {
    const tag = tagName(el);
    if (
      tag === 'button' ||
      tag === 'a' ||
      tag === 'input' ||
      tag === 'select' ||
      tag === 'textarea' ||
      attr(el, 'role') === 'button' ||
      attr(el, 'data-allstak-click') !== null
    ) {
      return el;
    }
    el = asElement((el as { parentElement?: unknown }).parentElement);
  }
  return asElement(target);
}

function asElement(value: unknown): Element | null {
  if (!value || typeof value !== 'object') return null;
  const maybe = value as { tagName?: unknown; nodeType?: unknown };
  return typeof maybe.tagName === 'string' || maybe.nodeType === 1 ? value as Element : null;
}

function isSensitiveClickable(el: Element): boolean {
  const tag = tagName(el);
  if (tag !== 'input') return false;
  const type = (attr(el, 'type') ?? '').toLowerCase();
  return type === 'password' || type === 'hidden';
}

function selectorSummary(el: Element, maxLength: number): string {
  const tag = tagName(el) || 'element';
  const parts = [tag];
  const id = cleanSelectorPart(attr(el, 'id'));
  if (id) parts.push(`#${id}`);

  const classes = classNames(el).slice(0, 3).map(cleanSelectorPart).filter(Boolean);
  if (classes.length) parts.push(classes.map((c) => `.${c}`).join(''));

  const role = cleanSelectorPart(attr(el, 'role'));
  if (role) parts.push(`[role="${role}"]`);

  const type = cleanSelectorPart(attr(el, 'type'));
  if (type && tag === 'input') parts.push(`[type="${type}"]`);

  return truncate(parts.join(''), maxLength);
}

function tagName(el: Element): string {
  return ((el as { tagName?: string }).tagName ?? '').toLowerCase();
}

function attr(el: Element, name: string): string | null {
  try {
    const getter = (el as { getAttribute?: (n: string) => string | null }).getAttribute;
    if (typeof getter === 'function') return getter.call(el, name);
    const value = (el as unknown as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function classNames(el: Element): string[] {
  try {
    const list = (el as { classList?: Iterable<string>; className?: unknown }).classList;
    if (list) return Array.from(list).filter((v): v is string => typeof v === 'string');
    const className = (el as { className?: unknown }).className;
    return typeof className === 'string' ? className.split(/\s+/).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function cleanSelectorPart(value: string | null): string {
  if (!value) return '';
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}

// ── console ──────────────────────────────────────────────────────────────────

const CONSOLE_METHODS = ['debug', 'info', 'warn', 'error'] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];
const CONSOLE_LEVEL: Record<ConsoleMethod, string> = {
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
};
const CONSOLE_BREADCRUMB_MARKER = '__allstak_breadcrumb__';

function installConsoleBreadcrumbs(): () => void {
  const consoleObj = (globalThis as unknown as { console?: Record<string, unknown> }).console;
  if (!consoleObj) return () => {};
  const originals: Partial<Record<ConsoleMethod, unknown>> = {};

  for (const method of CONSOLE_METHODS) {
    const original = consoleObj[method];
    if (typeof original !== 'function') continue;
    // Don't double-wrap if a console wrapper marked itself.
    if ((original as unknown as Record<string, unknown>)[CONSOLE_BREADCRUMB_MARKER]) continue;
    originals[method] = original;
    const orig = original as (...args: unknown[]) => void;
    const level = CONSOLE_LEVEL[method];
    const patched = function patchedConsole(this: unknown, ...args: unknown[]): void {
      try {
        orig.apply(this, args);
      } catch {
        // fail-open
      }
      try {
        addCrumb('console', summarize(args), level);
      } catch {
        // fail-open
      }
    } as (...args: unknown[]) => void;
    (patched as unknown as Record<string, unknown>)[CONSOLE_BREADCRUMB_MARKER] = true;
    consoleObj[method] = patched;
  }

  return () => {
    try {
      for (const [method, original] of Object.entries(originals)) {
        if (original) consoleObj[method] = original;
      }
    } catch {
      // fail-open
    }
  };
}

// ── navigation ─────────────────────────────────────────────────────────────────

function installNavigationBreadcrumbs(): () => void {
  const w = window as Window & typeof globalThis & {
    history?: History & { __allstak_patched__?: boolean };
  };
  const history = w.history;
  let from = currentLocation();

  // Initial load breadcrumb.
  addCrumb('navigation', `navigate ${from}`, 'info', { to: from });

  const onPopState = () => {
    const to = currentLocation();
    addCrumb('navigation', `popstate ${from} → ${to}`, 'info', { from, to });
    from = to;
  };
  window.addEventListener('popstate', onPopState);

  const restorers: Array<() => void> = [];
  if (history && !history.__allstak_patched__) {
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method];
      if (typeof original !== 'function') continue;
      const orig = (original as (...args: unknown[]) => unknown).bind(history) as (...args: unknown[]) => unknown;
      history[method] = function patchedHistory(this: History, ...args: unknown[]): void {
        try {
          orig(...args);
        } finally {
          try {
            const to = currentLocation();
            addCrumb('navigation', `${method} ${from} → ${to}`, 'info', { from, to });
            from = to;
          } catch {
            // fail-open
          }
        }
      } as History[typeof method];
      restorers.push(() => {
        try {
          history[method] = original;
        } catch {
          // fail-open
        }
      });
    }
    history.__allstak_patched__ = true;
    restorers.push(() => {
      try {
        delete history.__allstak_patched__;
      } catch {
        // fail-open
      }
    });
  }

  return () => {
    try {
      window.removeEventListener('popstate', onPopState);
    } catch {
      // fail-open
    }
    for (const r of restorers) r();
  };
}

function currentLocation(): string {
  try {
    const loc = (globalThis as { location?: { pathname?: string; search?: string; hash?: string } }).location;
    if (!loc) return '';
    return `${loc.pathname ?? ''}${loc.search ?? ''}${loc.hash ?? ''}`;
  } catch {
    return '';
  }
}

// ── fetch ──────────────────────────────────────────────────────────────────────

const FETCH_BREADCRUMB_MARKER = '__allstak_breadcrumb_fetch__';

function installFetchBreadcrumbs(): () => void {
  const g = globalThis as typeof globalThis & { fetch?: typeof fetch };
  const current = g.fetch;
  if (typeof current !== 'function') return () => {};
  if ((current as unknown as Record<string, unknown>)[FETCH_BREADCRUMB_MARKER]) return () => {};

  const original = current;
  const patched = (async function patchedFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const method = resolveMethod(input, init);
    const url = resolveUrl(input);
    try {
      const response = await (original as typeof fetch).call(this, input as RequestInfo, init);
      try {
        const status = (response as { status?: number })?.status ?? 0;
        if (url && !isIngestUrl(url)) {
          addCrumb('http', `${method} ${url} [${status}]`, status >= 400 ? 'warning' : 'info', { method, url, status });
        }
      } catch {
        // fail-open
      }
      return response;
    } catch (error) {
      try {
        if (url && !isIngestUrl(url)) {
          addCrumb('http', `${method} ${url} [failed]`, 'error', { method, url, status: 0 });
        }
      } catch {
        // fail-open
      }
      throw error;
    }
  }) as typeof fetch;
  (patched as unknown as Record<string, unknown>)[FETCH_BREADCRUMB_MARKER] = true;
  g.fetch = patched;

  return () => {
    try {
      if (g.fetch === patched) g.fetch = original;
    } catch {
      // fail-open
    }
  };
}

function isIngestUrl(url: string): boolean {
  return /\/ingest\/v1\//.test(url);
}

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  const RequestCtor = (globalThis as { Request?: typeof Request }).Request;
  if (RequestCtor && input instanceof RequestCtor) return (input.method || 'GET').toUpperCase();
  return 'GET';
}

function resolveUrl(input: RequestInfo | URL): string {
  try {
    if (typeof input === 'string') return input;
    const RequestCtor = (globalThis as { Request?: typeof Request }).Request;
    if (RequestCtor && input instanceof RequestCtor) return input.url;
    if (input instanceof URL) return input.toString();
    const maybe = (input as { url?: unknown }).url;
    return typeof maybe === 'string' ? maybe : String(input);
  } catch {
    return '';
  }
}

function summarize(args: unknown[]): string {
  const parts: string[] = [];
  for (const arg of args) {
    if (typeof arg === 'string') parts.push(arg);
    else if (arg instanceof Error) parts.push(arg.message || arg.name);
    else {
      try {
        parts.push(typeof arg === 'object' ? JSON.stringify(arg) : String(arg));
      } catch {
        parts.push('[object]');
      }
    }
  }
  const joined = parts.join(' ').trim();
  return joined.length > 1000 ? `${joined.slice(0, 1000)}…` : joined;
}

/** @internal test seam: tear down all collectors and reset state. */
export function _resetAutoBreadcrumbsForTest(): void {
  teardownAll();
}
