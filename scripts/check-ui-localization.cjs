/* eslint-env es2020 */
// Inspect UI syntax rather than searching source text: identifiers, styles,
// translation keys, URLs, and diagnostic strings are not UI copy.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const translationKeys = new Set(Object.keys(require('../src/locales/en.ts').en));

const root = path.resolve(__dirname, '..');
const baselinePath = path.join(__dirname, 'ui-localization-baseline.json');
const textProps = new Set([
  'accessibilityLabel', 'accessibilityHint', 'placeholder', 'title', 'subtitle',
  'label', 'copy', 'confirmLabel', 'cancelLabel', 'emptyText', 'message',
]);
// Proper names have the same spelling in every locale.
const properNames = new Set(['Whip', 'OpenAI', 'GitHub', 'Google', 'DuckDuckGo', 'Bing', 'Brave']);

function untranslatedUiStrings(filename, source) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = new Map();
  const declarations = new Map();
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const values = declarations.get(node.name.text) || [];
      values.push(node.initializer);
      declarations.set(node.name.text, values);
    }
    ts.forEachChild(node, collect);
  }
  collect(file);

  function report(node, text) {
    const value = text.replace(/\s+/g, ' ').trim();
    if (!/\p{L}/u.test(value) || properNames.has(value)) return;
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    findings.set(node.pos, { text: value, line: line + 1, column: character + 1 });
  }

  // Follow simple constants as well as inline conditional/template copy.
  // Calls (including t()) and external data remain outside this static check.
  function inspect(expression, seen = new Set(), stored = false) {
    if (ts.isStringLiteralLike(expression)) {
      if (!stored || !translationKeys.has(expression.text)) report(expression, expression.text);
    } else if (ts.isTemplateExpression(expression)) {
      report(expression, expression.head.text + expression.templateSpans.map(span => '${…}' + span.literal.text).join(''));
    } else if (ts.isConditionalExpression(expression)) {
      inspect(expression.whenTrue, seen, stored);
      inspect(expression.whenFalse, seen, stored);
    } else if (ts.isBinaryExpression(expression)) {
      if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) inspect(expression.left, seen, stored);
      inspect(expression.right, seen, stored);
    } else if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
      inspect(expression.expression, seen, stored);
    } else if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
      const initializers = declarations.get(expression.text);
      // A unique local declaration can be resolved without confusing scopes.
      if (initializers?.length === 1) {
        const next = new Set(seen).add(expression.text);
        inspect(initializers[0], next, stored);
      }
    }
  }

  function visit(node) {
    if (ts.isJsxText(node)) report(node, node.text);
    if (ts.isJsxExpression(node) && node.expression &&
        (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      inspect(node.expression);
    }
    if (ts.isJsxAttribute(node) && textProps.has(node.name.getText(file)) && node.initializer) {
      if (ts.isJsxExpression(node.initializer)) {
        if (node.initializer.expression) inspect(node.initializer.expression);
      } else {
        inspect(node.initializer);
      }
    }
    if (ts.isPropertyAssignment(node) && textProps.has(node.name.getText(file))) {
      inspect(node.initializer);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        ['setError', 'setMessage'].includes(node.expression.text) && node.arguments[0]) {
      inspect(node.arguments[0], new Set(), true);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return [...findings.values()].sort((a, b) => a.line - b.line || a.column - b.column);
}

function uiFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.')) return [];
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return uiFiles(filename);
    return filename.endsWith('.tsx') ? [filename] : [];
  });
}

function check() {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  let failures = 0;
  for (const filename of [path.join(root, 'App.tsx'), ...uiFiles(path.join(root, 'src'))]) {
    const relative = path.relative(root, filename).split(path.sep).join('/');
    // Entries cover existing debt by exact text and occurrence count. New files
    // have no exemptions; adding a duplicate hardcoded label also fails.
    const allowed = [...(baseline[relative] || [])];
    for (const finding of untranslatedUiStrings(relative, fs.readFileSync(filename, 'utf8'))) {
      const index = allowed.indexOf(finding.text);
      if (index >= 0) {
        allowed.splice(index, 1);
        continue;
      }
      console.error(`${relative}:${finding.line}:${finding.column}: Translate user-facing text: ${JSON.stringify(finding.text)}`);
      failures++;
    }
  }
  if (failures) process.exitCode = 1;
  else console.log('UI localization check passed.');
}

module.exports = { untranslatedUiStrings };
if (require.main === module) check();
