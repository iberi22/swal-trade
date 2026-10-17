import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';

/**
 * Reads versions from the 4 specified paths.
 * @param {string} root The repository root
 * @returns {Record<string, string>} A map of paths to their version strings
 */
export function readVersions(root) {
  const versions = {};

  const readVersion = (filePath, regex) => {
    try {
      const content = fs.readFileSync(path.join(root, filePath), 'utf8');
      const match = content.match(regex);
      if (match && match[1]) {
        versions[filePath] = match[1];
      } else {
        versions[filePath] = 'NOT_FOUND';
      }
    } catch (err) {
      versions[filePath] = 'FILE_ERROR';
    }
  };

  readVersion('packages/mcp/package.json', /"version"\s*:\s*"([^"]+)"/);
  readVersion('apps/extension/package.json', /"version"\s*:\s*"([^"]+)"/);
  readVersion('apps/extension/wxt.config.ts', /version\s*:\s*'([^']+)'/);
  readVersion('crates/synapse-core/Cargo.toml', /version\s*=\s*"([^"]+)"/);

  return versions;
}

/**
 * Checks licenses in the specified paths.
 * @param {string} root The repository root
 * @returns {Record<string, string>} A map of paths to their license strings
 */
export function checkLicenses(root) {
  const licenses = {};

  const readLicense = (filePath, regex) => {
    try {
      const content = fs.readFileSync(path.join(root, filePath), 'utf8');
      const match = content.match(regex);
      if (match && match[1]) {
        licenses[filePath] = match[1];
      } else {
        licenses[filePath] = 'NOT_FOUND';
      }
    } catch (err) {
      licenses[filePath] = 'FILE_ERROR';
    }
  };

  readLicense('packages/mcp/package.json', /"license"\s*:\s*"([^"]+)"/);
  readLicense('crates/synapse-core/Cargo.toml', /license\s*=\s*"([^"]+)"/);
  readLicense('apps/extension/package.json', /"license"\s*:\s*"([^"]+)"/);

  try {
    const rootLicenseContent = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
    if (rootLicenseContent.includes('GNU AFFERO GENERAL PUBLIC LICENSE') && rootLicenseContent.includes('Version 3')) {
      licenses['LICENSE'] = 'AGPL-3.0';
    } else {
      licenses['LICENSE'] = 'UNKNOWN';
    }
  } catch (err) {
    licenses['LICENSE'] = 'FILE_ERROR';
  }

  return licenses;
}

/**
 * Checks if the changelog contains the specified version.
 * @param {string} text The changelog text
 * @param {string} v The version to check
 * @returns {boolean} True if the section is found, false otherwise
 */
export function hasChangelogSection(text, v) {
  const regex = new RegExp(`^## \\[${v}\\]`, 'm');
  return regex.test(text);
}

function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        version: { type: 'string' },
        'allow-dirty': { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    console.error('Usage: node release-check.mjs --version X.Y.Z [--allow-dirty]');
    process.exit(2);
  }

  if (!args.values.version) {
    console.error('Usage: node release-check.mjs --version X.Y.Z [--allow-dirty]');
    process.exit(2);
  }

  const targetVersion = args.values.version;
  const allowDirty = args.values['allow-dirty'];
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

  let failed = false;
  const logError = (msg) => {
    console.error(`ERROR: ${msg}`);
    failed = true;
  };

  // 1. Check Versions
  const versions = readVersions(root);
  for (const [file, ver] of Object.entries(versions)) {
    if (ver !== targetVersion) {
      logError(`Version mismatch in ${file}: expected ${targetVersion}, found ${ver}`);
    }
  }

  // 2. Check Licenses
  const licenses = checkLicenses(root);
  for (const [file, lic] of Object.entries(licenses)) {
    if (file === 'LICENSE') {
      if (lic !== 'AGPL-3.0') {
        logError(`Root license mismatch: expected AGPL-3.0, found ${lic}`);
      }
    } else {
      if (lic !== 'AGPL-3.0-only') {
        logError(`License mismatch in ${file}: expected AGPL-3.0-only, found ${lic}`);
      }
    }
  }

  // 3. Check Changelog
  try {
    const changelogText = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    if (!hasChangelogSection(changelogText, targetVersion)) {
      logError(`Changelog missing section for version ${targetVersion}`);
    }
  } catch (err) {
    logError(`Could not read CHANGELOG.md`);
  }

  // 4. Check Git Status
  if (!allowDirty) {
    try {
      const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' });
      if (status.trim() !== '') {
        logError(`Git tree is not clean. Use --allow-dirty to ignore.`);
      }
    } catch (err) {
      logError(`Failed to check git status.`);
    }
  }

  // 5. Check Tag Existence
  try {
    const tags = execSync('git tag --list', { cwd: root, encoding: 'utf8' }).split('\n').map(t => t.trim());
    if (tags.includes(`v${targetVersion}`)) {
      logError(`Tag v${targetVersion} already exists.`);
    }
  } catch (err) {
    logError(`Failed to check existing git tags.`);
  }

  if (failed) {
    process.exit(1);
  } else {
    console.log('PASS');
  }
}

if (process.argv[1] && process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}
