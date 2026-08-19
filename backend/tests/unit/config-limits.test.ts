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
