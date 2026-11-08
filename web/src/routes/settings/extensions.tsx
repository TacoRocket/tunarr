import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/extensions')({
  component: ExtensionsSettings,
});

function ExtensionsSettings() {
  const { t } = useLingui();
  return (
    <iframe
      title={t`Extensions`}
      src="/extensions/"
      style={{ width: '100%', height: '72vh', border: 0 }}
    />
  );
}
