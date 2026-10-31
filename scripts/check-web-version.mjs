import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Reject stale or unstamped web assets before adding them to a container. */
export function checkWebVersion(webDirectory, backendVersion) {
  const metadataPath = path.join(webDirectory, 'version.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  if (
    typeof backendVersion !== 'string' ||
    backendVersion.length === 0 ||
    metadata?.version !== backendVersion
  ) {
    throw new Error(
      `Web/backend version mismatch: web=${metadata?.version}, backend=${backendVersion}. Rebuild both bundles with the same version settings.`,
    );
  }
  return backendVersion;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , webDirectory, backendVersion] = process.argv;
  if (!webDirectory || !backendVersion) {
    throw new Error(
      'Usage: node scripts/check-web-version.mjs <web-directory> <backend-version>',
    );
  }
  console.log(
    `Web/backend version matches: ${checkWebVersion(webDirectory, backendVersion)}`,
  );
}
