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
  mode: 'plan', // plan | build  — global UI toggle
  slidePhases: {}, // per-slide: 'plan' | 'build'  — once set to 'build', never goes back
  messages: [],
  theme: 'dark-tech',
  model: 'ollama/gemma4:31b-cloud',
  projectPath: '',
  uploadedAssets: []
};

/**
 * Get the phase for a specific slide index.
 * Defaults to 'plan' until building has started.
 */
export function getSlidePhase(index) {
  return state.slidePhases[index] || 'plan';
}

/**
 * Mark a slide as entered build phase. This is irreversible per slide.
 */
export function lockSlideIntoBuild(index) {
  state.slidePhases[index] = 'build';
}

/**
 * Check if a slide can still be planned (never been built).
 */
export function canPlanSlide(index) {
  return (state.slidePhases[index] || 'plan') === 'plan';
}

/**
 * Check if the current global mode is allowed for the given slide.
 * - In 'plan' mode: only allowed if slide hasn't been built yet
 * - In 'build' mode: always allowed
 */
export function isModeAllowedForSlide(mode, index) {
  if (mode === 'build') return true;
  if (mode === 'plan') return canPlanSlide(index);
  return false;
}

/**
 * Update state and return new state
 * @param {Object} partialState 
 */
export function updateState(partialState) {
  Object.assign(state, partialState);
  return state;
}