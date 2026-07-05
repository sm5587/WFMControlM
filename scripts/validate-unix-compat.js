#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_APP_DIR = '/application/wfmwatch';
const DISALLOWED_APP_DIR = '/opt/wfm-controlm';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function fail(errors, msg) {
  errors.push(msg);
}

function checkPackageScripts(errors) {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = readJson(pkgPath);
  const scripts = pkg.scripts || {};

  const unixCriticalScripts = ['db:deploy', 'db:bootstrap:ddl', 'db:bootstrap:dml', 'db:bootstrap:clients', 'preflight:unix'];
  for (const name of unixCriticalScripts) {
    const value = scripts[name];
    if (!value) {
      fail(errors, `Missing package script: ${name}`);
      continue;
    }
    if (value.includes('\\')) {
      fail(errors, `Windows path separator found in package script '${name}': ${value}`);
    }
  }
}

function checkFileContains(filePath, needle, shouldContain, errors) {
  const content = readText(filePath);
  const hasNeedle = content.includes(needle);
  if (shouldContain && !hasNeedle) {
    fail(errors, `${path.relative(ROOT, filePath)} must contain '${needle}'`);
  }
  if (!shouldContain && hasNeedle) {
    fail(errors, `${path.relative(ROOT, filePath)} must not contain '${needle}'`);
  }
}

function checkShellLineEndings(errors) {
  const scriptsDir = path.join(ROOT, 'scripts');
  const shellScripts = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.sh')) {
        shellScripts.push(full);
      }
    }
  }

  walk(scriptsDir);

  for (const f of shellScripts) {
    const content = readText(f);
    if (content.includes('\r')) {
      fail(errors, `${path.relative(ROOT, f)} must use LF line endings (CRLF breaks bash); fix: sed -i 's/\\r$//' "${path.relative(ROOT, f)}"`);
    }
  }
}

function checkEnvLineEndings(errors) {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = readText(envPath);
  if (content.includes('\r')) {
    fail(errors, '.env contains CRLF line endings; fix with: sed -i "s/\\r$//" .env');
  }
}

function main() {
  const errors = [];
  const docFiles = [
    path.join(ROOT, 'docs', 'DEPLOYMENT_UNIX.md'),
    path.join(ROOT, 'docs', 'DEPLOYMENT_UNIX_v2.md'),
  ];
  const scriptFiles = [
    path.join(ROOT, 'scripts', 'preflight-unix.sh'),
    path.join(ROOT, 'scripts', 'deploy-unix.sh'),
    path.join(ROOT, 'scripts', 'setup-db.sh'),
    path.join(ROOT, 'scripts', 'start-app-unix.sh'),
    path.join(ROOT, 'scripts', 'start-frontend-unix.sh'),
    path.join(ROOT, 'scripts', 'create-db.sh'),
  ];

  checkFileContains(path.join(ROOT, '.env.example'), 'APP_DIR=', true, errors);
  checkFileContains(path.join(ROOT, 'scripts', 'lib', 'dotenv.sh'), 'resolve_app_dir', true, errors);

  for (const rel of ['database/clients-dml.sql', 'database/fix-client-datetimes.sql']) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f)) {
      fail(errors, `Missing required file: ${rel}`);
    }
  }

  for (const f of docFiles) {
    if (!fs.existsSync(f)) {
      fail(errors, `Missing required file: ${path.relative(ROOT, f)}`);
      continue;
    }
    checkFileContains(f, DISALLOWED_APP_DIR, false, errors);
    checkFileContains(f, EXPECTED_APP_DIR, true, errors);
  }

  for (const f of scriptFiles) {
    if (!fs.existsSync(f)) {
      fail(errors, `Missing required file: ${path.relative(ROOT, f)}`);
      continue;
    }
    checkFileContains(f, DISALLOWED_APP_DIR, false, errors);
    checkFileContains(f, 'resolve_app_dir', true, errors);
  }

  checkPackageScripts(errors);
  checkShellLineEndings(errors);
  checkEnvLineEndings(errors);

  if (errors.length > 0) {
    console.error('[validate-unix-compat] FAILED');
    for (const e of errors) console.error(` - ${e}`);
    process.exit(1);
  }

  console.log('[validate-unix-compat] OK');
}

main();
