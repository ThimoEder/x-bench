// Inline styles set CSS custom properties (--depth, --pill, --dock-inner, ...).
import "react";

declare module "react" {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}
