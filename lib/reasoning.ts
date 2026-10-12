import type { Api, Model } from '@earendil-works/pi-ai';
import { supportedReasoning, supportsReasoning } from '@neruok/pi-common/models';
import { DecisionError, type BuilderReasoning } from './decision.ts';
export { supportedReasoning };
export function assertReasoning(model: Model<Api>, level?: BuilderReasoning): void {
  if (!supportsReasoning(model, level)) throw new DecisionError('unsupported-reasoning');
}
