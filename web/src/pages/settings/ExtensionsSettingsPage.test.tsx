import { ExtensionEditDialog } from '@/components/settings/extensions/ExtensionEditDialog.tsx';
import type {
  ExtensionAction,
  ExtensionStoreState,
  InstalledExtension,
} from '@/hooks/useExtensionStore.ts';
import { renderWithProviders, screen, within } from '@/test/utils.tsx';
import { expect, it, vi } from 'vitest';
import ExtensionsSettingsPage from './ExtensionsSettingsPage.tsx';

// The card and details dialog are a template every extension plugs into.
// These tests pin what the template promises publishers.

const store = vi.hoisted(() => ({ installed: [] as InstalledExtension[] }));
vi.mock('@/hooks/useExtensionStore.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useExtensionStore: () => ({
    data: {
      apiVersion: '0.5',
      canManage: true,
      installed: store.installed,
      sources: [],
    } satisfies ExtensionStoreState,
  }),
}));

function action(id: string, label: string, quick = false): ExtensionAction {
  return { id, label, inputs: [], quick };
}

// Shaped like our two first extensions: a service with quick actions, and a
// capability provider with nothing to do from the overview.
function installed(
  overrides: Partial<InstalledExtension> & Pick<InstalledExtension, 'name'>,
): InstalledExtension {
  return {
    key: `publisher/${overrides.name}:${overrides.name}`,
    id: overrides.name.toLowerCase(),
    description: '',
    repository: `publisher/${overrides.name}`,
    source: 'https://github.com/publisher/extensions',
    version: '1.0.0',
    commit: 'a'.repeat(40),
    enabled: true,
    configured: true,
    update: null,
    connectionTest: false,
    compatible: true,
    settings: [],
    values: {},
    savedSecrets: [],
    actions: [],
    capabilities: [],
    ...overrides,
  };
}

const bazarr = (overrides: Partial<InstalledExtension> = {}) =>
  installed({
    name: 'Bazarr',
    connectionTest: true,
    settings: [
      { key: 'bazarrUrl', type: 'url', label: 'Bazarr URL', required: true },
    ],
    values: { bazarrUrl: 'http://bazarr:6767' },
    actions: [
      action('lookup', 'Check subtitles', true),
      action('search', 'Search for missing subtitles', true),
      action('history', 'Subtitle history'),
    ],
    ...overrides,
  });

const potion = (overrides: Partial<InstalledExtension> = {}) =>
  installed({
    name: 'Potion',
    actions: [action('status', 'Check index')],
    capabilities: [
      {
        capability: 'similarity',
        label: 'similar titles',
        state: 'off',
        message: 'Turn on Potion to provide similar titles.',
      },
    ],
    ...overrides,
  });

it('puts only the quick actions the publisher chose on the card', () => {
  store.installed = [bazarr()];
  renderWithProviders(<ExtensionsSettingsPage />);
  const buttons = within(screen.getByText('Bazarr').closest('.MuiCard-root')!)
    .getAllByRole('button')
    .map((b) => b.textContent);
  expect(buttons).toContain('Check subtitles');
  expect(buttons).toContain('Search for missing subtitles');
  expect(buttons).not.toContain('Subtitle history');
});

it('shows no buttons on a card whose publisher chose no quick actions', () => {
  store.installed = [potion({ enabled: true })];
  renderWithProviders(<ExtensionsSettingsPage />);
  const card = screen.getByText('Potion').closest('.MuiCard-root')!;
  // The whole card opens its details; nothing else is a button.
  expect(within(card as HTMLElement).getAllByRole('button')).toHaveLength(1);
  expect(within(card as HTMLElement).queryByText('Check index')).toBeNull();
});

it('hides details tabs that have nothing in them, and keeps status off the Actions tab', () => {
  renderWithProviders(
    <ExtensionEditDialog
      extension={potion({ enabled: false })}
      onClose={vi.fn()}
      onRun={vi.fn()}
    />,
  );
  const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
  expect(tabs).toEqual(['Info', 'Configuration', 'Access']);
  expect(screen.getByText('Provides similar titles')).toBeVisible();
});

it('lists every action in details, quick ones included, and opens setup first', async () => {
  const onRun = vi.fn();
  const { user } = renderWithProviders(
    <ExtensionEditDialog
      extension={bazarr({ configured: false, enabled: false })}
      onClose={vi.fn()}
      onRun={onRun}
    />,
  );
  expect(screen.getByRole('tab', { selected: true })).toHaveTextContent(
    'Configuration',
  );
  await user.click(screen.getByRole('tab', { name: 'Actions' }));
  for (const label of [
    'Check subtitles',
    'Search for missing subtitles',
    'Subtitle history',
  ])
    expect(screen.getByText(label)).toBeVisible();
  expect(screen.getAllByText('Also on the card')).toHaveLength(2);
});

it('hides quick actions while the extension is turned off', () => {
  store.installed = [bazarr({ enabled: false })];
  renderWithProviders(<ExtensionsSettingsPage />);
  const card = screen.getByText('Bazarr').closest('.MuiCard-root')!;
  expect(within(card as HTMLElement).getAllByRole('button')).toHaveLength(1);
  expect(within(card as HTMLElement).queryByText('Check subtitles')).toBeNull();
});

it("won't run actions from details while the extension is turned off", async () => {
  const onRun = vi.fn();
  const { user } = renderWithProviders(
    <ExtensionEditDialog
      extension={bazarr({ enabled: false })}
      onClose={vi.fn()}
      onRun={onRun}
    />,
  );
  await user.click(screen.getByRole('tab', { name: 'Actions' }));
  expect(
    screen.getByText('Turn the extension on to run its actions.'),
  ).toBeVisible();
  for (const run of screen.getAllByRole('button', { name: 'Run' }))
    expect(run).toBeDisabled();
  expect(onRun).not.toHaveBeenCalled();
});
