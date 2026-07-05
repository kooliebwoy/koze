/**
 * CSS Pipeline — processes CSS files with optional Tailwind and Lightning CSS minification.
 *
 * This module handles:
 * 1. Tailwind CSS processing via @tailwindcss/postcss (when enabled in config)
 * 2. CSS minification via Lightning CSS (always available)
 *
 * All processing is local — no network calls. PostCSS and Lightning CSS are
 * Node.js libraries that run entirely on the user's machine.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

export interface CssConfigEntry {
  /**
   * Enable Tailwind CSS processing.
   * Requires `tailwindcss` to be installed in the project.
   */
  tailwind?: boolean;

  /**
   * Tailwind plugins to load (e.g., 'daisyui', '@tailwindcss/forms').
   * Only used when `tailwind: true`.
   */
  plugins?: string[];

  /**
   * Enable CSS minification via Lightning CSS.
   * Defaults to true in production builds.
   */
  minify?: boolean;
}

export interface CssProcessOptions {
  /** Absolute path to the CSS file being processed */
  filePath: string;
  /** CSS content to process */
  content: string;
  /** Project root directory */
  projectDir: string;
  /** CSS configuration supplied by the orchestrator (Vite plugin or legacy CLI). */
  cssConfig: CssConfigEntry | null;
  /** Whether this is a dev build */
  isDev: boolean;
}

export interface CssProcessResult {
  /** Processed CSS content */
  css: string;
  /** Whether Tailwind processing was applied */
  tailwindApplied: boolean;
  /** Whether minification was applied */
  minified: boolean;
}

/**
 * Check if tailwindcss is installed in the project.
 */
function hasTailwindInstalled(projectDir: string): boolean {
  const candidates = [
    path.join(projectDir, 'node_modules', 'tailwindcss'),
    path.join(projectDir, 'node_modules', '@tailwindcss', 'postcss'),
    path.join(projectDir, '..', 'node_modules', 'tailwindcss'),
    path.join(projectDir, '..', 'node_modules', '@tailwindcss', 'postcss'),
    path.join(projectDir, '..', '..', 'node_modules', 'tailwindcss'),
    path.join(projectDir, '..', '..', 'node_modules', '@tailwindcss', 'postcss'),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate));
}


/**
 * Process CSS with Tailwind via @tailwindcss/postcss.
 * Returns the processed CSS or null if Tailwind is not available.
 */
async function processTailwind(
  content: string,
  filePath: string,
  projectDir: string,
  _plugins: string[],
): Promise<string | null> {
  try {
    // Resolve from the project directory so we pick up the user's installed packages
    const require = createRequire(path.join(projectDir, 'package.json'));
    const postcss = (await import(require.resolve('postcss'))).default;
    const tailwindPlugin = await import(require.resolve('@tailwindcss/postcss'));

    const plugin = typeof tailwindPlugin.default === 'function'
      ? tailwindPlugin.default()
      : tailwindPlugin.default;

    const processor = postcss([plugin]);

    const result = await processor.process(content, {
      from: filePath,
      to: filePath.replace(/\.css$/, '.out.css'),
    });

    return result.css;
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.message?.includes('Cannot find module') || err.code === 'ERR_MODULE_NOT_FOUND') {
      console.warn('[koze] css.tailwind: true but @tailwindcss/postcss not found. Install with: npm install tailwindcss @tailwindcss/postcss postcss');
      return null;
    }
    throw error;
  }
}

/**
 * Minify CSS with Lightning CSS.
 * Returns the minified CSS or the original if Lightning CSS is not available.
 */
async function minifyCss(content: string, filePath: string, projectDir: string): Promise<string> {
  try {
    const require = createRequire(path.join(projectDir, 'package.json'));
    const lightningcss = await import(require.resolve('lightningcss'));

    const result = lightningcss.transform({
      filename: path.basename(filePath),
      code: Buffer.from(content),
      minify: true,
      targets: {
        chrome: 100 << 16,
        firefox: 100 << 16,
        safari: 15 << 16,
      },
    });

    return result.code.toString();
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.message?.includes('Cannot find module') || err.code === 'ERR_MODULE_NOT_FOUND') {
      return content;
    }
    console.warn(`[koze] CSS minification failed for ${filePath}:`, err.message);
    return content;
  }
}

/**
 * Process a CSS file through the CSS pipeline.
 *
 * Pipeline order:
 * 1. Tailwind processing (if enabled and installed)
 * 2. Minification (if enabled, defaults to true in production)
 */
export async function processCss(options: CssProcessOptions): Promise<CssProcessResult> {
  const { filePath, content, projectDir, cssConfig, isDev } = options;

  let css = content;
  let tailwindApplied = false;
  let minified = false;

  if (cssConfig?.tailwind) {
    if (!hasTailwindInstalled(projectDir)) {
      console.warn('[koze] css.tailwind: true but tailwindcss not installed. Install with: npm install tailwindcss @tailwindcss/postcss postcss');
    } else {
      const processed = await processTailwind(css, filePath, projectDir, cssConfig.plugins ?? []);
      if (processed !== null) {
        css = processed;
        tailwindApplied = true;
      }
    }
  }

  // Minification via Lightning CSS (optional — only if lightningcss is installed)
  const shouldMinify = cssConfig?.minify ?? !isDev;
  if (shouldMinify) {
    const minifiedCss = await minifyCss(css, filePath, projectDir);
    if (minifiedCss !== css) {
      css = minifiedCss;
      minified = true;
    }
  }

  return { css, tailwindApplied, minified };
}

/**
 * Check if a file is a CSS file that should be processed.
 */
export function isCssFile(filePath: string): boolean {
  return filePath.endsWith('.css');
}
