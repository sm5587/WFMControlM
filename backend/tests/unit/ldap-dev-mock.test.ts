import { isLdapDevMockEnabled, buildLdapDevMockIdentity } from '../../src/utils/ldap-dev-mock';

jest.mock('../../src/config', () => ({
  config: { nodeEnv: 'development', sso: { allowedDomain: 'zebra.com' } },
}));

const configValues: Record<string, string> = {
  'infra.ldapDomain': 'zebra.com',
  'infra.ldapDevMock': 'false',
};

jest.mock('../../src/services/config-service', () => ({
  configService: {
    getBool: jest.fn((key: string, defaultVal = false) => {
      const v = configValues[key];
      if (v === undefined || v === '') return defaultVal;
      return v === 'true' || v === '1';
    }),
    getString: jest.fn((key: string, defaultVal = '') => configValues[key] ?? defaultVal),
  },
}));

describe('ldap-dev-mock', () => {
  const originalEnv = process.env.LDAP_DEV_MOCK;

  afterEach(() => {
    process.env.LDAP_DEV_MOCK = originalEnv;
    configValues['infra.ldapDevMock'] = 'false';
  });

  it('is disabled in production even when env flag is set', () => {
    jest.resetModules();
    jest.doMock('../../src/config', () => ({
      config: { nodeEnv: 'production', sso: { allowedDomain: 'zebra.com' } },
    }));
    process.env.LDAP_DEV_MOCK = 'true';
    const { isLdapDevMockEnabled: prodCheck } = require('../../src/utils/ldap-dev-mock');
    expect(prodCheck()).toBe(false);
  });

  it('enables via LDAP_DEV_MOCK env var in development', () => {
    process.env.LDAP_DEV_MOCK = 'true';
    expect(isLdapDevMockEnabled()).toBe(true);
  });

  it('builds synthetic LDAP identity from username', () => {
    const identity = buildLdapDevMockIdentity('jdoe');
    expect(identity).toEqual({
      username: 'jdoe',
      email: 'jdoe@zebra.com',
      displayName: 'jdoe (dev mock)',
    });
  });
});
