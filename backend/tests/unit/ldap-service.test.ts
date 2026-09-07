jest.mock('../../src/utils/ldap-dev-mock', () => ({
  isLdapDevMockEnabled: jest.fn(() => false),
  buildLdapDevMockIdentity: jest.fn(),
}));

import { authenticateLdap, isLdapEnabled } from '../../src/services/ldap-service';
import { isLdapDevMockEnabled } from '../../src/utils/ldap-dev-mock';

const mockIsLdapDevMockEnabled = isLdapDevMockEnabled as jest.MockedFunction<typeof isLdapDevMockEnabled>;

const mockBind = jest.fn();
const mockSearch = jest.fn();
const mockUnbind = jest.fn();
const mockStartTLS = jest.fn();

jest.mock('ldapts', () => ({
  Client: jest.fn().mockImplementation(() => ({
    bind: mockBind,
    search: mockSearch,
    unbind: mockUnbind,
    startTLS: mockStartTLS,
  })),
}));

jest.mock('../../src/utils/logger', () => ({
  createServiceLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const config: Record<string, string> = {
  'infra.ldapEnabled': 'false',
  'infra.ldapUrl': '',
  'infra.ldapBaseDn': '',
  'infra.ldapBindDn': '',
  'infra.ldapBindPassword': '',
  'infra.ldapUserSearchBase': '',
  'infra.ldapUserFilter': '(uid={{username}})',
  'infra.ldapUserDnPattern': '',
  'infra.ldapDomain': '',
  'infra.ldapEmailAttribute': 'mail',
  'infra.ldapDisplayNameAttribute': 'displayName',
  'infra.ldapUseStartTls': 'false',
  'infra.ldapTlsRejectUnauthorized': 'true',
};

jest.mock('../../src/services/config-service', () => ({
  configService: {
    getBool: jest.fn((key: string, defaultVal = false) => {
      const v = config[key];
      if (v === undefined || v === '') return defaultVal;
      return v === 'true' || v === '1';
    }),
    getString: jest.fn((key: string, defaultVal = '') => config[key] ?? defaultVal),
    getInt: jest.fn((key: string, defaultVal = 0) => {
      const v = config[key];
      if (!v) return defaultVal;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : defaultVal;
    }),
  },
}));

describe('ldap-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsLdapDevMockEnabled.mockReturnValue(false);
    config['infra.ldapEnabled'] = 'false';
    config['infra.ldapUrl'] = '';
    config['infra.ldapBindDn'] = '';
    config['infra.ldapBaseDn'] = '';
    config['infra.ldapUserSearchBase'] = '';
    config['infra.ldapUserDnPattern'] = '';
    config['infra.ldapDomain'] = '';
    mockBind.mockResolvedValue(undefined);
    mockSearch.mockResolvedValue({ searchEntries: [] });
    mockUnbind.mockResolvedValue(undefined);
    mockStartTLS.mockResolvedValue(undefined);
  });

  it('isLdapEnabled is false when disabled', () => {
    expect(isLdapEnabled()).toBe(false);
  });

  it('isLdapEnabled is true when enabled with URL', () => {
    config['infra.ldapEnabled'] = 'true';
    config['infra.ldapUrl'] = 'ldap://test.example.com';
    expect(isLdapEnabled()).toBe(true);
  });

  it('isLdapEnabled is true when dev mock is active', () => {
    mockIsLdapDevMockEnabled.mockReturnValue(true);
    expect(isLdapEnabled()).toBe(true);
  });

  it('authenticates via dev mock without contacting LDAP', async () => {
    mockIsLdapDevMockEnabled.mockReturnValue(true);
    const { buildLdapDevMockIdentity } = require('../../src/utils/ldap-dev-mock');
    buildLdapDevMockIdentity.mockReturnValue({
      username: 'jdoe',
      email: 'jdoe@zebra.com',
      displayName: 'jdoe (dev mock)',
    });

    const result = await authenticateLdap('jdoe', 'anything');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.username).toBe('jdoe');
      expect(result.email).toBe('jdoe@zebra.com');
    }
    expect(mockBind).not.toHaveBeenCalled();
  });

  it('returns error when LDAP disabled', async () => {
    const result = await authenticateLdap('user1', 'pass');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not enabled/i);
  });

  it('authenticates via UPN bind when domain configured', async () => {
    config['infra.ldapEnabled'] = 'true';
    config['infra.ldapUrl'] = 'ldap://usc1.rfx.zebra.com:389';
    config['infra.ldapBindDn'] = '';
    config['infra.ldapBaseDn'] = '';
    config['infra.ldapDomain'] = 'zebra.com';

    const result = await authenticateLdap('jdoe', 'Secret1!');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.username).toBe('jdoe');
      expect(result.email).toBe('jdoe@zebra.com');
    }
    expect(mockBind).toHaveBeenCalledWith('jdoe@zebra.com', 'Secret1!');
  });

  it('authenticates via uid search+bind for FreeIPA-style config', async () => {
    config['infra.ldapEnabled'] = 'true';
    config['infra.ldapUrl'] = 'ldap://usc1.rfx.zebra.com:389';
    config['infra.ldapBindDn'] = 'uid=svc_wfmwatch,cn=users,cn=accounts,dc=rfx,dc=zebra,dc=com';
    config['infra.ldapBindPassword'] = 'svc-pass';
    config['infra.ldapBaseDn'] = 'dc=rfx,dc=zebra,dc=com';
    config['infra.ldapUserSearchBase'] = 'dc=rfx,dc=zebra,dc=com';
    config['infra.ldapUserFilter'] = '(uid={0})';
    config['infra.ldapDomain'] = '';

    mockSearch.mockResolvedValueOnce({
      searchEntries: [{
        dn: 'uid=jdoe,cn=users,cn=accounts,dc=rfx,dc=zebra,dc=com',
        uid: 'jdoe',
        mail: 'jdoe@zebra.com',
        cn: 'John Doe',
      }],
    });

    const result = await authenticateLdap('jdoe', 'Secret1!');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.username).toBe('jdoe');
      expect(result.email).toBe('jdoe@zebra.com');
      expect(result.displayName).toBe('John Doe');
    }
    expect(mockBind).toHaveBeenCalledWith(
      'uid=svc_wfmwatch,cn=users,cn=accounts,dc=rfx,dc=zebra,dc=com',
      'svc-pass',
    );
    expect(mockBind).toHaveBeenCalledWith(
      'uid=jdoe,cn=users,cn=accounts,dc=rfx,dc=zebra,dc=com',
      'Secret1!',
    );
  });

  it('authenticates via DN pattern when search is not configured', async () => {
    config['infra.ldapEnabled'] = 'true';
    config['infra.ldapUrl'] = 'ldap://usc1.rfx.zebra.com:389';
    config['infra.ldapBindDn'] = '';
    config['infra.ldapBaseDn'] = '';
    config['infra.ldapUserDnPattern'] = 'uid={0},cn=users,cn=accounts,dc=rfx,dc=zebra,dc=com';
    config['infra.ldapDomain'] = '';

    const result = await authenticateLdap('jdoe', 'Secret1!');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.username).toBe('jdoe');
    }
    expect(mockBind).toHaveBeenCalledWith(
      'uid=jdoe,cn=users,cn=accounts,dc=rfx,dc=zebra,dc=com',
      'Secret1!',
    );
  });

  it('authenticates via search+bind when service account configured', async () => {
    config['infra.ldapEnabled'] = 'true';
    config['infra.ldapUrl'] = 'ldap://usc1.rfx.zebra.com:389';
    config['infra.ldapBindDn'] = 'CN=svc,DC=rfx,DC=zebra,DC=com';
    config['infra.ldapBindPassword'] = 'svc-pass';
    config['infra.ldapBaseDn'] = 'DC=rfx,DC=zebra,DC=com';
    config['infra.ldapDomain'] = '';

    mockSearch.mockResolvedValueOnce({
      searchEntries: [{
        dn: 'CN=John Doe,OU=Users,DC=rfx,DC=zebra,DC=com',
        sAMAccountName: 'jdoe',
        mail: 'jdoe@zebra.com',
        displayName: 'John Doe',
      }],
    });

    const result = await authenticateLdap('jdoe', 'Secret1!');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.username).toBe('jdoe');
      expect(result.email).toBe('jdoe@zebra.com');
      expect(result.displayName).toBe('John Doe');
    }
    expect(mockBind).toHaveBeenCalledWith('CN=svc,DC=rfx,DC=zebra,DC=com', 'svc-pass');
    expect(mockBind).toHaveBeenCalledWith('CN=John Doe,OU=Users,DC=rfx,DC=zebra,DC=com', 'Secret1!');
  });
});
