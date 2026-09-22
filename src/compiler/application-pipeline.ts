/**
 * Deterministic application compilation for Koze routes, layouts, app shells,
 * and browser fragments. Build integrations provide project state and consume
 * the returned code/dependency metadata; this module has no Vite hooks.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

import type { ComponentCompiler } from './component-pipeline.js';
import { discoverContentEntries } from './content-discovery.js';
import { componentFuncName } from './compiler-shared.js';
import {
	type AugmentedActionAlias,
	parseFile,
	rewriteAugmentedActionInitializersForClient,
	stripAugmentImportSpecifier,
	stripAugmentedActionDeclarations,
} from './parser.js';
import {
	buildReactiveRuntimeScriptTag,
} from './root-layout-pipeline.js';
import {
	buildClientScopeMount,
	buildSelectiveSsrPrelude,
	transformReactiveClientScript,
} from './script-transform.js';
import { parseKuratchiSfc } from './sfc-parser.js';
import { appendInlineSourceMap, createKuratchiSourceMap } from './source-map.js';
import {
	analyzeClientTemplateReactivity,
	buildClientTemplateRenderersExpression,
	compileTemplate,
} from './template.js';
import { resolveKozeVirtualModule } from './virtual-modules.js';

export interface ClientFragment {
	source: string;
	importerAbsPath: string;
	kind?: 'leading' | 'bridge';
	hydrateVars?: string[];
	handlerRegistry?: CompilerClientRouteRegistry;
	needsBridge?: boolean;
	reactiveNames?: Set<string>;
	blockRenderersExpr?: string;
}

const REQUEST_IMPORT_FALLBACKS: Record<string, string> = {
	url: 'new URL("http://localhost/")',
	pathname: '"/"',
	searchParams: 'new URLSearchParams()',
	params: '{}',
	slug: 'undefined',
	method: '"GET"',
};

export const NESTED_LAYOUT_VIRTUAL_PREFIX = 'koze:layout/';
export const CLIENT_BRIDGE_HASH = 'bridge';

export function layoutModuleHash(layoutAbsPath: string): string {
	return crypto.createHash('sha1').update(layoutAbsPath).digest('hex').slice(0, 10);
}

export function routeModuleHash(routeAbsPath: string): string {
	return crypto.createHash('sha1').update(routeAbsPath).digest('hex').slice(0, 10);
}

function componentRpcHash(sourceKey: string, importedName: string): string {
	return crypto.createHash('sha1').update(`${sourceKey}:${importedName}`).digest('hex').slice(0, 12);
}

export function leadingScriptHash(importerAbsPath: string, source: string): string {
	return crypto
		.createHash('sha1')
		.update('leading:' + importerAbsPath + '\0' + source)
		.digest('hex')
		.slice(0, 12);
}

/**
 * Inspect the leading-script source and return the names of every
 * top-level declaration whose initializer reaches an `await` at module
 * evaluation time. Those are the SSR-resolved values the server computes
 * per request; we serialize them into the HTML payload so the client
 * copy of the script can read them without re-running the work.
 *
 * Supported initializer shapes:
 *   const X = await fn();                           // direct
 *   const X = cond ? await fn() : other;            // ternary (either branch)
 *   const X = cond ? other : await fn();
 *   const X = (await fn());                         // parenthesized
 *   const X = (a, await fn());                      // sequence (rare)
 *
 * Nested awaits inside arrow bodies / functions / blocks are NOT
 * collected — those don't fire at module-eval time.
 */
function initializerContainsTopLevelAwait(expr: ts.Expression): boolean {
	if (ts.isAwaitExpression(expr)) return true;
	if (ts.isParenthesizedExpression(expr)) {
		return initializerContainsTopLevelAwait(expr.expression);
	}
	if (ts.isConditionalExpression(expr)) {
		return (
			initializerContainsTopLevelAwait(expr.whenTrue) ||
			initializerContainsTopLevelAwait(expr.whenFalse)
		);
	}
	if (ts.isBinaryExpression(expr)) {
		// Logical / nullish short-circuit: `x ?? await fn()`, `x || await fn()`.
		const op = expr.operatorToken.kind;
		if (
			op === ts.SyntaxKind.QuestionQuestionToken ||
			op === ts.SyntaxKind.AmpersandAmpersandToken ||
			op === ts.SyntaxKind.BarBarToken ||
			op === ts.SyntaxKind.CommaToken
		) {
			return (
				initializerContainsTopLevelAwait(expr.left) ||
				initializerContainsTopLevelAwait(expr.right)
			);
		}
		return false;
	}
	return false;
}

/**
 * Walk the subtree under `node` (without crossing into nested functions,
 * arrow bodies, class/method bodies — those don't execute at module-eval
 * time) and report whether any `await` expression lives within. Used to
 * classify top-level statements: anything that contains an await is SSR-
 * only work and gets stripped from the browser bundle.
 */
function containsAwaitInControlFlow(node: ts.Node): boolean {
	if (ts.isAwaitExpression(node)) return true;
	// Stop at any construct that creates a new callable boundary. `await`
	// inside a function body will fire only if the function is invoked,
	// which we can't know statically — err on the side of preserving.
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isClassDeclaration(node) ||
		ts.isClassExpression(node)
	) {
		return false;
	}
	let found = false;
	node.forEachChild((child) => {
		if (found) return;
		if (containsAwaitInControlFlow(child)) found = true;
	});
	return found;
}

/**
 * Walk the subtree under `node` (same "no-function-body" rule as above)
 * and collect every identifier that appears as the LHS of an assignment
 * (plain `=`, compound `+=`, `-=`, etc.) or as the operand of `++`/`--`.
 * Only bare identifiers are collected — property-access targets like
 * `obj.field = …` are ignored (they mutate the object the hydrated
 * binding points to, not the binding itself, so hydration still works).
 */
function collectReassignedIdentifiers(node: ts.Node, out: Set<string>): void {
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isClassDeclaration(node) ||
		ts.isClassExpression(node)
	) {
		return;
	}
	if (ts.isBinaryExpression(node)) {
		const op = node.operatorToken.kind;
		const isAssignmentOp =
			op === ts.SyntaxKind.EqualsToken ||
			op === ts.SyntaxKind.PlusEqualsToken ||
			op === ts.SyntaxKind.MinusEqualsToken ||
			op === ts.SyntaxKind.AsteriskEqualsToken ||
			op === ts.SyntaxKind.SlashEqualsToken ||
			op === ts.SyntaxKind.PercentEqualsToken ||
			op === ts.SyntaxKind.AmpersandEqualsToken ||
			op === ts.SyntaxKind.BarEqualsToken ||
			op === ts.SyntaxKind.CaretEqualsToken ||
			op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
			op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
			op === ts.SyntaxKind.BarBarEqualsToken ||
			op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
			op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
			op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken;
		if (isAssignmentOp && ts.isIdentifier(node.left)) {
			out.add(node.left.text);
		}
	}
	if (
		(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
		(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
		ts.isIdentifier(node.operand)
	) {
		out.add(node.operand.text);
	}
	node.forEachChild((child) => collectReassignedIdentifiers(child, out));
}

function collectBindingIdentifiers(name: ts.BindingName, out: string[]): void {
	if (ts.isIdentifier(name)) {
		out.push(name.text);
		return;
	}
	for (const element of name.elements) {
		if (ts.isOmittedExpression(element)) continue;
		collectBindingIdentifiers(element.name, out);
	}
}

export interface LeadingHydrateTargets {
	/**
	 * Top-level `const|let|var X = await …` identifiers (plus ternary /
	 * short-circuit variants). The initializer itself reaches an `await`
	 * at module-eval time — the entire declaration is rewritten on the
	 * client to read from the hydrate payload.
	 */
	initAwaitVars: string[];
	/**
	 * Top-level `let X = <literal>` identifiers (or `let X;`) that are
	 * reassigned from within a statement whose body contains an `await`.
	 * These are the "imperative SSR lets" pattern — declared with a
	 * placeholder, mutated inside `if/try/…` blocks that do async work.
	 * The client rewrite is: keep the declaration, seed its initializer
	 * from the hydrate payload (falling back to the original init so
	 * unhydrated reruns don't crash), then strip the async blocks that
	 * mutate it since those values are already the SSR-final values.
	 */
	reassignedLets: string[];
}

function collectLeadingHydrateTargets(scriptBody: string): LeadingHydrateTargets {
	const empty: LeadingHydrateTargets = { initAwaitVars: [], reassignedLets: [] };
	if (!scriptBody.trim()) return empty;
	let sourceFile: ts.SourceFile;
	try {
		sourceFile = ts.createSourceFile(
			'kuratchi-leading-script.ts',
			scriptBody,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
	} catch {
		return empty;
	}

	const initAwaitVars: string[] = [];
	// Map every top-level `let` identifier to its declaration so we can
	// decide later whether to hydrate. `const` bindings can't be reassigned
	// so there's no point collecting them here — their initializer was
	// already handled by `initAwaitVars` above.
	const topLevelLets = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		const isLet = (statement.declarationList.flags & ts.NodeFlags.Let) !== 0;
		const isVar =
			(statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
		for (const decl of statement.declarationList.declarations) {
			if (decl.initializer && initializerContainsTopLevelAwait(decl.initializer)) {
				const names: string[] = [];
				collectBindingIdentifiers(decl.name, names);
				initAwaitVars.push(...names);
				continue;
			}
			if (!ts.isIdentifier(decl.name)) continue;
			const name = decl.name.text;
			if (isLet || isVar) topLevelLets.add(name);
		}
	}

	// Walk each top-level statement. If the statement body contains an
	// `await` (via `containsAwaitInControlFlow`), collect the identifiers
	// it reassigns. Any of those identifiers that is ALSO a top-level
	// `let`/`var` becomes a hydration target.
	const reassignedLets = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (ts.isVariableStatement(statement)) continue; // declarations themselves handled above
		if (!containsAwaitInControlFlow(statement)) continue;
		const reassigned = new Set<string>();
		collectReassignedIdentifiers(statement, reassigned);
		for (const name of reassigned) {
			if (topLevelLets.has(name)) reassignedLets.add(name);
		}
	}

	return {
		initAwaitVars,
		reassignedLets: Array.from(reassignedLets),
	};
}

/**
 * AST-driven rewrite that transforms the leading script's source into its
 * browser-shaped equivalent. Two concerns, both at module-top-level:
 *
 *   1. "Init-await" declarations (`const X = await fn()`, incl. ternary/
 *      short-circuit variants): the whole declaration's initializer is
 *      swapped for `__kozeReadData("X")`. Type annotation dropped —
 *      the SSR-serialized value is the source of truth.
 *
 *   2. "Reassigned-let" declarations (`let X = <literal>` mutated from
 *      inside a top-level block that contains an `await`): the
 *      declaration is preserved but its initializer becomes
 *      `__kozeReadData("X") ?? <originalInitOrUndefined>`. Then every
 *      top-level statement whose body contains an `await` is stripped,
 *      because it exists only to populate those lets — and the hydration
 *      payload already carries the post-eval result.
 *
 * Everything else — helper functions, non-async branches, template
 * expressions — passes through untouched. We use the TypeScript compiler
 * API to guarantee we handle multi-line initializers, comments, template
 * literals, and nested ternaries correctly. Regex-based replacement would
 * misfire on any of those.
 */
function rewriteLeadingScriptForBrowser(
	scriptBody: string,
	initAwaitVars: Set<string>,
	reassignedLets: Set<string>,
): string {
	const sourceFile = ts.createSourceFile(
		'kuratchi-leading-script.ts',
		scriptBody,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });

	const makeHydrateRead = (factory: ts.NodeFactory, name: string): ts.CallExpression =>
		factory.createCallExpression(
			factory.createIdentifier('__kozeReadData'),
			undefined,
			[factory.createStringLiteral(name)],
		);

	const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
		const factory = context.factory;
		return (file) => {
			const newStatements: ts.Statement[] = [];
			for (const statement of file.statements) {
				// Variable declarations get rewritten to pull from hydrate.
				if (ts.isVariableStatement(statement)) {
					const decls: ts.VariableDeclaration[] = [];
					for (const decl of statement.declarationList.declarations) {
						if (!ts.isIdentifier(decl.name)) {
							if (decl.initializer && initializerContainsTopLevelAwait(decl.initializer)) {
								const names: string[] = [];
								collectBindingIdentifiers(decl.name, names);
								for (const name of names) {
									if (!initAwaitVars.has(name)) continue;
									decls.push(
										factory.createVariableDeclaration(
											factory.createIdentifier(name),
											undefined,
											undefined,
											makeHydrateRead(factory, name),
										),
									);
								}
							} else {
								decls.push(decl);
							}
							continue;
						}
						const name = decl.name.text;
						if (initAwaitVars.has(name)) {
							decls.push(factory.updateVariableDeclaration(
								decl,
								decl.name,
								decl.exclamationToken,
								undefined, // drop type — SSR value wins
								makeHydrateRead(factory, name),
							));
							continue;
						}
						if (reassignedLets.has(name)) {
							// Preserve the original initializer (or `undefined`
							// if `let X;` with no init) as a fallback. `??`
							// is correct: JSON.parse can't produce `undefined`,
							// so `null`-valued hydrates fall through to the
							// author's original init, matching SSR behavior.
							const fallback = decl.initializer ?? factory.createIdentifier('undefined');
							const hydrateWithFallback = factory.createBinaryExpression(
								makeHydrateRead(factory, name),
								factory.createToken(ts.SyntaxKind.QuestionQuestionToken),
								fallback,
							);
							decls.push(factory.updateVariableDeclaration(
								decl,
								decl.name,
								decl.exclamationToken,
								undefined,
								hydrateWithFallback,
							));
							continue;
						}
						decls.push(decl);
					}
					newStatements.push(
						factory.updateVariableStatement(
							statement,
							statement.modifiers,
							factory.updateVariableDeclarationList(statement.declarationList, decls),
						),
					);
					continue;
				}

				// Top-level statements whose bodies contain `await` exist only
				// to populate the SSR lets we just hydrated. On the client
				// those lets already carry the post-eval values, so we skip
				// the whole statement. Nested functions are NOT flagged by
				// `containsAwaitInControlFlow` (they might be referenced by
				// event handlers that DO run client-side), so that path is
				// preserved.
				if (containsAwaitInControlFlow(statement)) continue;

				newStatements.push(statement);
			}

			return factory.updateSourceFile(file, newStatements);
		};
	};

	const result = ts.transform(sourceFile, [transformer]);
	const printed = printer.printFile(result.transformed[0] as ts.SourceFile);
	result.dispose();
	return printed;
}

