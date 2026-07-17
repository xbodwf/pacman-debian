import type { RepoPkg } from './types';

export interface InstallOptions {
  needed?: boolean;
  noscriptlet?: boolean;
  asdeps?: boolean;
  print?: boolean;
  allowFiles?: boolean;
  repo?: string; // source repository name
  confirmed?: boolean; // transaction was already shown and confirmed by caller
  skipSummary?: boolean; // caller already rendered the transaction summary
  noProgressBar?: boolean;
  skipDependencyResolution?: boolean;
  preparedPackages?: RepoPkg[];
  takeoverConfirmed?: boolean;
}

export interface RemoveOptions {
  recursive?: boolean;
  noscriptlet?: boolean;
  cascade?: boolean;
  nodeps?: boolean;
  nosave?: boolean;
  print?: boolean;
}

export interface DbOptions {
  asdeps?: boolean;
  asexplicit?: boolean;
}
