import ExtensionsSettingsPage from '@/pages/settings/ExtensionsSettingsPage';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/extensions')({
  component: ExtensionsSettingsPage,
});