/**
 * Produce the BROWSER-SHAPE version of the leading script. Three changes:
 *
 *   1. Top-level `const|let|var X = await …` declarations are rewritten to
 *      `const X = (typeof window !== 'undefined' && window.__kozeData)
 *        ? window.__kozeData.X : undefined;`
 *      so the client can read the value the server computed. `await`
 *      cannot run in a non-async module-eval context against a `$server/*`
 *      RPC stub without turning the top-level script into an async
 *      sequence; hydration keeps evaluation synchronous and predictable.
 *
 *   2. `import … from 'koze:request'` is replaced with synthesized
 *      `const` declarations reading from `window.location`, so the same
 *      aliases (`params`, `searchParams`, `pathname`, etc.) resolve in
 *      the browser.
 *
 *   3. `import … from 'koze:environment'` is replaced with a literal
 *      `const dev = <bool>;` matching the build-time env.
 *
 * Everything else — `$server/*` imports, `$lib/*` imports, helper
 * functions, non-await top-level consts, event listeners, etc. —
 * passes through unchanged. `$server/*` imports become RPC stubs
 * transparently via the existing client-env resolver.
 */
/**
 * Prepended to every leading-script browser bundle. Reads the JSON blob
 * the server inlined under `<script type="application/json"
 * id="__koze_data">`. Using `application/json` keeps the browser's
 * script parser in data mode — the payload is never interpreted as JS
 * even if it contains `</script>`-like sequences or looks like code — so
 * authors can stare at View Source without worrying what's "live" there.
 *
 * If the element is missing (route shipped with no SSR data, or the
 * script runs in a stale page) the helper returns `undefined`; author
 * code is expected to have started with `x && x.foo` idioms anyway.
 */
const LEADING_FRAGMENT_HYDRATE_PRELUDE = `// koze: SSR data hydrate helper
const __kozeReadData = (key) => {
	if (typeof document === 'undefined') return undefined;
	const nodes = Array.from(document.querySelectorAll('#__koze_data'));
	if (nodes.length === 0) return undefined;
	const merged = {};
	for (const el of nodes) {
		if (!el || !el.textContent) continue;
		try {
			const data = JSON.parse(el.textContent);
			if (data && typeof data === 'object') Object.assign(merged, data);
		} catch {
			// Ignore malformed fragments and keep scanning later blobs.
		}
	}
	return merged == null ? undefined : merged[key];
};
`;

function removeSourceRanges(source: string, ranges: Array<{ start: number; end: number }>): string {
	if (ranges.length === 0) return source;
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	let cursor = 0;
	let out = '';
	for (const range of sorted) {
		out += source.slice(cursor, range.start);
		cursor = range.end;
	}
	out += source.slice(cursor);
	return out.trim();
}

function statementRemovalRange(source: string, statement: ts.Statement): { start: number; end: number } {
	let start = statement.getFullStart();
	let end = statement.end;
	if (source[end] === ';') end += 1;
	while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end += 1;
	if (source[end] === '\r' && source[end + 1] === '\n') end += 2;
	else if (source[end] === '\n') end += 1;
	return { start, end };
}

function stripRouteServerOnlyPartsForClient(source: string): string {
	const sourceFile = ts.createSourceFile(
		'koze-client-route.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const ranges: Array<{ start: number; end: number }> = [];
	for (const statement of sourceFile.statements) {
		if (
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text === 'cloudflare:workers' &&
			!statement.importClause?.isTypeOnly
		) {
			ranges.push(statementRemovalRange(source, statement));
			continue;
		}
		if (
			ts.isFunctionDeclaration(statement) &&
			statement.name?.text === 'load' &&
			statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
		) {
			ranges.push(statementRemovalRange(source, statement));
		}
	}
	return removeSourceRanges(source, ranges);
}

function mergeImportDeclarations(source: string): string {
	if (!source.trim()) return source;
	const sourceFile = ts.createSourceFile(
		'kuratchi-merged-imports.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
	const moduleEntries = new Map<string, {
		defaultImport: string | null;
		namespaceImport: string | null;
		named: Map<string, string>;
		sideEffectOnly: boolean;
	}>();
	const passthrough: ts.Statement[] = [];

	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
			passthrough.push(statement);
			continue;
		}
		const moduleSpecifier = statement.moduleSpecifier.text;
		const entry = moduleEntries.get(moduleSpecifier) ?? {
			defaultImport: null,
			namespaceImport: null,
			named: new Map<string, string>(),
			sideEffectOnly: false,
		};
		const clause = statement.importClause;
		if (!clause) {
			entry.sideEffectOnly = true;
			moduleEntries.set(moduleSpecifier, entry);
			continue;
		}
		if (clause.name && !entry.defaultImport) entry.defaultImport = clause.name.text;
		if (clause.namedBindings) {
			if (ts.isNamespaceImport(clause.namedBindings)) {
				if (!entry.namespaceImport) entry.namespaceImport = clause.namedBindings.name.text;
			} else if (ts.isNamedImports(clause.namedBindings)) {
				for (const element of clause.namedBindings.elements) {
					const localName = element.name.text;
					if (entry.named.has(localName)) continue;
					entry.named.set(localName, element.propertyName?.text ?? localName);
				}
			}
		}
		moduleEntries.set(moduleSpecifier, entry);
	}

	const importStatements: ts.Statement[] = [];
	for (const [moduleSpecifier, entry] of moduleEntries) {
		if (entry.sideEffectOnly && !entry.defaultImport && !entry.namespaceImport && entry.named.size === 0) {
			importStatements.push(ts.factory.createImportDeclaration(
				undefined,
				undefined,
				ts.factory.createStringLiteral(moduleSpecifier),
				undefined,
			));
			continue;
		}
		const namedImports = entry.named.size > 0
			? ts.factory.createNamedImports(
				Array.from(entry.named.entries()).map(([localName, importedName]) =>
					ts.factory.createImportSpecifier(
						false,
						importedName === localName ? undefined : ts.factory.createIdentifier(importedName),
						ts.factory.createIdentifier(localName),
					),
				),
			)
			: undefined;
		const namedBindings = entry.namespaceImport
			? ts.factory.createNamespaceImport(ts.factory.createIdentifier(entry.namespaceImport))
			: namedImports;
		importStatements.push(ts.factory.createImportDeclaration(
			undefined,
			ts.factory.createImportClause(
				false,
				entry.defaultImport ? ts.factory.createIdentifier(entry.defaultImport) : undefined,
				namedBindings,
			),
			ts.factory.createStringLiteral(moduleSpecifier),
			undefined,
		));
	}

	const mergedSourceFile = ts.factory.updateSourceFile(
		sourceFile,
		ts.factory.createNodeArray([...importStatements, ...passthrough]),
	);
	return printer.printFile(mergedSourceFile);
}

function transformLeadingScriptForClient(
	scriptBody: string,
	hydrateTargets: LeadingHydrateTargets,
	requestImports: Array<{ exportName: string; alias: string }>,
	isProduction: boolean,
	reactiveNames?: Iterable<string>,
	blockRenderersExpr?: string,
	actionAliases: AugmentedActionAlias[] = [],
	extraScopeNames?: Iterable<string>,
	ownerId?: string,
): string {
	// 1. Rewrite the script body for the browser:
	//    - init-await declarations: initializer swapped for hydrate read
	//    - reassigned-let declarations: initializer wrapped in a hydrate
	//      read with `??` fallback to the original literal
	//    - every top-level statement whose body contains `await`:
	//      dropped, since those ran SSR and their effects were serialized
	let out = scriptBody;
	const hadReactiveSyntax = /\$\s*:/.test(scriptBody);
	out = stripRouteServerOnlyPartsForClient(out);
	if (hydrateTargets.initAwaitVars.length > 0 || hydrateTargets.reassignedLets.length > 0) {
		out = rewriteLeadingScriptForBrowser(
			out,
			new Set(hydrateTargets.initAwaitVars),
			new Set(hydrateTargets.reassignedLets),
		);
	}

	// 2. Swap `koze:request` imports for browser-readable aliases.
	// `params` reads from the SSR-hydrated data blob (route params aren't
	// visible to `window.location` alone — they come from the matched
	// route pattern). Everything else derives from `window.location`.
	if (requestImports.length > 0) {
		out = out.replace(
			/import\s*\{[^}]*\}\s*from\s*['"](?:koze|kuratchi):request['"]\s*;?\s*/g,
			'',
		);
		const lines: string[] = [
			`const __kozeUrl = new URL(window.location.href);`,
			`const __kozeParams = __kozeReadData('__params') ?? {};`,
		];
		for (const imp of requestImports) {
			switch (imp.exportName) {
				case 'url':
					lines.push(`const ${imp.alias} = __kozeUrl;`);
					break;
				case 'pathname':
					lines.push(`const ${imp.alias} = __kozeUrl.pathname;`);
					break;
				case 'searchParams':
					lines.push(`const ${imp.alias} = __kozeUrl.searchParams;`);
					break;
				case 'params':
					lines.push(`const ${imp.alias} = __kozeParams;`);
					break;
				case 'slug':
					lines.push(
						`const ${imp.alias} = __kozeParams.slug ?? Object.values(__kozeParams)[0];`,
					);
					break;
				case 'method':
					lines.push(`const ${imp.alias} = 'GET';`);
					break;
			}
		}
		out = lines.join('\n') + '\n' + out;
	}

	// 3. `koze:environment` → `const dev = …;`. Koze uses
	// `globalThis.__koze_DEV__`; we inline it because the client
	// fragment is bundled per environment and the value is static.
	out = out.replace(
		/import\s*\{\s*([^}]*)\s*\}\s*from\s*['"](?:koze|kuratchi):environment['"]\s*;?\s*/g,
		(_m, bindings: string) => {
			const aliases = bindings
				.split(',')
				.map((b: string) => b.trim().split(/\s+as\s+/).pop() ?? '')
				.filter((name: string) => /^[A-Za-z_$][\w$]*$/.test(name));
			return aliases.map((alias: string) => `const ${alias} = ${!isProduction};`).join('\n') + '\n';
		},
	);
	out = rewriteBrowserNavigationImports(out);

	// Prepend the hydrate helper whenever ANY bridge from SSR → browser
	// is in play (hydrated await vars OR a `koze:request` `params`
	// import). The helper is a tiny arrow function + one DOM read; the
	// extra bytes are negligible and having it unconditionally present
	// means authors can call `__kozeReadData(...)` from their own
	// code if they want to read additional SSR-serialized values.
	out = stripKuratchiComponentImports(out);
	out = rewriteAugmentedActionInitializersForClient(out, actionAliases);
	out = stripAugmentImportSpecifier(out);

	const needsHydrateHelper =
		hydrateTargets.initAwaitVars.length > 0 ||
		hydrateTargets.reassignedLets.length > 0 ||
		requestImports.length > 0;
	if (needsHydrateHelper) {
		out = LEADING_FRAGMENT_HYDRATE_PRELUDE + out;
	}
	const reactiveNameList = reactiveNames ? Array.from(reactiveNames) : [];
	const needsReactiveRuntime =
		hadReactiveSyntax ||
		reactiveNameList.length > 0 ||
		!!blockRenderersExpr;
	const mountSource = out;
	if (needsReactiveRuntime) {
		out = transformReactiveClientScript(out, {
			forceRuntime: true,
			reactiveNames: reactiveNameList,
		});
		out += '\n' + buildClientScopeMount(
			mountSource,
			reactiveNameList,
			blockRenderersExpr,
			undefined,
			undefined,
			extraScopeNames,
			ownerId,
		);
	}

	return out;
}

function rewriteBrowserNavigationImports(source: string): string {
	return source.replace(
		/import\s*\{\s*([^}]*)\s*\}\s*from\s*['"](?:koze|kuratchi):navigation['"]\s*;?\s*/g,
		(_match, bindings: string) => {
			const browserBindings = bindings
				.split(',')
				.map((binding: string) => binding.trim())
				.filter(Boolean)
				.map((binding: string) => {
					const aliasMatch = binding.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
					if (aliasMatch) return { exported: aliasMatch[1], local: aliasMatch[2] };
					return { exported: binding, local: binding };
				})
				.filter((binding: { exported: string; local: string }) =>
					binding.exported === 'navigateTo' || binding.exported === 'refreshRoute',
				);
			if (browserBindings.length === 0) return '';
			const rewrittenBindings = browserBindings
				.map((binding: { exported: string; local: string }) =>
					binding.exported === binding.local ? binding.exported : `${binding.exported} as ${binding.local}`,
				)
				.join(', ');
			return `import { ${rewrittenBindings} } from ${JSON.stringify(resolveKozeVirtualModule('koze:navigation'))};\n`;
		},
	);
}

function stripKuratchiComponentImports(source: string): string {
	return source.replace(
		/^[ \t]*import\s+[^\n;]+?\s+from\s+['"][^'"]+\.(?:koze|kuratchi)['"][ \t]*;?[ \t]*(?:\r?\n)?/gm,
		'',
	);
}

