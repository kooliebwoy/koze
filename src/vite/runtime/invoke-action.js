/**
 * Pure core of the action-dispatch calling convention. Lives in its own
 * module so it can be unit-tested without dragging in the Worker-only
 * virtual-module imports (`koze:routes`, internal middleware entry, …)
 * that `dispatch.js` pulls in at the top level.
 *
 * Calling convention: `fn(...positionalArgs, context)`.
 *
 * The trailing argument is always the per-request **context object**:
 *   { formData, request, url, params }
 * Destructure what you need. `formData` is always present for HTML form
 * actions (empty FormData for RPC-less triggers). `request` / `url` /
 * `params` carry per-request context.
 *
 * Any arguments *before* the context are the positional arguments from
 * a button-triggered action's `_args` payload, matching the author's
 * call site. `<form action={fn}>` submissions carry zero positional
 * args, so the handler receives only the context object.
 *
 * Env / locals are reached through `env` / `locals` from
 * `koze`, which read the module-scope context `handle()`
 * seeded per-request. We do NOT re-pass them here — having one
 * canonical accessor keeps `$server/*` modules portable between
 * render, RPC, and action code.
 *
 * Invocation shapes (call-site → handler signature):
 *
 *   <form action={save}>
 *     → save({ formData, request, url, params })
 *     handler: async function save({ formData, ... }) { … }
 *
 *   <button onclick={deleteItem(item.id)}>
 *     → deleteItem(item.id, { formData, request, url, params })
 *     handler: async function deleteItem(id, { formData, ... }) { … }
 *
 *   <button onclick={move(item.id, 'done')}>
 *     → move(item.id, 'done', { formData, request, url, params })
 *     handler: async function move(id, target, { formData, ... }) { … }
 *
 * The signature matches the call-site naturally — no `args[0]`
 * unwrapping, positional args line up with the handler's parameter
 * list. Forms and buttons share the same transport (POST with
 * `_action` / `_args`) and the same dispatch path, preserving
 * augmented form submission and POST-Redirect-GET semantics.
 */
export function invokeAction(fn, { spreadArgs, formData, request, url, params }) {
	const ctx = { formData, request, url, params };
	return fn(...spreadArgs, ctx);
}
