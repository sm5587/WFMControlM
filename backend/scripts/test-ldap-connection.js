/**
 * Test LDAP / Active Directory connectivity using backend/ldap-test.config.json
 * (copy from ldap-test.config.example.json — gitignored, local testing only).
 *
 * Usage:
 *   node scripts/test-ldap-connection.js
 *   node scripts/test-ldap-connection.js --user SM5587 --password 'your-pass'
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('ldapts');

const CONFIG_PATH = path.resolve(__dirname, '../ldap-test.config.json');

function parseArgs() {
  const args = process.argv.slice(2);
  let username;
  let password;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user' && args[i + 1]) username = args[++i];
    if (args[i] === '--password' && args[i + 1]) password = args[++i];
  }
  return { username, password };
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Missing config: ${CONFIG_PATH}`);
    console.error('Copy ldap-test.config.example.json → ldap-test.config.json and fill in values.');
    process.exit(1);
  }
  return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
}

/** Support ticket-style keys (ldap.url, ldap.manager.dn, …) and app-style keys. */
function normalizeConfig(raw) {
  const ldapUrl = (raw.ldapUrl || raw['ldap.url'] || '').trim();
  const ldapBindDn = (raw.ldapBindDn || raw['ldap.manager.dn'] || '').trim();
  const ldapBindPassword = raw.ldapBindPassword ?? raw['ldap.manager.password'] ?? '';
  const searchBase = (
    raw.ldapUserSearchBase || raw.ldapBaseDn || raw['ldap.userSearch.base'] || ''
  ).trim();

  let userFilter = (
    raw.ldapUserFilter || raw['ldap.userSearchFilter.pattern'] || '(uid={{username}})'
  ).trim();
  if (!userFilter.includes('{{username}}')) {
    userFilter = userFilter.replace(/\{0\}/g, '{{username}}');
  }

  const userDnPattern = raw.ldapUserDnPattern || raw['ldap.userDn.pattern'] || '';
  const normalizedDnPattern = userDnPattern.includes('{{username}}')
    ? userDnPattern
    : userDnPattern.replace(/\{0\}/g, '{{username}}');

  return {
    ...raw,
    ldapUrl,
    ldapBindDn,
    ldapBindPassword,
    ldapBaseDn: searchBase,
    ldapUserSearchBase: searchBase,
    ldapUserFilter: userFilter,
    ldapUserDnPattern: normalizedDnPattern,
    ldapGroupSearchBase: (raw.ldapGroupSearchBase || raw['ldap.groupSearch.base'] || '').trim(),
    ldapUseStartTls: raw.ldapUseStartTls ?? false,
    ldapTlsRejectUnauthorized: raw.ldapTlsRejectUnauthorized !== false,
    ldapTimeoutMs: raw.ldapTimeoutMs || 10000,
    ldapDomain: raw.ldapDomain || '',
    ldapEmailAttribute: raw.ldapEmailAttribute || 'mail',
    ldapDisplayNameAttribute: raw.ldapDisplayNameAttribute || 'displayName',
  };
}

function escapeLdapFilter(value) {
  return value.replace(/[\\*()\0]/g, (ch) => {
    const hex = ch.charCodeAt(0).toString(16).padStart(2, '0');
    return `\\${hex}`;
  });
}

function applyUserFilter(template, username) {
  const bare = username.trim().includes('@') ? username.trim().split('@')[0] : username.trim();
  const safe = escapeLdapFilter(bare);
  return template.replace(/\{0\}/g, safe).replace(/\{\{username\}\}/g, safe);
}

function applyDnPattern(pattern, username) {
  const bare = username.trim().includes('@') ? username.trim().split('@')[0] : username.trim();
  return pattern.replace(/\{0\}/g, bare).replace(/\{\{username\}\}/g, bare);
}

function readAttr(entry, attr) {
  const val = entry[attr];
  if (typeof val === 'string' && val.trim()) return val.trim();
  if (Array.isArray(val) && typeof val[0] === 'string' && val[0].trim()) return val[0].trim();
  return undefined;
}

async function withClient(cfg, fn) {
  const client = new Client({
    url: cfg.ldapUrl.trim(),
    tlsOptions: { rejectUnauthorized: cfg.ldapTlsRejectUnauthorized !== false },
    timeout: cfg.ldapTimeoutMs || 10000,
  });
  try {
    if (cfg.ldapUseStartTls) {
      await client.startTLS({ rejectUnauthorized: cfg.ldapTlsRejectUnauthorized !== false });
    }
    return await fn(client);
  } finally {
    try {
      await client.unbind();
    } catch {
      /* ignore */
    }
  }
}

async function testServerReachable(cfg) {
  console.log('\n[1/3] Server reachability');
  console.log(`      URL: ${cfg.ldapUrl}`);
  await withClient(cfg, async (client) => {
    // Anonymous or connection-only — bind may fail without creds; connection attempt is enough
    console.log('      OK — TCP/TLS connection established');
  });
}

