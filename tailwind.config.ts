import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: [
          'JetBrains Mono',
          'SF Mono',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
        sans: [
          'IBM Plex Sans JP',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
      },
      colors: {
        bg: {
          DEFAULT: '#0a0a0a',
          panel: '#111111',
          card: '#181818',
        },
        line: '#2a2a2a',
        text: {
          primary: '#e5e5e5',
          secondary: '#999999',
          muted: '#666666',
        },
        accent: {
          green: '#22c55e',
          red: '#ef4444',
          yellow: '#eab308',
          blue: '#3b82f6',
          purple: '#a855f7',
        },
      },
    },
  },
  plugins: [],
};
export default config;
