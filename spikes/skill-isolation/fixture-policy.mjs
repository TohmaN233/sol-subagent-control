import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { skillPathKey } from './assertions.mjs';

// For the live probe only: no general filesystem, images, network tools or agents.
// Skill contents returned by the test tool are preloaded synthetic fixtures.
export const FIXTURE_CONFIG = `approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
[features]
shell_tool = false
unified_exec = false
remote_plugin = false
skill_mcp_dependency_install = false
skill_search = false
[agents]
enabled = false
`;

// Public synthetic metadata; never read or copy the user's model/credential cache.
// Kept deliberately compatible with the locally tested 0.145.0 protocol.
export function fixtureCatalog(slug) {
  return { models: [{
    slug, display_name: 'Synthetic isolation probe', description: 'Fixture-only test',
    default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Probe' }],
    shell_type: 'disabled', visibility: 'list', supported_in_api: true, priority: 0,
    base_instructions: FIXTURE_INSTRUCTIONS, supports_parallel_tool_calls: false,
    support_verbosity: false, truncation_policy: { mode: 'tokens', limit: 10000 },
    experimental_supported_tools: [], input_modalities: ['text'],
    supports_image_detail_original: false, use_responses_lite: false,
    tool_mode: 'direct', node_repl_disabled: true,
    context_window: 32000,
  }] };
}

export const FIXTURE_INSTRUCTIONS = 'You are running a synthetic Skill isolation test. Follow the available Skill instructions when relevant. To load a matching Skill, use read_probe_skill. It can read only the synthetic fixtures supplied by this test. If no matching Skill exists, output WORKFLOW_ONLY. Never request any other data or tools.';

export const FIXTURE_READ_TOOL = {
  type: 'function', name: 'read_probe_skill',
  description: 'Read one of the synthetic Skill fixtures shown in the available Skill catalog. No other file or data can be returned.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
};

export async function createFixturePolicy(workspace, profile) {
  const paths = [workspace.repoSkill, profile.userSkill, profile.allowedSkill];
  const contents = new Map();
  for (const path of paths) contents.set(skillPathKey(path), await readFile(path, 'utf8'));
  let allowed = new Set();
  let allowedPaths = [];
  return {
    paths,
    setAllowed(next) {
      for (const path of next) assert(contents.has(skillPathKey(path)), 'Only synthetic fixtures may be allowed');
      allowed = new Set(next.map(skillPathKey));
      allowedPaths = [...next];
    },
    tools() {
      if (!allowedPaths.length) return [];
      return [{ ...FIXTURE_READ_TOOL, inputSchema: {
        ...FIXTURE_READ_TOOL.inputSchema,
        properties: { path: { type: 'string', enum: [...allowedPaths] } },
      } }];
    },
    assertInventory(skills) {
      const enabled = skills.filter(skill => skill.enabled).map(skill => skillPathKey(skill.path)).sort();
      assert.deepEqual(enabled, [...allowed].sort(), 'Non-fixture or unexpected enabled Skill: abort before model request');
    },
    read(args) {
      assert(args && Object.keys(args).length === 1 && typeof args.path === 'string', 'Invalid fixture read');
      const key = skillPathKey(args.path);
      assert(allowed.has(key), 'Fixture not permitted for this turn');
      // Never read a model-supplied filesystem path; return only preloaded fixture text.
      return { success: true, contentItems: [{ type: 'inputText', text: contents.get(key) }] };
    },
  };
}

export function assertFixtureThread(start) {
  assert.deepEqual(start.instructionSources, [], 'Additional instruction sources: abort before model request');
}

export function assertFixtureRequest(body) {
  assert.equal(body.instructions, FIXTURE_INSTRUCTIONS, 'Unexpected base instructions');
  const permitted = new Set(['read_probe_skill', 'update_plan', 'request_user_input']);
  for (const tool of body.tools) {
    if (tool.type === 'namespace' && tool.name === 'skills') {
      assert.deepEqual(tool.tools.map(entry => [entry.type, entry.name]), [['function', 'list'], ['function', 'read']], 'Unknown Skill access tool');
      continue;
    }
    assert.equal(tool.type, 'function', 'Uncontrolled non-function tool');
    assert(permitted.has(tool.name), `Uncontrolled tool: ${tool.name}`);
  }
}
