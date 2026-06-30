import { firebaseConfig } from './shared/firebaseConfig.js';
import * as dateUtils from './shared/dateUtils.js';
import * as domUtils from './shared/domUtils.js';
import { createStorageService } from './shared/storageService.js';
import * as youtubeService from './shared/youtubeService.js';
import * as plannerEngine from './shared/plannerEngine.js';

window.SP_FIREBASE_CONFIG ||= firebaseConfig;

window.StudyPlannerModules = Object.freeze({
  firebaseConfig,
  dateUtils,
  domUtils,
  createStorageService,
  youtubeService,
  plannerEngine
});

window.dispatchEvent(new CustomEvent('studyplanner:modules-ready', {
  detail: window.StudyPlannerModules
}));