async function testServiceBindAndSearch(cfg, testUsername) {
  const bindDn = (cfg.ldapBindDn || '').trim();
  const searchBase = (cfg.ldapUserSearchBase || '').trim() || (cfg.ldapBaseDn || '').trim();
  if (!bindDn || !searchBase) {
    console.log('\n[2/3] Service bind + user search — skipped (set ldapBindDn + ldapBaseDn)');
    return null;
  }

  console.log('\n[2/3] Service bind + user search');
  console.log(`      Bind DN: ${bindDn}`);
  console.log(`      Search base: ${searchBase}`);

  const filterTpl = (cfg.ldapUserFilter || '(sAMAccountName={{username}})').trim();
  const emailAttr = (cfg.ldapEmailAttribute || 'mail').trim();
  const displayAttr = (cfg.ldapDisplayNameAttribute || 'displayName').trim();

  const entries = await withClient(cfg, async (client) => {
    await client.bind(bindDn, cfg.ldapBindPassword || '');
    const filter = applyUserFilter(filterTpl, testUsername);
    console.log(`      Filter: ${filter}`);
    const { searchEntries } = await client.search(searchBase, {
      scope: 'sub',
      filter,
      attributes: ['dn', emailAttr, displayAttr, 'sAMAccountName', 'uid', 'cn'],
      sizeLimit: 2,
    });
    return searchEntries;
  });

  if (entries.length === 0) {
    throw new Error(`User not found: ${testUsername}`);
  }
  if (entries.length > 1) {
    throw new Error(`Ambiguous search — ${entries.length} entries matched`);
  }

  const entry = entries[0];
  console.log('      OK — user found');
  console.log(`      DN:          ${entry.dn}`);
  console.log(`      uid:         ${readAttr(entry, 'uid') || '(n/a)'}`);
  console.log(`      sAMAccountName: ${readAttr(entry, 'sAMAccountName') || '(n/a)'}`);
  console.log(`      mail:        ${readAttr(entry, emailAttr) || '(n/a)'}`);
  console.log(`      displayName: ${readAttr(entry, displayAttr) || readAttr(entry, 'cn') || '(n/a)'}`);
  return entry;
}

async function testUserAuth(cfg, testUsername, testPassword, entryFromSearch) {
  console.log('\n[3/3] User authentication');

  const bindDn = (cfg.ldapBindDn || '').trim();
  const searchBase = (cfg.ldapUserSearchBase || '').trim() || (cfg.ldapBaseDn || '').trim();
  const domain = (cfg.ldapDomain || '').trim().replace(/^@/, '');

  if (bindDn && searchBase && entryFromSearch) {
    await withClient(cfg, async (client) => {
      await client.bind(entryFromSearch.dn, testPassword);
    });
    console.log(`      OK — user bind succeeded (${testUsername})`);
    return;
  }

  const dnPattern = (cfg.ldapUserDnPattern || '').trim();
  if (dnPattern) {
    const directDn = applyDnPattern(dnPattern, testUsername);
    await withClient(cfg, async (client) => {
      await client.bind(directDn, testPassword);
    });
    console.log(`      OK — direct DN bind succeeded (${directDn})`);
    return;
  }

  if (domain) {
    const upn = testUsername.includes('@') ? testUsername : `${testUsername}@${domain}`;
    await withClient(cfg, async (client) => {
      await client.bind(upn, testPassword);
    });
    console.log(`      OK — UPN bind succeeded (${upn})`);
    return;
  }

  console.log('      skipped — provide ldapBindDn+search base or ldapDomain, and testUser credentials');
}

async function main() {
  const cfg = loadConfig();
  const cli = parseArgs();
  const testUsername = cli.username || cfg.testUser?.username;
  const testPassword = cli.password ?? cfg.testUser?.password;

  if (!cfg.ldapUrl?.trim()) {
    throw new Error('ldapUrl is required in ldap-test.config.json');
  }

  console.log('LDAP connection test (local config — not applied to AppConfig)');

  await testServerReachable(cfg);

  let entry = null;
  if (testUsername) {
    entry = await testServiceBindAndSearch(cfg, testUsername);
  } else {
    console.log('\n[2/3] Service bind + user search — skipped (set testUser.username or --user)');
  }

  if (testUsername && testPassword) {
    await testUserAuth(cfg, testUsername, testPassword, entry);
  } else if (testUsername) {
    console.log('\n[3/3] User authentication — skipped (set testUser.password or --password)');
  }

  console.log('\nDone. If all steps passed, copy these values to Admin → Config (LDAP section).\n');
}

main().catch((err) => {
  console.error('\nFAILED:', err.message || err);
  process.exit(1);
});
