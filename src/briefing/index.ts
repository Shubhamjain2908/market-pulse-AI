export { composeBriefing, type ComposeBriefingOptions, type ComposedBriefing } from './composer.js';
export {
  renderBriefing,
  type BriefingData,
  type MarketMood,
  type MoverRow,
  type NewsRow,
  type WatchlistAlert,
} from './template.js';
export { deliverToFile, type FileDeliveryResult } from './delivery/file.js';
export { deliverToEmail, type EmailDeliveryResult } from './delivery/email.js';
