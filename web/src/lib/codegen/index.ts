/**
 * Dispatch table for the four target languages.
 */

import type { DeviceConfig } from '../types';
import { generatePython } from './python';
import { generateC } from './c';
import { generateCpp } from './cpp';
import { generateRust } from './rust';
import { toSnakeCase } from './common';

export type GenLang = 'python' | 'c' | 'cpp' | 'rust';

const GENERATORS: Record<GenLang, (d: DeviceConfig) => string> = {
  python: generatePython,
  c: generateC,
  cpp: generateCpp,
  rust: generateRust,
};

const EXTENSIONS: Record<GenLang, string> = {
  python: '.py',
  c: '.h',
  cpp: '.hpp',
  rust: '.rs',
};

const LANG_LABELS: Record<GenLang, string> = {
  python: 'Python 3',
  c: 'C99 (header-only)',
  cpp: 'C++17 (header-only)',
  rust: 'Rust',
};

export const GEN_LANGS: GenLang[] = ['python', 'c', 'cpp', 'rust'];

export function generate(lang: GenLang, device: DeviceConfig): string {
  return GENERATORS[lang](device);
}

export function extensionFor(lang: GenLang): string {
  return EXTENSIONS[lang];
}

export function labelFor(lang: GenLang): string {
  return LANG_LABELS[lang];
}

export function suggestedFilename(lang: GenLang, device: DeviceConfig): string {
  const base = toSnakeCase(device.name) || 'device';
  return `${base}${extensionFor(lang)}`;
}
