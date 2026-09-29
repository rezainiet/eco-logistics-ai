// Types for the bootstrap entry (imported by the API test suite; importing never runs main()).
export declare const INSTALL_DIR: string;
export declare const TRUSTED_FILES: string[];
export declare const UNTRUSTED_TREES: string[];
export interface TrustStat {
  uid: number;
  mode: number;
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
}
export interface TrustFs {
  lstat(path: string): TrustStat;
  realpath(path: string): string;
}
export declare function trustProblems(fsi: TrustFs, opts: { invokedAs: string; installDir?: string }): string[];
export declare function main(argv?: string[], env?: Record<string, string | undefined>): Promise<void>;
export declare function isEntrypoint(argv1: unknown, modulePath: unknown, realpath?: (p: string) => string): boolean;
