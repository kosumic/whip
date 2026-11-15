UI copy belongs in `src/locales/`. Use `useTranslation()` for labels,
placeholders, accessibility text, confirmation dialogs, and errors. Translate
complete sentences with interpolation rather than joining translated fragments.
Keep shared option metadata as translation keys and resolve it while rendering
so it follows the selected app language. Never display a raw internal error as
the only user-facing message.

Run `npm run check:localization` in `nix develop` before submitting UI changes.
CI runs this check for `App.tsx` and all `src/**/*.tsx` files, including new
screens. It parses TypeScript/JSX to find literal UI children, text properties,
simple local constants, and error/message setters. Calls and external data are
outside the static analysis; review those paths for translated output too.

`scripts/ui-localization-baseline.json` records existing untranslated copy by
file, exact text, and occurrence count. It permits incremental cleanup without
exempting entire files. New screens have no baseline entries. Remove entries as
their copy is translated; do not add entries for new user-facing text. Proper
names and symbols do not need translation.

`__tests__/i18n.test.ts` checks that all six catalogs have matching keys and
interpolation placeholders. Component tests should also exercise translated
labels, dynamic values, and error paths with a non-English language.
