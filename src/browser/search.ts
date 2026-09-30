export const BROWSER_SEARCH_ENGINES = [
  {
    id: 'google',
    label: 'Google',
    queryUrl: 'https://www.google.com/search?q=',
  },
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    queryUrl: 'https://duckduckgo.com/?q=',
  },
  { id: 'bing', label: 'Bing', queryUrl: 'https://www.bing.com/search?q=' },
  {
    id: 'brave',
    label: 'Brave',
    queryUrl: 'https://search.brave.com/search?q=',
  },
] as const;
export type BrowserSearchEngine = (typeof BROWSER_SEARCH_ENGINES)[number]['id'];
export const DEFAULT_BROWSER_SEARCH_ENGINE = BROWSER_SEARCH_ENGINES[0].id;

export function browserSearchUrl(
  query: string,
  engine: BrowserSearchEngine,
): string {
  const provider = BROWSER_SEARCH_ENGINES.find(item => item.id === engine);
  if (!provider) throw new Error('Invalid browser search engine');
  return provider.queryUrl + encodeURIComponent(query);
}
