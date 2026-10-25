import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const profile = 'C:\\Users\\asus\\.dsh\\profiles\\desktop';
const require = createRequire(path.join(profile, 'node_modules', 'noop.js'));
const YAML = require('yaml');

const pluginPatch = YAML.parse(fs.readFileSync('cordis.patch.yml', 'utf8'));
const inserted = (pluginPatch[0]?.insert ?? []).map((e) => e.id);
console.log('插件 patch 插入:', inserted.join(', '));

const profilePatchText = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8');
const profilePatch = YAML.parse(profilePatchText);
const flat = JSON.stringify(profilePatch);
console.log('profile patch 里出现 dsh-memory-curve 次数:', (flat.match(/dsh-memory-curve/g) || []).length);

const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
console.log('dep:', pkg.dependencies['dsh-memory-curve']);
console.log('bundle 已列:', pkg.dsh.profile.bundles.includes('dsh-memory-curve'));

const linkPath = path.join(profile, 'node_modules', 'dsh-memory-curve', 'package.json');
const linked = JSON.parse(fs.readFileSync(linkPath, 'utf8'));
console.log('junction 可读:', linked.name, linked.version, '| patch:', linked.dsh?.bundle?.patch);
const entryOk = fs.existsSync(path.resolve(path.dirname(linkPath), linked.dsh.bundle.patch));
console.log('bundle patch 存在:', entryOk);

// 浏览器半端（设置页那一栏）：清单、入口、文件三者都得在位，缺一个页面就不出现
const clientEntry = linked.exports?.['./client'];
console.log('exports["./client"]:', clientEntry || '（缺）');
console.log('dsh.client 声明:', linked.dsh?.client ? `platform=${linked.dsh.client.platform} inject=${(linked.dsh.client.inject || []).join(',')}` : '（缺）');
const clientFile = path.resolve(path.dirname(linkPath), clientEntry || 'client.js');
console.log('client.js 存在:', fs.existsSync(clientFile), clientFile);
if (fs.existsSync(clientFile)) {
  const text = fs.readFileSync(clientFile, 'utf8');
  console.log('client.js 自查: __ModuleLoader__', text.includes('__ModuleLoader__.load'), '| settings.section', text.includes("'settings.section'"));
}

console.log('cordis.yml:', fs.readFileSync(path.join(profile, 'cordis.yml'), 'utf8').trim().slice(0, 200));
