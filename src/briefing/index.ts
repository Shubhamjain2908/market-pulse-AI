export { type ComposeBriefingOptions, type ComposedBriefing, composeBriefing } from './composer.js';
export { deliverToEmail, type EmailDeliveryResult } from './delivery/email.js';
export { deliverToFile, type FileDeliveryResult } from './delivery/file.js';
export { deliverBriefing } from './dispatch.js';
export {
  type BriefingData,
  type MarketMood,
  type MoverRow,
  type NewsRow,
  renderBriefing,
  THEME,
  type WatchlistAlert,
} from './template.js';
