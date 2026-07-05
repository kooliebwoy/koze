import { buildRoutesModuleFeatureBlocks } from './routes-module-feature-blocks.js';
import { buildRoutesModuleRuntimeShell } from './routes-module-runtime-shell.js';
import type { GenerateRoutesModuleOptions } from './routes-module-types.js';

export function generateRoutesModule(opts: GenerateRoutesModuleOptions): string {
  const featureBlocks = buildRoutesModuleFeatureBlocks(opts);
  return buildRoutesModuleRuntimeShell(opts, featureBlocks);
}
