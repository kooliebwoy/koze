import { cookies } from 'koze:cookies';
import { headers, locals, method, params, pathname, request, searchParams, slug, url } from 'koze:request';
import { env } from 'cloudflare:workers';

export async function inspectContext(delay: number) {
	const snapshot = () => ({
		slug: slug ?? null,
		param: params.slug ?? null,
		localParam: (locals.params as { slug?: string } | undefined)?.slug ?? null,
		session: cookies.get('session') ?? null,
		header: headers.get('cookie'),
		requestHeader: request.headers.get('cookie'),
		method,
		pathname,
		url: url.pathname,
		query: searchParams.get('view'),
	});
	const before = snapshot();
	await new Promise<void>((resolve) => setTimeout(resolve, delay));
	return { before, after: snapshot() };
}

export function increment() {
	return env.COUNTER.getByName('lost-rpc-response').increment();
}

export function fail() {
	throw new Error('private failure detail');
}
