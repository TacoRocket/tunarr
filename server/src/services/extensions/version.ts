// The extension API this Tunarr runs, as major.minor.
//
// A minor version only adds: an extension built for 0.5 keeps working on 0.6
// and 0.7, it just doesn't use what they add. Anything that would break an
// installed extension waits for the next major version (1.0, 2.0).
export const currentExtensionApi = '0.5';

const versionPattern = /^(\d{1,3})\.(\d{1,3})$/;

function parse(version: string) {
  const match = versionPattern.exec(version);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

export type ApiCompatibility =
  | 'supported'
  | 'needs-newer-tunarr'
  | 'other-major';

export function extensionApiCompatibility(wanted: string): ApiCompatibility {
  const host = parse(currentExtensionApi)!;
  const needed = parse(wanted);
  if (!needed || needed.major !== host.major) return 'other-major';
  return needed.minor <= host.minor ? 'supported' : 'needs-newer-tunarr';
}

export function isExtensionApiVersion(value: string) {
  return versionPattern.test(value);
}

// Sources and release feeds publish one file per major version, so a minor
// update reads the same listing and a new major gets its own.
export const listingSuffix = `v${currentExtensionApi.split('.')[0]}`;
