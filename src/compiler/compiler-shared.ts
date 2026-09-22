export function toSafeIdentifier(input: string): string {
  const normalized = input.replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[A-Za-z_$]/.test(normalized) ? normalized : `_${normalized}`;
}

/**
 * Stable function-name derivation for compiled `.koze` components.
 *
 * The component pipeline emits a function `function __c_<name>(props,
 * __esc) { ... }` for every imported component, and the template
 * compiler emits a CALL to that function at every component-tag site
 * (`<Card title="..." />` becomes `__c_<name>({ title: "..." }, __esc)`).
 *
 * Both sides MUST agree on the derived name, so this helper is the
 * single source of truth.
 *
 * Three input shapes correspond to the three accepted import forms:
 *
 *   "stat-card"                  → "__c_stat_card"        ($lib import)
 *   "@kuratchi/ui:badge"         → "__c_badge"            (package import)
 *   "__rel__:./widgets/chart"    → "__c_rel_chart_<hash>" (relative import)
 *
 * Relative paths get a stable hash suffix derived from the relative
 * specifier so two `chart.koze` files in different directories
 * don't collide. The hash is content-free (path only), so a file
 * being edited doesn't change the function name and produce gratuitous
 * cache invalidation.
 */
export function componentFuncName(fileName: string, hashSpec?: string): string {
  // Relative import: `__rel__:./path/to/component`
  if (fileName.startsWith('__rel__:')) {
    const relPath = fileName.slice('__rel__:'.length); // "./widgets/chart"
    const stem = relPath.split(/[\\/]/).pop() ?? 'component';
    const safeStem = stem.replace(/[^A-Za-z0-9_]/g, '_');
    // 8-char hash of the relative spec (caller may pass a richer key
    // — typically the absolute resolved path — for stability across
    // duplicate-named files).
    const hashInput = hashSpec ?? relPath;
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
      hash = ((hash << 5) - hash + hashInput.charCodeAt(i)) | 0;
    }
    const hashHex = (hash >>> 0).toString(16).padStart(8, '0').slice(0, 8);
    return `__c_rel_${safeStem}_${hashHex}`;
  }
  // Package or $lib import: split off any `pkg:` prefix and sanitize
  // the remainder.
  const name = fileName.includes(':') ? fileName.split(':').pop()! : fileName;
  return '__c_' + name.replace(/[^A-Za-z0-9_]/g, '_');
}
