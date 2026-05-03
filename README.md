# @allstak/next

Beta standalone AllStak SDK for Next.js applications and source-map upload.

This package is independently installable and does not depend on another `@allstak/*` SDK at runtime.

```sh
npm install @allstak/next@beta
```

```ts
import { initAllStakNext } from "@allstak/next";

const allstak = initAllStakNext({
  dsn: process.env.ALLSTAK_DSN,
  endpoint: "https://api.allstak.sa",
  release: process.env.NEXT_PUBLIC_RELEASE,
  environment: process.env.NODE_ENV,
});
```

For development verification against AllStak dev, set `endpoint` to `https://api.dev.allstak.sa`.
