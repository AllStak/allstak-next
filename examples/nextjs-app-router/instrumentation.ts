export async function register() {
  const { registerAllStak } = await import('@allstak/next');

  registerAllStak({
    apiKey: process.env.ALLSTAK_API_KEY,
    host: process.env.ALLSTAK_HOST || 'https://api.allstak.sa',
    environment: process.env.NODE_ENV,
    release: process.env.npm_package_version || '0.1.0',
  });
}
