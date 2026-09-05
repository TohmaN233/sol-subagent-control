import { isAbsolute } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { requireValue, noSymlinks } from '../workflow-paths.mjs';
import { digest } from '../workflow-revisions.mjs';

export const QUALIFIED_CODEX = Object.freeze({ platform: 'win32', architecture: 'x64', version: '0.145.0',
  sha256: '83751f15cb6a0a7b97df67752c001e3fe1c20e18ffbfec3ff63567296205eb6c',
  boundary: 'catalog-and-explicit-input', live_model: 'gpt-5.6-sol', live_effort: 'low' });

function keys(value, allowed, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)), 'STRICT_CONFIG', `${label} contains unknown fields`);
}
export function validateStrictConfig(raw = {}) {
  keys(raw, ['enabled', 'codex_binary', 'binary_sha256', 'authentication', 'main_model', 'main_reasoning_effort'], 'Strict executor');
  const auth = raw.authentication ?? {}; keys(auth, ['mode', 'api_key_env'], 'Strict authentication');
  const result = { enabled: raw.enabled ?? false, codex_binary: raw.codex_binary ?? '', binary_sha256: raw.binary_sha256 ?? '',
    authentication: { mode: auth.mode ?? 'managed_chatgpt', api_key_env: auth.api_key_env ?? '' },
    main_model: raw.main_model ?? 'gpt-5.6-sol', main_reasoning_effort: raw.main_reasoning_effort ?? 'high' };
  requireValue(typeof result.enabled === 'boolean' && typeof result.codex_binary === 'string' && result.codex_binary.length <= 4096 &&
    (!result.codex_binary || isAbsolute(result.codex_binary)) && typeof result.binary_sha256 === 'string' &&
    (!result.binary_sha256 || /^[a-f0-9]{64}$/.test(result.binary_sha256)), 'STRICT_CONFIG', 'Strict executor needs an absolute executable and its SHA-256');
  requireValue(['managed_chatgpt', 'environment_api_key'].includes(result.authentication.mode) && typeof result.authentication.api_key_env === 'string' &&
    (!result.authentication.api_key_env || /^[A-Z_][A-Z0-9_]{0,127}$/.test(result.authentication.api_key_env)), 'STRICT_CONFIG', 'Authentication stores only a supported mode and environment variable name');
  requireValue(['gpt-5.6-sol', 'gpt-5.6-terra'].includes(result.main_model) && ['high', 'xhigh', 'max'].includes(result.main_reasoning_effort), 'STRICT_CONFIG', 'Main finalizer retains the Sol/Terra high, xhigh or max policy');
  requireValue(!result.enabled || result.codex_binary && result.binary_sha256 && (result.authentication.mode !== 'environment_api_key' || result.authentication.api_key_env), 'STRICT_CONFIG', 'Enabled Strict executor requires complete binary and authentication settings');
  return result;
}

export async function qualifiedCodexBinary(settings) {
  requireValue(process.platform === QUALIFIED_CODEX.platform && process.arch === QUALIFIED_CODEX.architecture && settings.binary_sha256 === QUALIFIED_CODEX.sha256,
    'STRICT_EXECUTOR_UNQUALIFIED', 'This platform/executable has no shipped Strict qualification');
  await noSymlinks(settings.codex_binary); const stat = await lstat(settings.codex_binary);
  requireValue(stat.isFile() && stat.size <= 512 * 1024 * 1024 && digest(await readFile(settings.codex_binary)) === settings.binary_sha256, 'CODEX_BINARY_CHANGED', 'Executable differs from its qualified content hash');
  return settings;
}

export async function qualifiedStrictSettings(config, env = process.env) {
  const settings = validateStrictConfig(config.strict_executor);
  requireValue(settings.enabled, 'STRICT_DISABLED', 'The user has not enabled the isolated executor');
  await qualifiedCodexBinary(settings);
  requireValue(settings.authentication.mode !== 'environment_api_key' || Boolean(env[settings.authentication.api_key_env]), 'CODEX_CREDENTIAL_MISSING', 'Configured authentication environment variable is unavailable');
  return settings;
}
