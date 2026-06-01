// ============================================================
// Unit tests: KeeperService
// Tests the flag-based enable/disable logic, SDK initialization,
// field fetching, TTL cache, and error handling.
// ============================================================

// ---- Mock logger (no file writes) ----
jest.mock('../../src/utils/logger', () => ({
  createServiceLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// ---- Mock config — mutable via jest.requireMock ----
jest.mock('../../src/config', () => ({
  config: {
    keeper: {
      enabled: false,
      configFile: '',
      oneTimeToken: '',
    },
  },
}));

// ---- Mock the Keeper SDK (dynamic import intercepted by Jest) ----
const mockGetSecrets = jest.fn();
const mockGetSecretByTitle = jest.fn();
const mockInitializeStorage = jest.fn();
const mockLocalConfigStorage = jest.fn(() => ({ __storage: true }));

jest.mock('@keeper-security/secrets-manager-core', () => ({
  getSecrets: mockGetSecrets,
  getSecretByTitle: mockGetSecretByTitle,
  initializeStorage: mockInitializeStorage,
  localConfigStorage: mockLocalConfigStorage,
}));

import { keeperService } from '../../src/services/keeper-service';

// Helper: access the mutable mock config object
const { config: mockConfig } = jest.requireMock('../../src/config') as {
  config: { keeper: { enabled: boolean; configFile: string; oneTimeToken: string } };
};

// Helper: reset internal singleton state between tests
function resetService() {
  (keeperService as any).initialized = false;
  (keeperService as any).fieldCache.clear();
}

// Helper: make the service think it's initialized
function forceInitialized() {
  (keeperService as any).initialized = true;
}

beforeEach(() => {
  resetService();
  mockConfig.keeper.enabled = false;
  mockConfig.keeper.configFile = '';
  mockConfig.keeper.oneTimeToken = '';
});

// ============================================================
// isConfigured()
// ============================================================

describe('isConfigured()', () => {
  it('returns false when KEEPER_ENABLED is false', () => {
    mockConfig.keeper.enabled = false;
    mockConfig.keeper.configFile = '/some/path.json';
    expect(keeperService.isConfigured()).toBe(false);
  });

  it('returns false when enabled but KEEPER_CONFIG_FILE is empty', () => {
    mockConfig.keeper.enabled = true;
    mockConfig.keeper.configFile = '';
    expect(keeperService.isConfigured()).toBe(false);
  });

  it('returns true when enabled and configFile are both set', () => {
    mockConfig.keeper.enabled = true;
    mockConfig.keeper.configFile = '/path/to/ksm-config.json';
    expect(keeperService.isConfigured()).toBe(true);
  });
});

// ============================================================
// initialize()
// ============================================================

describe('initialize()', () => {
  it('does not call the SDK when KEEPER_ENABLED is false', async () => {
    mockConfig.keeper.enabled = false;
    await keeperService.initialize();
    expect(mockGetSecrets).not.toHaveBeenCalled();
    expect((keeperService as any).initialized).toBe(false);
  });

  it('does not call the SDK when enabled but configFile is missing', async () => {
    mockConfig.keeper.enabled = true;
    mockConfig.keeper.configFile = '';
    await keeperService.initialize();
    expect(mockGetSecrets).not.toHaveBeenCalled();
    expect((keeperService as any).initialized).toBe(false);
  });

  it('calls getSecrets and sets initialized=true on successful connection', async () => {
    mockConfig.keeper.enabled = true;
    mockConfig.keeper.configFile = '/path/to/ksm-config.json';
    mockGetSecrets.mockResolvedValueOnce({ records: [] });

    await keeperService.initialize();

    expect(mockGetSecrets).toHaveBeenCalledTimes(1);
    expect((keeperService as any).initialized).toBe(true);
  });

  it('calls initializeStorage when oneTimeToken is set', async () => {
    mockConfig.keeper.enabled = true;
    mockConfig.keeper.configFile = '/path/to/ksm-config.json';
    mockConfig.keeper.oneTimeToken = 'US:ONE_TIME_TOKEN_abc123';
    mockGetSecrets.mockResolvedValueOnce({ records: [] });

    await keeperService.initialize();

    expect(mockInitializeStorage).toHaveBeenCalledWith(
      expect.anything(),
      'US:ONE_TIME_TOKEN_abc123',
    );
  });

  it('stays uninitialized and does not throw when SDK throws', async () => {
    mockConfig.keeper.enabled = true;
    mockConfig.keeper.configFile = '/path/to/ksm-config.json';
    mockGetSecrets.mockRejectedValueOnce(new Error('network unreachable'));

    await expect(keeperService.initialize()).resolves.toBeUndefined();
    expect((keeperService as any).initialized).toBe(false);
  });
});

// ============================================================
// getPassword() / getLogin() / getField()
// ============================================================

describe('getPassword()', () => {
  it('returns null immediately when service is not initialized', async () => {
    // initialized = false (set in beforeEach)
    const result = await keeperService.getPassword('CVS');
    expect(result).toBeNull();
    expect(mockGetSecretByTitle).not.toHaveBeenCalled();
  });

  it('returns the password field value from the Keeper record', async () => {
    forceInitialized();
    mockConfig.keeper.configFile = '/path/to/ksm-config.json';
    mockGetSecretByTitle.mockResolvedValueOnce({
      data: {
        fields: [
          { type: 'login', value: ['datareader'] },
          { type: 'password', value: ['s3cr3tP@ss!'] },
        ],
      },
    });

    const result = await keeperService.getPassword('CVS');
    expect(result).toBe('s3cr3tP@ss!');
    expect(mockGetSecretByTitle).toHaveBeenCalledWith(
      expect.objectContaining({ storage: expect.anything() }),
      'CVS',
    );
  });

  it('returns null when the Keeper record does not exist', async () => {
    forceInitialized();
    mockConfig.keeper.configFile = '/path/to/ksm-config.json';
    mockGetSecretByTitle.mockResolvedValueOnce(null);

    const result = await keeperService.getPassword('UNKNOWN_CLIENT');
    expect(result).toBeNull();
  });

  it('returns null when the record exists but has no password field', async () => {
    forceInitialized();
    mockConfig.keeper.configFile = '/path/to/ksm-config.json';
    mockGetSecretByTitle.mockResolvedValueOnce({
      data: { fields: [{ type: 'login', value: ['someuser'] }] },
    });

    const result = await keeperService.getPassword('WAG');
    expect(result).toBeNull();
  });

  it('returns null (no throw) when SDK throws', async () => {
    forceInitialized();
    mockConfig.keeper.configFile = '/path/to/ksm-config.json';
    mockGetSecretByTitle.mockRejectedValueOnce(new Error('vault unreachable'));

    const result = await keeperService.getPassword('BOFA');
    expect(result).toBeNull();
  });

  it('returns cached value on second call within TTL (SDK called only once)', async () => {
    forceInitialized();
    mockConfig.keeper.configFile = '/path/to/ksm-config.json';
    mockGetSecretByTitle.mockResolvedValue({
      data: { fields: [{ type: 'password', value: ['cachedPass'] }] },
    });

    const first = await keeperService.getPassword('CVS');
    const second = await keeperService.getPassword('CVS');

    expect(first).toBe('cachedPass');
    expect(second).toBe('cachedPass');
    // SDK should only be called once; second result comes from cache
    expect(mockGetSecretByTitle).toHaveBeenCalledTimes(1);
  });

  it('re-fetches from SDK after TTL expires', async () => {
    forceInitialized();
    mockConfig.keeper.configFile = '/path/to/ksm-config.json';
    mockGetSecretByTitle.mockResolvedValue({
      data: { fields: [{ type: 'password', value: ['newPass'] }] },
    });

    // Seed expired cache entry directly
    (keeperService as any).fieldCache.set('CVS::password', {
      value: 'oldPass',
      expiresAt: Date.now() - 1, // already expired
    });

    const result = await keeperService.getPassword('CVS');
    expect(result).toBe('newPass');
    expect(mockGetSecretByTitle).toHaveBeenCalledTimes(1);
  });
});

describe('getLogin()', () => {
  it('returns the login field value from the record', async () => {
    forceInitialized();
    mockConfig.keeper.configFile = '/path/to/ksm-config.json';
    mockGetSecretByTitle.mockResolvedValueOnce({
      data: {
        fields: [
          { type: 'login', value: ['datareader'] },
          { type: 'password', value: ['somepass'] },
        ],
      },
    });

    const result = await keeperService.getLogin('CVS');
    expect(result).toBe('datareader');
  });

  it('caches login and password independently by field type', async () => {
    forceInitialized();
    mockConfig.keeper.configFile = '/path/to/ksm-config.json';
    mockGetSecretByTitle.mockResolvedValue({
      data: {
        fields: [
          { type: 'login', value: ['datareader'] },
          { type: 'password', value: ['secret'] },
        ],
      },
    });

    await keeperService.getPassword('CVS');
    await keeperService.getLogin('CVS');

    // Two separate cache keys: CVS::password and CVS::login
    expect((keeperService as any).fieldCache.size).toBe(2);
    // SDK called once per field type (cache misses for each)
    expect(mockGetSecretByTitle).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// clearCache()
// ============================================================

describe('clearCache()', () => {
  it('evicts all cached entries', () => {
    (keeperService as any).fieldCache.set('CVS::password', { value: 'x', expiresAt: Date.now() + 99999 });
    (keeperService as any).fieldCache.set('WAG::password', { value: 'y', expiresAt: Date.now() + 99999 });

    keeperService.clearCache();

    expect((keeperService as any).fieldCache.size).toBe(0);
  });
});

// ============================================================
// getStatus()
// ============================================================

describe('getStatus()', () => {
  it('reports not configured + not initialized when disabled', () => {
    mockConfig.keeper.enabled = false;
    const status = keeperService.getStatus();
    expect(status.configured).toBe(false);
    expect(status.initialized).toBe(false);
    expect(status.cachedEntries).toBe(0);
  });

  it('reports configured + initialized when fully set up', () => {
    mockConfig.keeper.enabled = true;
    mockConfig.keeper.configFile = '/path/to/ksm-config.json';
    forceInitialized();

    (keeperService as any).fieldCache.set('CVS::password', { value: 'x', expiresAt: Date.now() + 9999 });

    const status = keeperService.getStatus();
    expect(status.configured).toBe(true);
    expect(status.initialized).toBe(true);
    expect(status.cachedEntries).toBe(1);
  });
});
