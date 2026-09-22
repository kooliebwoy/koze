import { describe, expect, test } from 'vitest';

import {
  VIRTUAL_MODULE_MAP,
  VIRTUAL_MODULE_NAMES,
  buildVirtualModuleTypeDeclarations,
  getKozeModuleName,
  isKozeVirtualModule,
  resolveKozeVirtualModule,
} from '../src/compiler/virtual-modules.ts';

const PRODUCT_MODULES = ['assets', 'access', 'workflow', 'pipeline'];

describe('virtual modules', () => {
  test('contains only Koze language and HTTP application modules', () => {
    expect(VIRTUAL_MODULE_MAP).toEqual({
      environment: '@kuratchi/koze/runtime/environment.js',
      request: '@kuratchi/koze/runtime/request.js',
      navigation: '@kuratchi/koze/runtime/navigation.js',
      cookies: '@kuratchi/koze/runtime/cookies.js',
      middleware: '@kuratchi/koze/runtime/middleware-virtual.js',
      component: '@kuratchi/koze/runtime/component.js',
    });
    expect(VIRTUAL_MODULE_NAMES).toEqual(Object.keys(VIRTUAL_MODULE_MAP));
  });

  test('does not expose Cloudflare product wrappers', () => {
    for (const name of PRODUCT_MODULES) {
      expect(VIRTUAL_MODULE_MAP[name]).toBeUndefined();
      expect(VIRTUAL_MODULE_NAMES).not.toContain(name);
      expect(resolveKozeVirtualModule(`koze:${name}`)).toBe(`koze:${name}`);
    }
  });

  test('resolves known modules and leaves platform imports untouched', () => {
    expect(resolveKozeVirtualModule('koze:request')).toBe('@kuratchi/koze/runtime/request.js');
    expect(resolveKozeVirtualModule('koze:navigation')).toBe('@kuratchi/koze/runtime/navigation.js');
    expect(resolveKozeVirtualModule('cloudflare:workers')).toBe('cloudflare:workers');
    expect(resolveKozeVirtualModule('koze:unknown')).toBe('koze:unknown');
  });

  test('recognizes Koze namespace syntax independently of registration', () => {
    expect(isKozeVirtualModule('koze:request')).toBe(true);
    expect(isKozeVirtualModule('koze:unknown')).toBe(true);
    expect(isKozeVirtualModule('cloudflare:workers')).toBe(false);
    expect(getKozeModuleName('koze:request')).toBe('request');
    expect(getKozeModuleName('cloudflare:workers')).toBeNull();
  });

  test('generates framework declarations without platform product types', () => {
    const declarations = buildVirtualModuleTypeDeclarations(['docs', 'release-notes']);
    expect(declarations).toContain("declare module 'koze:worker'");
    expect(declarations).toContain('export function handleRequest');
    expect(declarations).toContain("declare module 'koze:request'");
    expect(declarations).toContain("declare module 'koze:component'");
    expect(declarations).toContain("declare module 'koze:content'");
    expect(declarations).toContain("export type ContentName = 'docs' | 'release-notes';");
    expect(declarations).toContain('readonly docs: ContentGroup;');
    expect(declarations).toContain('readonly "release-notes": ContentGroup;');
    for (const name of PRODUCT_MODULES) {
      expect(declarations).not.toContain(`declare module 'koze:${name}'`);
    }
  });

  test('declares koze:navigation module', () => {
    const declarations = buildVirtualModuleTypeDeclarations();
    expect(declarations).toContain("declare module 'koze:navigation'");
    expect(declarations).toContain('export function redirect');
  });

  test('declares koze:cookies module', () => {
    const declarations = buildVirtualModuleTypeDeclarations();
    expect(declarations).toContain("declare module 'koze:cookies'");
    expect(declarations).toContain('export const cookies: CookieStore');
  });
});
