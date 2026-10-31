import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ChannelIconDisplay } from './ChannelIconDisplay.tsx';

test('previews the default channel artwork instead of the app logo', () => {
  render(<ChannelIconDisplay icon={undefined} />);

  expect(screen.getByRole('presentation')).toHaveAttribute(
    'src',
    `${import.meta.env.BASE_URL}tunarr.png`,
  );
});
