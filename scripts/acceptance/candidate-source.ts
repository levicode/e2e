/** Final native delivery cannot retain unreachable production backends or stage tests elsewhere. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../public-packages.ts';

export const LEGACY_PRODUCTION_FILES = [
  'app-log.ts', 'read-node.ts', 'observe.ts', 'capture-scope.ts', 'cdp-recovery.ts',
  'provider-video.ts', 'browser-connection.ts', 'surface.ts', 'observation.ts', 'downloads.ts',
  'actions.ts', 'cdp-selectors.ts', 'selector-engines.ts', 'install.ts', 'video.ts', 'trace-feed.ts',
  'attempt-session.ts', 'shown-selector.ts', 'closed-shadow.ts', 'label-selector.ts', 'read-selector.ts',
  'locators.ts', 'dialogs.ts', 'refs.ts', 'support.ts', 'observation-capture.ts',
] as const;
/** Keep the assertion-bearing suites in normal discovery while their implementations migrate. */
export const REQUIRED_MIGRATED_TEST_FILES = [
  'integration/read-node-names.test.ts', 'integration/observation.test.ts',
  'unit/closed-shadow.test.ts', 'unit/actions.test.ts', 'unit/observation-capture.test.ts',
  'unit/cdp-selectors.test.ts', 'unit/surface-lifecycle.test.ts', 'unit/locators.test.ts',
  'unit/provider-video.test.ts', 'unit/semantic-fallback.test.ts', 'unit/attempt-session.test.ts',
  'unit/refs-disposal.test.ts', 'unit/video.test.ts', 'unit/observe.test.ts',
] as const;

/**
 * Mask comments and the text inside literals so statement scanning sees only
 * code. Quoted and fixed template values become numbered placeholders, so a
 * real import specifier stays available while a path quoted for history
 * cannot read as a dependency.
 */
function maskSource(input: string): { code: string; strings: string[] } {
  const source = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const strings: string[] = [];
  const code: string[] = [];
  const frames: { mode: 'code' | 'template'; braces: number }[] = [{ mode: 'code', braces: -1 }];
  let index = 0;
  while (index < source.length) {
    const frame = frames[frames.length - 1]!;
    const character = source[index]!;
    if (frame.mode === 'template') {
      if (character === '\\') { code.push(' '); index += 2; continue; }
      if (character === '`') { frames.pop(); code.push(' '); index++; continue; }
      if (character === '$' && source[index + 1] === '{') { frames.push({ mode: 'code', braces: 0 }); code.push(' '); index += 2; continue; }
      code.push(' '); index++; continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index++;
      code.push(' '); continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      // Keep the comment's line terminators: ASI can depend on a newline inside one.
      code.push(` ${source.slice(index, stop).replace(/[^\n]/g, '')}`);
      index = stop; continue;
    }
    if (character === "'" || character === '"') {
      let end = index + 1; let value = '';
      while (end < source.length && source[end] !== character && source[end] !== '\n') {
        if (source[end] === '\\') { value += source[end + 1] ?? ''; end += 2; continue; }
        value += source[end]!; end++;
      }
      if (source[end] === character) {
        strings.push(value); code.push(`__STRING_${strings.length - 1}__`); index = end + 1; continue;
      }
    }
    if (character === '`') {
      let end = index + 1; let value = ''; let interpolated = false;
      while (end < source.length) {
        const next = source[end]!;
        if (next === '\\') { value += source[end + 1] ?? ''; end += 2; continue; }
        if (next === '`') { end++; break; }
        if (next === '$' && source[end + 1] === '{') { interpolated = true; break; }
        value += next; end++;
      }
      if (!interpolated && source[end - 1] === '`') {
        strings.push(value); code.push(`__STRING_${strings.length - 1}__`); index = end; continue;
      }
      frames.push({ mode: 'template', braces: -1 }); code.push(' '); index++; continue;
    }
    if (frame.braces >= 0) {
      if (character === '{') frame.braces++;
      else if (character === '}') {
        if (frame.braces === 0) { frames.pop(); code.push(' '); index++; continue; }
        frame.braces--;
      }
    }
    if (character === '/' && regexStartsAfter(code)) {
      let end = index + 1; let inClass = false; let closed = false;
      while (end < source.length) {
        const next = source[end];
        if (next === '\\') { end += 2; continue; }
        if (next === '\n') break;
        if (next === '[') inClass = true;
        else if (next === ']') inClass = false;
        else if (next === '/' && !inClass) { end++; closed = true; break; }
        end++;
      }
      if (closed) { code.push(' '); index = end; continue; }
    }
    code.push(character); index++;
  }
  return { code: code.join(''), strings };
}

