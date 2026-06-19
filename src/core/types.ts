export interface DebControl {
  package: string;
  version: string;
  architecture: string;
  maintainer?: string;
  description?: string;
  depends?: string;
  'pre-depends'?: string;
  conflicts?: string;
  provides?: string;
  'installed-size'?: string;
  section?: string;
  priority?: string;
  homepage?: string;
  [key: string]: string | undefined;
}

export interface DebPackage {
  path: string;
  control: DebControl;
  controlTar: Buffer;
  dataTar: Buffer;
}

export interface InstalledPackage {
  name: string;
  version: string;
  architecture: string;
  description: string;
  depends?: string;
  'pre-depends'?: string;
  conflicts?: string;
  provides?: string;
  maintainer?: string;
  homepage?: string;
  controlSection?: string;
  controlPriority?: string;
  installedSize?: number;
  installTime: number;
  reason: 'explicit' | 'dependency';
  files: string[];
  repoType?: 'debian' | 'arch';
}

export interface RepoPkg {
  package: string;
  version: string;
  architecture: string;
  description?: string;
  depends?: string;
  conflicts?: string;
  provides?: string;
  filename: string;
  size?: number;
  installedSize?: number;
  sha256?: string;
  repo: string;
  repoType: 'debian' | 'arch';
}

export interface RepoConfig {
  name: string;
  type?: 'debian' | 'arch';
  server: string;
  dist?: string;
  components?: string[];
  dbFile?: string;
  architecture?: string;
}

export interface Config {
  architecture: string;
  color: boolean;
  repos: RepoConfig[];
}

export interface Database {
  packages: Map<string, InstalledPackage>;
  fileIndex: Map<string, string>;
}

export interface Transaction {
  id: string;
  timestamp: number;
  action: 'install' | 'remove';
  package: string;
  version: string;
  completed: boolean;
}
