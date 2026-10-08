// Copy this file and replace all model identifiers before an authorized live run.
// This module does not create a runtime until the CLI calls its factory.
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const builders = [
  { name: 'small', provider: 'YOUR_CHAT_PROVIDER', model: 'YOUR_SMALL_MODEL' },
  { name: 'other', provider: 'YOUR_CHAT_PROVIDER', model: 'YOUR_OTHER_MODEL' },
];
const classifierSelection = { provider: 'YOUR_CLASSIFIER_PROVIDER', model: 'YOUR_CLASSIFIER_MODEL' };

export default async function adapter() {
  if ([...builders, classifierSelection].some(pair => pair.provider.startsWith('YOUR_') || pair.model.startsWith('YOUR_'))) throw new Error('Replace the example model identifiers.');
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const classifier = runtime.getModelOfType('classifier', classifierSelection.provider, classifierSelection.model);
  if (!classifier) throw new Error('Classifier is unavailable.');
  return {
    configurations: builders.map(({ name, provider, model }) => {
      const selected = runtime.getPhysicalModel(provider, model);
      if (!selected) throw new Error('Physical builder is unavailable.');
      return {
        name,
        models: { builder: { provider, model }, classifier: classifierSelection },
        complete: (context, signal, options) => runtime.streamSimple(selected, context, { ...options, signal, maxRetries: 0 }).result(),
      };
    }),
    classify: (request, state, signal, execution) => runtime.classify(classifier, { state, questions: { decision: { type: 'choice', instructions: request.question, criteria: request.responses } } }, { signal, timeoutMs: execution.remaining(), maxRetries: 0 }),
  };
}
