import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveRelease,
  resolveGitRelease,
  detectReleaseFromEnv,
  isNodeServerRuntime,
  _resetReleaseCache,
  type GitRunner,
} from '../src/release';
import { AllStakNextClient, SDK_VERSION } from '../src/client';

afterEach(() => {
  _resetReleaseCache();
});

/** Build a fake git runner from a map of "joined args" → output (or throw). */
function fakeGit(map: Record<string, string | null | Error>): GitRunner {
  return (args: string[]) => {
    const key = args.join(' ');
    const v = map[key];
    if (v instanceof Error) throw v;
    return v ?? null;
  };
}

describe('detectReleaseFromEnv', () => {
  it('prefers ALLSTAK_RELEASE over platform vars', () => {
    expect(detectReleaseFromEnv({ ALLSTAK_RELEASE: 'r1', VERCEL_GIT_COMMIT_SHA: 'abc' })).toBe('r1');
  });
  it('falls back through platform vars in order', () => {
    expect(detectReleaseFromEnv({ VERCEL_GIT_COMMIT_SHA: 'vercel-sha' })).toBe('vercel-sha');
    expect(detectReleaseFromEnv({ RAILWAY_GIT_COMMIT_SHA: 'rw' })).toBe('rw');
    expect(detectReleaseFromEnv({ RENDER_GIT_COMMIT: 'rd' })).toBe('rd');
    expect(detectReleaseFromEnv({ GIT_COMMIT: 'gc' })).toBe('gc');
    expect(detectReleaseFromEnv({ GIT_SHA: 'gs' })).toBe('gs');
    expect(detectReleaseFromEnv({ SOURCE_VERSION: 'sv' })).toBe('sv');
  });
  it('ignores empty / whitespace values and trims', () => {
    expect(detectReleaseFromEnv({ ALLSTAK_RELEASE: '   ', VERCEL_GIT_COMMIT_SHA: '  v ' })).toBe('v');
    expect(detectReleaseFromEnv({})).toBeUndefined();
  });
});

describe('resolveGitRelease (pure parse over runner)', () => {
  it('uses git describe output when present', () => {
    const runner = fakeGit({ 'describe --tags --always --dirty': 'v1.2.3-4-gabcdef' });
    expect(resolveGitRelease(runner)).toBe('v1.2.3-4-gabcdef');
  });
  it('parses describe --dirty suffix verbatim', () => {
    const runner = fakeGit({ 'describe --tags --always --dirty': 'v1.0.0-dirty' });
    expect(resolveGitRelease(runner)).toBe('v1.0.0-dirty');
  });
  it('falls back to short sha when describe is empty', () => {
    const runner = fakeGit({
      'describe --tags --always --dirty': '',
      'rev-parse --short HEAD': 'deadbee',
      'status --porcelain': '',
    });
    expect(resolveGitRelease(runner)).toBe('deadbee');
  });
  it('appends -dirty when status reports a dirty tree on the sha fallback', () => {
    const runner = fakeGit({
      'describe --tags --always --dirty': null,
      'rev-parse --short HEAD': 'deadbee',
      'status --porcelain': ' M src/x.ts',
    });
    expect(resolveGitRelease(runner)).toBe('deadbee-dirty');
  });
  it('returns undefined when the runner yields nothing', () => {
    const runner = fakeGit({});
    expect(resolveGitRelease(runner)).toBeUndefined();
  });
  it('is graceful when the runner throws', () => {
    const runner: GitRunner = () => {
      throw new Error('ENOENT git');
    };
    expect(resolveGitRelease(runner)).toBeUndefined();
  });
});

