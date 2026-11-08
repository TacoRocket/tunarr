import { AddExtensionDialog } from '@/components/settings/extensions/AddExtensionDialog.tsx';
import { ExtensionEditDialog } from '@/components/settings/extensions/ExtensionEditDialog.tsx';
import { ExtensionSourcesDialog } from '@/components/settings/extensions/ExtensionSourcesDialog.tsx';
import { ExtensionStatusPill } from '@/components/settings/extensions/ExtensionStatusPill.tsx';
import { RunExtensionActionDialog } from '@/components/settings/extensions/RunExtensionActionDialog.tsx';
import { EmptyState } from '@/components/ui/EmptyState.tsx';
import { MonoText } from '@/components/ui/MonoText.tsx';
import { StatusPill } from '@/components/ui/StatusPill.tsx';
import {
  useExtensionStore,
  type ExtensionAction,
  type InstalledExtension,
} from '@/hooks/useExtensionStore.ts';
import { useThemeTokens } from '@/hooks/useTunarrTheme.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import { Add, ExtensionOutlined, Hub } from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Link,
  Stack,
  Typography,
} from '@mui/material';
import { useState } from 'react';

// Where the beta's plans live and where feedback goes.
const roadmapUrl =
  'https://github.com/TacoRocket/tunarr-retuned/blob/main/docs/fork/extensions.md#roadmap';

const gridSx = {
  display: 'grid',
  gap: 2,
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
} as const;

function ExtensionCard({
  extension,
  onEdit,
  onRun,
}: {
  extension: InstalledExtension;
  onEdit: () => void;
  onRun: (action: ExtensionAction) => void;
}) {
  // The publisher picks up to two quick actions for the card; everything else
  // is in the details dialog.
  const quick = extension.actions.filter((action) => action.quick);
  return (
    <Card sx={{ display: 'flex', flexDirection: 'column' }}>
      <CardActionArea
        onClick={onEdit}
        // Content starts at the top whether or not the card has quick actions.
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          justifyContent: 'flex-start',
        }}
      >
        <CardContent>
          <Stack spacing={1}>
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              gap={1}
            >
              <Typography
                variant="subtitle1"
                fontWeight={600}
                sx={{ overflowWrap: 'anywhere' }}
              >
                {extension.name}
              </Typography>
              <ExtensionStatusPill extension={extension} />
            </Stack>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ overflowWrap: 'anywhere' }}
            >
              <MonoText fontSize="inherit">{extension.repository}</MonoText>
              {' · '}
              <Trans>version {extension.version}</Trans>
            </Typography>
            {extension.update && (
              <Box>
                <StatusPill
                  status="warning"
                  label={<Trans>Update to {extension.update.version}</Trans>}
                />
              </Box>
            )}
          </Stack>
        </CardContent>
      </CardActionArea>
      {extension.compatible && extension.enabled && quick.length > 0 && (
        <Stack
          direction="row"
          gap={1}
          flexWrap="wrap"
          sx={{ px: 2, pb: 2, pt: 0.5 }}
        >
          {quick.map((action) => (
            <Button
              key={action.id}
              size="small"
              variant="outlined"
              onClick={() => onRun(action)}
            >
              {action.label}
            </Button>
          ))}
        </Stack>
      )}
    </Card>
  );
}

function AddCard({ onClick }: { onClick: () => void }) {
  const { tokens } = useThemeTokens();
  return (
    <Card
      sx={{
        borderStyle: 'dashed',
        borderColor: tokens.borderStrong,
        backgroundColor: 'transparent',
        minHeight: 112,
      }}
    >
      <CardActionArea
        onClick={onClick}
        sx={{ height: '100%', display: 'grid', placeItems: 'center' }}
      >
        <Stack alignItems="center" gap={0.5} sx={{ color: 'text.secondary' }}>
          <Add fontSize="large" />
          <Typography variant="body2" fontWeight={600}>
            <Trans>Add extension</Trans>
          </Typography>
        </Stack>
      </CardActionArea>
    </Card>
  );
}

