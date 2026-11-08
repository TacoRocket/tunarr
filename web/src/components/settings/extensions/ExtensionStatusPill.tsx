import { StatusPill } from '@/components/ui/StatusPill.tsx';
import {
  extensionStatus,
  type InstalledExtension,
} from '@/hooks/useExtensionStore.ts';
import { Trans } from '@lingui/react/macro';

export function ExtensionStatusPill({
  extension,
}: {
  extension: InstalledExtension;
}) {
  switch (extensionStatus(extension)) {
    case 'enabled':
      return <StatusPill status="live" label={<Trans>Enabled</Trans>} />;
    case 'disabled':
      return <StatusPill status="idle" label={<Trans>Disabled</Trans>} />;
    case 'setup':
      return <StatusPill status="warning" label={<Trans>Needs setup</Trans>} />;
  }
}
