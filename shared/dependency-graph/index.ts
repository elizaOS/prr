export {
  detectDepScanLang,
  extractImports,
  type DepScanLang,
} from './import-scanner.js';
export { resolveSpecifier, type LangContext } from './specifier-resolver.js';
export {
  getDirectoryNeighbors,
  getFilenamePatternMatches,
  DEFAULT_MAX_DIR_NEIGHBORS,
} from './proximity.js';
export {
  type FileDepGraph,
  type BuildDependencyGraphOptions,
  buildDependencyGraph,
  computeBlastRadius,
  isInBlastRadius,
  listGitTrackedFiles,
  isBlastRadiusDisabled,
  getBlastRadiusDepth,
  getBlastRadiusMaxFiles,
  getBlastRadiusTimeoutMs,
  isBlastRadiusDismissEnabled,
} from './graph.js';
