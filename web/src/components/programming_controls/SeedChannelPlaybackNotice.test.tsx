import { DefaultChannel } from '@/helpers/constants.ts';
import { renderWithProviders, screen } from '@/test/utils.tsx';
import { expect, test, vi } from 'vitest';
import { defaultNewTranscodeConfig } from '../settings/ffmpeg/defaultNewTranscodeConfig.ts';
import { SeedChannelPlaybackNotice } from './SeedChannelPlaybackNotice.tsx';

const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('@/hooks/useUpdateChannel.ts', () => ({
  useUpdateChannel: () => ({ mutateAsync: update }),
}));

test('switching profiles leaves the schedule clock and on-demand position to the server', async () => {
  const channel = {
    ...DefaultChannel,
    id: 'channel',
    name: 'On demand',
    number: 1,
    startTime: 1700000000000,
    onDemand: { enabled: true },
    transcodeConfigId: 'legacy',
  };
  const profile = { ...defaultNewTranscodeConfig, id: 'aac', name: 'AAC' };
  const { user } = renderWithProviders(
    <SeedChannelPlaybackNotice
      channel={channel}
      blocked
      unsupported={[
        { field: 'audioFormat', value: 'eac3', reason: 'unsupported' },
      ]}
      profileName="Legacy"
      profilesLoaded
      compatibleProfiles={[profile]}
    />,
  );

  await user.click(screen.getByRole('button', { name: 'Use this profile' }));
  expect(update).toHaveBeenCalledOnce();
  const [request] = update.mock.calls[0];
  expect(request.path.id).toBe(channel.id);
  expect(request.body.transcodeConfigId).toBe(profile.id);
  expect(request.body).not.toHaveProperty('startTime');
  expect(request.body).not.toHaveProperty('onDemand');
});
