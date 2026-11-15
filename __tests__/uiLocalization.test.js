const { untranslatedUiStrings } = require('../scripts/check-ui-localization.cjs');

const copy = source => untranslatedUiStrings('NewScreen.tsx', source).map(finding => finding.text);

test('rejects literal labels, accessibility copy, placeholders, templates, and conditional UI copy', () => {
  expect(copy(`
    <View>
      <Text>New feature</Text>
      <Input accessibilityLabel="Account name" placeholder={'Name'} />
      <Button accessibilityHint={\`Open \${name}\`} />
      <Text>{empty ? 'No results' : 'Results'}</Text>
    </View>
  `)).toEqual(['New feature', 'Account name', 'Name', 'Open ${…}', 'No results', 'Results']);
});

test('checks constants used as UI copy and messages stored by error handlers', () => {
  expect(copy(`
    const heading = 'My heading';
    const unrelated = 'Internal diagnostic';
    const options = [{ label: 'First choice' }];
    function fail() { setError('Could not save.'); }
    <Text>{heading}</Text>;
  `)).toEqual(['My heading', 'First choice', 'Could not save.']);
});

test('allows translations, data, symbols, brands, styles, and diagnostics', () => {
  expect(copy(`
    const heading = t('settings.title');
    console.warn('Internal diagnostic');
    setError('browser.saveShortcutFailed');
    setMessage(t('browser.saveSettingFailed'));
    <View className="flex-1" accessibilityRole="button">
      <Text>{heading}</Text><Text>{site.title}</Text>
      <Text>Whip</Text><Text>×</Text><Text>{count}</Text>
      <Input placeholder={t('browser.name')} />
    </View>
  `)).toEqual([]);
});

test('does not exempt untranslated text just because it resembles a translation key', () => {
  expect(copy(`<Text>{'settings.title'}</Text>`)).toEqual(['settings.title']);
});