/**
 * A `<script>` block is a "client fragment candidate" when it is not the
 * leading script AND contains at least one ES-module import. Without
 * imports, there is nothing to bundle — the block can stay inline (and
 * the existing Kuratchi template compiler preserves it as-is).
 *
 * NB: we match across multiple lines because named-import lists often
 * break across lines in hand-authored code (`import {\n a,\n b\n } from`).
 * The original regex used `.+` which doesn't cross newlines; that bug
 * caused multi-line imports to be treated as "no imports" and the entire
 * `<script>` block — raw TypeScript, `$server/*` and all — got echoed
 * into the rendered HTML response.
 */
/**
 * Count the net brace delta in a compiled-template body, ignoring any
 * braces inside string literals (single, double, or backtick) and
 * template-literal interpolations. Used as a pre-Rollup sanity check
 * so a stray `}` in an author's template surfaces as a clear error
 * instead of a downstream "return not allowed here".
 *
 * Returns 0 for balanced bodies, positive for extra openers, negative
 * for extra closers.
 */
function controlFlowBraceImbalance(src: string): number {
	let depth = 0;
	let quote: '"' | "'" | '`' | null = null;
	let templateDepth = 0; // depth of `${…}` interpolations inside a backtick
	let escaped = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		// Single-line and block comments — skip.
		if (!quote) {
			if (ch === '/' && src[i + 1] === '/') {
				while (i < src.length && src[i] !== '\n') i++;
				continue;
			}
			if (ch === '/' && src[i + 1] === '*') {
				i += 2;
				while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
				i++;
				continue;
			}
		}
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === '\\') {
				escaped = true;
				continue;
			}
			if (quote === '`') {
				// `${` opens a template interpolation; inside it we go
				// back to regular code until a matching `}`.
				if (ch === '$' && src[i + 1] === '{') {
					templateDepth++;
					i++;
					quote = null;
					continue;
				}
			}
			if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			quote = ch as '"' | "'" | '`';
			continue;
		}
		if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			if (templateDepth > 0) {
				// Closing a `${…}` interpolation, re-enter the template.
				templateDepth--;
				quote = '`';
			} else {
				depth--;
			}
		}
	}
	return depth;
}

// ─────────────────────────────────────────────────────────────────────
//  Stream boundaries — automatic detection.
//
//  Authors write normal Koze templates:
//
//    <script>
//      const todos = getTodos();         // no await → async binding
//    </script>
//    if (todos.pending) { <Skeleton /> }
//    else if (todos.error) { <p>{todos.error}</p> }
//    else { for (const t of todos) { <TodoItem todo={t} /> } }
//
//  The framework spots the if/else-if/else chain that gates on
//  `todos.pending|error|success`, compiles that chain into a render
//  closure, and streams its resolved markup in when the promise settles.
//  Authors never see a `<Boundary>` tag or any other wrapper — the
//  compiler infers the region from the `.pending/.error/.success`
//  accesses the author already wrote.
//
//  Region rule: smallest contiguous `if (…) { } else if (…) { } else { }`
//  chain whose gating expressions reference any async binding. A chain
//  may reference multiple bindings (`if (a.pending || b.pending)`); in
//  that case the boundary awaits `Promise.all([a, b])` and re-renders
//  the chain once both settle.
//
//  See `@kuratchi/koze/runtime/stream.ts` for the runtime primitives
//  (`__registerBoundary`, `boundaryPlaceholder`, `BOOTSTRAP_SCRIPT`,
//  `resolveBoundaryToChunk`) this pre-pass composes with.
// ─────────────────────────────────────────────────────────────────────

interface ExtractedBoundary {
	/** Marker substituted into the outer template in place of the if-chain. */
	marker: string;
	/** The full source of the if-chain. Compiled on its own into a closure. */
	chainSource: string;
	/** Identifiers the chain depends on (bindings accessed as X.pending/.error/.success). */
	bindings: string[];
	/** 0-based sequence number, makes closure names unique per route. */
	index: number;
}

/**
 * Which top-level script bindings are "async" — meaning they're
 * referenced in the template as `X.pending`?
 *
 * `.pending` is the shared AsyncValue/action-state tell. Action
 * function names are not top-level data vars, so they are filtered out
 * before streaming boundary extraction.
 *
 * Once `.pending` is seen the caller promotes the identifier to an
 * async binding; the extractor then matches if-chains gated on any of
 * `.pending | .error | .success` for that same identifier.
 */
function detectAsyncBindings(template: string): Set<string> {
	const out = new Set<string>();
	const re = /\b([A-Za-z_$][\w$]*)\.pending\b/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(template)) !== null) {
		out.add(match[1]);
	}
	return out;
}

/**
 * Walk the template line-by-line (the same shape `compileTemplate`
 * expects) and identify every `if (...) { ... } else if (...) { ... }
 * else { ... }` chain whose head condition mentions an async binding.
 * Replace each chain with a `<!--koze:auto-boundary:N-->` marker.
 *
 * Control-flow opener detection: `compileTemplate` already recognizes
 * `if (…) {`, `else if (…) {`, `else {`, and the closing `}` as plain
 * JS lines. We follow the same bracket-counting rules to find the end
 * of a chain.
 */
function extractAsyncBoundaries(
	template: string,
	asyncBindings: Set<string>,
): { template: string; boundaries: ExtractedBoundary[] } {
	if (asyncBindings.size === 0) {
		return { template, boundaries: [] };
	}
	const lines = template.split('\n');
	const boundaries: ExtractedBoundary[] = [];
	const output: string[] = [];

	// Regexes tolerant of leading whitespace. Head `if` must reference
	// an async binding directly in its condition; `else if` continues
	// an ongoing chain regardless of whether its own condition mentions
	// an async binding (the chain as a whole is already a boundary).
	const headIfRe = /^\s*if\s*\(([^)]+)\)\s*\{\s*$/;
	const elseIfRe = /^\s*\}\s*else\s+if\s*\(([^)]+)\)\s*\{\s*$/;
	const elseRe = /^\s*\}\s*else\s*\{\s*$/;
	const closeRe = /^\s*\}\s*$/;

	const conditionReferencesAsyncBinding = (condition: string): string[] => {
		const hits: string[] = [];
		const idRe = /\b([A-Za-z_$][\w$]*)\.(?:pending|error|success)\b/g;
		let m: RegExpExecArray | null;
		while ((m = idRe.exec(condition)) !== null) {
			if (asyncBindings.has(m[1]) && !hits.includes(m[1])) hits.push(m[1]);
		}
		return hits;
	};

	// Scan an arbitrary slice of template source for async-binding usage —
	// not just `.pending|.error|.success` accessors but ANY property /
	// method access on the binding identifier. The boundary closure runs
	// AFTER reassignment to the pending AsyncValue, so any reference to
	// the raw binding inside the chain body — `x.success`, `x.candidates`,
	// `x.length`, `x.context.person`, etc. — needs the binding hoisted
	// into the boundary's parameter list. Without this, the closure reads
	// the outer-scope raw Promise (or worse, the AsyncValue) for nested
	// bindings whose head condition we never detected, and renders junk
	// (or nothing). Concrete repro: a chain like
	//
	//   if (a.pending) { … }
	//   else if (a.success) {
	//     if (b.pending) { … } else if (b.success) { … b.value … }
	//   }
	//
	// previously only registered `a` in the boundary; `b` stayed a raw
	// Promise so `b.pending` was undefined and the inner branch never
	// matched. Hoisting `b` into the outer boundary makes the chain
	// stream atomically when BOTH resolve — the simplest correct
	// behavior given async boundaries don't compose recursively yet.
	const sourceReferencesAsyncBindings = (src: string): string[] => {
		const hits: string[] = [];
		const idRe = /\b([A-Za-z_$][\w$]*)\b/g;
		let m: RegExpExecArray | null;
		while ((m = idRe.exec(src)) !== null) {
			if (asyncBindings.has(m[1]) && !hits.includes(m[1])) hits.push(m[1]);
		}
		return hits;
	};

	let i = 0;
	let boundaryIndex = 0;
	while (i < lines.length) {
		const line = lines[i];
		const headMatch = line.match(headIfRe);
		const headHits = headMatch ? conditionReferencesAsyncBinding(headMatch[1]) : [];
		if (!headMatch || headHits.length === 0) {
			output.push(line);
			i++;
			continue;
		}

		// We're at the head of an async-binding-gated if. Walk forward
		// through the chain tracking `{`/`}` depth. The chain ends at
		// the line that closes the last `else` branch.
		const chainStart = i;
		const bindingsInChain = new Set<string>(headHits);
		let depth = 1;
		let j = i + 1;
		let chainClosedAt = -1;
		while (j < lines.length) {
			const l = lines[j];
			// Continuation clauses at depth 1 keep the chain alive AND
			// may introduce new binding references.
			if (depth === 1) {
				const ei = l.match(elseIfRe);
				if (ei) {
					for (const b of conditionReferencesAsyncBinding(ei[1])) bindingsInChain.add(b);
					// `} else if (…) {` pops one block and opens another; depth stays at 1.
					j++;
					continue;
				}
				const e = l.match(elseRe);
				if (e) {
					j++;
					continue;
				}
				if (closeRe.test(l)) {
					chainClosedAt = j;
					break;
				}
			}
			// Count braces INSIDE lines that aren't clause boundaries.
			// We approximate: each naked `{` at end of line opens, each
			// naked `}` at start closes. Good enough because the author
			// writes control flow on its own line (the template-compiler
			// line-scanner already assumes this).
			const opens = (l.match(/\{\s*$/) || []).length;
			const closes = (l.match(/^\s*\}/) || []).length;
			depth += opens;
			depth -= closes;
			j++;
		}
		if (chainClosedAt === -1) {
			// Unclosed chain — bail out to avoid breaking the template;
			// emit the original lines unchanged so `compileTemplate`
			// surfaces any syntax error rather than us masking it.
			output.push(line);
			i++;
			continue;
		}
		const chainSource = lines.slice(chainStart, chainClosedAt + 1).join('\n');
		// Add any other async bindings referenced inside the chain body.
		// See `sourceReferencesAsyncBindings` for the rationale.
		for (const b of sourceReferencesAsyncBindings(chainSource)) bindingsInChain.add(b);
		const marker = `<!--koze:auto-boundary:${boundaryIndex}-->`;
		boundaries.push({
			marker,
			chainSource,
			bindings: Array.from(bindingsInChain),
			index: boundaryIndex,
		});
		output.push(marker);
		boundaryIndex++;
		i = chainClosedAt + 1;
	}

	return { template: output.join('\n'), boundaries };
}

// ─────────────────────────────────────────────────────────────────────
//  Inline event-handler directive: `onclick={fn(args)}`
//
//  Koze-native handler binding. Authors write:
//      <button onclick={deleteTodo(todo.id)}>Delete</button>
//  The template compiler in `koze` recognizes `on<event>={…}`
//  attributes and consults the `ClientRouteRegistry` we pass in via
//  `compileTemplate`'s options. The registry assigns a stable handler
//  id (`h0`, `h1`, …), remembers the callee expression, and returns
//  the triple `(routeId, handlerId, argsExpr)`. The compiler then
//  emits the element with:
//
//      data-client-route="<routeId>"
//      data-client-handler="h0"
//      data-client-event="click"
//      data-client-args="${__esc(JSON.stringify([<argsExpr>]))}"
//
//  At the end of the leading-script browser bundle we register the
//  handler table with the client bridge:
//
//      window.__kozeClient.register("<routeId>", {
//          h0: (args) => deleteTodo(args[0]),
//          h1: (args, event) => save(),
//      });
//
//  The bridge (a tiny ~1 kB IIFE) installs one document-level listener
//  per event type, finds the `data-client-*` attributes on the closest
//  ancestor, parses `data-client-args`, and invokes the registered
//  handler. Re-including the bridge across multiple pages is
//  idempotent — it guards on `window.__kozeClient`.
//
//  This is deliberately MORE permissive than `koze`'s reference
//  implementation. That one required every referenced binding to come
//  from a `$lib/*` import. We allow any identifier: `$lib/*` imports,
//  `$server/*` RPC stubs (which in the browser bundle become real
//  functions), or functions the author declared in the top `<script>`
//  block. The registry never resolves the expression — it just stores
//  the string — so as long as the expression evaluates cleanly in the
//  leading-fragment's module scope at register time, it works.
// ─────────────────────────────────────────────────────────────────────

interface ClientEventRegistration {
	routeId: string;
	handlerId: string;
	argsExpr: string | null;
}

interface ClientRouteRegistryLike {
	hasBindings(): boolean;
	hasBindingReference(expression: string): boolean;
	registerEventHandler(eventName: string, expression: string): ClientEventRegistration | null;
	getServerProxyBindings(): unknown[];
	buildEntryAsset(): { assetName: string; asset: unknown } | null;
	rewriteClientImport(importLine: string, importerDir: string): string | null;
}

/**
 * Does the template have any `on<event>={fn(…)}` where `fn` is a
 * `$server/*` import? Used to decide whether the leading-fragment
 * bundle must ship the bridge's server-action dispatch branch even
 * when there are zero client handlers to register.
 */
function templateHasServerActionHandlers(
	template: string,
	serverActionCallees: Set<string>,
): boolean {
	if (serverActionCallees.size === 0) return false;
	const re = /\son[A-Za-z]+\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\(/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(template)) !== null) {
		if (serverActionCallees.has(match[1])) return true;
	}
	return false;
}

function templateHasEnhancedActionForms(
	template: string,
	stateActionNames: Set<string>,
): boolean {
	if (/<form\b[^>]*(?:\saugment(?:[\s=>/]|$)|\sdata-augment(?:[\s=>/]|$))/i.test(template)) {
		return true;
	}
	if (stateActionNames.size === 0) return false;
	const re = /<form\b[^>]*\saction\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(template)) !== null) {
		if (stateActionNames.has(match[1])) return true;
	}
	return false;
}

