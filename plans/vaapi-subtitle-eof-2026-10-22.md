# VAAPI subtitle overlay at end of episode

The main Rewind stream remained on DBZ after other channels advanced. Its encoder stayed alive without new HLS segments after the expected program duration. The native VAAPI subtitle-overlay builder uses FFmpeg's default secondary-frame repetition. The existing class is only used for image-subtitle overlays, not channel watermarks.

Set eof_action=pass at that owner: the primary video determines the remaining picture when subtitle input ends. This preserves the primary stream instead of shortest=1, which could end an episode when its subtitle input finishes early. No wrapper, FFmpeg build, audio, shader, schedule or other hardware backend changes.

Direct evidence on the affected DBZ Kai S01E22, same patched FFmpeg and GPU:

- Last12.175744s with default overlay failed to finish before40s; no-overlay control finished.
- Removing or correcting subtitle fps did not resolve the hang.
- eof_action=pass finished the short ending and the complete241.399744s tail (5787 frames,241.399750s output, normal exit).
- The unit regression protects command generation only. Runtime behavior is established by direct media probes, not by the unit assertion.

FFmpeg8.1.2 framesync.c turns off secondary synchronization/extension for pass; vf_overlay_vaapi.c supports rendering primary alone. This is an available native filter policy, not proof of a newly diagnosed FFmpeg internal defect. Other drivers, image-subtitle codecs and EOF layouts are not exhaustively verified. Compiled trial and live cutover have not occurred yet.
