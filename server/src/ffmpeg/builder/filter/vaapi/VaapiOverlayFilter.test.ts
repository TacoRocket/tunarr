import { VaapiOverlayFilter } from './VaapiOverlayFilter.ts';

test('subtitle EOF passes the remaining primary video instead of extending the overlay', () => {
  const filter = new VaapiOverlayFilter();
  expect(filter.filter).toBe('overlay_vaapi=x=(W-w)/2:y=(H-h)/2:eof_action=pass');
});
