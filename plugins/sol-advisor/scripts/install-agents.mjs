#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const templateDir = resolve(scriptDir, '..', 'agents');

const roles = {
  luna: {
    label: 'Luna',
    file: 'sol-advisor-luna-implementer.toml',
    legacyDigests: new Set([
      'fba1b42849d93737e83b094a2ab0b1611f87ac37db7438c8bbdf581f0813f8eb',
      '5cfaf77f14757074ca5d3cfecd0b8204c91dc14eff8d6119985c64416ddf4853',
    ]),
  },
  terra: {
    label: 'Terra',
    file: 'sol-advisor-terra-implementer.toml',
    legacyDigests: new Set([
      '4425a8c1f21ce8c6af93f96adc253bbc33ea301f1389b3fa8ce350be08584eca',
      'dc329fe87f6f6610c13157ec16432f91c79cf5a541ee3e7448f6afb165dd18ce',
    ]),
  },
  sol: {
    label: 'Sol',
    file: 'sol-advisor-sol-reviewer.toml',
    legacyDigests: new Set(),
  },
};

function usage() {
  process.stdout.write(`Usage: install-agents.mjs [--target-dir PATH] [--check] [--check-role ROLE ...]\n\nInstall Sol Advisor's three current custom-agent templates into the target directory.\nNormal mode migrates only exact byte-matching historical templates. It never\noverwrites a modified, nonregular, or symlinked destination.\n\nWithout --target-dir, the target is CODEX_HOME/agents when CODEX_HOME is set,\notherwise the platform Codex home under the current user's home directory.\n\nOptions:\n  --target-dir PATH  Explicit destination directory.\n  --check            Verify all three roles without mutation.\n  --check-role ROLE  Verify only luna, terra, or sol; repeatable.\n  --help             Show this help text.\n`);
}

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = 1;
}

function fatal(message) {
  throw new Error(message);
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function classify(destination, template, legacyDigests) {
  const stat = lstatOrNull(destination);
  if (!stat) return 'missing';
  if (stat.isSymbolicLink() || !stat.isFile()) return 'unsafe';

  try {
    const expected = readFileSync(template);
    const actual = readFileSync(destination);
    if (expected.equals(actual)) return 'current';
    return legacyDigests.has(sha256(actual)) ? 'legacy' : 'conflict';
  } catch {
    return 'unreadable';
  }
}

function parseArguments(argv) {
  let targetDir = process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, 'agents')
    : join(homedir(), '.codex', 'agents');
  let checkOnly = false;
  const checkRoles = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--target-dir') {
      const value = argv[index + 1];
      if (!value) fatal('--target-dir requires a non-empty path.');
      if (value.startsWith('--')) {
        fatal('--target-dir path must be explicit; prefix an option-like relative name with ./ or use an absolute path.');
      }
      targetDir = value;
      index += 1;
    } else if (argument === '--check') {
      checkOnly = true;
    } else if (argument === '--check-role') {
      const role = argv[index + 1];
      if (!role) fatal('--check-role requires a role: luna, terra, or sol.');
      if (!roles[role]) fatal(`unknown --check-role '${role}'; expected luna, terra, or sol.`);
      checkOnly = true;
      checkRoles.add(role);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      return { help: true };
    } else {
      fatal(`unknown argument: ${argument} (run with --help for usage).`);
    }
  }

  const absoluteTarget = isAbsolute(targetDir) ? resolve(targetDir) : resolve(process.cwd(), targetDir);
  if (absoluteTarget === parse(absoluteTarget).root) {
    fatal('refusing to use the filesystem root as an agent target directory.');
  }
  return { help: false, targetDir: absoluteTarget, checkOnly, checkRoles };
}

function roleEntries(targetDir) {
  return Object.entries(roles).map(([id, role]) => ({
    id,
    ...role,
    template: join(templateDir, role.file),
    destination: join(targetDir, role.file),
  }));
}

function validateTemplates(entries) {
  for (const entry of entries) {
    const stat = lstatOrNull(entry.template);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      fatal(`shipped template is missing or not a regular file: ${entry.template}`);
    }
  }
}

