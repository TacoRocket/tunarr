import { getApiExtensionsOptions } from '@/generated/@tanstack/react-query.gen.ts';
import type { GetApiExtensionsResponses } from '@/generated/types.gen.ts';
import { getApiErrorMessage } from '@/helpers/apiError.ts';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

export type ExtensionStoreState = GetApiExtensionsResponses[200];
export type InstalledExtension = ExtensionStoreState['installed'][number];
export type ExtensionSource = ExtensionStoreState['sources'][number];
export type ExtensionListing = ExtensionSource['entries'][number];
export type ExtensionField = InstalledExtension['settings'][number];
export type ExtensionAction = InstalledExtension['actions'][number];

export function useExtensionStore() {
  return useSuspenseQuery(getApiExtensionsOptions());
}

// Every change reloads the whole store state, which is small.
export function useRefreshExtensionStore() {
  const queryClient = useQueryClient();
  return useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: getApiExtensionsOptions().queryKey,
      }),
    [queryClient],
  );
}

export function extensionErrorMessage(error: unknown, fallback: string) {
  return (
    getApiErrorMessage(error) ??
    (error instanceof Error && error.message ? error.message : fallback)
  );
}

export type ExtensionStatus = 'enabled' | 'disabled' | 'setup';

export function extensionStatus(
  extension: InstalledExtension,
): ExtensionStatus {
  if (!extension.configured) return 'setup';
  return extension.enabled ? 'enabled' : 'disabled';
}