describe('resolveRelease — priority order', () => {
  it('1. explicit release always wins', () => {
    expect(
      resolveRelease({
        explicit: 'explicit-1',
        env: { ALLSTAK_RELEASE: 'env', VERCEL_GIT_COMMIT_SHA: 'v' },
        gitRunner: fakeGit({ 'describe --tags --always --dirty': 'git' }),
        version: '9.9.9',
      }),
    ).toBe('explicit-1');
  });

  it('2. env beats git + version', () => {
    expect(
      resolveRelease({
        env: { VERCEL_GIT_COMMIT_SHA: 'vercel-sha' },
        gitRunner: fakeGit({ 'describe --tags --always --dirty': 'git-rel' }),
        version: '9.9.9',
      }),
    ).toBe('vercel-sha');
  });

  it('3. git beats version when env is empty', () => {
    expect(
      resolveRelease({
        env: {},
        gitRunner: fakeGit({ 'describe --tags --always --dirty': 'git-rel' }),
        version: '9.9.9',
      }),
    ).toBe('git-rel');
  });

  it('4. version fallback when nothing else resolves', () => {
    expect(
      resolveRelease({
        env: {},
        gitRunner: fakeGit({}),
        version: '9.9.9',
      }),
    ).toBe('9.9.9');
  });

  it('opt-out disables git AND version (env still honored)', () => {
    // autoDetectRelease:false with no env → empty
    expect(
      resolveRelease({
        autoDetectRelease: false,
        env: {},
        gitRunner: fakeGit({ 'describe --tags --always --dirty': 'git-rel' }),
        version: '9.9.9',
      }),
    ).toBe('');
    // env still wins even when opted out
    expect(
      resolveRelease({
        autoDetectRelease: false,
        env: { GIT_SHA: 'gs' },
        version: '9.9.9',
      }),
    ).toBe('gs');
  });

  it('caches the git lookup (runner invoked once across calls)', () => {
    let calls = 0;
    const runner: GitRunner = (args) => {
      calls++;
      return args[0] === 'describe' ? 'git-cached' : null;
    };
    expect(resolveRelease({ env: {}, gitRunner: runner })).toBe('git-cached');
    expect(resolveRelease({ env: {}, gitRunner: runner })).toBe('git-cached');
    expect(calls).toBe(1);
  });
});

describe('runtime guard', () => {
  it('isNodeServerRuntime is true under vitest/node', () => {
    expect(isNodeServerRuntime()).toBe(true);
  });
});

describe('AllStakNextClient integration', () => {
  it('explicit release wins on the client', () => {
    const c = new AllStakNextClient({ apiKey: 'k', release: 'explicit', gitRunner: fakeGit({ 'describe --tags --always --dirty': 'git' }) });
    expect(c.getRelease()).toBe('explicit');
  });

  it('client falls back to git then version via injected runner', () => {
    const c = new AllStakNextClient({ apiKey: 'k', gitRunner: fakeGit({ 'describe --tags --always --dirty': 'git-via-client' }) });
    expect(c.getRelease()).toBe('git-via-client');
  });

  it('client uses SDK version when git+env yield nothing', () => {
    const c = new AllStakNextClient({ apiKey: 'k', gitRunner: fakeGit({}) });
    // env may be empty in this environment; if a real env var is set this would differ,
    // so only assert it is non-empty and defaults to version when no env present.
    const r = c.getRelease();
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
    // When no release env vars are set, it should equal the SDK version.
    if (!process.env.ALLSTAK_RELEASE && !process.env.GIT_SHA && !process.env.GIT_COMMIT &&
        !process.env.VERCEL_GIT_COMMIT_SHA && !process.env.RAILWAY_GIT_COMMIT_SHA &&
        !process.env.RENDER_GIT_COMMIT && !process.env.SOURCE_VERSION) {
      expect(r).toBe(SDK_VERSION);
    }
  });

  it('opt-out leaves release empty when no explicit/env release', () => {
    const c = new AllStakNextClient({ apiKey: 'k', autoDetectRelease: false, gitRunner: fakeGit({ 'describe --tags --always --dirty': 'git' }) });
    if (!process.env.ALLSTAK_RELEASE && !process.env.GIT_SHA && !process.env.GIT_COMMIT &&
        !process.env.VERCEL_GIT_COMMIT_SHA && !process.env.RAILWAY_GIT_COMMIT_SHA &&
        !process.env.RENDER_GIT_COMMIT && !process.env.SOURCE_VERSION) {
      expect(c.getRelease()).toBe('');
    }
  });
});
