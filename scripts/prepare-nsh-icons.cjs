// Reuse the installed Lucide shapes without importing its React components
// into the NSH bundle. This runs only during asset preparation.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const icons = ['info', 'external-link', 'share-2', 'chevron-up', 'chevron-down', 'chevron-right', 'refresh-cw', 'download', 'scale'];
const output = path.resolve(__dirname, '../packages/whip-nsh/assets/icons');
fs.mkdirSync(output, { recursive: true });
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
for (const name of icons) {
  const filename = require.resolve(`lucide-react-native/icons/${name}`);
  const exports = {};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports,
    require: dependency => {
      if (dependency !== '../createLucideIcon.js') throw new Error(`Unexpected Lucide dependency: ${dependency}`);
      return (data, nodes) => typeof data === 'string' ? { name: data, node: nodes } : data;
    },
  }, { filename });
  const data = exports.__iconData || exports.default;
  if (!data || !Array.isArray(data.node)) throw new Error(`Missing Lucide shapes for ${name}`);
  const shapes = data.node.map(([tag, attributes]) => {
    const values = Object.entries(attributes).filter(([key]) => key !== 'key')
      .map(([key, value]) => `${key}="${escape(value)}"`).join(' ');
    return `<${tag} ${values}/>`;
  }).join('');
  fs.writeFileSync(path.join(output, `${name}.svg`),
    `<!-- Lucide, ISC license; see assets/licenses/lucide-ISC-and-Feather-MIT.txt. -->\n<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>\n`);
}
