import type { SVGProps } from 'react';

export default function TunarrLogo(props: SVGProps<SVGElement>) {
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 1254 1254"
      xmlns="http://www.w3.org/2000/svg"
      style={props.style}
      aria-hidden="true"
    >
      <image
        href={`${import.meta.env.BASE_URL}tunarr.png`}
        width="1254"
        height="1254"
      />
    </svg>
  );
}
