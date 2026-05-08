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
  currentIndex: 0,
  currentSlideHtml: '',
  status: 'IDLE', // IDLE | OUTLINING | GENERATING | REVIEWING | DONE
  phase: 'CONTENT', // CONTENT | DESIGN
  theme: 'dark-tech',
  model: 'ollama/gemma4:31b-cloud',
  projectPath: '',
  uploadedAssets: []
};

/**
 * Update state and return new state
 * @param {Object} partialState 
 */
export function updateState(partialState) {
  Object.assign(state, partialState);
  return state;
}
