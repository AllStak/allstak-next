# AllStak Next.js App Router Example

A working example demonstrating `@allstak/next` SDK integration with Next.js 14 App Router.

## Setup

1. Copy `.env.example` to `.env.local` and add your AllStak API key:

```bash
cp .env.example .env.local
```

2. Install dependencies:

```bash
npm install
```

3. Run the development server:

```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000) and navigate to the Demo page.

## Integration Points

| File                  | SDK API                     | Purpose                                  |
|-----------------------|-----------------------------|------------------------------------------|
| `next.config.mjs`    | `withAllStak()`             | Source map upload during production build |
| `instrumentation.ts`  | `registerAllStak()`         | Server-side SDK initialization           |
| `middleware.ts`       | `withAllStakMiddleware()`   | Request tracing and error capture        |
| `app/error.tsx`       | `AllStakErrorBoundary`      | Route-level error boundary               |
| `app/global-error.tsx`| `captureException()`        | Root-level error boundary                |
| `app/demo/page.tsx`   | `captureException()`, `installGlobalErrorHandlers()`, `AllStakErrorBoundary` | Interactive demo |
| `app/api/test-error/` | `captureException()`        | Server-side error capture in API routes  |

## Production Build

```bash
npm run build
npm start
```

Source maps are uploaded automatically during `npm run build` when `ALLSTAK_API_KEY` is set.
