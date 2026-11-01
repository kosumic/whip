import {
  appGlassControlStyle,
  colorWithAlpha,
  darkColors,
  githubLightPalette,
  lightColors,
  resolveTheme,
  sessionTabGlassStyle,
  sessionTabStatusColor,
  statusColor,
  terminalColors,
  tokyoNightPalette,
} from '../src/theme';

describe('application theme', () => {
  test('resolves light and dark system themes', () => {
    expect(resolveTheme('light')).toBe(lightColors);
    expect(resolveTheme('dark')).toBe(darkColors);
    expect(resolveTheme(null)).toBe(darkColors);
  });

  test('uses GitHub Light for light controls and semantic statuses', () => {
    expect(lightColors.canvas).toBe('#FFFFFF');
    expect(lightColors.surface).toBe('#F6F8FA');
    expect(lightColors.text).toBe('#24292F');
    expect(lightColors.primary).toBe('#0969DA');
    expect(lightColors.working).toBe(githubLightPalette.green);
    expect(lightColors.blocked).toBe(githubLightPalette.red);
  });

  test('uses Tokyo Night for dark controls and the terminal', () => {
    expect(darkColors.canvas).toBe('#1A1B26');
    expect(darkColors.primary).toBe('#7AA2F7');
    expect(darkColors.text).toBe('#C0CAF5');
    expect(terminalColors.canvas).toBe(tokyoNightPalette.background);
    expect(terminalColors.accent).toBe(tokyoNightPalette.blue);
    expect(statusColor('blocked', lightColors)).toBe(lightColors.blocked);
    expect(statusColor('working', darkColors)).toBe(darkColors.working);
    expect(statusColor('unexpected', lightColors)).toBe(lightColors.unknown);
  });

  test('colors idle tab checks by connection state without hiding active agent status', () => {
    for (const palette of [lightColors, darkColors]) {
      expect(sessionTabStatusColor('idle', 'connected', palette)).toBe(palette.done);
      expect(sessionTabStatusColor('idle', 'connecting', palette)).toBe(palette.warning);
      expect(sessionTabStatusColor('idle', 'disconnected', palette)).toBe(palette.idle);
      expect(sessionTabStatusColor('idle', 'error', palette)).toBe(palette.blocked);
      expect(sessionTabStatusColor('idle', undefined, palette)).toBe(palette.idle);

      expect(sessionTabStatusColor('blocked', 'connected', palette)).toBe(palette.blocked);
      expect(sessionTabStatusColor('working', 'connected', palette)).toBe(palette.working);
      expect(sessionTabStatusColor('done', 'connected', palette)).toBe(palette.done);
      expect(sessionTabStatusColor('working', 'error', palette)).toBe(palette.blocked);
      expect(sessionTabStatusColor('working', 'disconnected', palette)).toBe(palette.idle);
    }
  });

  test('keeps terminal tab glass translucent without fading its contents', () => {
    expect(sessionTabGlassStyle(false, darkColors)).toEqual({
      backgroundColor: `${darkColors.surface}B8`,
      borderColor: `${darkColors.text}29`,
    });
    expect(sessionTabGlassStyle(true, darkColors)).toEqual({
      backgroundColor: `${darkColors.primary}D6`,
      borderColor: `${darkColors.onPrimary}47`,
    });
  });

  test('keeps app glass controls transparent', () => {
    expect(appGlassControlStyle(false, darkColors)).toEqual({
      backgroundColor: 'transparent',
      borderColor: `${darkColors.text}47`,
    });
    expect(appGlassControlStyle(true, darkColors)).toEqual({
      backgroundColor: 'transparent',
      borderColor: `${darkColors.primary}D6`,
    });
  });

  test('adds alpha only to six-digit hex colors', () => {
    expect(colorWithAlpha('#7AA2F7', '80')).toBe('#7AA2F780');
    expect(colorWithAlpha('rgb(122, 162, 247)', '80')).toBe('rgb(122, 162, 247)');
  });
});
