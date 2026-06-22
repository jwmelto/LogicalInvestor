/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import { Platform } from 'react-native';

const tintColorLight = '#0a7ea4';
const tintColorDark = '#9fc4e0';

export const Colors = {
  light: {
    text: '#11181C',
    background: '#fff',
    tint: tintColorLight,
    icon: '#687076',
    tabIconDefault: '#687076',
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: '#ECEDEE',
    background: '#2b2d32',
    tint: tintColorDark,
    icon: '#9BA1A6',
    tabIconDefault: '#9BA1A6',
    tabIconSelected: tintColorDark,
  },
};

// Semantic palette used by screens and components
export const Palette = {
  light: {
    bg:              '#ffffff',
    surface:         '#f9f9f9',
    surfaceAlt:      '#fafafa',
    border:          '#e0e0e0',
    borderSubtle:    '#f0f0f0',
    text:            '#1a1a1a',
    textSecondary:   '#555555',
    textMuted:       '#888888',
    textFaint:       '#999999',
    tint:            '#0a7ea4',
    newBadge:        '#22c55e',
    inputBg:         '#ffffff',
    inputBorder:     '#dddddd',
    placeholder:     '#aaaaaa',
    resubscribeBg:   '#f0f0f0',
    resubscribeText: '#0066cc',
  },
  dark: {
    bg:              '#2b2d32',
    surface:         '#35373d',
    surfaceAlt:      '#303236',
    border:          '#444850',
    borderSubtle:    '#3a3c42',
    text:            '#f0f0f0',
    textSecondary:   '#b0b8c8',
    textMuted:       '#8090a0',
    textFaint:       '#606878',
    tint:            '#9fc4e0',
    newBadge:        '#4ade80',
    inputBg:         '#35373d',
    inputBorder:     '#444850',
    placeholder:     '#666c7a',
    resubscribeBg:   '#3a3c42',
    resubscribeText: '#9fc4e0',
  },
};

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
