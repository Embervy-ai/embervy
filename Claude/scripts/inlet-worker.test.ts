import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ContextOptions = {
  recent?: string; message?: string; failure?: string; root?: string;
  env?: Record<string, string>; hits?: any[]; expanded?: any[]; lookup?: any;
};
async function contextRun(options: ContextOptions = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'inlet-context-'));
  const capture = join(root, 'context-calls.json');
  const preload = join(root, 'context-offline.ts');
  writeFileSync(preload, `
    import { writeFileSync } from 'node:fs';
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      writeFileSync(${JSON.stringify(capture)}, JSON.stringify(calls));
      if (url.origin === 'https://openrouter.ai') {
        const failure = ${JSON.stringify(options.failure ?? '')};
        if (failure === 'status') return new Response('DO NOT LOG RESPONSE', { status: 503 });
        if (failure === 'timeout') throw new DOMException('DO NOT LOG ERROR', 'TimeoutError');
        if (failure === 'transport') throw new Error('DO NOT LOG ERROR');
        if (failure === 'envelope') return new Response('DO NOT LOG RESPONSE');
        const content = failure === 'parse' ? 'not json' : failure === 'empty' ? '{}' : JSON.stringify({
          persons: ['speaker', 'earlier speaker'], places: ['venue', 'earlier venue'],
          rag_queries: [{q: 'storage decision', cat: 'technical'}], turn_category: 'technical',
        });
        return Response.json({ choices: [{ message: { content } }] });
      }
      if (url.origin === 'https://memory.test' && url.pathname === '/lookup')
        return Response.json(${JSON.stringify(options.lookup ?? { card: { description: 'entity context' }, recent: [], relations: [] })});
      if (url.origin === 'https://rag.test') {
        if (url.pathname === '/search') return Response.json({ results: ${JSON.stringify(options.hits ?? [
          {filename:'excerpt.md',chunkIndex:0,score:0.8,sources:['rerank'],content:'retrieved context'},
        ])} });
        if (url.pathname === '/expand') return Response.json({ results: ${JSON.stringify(options.expanded ?? [])}, vetoes: [] });
      }
      throw new Error('Unexpected offline route');
    };
  `);
  try {
    const args = [process.execPath, '--no-env-file', '--preload', preload,
      join(import.meta.dir, 'inlet-worker.ts'), options.message ?? 'What did speaker say about venue?'];
    if (options.recent !== undefined) args.push(options.recent);
    const child = Bun.spawn(args, {
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: root,
        OPENROUTER_API_KEY: 'offline', EMBERVY_API_KEY: 'offline', EMBERVY_URL: 'https://memory.test',
        RAG_URL: 'https://rag.test', INLET_TEMPORAL: '0', ...options.env },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0);
    return { stdout, stderr, calls: JSON.parse(readFileSync(capture, 'utf8')) as any[] };
  } finally { if (!options.root) rmSync(root, { recursive: true, force: true }); }
}

test('recent query context is bounded to its newest end and cannot supply entity lookups', async () => {
  const recent = 'discard this prefix' + 'x'.repeat(1600) + '\nUser: earlier speaker discussed storage at earlier venue.';
  const withRecent = await contextRun({ recent });
  const classifier = withRecent.calls.find(call => call.path.endsWith('/completions')).body.messages[1].content;
  expect(classifier).toContain('Earlier conversation (context only for query variants):\n' + recent.slice(-1500));
  expect(classifier).not.toContain('discard this prefix');
  expect(classifier).toContain('Current message: What did speaker say about venue?');
  expect(classifier).toContain('Extract persons and places from the current message only');
  expect(withRecent.calls.filter(call => call.path === '/lookup').map(call => call.query.name)).toEqual(['speaker', 'venue']);
  expect(withRecent.calls.find(call => call.path === '/search').body.query).toBe('storage decision');
  const withoutRecent = await contextRun();
  const original = withoutRecent.calls.find(call => call.path.endsWith('/completions')).body.messages[1].content;
  expect(original).toEndWith('Message: What did speaker say about venue?');
  expect(original).not.toContain('Earlier conversation');
  expect(withoutRecent.calls.filter(call => call.path === '/lookup').map(call => call.query.name))
    .toEqual(['speaker', 'earlier speaker', 'venue', 'earlier venue']);
});

