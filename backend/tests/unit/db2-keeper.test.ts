// ============================================================
// Unit tests: DB2DirectService — Keeper password injection
// Verifies that DB2_PASS_OVERRIDE is set / not set depending on
// the KEEPER_ENABLED flag and whether a Keeper record exists.
// ============================================================
import { execFile } from 'child_process';

// ---- Mock child_process before any import that uses it ----
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

// ---- Mock logger ----
jest.mock('../../src/utils/logger', () => ({
  createServiceLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// ---- Mock keeperService ----
jest.mock('../../src/services/keeper-service', () => ({
  keeperService: {
    isConfigured: jest.fn(() => false),
    getPassword: jest.fn(),
  },
}));

import { db2DirectService } from '../../src/services/db2-direct-service';
import { keeperService } from '../../src/services/keeper-service';

// Convenience casts
const execFileMock = execFile as jest.MockedFunction<typeof execFile>;
const isConfiguredMock = keeperService.isConfigured as jest.Mock;
const getPasswordMock = keeperService.getPassword as jest.Mock;

// Successful JSON response the mock connector returns
const SUCCESS_JSON = JSON.stringify({ success: true, columns: [], rows: [], rowCount: 0 });

/**
 * Build an execFile mock that captures the options passed to it
 * and calls the callback with the given stdout.
 */
function buildExecFileMock(stdout: string = SUCCESS_JSON) {
  let capturedOpts: Record<string, any> = {};
  execFileMock.mockImplementation((_cmd: any, _args: any, opts: any, cb: any) => {
    capturedOpts = opts;
    // Fire callback asynchronously to simulate real behaviour
    process.nextTick(() => cb(null, stdout, ''));
    return { kill: jest.fn() } as any;
  });
  return { getCapturedOpts: () => capturedOpts };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Ensure the service isn't in shutdown mode
  (db2DirectService as any).shuttingDown = false;
});

// ============================================================
// Keeper DISABLED (default)
// ============================================================

describe('runConnector() — Keeper disabled', () => {
  beforeEach(() => {
    isConfiguredMock.mockReturnValue(false);
  });

  it('does not call keeperService.getPassword', async () => {
    buildExecFileMock();
    await db2DirectService.testConnection('CVS');
    expect(getPasswordMock).not.toHaveBeenCalled();
  });

  it('passes undefined env to execFile (uses connection file password)', async () => {
    const { getCapturedOpts } = buildExecFileMock();
    await db2DirectService.testConnection('CVS');
    expect(getCapturedOpts().env).toBeUndefined();
  });

  it('does not include DB2_PASS_OVERRIDE in the child environment', async () => {
    const { getCapturedOpts } = buildExecFileMock();
    await db2DirectService.testConnection('WAG');
    const env = getCapturedOpts().env as NodeJS.ProcessEnv | undefined;
    if (env) {
      expect(env['DB2_PASS_OVERRIDE']).toBeUndefined();
    } else {
      // env is undefined — child process inherits parent env (no override injected)
      expect(env).toBeUndefined();
    }
  });
});

// ============================================================
// Keeper ENABLED — record found
// ============================================================

describe('runConnector() — Keeper enabled, record found', () => {
  beforeEach(() => {
    isConfiguredMock.mockReturnValue(true);
    getPasswordMock.mockResolvedValue('vaultP@ssword123');
  });

  it('calls keeperService.getPassword with the sanitised client ID', async () => {
    buildExecFileMock();
    await db2DirectService.testConnection('CVS');
    expect(getPasswordMock).toHaveBeenCalledWith('CVS');
  });

  it('sets DB2_PASS_OVERRIDE in the child env when a password is returned', async () => {
    const { getCapturedOpts } = buildExecFileMock();
    await db2DirectService.testConnection('CVS');
    expect(getCapturedOpts().env).toBeDefined();
    expect(getCapturedOpts().env!['DB2_PASS_OVERRIDE']).toBe('vaultP@ssword123');
  });

  it('includes all existing process.env vars alongside DB2_PASS_OVERRIDE', async () => {
    const { getCapturedOpts } = buildExecFileMock();
    await db2DirectService.testConnection('CVS');
    const env = getCapturedOpts().env as NodeJS.ProcessEnv;
    // process.env keys should also be present (shallow spread)
    expect(env['PATH']).toBe(process.env.PATH);
  });

  it('sanitises the client ID (strips non-alphanumeric) before querying Keeper', async () => {
    buildExecFileMock();
    await db2DirectService.testConnection('CVS; rm -rf /');
    // After sanitisation, only 'CVS' remains
    expect(getPasswordMock).toHaveBeenCalledWith('CVSrmrf');
  });

  it('returns the connector output regardless of Keeper usage', async () => {
    buildExecFileMock(JSON.stringify({ success: true, columns: ['C1'], rows: [{ C1: 'val' }], rowCount: 1 }));
    const result = await db2DirectService.queryClient('CVS', 'SELECT 1 FROM SYSIBM.SYSDUMMY1');
    expect(result.success).toBe(true);
    expect(result.rowCount).toBe(1);
  });
});

// ============================================================
// Keeper ENABLED — record NOT found
// ============================================================

describe('runConnector() — Keeper enabled, record not found', () => {
  beforeEach(() => {
    isConfiguredMock.mockReturnValue(true);
    getPasswordMock.mockResolvedValue(null); // no record in vault
  });

  it('does not set DB2_PASS_OVERRIDE (falls back to connection file)', async () => {
    const { getCapturedOpts } = buildExecFileMock();
    await db2DirectService.testConnection('BOFA');
    expect(getCapturedOpts().env).toBeUndefined();
  });

  it('still calls keeperService.getPassword (attempted lookup)', async () => {
    buildExecFileMock();
    await db2DirectService.testConnection('BOFA');
    expect(getPasswordMock).toHaveBeenCalledWith('BOFA');
  });
});

// ============================================================
// Keeper ENABLED — Keeper throws
// ============================================================

describe('runConnector() — Keeper enabled, getPassword throws', () => {
  beforeEach(() => {
    isConfiguredMock.mockReturnValue(true);
    getPasswordMock.mockRejectedValue(new Error('vault unreachable'));
  });

  it('propagates the error (DB2 call fails gracefully)', async () => {
    // The error from getPassword will bubble up; runConnector is async so it rejects.
    await expect(db2DirectService.testConnection('CVS')).rejects.toThrow('vault unreachable');
  });
});

// ============================================================
// Shutdown guard
// ============================================================

describe('runConnector() — shutdown guard', () => {
  it('returns a failure response immediately when service is shutting down', async () => {
    (db2DirectService as any).shuttingDown = true;
    const result = await db2DirectService.testConnection('CVS');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/shutting down/i);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
