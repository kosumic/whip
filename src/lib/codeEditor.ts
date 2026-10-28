export const CODE_EDITOR_ACTIONS = [
  'undo', 'redo', 'find', 'goToLine', 'complete', 'indent', 'outdent', 'comment',
  'wrap', 'foldAll', 'unfoldAll', 'selectAll', 'selectNext', 'splitSelection',
  'singleSelection', 'moveUp', 'moveDown', 'duplicateLine', 'deleteLine',
] as const;
export type CodeEditorAction = typeof CODE_EDITOR_ACTIONS[number];
export interface CodeEditorOptions {
  filename: string;
  readOnly: boolean;
  dark: boolean;
  fontSize: number;
  labels: Record<string, string>;
  phrases: Record<string, string>;
  colors: Record<string, string>;
}
export interface CodeEditorDocument extends CodeEditorOptions {
  content: string;
  requestId: number;
}
