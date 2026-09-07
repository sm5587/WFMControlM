import {
  applyLdapDnPattern,
  applyLdapUsernameTemplate,
  normalizeLdapUsernamePlaceholder,
} from '../../src/utils/ldap-templates';

describe('ldap-templates', () => {
  it('normalizes {0} to {{username}}', () => {
    expect(normalizeLdapUsernamePlaceholder('(uid={0})')).toBe('(uid={{username}})');
  });

  it('applies username to filter with escaping', () => {
    expect(applyLdapUsernameTemplate('(uid={{username}})', 'sm5587')).toBe('(uid=sm5587)');
    expect(applyLdapUsernameTemplate('(uid={0})', 'sm5587')).toBe('(uid=sm5587)');
  });

  it('applies username to DN pattern without filter escaping', () => {
    expect(
      applyLdapDnPattern(
        'uid={{username}},cn=users,cn=accounts,dc=rfx,dc=zebra,dc=com',
        'sm5587',
      ),
    ).toBe('uid=sm5587,cn=users,cn=accounts,dc=rfx,dc=zebra,dc=com');
  });
});
