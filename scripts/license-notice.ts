export interface LicenseNotice {
  category: 'npm' | 'cargo';
  licenseName: string;
  licenseText: string;
  name: string;
  sourceUrl: string;
  usedBy?: string[];
  version: string;
}

export function commandErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    for (const field of ['stderr', 'stdout'] as const) {
      if (field in error) {
        const output: unknown = Reflect.get(error, field);
        if (typeof output === 'string' && output.trim()) return output.trim();
      }
    }
    return error.message;
  }
  return String(error);
}
