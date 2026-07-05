import { getEnv } from './context.js';
import { request } from './request.js';

interface AssetBindingEnv {
  ASSETS?: {
    fetch(input: Request | URL | string): Promise<Response>;
  };
}

function hasUrlScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

function getAssetBaseUrl(): URL {
  return new URL('/', request.url);
}

function toAssetRequest(input: Request | URL | string): Request | URL | string {
  if (input instanceof Request || input instanceof URL) return input;
  if (hasUrlScheme(input)) return input;
  return new URL(input, getAssetBaseUrl());
}

export async function fetchAsset(input: Request | URL | string): Promise<Response> {
  const env = getEnv<AssetBindingEnv>();
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    throw new Error('fetchAsset() requires an ASSETS binding. Add `assets.binding` to your wrangler configuration.');
  }
  return env.ASSETS.fetch(toAssetRequest(input));
}
