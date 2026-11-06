import type { Theme } from "../theme.ts";

// Keep in step with the launch screen in index.html, which takes over from this image once the page paints.
const PALETTES = {
  dark: { center: "#18181b", edge: "#0a0a0a", plateTop: "#232326", plateBottom: "#0a0a0a", left: "#ffffff", rightTop: "#b4b4ba", rightBottom: "#76767c" },
  light: { center: "#ffffff", edge: "#ffffff", plateTop: "#ffffff", plateBottom: "#e6e6ea", left: "#0a0a0a", rightTop: "#9a9aa0", rightBottom: "#6a6a70" },
};

// The launch screen at width × height CSS pixels, drawn at the given pixel scale.
export function launchSvg(theme: Theme, width: number, height: number, scale: number): string {
  const c = PALETTES[theme];
  const cx = width / 2;
  const cy = height * 0.45;
  // CSS `radial-gradient(ellipse at 50% 45%)` reaches the farthest corner with the farthest side's aspect ratio.
  const ry = height * 0.55 * Math.SQRT2;
  const rx = width * 0.5 * Math.SQRT2;
  const shadow = theme === "light" ? ' filter="url(#shadow)"' : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">
<defs>
<radialGradient id="bg" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${ry}" gradientTransform="translate(${cx} ${cy}) scale(${rx / ry} 1) translate(${-cx} ${-cy})"><stop offset="0" stop-color="${c.center}"/><stop offset="0.6" stop-color="${c.edge}"/></radialGradient>
<linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.plateTop}"/><stop offset="1" stop-color="${c.plateBottom}"/></linearGradient>
<linearGradient id="right" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.rightTop}"/><stop offset="1" stop-color="${c.rightBottom}"/></linearGradient>
<filter id="shadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity="0.14"/></filter>
</defs>
<rect width="${width}" height="${height}" fill="url(#bg)"/>
<g${shadow}><g transform="translate(${cx - 60} ${height / 2 - 60}) scale(${120 / 824}) translate(-100 -100)">
<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#plate)"/>
<g fill="none" stroke-width="100" stroke-linecap="round" stroke-linejoin="round"><path d="M300 318 L446 512 L300 706" stroke="${c.left}"/><path d="M724 318 L578 512 L724 706" stroke="url(#right)"/></g>
</g></g>
</svg>`;
}

let drawn: Theme | undefined;

// iOS shows an apple-touch-startup-image until a home-screen app's page paints, and only one the exact size of
// the screen. It keeps the one linked when the page is added to the home screen, whatever the theme at launch.
export function addStartupImage(theme: Theme): void {
  if (Reflect.get(navigator, "standalone") !== false || theme === drawn) return;
  drawn = theme;
  const { width, height } = screen;
  const scale = devicePixelRatio;
  const image = new Image();
  image.onload = () => {
    // A later theme change may finish first.
    if (drawn !== theme) return;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    let link = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-startup-image"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "apple-touch-startup-image";
      document.head.append(link);
    }
    link.href = canvas.toDataURL();
  };
  image.src = `data:image/svg+xml,${encodeURIComponent(launchSvg(theme, width, height, scale))}`;
}
