export const BROWSER_POPUP_CODE = 'unexpected_popup';
export const BROWSER_POPUP_MESSAGE =
  'Page JavaScript dialog is open; inspect the browser before continuing';

export function isBrowserPopup(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'browserCode' in error &&
    error.browserCode === BROWSER_POPUP_CODE
  );
}
