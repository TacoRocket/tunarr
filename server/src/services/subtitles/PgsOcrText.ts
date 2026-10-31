// Narrow adaptation of Subtitle Edit's English OCR replacement list (MIT).
// See README.md and LICENSE.SubtitleEdit; this does not run its dictionary engine.
export function fixPgsOcrText(text: string, language: string): string {
  if (language !== 'eng') return text;
  return text.replace(
    /(?<=[A-Za-z'’])\||\|(?=[A-Za-z'’])|(?<![\w|])\|(?![\w|])/g,
    'I',
  );
}
