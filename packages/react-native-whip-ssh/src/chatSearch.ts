import { ChatSearchIndex } from './generated-entry';
export type { ChatSearchDocument, ChatSearchMatch, ChatSearchResults } from './generated-entry';

/** Matching, result bounds and selection belong to the Rust index. */
export class NativeChatSearchIndex {
  private readonly index = new ChatSearchIndex();
  setDocuments(documents: Parameters<ChatSearchIndex['setDocuments']>[0]): void {
    this.index.setDocuments(documents);
  }
  search(query: string) { return this.index.search(query); }
  navigate(backwards: boolean) { return this.index.navigate(backwards); }
  select(index: number) { return this.index.select(index); }
  dispose(): void { this.index.uniffiDestroy(); }
}
