import type { StreamDegradation, StreamDegradationCode } from '@tunarr/types';
import { readFileSync } from 'node:fs';
import { z } from 'zod/v4';
import { CrtHdrBypassedMessage } from '../../ffmpeg/StreamDegradations.ts';

/**
 * The fork's worker (TacoRocket/next) rewrites `ffmpeg.degradation_report` as
 * each item starts: its last few items, each with the fallbacks its pipeline
 * chose. Codes this version does not know are skipped, so a newer worker can
 * report more without breaking an older Tunarr.
 */
const DegradationReportSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      start: z.string(),
      finish: z.string(),
      degradations: z.array(
        z.object({
          code: z.string(),
          message: z.string(),
          since: z.string(),
        }),
      ),
    }),
  ),
});

// The worker draws only the shader Tunarr gives it, and Tunarr gives it only
// the CRT look, so the shader codes become CRT codes with CRT wording.
const WorkerCodes = new Map<
  string,
  { code: StreamDegradationCode; message?: string }
>([
  ['hardware_decode_unavailable', { code: 'hardware_decode_unavailable' }],
  ['hardware_encode_unavailable', { code: 'hardware_encode_unavailable' }],
  ['hardware_tonemap_unavailable', { code: 'hardware_tonemap_unavailable' }],
  ['hdr_tone_mapped', { code: 'hdr_tone_mapped' }],
  ['hdr_preservation_unsupported', { code: 'hdr_preservation_unsupported' }],
  ['vaapi_low_power_unavailable', { code: 'vaapi_low_power_unavailable' }],
  [
    'custom_shader_hdr_skipped',
    { code: 'crt_hdr_bypassed', message: CrtHdrBypassedMessage },
  ],
  [
    'custom_shader_unavailable',
    {
      code: 'crt_unavailable',
      message:
        'CRT is off: the ErsatzTV next backend draws it only with VAAPI, libplacebo and a Vulkan device that imports VAAPI frames.',
    },
  ],
]);

/**
 * The worker's fallbacks for the item scheduled at `nowMs`.
 *
 * Empty when the worker has not built that item yet, or when the report is
 * missing or unreadable: the subtitle diagnostics come from Tunarr and still
 * apply.
 */
export function readEtvNextDegradations(
  reportPath: string,
  nowMs: number,
): StreamDegradation[] {
  let parsed: z.infer<typeof DegradationReportSchema>;
  try {
    const result = DegradationReportSchema.safeParse(
      JSON.parse(readFileSync(reportPath, 'utf-8')),
    );
    if (!result.success) {
      return [];
    }
    parsed = result.data;
  } catch {
    return [];
  }

  // The worker transcodes ahead, so the newest item may not be on air yet.
  const current = parsed.items.findLast(
    (item) =>
      Date.parse(item.start) <= nowMs && nowMs < Date.parse(item.finish),
  );
  if (!current) {
    return [];
  }

  const degradations: StreamDegradation[] = [];
  for (const reported of current.degradations) {
    const known = WorkerCodes.get(reported.code);
    const firstSeen = Date.parse(reported.since);
    if (!known || Number.isNaN(firstSeen)) {
      continue;
    }
    degradations.push({
      code: known.code,
      message: known.message ?? reported.message,
      firstSeen,
    });
  }
  return degradations;
}
