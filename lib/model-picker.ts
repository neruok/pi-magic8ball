import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { fuzzyFilter, getKeybindings, Input, SelectList, truncateToWidth } from '@earendil-works/pi-tui';
import { DecisionError, type ModelSelection } from './decision.ts';

type Pair = ModelSelection['builder'];
interface PickerModel { provider: string; id: string; name?: string }
const key = (model: PickerModel) => `${model.provider} / ${model.id}`;

/** Match /model's inline, ten-row searchable UI without its chat-session runtime. */
export async function selectModel(ctx: ExtensionCommandContext, title: string, models: readonly PickerModel[], current?: Pair): Promise<Pair | undefined> {
  const entries = new Map(models.map(model => [key(model), model]));
  if (ctx.mode !== 'tui') {
    const selected = await ctx.ui.select(title, [...entries.keys()]);
    if (selected === undefined) return undefined;
    const model = entries.get(selected);
    if (!model) throw new DecisionError('model-unavailable');
    return { provider: model.provider, model: model.id };
  }
  return ctx.ui.custom<Pair | undefined>((tui, theme, _keybindings, done) => {
    const isCurrent = (model: PickerModel) => model.provider === current?.provider && model.id === current.model;
    const items = [...entries.values()]
      .sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)) || a.provider.localeCompare(b.provider))
      .map(model => ({ value: key(model), label: `${isCurrent(model) ? '✓ ' : '  '}${model.id} [${model.provider}]`, model }));
    const search = new Input();
    const style = {
      selectedPrefix: (text: string) => theme.fg('accent', text),
      selectedText: (text: string) => theme.fg('accent', text),
      description: (text: string) => theme.fg('muted', text),
      scrollInfo: (text: string) => theme.fg('muted', text),
      noMatch: () => theme.fg('muted', '  No matching models'),
    };
    let filtered = items, selectedIndex = 0, visible = 10;
    function makeList(): SelectList {
      const next = new SelectList(filtered, visible, style);
      next.setSelectedIndex(selectedIndex);
      next.onSelectionChange = item => { selectedIndex = filtered.findIndex(entry => entry.value === item.value); };
      next.onSelect = item => {
        const model = entries.get(item.value)!;
        done({ provider: model.provider, model: model.id });
      };
      next.onCancel = () => done(undefined);
      return next;
    }
    let list = makeList();
    search.onSubmit = () => list.handleInput('\r');
    function filter(query: string): void {
      // Same search text order and token ranking as Pi's /model selector.
      filtered = fuzzyFilter(items, query, ({ model }) => `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id}${model.name ? ` ${model.name}` : ''}`);
      selectedIndex = query ? 0 : Math.min(selectedIndex, Math.max(0, filtered.length - 1));
      list = makeList();
    }
    return {
      get focused() { return search.focused; },
      set focused(value: boolean) { search.focused = value; },
      render(width: number) {
        const height = Math.max(1, tui.terminal.rows - 2);
        const full = height >= 10;
        const border = theme.fg('accent', '─'.repeat(Math.max(0, width)));
        const heading = theme.fg('accent', theme.bold(title));
        const prefix = full ? [border, heading, ...search.render(width), '']
          : height >= 4 ? [heading, ...search.render(width)] : height >= 2 ? search.render(width) : [];
        const selected = filtered[selectedIndex]?.model;
        const suffix = full ? ['', theme.fg('muted', `  Model Name: ${selected?.name ?? selected?.id ?? ''}`), theme.fg('dim', '↑↓ navigate • enter select • esc cancel'), border] : [];
        const listHeight = height - prefix.length - suffix.length;
        // Count SelectList's position indicator within the viewport budget.
        const count = Math.max(1, Math.min(10, filtered.length, listHeight - (filtered.length > Math.min(10, listHeight) ? 1 : 0)));
        if (count !== visible) { visible = count; list = makeList(); }
        return [...prefix, ...list.render(width).slice(0, listHeight), ...suffix].map(line => truncateToWidth(line, width));
      },
      invalidate() { search.invalidate(); list.invalidate(); },
      handleInput(data: string) {
        const kb = getKeybindings();
        if (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.select.down') || kb.matches(data, 'tui.select.confirm') || kb.matches(data, 'tui.select.cancel')) {
          list.handleInput(data);
        } else {
          const before = search.getValue();
          search.handleInput(data);
          if (search.getValue() !== before) filter(search.getValue());
        }
        tui.requestRender();
      },
    };
  });
}
