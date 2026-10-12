import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { selectModel as commonSelectModel, ModelPickerError } from '@neruok/pi-common/model-picker';
import type { PickerModel, ModelSelection } from '@neruok/pi-common/models';
import { DecisionError } from './decision.ts';

export async function selectModel(ctx: ExtensionCommandContext, title: string, models: readonly PickerModel[], current?: ModelSelection): Promise<ModelSelection | undefined> {
  try { return await commonSelectModel(ctx, title, models, current); }
  catch (error) {
    if (error instanceof ModelPickerError) throw new DecisionError('model-unavailable');
    throw error;
  }
}
