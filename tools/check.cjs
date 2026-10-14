const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.name, 'Human Typer');
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, '1.5.0');
assert.ok(manifest.permissions.includes('debugger'));
assert.ok(!manifest.optional_permissions?.includes('debugger'));
assert.ok(!manifest.host_permissions?.length);
const runtime = ['background.js','content.js','google-apps.js','typing-behavior.js','sidepanel.js'];
for (const file of runtime) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  new vm.Script(source, { filename: file });
  assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/.test(source), 'Unexpected runtime network access: ' + file);
}
const panel = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8');
assert.ok(panel.includes('v' + manifest.version));
assert.ok(!panel.includes('maxlength='));
const ids = new Set(Array.from(panel.matchAll(/\bid="([^"]+)"/g), m => m[1]));
assert.equal(ids.size, Array.from(panel.matchAll(/\bid="([^"]+)"/g)).length);
const binding = fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8').split('].map((id)')[0];
for (const match of binding.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)) {
  if (match[1] !== manifest.version) assert.ok(ids.has(match[1]), 'Missing panel element: ' + match[1]);
}
const references = [manifest.background.service_worker,manifest.side_panel.default_path,...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),...Array.from(panel.matchAll(/(?:src|href)="([^"#]+)"/g),m=>m[1])];
for (const file of references) assert.ok(fs.existsSync(path.join(root, file)), 'Missing extension asset: '+file);
console.log('PASS manifest, permissions, script syntax, panel bindings and local asset references');
for (const file of ['background.cjs','content.cjs','panel.cjs','behavior.cjs']) {
  const result = spawnSync(process.execPath, [path.join(root, 'tests', file)], { encoding:'utf8' });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('All release checks passed. Browser fixtures: node tests/serve.cjs');
