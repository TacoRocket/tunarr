import path, { dirname } from 'node:path';
import { filename } from './util/index.js';

// Fork: file paths for images Tunarr already serves, for readers that take a
// file rather than Tunarr's /images URLs (the ErsatzTV next worker's fallback
// picture). Same roots as Server.ts's static routes. This module sits beside
// Server.ts so `import.meta.url` names the same folder from source and from the
// bundle.
const currentDirectory = dirname(filename(import.meta.url));

/** An image shipped in resources/images, such as generic-offline-screen.png. */
export function bundledImagePath(name: string) {
  return path.join(currentDirectory, 'resources', 'images', name);
}

/**
 * The file behind a Tunarr upload URL (`…/images/uploads/<file>`, as the image
 * upload API returns it), or undefined for any other location. The database
 * folder is only looked up for an upload URL.
 */
export function uploadedImagePath(
  location: string,
  databaseDirectory: () => string,
) {
  let pathname: string;
  try {
    pathname = new URL(location, 'http://tunarr.invalid').pathname;
  } catch {
    return undefined;
  }
  const match = /^\/images\/uploads\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) {
    return undefined;
  }
  let file: string;
  try {
    file = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  // A decoded name must still be a single file in the uploads folder.
  if (file !== path.basename(file) || file === '.' || file === '..') {
    return undefined;
  }
  return path.join(databaseDirectory(), 'images', 'uploads', file);
}
