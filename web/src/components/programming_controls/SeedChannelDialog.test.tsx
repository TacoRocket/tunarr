import { renderWithProviders, screen, waitFor } from '@/test/utils';
import { expect, test, vi } from 'vitest';
import { SeedChannelDialog } from './SeedChannelDialog';

const { generate, applyGrowth, savedGrowth, seedProgram } = vi.hoisted(() => ({
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
}));

vi.mock('../../store/selectors.ts', () => ({
  useChannelEditor: () => ({
    currentEntity: { id: 'e94ff04b-3259-4777-8f55-91b6e1b46bfa' },
    seedGrowth: savedGrowth,
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
    { programs: [seedProgram], hours: 24, familiarity: 50 },
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
