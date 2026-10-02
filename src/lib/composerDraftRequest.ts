/** Text to append to a specific pane's composer, never to the terminal input. */
export interface ComposerDraftRequest {
  id: number;
  terminalId: string;
  text: string;
}
