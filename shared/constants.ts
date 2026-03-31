/**
 * Re-export barrel: domain-split constants live in `./constants/*.ts`.
 * WHY this file: Preserves `import … from '…/shared/constants.js'` resolution under TypeScript NodeNext.
 */
export * from './constants/index.js';
