// Browser client bootstrap. Next.js auto-loads a root `instrumentation-client.ts`
// in the browser; re-exporting the SDK's client entry auto-runs the AllStak
// browser bootstrap from NEXT_PUBLIC_* env — registering a client and installing
// global error handlers, Core Web Vitals, the outbound-fetch tracer, the
// auto-breadcrumb collectors, and the console→log bridge — with no manual call.
export * from '@allstak/next/client';
