import fixtures from '../packages/react-native-whip-ssh/rust/test-fixtures/rich-text-html.json';

// Rust checks the same parser results against the original HTML conversion.
// Jest exercises Markdown code protection, math normalization and token restore.
export function convertRichTextHtml(input: string) {
  const fixture = fixtures.find(candidate => candidate.input === input);
  if (!fixture) throw new Error(`Missing native HTML fixture: ${input}`);
  const { content, fragmentPrefix, protectedFragments } = fixture;
  return { content, fragmentPrefix, protectedFragments };
}
