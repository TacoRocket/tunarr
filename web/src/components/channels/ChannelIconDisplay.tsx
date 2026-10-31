import type { ChannelIcon } from '@tunarr/types';

type Props = {
  icon: ChannelIcon | undefined;
  style?: React.CSSProperties;
  imgStyle?: React.CSSProperties;
};

export function ChannelIconDisplay({ icon, style, imgStyle }: Props) {
  if (icon?.path) {
    return <img style={imgStyle ?? style} src={icon.path} alt="" />;
  }
  if (!icon || icon.useDefaultIconFallback !== false) {
    return (
      <img style={style} src={`${import.meta.env.BASE_URL}tunarr.png`} alt="" />
    );
  }
  return null;
}