/**
 * Pre-populate the per-route handler registry from a raw template
 * scan. Matches every `on<event>={expr}` attribute and feeds `expr` to
 * `registerEventHandler`. Run during `extractClientFragments` so the
 * handler-registration source can be appended to the leading-fragment
 * browser source at fragment registration time — BEFORE the client
 * Rollup build calls `load()` on the virtual fragment module.
 *
 * Skips expressions whose root callee is a `$server/*` import — those
 * are dispatched as server actions by the template compiler
 * (`data-action=…`), not through the client-handler bridge. Keeping
 * them out of the registry keeps the browser bundle tight.
 *
 * Must match `{…}` carefully: we want the FULL expression including
 * nested parens, template literals, comments. A naive `{[^}]*}` would
 * cut off at the first `}` inside the expression. We use a tiny
 * bracket-balanced scanner instead.
 */
function preRegisterHandlers(
	template: string,
	registry: CompilerClientRouteRegistry,
	serverActionCallees: Set<string>,
): void {
	const attrRe = /\son([A-Za-z]+)\s*=\s*\{/g;
	let match: RegExpExecArray | null;
	while ((match = attrRe.exec(template)) !== null) {
		const eventName = match[1].toLowerCase();
		const exprStart = match.index + match[0].length;
		let depth = 1;
		let end = exprStart;
		let inString: '"' | "'" | '`' | null = null;
		while (end < template.length && depth > 0) {
			const ch = template[end];
			const prev = end > 0 ? template[end - 1] : '';
			if (inString) {
				if (ch === inString && prev !== '\\') inString = null;
			} else if (ch === '"' || ch === "'" || ch === '`') {
				inString = ch;
			} else if (ch === '{') {
				depth++;
			} else if (ch === '}') {
				depth--;
				if (depth === 0) break;
			}
			end++;
		}
		const expr = template.slice(exprStart, end).trim();
		if (!expr) continue;
		// Skip server-action callees. `parseHandlerExpression` reports
		// the root identifier of `foo.bar(…)` as `foo`, so we need the
		// parser's result to filter correctly for property-access
		// callees — but server actions are always bare identifiers
		// (`$server/*` imports produce top-level bindings), so a cheap
		// identifier-first check is sufficient.
		const rootMatch = expr.match(/^([A-Za-z_$][\w$]*)/);
		if (rootMatch && serverActionCallees.has(rootMatch[1])) continue;
		registry.registerEventHandler(eventName, expr);
	}
}

/**
 * Parse `fnExpr(argsExpr)` into its parts. The argsExpr is the raw
 * argument list source (possibly multi-arg, possibly empty). We use the
 * TypeScript parser to tolerate nested parens, template literals, and
 * commas inside array/object literals — things a regex can't handle.
 *
 * Returns `null` if the expression isn't a call expression, or if the
 * callee isn't a simple identifier / property-access chain (we refuse
 * to register anything more exotic because it's not clear what the
 * client-side invocation shape should be).
 */
function parseHandlerExpression(expression: string): {
	calleeExpr: string;
	argsExpr: string;
	rootBinding: string;
} | null {
	let sourceFile: ts.SourceFile;
	try {
		sourceFile = ts.createSourceFile(
			'kuratchi-handler.ts',
			`(${expression})`,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
	} catch {
		return null;
	}
	const stmt = sourceFile.statements[0];
	if (!stmt || !ts.isExpressionStatement(stmt)) return null;
	const paren = stmt.expression;
	if (!ts.isParenthesizedExpression(paren)) return null;
	const expr = paren.expression;
	if (!ts.isCallExpression(expr)) return null;

	// Callee must be a plain identifier or dotted property-access chain.
	// This is the ONLY place we're opinionated: `foo.bar()` is fine,
	// `(a || b)()` is not. Authors who need dynamic dispatch can wrap
	// their logic in a named function.
	const rootBinding = (() => {
		let node: ts.Expression = expr.expression;
		while (ts.isPropertyAccessExpression(node)) node = node.expression;
		if (!ts.isIdentifier(node)) return null;
		return node.text;
	})();
	if (!rootBinding) return null;

	const calleeText = expr.expression.getText(sourceFile);
	const argsText = expr.arguments.map((a) => a.getText(sourceFile)).join(', ');
	return { calleeExpr: calleeText, argsExpr: argsText, rootBinding };
}

interface ClientHandlerRecord {
	id: string;
	calleeExpr: string;
	argsExpr: string;
}

class CompilerClientRouteRegistry implements ClientRouteRegistryLike {
	private readonly handlerByKey = new Map<string, ClientHandlerRecord>();

	constructor(private readonly routeId: string) {}

	hasBindings(): boolean {
		// We don't gate registrations on `$lib` bindings, so claim
		// `true` whenever a registration has happened. The field is
		// only consulted by the template compiler to decide whether to
		// emit the legacy native `on<event>=` fallback; we always want
		// the data-client-* path for our routes.
		return true;
	}

	hasBindingReference(_expression: string): boolean {
		// The reference implementation uses this to refuse unsupported
		// handler shapes whose identifiers come from `$lib`. We accept
		// any identifier, so returning `false` lets `compileTemplate`
		// fall through to the native inline-handler branch if
		// `registerEventHandler` couldn't parse the expression.
		return false;
	}

	registerEventHandler(_eventName: string, expression: string): ClientEventRegistration | null {
		const parsed = parseHandlerExpression(expression);
		if (!parsed) return null;

		// De-dupe: two identical `<button onclick={save()}>` elements
		// share the same handler id, so we don't bloat the registry.
		const key = `${parsed.calleeExpr}::${parsed.argsExpr}`;
		let record = this.handlerByKey.get(key);
		if (!record) {
			record = {
				id: `h${this.handlerByKey.size}`,
				calleeExpr: parsed.calleeExpr,
				argsExpr: parsed.argsExpr,
			};
			this.handlerByKey.set(key, record);
		}

		return {
			routeId: this.routeId,
			handlerId: record.id,
			argsExpr: parsed.argsExpr.trim() === '' ? null : parsed.argsExpr,
		};
	}

	getServerProxyBindings(): unknown[] {
		return [];
	}

	buildEntryAsset(): null {
		// We emit the handler table inline in the leading fragment, not
		// as a separate client entry asset. Return null so the template
		// compiler doesn't try to inject a `<script src=...>` tag of
		// its own for the handler bundle.
		return null;
	}

	rewriteClientImport(_importLine: string, _importerDir: string): string | null {
		return null;
	}

	/**
	 * JS source appended to the end of the leading fragment's browser
	 * source, AFTER all user code. Registers every collected handler
	 * with `window.__kozeClient.register(routeId, {…})`. Returns
	 * empty string when no handlers were registered — that short-circuits
	 * both the `register(...)` call AND the bridge inclusion.
	 */
	emitRegistrationSource(): string {
		if (this.handlerByKey.size === 0) return '';
		// Invocation shape: `fn(...args, event, element)`. Matches the
		// reference `koze` runtime. `args` comes from
		// `data-client-args` (JSON-serialized at SSR); `event` is the
		// browser event; `element` is the ancestor element the bridge
		// matched on (the one carrying `data-client-handler`). Authors
		// who only care about their own args can write a normal
		// fixed-arity function: `function deleteTodo(id) { … }` works
		// whether invoked with zero or three trailing arguments.
		const entries = Array.from(this.handlerByKey.values())
			.map((record) => `\t${record.id}: (args, event, element) => ${record.calleeExpr}(...args, event, element)`)
			.join(',\n');
		return `\nwindow.__kozeClient && window.__kozeClient.register(${JSON.stringify(this.routeId)}, {\n${entries}\n});\n`;
	}

	get handlerCount(): number {
		return this.handlerByKey.size;
	}
}

/**
 * Minimal client bridge. Runs once per page — idempotent because it
 * guards on `window.__kozeClient`. Listens at the document root
 * for a fixed set of events and performs TWO dispatches:
 *
 *   1. `data-client-event`  → client handler registered via
 *      `window.__kozeClient.register(routeId, {…})`. Registered
 *      by the leading-fragment browser bundle. See `registerEventHandler`
 *      in the compiler for the emission shape.
 *
 *   2. `data-action-event`  → server action. The bridge POSTs to the
 *      current URL with `_action`, `_args`, optional `_method` fields.
 *      The response JSON can include `{ redirectTo }` to trigger a
 *      client-side navigation after the action resolves. This mirrors
 *      the `koze` reference bridge — `onclick={serverFn(id)}`
 *      where `serverFn` is a `$server/*` import compiles to these
 *      attributes, so the button "just works" with no extra code.
 *
 * Security: every routeId / handlerId is validated against a strict
 * identifier regex, prototype-pollution names are blocked, and the
 * handler table is an `Object.create(null)` with `hasOwnProperty`
 * checks on lookup.
 */
/**
 * Register the single leading `<script>` block as a browser fragment.
 * The SFC parser enforces the one-script rule before Vite touches the
 * source, so body scripts cannot bypass the compiler by becoming hidden
 * client fragments.
 *
 * As of the leading-script dual-bundle change, the LEADING `<script>`
 * block (index 0) is ALSO registered as a client fragment — with its
 * body rewritten so module-level `await` of `$server/*` reads from the
 * SSR-hydrated `window.__kozeData` instead. The SSR copy of the
 * leading script remains inlined as the render-function prelude; the
 * browser copy runs the same code with live data, the same way Svelte
 * + Astro ship dual SSR/client modules.
 */
export function extractClientFragments(
	source: string,
	importerAbsPath: string,
	clientFragments: Map<string, ClientFragment>,
	isProduction: boolean = false,
	componentCompiler?: ComponentCompiler,
): { source: string; leadingHash: string | null } {
	let leadingHash: string | null = null;

	const sfc = parseKuratchiSfc(source, { kind: 'route', filePath: importerAbsPath });
	if (!sfc.script) return { source, leadingHash };

	const trimmedLeading = sfc.script.content.trim();
	if (trimmedLeading.length === 0) return { source, leadingHash };

	const hash = leadingScriptHash(importerAbsPath, source);
	leadingHash = hash;
	const hydrateTargets = collectLeadingHydrateTargets(trimmedLeading);
	let requestImports: Array<{ exportName: string; alias: string }> = [];
	let serverActionCallees = new Set<string>();
	let actionAliases: AugmentedActionAlias[] = [];
	let augmentedActionNames = new Set<string>();
	let componentNames: Map<string, string> | undefined;
	let serverRpcScopeNames: string[] = [];
	try {
		const parsed = parseFile(source, {
			kind: 'route',
			filePath: importerAbsPath,
		});
		requestImports = parsed.ir.imports.request;
		actionAliases = parsed.actionAliases ?? [];
		augmentedActionNames = new Set(actionAliases.map((alias) => alias.name));
		serverRpcScopeNames = parsed.ir.rpc.serverFunctions;
		serverActionCallees = new Set([
			...serverRpcScopeNames,
			...augmentedActionNames,
		]);
		componentNames = componentCompiler?.collectComponentMap(parsed.componentImports, importerAbsPath);
	} catch {
		requestImports = [];
	}
	const templateTail = sfc.template.source;
	const reactivePlan = analyzeClientTemplateReactivity(
		templateTail,
		trimmedLeading,
		componentNames,
		serverActionCallees,
		undefined,
		{ augmentedActionNames, reactiveOwnerId: hash },
	);
	const componentScopeNames = componentNames
		? Array.from(new Set(Array.from(componentNames.values()).map((fileName) => componentFuncName(fileName))))
		: [];
	const extraScopeNames = Array.from(new Set([
		...componentScopeNames,
		...serverRpcScopeNames,
	]));
	const blockRenderersExpr = buildClientTemplateRenderersExpression(reactivePlan.blockRenderers);
	const browserSource = transformLeadingScriptForClient(
		trimmedLeading,
		hydrateTargets,
		requestImports,
		isProduction,
		reactivePlan.reactiveNames,
		blockRenderersExpr,
		actionAliases,
		extraScopeNames,
		hash,
	);
	const handlerRegistry = new CompilerClientRouteRegistry(hash);
	preRegisterHandlers(templateTail, handlerRegistry, serverActionCallees);

	const hasServerActionHandlers = templateHasServerActionHandlers(templateTail, serverActionCallees);
	const hasEnhancedActionForms = actionAliases.length > 0 || templateHasEnhancedActionForms(templateTail, augmentedActionNames);
	const needsBridge = handlerRegistry.handlerCount > 0 || hasServerActionHandlers || hasEnhancedActionForms;
	let finalSource = browserSource;
	const componentDecls = componentNames && componentNames.size > 0 && componentCompiler
		? componentCompiler.getCompiledComponents().join('\n\n')
		: '';
	if (componentDecls) {
		finalSource += '\n' + componentDecls;
	}
	if (handlerRegistry.handlerCount > 0) {
		finalSource += handlerRegistry.emitRegistrationSource();
	}
	finalSource = appendInlineSourceMap(
		finalSource,
		createKuratchiSourceMap({
			generatedCode: finalSource,
			source,
			sourcePath: importerAbsPath,
			file: `${hash}.ts`,
		}),
	);
	clientFragments.set(hash, {
		source: finalSource,
		importerAbsPath,
		kind: 'leading',
		hydrateVars: [...hydrateTargets.initAwaitVars, ...hydrateTargets.reassignedLets],
		handlerRegistry,
		needsBridge,
		reactiveNames: reactivePlan.reactiveNames,
		blockRenderersExpr,
	});
	return { source, leadingHash };

}

/**
 * Compile a `.koze` route file into a TS module exporting `render(data)`.
 *
 *   1. Register the leading `<script>` browser fragment.
 *   2. Parse the source with `koze/compiler`.
 *   3. Compile the template to the `const __parts = [...]` body.
 *   4. Inline the leading `<script>` body as the render-function prelude
 *      so top-level `const` declarations become locals in scope.
 *
 * Dual SSR/client split for the leading script + `$server/*` RPC stubs
 * arrive in Phase C.2/C.3.
 */
/**
 * Compile a `routes/layout.*` file into a TS module exporting
 * `render(data, __content)`. `<slot></slot>` and `<slot/>` in the layout
 * template get rewritten to `{@raw __content}` so the child route's
 * HTML is inserted unescaped at that location — matching the existing
 * CLI's layout semantics.
 *
 * Layouts use the same single leading-script fragment rule as routes.
 */
export const DEFAULT_APP_SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
	<slot></slot>
</body>
</html>`;

/**
 * Compile a `routes/app.koze` file into a TS module exporting
 * `render(data, __content)`. Structurally identical to the layout
 * transform — app files are fragments too, just scoped to the
 * document shell instead of in-page chrome. Keeping the transforms
 * symmetrical means authors get the same mental model in both
 * files: top <script> + template + `<slot></slot>`.
 */
export function transformAppFile(
	source: string,
	hasGlobalCss: boolean,
	clientFragments?: Map<string, ClientFragment>,
	isProduction: boolean = false,
	importerAbsPath?: string,
): string {
	const preprocessed = clientFragments && importerAbsPath
		? extractClientFragments(source, importerAbsPath, clientFragments, isProduction)
		: { source, leadingHash: null as string | null };
	const parsed = parseFile(preprocessed.source, {
		kind: 'route',
		filePath: importerAbsPath,
	});
	const rawTemplate = parsed.template ?? '';
	// When `src/app.css` exists, inject `<link rel="stylesheet" href={...}>`
	// immediately before `</head>`. The href resolves at render time via
	// `resolveGlobalCssHref()` from koze:manifest — pointing at the
	// dev-server URL in dev, and the hashed manifest output in prod.
	//
	// If the shell has no `</head>`, we synthesize one: authors who ship
	// a shell without a head get a one-line injection as the first child
	// of `<html>`. The default shell always has `</head>`.
	const withGlobalCss = hasGlobalCss ? injectGlobalCssLink(rawTemplate) : rawTemplate;
	const withReactiveRuntime = injectReactiveRuntimeScript(withGlobalCss, isProduction);
	const template = withReactiveRuntime
		.replace(/<slot\s*><\/slot>/g, '{@raw __content}')
		.replace(/<slot\s*\/>/g, '{@raw __content}');
	const script = parsed.script ?? '';
	const appPreludePlan = buildSelectiveSsrPrelude({
		scriptBody: script,
		template,
		serverImports: parsed.serverImports ?? [],
	});
	const authoredImports = appPreludePlan.imports.join('\n');
	const manifestImport = hasGlobalCss
		? "import { resolveGlobalCssHref as __kozeResolveGlobalCssHref } from 'koze:manifest';"
		: '';
	const leadingHash = preprocessed.leadingHash;
	const moduleImports = [authoredImports, manifestImport].filter(Boolean).join('\n');
	const prelude = appPreludePlan.prelude;
	const requestImportDecls = buildRequestImportDecls(parsed.requestImports ?? []);
	let body = compileTemplate(template, undefined, undefined, undefined, {
		reactiveOwnerId: leadingHash ?? undefined,
	});
	if (leadingHash) {
		const leadingFragment = clientFragments?.get(leadingHash);
		const leadingScriptTag =
			'<script type="module" src="${resolveClientAsset(' +
			JSON.stringify(leadingHash) +
			')}"></script>';
		const bridgeTag = leadingFragment?.needsBridge
			? '<script type="module" src="${resolveClientAsset(' +
				JSON.stringify(CLIENT_BRIDGE_HASH) +
				')}\"></script>'
			: null;
		const bridgePush = bridgeTag
			? `\n\t__parts.push(\`${bridgeTag}\\n\`);`
			: '';
		body = `${body}${bridgePush}\n\t__parts.push(\`${leadingScriptTag}\\n\`);\n\t__html = __parts.join('');`;
	}
	const appManifestImport = leadingHash
		? `import { resolveClientAsset } from 'koze:manifest';\n`
		: '';

	const code = `${appManifestImport}${moduleImports}
export const hasApp = true;
export async function render(data, __content) {
${requestImportDecls}
	const __rawHtml = (v) => (v == null ? '' : String(v));
	const __sanitizeHtml = (v) => {
		let html = __rawHtml(v);
		html = html.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, '');
		html = html.replace(/<iframe\\b[^>]*>[\\s\\S]*?<\\/iframe>/gi, '');
		html = html.replace(/<object\\b[^>]*>[\\s\\S]*?<\\/object>/gi, '');
		html = html.replace(/<embed\\b[^>]*>/gi, '');
		html = html.replace(/\\son[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
		html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*([\"'])\\s*javascript:[\\s\\S]*?\\2/gi, ' $1=\"#\"');
		html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*javascript:[^\\s>]+/gi, ' $1=\"#\"');
		html = html.replace(/\\ssrcdoc\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
		return html;
	};
	const __esc = (v) => {
		if (v == null) return '';
		return String(v)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/\"/g, '&quot;')
			.replace(/'/g, '&#39;');
	};

	${prelude}

	${body}
	return __html;
}
`;
	return importerAbsPath
		? appendInlineSourceMap(
			code,
			createKuratchiSourceMap({
				generatedCode: code,
				source,
				sourcePath: importerAbsPath,
				file: path.basename(importerAbsPath) + '.js',
			}),
		)
		: code;
}

/**
 * Inject `<link rel="stylesheet" href={__kozeResolveGlobalCssHref()}>`
 * immediately before the first `</head>` in the template. When the
 * template has no `</head>` (authors who ship a shell without a head),
 * the link goes right after `<html ...>` so the browser still sees it
 * before any body content.
 *
 * Idempotent: if the template already contains a rendered call to
 * `__kozeResolveGlobalCssHref`, we leave it alone (prevents double
 * injection on HMR).
 */
function injectGlobalCssLink(template: string): string {
	if (template.includes('__kozeResolveGlobalCssHref')) return template;
	const tag = `<link rel="stylesheet" href={__kozeResolveGlobalCssHref()} />`;
	if (/<\/head\s*>/i.test(template)) {
		return template.replace(/<\/head\s*>/i, `\t${tag}\n</head>`);
	}
	if (/<html\b[^>]*>/i.test(template)) {
		return template.replace(/(<html\b[^>]*>)/i, `$1\n${tag}`);
	}
	// No `<html>` — prepend. Produces a malformed document but at least
	// the link is in the HTML response.
	return `${tag}\n${template}`;
}

function injectReactiveRuntimeScript(template: string, isProduction: boolean): string {
	if (template.includes('__kozeReactive')) return template;
	const tag = buildReactiveRuntimeScriptTag(!isProduction);
	if (/<\/head\s*>/i.test(template)) {
		return template.replace(/<\/head\s*>/i, `\t${tag}\n</head>`);
	}
	if (/<html\b[^>]*>/i.test(template)) {
		return template.replace(/(<html\b[^>]*>)/i, `$1\n${tag}`);
	}
	return `${tag}\n${template}`;
}

/**
 * Synthesize `const <alias> = data.<exportName> ?? <fallback>;`
 * declarations for every `koze:request` import the leading script
 * referenced. Routes, layouts, and the app shell all run inside a
 * `render(data, ...)` function the dispatcher invokes per request —
 * so any file whose top <script> pulls from `koze:request` needs
 * these locals to be in scope.
 */
function buildRequestImportDecls(
	requestImports: Array<{ exportName: string; alias: string }>,
): string {
	return requestImports
		.map((imp) => {
			const fallback = REQUEST_IMPORT_FALLBACKS[imp.exportName] ?? 'undefined';
			return `\tconst ${imp.alias} = data.${imp.exportName} ?? ${fallback};`;
		})
		.join('\n');
}

function stripAugmentedActionsFromServerPrelude(
	scriptBody: string,
	actionAliases: AugmentedActionAlias[],
): string {
	if (actionAliases.length === 0) return scriptBody;
	return stripAugmentImportSpecifier(
		stripAugmentedActionDeclarations(scriptBody, actionAliases),
	);
}

export function transformLayoutFile(
	source: string,
	importerAbsPath: string,
	clientFragments: Map<string, ClientFragment>,
	componentCompiler: ComponentCompiler,
	isProduction: boolean = false,
): { code: string; watchFiles: string[] } {
	const { source: preprocessedSource, leadingHash } = extractClientFragments(
		source,
		importerAbsPath,
		clientFragments,
		isProduction,
		componentCompiler,
	);
	const parsed = parseFile(preprocessedSource, {
		kind: 'route',
		filePath: importerAbsPath,
	});
	const rawTemplate = parsed.template ?? '';
	// Replace both styles of `<slot>` marker with the raw-content directive.
	// Koze's template compiler lowers `{@raw expr}` to `__rawHtml(expr)`.
	const template = rawTemplate
		.replace(/<slot\s*><\/slot>/g, '{@raw __content}')
		.replace(/<slot\s*\/>/g, '{@raw __content}');
	const script = parsed.script ?? '';

	// Component compilation — same pattern as the route transform, but
	// rooted at the layout file's path so relative component imports
	// resolve against the layout's directory.
	const componentNames = componentCompiler.collectComponentMap(
		parsed.componentImports,
		importerAbsPath,
	);
	const componentWatchFiles = Array.from(componentCompiler.getResolvedFiles().values()) as string[];

	// Server-action identifiers used in `action={fn}` or `on<event>={fn(…)}`.
	// Same filtering rule as pages: only names that are ALSO imported
	// from `$server/*` qualify (the rest are client-handler callees).
	// Without this, the template compiler falls through to its native
	// attribute emitter which calls `toString()` on the function — the
	// "Unknown action: async function setCaseCategoryAction(…)" bug that
	// used to bite every form in a layout.
	const rawLayoutActionFunctions = parsed.actionFunctions ?? [];
	const layoutServerRpcFunctions = new Set(parsed.serverRpcFunctions ?? []);
	const layoutActionAliases = parsed.actionAliases ?? [];
	const layoutActionAliasTargets = new Map(
		layoutActionAliases.map((alias) => [alias.name, alias.target] as const),
	);
	const layoutAugmentedActionNames = new Set(layoutActionAliases.map((alias) => alias.name));
	const layoutActionNames = new Set(
		rawLayoutActionFunctions.filter((name) =>
			layoutServerRpcFunctions.has(name) || layoutAugmentedActionNames.has(name),
		),
	);
	for (const name of layoutAugmentedActionNames) layoutActionNames.add(name);
	// Same component-action bubble as routes: a `<Card action={save}>`
	// inside a layout where `save` comes from `$server/*` becomes part
	// of the layout's action table.
	for (const fnName of componentCompiler.resolveActionProps(
		template,
		componentNames,
		(name: string) => layoutServerRpcFunctions.has(name) || layoutAugmentedActionNames.has(name),
	)) {
		layoutActionNames.add(fnName);
	}
	const layoutPreludeScript = stripAugmentedActionsFromServerPrelude(script, layoutActionAliases);
	const layoutNeededActionBindings = Array.from(new Set([
		...layoutActionNames,
		...layoutActionAliasTargets.values(),
	]));
	const layoutPreludePlan = buildSelectiveSsrPrelude({
		scriptBody: layoutPreludeScript,
		template,
		serverImports: parsed.serverImports ?? [],
		additionalNeededBindings: layoutNeededActionBindings,
	});
	const componentModuleImports = componentCompiler.getServerImports().join('\n');
	const moduleImports = [layoutPreludePlan.imports.join('\n'), componentModuleImports]
		.filter(Boolean)
		.join('\n');
	const prelude = layoutPreludePlan.prelude;
	const requestImportDecls = buildRequestImportDecls(parsed.requestImports ?? []);

	// Layouts support the same async-boundary rewrite as pages: a top-
	// level `let x = fn()` (non-awaited) that the template gates on via
	// `x.pending | x.error | x.success` becomes a stream boundary. The
	// runtime's dispatcher handles boundaries uniformly regardless of
	// whether they were registered from a layout or a page — boundaries
	// collect on the per-request `locals` collector, and the final
	// `renderRoute` check picks them all up.
	const topLevelDataVars = new Set(parsed.dataVars ?? []);
	const layoutAsyncBindings = new Set(
		[...detectAsyncBindings(template)].filter((name) => topLevelDataVars.has(name) && !layoutActionNames.has(name)),
	);
	const layoutBoundaryExtraction = extractAsyncBoundaries(template, layoutAsyncBindings);
	const layoutBoundariesUsed = layoutBoundaryExtraction.boundaries.length > 0;
	const handlerRegistry = leadingHash
		? clientFragments.get(leadingHash)?.handlerRegistry ?? null
		: null;

	let body = compileTemplate(layoutBoundaryExtraction.template, componentNames, layoutActionNames, undefined, {
		clientRouteRegistry: handlerRegistry as any,
		augmentedActionNames: layoutAugmentedActionNames,
		reactiveOwnerId: leadingHash ?? undefined,
	});

	// Post-compile: swap each `<!--koze:auto-boundary:N-->` marker
	// for a block that registers the combined promise with the stream
	// runtime and emits a placeholder wrapping the chain's pending
	// render. Same shape as the route-side rewrite in `transformRouteFile`.
	for (const boundary of layoutBoundaryExtraction.boundaries) {
		const marker = boundary.marker;
		const innerBody = compileTemplate(boundary.chainSource, componentNames, layoutActionNames, undefined, {
			clientRouteRegistry: handlerRegistry as any,
			augmentedActionNames: layoutAugmentedActionNames,
			reactiveOwnerId: leadingHash ?? undefined,
		});
		const params = boundary.bindings.join(', ');
		const closureName = `__boundary_${boundary.bindings[0]}_${boundary.index}_render`;
		const closureDef = `const ${closureName} = (${params}) => { ${innerBody}; return __html; };`;
		const rawCaptures = boundary.bindings
			.map((b) => `const __boundary_raw_${b} = ${b};`)
			.join('\n\t\t');
		// Each binding's promise is wrapped INDEPENDENTLY into an AsyncValue
		// before joining. `Promise.all` short-circuits on the first rejection,
		// which historically meant a single failed binding (e.g. an AI call
		// that errored) bled across to all other bindings sharing the
		// boundary — they'd all render their `.error` branch even though
		// their own data was fine. Mapping rejections to `wrapError(msg)`
		// per-binding gives every chain branch its own success/error state
		// while keeping the boundary's "stream when ALL settle" semantics.
		const combinedPromise = `Promise.all([${boundary.bindings
			.map(
				(b) =>
					`Promise.resolve(__boundary_raw_${b}).then(__kozeWrapSuccess, function(__err){ return __kozeWrapError(__err && __err.message ? String(__err.message) : String(__err)); })`,
			)
			.join(', ')}])`;
		// Each `__values[i]` is already an AsyncValue (success or error)
		// thanks to the per-binding wrapping above — pass them straight
		// into the closure without re-wrapping.
		const successArgs = boundary.bindings.map((_, idx) => `__values[${idx}]`).join(', ');
		const successHandler = `(__values) => ${closureName}(${successArgs})`;
		// Defensive only: if `Promise.all` itself throws (it shouldn't —
		// every input now resolves), every binding falls back to error.
		const errorArgs = boundary.bindings.map(() => `__kozeWrapError(__message)`).join(', ');
		const errorHandler = `(__message) => ${closureName}(${errorArgs})`;
		const reassignPending = boundary.bindings
			.map((b) => `${b} = __boundary_pending;`)
			.join('\n\t\t');
		const pendingArgs = boundary.bindings.map(() => '__boundary_pending').join(', ');
		const replacement = `\`);
	{
		${closureDef}
		${rawCaptures}
		const __boundary_id = __kozeNextBoundaryId(${JSON.stringify(boundary.bindings.join('-'))});
		const __boundary_pending = __kozeRegisterBoundary(
			__boundary_id,
			${combinedPromise},
			${successHandler},
			${errorHandler},
		);
		${reassignPending}
		__parts.push(__kozeBoundaryPlaceholder(__boundary_id, ${closureName}(${pendingArgs})));
	}
	__parts.push(\``;
		body = body.split(marker).join(replacement);
	}

	const streamRuntimeImport = layoutBoundariesUsed
		? `import {\n\t__registerBoundary as __kozeRegisterBoundary,\n\t__nextBoundaryId as __kozeNextBoundaryId,\n\tboundaryPlaceholder as __kozeBoundaryPlaceholder,\n\t__wrapSuccess as __kozeWrapSuccess,\n\t__wrapError as __kozeWrapError,\n} from '@kuratchi/koze/runtime/stream.js';\n`
		: '';

	// Export every detected server-action function so the route module
	// can re-export them as its own `actions` (layout actions bubble up
	// the chain to the page's exported `actions` table; the dispatcher
	// looks up `match.module.actions[name]` without needing any
	// layout-awareness at the runtime level).
	const layoutActionExportEntries = Array.from(layoutActionNames)
		.map((name) => `\t${JSON.stringify(name)}: ${layoutActionAliasTargets.get(name) ?? name},`)
		.join('\n');
	// Always export `actions` — empty when the layout has no
	// server-action callees of its own. Rollup warns when a route
	// module imports a name that isn't exported, even though the
	// `?? {}` coalesce handles it at runtime; emitting the name
	// unconditionally suppresses the warning and lets Rollup
	// tree-shake correctly.
	const layoutActionsExport = layoutActionExportEntries
		? `\nexport const actions = {\n${layoutActionExportEntries}\n};\n`
		: '\nexport const actions = {};\n';

	let leadingModuleAppend = '';
	if (leadingHash) {
		const leadingFragment = clientFragments.get(leadingHash);
		const hydrateVars = leadingFragment?.hydrateVars ?? [];
		const hydrateEntries = hydrateVars
			.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
			.map((name) => `${JSON.stringify(name)}: ${name}`)
			.join(', ');
		const hydratePayload = `{ ${hydrateEntries}${
			hydrateEntries ? ', ' : ''
		}__params: data.params ?? {} }`;
		const leadingScriptTag =
			'<script type="module" src="${resolveClientAsset(' +
			JSON.stringify(leadingHash) +
			')}"></script>';
		const bridgeTag = leadingFragment?.needsBridge
			? '<script type="module" src="${resolveClientAsset(' +
				JSON.stringify(CLIENT_BRIDGE_HASH) +
				')}"></script>'
			: null;
		const bridgePush = bridgeTag
			? `\n\t__parts.push(\`${bridgeTag}\\n\`);`
			: '';
		leadingModuleAppend = `
	__parts.push('<script type="application/json" id="__koze_data">' + __kozeSerializeData(${hydratePayload}) + '</' + 'script>\\n');${bridgePush}
	__parts.push(\`${leadingScriptTag}\\n\`);
	__html = __parts.join('');`;
	}

	// Inside `render(data, __content)`, shadow every action identifier
	// with its per-request state object (`{ error, pending, success }`).
	// Seeded by the dispatcher before render; same mechanism as pages.
	const layoutActionStateDecls = Array.from(layoutActionNames)
		.map(
			(name) =>
				`\tconst ${name} = (data && data[${JSON.stringify(name)}]) ?? { error: undefined, pending: false, success: false };`,
		)
		.join('\n');
	const manifestImport = leadingHash
		? `import { resolveClientAsset } from 'koze:manifest';\n`
		: '';

	// Component decls + styles — same shape as routes. Layouts can
	// import their own components (e.g. an app-shell layout that
	// imports `<Sidebar>`); the compiled functions land at module
	// scope so the layout's `render()` can call them.
	const componentDecls = componentCompiler.getCompiledComponents().join('\n\n');
	const componentStyles = componentCompiler.collectStyles(componentNames);
	const componentStylesInjection = componentStyles.length > 0
		? `__parts.push(\`${componentStyles.join('')}\`);`
		: '';

	const code = `${streamRuntimeImport}${manifestImport}${moduleImports}
${componentDecls}
${layoutActionsExport}
export const hasLayout = true;
export async function render(data, __content) {
${requestImportDecls}
${layoutActionStateDecls}
	const __rawHtml = (v) => (v == null ? '' : String(v));
	const __sanitizeHtml = (v) => {
		let html = __rawHtml(v);
		html = html.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, '');
		html = html.replace(/<iframe\\b[^>]*>[\\s\\S]*?<\\/iframe>/gi, '');
		html = html.replace(/<object\\b[^>]*>[\\s\\S]*?<\\/object>/gi, '');
		html = html.replace(/<embed\\b[^>]*>/gi, '');
		html = html.replace(/\\son[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
		html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*([\"'])\\s*javascript:[\\s\\S]*?\\2/gi, ' $1=\"#\"');
		html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*javascript:[^\\s>]+/gi, ' $1=\"#\"');
		html = html.replace(/\\ssrcdoc\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
		return html;
	};
	const __esc = (v) => {
		if (v == null) return '';
		return String(v)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	};
	const __kozeSerializeData = (value) => {
		let s;
		try { s = JSON.stringify(value); } catch { s = undefined; }
		if (s === undefined) return 'null';
		const __lineSep = String.fromCharCode(0x2028);
		const __paraSep = String.fromCharCode(0x2029);
		return s
			.split('<').join('\\\\u003c')
			.split(__lineSep).join('\\\\u2028')
			.split(__paraSep).join('\\\\u2029');
	};

	${prelude}

	${injectComponentStyles(body, componentStylesInjection)}${leadingModuleAppend}
	return __html;
}
`;
	return {
		code: appendInlineSourceMap(
			code,
			createKuratchiSourceMap({
				generatedCode: code,
				source,
				sourcePath: importerAbsPath,
				file: path.basename(importerAbsPath) + '.js',
			}),
		),
		watchFiles: componentWatchFiles,
	};
}

/**
 * Emit the JS that composes the route's HTML through every layout in
 * its chain, innermost-first. The chain is received outermost-first
 * (so `chain[0]` is the root-most layout wrapping everything); we
 * reverse at compose time so the first wrap is the innermost layout
 * — that layout receives the raw route HTML, and its output becomes
 * the child content for the next-outer layout.
 *
 * Returns a sequence of `const` assignments feeding a final
 * `__layoutHtml` that the route emission hands to `__kozeApp.render`.
 *
 * When the chain is empty, falls back to the legacy single-module
 * `__kozeLayout` import (which resolves to a no-op stub when the
 * project has no root layout file). This preserves behavior for
 * existing apps with no layouts at all.
 */
function composeLayoutChain(chain: string[]): string {
	if (chain.length === 0) {
		return `const __layoutHtml = await __kozeLayout.render(data, __routeHtml);`;
	}
	const lines: string[] = [`let __layoutHtml = __routeHtml;`];
	// Reverse to innermost-first. Each wrap's output feeds the next.
	for (const layoutPath of [...chain].reverse()) {
		const hash = layoutModuleHash(layoutPath);
		lines.push(`__layoutHtml = await __kozeLayout_${hash}.render(data, __layoutHtml);`);
	}
	return lines.join('\n\t');
}

export function transformRouteFile(
	source: string,
	importerAbsPath: string,
	clientFragments: Map<string, ClientFragment>,
	componentCompiler: ComponentCompiler,
	isProduction: boolean = false,
	layoutChain: string[] = [],
): { code: string; watchFiles: string[] } {
	const { source: preprocessedSource, leadingHash } = extractClientFragments(
		source,
		importerAbsPath,
		clientFragments,
		isProduction,
		componentCompiler,
	);

	const parsed = parseFile(preprocessedSource, {
		kind: 'route',
		filePath: importerAbsPath,
	});
	const template = parsed.template ?? '';
	const script = parsed.script ?? '';

	// Component compilation. `componentImports` was populated by the
	// parser from `import Card from '$lib/card.koze'` (or
	// '@scope/pkg/card.koze', or './widgets/card.koze'). The
	// component compiler resolves each one — relative paths against
	// the importer's directory, $lib paths against `src/lib`, package
	// paths against `node_modules`. Compiled component bodies are
	// shared across the entire build via the per-plugin
	// `componentCompiler` instance.
	const componentNames = componentCompiler.collectComponentMap(
		parsed.componentImports,
		importerAbsPath,
	);
	// Track watch files so the Vite plugin's `load` hook can register
	// them. Editing a `card.koze` should re-emit every route that
	// imports it.
	const componentWatchFiles = Array.from(componentCompiler.getResolvedFiles().values()) as string[];

	// Imports hoist to module scope so Vite's resolver handles them once
	// per module (via `$lib`/`$server` aliases). The prelude — the script
	// body with imports stripped — runs inside `render()` every request
	// so top-level `await` of `$server/*` calls produces per-request data.
	// (`serverRpcImports` is a subset of `serverImports`; `serverImports`
	// alone covers everything from the leading script.)

	// `koze:request` imports are stripped by the parser (they're not
	// real import lines at runtime; they map to per-request state). We
	// synthesize the matching `const alias = data.alias || <fallback>;`
	// declarations so the leading-script body, which runs inside `render`,
	// can reference `params` / `searchParams` / `url` / etc. The Vite
	// dispatcher populates `data` with these values before calling render.

	// Dispatch rule for `on<event>={fn(args)}` matches the Kuratchi CLI:
	//
	//   1. If `fn` is imported from `$server/*`              → server action
	//      (POSTs to the route URL via the action dispatcher).
	//   2. Else, if `fn` is a known client binding           → client handler
	//      (either a `$lib/*` import or a function declared
	//       in the top `<script>` block).
	//   3. Else                                              → native inline
	//      `<button onclick="fn(args)">` — legacy escape hatch.
	//
	// The `compileTemplate` branch at `template.ts:1030` dispatches rule
	// 1 vs rules 2/3 based on whether the callee name is present in
	// `actionNames`. So `actionNames` must contain EXACTLY the server-
	// action callees — no more, no less.
	//
	// `parsed.actionFunctions` from the parser conflates both categories
	// (it collects every `action={…}` + every `on<event>={…}` callee).
	// We filter it down to just the ones that are also `$server/*`
	// imports. That matches the CLI's effective behavior: only functions
	// authored as server work become server-action dispatches.
	const rawActionFunctions = parsed.actionFunctions ?? [];
	const serverRpcFunctions = new Set(parsed.serverRpcFunctions ?? []);
	const actionAliases = parsed.actionAliases ?? [];
	const actionAliasTargets = new Map(
		actionAliases.map((alias) => [alias.name, alias.target] as const),
	);
	const augmentedActionNames = new Set(actionAliases.map((alias) => alias.name));
	const actionNames = new Set(
		rawActionFunctions.filter((name) =>
			serverRpcFunctions.has(name) || augmentedActionNames.has(name),
		),
	);
	for (const name of augmentedActionNames) actionNames.add(name);
	// Components can declare `action={fn}` props (e.g. `<Card action={save}>`).
	// The component compiler scans each component's own template for
	// `action={…}` prop sites and reports them via `getActionPropNames`;
	// `resolveActionProps` then walks THIS template, looks at each
	// component tag's attribute list, and figures out which local
	// callees flow into those slots. Any callee that's also a
	// `$server/*` import becomes part of the route's `actions` table —
	// without this bubble step, `<Card action={save}>` where `save`
	// comes from `$server/orders` would never get dispatched.
	for (const fnName of componentCompiler.resolveActionProps(
		template,
		componentNames,
		(name: string) => serverRpcFunctions.has(name) || augmentedActionNames.has(name),
	)) {
		actionNames.add(fnName);
	}
	// A component may own a native form and import its action directly
	// from `$server/*`. Those actions belong to the consuming route's
	// dispatcher even though the route template never references the
	// function identifier itself.
	for (const binding of componentCompiler.collectServerActionBindings(componentNames)) {
		actionNames.add(binding.localName);
	}
	const routePreludeScript = stripAugmentedActionsFromServerPrelude(script, actionAliases);
	const neededActionBindings = Array.from(new Set([
		...actionNames,
		...actionAliasTargets.values(),
	]));
	const routePreludePlan = buildSelectiveSsrPrelude({
		scriptBody: routePreludeScript,
		template,
		serverImports: parsed.serverImports ?? [],
		additionalNeededBindings: neededActionBindings,
	});
	const componentModuleImports = componentCompiler.getServerImports().join('\n');
	const moduleImports = mergeImportDeclarations([routePreludePlan.imports.join('\n'), componentModuleImports]
		.filter(Boolean)
		.join('\n'));
	const prelude = routePreludePlan.prelude;
	const requestImportDecls = buildRequestImportDecls(parsed.requestImports ?? []);

	// Per-route event-handler registry. Consumed by `compileTemplate`
	// whenever it sees an `on<event>={…}` attribute. The registry was
	// created during `extractClientFragments` and pre-populated from a
	// template scan, so handler IDs here match what the leading
	// fragment's browser bundle registers with `__kozeClient`.
	const handlerRegistry = leadingHash
		? clientFragments.get(leadingHash)?.handlerRegistry ?? null
		: null;

	// Async boundaries — auto-detected from the template. For every
	// top-level `if/else-if/else` chain whose conditions reference
	// `X.pending | X.error | X.success`, the framework pulls that
	// chain out, compiles it into a render closure, and (at render
	// time) registers it with the stream collector. Authors write
	// plain template control flow — no `<Boundary>` wrapper required.
	//
	// An identifier qualifies as an async binding when it is
	// (a) declared at the top level of the leading `<script>` AND
	// (b) accessed in the template via `.pending`.
	//
	// `.pending` is the shared AsyncValue/action-state tell. Only
	// top-level data vars are considered for streamed async boundaries.
	const topLevelDataVars = new Set(parsed.dataVars ?? []);
	const asyncBindings = new Set(
		[...detectAsyncBindings(template)].filter((name) => topLevelDataVars.has(name) && !actionNames.has(name)),
	);
	const boundaryExtraction = extractAsyncBoundaries(template, asyncBindings);
	const boundariesUsed = boundaryExtraction.boundaries.length > 0;
	const clientTemplatePlan = analyzeClientTemplateReactivity(
		boundaryExtraction.template,
		script,
		componentNames,
		actionNames,
		undefined,
		{
			clientRouteRegistry: handlerRegistry as any,
			augmentedActionNames,
		},
	);

	// `clientRouteRegistry` is typed in `koze` against a private
	// internal interface we can't import by name. Structural typing
	// handles the shape — the method surface we expose matches exactly.
	let body = compileTemplate(boundaryExtraction.template, componentNames, actionNames, undefined, {
		clientRouteRegistry: handlerRegistry as any,
		clientScriptBody: script,
		liveTemplateNames: clientTemplatePlan.reactiveNames,
		augmentedActionNames,
		reactiveOwnerId: leadingHash ?? undefined,
	});

	// NOTE: a brace-balance pre-check was attempted here but produced
	// false positives because `compileTemplate` legitimately emits JS
	// where string-literal or template-interpolation braces don't net
	// to zero at the token-level when analyzed without a full JS parser.
	// A proper implementation would need to acorn-parse the emitted body
	// and surface the first unbalanced brace at its source-line. Left
	// for follow-up; for now, Rollup's downstream "return not allowed
	// here" error points at the route module and is enough to find a
	// stray `}` in the template by visual inspection.
	// Stream-boundary rewrite. For each detected if-chain:
	//
	//  1. Compile the chain's source into a render closure parameterized
	//     on every async binding it references. The same closure is
	//     invoked at SSR time with pending AsyncValues (rendering the
	//     skeleton branch) and at stream-resolve time with success or
	//     error AsyncValues (rendering the final branch).
	//
	//  2. Capture each binding's underlying promise before the register
	//     call reassigns the binding to a pending AsyncValue.
	//
	//  3. Combine the promises with `Promise.all` — the chain streams
	//     atomically when ALL referenced bindings settle, matching how
	//     an author reasons about "this block needs a, b, and c ready
	//     before it can render."
	//
	//  4. Emit `boundaryPlaceholder(id, initialHTML)` wrapping the
	//     closure's pending-state output. The stream dispatcher later
	//     picks up the registered promise, runs `renderSuccess` /
	//     `renderError`, and streams the resolved chunk.
	for (const boundary of boundaryExtraction.boundaries) {
		const marker = boundary.marker;
		const innerBody = compileTemplate(boundary.chainSource, componentNames, actionNames, undefined, {
			clientRouteRegistry: handlerRegistry as any,
			augmentedActionNames,
			reactiveOwnerId: leadingHash ?? undefined,
		});
		const params = boundary.bindings.join(', ');
		const closureName = `__boundary_${boundary.bindings[0]}_${boundary.index}_render`;
		const closureDef = `const ${closureName} = (${params}) => { ${innerBody}; return __html; };`;

		// Capture each binding's raw value BEFORE reassigning — those
		// raw values are the promises (or already-resolved values) we
		// hand to the stream runtime.
		const rawCaptures = boundary.bindings
			.map((b) => `const __boundary_raw_${b} = ${b};`)
			.join('\n\t\t');

		// Combine all raw values through `Promise.resolve` so non-thenable
		// bindings (already resolved literals, rare but possible) flow
		// through cleanly. Each binding's promise is wrapped INDEPENDENTLY
		// into an AsyncValue (`wrapSuccess` on resolve / `wrapError` on
		// reject) so a single failed binding doesn't poison its sibling
		// bindings — historically `Promise.all`'s short-circuit caused the
		// whole boundary to flip to error on any rejection, leaving every
		// binding's `.error` branch firing even when only one had failed.
		// This per-binding wrap gives each branch its own success/error
		// state while preserving "stream when ALL settle" semantics.
		const combinedPromise = `Promise.all([${boundary.bindings
			.map(
				(b) =>
					`Promise.resolve(__boundary_raw_${b}).then(__kozeWrapSuccess, function(__err){ return __kozeWrapError(__err && __err.message ? String(__err.message) : String(__err)); })`,
			)
			.join(', ')}])`;

		// renderSuccess: each `__values[i]` is already an AsyncValue
		// (success or error) thanks to the per-binding wrapping above,
		// so we pass them straight through without re-wrapping.
		const successArgs = boundary.bindings.map((_, idx) => `__values[${idx}]`).join(', ');
		const successHandler = `(__values) => ${closureName}(${successArgs})`;

		// renderError: defensive fallback only. The combined promise no
		// longer rejects (every input maps rejection to a success-shaped
		// error AsyncValue), but if `Promise.all` itself throws for some
		// runtime-internal reason every binding falls back to error.
		const errorArgs = boundary.bindings.map(() => `__kozeWrapError(__message)`).join(', ');
		const errorHandler = `(__message) => ${closureName}(${errorArgs})`;

		// Reassign each binding to a SHARED pending AsyncValue for the
		// initial render. `createPendingValue` returns an empty object
		// with `pending=true, error=null, success=false` — that's what
		// every binding evaluates to during SSR up to the boundary
		// site. Must happen AFTER `rawCaptures` stashes the promises.
		const reassignPending = boundary.bindings
			.map((b) => `${b} = __boundary_pending;`)
			.join('\n\t\t');

		const pendingArgs = boundary.bindings.map(() => '__boundary_pending').join(', ');

		const replacement = `\`);
	{
		${closureDef}
		${rawCaptures}
		const __boundary_id = __kozeNextBoundaryId(${JSON.stringify(boundary.bindings.join('-'))});
		const __boundary_pending = __kozeRegisterBoundary(
			__boundary_id,
			${combinedPromise},
			${successHandler},
			${errorHandler},
		);
		${reassignPending}
		__parts.push(__kozeBoundaryPlaceholder(__boundary_id, ${closureName}(${pendingArgs})));
	}
	__parts.push(\``;
		body = body.split(marker).join(replacement);
	}

	// (Handler registration + bridge are emitted to the leading
	// fragment's browser source during `extractClientFragments`, not
	// here. See `preRegisterHandlers`.)

	// Leading-script dual bundle: emit a JSON data blob + module
	// `<script>` at the very end of the route body. The client bundle
	// reads the blob via `getElementById('__koze_data').textContent`
	// + `JSON.parse(...)` so the payload is never parsed as JavaScript
	// — no risk of XSS via a broken serializer, no visible "live-looking
	// code" in view-source. Matches the pattern Next.js (__NEXT_DATA__),
	// SvelteKit, and Remix (loader data) all use.
	let leadingModuleAppend = '';
	if (leadingHash) {
		const leadingFragment = clientFragments.get(leadingHash);
		const hydrateVars = leadingFragment?.hydrateVars ?? [];
		const hydrateEntries = hydrateVars
			.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
			.map((name) => `${JSON.stringify(name)}: ${name}`)
			.join(', ');
		// `__params` is always included so `koze:request`'s `params`
		// / `slug` virtual imports have a source on the client. Cost is
		// typically a couple of bytes for `{}` when a route has no params.
		const hydratePayload = `{ ${hydrateEntries}${
			hydrateEntries ? ', ' : ''
		}__params: data.params ?? {} }`;
		const leadingScriptTag =
			'<script type="module" src="${resolveClientAsset(' +
			JSON.stringify(leadingHash) +
			')}"></script>';
		// Module `<script type="module">` is implicitly deferred until
		// the document is parsed, so the JSON blob is always present in
		// the DOM by the time the client bundle evaluates.
		// NB: compileTemplate ends its output with `let __html =
		// __parts.join('')`. We push more onto `__parts` after that
		// join, then re-assign `__html` so the appended markup makes it
		// into the final response.
		//
		// If the route uses any `on<event>={…}`, emit the shared client
		// bridge BEFORE the leading fragment. `<script type="module">`
		// preserves document order, so `window.__kozeClient` is
		// defined by the time the leading bundle calls `register(…)`.
		const bridgeTag = leadingFragment?.needsBridge
			? '<script type="module" src="${resolveClientAsset(' +
				JSON.stringify(CLIENT_BRIDGE_HASH) +
				')}"></script>'
			: null;
		const bridgePush = bridgeTag
			? `\n	__parts.push(\`${bridgeTag}\\n\`);`
			: '';
		leadingModuleAppend = `
	__parts.push('<script type="application/json" id="__koze_data">' + __kozeSerializeData(${hydratePayload}) + '</' + 'script>\\n');${bridgePush}
	__parts.push(\`${leadingScriptTag}\\n\`);
	__html = __parts.join('');`;
	}

	const manifestImport = leadingHash
		? `import { resolveClientAsset } from 'koze:manifest';\n`
		: '';

	// Stream-boundary runtime imports. Only emitted for routes that
	// declare a `<Boundary>` element — routes without boundaries pay
	// zero cost. The dispatcher side of the streaming protocol lives
	// in `koze/vite/runtime/dispatch.js`; these imports give the
	// route's `render()` access to the compile-time primitives.
	const streamRuntimeImport = boundariesUsed
		? `import {\n\t__registerBoundary as __kozeRegisterBoundary,\n\t__nextBoundaryId as __kozeNextBoundaryId,\n\tboundaryPlaceholder as __kozeBoundaryPlaceholder,\n\t__wrapSuccess as __kozeWrapSuccess,\n\t__wrapError as __kozeWrapError,\n} from '@kuratchi/koze/runtime/stream.js';\n`
		: '';

	// Export the action map so the request dispatcher can call server
	// functions referenced via `<form action={fn}>`. Names are preserved
	// — server module imports are hoisted at module scope, so the
	// identifiers are in lexical range at module eval time.
	//
	// Layout actions bubble up: a form `<form action={fn}>` inside any
	// `layout.koze` on the chain should dispatch when the user POSTs
	// to a page under that layout. We spread each layout's `actions`
	// export into our own (outermost→innermost so a page can override a
	// layout action by re-exporting the same name). The dispatcher
	// stays layout-ignorant — it just sees a single `actions` table on
	// the matched page module.
	const actionExportEntries = Array.from(actionNames)
		.map((name) => `\t${JSON.stringify(name)}: ${actionAliasTargets.get(name) ?? name},`)
		.join('\n');
	const layoutActionSpreads = layoutChain
		.map((p) => `\t...(__kozeLayout_${layoutModuleHash(p)}.actions ?? {}),`)
		.join('\n');
	const mergedActionBody = [layoutActionSpreads, actionExportEntries]
		.filter((chunk) => chunk.length > 0)
		.join('\n');
	const actionsExport = mergedActionBody
		? `\nexport const actions = {\n${mergedActionBody}\n};\n`
		: `\nexport const actions = {};\n`;

	const rpcNameMap = new Map<string, string>();
	let rpcCounter = 0;
	for (const fnName of parsed.pollFunctions ?? []) {
		if (!rpcNameMap.has(fnName)) {
			rpcNameMap.set(fnName, `rpc_${routeModuleHash(importerAbsPath)}_${rpcCounter++}`);
		}
	}
	for (const query of parsed.dataGetQueries ?? []) {
		if (!rpcNameMap.has(query.fnName)) {
			rpcNameMap.set(query.fnName, `rpc_${routeModuleHash(importerAbsPath)}_${rpcCounter++}`);
		}
	}
	const rpcEntries = new Map<string, string>();
	for (const fnName of parsed.pollFunctions ?? []) {
		const rpcId = rpcNameMap.get(fnName) ?? fnName;
		rpcEntries.set(rpcId, fnName);
	}
	for (const binding of componentCompiler.collectServerRpcBindings(componentNames)) {
		const rpcId = `rpc_component_${componentRpcHash(binding.sourceKey, binding.importedName)}`;
		if (!rpcEntries.has(rpcId)) {
			rpcEntries.set(rpcId, binding.localName);
		}
	}
	const rpcExport = rpcEntries.size > 0
		? `\nexport const rpc = {\n${Array.from(rpcEntries.entries()).map(([rpcId, localName]) => `\t${JSON.stringify(rpcId)}: ${localName},`).join('\n')}\n};\n`
		: `\nexport const rpc = {};\n`;
	const allowedQueriesExport = rpcEntries.size > 0
		? `export const allowedQueries = [${Array.from(rpcEntries.keys()).map((rpcId) => JSON.stringify(rpcId)).join(', ')}];\n`
		: `export const allowedQueries = [];\n`;

	// Inside `render(data)`, shadow every action function identifier with
	// its per-request state object (`{ error, pending, success }`). The
	// state object is seeded on `data` by the dispatcher for every GET and
	// populated with `error` on an action failure. This makes
	// `<actionFn>.error` in the template resolve to the state, not the
	// hoisted function reference (which would always be `undefined`).
	//
	// We keep the fallback to the function itself (`?? <name>`) so bare
	// identifier usage in JSX-ish contexts like `<form action={fn}>`
	// still sees a truthy value at render time — though in practice the
	// template compiler rewrites those into string literals anyway.
	const actionStateDecls = Array.from(actionNames)
		.map(
			(name) =>
				`\tconst ${name} = (data && data[${JSON.stringify(name)}]) ?? { error: undefined, pending: false, success: false };`
		)
		.join('\n');

	// Every route imports the chain of layouts that wrap it, outermost
	// first. The chain is computed in the `load` hook via
	// `layoutChainForRoute`. Each entry gets its own local binding
	// `__kozeLayout_<hash>`. If the chain is empty (no layout file
	// anywhere on the ancestor chain), the legacy `koze:layout`
	// module (a no-op when the root layout is absent) is imported so
	// existing setups without nested layouts still behave as before.
	const layoutChainImports = layoutChain.length > 0
		? layoutChain
			.map((p) => {
				const hash = layoutModuleHash(p);
				return `import * as __kozeLayout_${hash} from ${JSON.stringify(NESTED_LAYOUT_VIRTUAL_PREFIX + hash)};`;
			})
			.join('\n') + '\n'
		: `import * as __kozeLayout from 'koze:layout';\n`;
	const layoutImport = `${layoutChainImports}import * as __kozeApp from 'koze:app';\n`;

	// Component function declarations — one `function __c_<name>(props,
	// __esc) { … }` per imported `.koze` component. The compiler's
	// `getCompiledComponents()` returns the de-duped set across the
	// whole build (cached per-plugin). Each component lives at module
	// scope so it's in lexical range when the route's `render()`
	// invokes `__c_card({...}, __esc)` from the `compileTemplate`
	// output.
	const componentDecls = componentCompiler.getCompiledComponents().join('\n\n');
	// Component styles — every scoped `<style>` block from imported
	// components, joined into a single string the route's render
	// pushes into its output before the route body. The styles are
	// already escaped for template-literal embedding (see
	// `escapeTemplateLiteral` in component-pipeline). When a route
	// imports no components, the array is empty and the push is
	// optimized into a literal '' that minifiers DCE.
	const componentStyles = componentCompiler.collectStyles(componentNames);
	// `compileTemplate`'s output begins with `const __parts = [];`. We
	// inject the component-style push immediately AFTER that line so
	// the styles land at the very top of the rendered route HTML —
	// which means they sit inside the layout's <slot> and inside the
	// app shell's <body>, ahead of any user markup. Browsers tolerate
	// `<style>` anywhere in the document; the alternative (head
	// injection) would require a separate stream-time rewrite step
	// that earns nothing the inline pattern doesn't.
	const componentStylesInjection = componentStyles.length > 0
		? `__parts.push(\`${componentStyles.join('')}\`);`
		: '';

	// `async` so top-level `await` in the leading script (e.g. `const x =
	// await $serverFn()`) is valid inside the function body. Worker
	// callers must `await render()`.
	//
	// `__kozeSerializeData` is defined inside `render()` so routes
	// without a leading-script hydration payload still pay zero cost
	// (no closure over a module-level helper, minifiers can DCE it).
	const code = `${manifestImport}${streamRuntimeImport}${layoutImport}${moduleImports}
${componentDecls}
${actionsExport}
${rpcExport}${allowedQueriesExport}
export async function render(data) {
	const __rawHtml = (v) => (v == null ? '' : String(v));
	const __sanitizeHtml = (v) => {
		let html = __rawHtml(v);
		html = html.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, '');
		html = html.replace(/<iframe\\b[^>]*>[\\s\\S]*?<\\/iframe>/gi, '');
		html = html.replace(/<object\\b[^>]*>[\\s\\S]*?<\\/object>/gi, '');
		html = html.replace(/<embed\\b[^>]*>/gi, '');
		html = html.replace(/\\son[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
		html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*([\"'])\\s*javascript:[\\s\\S]*?\\2/gi, ' $1=\"#\"');
		html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*javascript:[^\\s>]+/gi, ' $1=\"#\"');
		html = html.replace(/\\ssrcdoc\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
		return html;
	};
	const __esc = (v) => {
		if (v == null) return '';
		return String(v)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	};
	const __kozeSerializeData = (value) => {
		let s;
		try { s = JSON.stringify(value); } catch { s = undefined; }
		if (s === undefined) return 'null';
		// The payload lives inside <script type="application/json">, so the
		// browser never parses it as JavaScript — no XSS-via-unquoted-JSON.
		// The only remaining hazard is the HTML tokenizer bailing out of
		// the script tag if it encounters a literal '</' sequence; escape
		// '<' (covering '</', '<!--', '<script', etc.) to '\u003c'.
		// U+2028 / U+2029 are preserved valid JSON but some older parsers
		// choke, so we escape them too — cheap insurance.
		const __lineSep = String.fromCharCode(0x2028);
		const __paraSep = String.fromCharCode(0x2029);
		return s
			.split('<').join('\\\\u003c')
			.split(__lineSep).join('\\\\u2028')
			.split(__paraSep).join('\\\\u2029');
	};

${requestImportDecls}
${actionStateDecls}

	${prelude}

	${injectComponentStyles(body, componentStylesInjection)}${leadingModuleAppend}
	const __routeHtml = __html;
	${composeLayoutChain(layoutChain)}
	return __kozeApp.render(data, __layoutHtml);
}

export const __kozeRoute = { kind: 'page', actions, rpc, allowedQueries };
`;
	return {
		code: appendInlineSourceMap(
			code,
			createKuratchiSourceMap({
				generatedCode: code,
				source,
				sourcePath: importerAbsPath,
				file: path.basename(importerAbsPath) + '.js',
			}),
		),
		watchFiles: componentWatchFiles,
	};
}

/**
 * Inject a `__parts.push(<styles>);` statement immediately after the
 * `const __parts = [];` line that `compileTemplate` always emits as
 * its first output. This places component styles at the top of the
 * rendered HTML — inside the route's first emitted chunk, ahead of
 * any user markup, but after `__parts` exists so the push is valid.
 *
 * When the injection string is empty, returns the body unchanged.
 */
function injectComponentStyles(compiledBody: string, injection: string): string {
	if (!injection) return compiledBody;
	const marker = 'const __parts = [];';
	const idx = compiledBody.indexOf(marker);
	if (idx === -1) {
		// `compileTemplate` always starts with this line; if it doesn't,
		// fall back to prepending — styles still land near the top of
		// the rendered fragment, just inside whatever the first
		// statement of the body is.
		return injection + '\n\t' + compiledBody;
	}
	const before = compiledBody.slice(0, idx + marker.length);
	const after = compiledBody.slice(idx + marker.length);
	return before + '\n\t' + injection + after;
}


export interface GeneratedContentModule {
	code: string;
	watchFiles: string[];
}

export function generateContentModule(projectRoot: string): GeneratedContentModule {
	const contentRoot = path.resolve(projectRoot, 'src', 'content');
	const entries = discoverContentEntries(projectRoot);
	const watchFiles = fs.existsSync(contentRoot) ? [contentRoot] : [];
	const seenIds = new Set<string>();
	const payload = entries.map((entry) => {
		const key = `${entry.group}:${entry.id}`;
		if (seenIds.has(key)) {
			throw new Error(
				`[koze:content] Duplicate content id "${entry.id}" in src/content/${entry.group}. ` +
				'Use one Markdown file per content id.',
			);
		}
		seenIds.add(key);
		watchFiles.push(entry.absPath);
		return {
			group: entry.group,
			id: entry.id,
			href: entry.href,
			file: entry.file,
			source: fs.readFileSync(entry.absPath, 'utf-8'),
		};
	});

	return {
		watchFiles,
		code: [
			`import { createContentRegistry } from '@kuratchi/koze/runtime/content.js';`,
			`const entries = ${JSON.stringify(payload)};`,
			`export const content = createContentRegistry(entries);`,
			`export default content;`,
			'',
		].join('\n'),
	};
}

/**
 * Emit the body of the `koze:manifest` virtual module.
 *
 * In dev (no build manifest exists yet) the helper returns a live
 * `/@id/virtual:koze-client/<hash>.ts` URL that Vite's dev server
 * transforms on demand.
 *
 * In prod, the client Rollup build runs first and writes
 * `dist/client/.vite/manifest.json`. We read it synchronously here —
 * safe because the SSR environment build runs *after* the client build
 * in Vite's default env order, so the file exists by the time this is
 * loaded. The manifest is then baked into the module as a literal
 * object; no file IO at request time.
 */

export function resolveServerFile(
	projectRoot: string,
	serverDir: string,
	subpath: string,
): string | null {
	const base = path.resolve(projectRoot, serverDir, subpath);
	const candidates = [
		base,
		base + '.ts',
		base + '.js',
		base + '.mjs',
		path.join(base, 'index.ts'),
		path.join(base, 'index.js'),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return null;
}

/**
 * Walk a TypeScript source file's AST to collect every exported
 * identifier name. We need this to generate the right number of RPC
 * stub exports — a Proxy-catch-all would work at runtime but break
 * Rollup's static import-analysis in the client bundle.
 *
 * Supports: `export function x`, `export const y`, `export class Z`,
 * `export { a, b }`, `export default <expr>`. For `export default`,
 * the stub exports a `default` binding (callable the same way).
 */
function collectExportedNames(sourceFile: string): string[] {
	if (!fs.existsSync(sourceFile)) return [];
	const source = fs.readFileSync(sourceFile, 'utf-8');
	const sf = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true);
	const names = new Set<string>();
	for (const stmt of sf.statements) {
		if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
			for (const spec of stmt.exportClause.elements) {
				names.add((spec.name as ts.Identifier).text);
			}
			continue;
		}
		const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
		if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
		const hasDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
		if (hasDefault) {
			names.add('default');
			continue;
		}
		if (ts.isFunctionDeclaration(stmt) && stmt.name) names.add(stmt.name.text);
		else if (ts.isClassDeclaration(stmt) && stmt.name) names.add(stmt.name.text);
		else if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
			}
		}
	}
	return Array.from(names);
}