function preflightTargetDirectory(targetDir) {
  const stat = lstatOrNull(targetDir);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    fatal(`target directory is not a real directory: ${targetDir}`);
  }
}

function temporaryPath(targetDir) {
  return join(targetDir, `.sol-advisor-agent.${randomUUID()}.tmp`);
}

function installMissing(entry, targetDir) {
  if (lstatOrNull(entry.destination)) {
    fatal(`destination changed after preflight and will not be overwritten: ${entry.destination}`);
  }
  copyFileSync(entry.template, entry.destination, constants.COPYFILE_EXCL);
  process.stdout.write(`INSTALLED: ${entry.destination}\n`);
}

function replaceLegacy(entry, targetDir) {
  if (classify(entry.destination, entry.template, entry.legacyDigests) !== 'legacy') {
    fatal(`legacy ${entry.label} destination changed after preflight and will not be replaced: ${entry.destination}`);
  }

  const staged = temporaryPath(targetDir);
  try {
    copyFileSync(entry.template, staged, constants.COPYFILE_EXCL);
    if (classify(entry.destination, entry.template, entry.legacyDigests) !== 'legacy') {
      fatal(`legacy ${entry.label} destination changed after preflight and will not be replaced: ${entry.destination}`);
    }
    if (process.platform === 'win32') {
      copyFileSync(staged, entry.destination);
      rmSync(staged, { force: true });
    } else {
      renameSync(staged, entry.destination);
    }
  } finally {
    rmSync(staged, { force: true });
  }
  process.stdout.write(`MIGRATED: ${entry.destination}\n`);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const entries = roleEntries(options.targetDir);
  validateTemplates(entries);
  preflightTargetDirectory(options.targetDir);

  const initialStates = new Map(entries.map((entry) => [
    entry.id,
    classify(entry.destination, entry.template, entry.legacyDigests),
  ]));
  const errors = [];

  if (options.checkOnly) {
    for (const entry of entries) {
      if (options.checkRoles.size > 0 && !options.checkRoles.has(entry.id)) continue;
      const state = initialStates.get(entry.id);
      if (state !== 'current') {
        errors.push(`${entry.label} template is ${state}, not the current exact file: ${entry.destination}`);
      }
    }
  } else {
    for (const entry of entries) {
      const state = initialStates.get(entry.id);
      const allowed = entry.id === 'sol'
        ? new Set(['current', 'missing'])
        : new Set(['current', 'legacy', 'missing']);
      if (!allowed.has(state)) {
        errors.push(`${entry.label} destination is ${state} and will not be replaced: ${entry.destination}`);
      }
    }
  }

  if (errors.length > 0) {
    for (const error of errors) fail(error);
    return;
  }

  if (options.checkOnly) {
    const label = options.checkRoles.size > 0
      ? 'selected role templates'
      : 'Luna, Terra, and Sol';
    process.stdout.write(`CHECK PASSED: ${label} exactly match ${templateDir}.\n`);
    return;
  }

  mkdirSync(options.targetDir, { recursive: true });
  preflightTargetDirectory(options.targetDir);

  for (const entry of entries) {
    const currentState = classify(entry.destination, entry.template, entry.legacyDigests);
    const initialState = initialStates.get(entry.id);
    if (currentState !== initialState) {
      fatal(`${entry.label} changed after preflight; no further destination files were changed.`);
    }
  }

  for (const entry of entries) {
    const state = initialStates.get(entry.id);
    if (state === 'missing') installMissing(entry, options.targetDir);
    else if (state === 'legacy') replaceLegacy(entry, options.targetDir);
    else process.stdout.write(`ALREADY CURRENT: ${entry.destination}\n`);
  }

  for (const entry of entries) {
    if (classify(entry.destination, entry.template, entry.legacyDigests) !== 'current') {
      fatal(`post-install exactness check failed: ${entry.destination}`);
    }
  }
  process.stdout.write(`INSTALL PASSED: Luna, Terra, and Sol exactly match ${templateDir}.\n`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
