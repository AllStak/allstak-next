# @allstak/next

AllStak SDK for Next.js App Router and Pages Router. After two small wiring
steps it automatically captures server + client errors, route-handler /
middleware errors, outbound HTTP, Core Web Vitals, database queries, structured
logs, and an automatic breadcrumb trail — and uploads source maps. Almost
everything is default-on and individually toggleable; you rarely write
per-call telemetry code.

## Install

```bash
npm install @allstak/next
```

## App Router

Two files, then you're done.

1. Server bootstrap — create `instrumentation.ts`:

```ts
export async function register() {
  const { registerAllStak } = await import('@allstak/next');

  registerAllStak({
    apiKey: process.env.ALLSTAK_API_KEY,
    environment: process.env.NODE_ENV ?? 'production',
    release: process.env.NEXT_PUBLIC_RELEASE,
  });
}
```

`registerAllStak` automatically wires server-side error capture, the outbound
`fetch` tracer, database query instrumentation (the `pg` driver), and a
`console` → structured-log bridge. Each is default-on and individually
toggleable (`enableDbInstrumentation`, `enableConsoleLogs`, `enableOutboundHttp`, …).

2. Client bootstrap — create `instrumentation-client.ts` at your project root:

```ts
// instrumentation-client.ts  (project root — Next.js auto-loads it in the browser)
export * from '@allstak/next/client';
```

That single re-export auto-runs a browser bootstrap from `NEXT_PUBLIC_*` env:
it registers a client, installs global error handlers, Core Web Vitals,
outbound-`fetch` tracing, the auto-breadcrumb collectors (console / navigation /
fetch), and the console→log bridge — with NO manual call. Set
`NEXT_PUBLIC_ALLSTAK_API_KEY` (and optionally `NEXT_PUBLIC_ALLSTAK_HOST`,
`NEXT_PUBLIC_ALLSTAK_RELEASE`, …); toggle any collector off by setting e.g.
`NEXT_PUBLIC_ALLSTAK_BREADCRUMBS=false`.

`withAllStak()` (see Source maps) injects this client entry into the browser
bundle for you, so the `instrumentation-client.ts` file is optional when you
use it.

Wrap client components when you want a local fallback:

```tsx
'use client';

import { withAllStakErrorBoundary } from '@allstak/next';

function PageContent() {
  return <AppContent />;
}

export default withAllStakErrorBoundary(PageContent, {
  fallback: <p>Something went wrong.</p>,
});
```

## Route handlers

```ts
import { withAllStakRouteHandler } from '@allstak/next';

export const GET = withAllStakRouteHandler(async () => {
  return Response.json({ ok: true });
});
```

## Pages Router

```ts
// pages/_app.tsx
import { installGlobalErrorHandlers } from '@allstak/next';
import { useEffect } from 'react';

export default function App({ Component, pageProps }) {
  useEffect(() => installGlobalErrorHandlers(), []);
  return <Component {...pageProps} />;
}
```

## Database queries

`registerAllStak` auto-instruments the `pg` driver when it resolves in your app
(covering `Pool` and `Client`, including prepared/named queries and
transactions). Every query is normalized — string and numeric literals are
masked to `?` BEFORE it leaves the SDK, so bound values never reach the wire —
and emitted to `/ingest/v1/db`.

ORM integrations that need a live client instance are one explicit call:

```ts
// Prisma — construct the client with query-event logging, then attach.
import { PrismaClient } from '@prisma/client';
import { instrumentPrisma } from '@allstak/next';

const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
instrumentPrisma(prisma);

// Drizzle — pass the AllStak logger.
import { drizzle } from 'drizzle-orm/node-postgres';
import { allstakDrizzleLogger } from '@allstak/next';

const db = drizzle(pool, { logger: allstakDrizzleLogger() });
```

## Logs

