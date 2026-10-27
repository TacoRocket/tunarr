import { VaapiHardwareAccelerationOption } from './VaapiOptions.ts';

test.each([true, false])(
  'CRT subtitle uploads can reuse the video VAAPI device (hardware decode: %s)',
  (hardwareDecode) => {
    const options = new VaapiHardwareAccelerationOption(
      '/dev/dri/renderD128',
      hardwareDecode,
      false,
      true,
    ).options();

    expect(options.slice(0, 8)).toEqual([
      '-init_hw_device',
      'drm=dr:/dev/dri/renderD128',
      '-init_hw_device',
      'vaapi=va@dr',
      '-init_hw_device',
      'vulkan=vk@va',
      '-filter_hw_device',
      'vk',
    ]);
  },
);
