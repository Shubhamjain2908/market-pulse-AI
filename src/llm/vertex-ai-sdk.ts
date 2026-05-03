/**
 * Re-export Vertex AI SDK after installing the deprecation warning filter.
 * `suppress-vertex-deprecation` must run before `@google-cloud/vertexai` loads.
 */

import './suppress-vertex-deprecation.js';
import {
  BlockedReason,
  FinishReason,
  HarmBlockThreshold,
  HarmCategory,
  VertexAI,
} from '@google-cloud/vertexai';

export type { GenerateContentResponse } from '@google-cloud/vertexai';
export { BlockedReason, FinishReason, HarmBlockThreshold, HarmCategory, VertexAI };
