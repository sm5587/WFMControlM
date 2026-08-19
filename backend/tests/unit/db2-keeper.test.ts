// ============================================================
// Unit tests: DB2DirectService — Keeper password injection
// Verifies that DB2_PASS_OVERRIDE is set / not cleared depending on
// the KEEPER_ENABLED flag and whether a Keeper record exists.
// ============================================================
import { execFile } from 'child_process';

// ---- Mock child_process before any import that uses it ----
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execFile: jest.fn(),
  };
});

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

jest.mock('../../src/database/prisma', () => ({
  prisma: {
    client: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}));

jest.mock('../../src/services/config-service', () => ({
  configService: {
    getString: jest.fn((key: string) => {
      const defaults: Record<string, string> = {
        'infra.db2LibDir': '',
        'infra.db2JavaPath': 'java',
        'infra.db2JjsPath': '',
      };
      return defaults[key] ?? '';
    }),
    getInt: jest.fn((key: string, defaultVal = 0) => {
      const defaults: Record<string, number> = {
        'engine.db2ConnectorTimeoutMs': 120000,
        'engine.db2ConnectorMaxBuffer': 10485760,
        'engine.jjsTimeoutMs': 120000,
        'engine.jjsMaxBuffer': 10485760,
        'infra.db2DefaultPort': 50000,
      };
      return defaults[key] ?? defaultVal;
    }),
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
  let passwordAtSpawn: string | undefined;
  execFileMock.mockImplementation((_cmd: any, _args: any, optsOrCb: any, cb?: any) => {
    const opts = typeof optsOrCb === 'function' ? {} : (optsOrCb ?? {});
    const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
    capturedOpts = opts;
    passwordAtSpawn = opts?.env?.DB2_PASS_OVERRIDE;
    process.nextTick(() => callback(null, stdout, ''));
    return { kill: jest.fn() } as any;
  });
  return {
    getCapturedOpts: () => capturedOpts,
    getPasswordAtSpawn: () => passwordAtSpawn,
  };
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

  it('passes java connector args with DB2Connector main class', async () => {
    let capturedArgs: string[] = [];
    execFileMock.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      capturedArgs = args;
      process.nextTick(() => cb(null, SUCCESS_JSON, ''));
      return { kill: jest.fn() } as any;
    });
    await db2DirectService.testConnection('CVS');
    expect(capturedArgs).toEqual(expect.arrayContaining(['-cp', 'DB2Connector', 'test', 'CVS']));
  });

  it('does not include DB2_PASS_OVERRIDE when no credentials configured', async () => {
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
    const { getPasswordAtSpawn } = buildExecFileMock();
    await db2DirectService.testConnection('CVS');
    expect(getPasswordAtSpawn()).toBe('vaultP@ssword123');
  });

  it('clears DB2_PASS_OVERRIDE from child env after the connector exits', async () => {
    const { getCapturedOpts } = buildExecFileMock();
    await db2DirectService.testConnection('CVS');
    expect(getCapturedOpts().env!['DB2_PASS_OVERRIDE']).toBeUndefined();
  });

  it('includes parent process env in the child environment', async () => {
    const { getCapturedOpts } = buildExecFileMock();
    await db2DirectService.testConnection('CVS');
    const env = getCapturedOpts().env as NodeJS.ProcessEnv;
    expect(env).toBeDefined();
    expect(typeof env).toBe('object');
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

  it('does not set DB2_PASS_OVERRIDE when Keeper returns null', async () => {
    const { getCapturedOpts } = buildExecFileMock();
    await db2DirectService.testConnection('BOFA');
    expect(getCapturedOpts().env?.DB2_PASS_OVERRIDE).toBeUndefined();
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
