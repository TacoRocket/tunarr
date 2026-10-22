import { FilterOption } from '../FilterOption.ts';

export class VaapiOverlayFilter extends FilterOption {
  get filter() {
    // Subtitle EOF must not keep the secondary input driving frame synchronization.
    return `overlay_vaapi=x=(W-w)/2:y=(H-h)/2:eof_action=pass`;
  }
}
