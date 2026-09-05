import { parseDocument } from '../vendor/yaml.mjs';
import { canonicalJSON } from '../workflow-revisions.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.trim() && value.length <= 256;
// Optional metadata may be malformed without invalidating the primary Skill.
// Preserve the resource and an explicit Draft blocker instead of ignoring it.
export function readDependencyMetadata(snapshot) {
  const requirements = { tools: [], mcp_servers: [], executables: [], environment: [] };
  const unresolved = []; const declarations = [];
  const issue = (code, path, field) => unresolved.push({ code, path, field, origin: 'declared' });
  const sources = [{ path: 'source/SKILL.md', data: snapshot.metadata }];
  for (const path of ['source/agents/openai.yaml', 'source/SKILL.json']) {
    if (!snapshot.files[path]) continue;
    try {
      const text = snapshot.files[path].toString('utf8');
      if (path.endsWith('.json')) JSON.parse(text); // JSON file must actually be JSON.
      const document = parseDocument(text, { uniqueKeys: true, version: '1.2', customTags: [], prettyErrors: false });
      if (document.errors.length || document.warnings.length) throw new Error('Unsupported metadata');
      const data = document.toJS({ maxAliasCount: 20 }); canonicalJSON(data);
      if (!object(data)) throw new Error('Metadata is not an object');
      sources.push({ path, data });
    } catch { issue('INVALID_DEPENDENCY_METADATA', path, 'document'); }
  }
  for (const { path, data } of sources) {
    if (path !== 'source/SKILL.md') {
      const known = path.endsWith('.yaml') ? ['interface', 'dependencies', 'policy']
        : ['name', 'description', 'version', 'license', 'tags', 'interface', 'dependencies', 'requirements', 'policy'];
      for (const field of Object.keys(data)) if (!known.includes(field)) issue('METADATA_FIELD_REQUIRES_REVIEW', path, field);
    }
    if (data.requirements !== undefined) {
      if (!object(data.requirements)) issue('INVALID_DEPENDENCY_METADATA', path, 'requirements');
      else for (const [kind, values] of Object.entries(data.requirements)) {
        if (!Object.hasOwn(requirements, kind)) { issue('UNSUPPORTED_DECLARED_REQUIREMENT', path, 'requirements.' + kind); continue; }
        if (!Array.isArray(values) || values.length > 128 || values.some(value => !name(value) || kind === 'environment' && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(value))) {
          issue('INVALID_DEPENDENCY_METADATA', path, 'requirements.' + kind); continue;
        }
        requirements[kind].push(...values); declarations.push({ path, kind, names: values });
      }
    }
    if (data['allowed-tools'] !== undefined) {
      const values = Array.isArray(data['allowed-tools']) ? data['allowed-tools'] : typeof data['allowed-tools'] === 'string' ? data['allowed-tools'].split(/\s+/).filter(Boolean) : null;
      if (!values || values.length > 128 || values.some(value => !name(value))) issue('INVALID_DEPENDENCY_METADATA', path, 'allowed-tools');
      else { requirements.tools.push(...values); declarations.push({ path, kind: 'tools', names: values }); }
    }
    if (data.dependencies === undefined) continue;
    if (!object(data.dependencies)) { issue('INVALID_DEPENDENCY_METADATA', path, 'dependencies'); continue; }
    for (const field of Object.keys(data.dependencies)) if (field !== 'tools') issue('UNSUPPORTED_DECLARED_REQUIREMENT', path, 'dependencies.' + field);
    const tools = data.dependencies.tools ?? [];
    if (!Array.isArray(tools) || tools.length > 128) { issue('INVALID_DEPENDENCY_METADATA', path, 'dependencies.tools'); continue; }
    for (const [index, tool] of tools.entries()) {
      const field = 'dependencies.tools.' + index;
      if (!object(tool) || !name(tool.type) || !name(tool.value)) { issue('INVALID_DEPENDENCY_METADATA', path, field); continue; }
      if (tool.type !== 'mcp') { issue('UNSUPPORTED_DECLARED_TOOL', path, field); continue; }
      requirements.mcp_servers.push(tool.value); declarations.push({ path, kind: 'mcp_servers', names: [tool.value] });
      // Endpoint/command descriptors are requirements for an existing user-owned
      // connection. Import never registers, launches, or authenticates one.
      if (tool.command !== undefined || tool.url !== undefined || tool.transport !== undefined) issue('MCP_CONNECTION_REQUIRES_REVIEW', path, field);
      for (const extra of Object.keys(tool)) if (!['type', 'value', 'description', 'command', 'url', 'transport'].includes(extra)) issue('METADATA_FIELD_REQUIRES_REVIEW', path, field + '.' + extra);
    }
  }
  return { requirements, unresolved, declarations };
}