/** A slash after one of these tokens starts a regular expression instead of dividing. */
function regexStartsAfter(code: string[]): boolean {
  const text = code.join('').trimEnd();
  if (!text) return true;
  if ((/(?:^|[^\w$])(?:return|case|typeof|instanceof|in|of|new|delete|void|do|else|yield|await|throw)$/).test(text)) return true;
  return '([,=:[!&|?{};+-*%<>~^'.includes(text[text.length - 1]!);
}

/**
 * The specifiers of every real static, dynamic or CommonJS import in a test
 * file. Comments and ordinary strings are masked out first, so a path quoted
 * for history never counts as a dependency.
 */
function importedSpecifiers(source: string): string[] {
  const { code, strings } = maskSource(source);
  const specifiers = new Set<string>();
  const patterns = [
    /(?:^|[;{}])[ \t]*import\b[^;]*?\bfrom\s*__STRING_(\d+)__/gm,
    /(?:^|[;{}])[ \t]*import\s*__STRING_(\d+)__/gm,
    /(?:^|[;{}])[ \t]*export\b[^;]*?\bfrom\s*__STRING_(\d+)__/gm,
    /\bimport\s*\(\s*__STRING_(\d+)__/g,
    /\brequire\s*\(\s*__STRING_(\d+)__/g,
    /\bvi\.(?:mock|doMock|unmock|importActual|importMock)\s*\(\s*__STRING_(\d+)__/g,
    /\brequire\.resolve\s*\(\s*__STRING_(\d+)__/g,
    /\bimport\.meta\.resolve\s*\(\s*__STRING_(\d+)__/g,
  ];
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) specifiers.add(strings[Number(match[1])]!);
  return [...specifiers];
}

/** Whether a module specifier still points at a source file final delivery removed. */
function importsRemovedBackend(specifier: string, backend: string): boolean {
  return specifier.includes(`/src/${backend}`) || specifier.includes(`/src/${backend.slice(0, -3)}.js`);
}

export function candidateSourceProblems(root: string): string[] {
  const web = join(root, 'packages/web'); const problems: string[] = [];
  for (const file of LEGACY_PRODUCTION_FILES) if (existsSync(join(web, 'src', file))) problems.push(`Legacy production backend remains: packages/web/src/${file}`);
  for (const file of REQUIRED_MIGRATED_TEST_FILES) if (!existsSync(join(web, 'tests', file))) problems.push(`Required migration assertions left normal discovery: packages/web/tests/${file}`);
  const tests = join(web, 'tests');
  if (existsSync(tests)) for (const file of readdirSync(tests, { recursive: true, encoding: 'utf8' })) {
    if (file.split(/[\\/]/).includes('legacy-oracle')) problems.push(`Legacy staging is not final delivery: packages/web/tests/${file}`);
    if (!file.endsWith('.ts')) continue;
    const specifiers = importedSpecifiers(readFileSync(join(tests, file), 'utf8'));
    for (const backend of LEGACY_PRODUCTION_FILES) {
      if (specifiers.some(specifier => importsRemovedBackend(specifier, backend))) problems.push(`Test still imports a removed backend: packages/web/tests/${file} -> ${backend}`);
    }
  }
  return problems;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2]; const problems = candidateSourceProblems(REPO_ROOT);
  if (output) {
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'source-removal.result.json'), JSON.stringify({ schemaVersion: 1, status: problems.length ? 'failed' : 'passed', problems, releaseEligible: false }, null, 2));
  }
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  if (problems.length) process.exitCode = 1;
}
