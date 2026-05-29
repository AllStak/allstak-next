import { withAllStakMiddleware } from '@allstak/next';
import { NextResponse } from 'next/server';

// Use Node.js runtime so the SDK's server-side APIs are available.
export const runtime = 'nodejs';

export default withAllStakMiddleware(async () => {
  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