A console → structured-log bridge is installed by default (server via
`registerAllStak`, browser via the client bootstrap). Existing
`console.{debug,info,warn,error}` calls become structured logs at
`/ingest/v1/logs`; the original console output is always preserved. An
`error`/`fatal` log carrying an `Error` is also promoted to `captureException`.

Wire your logger of choice, or log explicitly:

```ts
import pino from 'pino';
import { allstakPinoStream, allstakWinstonTransport, captureLog } from '@allstak/next';

// pino
const logger = pino({ level: 'info' }, allstakPinoStream());

// winston (optional peer)
const t = allstakWinstonTransport();
const wlogger = winston.createLogger({ transports: t ? [t] : [] });

// explicit
captureLog('warn', 'cache miss', { region: 'eu' });
```

## Breadcrumbs

The browser bootstrap installs console / navigation / fetch breadcrumb
collectors by default, so any error captured afterwards carries the "what
happened just before" trail automatically — no manual `addBreadcrumb` calls.
Toggle with `enableAutoBreadcrumbs` / `NEXT_PUBLIC_ALLSTAK_BREADCRUMBS`.

## Source maps

```js
const { withAllStak } = require('@allstak/next');

module.exports = withAllStak({
  release: process.env.NEXT_PUBLIC_RELEASE,
  uploadToken: process.env.ALLSTAK_UPLOAD_TOKEN,
}, {
  reactStrictMode: true,
});
```

`withAllStak()` also injects the browser client bootstrap into your bundle by
default (so you can skip the root `instrumentation-client.ts`); pass
`clientBootstrap: false` to opt out.

## Manual capture

```ts
import { captureException, initAllStakNext } from '@allstak/next';

initAllStakNext({
  apiKey: process.env.ALLSTAK_API_KEY,
  environment: process.env.NODE_ENV ?? 'production',
  release: process.env.NEXT_PUBLIC_RELEASE,
});

await captureException(new Error('checkout failed'), {
  route: '/checkout',
});
```

## Configuration

| Option | Description |
| --- | --- |
| `apiKey` | Project API key. |
| `environment` | Deployment environment. |
| `release` | App version or commit SHA. |
| `uploadToken` | Source-map upload token. |
| `dist` | Optional build distribution name. |
| `tunnelRoute` | Optional browser ingest tunnel route. |
| `enableDbInstrumentation` | Auto-wire DB driver capture (`pg`). Default true. |
| `enableConsoleLogs` | Bridge `console.*` to `/ingest/v1/logs`. Default true. |
| `enableAutoBreadcrumbs` | Console/navigation/fetch breadcrumb collectors. Default true. |
| `enableOutboundHttp` | Outbound `fetch` capture + trace propagation. Default true. |
| `enableWebVitals` | Core Web Vitals spans. Default true (browser). |

Browser env toggles (set to `false` to opt out): `NEXT_PUBLIC_ALLSTAK_API_KEY`,
`NEXT_PUBLIC_ALLSTAK_HOST`, `NEXT_PUBLIC_ALLSTAK_ENVIRONMENT`,
`NEXT_PUBLIC_ALLSTAK_RELEASE`, `NEXT_PUBLIC_ALLSTAK_WEB_VITALS`,
`NEXT_PUBLIC_ALLSTAK_OUTBOUND_HTTP`, `NEXT_PUBLIC_ALLSTAK_BREADCRUMBS`,
`NEXT_PUBLIC_ALLSTAK_CONSOLE_LOGS`, `NEXT_PUBLIC_ALLSTAK_SEND_PII`.

## Troubleshooting

- Server errors missing: ensure `instrumentation.ts` is enabled in your Next.js version.
- Client errors missing: install global handlers or use the error boundary helper.
- Source maps missing: use the same release value in runtime config and source-map upload.

## Contributing and Support

- Report bugs with the GitHub bug report template: https://github.com/AllStak/allstak-next/issues/new/choose
- Open pull requests using the checklist in [CONTRIBUTING.md](CONTRIBUTING.md).
- Report security vulnerabilities privately through [SECURITY.md](SECURITY.md).

## License

MIT
