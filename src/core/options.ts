export interface InstallOptions {
  needed?: boolean;
  noscriptlet?: boolean;
  asdeps?: boolean;
  print?: boolean;
  allowFiles?: boolean;
  repo?: string; // source repository name
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
