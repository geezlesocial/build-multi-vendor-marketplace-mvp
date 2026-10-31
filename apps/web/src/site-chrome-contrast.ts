import type { SiteChromeConfiguration } from './site-chrome-types.js';

function luminance(hex: string) {
  const values = hex.slice(1).match(/.{2}/g);
  if (!values || !/^#[\da-f]{6}$/i.test(hex)) return null;
  const channels = values.map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

export function contrastRatio(foreground: string, background: string) {
  const first = luminance(foreground);
  const second = luminance(background);
  return first === null || second === null ? null : (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function siteChromeContrastWarnings(configuration: SiteChromeConfiguration, scope: 'header' | 'footer') {
  const palette = configuration[scope];
  const checks = scope === 'header'
    ? [['Header text / background', palette.textColor, palette.backgroundColor], ['White text / accent controls', '#ffffff', palette.accentColor]] as const
    : [['Footer text / background', palette.textColor, palette.backgroundColor], ['Footer links / background', palette.accentColor, palette.backgroundColor]] as const;
  return checks.flatMap(([label, foreground, background]) => {
    const ratio = contrastRatio(foreground, background);
    return ratio !== null && ratio < 4.5 ? [`${label}: ${ratio.toFixed(2)}:1 (WCAG AA recommends at least 4.5:1 for normal text).`] : [];
  });
}
