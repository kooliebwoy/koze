import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';

import { generateRenderFunction } from '../src/compiler/template.ts';
import { parseFile } from '../src/compiler/parser.ts';
import { parseKuratchiSfc } from '../src/compiler/sfc-parser.ts';
import { getCompilerCorpusByStatus } from '../test/fixtures/compiler-corpus.ts';

type BenchResult = {
  name: string;
  iterations: number;
  durationMs: number;
  opsPerSecond: number;
};

const DEFAULT_ITERATIONS = 10;
const ITERATIONS = Number(process.env.COMPILER_BENCH_ITERS ?? DEFAULT_ITERATIONS);
const INCLUDE_SVELTE_BENCH = process.env.INCLUDE_SVELTE_BENCH === '1';

let sink = 0;
const BENCH_CORPUS = getCompilerCorpusByStatus('ported-pass').filter((fixture) => fixture.koze && fixture.svelte);

function compileKuratchi(source: string, name: string): string {
  const sfc = parseKuratchiSfc(source, {
    kind: 'route',
    filePath: `bench/${name}.koze`,
  });
  const parsed = parseFile(source, {
    kind: 'route',
    filePath: `bench/${name}.koze`,
  });
  return generateRenderFunction(sfc.template.source, parsed.dataVars);
}

function bench(
  name: string,
  iterations: number,
  run: (index: number) => string,
): BenchResult {
  for (let i = 0; i < Math.min(iterations, 5); i++) {
    sink += run(i).length;
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    sink += run(i).length;
  }
  const durationMs = performance.now() - start;

  return {
    name,
    iterations,
    durationMs,
    opsPerSecond: iterations / (durationMs / 1000),
  };
}

function benchSvelteInNode(name: string, generate: 'server' | 'client', iterations: number): BenchResult {
  const script = `
import { performance } from 'node:perf_hooks';
import { compile } from 'svelte/compiler';

const sources = JSON.parse(process.env.SVELTE_BENCH_SOURCES || '[]');
const iterations = Number(process.env.SVELTE_BENCH_ITERATIONS || '1');
const generate = process.env.SVELTE_BENCH_GENERATE || 'server';
let sink = 0;

for (let i = 0; i < Math.min(iterations, 5); i++) {
  sink += compile(sources[i % sources.length], { generate, dev: false }).js.code.length;
}

const start = performance.now();
for (let i = 0; i < iterations; i++) {
  sink += compile(sources[i % sources.length], { generate, dev: false }).js.code.length;
}
const durationMs = performance.now() - start;
console.log(JSON.stringify({ durationMs, sink }));
`;
  const child = spawnSync('node', ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      SVELTE_BENCH_SOURCES: JSON.stringify(BENCH_CORPUS.map((fixture) => fixture.svelte)),
      SVELTE_BENCH_ITERATIONS: String(iterations),
      SVELTE_BENCH_GENERATE: generate,
    },
  });
  if (child.status !== 0) {
    throw new Error(`Svelte benchmark failed: ${child.error?.message || child.stderr || child.stdout || `exit ${child.status}`}`);
  }
  const parsed = JSON.parse(child.stdout.trim()) as { durationMs: number; sink: number };
  sink += parsed.sink;
  return {
    name,
    iterations,
    durationMs: parsed.durationMs,
    opsPerSecond: iterations / (parsed.durationMs / 1000),
  };
}

function printResults(results: BenchResult[]): void {
  const fastest = Math.max(...results.map((result) => result.opsPerSecond));
  console.log(`fixture count: ${BENCH_CORPUS.length}`);
  console.log(`iterations: ${ITERATIONS.toLocaleString()}`);
  console.log('');
  console.log('| Benchmark | Iterations | Duration | Ops/sec | Relative |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const result of results) {
    const relative = result.opsPerSecond / fastest;
    console.log(
      `| ${result.name} | ${result.iterations.toLocaleString()} | ${result.durationMs.toFixed(2)}ms | ${Math.round(result.opsPerSecond).toLocaleString()} | ${relative.toFixed(2)}x |`,
    );
  }
  console.log('');
  console.log('Note: Kuratchi benchmark covers SFC parse, route parse/analysis, and render function generation.');
  if (!INCLUDE_SVELTE_BENCH) {
    console.log('Set INCLUDE_SVELTE_BENCH=1 to also spawn Node and compare svelte/compiler on the equivalent small corpus.');
  }
  console.log('');
  console.log(`sink: ${sink}`);
}

function main(): void {
  const results: BenchResult[] = [];

  results.push(bench('Kuratchi parse + render codegen', ITERATIONS, (index) => {
    const fixture = BENCH_CORPUS[index % BENCH_CORPUS.length];
    return compileKuratchi(fixture.koze!, fixture.name);
  }));

  if (INCLUDE_SVELTE_BENCH) {
    results.push(benchSvelteInNode('Svelte compiler SSR', 'server', ITERATIONS));
    results.push(benchSvelteInNode('Svelte compiler client', 'client', ITERATIONS));
  }

  printResults(results);
}

main();
