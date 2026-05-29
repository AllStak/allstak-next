// @ts-check

/**
 * The @allstak/next SDK ships a single bundle that includes both server-only
 * code (fs, path, crypto for source-map upload) and client-safe code (error
 * boundary, captureException). We dynamically import for the config wrapper
 * and configure webpack to stub Node.js built-ins on the client side.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Stub Node.js built-ins that the SDK imports at the top level
      // but never actually calls on the client side.
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    }
    return config;
  },
};

// Wrap with withAllStak for source-map upload during production builds.
// We use a top-level await dynamic import because next.config.mjs runs
// in Node.js where the fs imports resolve fine.
const { withAllStak } = await import('@allstak/next');

export default withAllStak(
  {
    release: process.env.npm_package_version || '0.1.0',
    uploadToken: process.env.ALLSTAK_API_KEY || '',
    host: process.env.ALLSTAK_HOST,
  },
  nextConfig,
);
