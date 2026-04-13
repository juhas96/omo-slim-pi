export interface PantheonScaffoldOptions {
  tmuxEnabled?: boolean;
  skillsEnabled?: boolean;
}

export interface PantheonScaffoldEntry {
  relativePath: string;
  content: string;
}

export function buildPantheonScaffoldConfig(options?: PantheonScaffoldOptions): string;
export function getPantheonScaffoldEntries(options?: PantheonScaffoldOptions): PantheonScaffoldEntry[];
export function getPantheonScaffoldRequiredPaths(): string[];
