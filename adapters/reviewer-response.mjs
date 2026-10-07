// Provider-neutral response boundary. Native schema-constrained generation is a
// dispatch capability; this adapter always validates the returned payload locally.
import { readFileSync } from 'node:fs';

export function reviewerResponseSchema(protocol = 1) {
  if (![1, 2].includes(protocol)) throw new Error('unsupported reviewer response protocol');
  return JSON.parse(readFileSync(new URL(`../skills/implement/reviewer-response${protocol === 2 ? '-v2' : ''}.schema.json`, import.meta.url), 'utf8'));
}

export function decodeReviewerResponse(payload, format = 'text', { candidate = false, protocol = 1 } = {}) {
  const schema = reviewerResponseSchema(protocol);
  let fields = schema.required;
  let value;
  if (format === 'json') {
    value = JSON.parse(payload);
    // JSON.parse alone silently keeps the last duplicate key, which could change
    // a verdict. Inspect string tokens before treating the object as unambiguous.
    const seen = new Set();
    for (let i = 0; i < payload.length; i++) {
      if (payload[i] !== '"') continue;
      const start = i++;
      while (i < payload.length && payload[i] !== '"') { if (payload[i] === '\\') i++; i++; }
      const end = i;
      let next = i + 1;
      while (/\s/.test(payload[next] ?? '') && next < payload.length) next++;
      if (payload[next] !== ':') continue;
      const key = JSON.parse(payload.slice(start, end + 1));
      if (seen.has(key)) throw new Error('duplicate reviewer response field');
      seen.add(key);
    }
  }
  else if (format === 'text') {
    const lines = payload.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    if (protocol === 2 && lines.length === 4) fields = ['status', 'artifact', 'changed-paths', 'signals'];
    if (lines.length !== fields.length || fields.some((field, i) => !lines[i].startsWith(`${field}: `))) throw new Error(protocol === 1 ? 'expected exactly four ordered fields' : 'expected ordered reviewer semantic fields');
    value = Object.fromEntries(fields.map((field, i) => [field, lines[i].slice(field.length + 2)]));
  } else throw new Error('unsupported reviewer response format');
  if (protocol === 2 && value && Object.hasOwn(value, 'changed-paths')) fields = ['status', 'artifact', 'changed-paths', 'signals'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw new Error('invalid reviewer response fields');
  for (const field of fields) {
    const rule = protocol === 2 && field === 'changed-paths' ? { type: 'string', minLength: 0 } : schema.properties[field];
    if (typeof value[field] !== 'string' || value[field].length < (rule.minLength ?? 1)) throw new Error(`invalid ${field}`);
    if (rule.enum && !rule.enum.includes(value[field])) throw new Error(`invalid ${field}`);
    // The engine may inspect an invalid changed-paths candidate to classify recovery.
    // This never declares that candidate a schema-valid response.
    if (Object.hasOwn(rule, 'const') && value[field] !== rule.const && !candidate) throw new Error(`${field} must be ${rule.const}`);
  }
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

export function serializeReviewerResponse(payload) {
  const value = decodeReviewerResponse(JSON.stringify(payload), 'json');
  return Object.entries(value).map(([field, text]) => `${field}: ${text}`).join('\n') + '\n';
}
