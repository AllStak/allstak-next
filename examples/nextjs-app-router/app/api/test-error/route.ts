import { captureException } from '@allstak/next';
import { NextResponse } from 'next/server';

export async function GET() {
  const error = new Error('Test server error from API route');
  error.name = 'ApiRouteTestError';

  await captureException(error, {
    route: '/api/test-error',
    mechanism: 'api-route',
  });

  return NextResponse.json(
    { error: error.message, captured: true },
    { status: 500 },
  );
}
