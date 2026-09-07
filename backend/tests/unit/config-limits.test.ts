import {
  clampConfigInt,
  ConfigValidationError,
  MAX_DB2_POOL_MAX,
  MAX_DB2_QUERY_CONCURRENCY,
  MIN_DB_POLLING_MINS,
  validateConfigValue,
} from '../../src/utils/config-limits';

describe('config-limits', () => {
  describe('validateConfigValue', () => {
    it('rejects DB polling intervals below 5 minutes', () => {
      expect(() => validateConfigValue('polling.batchRefreshMins', '1')).toThrow(ConfigValidationError);
      expect(() => validateConfigValue('polling.batchRefreshMins', '5')).not.toThrow();
    });

    it('rejects db2QueryConcurrency outside 1–10', () => {
      expect(() => validateConfigValue('engine.db2QueryConcurrency', '0')).toThrow(ConfigValidationError);
      expect(() => validateConfigValue('engine.db2QueryConcurrency', '11')).toThrow(ConfigValidationError);
      expect(() => validateConfigValue('engine.db2QueryConcurrency', '5')).not.toThrow();
    });

    it('rejects db2PoolMax outside 1–10', () => {
      expect(() => validateConfigValue('infra.db2PoolMax', '20')).toThrow(ConfigValidationError);
      expect(() => validateConfigValue('infra.db2PoolMax', '10')).not.toThrow();
    });

    it('rejects non-boolean engine.syncEnabled values', () => {
      expect(() => validateConfigValue('engine.syncEnabled', 'yes')).toThrow(ConfigValidationError);
      expect(() => validateConfigValue('engine.syncEnabled', 'true')).not.toThrow();
      expect(() => validateConfigValue('engine.syncEnabled', 'false')).not.toThrow();
    });

    it('rejects non-boolean engine.dbJobsSyncEnabled values', () => {
      expect(() => validateConfigValue('engine.dbJobsSyncEnabled', '1')).toThrow(ConfigValidationError);
      expect(() => validateConfigValue('engine.dbJobsSyncEnabled', 'false')).not.toThrow();
    });

    it('rejects non-boolean engine.punchSyncEnabled values', () => {
      expect(() => validateConfigValue('engine.punchSyncEnabled', 'yes')).toThrow(ConfigValidationError);
      expect(() => validateConfigValue('engine.punchSyncEnabled', 'true')).not.toThrow();
    });

    it('rejects invalid cron sync schedule', () => {
      expect(() => validateConfigValue('engine.cronSyncSchedule', 'not-a-cron')).toThrow(ConfigValidationError);
      expect(() => validateConfigValue('engine.cronSyncSchedule', '0 3 * * *')).not.toThrow();
    });

    it('rejects non-boolean infra.db2SslEnabled values', () => {
      expect(() => validateConfigValue('infra.db2SslEnabled', 'yes')).toThrow(ConfigValidationError);
      expect(() => validateConfigValue('infra.db2SslEnabled', 'true')).not.toThrow();
      expect(() => validateConfigValue('infra.db2SslEnabled', 'false')).not.toThrow();
    });
  });

  describe('clampConfigInt', () => {
    it('raises sub-minimum polling values to the floor', () => {
      expect(clampConfigInt('polling.punchRefreshMins', 1)).toBe(MIN_DB_POLLING_MINS);
    });

    it('caps concurrency values', () => {
      expect(clampConfigInt('engine.db2QueryConcurrency', 99)).toBe(MAX_DB2_QUERY_CONCURRENCY);
      expect(clampConfigInt('infra.db2PoolMax', 99)).toBe(MAX_DB2_POOL_MAX);
    });
  });
});
