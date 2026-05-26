# @allstak/next

AllStak SDK for Next.js App Router and Pages Router. Captures server errors, client errors, route-handler errors, middleware errors, and uploads source maps.

## Install

```bash
npm install @allstak/next
```

## App Router

Create `instrumentation.ts`:

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

## Troubleshooting

- Server errors missing: ensure `instrumentation.ts` is enabled in your Next.js version.
- Client errors missing: install global handlers or use the error boundary helper.
- Source maps missing: use the same release value in runtime config and source-map upload.

## License

MIT
