# @allstak/next

Next.js SDK for [AllStak](https://app.allstak.sa) -- automatic error tracking, source-map upload, and observability for Next.js applications.

[![npm version](https://img.shields.io/npm/v/@allstak/next.svg)](https://www.npmjs.com/package/@allstak/next)
[![license](https://img.shields.io/npm/l/@allstak/next.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-13%2B-black.svg)](https://nextjs.org/)

> **Beta** -- actively evolving. Validated for App Router and Pages Router.

```sh
npm install @allstak/next
```

## Features

- Server-side error capture via Next.js instrumentation hooks
- Client-side error boundaries and global handlers
- Middleware integration for edge-runtime errors
- Automatic source-map upload during builds
- Standalone source-map upload for CI pipelines
- Manual error and message capture API
- Zero `@allstak/*` runtime dependencies -- fully self-contained

## App Router Setup

### 1. Instrumentation (server-side)

```ts
// instrumentation.ts
export async function register() {
  const { registerAllStak } = await import("@allstak/next");
  registerAllStak({
    apiKey: process.env.ALLSTAK_API_KEY,
    host: "https://api.allstak.sa",
    environment: process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_RELEASE,
  });
}
```

### 2. Error boundary (client-side)

```tsx
// app/error.tsx
"use client";
import { AllStakErrorBoundary } from "@allstak/next";

export default function ErrorPage({ error }: { error: Error }) {
  return <p>Something went wrong: {error.message}</p>;
}
```

Or wrap any component:

```tsx
import { withAllStakErrorBoundary } from "@allstak/next";
export default withAllStakErrorBoundary(MyComponent, {
  fallback: <p>Something went wrong</p>,
});
```

### 3. Global client-side handlers

```tsx
// app/providers.tsx
"use client";
import { useEffect } from "react";
import { installGlobalErrorHandlers } from "@allstak/next";

export function AllStakProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => installGlobalErrorHandlers(), []);
  return <>{children}</>;
}
```

### 4. Middleware

```ts
// middleware.ts
import { withAllStakMiddleware } from "@allstak/next";
import { NextResponse } from "next/server";

export default withAllStakMiddleware(async () => {
  return NextResponse.next();
});
```

## Pages Router Setup

```tsx
// pages/_error.tsx
import { captureUnderscoreErrorException } from "@allstak/next";
import NextErrorComponent from "next/error";

function CustomError({ statusCode }: { statusCode: number }) {
  return <NextErrorComponent statusCode={statusCode} />;
}

CustomError.getInitialProps = async (ctx: any) => {
  await captureUnderscoreErrorException(ctx);
  return NextErrorComponent.getInitialProps(ctx);
};

export default CustomError;
```

## Source Maps

### next.config.js wrapper

```js
const { withAllStak } = require("@allstak/next");

module.exports = withAllStak(
  {
    release: process.env.NEXT_PUBLIC_RELEASE,
    uploadToken: process.env.ALLSTAK_UPLOAD_TOKEN,
  },
  {
    // your existing next.config.js options
  }
);
```

### Standalone upload (CI)

```ts
import { processNextSourceMaps } from "@allstak/next";

await processNextSourceMaps({
  dir: ".next",
  release: "1.0.0",
  uploadToken: process.env.ALLSTAK_UPLOAD_TOKEN!,
});
```

## Manual Capture

```ts
import { initAllStakNext } from "@allstak/next";

const client = initAllStakNext({
  apiKey: process.env.ALLSTAK_API_KEY,
  host: "https://api.allstak.sa",
});

client.captureException(new Error("something broke"));
client.captureMessage("deployment started", "info");
```

## Configuration

| Option          | Type     | Required | Description                            |
| --------------- | -------- | -------- | -------------------------------------- |
| `apiKey`        | `string` | Yes      | Project API key from AllStak dashboard |
| `host`          | `string` | Yes      | Ingest endpoint URL                    |
| `environment`   | `string` | No       | Deployment environment name            |
| `release`       | `string` | No       | Release or version identifier          |
| `uploadToken`   | `string` | No       | Token for source-map uploads           |

### Self-hosted deployments

Set `host` to your own AllStak instance URL (e.g. `https://allstak.internal.example.com`).

## Links

- [Dashboard](https://app.allstak.sa)
- [Documentation](https://docs.allstak.sa)

## License

[MIT](./LICENSE)
