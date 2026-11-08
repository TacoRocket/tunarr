import { describe, expect, it } from 'vitest';
import { checkApiVersion } from './schema.ts';
import { currentExtensionApi, extensionApiCompatibility } from './version.ts';

describe('extension API compatibility', () => {
  it('runs extensions built for this minor version or an older one', () => {
    expect(currentExtensionApi).toBe('0.5');
    expect(extensionApiCompatibility('0.5')).toBe('supported');
    expect(extensionApiCompatibility('0.1')).toBe('supported');
  });

  it('asks for a newer Tunarr when an extension needs a later minor', () => {
    expect(extensionApiCompatibility('0.6')).toBe('needs-newer-tunarr');
  });

  it('refuses another major version', () => {
    expect(extensionApiCompatibility('1.0')).toBe('other-major');
    expect(extensionApiCompatibility('2')).toBe('other-major');
  });

  it('explains a refusal in the manifest check', () => {
    expect(() => checkApiVersion({ apiVersion: '0.5' })).not.toThrow();
    expect(() => checkApiVersion({ apiVersion: 2 })).toThrow(
      'This extension was built for extension API 2, and this Tunarr runs 0.5. Update the extension.',
    );
    expect(() => checkApiVersion({ apiVersion: '0.6' })).toThrow(
      'This extension needs extension API 0.6, and this Tunarr runs 0.5. Update Tunarr to use it.',
    );
    expect(() => checkApiVersion({})).toThrow(
      "This extension doesn't say which extension API it needs.",
    );
  });
});
