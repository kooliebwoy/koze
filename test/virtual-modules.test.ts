import { describe, expect, test } from 'vitest';
import {
  VIRTUAL_MODULE_MAP,
  VIRTUAL_MODULE_NAMES,
  VIRTUAL_MODULE_TYPE_DECLARATIONS,
  buildVirtualModuleTypeDeclarations,
  isKuratchiVirtualModule,
  resolveKuratchiVirtualModule,
  getKuratchiModuleName,
} from '../src/compiler/virtual-modules.ts';

describe('virtual-modules', () => {
  describe('VIRTUAL_MODULE_MAP', () => {
    test('maps environment to runtime path', () => {
      expect(VIRTUAL_MODULE_MAP.environment).toBe('@kuratchi/koze/runtime/environment.js');
    });

    test('maps assets to runtime path', () => {
      expect(VIRTUAL_MODULE_MAP.assets).toBe('@kuratchi/koze/runtime/assets.js');
    });

    test('maps request to runtime path', () => {
      expect(VIRTUAL_MODULE_MAP.request).toBe('@kuratchi/koze/runtime/request.js');
    });

    test('maps navigation to runtime path', () => {
      expect(VIRTUAL_MODULE_MAP.navigation).toBe('@kuratchi/koze/runtime/navigation.js');
    });

    test('maps cookies to runtime path', () => {
      expect(VIRTUAL_MODULE_MAP.cookies).toBe('@kuratchi/koze/runtime/cookies.js');
    });

    test('maps middleware to runtime path', () => {
      expect(VIRTUAL_MODULE_MAP.middleware).toBe('@kuratchi/koze/runtime/middleware-virtual.js');
    });

    test('all paths use consistent ./runtime/*.js pattern', () => {
      for (const [name, path] of Object.entries(VIRTUAL_MODULE_MAP)) {
        expect(path).toMatch(/^@kuratchi\/koze\/runtime\/[\w-]+\.js$/);
      }
    });
  });

  describe('VIRTUAL_MODULE_NAMES', () => {
    test('includes all module names', () => {
      expect(VIRTUAL_MODULE_NAMES).toContain('assets');
      expect(VIRTUAL_MODULE_NAMES).toContain('environment');
      expect(VIRTUAL_MODULE_NAMES).toContain('request');
      expect(VIRTUAL_MODULE_NAMES).toContain('navigation');
      expect(VIRTUAL_MODULE_NAMES).toContain('cookies');
      expect(VIRTUAL_MODULE_NAMES).toContain('middleware');
    });
  });

  describe('isKuratchiVirtualModule', () => {
    test('returns true for koze: prefixed modules', () => {
      expect(isKuratchiVirtualModule('koze:assets')).toBe(true);
      expect(isKuratchiVirtualModule('koze:environment')).toBe(true);
      expect(isKuratchiVirtualModule('koze:request')).toBe(true);
      expect(isKuratchiVirtualModule('koze:navigation')).toBe(true);
      expect(isKuratchiVirtualModule('koze:cookies')).toBe(true);
      expect(isKuratchiVirtualModule('koze:middleware')).toBe(true);
      expect(isKuratchiVirtualModule('koze:unknown')).toBe(true);
    });

    test('returns false for non-kuratchi modules', () => {
      expect(isKuratchiVirtualModule('cloudflare:workers')).toBe(false);
      expect(isKuratchiVirtualModule('koze')).toBe(false);
      expect(isKuratchiVirtualModule('./local-module')).toBe(false);
      expect(isKuratchiVirtualModule('lodash')).toBe(false);
    });
  });

  describe('resolveKuratchiVirtualModule', () => {
    test('resolves known koze:* modules to runtime paths', () => {
      expect(resolveKuratchiVirtualModule('koze:assets')).toBe('@kuratchi/koze/runtime/assets.js');
      expect(resolveKuratchiVirtualModule('koze:environment')).toBe('@kuratchi/koze/runtime/environment.js');
      expect(resolveKuratchiVirtualModule('koze:request')).toBe('@kuratchi/koze/runtime/request.js');
      expect(resolveKuratchiVirtualModule('koze:navigation')).toBe('@kuratchi/koze/runtime/navigation.js');
      expect(resolveKuratchiVirtualModule('koze:cookies')).toBe('@kuratchi/koze/runtime/cookies.js');
      expect(resolveKuratchiVirtualModule('koze:middleware')).toBe('@kuratchi/koze/runtime/middleware-virtual.js');
    });

    test('returns original specifier for unknown koze:* modules', () => {
      expect(resolveKuratchiVirtualModule('koze:unknown')).toBe('koze:unknown');
    });

    test('returns original specifier for non-kuratchi modules', () => {
      expect(resolveKuratchiVirtualModule('cloudflare:workers')).toBe('cloudflare:workers');
      expect(resolveKuratchiVirtualModule('lodash')).toBe('lodash');
    });
  });

  describe('getKuratchiModuleName', () => {
    test('extracts module name from koze: specifier', () => {
      expect(getKuratchiModuleName('koze:assets')).toBe('assets');
      expect(getKuratchiModuleName('koze:environment')).toBe('environment');
      expect(getKuratchiModuleName('koze:request')).toBe('request');
      expect(getKuratchiModuleName('koze:navigation')).toBe('navigation');
      expect(getKuratchiModuleName('koze:cookies')).toBe('cookies');
      expect(getKuratchiModuleName('koze:middleware')).toBe('middleware');
    });

    test('returns null for non-kuratchi specifiers', () => {
      expect(getKuratchiModuleName('cloudflare:workers')).toBe(null);
      expect(getKuratchiModuleName('koze')).toBe(null);
    });
  });

  describe('VIRTUAL_MODULE_TYPE_DECLARATIONS', () => {
    test('declares koze:assets module', () => {
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain("declare module 'koze:assets'");
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export function fetchAsset');
    });

    test('declares koze:environment module', () => {
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain("declare module 'koze:environment'");
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export const dev: boolean');
    });

    test('declares koze:request module', () => {
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain("declare module 'koze:request'");
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export const request: Request');
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export const url: URL');
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export const pathname: string');
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export const params: Record<string, string>');
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export const headers: Headers');
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export const locals: App.Locals');
    });

    test('declares koze:navigation module', () => {
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain("declare module 'koze:navigation'");
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export function redirect');
    });

    test('declares koze:cookies module', () => {
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain("declare module 'koze:cookies'");
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export const cookies: CookieStore');
    });

    test('declares koze:middleware module', () => {
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain("declare module 'koze:middleware'");
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export function defineMiddleware');
    });

    test('declares koze:workflow module', () => {
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain("declare module 'koze:workflow'");
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export function workflowStatus');
    });

    test('declares koze:pipeline module', () => {
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain("declare module 'koze:pipeline'");
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export const pipelines');
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export function sendPipeline');
    });

    test('declares koze:content module', () => {
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain("declare module 'koze:content'");
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('export const content');
      expect(VIRTUAL_MODULE_TYPE_DECLARATIONS).toContain('render(id: string): Promise<RenderedContent | null>');
    });
  });

  describe('koze:workflow', () => {
    test('virtual module is registered in the map', () => {
      expect(VIRTUAL_MODULE_MAP.workflow).toBe('@kuratchi/koze/runtime/workflow.js');
      expect(VIRTUAL_MODULE_NAMES).toContain('workflow');
    });

    test('resolves koze:workflow to runtime path', () => {
      expect(resolveKuratchiVirtualModule('koze:workflow')).toBe('@kuratchi/koze/runtime/workflow.js');
    });
  });

  describe('buildVirtualModuleTypeDeclarations', () => {
    test('emits never as WorkflowName union when no workflows are discovered', () => {
      const decls = buildVirtualModuleTypeDeclarations([]);
      expect(decls).toContain("declare module 'koze:workflow'");
      expect(decls).toContain('export type WorkflowName = never;');
    });

    test('emits a literal string union of discovered workflow names', () => {
      const decls = buildVirtualModuleTypeDeclarations(['container', 'migration', 'host-backup']);
      expect(decls).toContain("export type WorkflowName = 'container' | 'migration' | 'host-backup';");
    });

    test('declares WorkflowStatusOptions shape', () => {
      const decls = buildVirtualModuleTypeDeclarations(['container']);
      expect(decls).toContain('poll?: string | number;');
      expect(decls).toContain('until?: (value: T) => boolean;');
    });

    test('workflowStatus signature binds name to WorkflowName', () => {
      const decls = buildVirtualModuleTypeDeclarations(['container']);
      // Collapse whitespace so the assertion is not sensitive to formatting.
      const flat = decls.replace(/\s+/g, ' ');
      expect(flat).toContain('name: WorkflowName, instanceId: string, options?: WorkflowStatusOptions<T>, ): Promise<WorkflowAsyncValue<T>>');
    });

    test('emits typed pipeline object properties', () => {
      const decls = buildVirtualModuleTypeDeclarations([], ['analytics', 'data-lake']);
      expect(decls).toContain("export type PipelineName = 'analytics' | 'data-lake';");
      expect(decls).toContain('readonly analytics: PipelineHandle;');
      expect(decls).toContain('readonly "data-lake": PipelineHandle;');
    });

    test('emits typed content object properties', () => {
      const decls = buildVirtualModuleTypeDeclarations([], [], ['docs', 'release-notes']);
      expect(decls).toContain("export type ContentName = 'docs' | 'release-notes';");
      expect(decls).toContain('readonly docs: ContentGroup;');
      expect(decls).toContain('readonly "release-notes": ContentGroup;');
    });
  });
});
