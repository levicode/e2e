import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { missingRecordingDependency } from '../../src/native/recording-dependency.ts';

let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'recording-dependency-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function ffmpegIn(dir: string): string {
  const file = path.join(dir, 'ffmpeg');
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return file;
}

it('leaves an absent PATH to the native recorder rather than guessing', () => {
  expect(missingRecordingDependency({}, directory)).toBeUndefined();
});

it('accepts ffmpeg from any PATH entry', () => {
  const first = mkdtempSync(path.join(tmpdir(), 'recording-dependency-missing-'));
  try {
    ffmpegIn(directory);
    expect(missingRecordingDependency({ PATH: [first, directory].join(path.delimiter) }, directory)).toBeUndefined();
  } finally { rmSync(first, { recursive: true, force: true }); }
});

it('resolves a relative PATH entry against the worker directory, not the process cwd', () => {
  mkdirSync(path.join(directory, 'bin'));
  ffmpegIn(path.join(directory, 'bin'));
  expect(missingRecordingDependency({ PATH: 'bin' }, directory)).toBeUndefined();
});

it('resolves an empty PATH entry against the worker directory', () => {
  ffmpegIn(directory);
  expect(missingRecordingDependency({ PATH: '' }, directory)).toBeUndefined();
});

it('names FFmpeg and the install commands when no executable is on PATH', () => {
  const message = missingRecordingDependency({ PATH: path.join(directory, 'empty') }, directory);
  expect(message).toContain('Video recording requires FFmpeg');
  expect(message).toContain('brew install ffmpeg');
  expect(message).toContain('sudo apt-get install ffmpeg');
});

it('does not count a file named ffmpeg that is not executable', () => {
  writeFileSync(path.join(directory, 'ffmpeg'), 'not an executable');
  expect(missingRecordingDependency({ PATH: directory }, directory)).toContain('Video recording requires FFmpeg');
});
