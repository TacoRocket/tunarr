import type { SVGProps } from 'react';

// Fork branding for the app header and welcome page. Upstream's TunarrLogo
// stays the default channel picture, matching the server's tunarr.png.

export default function RetunedLogo(props: SVGProps<SVGElement>) {
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 180 180"
      xmlns="http://www.w3.org/2000/svg"
      style={props.style}
      aria-hidden="true"
    >
      <image
        href={`${import.meta.env.BASE_URL}tunarr-retuned.png`}
        width="180"
        height="180"
      />
    </svg>
  );
}
