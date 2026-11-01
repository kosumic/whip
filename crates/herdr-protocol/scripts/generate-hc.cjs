#!/usr/bin/env node
// Maintainer tool: derive hc DTOs and RPC dispatch from the pinned OpenRPC contract.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const document = JSON.parse(fs.readFileSync(path.join(root, 'schema/hc.openrpc.json'), 'utf8'));
const definitions = new Map(Object.entries(document.components.schemas));
const keyword = new Set(['type', 'if', 'ref', 'match', 'loop', 'move', 'in', 'where', 'self', 'crate', 'mod', 'fn', 'use', 'enum', 'struct', 'impl', 'as', 'pub', 'async', 'await', 'const', 'dyn', 'static', 'super', 'trait', 'unsafe', 'return', 'default']);
const pascal = value => value.split(/[^A-Za-z0-9]+/).map(part => part[0].toUpperCase() + part.slice(1)).join('');
const rustName = value => keyword.has(value) ? `r#${value}` : value;
const methods = document.methods.map(method => {
  const name = pascal(method.name);
  const params = `${name}Params`;
  definitions.set(params, {type:'object', properties:Object.fromEntries(method.params.map(p => [p.name, p.schema])), required:method.params.filter(p => p.required).map(p => p.name)});
  let result;
  if (method.result.schema.$ref?.startsWith('#/components/schemas/')) result = method.result.schema.$ref.split('/').at(-1);
  else {
    result = `${name}Result`;
    definitions.set(result, method.result.schema);
  }
  return {method:method.name, name, params, result};
});
// The pinned server omits an empty ListResult.machines despite marking it
// required in OpenRPC (api/types.rs:297). Keep this narrow wire exception.
const omittedDefaults = new Set(['ListResult.machines']);
function nullable(schema) {
  return Array.isArray(schema.type) && schema.type.includes('null') || (schema.anyOf ?? schema.oneOf ?? []).some(s => s.type === 'null');
}
function type(schema) {
  if (schema.$ref) return schema.$ref.startsWith('#/components/schemas/') ? schema.$ref.split('/').at(-1) : 'Value';
  if (Array.isArray(schema.type)) {
    const nonnull = schema.type.filter(t => t !== 'null');
    if (nonnull.length === 1) return type({...schema, type:nonnull[0]});
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) {
    const nonnull = alternatives.filter(s => s.type !== 'null');
    if (nonnull.length === 1) return type(nonnull[0]);
    return 'Value';
  }
  switch (schema.type) {
    case 'string': return 'String';
    case 'boolean': return 'bool';
    case 'number': return 'f64';
    case 'integer': return ({uint8:'u8',uint16:'u16',uint32:'u32',uint64:'u64',int8:'i8',int16:'i16',int32:'i32',int64:'i64'})[schema.format] ?? (schema.minimum >= 0 ? 'u64' : 'i64');
    case 'array': {
      if (schema.minItems === schema.maxItems && Number.isInteger(schema.minItems) && schema.minItems <= 32) return `[${type(schema.items ?? {})}; ${schema.minItems}]`;
      if (schema.prefixItems) {
        const items = schema.prefixItems.map(type);
        if (items.every(item => item === items[0])) return `[${items[0]}; ${items.length}]`;
        return `(${items.join(', ')},)`;
      }
      return `Vec<${type(typeof schema.items === 'object' ? schema.items : {})}>`;
    }
    case 'object': return `BTreeMap<String, ${type(typeof schema.additionalProperties === 'object' ? schema.additionalProperties : {})}>`;
    default: return 'Value';
  }
}
let code = `//! Generated from schema/hc.openrpc.json. See UPSTREAM.md for source and license.\n//! Regenerate with: node scripts/generate-hc.cjs\n\nuse std::collections::BTreeMap;\nuse serde::{Deserialize, Serialize};\nuse serde_json::Value;\nuse super::Error;\n`;
for (const [name, schema] of definitions) {
  if (schema.type !== 'object' || !schema.properties) {
    // String-valued vocabularies deliberately retain future values; the server
    // only promises additive evolution within a generation.
    code += `\npub type ${name} = ${type(schema)};\n`;
    continue;
  }
  const params = name.endsWith('Params');
  code += `\n#[derive(Clone, Debug, PartialEq, Serialize, Deserialize${params ? ', Default' : ''})]\npub struct ${name} {\n`;
  for (const [field, property] of Object.entries(schema.properties)) {
    const optional = !schema.required?.includes(field);
    const value = nullable(property) || optional ? `Option<${type(property)}>` : type(property);
    if (optional) code += params ? '    #[serde(default, skip_serializing_if = "Option::is_none")]\n' : '    #[serde(default)]\n';
    else if (omittedDefaults.has(`${name}.${field}`)) code += '    #[serde(default)]\n';
    code += `    pub ${rustName(field)}: ${value},\n`;
  }
  // Preserve forward fields in replies, especially arbitrary status metadata.
  if (!params) code += '    #[serde(default, flatten)]\n    pub extra: BTreeMap<String, Value>,\n';
  code += '}\n';
}
code += '\n#[derive(Clone, Debug, PartialEq)]\npub enum Request {\n';
for (const method of methods) code += `    ${method.name}(Box<${method.params}>),\n`;
code += '}\n\n#[derive(Clone, Debug, PartialEq)]\npub enum Response {\n';
for (const method of methods) code += `    ${method.name}(Box<${method.result}>),\n`;
code += '}\n\nimpl Request {\n';
code += `    pub fn from_method_params(method: &str, value: Value) -> Result<Self, Error> { Ok(match method {\n${methods.map(m => `"${m.method}" => Self::${m.name}(Box::new(serde_json::from_value(value)?)),`).join('\n')}\n_ => return Err(Error::MissingMethod(method.into())),\n}) }\n`;
for (const method of methods) {
  code += `    pub fn ${method.method.replaceAll('.', '_')}(params: ${method.params}) -> Self { Self::${method.name}(Box::new(params)) }\n`;
}
code += `    pub fn method(&self) -> &'static str { match self {\n${methods.map(m => `Self::${m.name}(..) => "${m.method}",`).join('\n')}\n} }\n`;
code += `    pub fn params(&self) -> Result<Value, Error> { Ok(match self {\n${methods.map(m => `Self::${m.name}(p) => serde_json::to_value(p)?,`).join('\n')}\n}) }\n`;
code += `    pub fn decode(&self, value: Value) -> Result<Response, Error> { Ok(match self {\n${methods.map(m => `Self::${m.name}(..) => Response::${m.name}(Box::new(serde_json::from_value(value)?)),`).join('\n')}\n}) }\n`;
code += `    pub fn opens_channel(&self) -> bool { matches!(self, Self::TerminalAttach(..) | Self::EventsSubscribe(..)) }\n}\n`;
const resultGroups = new Map();
for (const method of methods) { if (!resultGroups.has(method.result)) resultGroups.set(method.result,[]); resultGroups.get(method.result).push(method.name); }
code += `impl Response {\n    pub fn as_value(&self) -> Result<Value, Error> { Ok(match self {\n${[...resultGroups.values()].map(names => names.map(name => `Self::${name}(v)`).join(" | ")+" => serde_json::to_value(v)?,").join('\n')}\n}) }\n`;
code += '    pub fn stream_channel(&self) -> Option<u32> { match self {\n';
for (const m of methods.filter(m => ['terminal.attach','events.subscribe'].includes(m.method))) {
  const schema = definitions.get(m.result);
  const optional = !schema.required?.includes('channel') || nullable(schema.properties.channel);
  code += `Self::${m.name}(v) => ${optional ? 'v.channel' : 'Some(v.channel)'},\n`;
}
code += '_ => None,\n} }\n}\n';
code += `pub const METHODS: &[&str] = &[${methods.map(m => JSON.stringify(m.method)).join(',')}];\n`;
const formatted = execFileSync('rustfmt', ['--edition','2024','--emit','stdout'], {input:code,encoding:'utf8',maxBuffer:8*1024*1024});
const output = path.join(root, 'src/hc/generated.rs');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(output,'utf8') !== formatted) throw new Error('hc models are stale; run node scripts/generate-hc.cjs');
  console.log(`Checked ${methods.length} schema-derived hc methods.`);
} else {
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,formatted);
  console.log(`Generated ${methods.length} hc methods and ${definitions.size} models.`);
}
