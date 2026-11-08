import { useLingui } from '@lingui/react/macro';

export default function ExtensionsSettingsPage() {
  const { t } = useLingui();
  return (
    <iframe
      title={t`Extensions`}
      src="/extensions/"
      style={{ width: '100%', height: '72vh', border: 0 }}
    />
  );
}
