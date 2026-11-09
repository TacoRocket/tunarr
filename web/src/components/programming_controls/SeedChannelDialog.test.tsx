import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { afterEach, expect, test, vi } from 'vitest';
import { SeedChannelDialog } from './SeedChannelDialog';

const { generate, applyGrowth, savedGrowth, seedProgram, fixture } = vi.hoisted(
  () => ({
    fixture: { saved: true, similarity: 'none' },
    generate: vi.fn(),
    applyGrowth: vi.fn(),
    savedGrowth: {
      seedProgramIds: ['d96a1ade-c78b-48e6-b512-3f18c29e501a'],
      familiarity: 50,
      targetHours: 12,
      recommendationMode: 'semantic',
    },
    seedProgram: {
      uuid: 'd96a1ade-c78b-48e6-b512-3f18c29e501a',
      title: 'Saved seed',
      type: 'show',
    },
  }),
);

vi.mock('../../store/selectors.ts', () => ({
  useChannelEditor: () => ({
    currentEntity: { id: 'e94ff04b-3259-4777-8f55-91b6e1b46bfa' },
    seedGrowth: fixture.saved ? savedGrowth : undefined,
    programList: [{ type: 'flex', duration: 1000 }],
  }),
}));

vi.mock('../../store/channelEditor/actions.ts', () => ({
  setSeedChannelGrowth: applyGrowth,
  applyGeneratedChannelProgramming: vi.fn(),
}));

vi.mock('../../generated/sdk.gen.ts', () => ({
  postApiProgrammingGenerateSeedChannel: generate,
}));

vi.mock('../../generated/@tanstack/react-query.gen.ts', () => ({
  getApiCapabilitiesOptions: () => ({
    queryKey: ['capabilities'],
    queryFn: () =>
      Promise.resolve([
        {
          capability: 'similarity',
          state: fixture.similarity,
          message: 'Similarity status: ' + fixture.similarity,
          provider: fixture.similarity === 'none' ? null : 'Example provider',
        },
      ]),
  }),
  postApiProgramsSearchOptions: () => ({
    queryKey: ['saved-seed'],
    queryFn: () => Promise.resolve({ results: [seedProgram] }),
  }),
  // The dialog checks the channel's transcode profile; these channels use a
  // profile ErsatzTV next can play.
  getChannelsByNumberV2Options: ({ path }: { path: { id: string } }) => ({
    queryKey: ['channel', path.id],
    queryFn: () =>
      Promise.resolve({ id: path.id, transcodeConfigId: 'next-profile' }),
  }),
  getApiEtvTranscodeConfigsByIdCompatibilityOptions: () => ({
    queryKey: ['compatibility'],
    queryFn: () =>
      Promise.resolve({ supported: true, unsupported: [], ignored: [] }),
  }),
  getApiTranscodeConfigsOptions: () => ({
    queryKey: ['profiles'],
    queryFn: () =>
      Promise.resolve([
        { id: 'next-profile', name: 'Next profile', audioFormat: 'aac' },
      ]),
  }),
}));

vi.mock('../ProgramSearchAutocomplete.tsx', () => ({
  ProgramSearchAutocomplete: () => null,
}));

vi.mock('usehooks-ts', () => ({
  useLocalStorage: () => [
    {
      programs: [seedProgram],
      hours: 24,
      familiarity: 50,
      recommendationMode: 'semantic',
    },
    vi.fn(),
  ],
}));

test('preserves a saved semantic mode when opening, previewing, and applying growth settings', async () => {
  generate.mockResolvedValue({
    data: {
      lineup: [],
      choices: [],
      warnings: [],
      durationMs: 0,
      seed: [42],
    },
  });
  const { user } = renderWithProviders(
    <SeedChannelDialog open onClose={vi.fn()} />,
  );

  const apply = screen.getByRole('button', { name: 'Apply growth settings' });
  expect.soft(apply).toBeDisabled();

  await user.click(screen.getByRole('button', { name: 'Generate preview' }));
  await waitFor(() => expect(generate).toHaveBeenCalledOnce());
  expect.soft(generate).toHaveBeenCalledWith(
    expect.objectContaining({
      body: expect.objectContaining({ recommendationMode: 'semantic' }),
    }),
  );

  const target = screen.getByLabelText('Keep about this many hours ahead');
  await user.clear(target);
  await user.type(target, '16');
  await user.click(apply);
  expect(applyGrowth).toHaveBeenCalledWith({ ...savedGrowth, targetHours: 16 });
});

test.each(['none', 'preparing', 'ready'])(
  'new channel matching with a %s similarity provider',
  async (state) => {
    fixture.saved = false;
    fixture.similarity = state;
    const { user } = renderWithProviders(
      <SeedChannelDialog open onClose={vi.fn()} />,
    );
    const matching = screen.getByRole('combobox', { name: 'Matching' });
    await screen.findByText('Similarity status: ' + state, { exact: false });
    expect(matching).toHaveTextContent(
      state === 'ready' ? 'Semantic' : 'Metadata',
    );
    await user.click(matching);
    const semantic = screen.getByRole('option', { name: 'Semantic' });
    if (state === 'ready')
      expect(semantic).not.toHaveAttribute('aria-disabled', 'true');
    else expect(semantic).toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByRole('option', { name: 'Balanced' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
  },
);

afterEach(() => {
  fixture.saved = true;
  fixture.similarity = 'none';
});
