/**
 * OUTLINE UI — Re-export shim
 * ────────────────────────────
 * globalControl.js imports renderOutline from './outline.js'.
 * This shim re-exports it from the existing ui.js module.
 *
 * This avoids touching ui.js directly, keeping changes minimal.
 */
export { renderOutline } from '../ui.js';