test('a pronoun follow-up uses recent query context without looking up stale entities', async () => {
  const result = await contextRun({ message: 'and that one?', recent: 'User: storage migration options\nAgent: use the smaller volume' });
  const classifier = result.calls.find(call => call.path.endsWith('/completions')).body.messages[1].content;
  expect(classifier).toContain('storage migration options');
  expect(classifier).toContain('Current message: and that one?');
  expect(result.calls.filter(call => call.path === '/lookup')).toEqual([]);
});

const notice = '(Memory search ran without its query step this turn; results come from the raw message and may be less precise.)';
for (const [failure, reason] of [
  ['status', 'status 503'], ['timeout', 'timeout'], ['transport', 'request failure'],
  ['parse', 'parse failure'], ['empty', 'parse failure'], ['envelope', 'parse failure'],
]) {
  test(`classifier ${failure} emits one safe notice and searches the raw message`, async () => {
    const result = await contextRun({failure});
    expect(result.stdout.split('\n')[0]).toBe(notice);
    expect(result.stdout.split(notice)).toHaveLength(2);
    expect(result.stdout).toContain('retrieved context');
    expect(result.stderr.trim()).toBe(`[inlet/classifier] ${reason}`);
    expect(result.stderr.length).toBeLessThan(100);
    expect(result.stderr).not.toContain('DO NOT LOG');
    expect(result.stderr).not.toContain('offline');
    expect(result.calls.find(call => call.path === '/search').body.query).toBe('What did speaker say about venue?');
    const working = await contextRun();
    expect(working.stdout).not.toContain(notice);
    expect(working.stderr).toBe('');
    expect(working.calls.find(call => call.path === '/search').body.query).toBe('storage decision');
  });
}

