/**
 * RENDERER — Public API
 * ──────────────────────
 * Re-exports the iframe renderer with a clean API.
 *
 * Usage:
 *   import { mountSlide, streamToken, finalizeSlide } from '../renderer/index.js';
 */

export {
  renderSlideInIframe as mountSlide,
  renderPlaceholderInIframe as mountPlaceholder,
  buildBaseDocument,
  ensureFontsInDocument,
  validateSlideHtml,
  _stripMarkdownFences as stripFences,
} from './iframe.js';
