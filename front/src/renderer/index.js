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
  appendStreamToken as streamToken,
  finalizeStream as finalizeSlide,
  clearStreamBuffer,
  renderPlaceholderInIframe as mountPlaceholder,
  buildSlideDocument,
  validateSlideHtml,
  _stripMarkdownFences as stripFences,
} from './iframe.js';
