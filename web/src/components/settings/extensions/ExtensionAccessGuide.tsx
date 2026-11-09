import { Trans, useLingui } from '@lingui/react/macro';
import { Box, Typography } from '@mui/material';

type Guide = {
  reads: string;
  changes: string;
  connectsTo: string;
  downloads: string;
};
type Allowance = {
  memoryMiB?: number;
  storageMiB?: number;
  downloadBytes?: number;
  requests: { method: string; setting: string }[];
  provides: string[];
};

const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 1048576));

/**
 * The publisher's own summary of what an extension does, followed by one line
 * Tunarr builds from the manifest. The first is a claim; the second is what
 * the sandbox actually allows, so a careless summary can't hide anything.
 */
export function ExtensionAccessGuide({
  name,
  guide,
  allowance,
}: {
  name: string;
  guide?: Guide;
  allowance?: Allowance;
}) {
  const { t, i18n } = useLingui();
  const rows = guide
    ? [
        [t`Reads`, guide.reads],
        [t`Changes`, guide.changes],
        [t`Connects to`, guide.connectsTo],
        [t`Downloads`, guide.downloads],
      ]
    : [];

  const allowed: string[] = [];
  if (allowance) {
    const bySetting = new Map<string, Set<string>>();
    for (const { method, setting } of allowance.requests)
      bySetting.set(setting, (bySetting.get(setting) ?? new Set()).add(method));
    for (const [setting, methods] of bySetting)
      allowed.push(
        [...methods].some((m) => m !== 'GET')
          ? t`read from and send changes to ${setting}`
          : t`read from ${setting}`,
      );
    if (!bySetting.size) allowed.push(t`reach no services`);
    if (allowance.memoryMiB)
      allowed.push(t`use up to ${allowance.memoryMiB} MB of memory`);
    if (allowance.storageMiB)
      allowed.push(t`keep up to ${allowance.storageMiB} MB of its own data`);
    if (allowance.downloadBytes)
      allowed.push(
        t`download ${megabytes(allowance.downloadBytes)} MB of files when installed`,
      );
    if (allowance.provides.includes('similarity'))
      allowed.push(t`answer Tunarr's similarity questions`);
    if (allowance.provides.includes('subtitleRequest'))
      allowed.push(t`answer subtitle requests during preparation`);
  }
  const list = new Intl.ListFormat(i18n.locale, {
    style: 'long',
    type: 'conjunction',
  }).format(allowed);

  return (
    <Box>
      <Typography variant="subtitle2">
        <Trans>{name} — Access at a glance</Trans>
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p">
        <Trans>Provided by the extension publisher</Trans>
      </Typography>
      {rows.length ? (
        <Box
          component="dl"
          sx={{
            m: 0,
            mt: 0.75,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: 1.5,
            rowGap: 0.5,
            '& dt': { fontWeight: 600, typography: 'body2' },
            '& dd': { m: 0, typography: 'body2', overflowWrap: 'anywhere' },
          }}
        >
          {rows.map(([label, text]) => (
            <Box key={label} sx={{ display: 'contents' }}>
              <dt>{label}</dt>
              <dd>{text}</dd>
            </Box>
          ))}
        </Box>
      ) : (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          <Trans>
            No access guide was provided by the extension publisher.
          </Trans>
        </Typography>
      )}
      {allowed.length > 0 && (
        <Typography
          variant="caption"
          color="text.secondary"
          component="p"
          sx={{ mt: 0.75 }}
        >
          <Trans>Tunarr lets it {list}.</Trans>
        </Typography>
      )}
    </Box>
  );
}