export default function ExtensionsSettingsPage() {
  const { t } = useLingui();
  const { data: store } = useExtensionStore();
  const [adding, setAdding] = useState(false);
  const [managingSources, setManagingSources] = useState(false);
  const [editingKey, setEditingKey] = useState<string>();
  const [running, setRunning] = useState<{
    extension: InstalledExtension;
    action: ExtensionAction;
  }>();

  // Read the live entry so the dialog shows changes such as an update.
  const editing = store.installed.find((e) => e.key === editingKey);

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        justifyContent="space-between"
        gap={2}
        sx={{ mb: 3 }}
      >
        <Box>
          <Stack direction="row" alignItems="center" gap={1}>
            <Typography variant="h5">
              <Trans>Extensions</Trans>
            </Typography>
            <Chip
              size="small"
              color="primary"
              variant="outlined"
              label={t`Beta`}
            />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            <Trans>
              Add features that connect Tunarr to your other services. Each
              extension runs in its own sandbox and can't change your channels
              or media.
            </Trans>
          </Typography>
        </Box>
        {store.canManage && (
          <Button
            variant="outlined"
            startIcon={<Hub />}
            onClick={() => setManagingSources(true)}
            sx={{ flex: 'none' }}
          >
            <Trans>Manage sources</Trans>
          </Button>
        )}
      </Stack>

      <Alert severity="info" sx={{ mb: 3 }}>
        <Trans>
          Extensions are an early beta (extension API {store.apiVersion}).
          Tunarr updates add to the API without breaking the extensions you have
          installed.{' '}
          <Link href={roadmapUrl} target="_blank" rel="noopener noreferrer">
            See what's planned and tell us what you'd use
          </Link>
          .
        </Trans>
      </Alert>

      {!store.canManage ? (
        <Stack spacing={2}>
          <Alert severity="info">
            <Trans>
              Installing and running extensions needs a Tunarr login. Set{' '}
              <code>TUNARR_BASIC_AUTH_USER</code> and{' '}
              <code>TUNARR_BASIC_AUTH_PASSWORD</code>, or start Tunarr with{' '}
              <code>TUNARR_EXTENSION_TRUSTED_LAN=true</code> if only trusted
              devices can reach it.
            </Trans>
          </Alert>
          <Box>
            <Button variant="outlined" onClick={() => setAdding(true)}>
              <Trans>Browse extensions</Trans>
            </Button>
          </Box>
        </Stack>
      ) : store.installed.length === 0 ? (
        <EmptyState
          icon={<ExtensionOutlined />}
          title={<Trans>No extensions installed</Trans>}
          description={
            <Trans>
              Browse the extensions your sources offer and install one to get
              started.
            </Trans>
          }
          actions={
            <Button
              variant="contained"
              startIcon={<Add />}
              onClick={() => setAdding(true)}
            >
              <Trans>Add extension</Trans>
            </Button>
          }
        />
      ) : (
        <Box sx={gridSx}>
          {store.installed.map((extension) => (
            <ExtensionCard
              key={extension.key}
              extension={extension}
              onEdit={() => setEditingKey(extension.key)}
              onRun={(action) => setRunning({ extension, action })}
            />
          ))}
          <AddCard onClick={() => setAdding(true)} />
        </Box>
      )}

      <AddExtensionDialog
        open={adding}
        store={store}
        onClose={() => setAdding(false)}
        onManageSources={() => {
          setAdding(false);
          setManagingSources(true);
        }}
        onInstalled={(key) => {
          setAdding(false);
          setEditingKey(key);
        }}
      />
      <ExtensionSourcesDialog
        open={managingSources}
        store={store}
        onClose={() => setManagingSources(false)}
      />
      <ExtensionEditDialog
        extension={editing}
        onClose={() => setEditingKey(undefined)}
        onRun={(action) =>
          editing && setRunning({ extension: editing, action })
        }
      />
      <RunExtensionActionDialog
        target={running}
        onClose={() => setRunning(undefined)}
      />
    </Box>
  );
}
