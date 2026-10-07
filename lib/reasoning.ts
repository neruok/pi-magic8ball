import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import { DecisionError, type BuilderReasoning } from './decision.ts';

export function supportedReasoning(model: Model<Api>): BuilderReasoning[] {
  return ['default', ...getSupportedThinkingLevels(model)];
}
export function assertReasoning(model: Model<Api>, level?: BuilderReasoning): void {
  if (level !== undefined && !supportedReasoning(model).includes(level)) throw new DecisionError('unsupported-reasoning');
}
