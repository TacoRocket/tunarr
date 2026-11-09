import type { ExtensionListing } from '@/hooks/useExtensionStore.ts';
import { renderWithProviders, screen } from '@/test/utils.tsx';
import { expect, it, vi } from 'vitest';
import { AddExtensionDialog } from './AddExtensionDialog.tsx';

function listing(id: string, hidden: boolean): ExtensionListing {
  return {
    id,
    name: id,
    key: `publisher/${id}:${id}`,
    repository: `publisher/${id}`,
    description: '',
    version: '1.0.0',
    commit: 'a'.repeat(40),
    hidden,
  };
}

it('shows hidden listings only while Show hidden is selected', async () => {
  const { user } = renderWithProviders(
    <AddExtensionDialog
      open
      store={{
        apiVersion: '0.5',
        canManage: true,
        installed: [],
        sources: [
          {
            url: 'https://github.com/publisher/extensions',
            name: 'Extensions',
            enabled: true,
            entries: [
              listing('visible-package', false),
              listing('hidden-package', true),
            ],
          },
        ],
      }}
      onClose={vi.fn()}
      onInstalled={vi.fn()}
      onManageSources={vi.fn()}
    />,
  );

  expect(screen.getByText('visible-package')).toBeVisible();
  expect(screen.queryByText('hidden-package')).not.toBeInTheDocument();

  const toggle = screen.getByLabelText(/show hidden/i);
  await user.click(toggle);
  expect(screen.getByText('hidden-package')).toBeVisible();
  expect(screen.getByText('visible-package')).toBeVisible();

  await user.click(toggle);
  expect(screen.queryByText('hidden-package')).not.toBeInTheDocument();
});
