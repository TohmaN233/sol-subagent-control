import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { digest } from '../../plugins/sol-advisor/control-plane/lib/workflow-revisions.mjs';

export const SOURCES = [
  'source-manifest.mjs',
  ...['codex-app-server-client', 'codex-profile-builder', 'codex-process-ownership', 'codex-session', 'codex-skill-policy', 'codex-tool-broker'].map(name => `../../plugins/sol-advisor/control-plane/lib/execution/${name}.mjs`),
  ...['workflow-revisions', 'workflow-paths', 'workflow-events', 'workflow-bindings'].map(name => `../../plugins/sol-advisor/control-plane/lib/${name}.mjs`),
  '../skill-isolation/create-temp-profile.mjs', '../skill-isolation/fixtures/allowed-skill/SKILL.md',
  '../skill-isolation/fixtures/conflicting-skill-a/SKILL.md', '../skill-isolation/fixtures/conflicting-skill-b/SKILL.md',
];
export const SYNTHETIC_PROMPT = 'Execute the synthetic Sol isolation fixture. If an allowed Skill is explicitly included, follow it. Otherwise read the permitted Skill with read_allowed_skill when available. If none is available, use WORKFLOW_ONLY. Output only the required marker.';
export async function sourceManifest() {
  return Object.fromEntries(await Promise.all(SOURCES.map(async path => [path, digest(await readFile(fileURLToPath(new URL(path, import.meta.url))))])));
}