/**
 * Emit the SSR-only `koze:rpc-map` module. Every `$server/<subpath>`
 * specifier the client env has referenced gets a literal dynamic-import
 * loader exposed through the `lookup(subpath)` helper.
 *
 * The literal specifiers are critical for Rollup / Worker bundling: a
 * computed `import('$server/' + subpath)` cannot be resolved at build
 * time. Keeping the import behind a loader preserves code splitting and
 * avoids evaluating every server module when the Worker starts.
 */
export function generateRpcMapModule(
	projectRoot: string,
	serverDir: string,
	referenced: Set<string>,
): string {
	const entries = Array.from(referenced).filter((subpath) => {
		const file = resolveServerFile(projectRoot, serverDir, subpath);
		return file !== null;
	});
	const mapEntries = entries
		.map((subpath) => `\t${JSON.stringify(subpath)}: () => import(${JSON.stringify(`$server/${subpath}`)})`)
		.join(',\n');
	return `const MAP = {
${mapEntries}
};

export async function lookup(subpath) {
	const load = MAP[subpath];
	return load ? load() : null;
}
`;
}

/**
 * Emit a client-safe stub module for `$server/<subpath>`. Each exported
 * identifier becomes a Kuratchi Channel call over Cap'n Web. The dispatcher
 * imports the real module server-side and invokes the function with the
 * deserialized args.
 *
 * Non-function exports become the same shape — the server dispatcher
 * returns their current value if they're not callable, which matches
 * the typical usage pattern (`await getCurrentUser()` over a `locals`
 * constant, etc.).
 */
export function generateRpcStubModule(subpath: string, serverFile: string | null): string {
	const names = serverFile ? collectExportedNames(serverFile) : [];
	const runtimePrelude = `import { createKuratchiRpcAsyncValue } from '@kuratchi/koze/runtime/channel.js';

function __kozeRpc(rpcId, args) {
	return createKuratchiRpcAsyncValue({ carrier: 'capnweb-http', target: 'server', op: rpcId, args });
}`;
	const stubs = names.map((name) => {
		const rpcId = `${subpath}/${name}`;
		if (name === 'default') {
			return `function __default(...args) {
	return __kozeRpc(${JSON.stringify(rpcId)}, args);
}
export default __default;`;
		}
		return `export function ${name}(...args) {
	return __kozeRpc(${JSON.stringify(rpcId)}, args);
}`;
	});
	return `// RPC stub for $server/${subpath} — generated by koze/vite
${runtimePrelude}

${stubs.join('\n\n')}
`;
}

/** Emit Koze's HTTP handler. The application owns the Worker module around it. */
export function generateWorkerModule(): string {
	return `export { handle as handleRequest } from 'koze:dispatch';\n`;
}
