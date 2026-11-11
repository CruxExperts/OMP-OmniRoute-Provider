// Research-only wrapper, beside unchanged next.config.upstream.mjs.
// `next build --webpack` preserves plugin composition but differs from the
// production-default bundler; this fixture is not release qualification.
import upstream from './next.config.upstream.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const fixture = '/work/fixture';
const map = JSON.parse(readFileSync(resolve(fixture, 'alias-map.json'), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function inside(base, name) {
  if (typeof name !== 'string' || isAbsolute(name)) throw new Error('INGRESS_INVALID_ALIAS_PATH');
  const target = resolve(base, name);
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('INGRESS_INVALID_ALIAS_PATH');
  return target;
}
function checked(path, expected) {
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expected) throw new Error(`INGRESS_SOURCE_HASH_MISMATCH:${relative(root, path)}`);
  return bytes.toString('utf8');
}
checked(resolve(root, 'next.config.upstream.mjs'), map.originalConfigSha256);
if (!Array.isArray(map.aliases)) throw new Error('INGRESS_INVALID_ALIAS_MAP');
const replacements = new Map();
for (const alias of map.aliases) {
  const source = inside(root, alias.source);
  const replacement = inside(fixture, alias.replacement);
  if (replacements.has(source)) throw new Error('INGRESS_DUPLICATE_ALIAS');
  if (alias.kind === 'declaration-extraction') {
    const original = checked(source, alias.sourceSha256);
    const extracted = checked(replacement, alias.replacementSha256);
    // Every non-import top-level declaration must be a contiguous exact source
    // substring. The extraction hash also binds its intentionally adapted imports.
    const declarations = extracted.split('\n').filter(line => !line.startsWith('import ')).join('\n')
      .split(/(?=^(?:export |type |interface |const |let |function ))/m)
      .map(part => part.trim()).filter(Boolean);
    if (!declarations.length || declarations.some(part => !original.includes(part))) {
      throw new Error(`INGRESS_DECLARATION_MISMATCH:${alias.source}`);
    }
  } else if (alias.kind !== 'storage-boundary') {
    throw new Error('INGRESS_INVALID_ALIAS_KIND');
  }
  replacements.set(source, replacement);
}
if (!upstream || typeof upstream !== 'object' || typeof upstream.webpack !== 'function') {
  throw new Error('INGRESS_UPSTREAM_CONFIG_SHAPE');
}
const originalWebpack = upstream.webpack;
export default {
  ...upstream,
  webpack(config, context) {
    const configured = originalWebpack.call(upstream, config, context);
    if (!configured || !Array.isArray(configured.plugins) || !context.webpack?.NormalModuleReplacementPlugin) {
      throw new Error('INGRESS_WEBPACK_CONFIG_SHAPE');
    }
    // Only the resolved callback has an absolute resource; a pre-resolution
    // request cannot match. This also covers relative and @ alias imports.
    configured.plugins.push(new context.webpack.NormalModuleReplacementPlugin(/./, result => {
      const data = result.createData ?? result;
      if (!data || typeof data.resource !== 'string') return;
      const replacement = replacements.get(data.resource);
      if (replacement) data.resource = replacement;
    }));
    return configured;
  },
};
