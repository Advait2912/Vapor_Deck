/**
 * Application State
 */
export const state = {
  sessionId: null,
  outline: [],
  slides: [],
  draftSlides: {},
  latestSlides: {},
  promptApplyingSlides: {},
  generatingSlides: {},
  // Vision audit state — stored separately from HTML strings so audit results
  // survive navigation and approval. Both are index-keyed maps.
  slideAudits: {},    // index → VisionAuditResult object (persisted in localStorage)
  auditingSlides: {}, // index → jobToken (in-flight only, not persisted)
  currentIndex: 0,
  currentSlideHtml: '',
  status: 'IDLE', // IDLE | OUTLINING | GENERATING | REVIEWING | DONE
  phase: 'CONTENT', // CONTENT | DESIGN
  mode: 'plan', // plan | build  — global UI toggle
  messages: [],
  theme: 'dark-tech',
  model: 'ollama/gemma4:31b-cloud',
  visionModel: 'ollama/ministral-3:14b-cloud',
  projectPath: '',
  uploadedAssets: [],
  isReorderMode: false, // UI toggle for drag-and-drop
  // Export snapshots — frozen HTML+CSS captured at approval time, keyed by slide index.
  // This is the single source of truth for PDF export.
  exportSnapshots: {},
};



/**
 * Update state and return new state
 * @param {Object} partialState 
 */
export function updateState(partialState) {
  Object.assign(state, partialState);
  return state;
}