async function hookRun(transcript?: any[]) {
  const root = mkdtempSync(join(tmpdir(), 'inlet-hook-'));
  try {
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'Claude'));
    symlinkSync(import.meta.dir, join(root, 'Claude/scripts'), 'dir');
    writeFileSync(join(root, '.env'), '');
    const capture = join(root, 'arguments.json');
    const script = join(root, 'capture.ts');
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))); console.log('context');`);
    writeFileSync(join(root, 'bin/bun'), `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(script)} "$@"\n`, {mode:0o755});
    const path = join(root, 'transcript.jsonl');
    if (transcript) writeFileSync(path, transcript.map(entry => JSON.stringify(entry)).join('\n'));
    mkdirSync(join(root, 'logs'));
    const hook = readFileSync(join(import.meta.dir, 'inlet.sh'), 'utf8');
    const invocation = hook.match(/RESULT=\$\(timeout 25s bash[\s\S]*?\nWORKER\n\)/)?.[0];
    expect(invocation).toBeDefined();
    const child = Bun.spawn(['bash', '-c', invocation + '\nprintf "%s" "$RESULT"'], {
      env: { PATH: join(root, 'bin') + ':' + (process.env.PATH || '/usr/bin:/bin'),
        HOME: root, EMBERVY_HOME: root, PROMPT: 'and that one?', TRANSCRIPT: path },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('context');
    return JSON.parse(readFileSync(capture, 'utf8')) as string[];
  } finally { rmSync(root, {recursive:true, force:true}); }
}

function transcriptExchange(index: number, text = `reply ${index}`) {
  return [
    {type:'user', message:{role:'user', content:`question ${index}`}},
    {type:'assistant', message:{role:'assistant', content:[
      {type:'text', text:'internal commentary'},
      {type:'tool_use', id:`reply-${index}`, name:'mcp__app__reply', input:{text}},
      {type:'tool_use', id:`failed-${index}`, name:'mcp__app__reply', input:{text:'failed delivery'}},
    ]}},
    {type:'user', message:{role:'user', content:[
      {type:'tool_result', tool_use_id:`reply-${index}`, content:'sent'},
      {type:'tool_result', tool_use_id:`failed-${index}`, is_error:true, content:'failed'},
    ]}},
  ];
}

test('hook passes only the last three exchanges and fails open without a transcript', async () => {
  const entries = [0,1,2,3].flatMap(index => transcriptExchange(index));
  entries.push({type:'user', message:{role:'user', content:'and that one?'}} as any);
  const args = await hookRun(entries);
  expect(args).toHaveLength(3);
  expect(args[1]).toBe('and that one?');
  expect(args[2]).toBe([1,2,3].map(index => `User: question ${index}\nAgent: [App] reply ${index}`).join('\n'));
  expect(args[2]).not.toContain('internal commentary');
  expect(args[2]).not.toContain('failed delivery');
  expect(await hookRun()).toHaveLength(2);
});

test('hook shares its 1500 characters between the lines, so one long reply cannot push the question out', async () => {
  const text = 'long reply ' + 'x'.repeat(1600) + ' end';
  const args = await hookRun(transcriptExchange(0, text));
  expect(args).toHaveLength(3);
  expect(args[2].length).toBeLessThanOrEqual(1500);
  expect(args[2].split('\n')[0]).toBe('User: question 0');
  expect(args[2]).toContain('Agent: [App] long reply');
});

test('hook recent text counts room and direct-line answers as the agent speaking', async () => {
  const args = await hookRun([
    {type:'user', message:{role:'user', content:'<channel source="app" kind="room">[Hall/Rowan] room question</channel>'}},
    {type:'assistant', message:{role:'assistant', content:[
      {type:'tool_use', id:'room-1', name:'mcp__app__room', input:{text:'room answer'}},
      {type:'tool_use', id:'peer-1', name:'mcp__app__peer', input:{to:'Peer', text:'peer answer'}},
    ]}},
    {type:'user', message:{role:'user', content:[
      {type:'tool_result', tool_use_id:'room-1', content:'Sent to Hall'},
      {type:'tool_result', tool_use_id:'peer-1', content:'[Direct to Peer] id=1'},
    ]}},
  ]);
  expect(args[2]).toContain('Agent: [Room] room answer');
  expect(args[2]).toContain('[Direct/Peer] peer answer');
});

test('hook recent text carries what was said in a channel, without wrapper or the house prompts', async () => {
  const args = await hookRun([
    {type:'user', message:{role:'user', content:'[silent] [gateway:cache-ping] keep warm'}},
    {type:'user', isMeta:true, message:{role:'user', content:'<channel source="app" kind="room" message_id="m1" ts="t">[Hall/Rowan] room words</channel>'}},
  ]);
  expect(args[2]).not.toContain('<channel');
  expect(args[2]).not.toContain('keep warm');
  expect(args[2]).toContain('Rowan: [Hall/Rowan] room words');
});

const cacheHits = Array.from({length: 7}, (_, index) => ({
  filename: `excerpt-${index}.md`, chunkIndex: 0, content: `evidence ${index}`,
  score: 0.9 - index * 0.05, sources: ['rerank'],
}));
async function withCache(action: (root: string, env: Record<string, string>, file: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'inlet-cache-'));
  const directory = join(root, 'cache');
  const counter = join(root, 'counter');
  mkdirSync(directory);
  writeFileSync(counter, '10');
  try {
    await action(root, {INLET_COUNTER_FILE: counter, INLET_CHUNK_CACHE_DIR: directory,
      INLET_DIVERSITY: '0'}, join(directory, 'chunks.json'));
  } finally { rmSync(root, {recursive:true, force:true}); }
}

test('shown chunks yield their slots to fresh candidates and return after the default window', async () => {
  await withCache(async (root, env, file) => {
    const first = await contextRun({root, env, hits: cacheHits.slice(0,5)});
    expect(first.stdout).toContain('evidence 0');
    expect(JSON.parse(readFileSync(file, 'utf8')).shown).toHaveLength(5);
    writeFileSync(env.INLET_COUNTER_FILE, '11');
    const next = await contextRun({root, env, hits: cacheHits});
    expect(next.stdout).not.toContain('evidence 0');
    expect(next.stdout).toContain('evidence 5');
    expect(next.stdout).toContain('evidence 6');
    expect(next.stdout.match(/^\[/gm)).toHaveLength(2);
    expect(next.stdout).toContain('entity context');
    writeFileSync(env.INLET_COUNTER_FILE, '52');
    const expired = await contextRun({root, env, hits: cacheHits.slice(0,5)});
    expect(expired.stdout).toContain('evidence 0');
    expect(expired.stdout.match(/^\[/gm)).toHaveLength(5);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.shown).toHaveLength(5);
    expect(saved.shown.every((entry: any) => entry[1] === 52)).toBe(true);
    expect(readdirSync(env.INLET_CHUNK_CACHE_DIR)).toEqual(['chunks.json']);
  });
});

test('all recent candidates keep only the best three fallback excerpts', async () => {
  await withCache(async (root, env) => {
    await contextRun({root, env, hits: cacheHits.slice(0,5)});
    writeFileSync(env.INLET_COUNTER_FILE, '11');
    const next = await contextRun({root, env, hits: cacheHits.slice(0,5)});
    expect(next.stdout.match(/^\[/gm)).toHaveLength(3);
    for (let index = 0; index < 3; index++) expect(next.stdout).toContain(`evidence ${index}`);
    expect(next.stdout).not.toContain('evidence 3');
    expect(next.stdout).toContain('entity context');
  });
});

test('repeat window is configurable and chunk identity includes the index', async () => {
  await withCache(async (root, env) => {
    env.INLET_CHUNK_REPEAT_TURNS = '2';
    await contextRun({root, env, hits: cacheHits.slice(0,5)});
    writeFileSync(env.INLET_COUNTER_FILE, '12');
    const sameFile = {...cacheHits[0], chunkIndex:1, content:'new index evidence'};
    const next = await contextRun({root, env, hits: [...cacheHits.slice(0,5), sameFile]});
    expect(next.stdout.match(/^\[/gm)).toHaveLength(1);
    expect(next.stdout).toContain('new index evidence');
    expect(next.stdout).not.toContain('evidence 0');
    writeFileSync(env.INLET_COUNTER_FILE, '13');
    const expired = await contextRun({root, env, hits: cacheHits.slice(0,5)});
    expect(expired.stdout.match(/^\[/gm)).toHaveLength(5);
  });
});

for (const broken of ['missing counter', 'invalid counter', 'counter directory', 'missing cache', 'invalid cache', 'cache directory', 'future cache']) {
  test(`${broken} disables suppression without removing retrieval`, async () => {
    await withCache(async (root, env, file) => {
      await contextRun({root, env, hits: cacheHits.slice(0,5)});
      expect(JSON.parse(readFileSync(file, 'utf8')).shown).toHaveLength(5);
      writeFileSync(env.INLET_COUNTER_FILE, '11');
      if (broken === 'missing counter') rmSync(env.INLET_COUNTER_FILE);
      if (broken === 'invalid counter') writeFileSync(env.INLET_COUNTER_FILE, 'not a turn');
      if (broken === 'counter directory') { rmSync(env.INLET_COUNTER_FILE); mkdirSync(env.INLET_COUNTER_FILE); }
      if (broken === 'missing cache') rmSync(file);
      if (broken === 'invalid cache') writeFileSync(file, '{broken');
      if (broken === 'cache directory') { rmSync(file); mkdirSync(file); }
      if (broken === 'future cache') writeFileSync(file, JSON.stringify({version:1, shown:[['excerpt-0.md#0', 99]]}));
      const next = await contextRun({root, env, hits: cacheHits.slice(0,5)});
      expect(next.stdout.match(/^\[/gm)).toHaveLength(5);
      expect(next.stderr).toBe('');
    });
  });
}

test('expansion cannot reintroduce a recently shown chunk', async () => {
  await withCache(async (root, env) => {
    await contextRun({root, env, hits: cacheHits.slice(0,5)});
    writeFileSync(env.INLET_COUNTER_FILE, '11');
    const next = await contextRun({root, env, hits:cacheHits.slice(5),
      expanded:[{...cacheHits[0], edge:'NEXT'}]});
    expect(next.stdout).not.toContain('evidence 0');
    expect(next.stdout).toContain('evidence 5');
    expect(next.stdout).toContain('evidence 6');
  });
});

test('recent conversation uses the same character bound for non-ASCII text', async () => {
  const recent = '💬'.repeat(1600) + '\nUser: storage migration';
  const result = await contextRun({recent, message:'and that one?'});
  const classifier = result.calls.find(call => call.path.endsWith('/completions')).body.messages[1].content;
  expect(classifier).toContain(Array.from(recent).slice(-1500).join(''));
  expect(classifier).not.toContain('💬'.repeat(1500));
  expect(result.calls.filter(call => call.path === '/lookup')).toEqual([]);
});

test('adjacent excerpts retain both identities in the repeat cache', async () => {
  await withCache(async (root, env, file) => {
    env.INLET_DIVERSITY = '1';
    const hits = [cacheHits[0], {...cacheHits[0], chunkIndex:1, content:'adjacent evidence'}];
    await contextRun({root, env, hits});
    expect(JSON.parse(readFileSync(file, 'utf8')).shown.map((entry: any) => entry[0]).sort())
      .toEqual(['excerpt-0.md#0', 'excerpt-0.md#1']);
    writeFileSync(env.INLET_COUNTER_FILE, '11');
    const next = await contextRun({root, env, hits:[...hits, cacheHits[5]]});
    expect(next.stdout).not.toContain('adjacent evidence');
    expect(next.stdout).not.toContain('evidence 0');
    expect(next.stdout).toContain('evidence 5');
  });
});

test('temporal cards and their excerpts ignore the chronicle repeat cache', async () => {
  await withCache(async (root, env, file) => {
    const first = await run(undefined, true, env);
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
    writeFileSync(file, JSON.stringify({version:1, shown:[['Session_99.md#0', 10]]}));
    writeFileSync(env.INLET_COUNTER_FILE, '11');
    const next = await run(undefined, true, env);
    expect(next.stdout).toBe(first.stdout);
    expect(next.stdout).toContain('## Time window (RAG)');
    expect(next.stdout).toContain('ordinary agent evidence');
  });
});

async function run(prefix?: string, temporal = false, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'inlet-prefix-'));
  const capture = join(root, 'calls.json');
  const preload = join(root, 'offline.ts');
  writeFileSync(preload, `
    import { writeFileSync } from 'node:fs';
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://rag.test') throw new Error('Unexpected network request');
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path:url.pathname, query:Object.fromEntries(url.searchParams), body });
      writeFileSync(${JSON.stringify(capture)}, JSON.stringify(calls));
      const scoped = !!process.env.INLET_FILENAME_PREFIX;
      const hit = (filename, content) => ({ filename, content, chunkIndex:0,
        score:0.8, sources:['bm25','rerank'], date:'2026-10-01', totalChunks:2 });
      if (url.pathname === '/search') return Response.json({
        results: scoped ? [hit('Builder_earlier.md', 'builder evidence'),
          hit('Session_99.md', 'PRIVATE AGENT SEARCH')] : [hit('Session_99.md', 'ordinary agent evidence')],
        date_filter: body.dateFrom ? {from:body.dateFrom,to:body.dateTo} : null,
      });
      if (url.pathname === '/files') return Response.json({ files: [
        {filename:'Builder_earlier.md', prefix:'Builder', session:1, part:1,
          date:'2026-10-01', total_chunks:2, themes:'builder day', summary:'build history'},
        {filename:'Session_99.md', prefix:'Session', session:99, part:1,
          date:'2026-10-01', total_chunks:2, themes:'PRIVATE AGENT DAY', summary:'private'},
      ] });
      if (url.pathname === '/expand') return Response.json({results:[],vetoes:[]});
      throw new Error('Unexpected RAG route');
    };
  `);
  try {
    const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', preload,
      join(import.meta.dir, 'inlet-worker.ts'), temporal ? 'What happened yesterday?' : 'build decision'], {
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin', HOME: root,
        RAG_URL: 'https://rag.test', RAG_AUTH_TOKEN: 'offline-token',
        INLET_TEMPORAL: temporal ? '1' : '0', INLET_NOW: '2026-10-02T14:00:00Z',
        EMBERVY_TIMEZONE: 'UTC', EMBERVY_STRINGS_LOCAL: join(root, 'missing.json'),
        ...(prefix === undefined ? {} : { INLET_FILENAME_PREFIX: prefix }),
        ...env,
      }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0);
    return { stdout, stderr, calls: JSON.parse(readFileSync(capture, 'utf8')) as any[] };
  } finally { rmSync(root, { recursive:true, force:true }); }
}

for (const prefix of [undefined, '']) {
  test(`agent inlet with prefix ${JSON.stringify(prefix)} keeps the original search and expansion`, async () => {
    const result = await run(prefix);
    expect(result.calls.filter(call => call.path === '/search').map(call => call.body)).toEqual([
      {query:'build decision',topK:5,mode:'hybrid'},
    ]);
    expect(result.calls.some(call => call.path === '/expand')).toBe(true);
    expect(result.stdout).toContain('[Session_99.md]');
    expect(result.stdout).toContain('ordinary agent evidence');
  });
}
test('configured filename prefix is sent to search; out-of-scope older-worker hits cannot enter', async () => {
  const result = await run('Builder_');
  expect(result.calls.filter(call => call.path === '/search').map(call => call.body)).toEqual([
    {query:'build decision',topK:5,mode:'hybrid',filenamePrefix:'Builder_'},
  ]);
  expect(result.stdout).toContain('[Builder_earlier.md]');
  expect(result.stdout).toContain('builder evidence');
  expect(result.stdout).not.toContain('PRIVATE');
  expect(result.calls.some(call => call.path === '/expand')).toBe(false);
});
test('prefix is optional and is not hard-coded to Builder in the product worker', async () => {
  const result = await run('Session_');
  expect(result.calls.find(call => call.path === '/search').body.filenamePrefix).toBe('Session_');
  expect(result.stdout).not.toContain('[Builder_');
});
test('scoped temporal discovery and temporal search cannot reintroduce resident sessions', async () => {
  const result = await run('Builder_', true);
  const files = result.calls.filter(call => call.path === '/files');
  const searches = result.calls.filter(call => call.path === '/search');
  expect(files.length).toBeGreaterThan(0);
  expect(searches.some(call => !!call.body.dateFrom)).toBe(true);
  for (const call of files) expect(call.query.filenamePrefix).toBe('Builder_');
  for (const call of searches) expect(call.body.filenamePrefix).toBe('Builder_');
  expect(result.stdout).toContain('builder day');
  expect(result.stdout).not.toContain('PRIVATE AGENT');
  expect(result.stdout).not.toContain('Session_99');
});
test('agent temporal requests omit filenamePrefix when no prefix is configured', async () => {
  const result = await run(undefined, true);
  expect(result.calls.some(call => call.path === '/files')).toBe(true);
  for (const call of result.calls.filter(call => call.path === '/files' || call.path === '/search')) {
    expect(call.query.filenamePrefix).toBeUndefined();
    expect(call.body?.filenamePrefix).toBeUndefined();
  }
});

const canonLookup = {
  card: { description: 'entity context' }, relations: [],
  recent: [{ id: 7, ts: '2026-02-01 10:00:00', kind: 'observation', content: 'newer fact about the speaker' }, { id: 3, ts: '2026-01-01 10:00:00', kind: 'observation', content: 'ordinary observation' }],
  canon: [{ id: 5, ts: '2026-01-15 09:00:00', content: 'older fact about the speaker' }, { id: 7, ts: '2026-02-01 10:00:00', content: 'newer fact about the speaker' }],
};

test('canon facts of the named stand first, newest first, and are not repeated as observations', async () => {
  const { stdout } = await contextRun({ lookup: canonLookup });
  const block = stdout.indexOf('## Canon — on conflict, this block wins over every excerpt below');
  expect(block).toBeGreaterThanOrEqual(0);
  expect(block).toBeLessThan(stdout.indexOf('## Person: speaker'));
  expect(block).toBeLessThan(stdout.indexOf('## Chronicle (RAG)'));
  const canonText = stdout.slice(block, stdout.indexOf('## Person: speaker'));
  expect(canonText.indexOf('newer fact')).toBeLessThan(canonText.indexOf('older fact'));
  // The same fact for two looked-up names appears once.
  expect(canonText.match(/\[#7\]/g)).toHaveLength(1);
  const person = stdout.slice(stdout.indexOf('## Person: speaker'), stdout.indexOf('## Place: venue'));
  expect(person).toContain('ordinary observation');
  expect(person).not.toContain('newer fact about the speaker');
});

test('the final recap names the newest canon fact per person and can be turned off', async () => {
  const { stdout } = await contextRun({ lookup: canonLookup });
  const recap = stdout.lastIndexOf('## Sure about the people named (check before writing)\n');
  expect(recap).toBeGreaterThan(stdout.indexOf('## Chronicle (RAG)'));
  expect(stdout.lastIndexOf('\n## ')).toBe(recap - 1);
  expect(stdout.slice(recap)).toContain('\n- speaker: newer fact about the speaker\n');
  const off = await contextRun({ lookup: canonLookup, env: { INLET_FINAL_RECAP: '0' } });
  expect(off.stdout).not.toContain('## Sure about the people named');
});

test('without canon or a card description the recap leaves the person out, never quoting an observation', async () => {
  const { stdout } = await contextRun({ lookup: { card: null, relations: [], recent: [{ id: 1, ts: '2026-01-01 10:00:00', kind: 'observation', content: 'a passing note of the day' }] } });
  expect(stdout).toContain('a passing note of the day');
  expect(stdout).not.toContain('## Sure about the people named');
});

test('without canon there is no canon block and the recap falls back to the card', async () => {
  const { stdout } = await contextRun();
  expect(stdout).not.toContain('## Canon');
  expect(stdout).toContain('- speaker: entity context');
});
