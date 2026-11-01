// Agent Treasury — Tailwind preset. Use in tailwind.config.ts: presets: [treasuryPreset]
import type { Config } from 'tailwindcss';

const treasuryPreset: Partial<Config> = {
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: '#0B0D10', deep: '#07080A' },
        surface: { DEFAULT: '#13161B', sunken: '#0F1216', raised: '#1A1E25', hover: '#171B21' },
        track: '#1C2028',
        line: { DEFAULT: '#232832', strong: '#2E3440' },
        ink: { DEFAULT: '#E6E8EC', secondary: '#A9B1BF', muted: '#8A93A3', subtle: '#6B7383' },
        ok: { DEFAULT: '#2ECC71', on: '#06210F' },
        warn: { DEFAULT: '#F5B544', on: '#241703' },
        danger: { DEFAULT: '#E5484D', text: '#FF8A8E' },
        info: '#8AB4FF',
        neutralFill: '#AEB5C1',
        chain: { base: '#3B82F6', ethereum: '#94A3B8', arbitrum: '#38BDF8', solana: '#A78BFA', tron: '#F87171', near: '#2ECC71' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: { balance: ['40px', { lineHeight: '1.1', letterSpacing: '-0.02em' }], sentence: ['18px', '1.55'] },
      borderRadius: { input: '8px', tile: '10px', card: '12px', modal: '14px', sheet: '16px' },
      maxWidth: { content: '1280px' },
      transitionTimingFunction: { out: 'cubic-bezier(.2,.7,.2,1)', sheet: 'cubic-bezier(.2,.9,.3,1)' },
    },
  },
};

export default treasuryPreset;
