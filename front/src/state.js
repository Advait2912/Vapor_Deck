/**
 * Application State
 */
export const state = {
  sessionId: null,
  outline: [],
  slides: [],
  slideErrors: {},      // { slideId: errorMessage }
  draftSlides: {},        // id → draft HTML
  latestSlides: {},       // id → latest HTML
  promptApplyingSlides: {}, // id → true/false
  generatingSlides: {},   // id → true/false
  // Vision audit state — stored separately from HTML strings so audit results
  // survive navigation and approval. Both are ID-keyed maps.
  slideAudits: {},    // id → VisionAuditResult object (persisted in localStorage)
  auditingSlides: {}, // id → jobToken (in-flight only, not persisted)
  currentIndex: 0,
  currentSlideHtml: '',
  status: 'IDLE', // IDLE | OUTLINING | GENERATING | REVIEWING | DONE
  phase: 'CONTENT', // CONTENT | DESIGN
  mode: 'plan', // plan | build  — global UI toggle
  messages: [],
  theme: 'dark-tech',
  model: 'ollama/gemma4:31b',
  visionModel: 'ollama/qwen3-vl:32b',
  projectPath: '',
  uploadedAssets: [],
  designConfig: {}, // { font_hints, color_palette, atmospheric_feel, etc. }
  isReorderMode: false, // UI toggle for drag-and-drop
};



/**
 * Update state and return new state
 * @param {Object} partialState 
 */
export function updateState(partialState) {
  Object.assign(state, partialState);
  return state;
}