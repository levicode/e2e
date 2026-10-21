/** Synthetic adversarial labels shared by pure sanitization and native artifact ownership checks. */
export const HOSTILE_NAMES = [
  '../../etc/passwd',
  '..',
  '/etc/cron.d/job',
  '..\\..\\Windows\\win.ini',
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  'report.pdf:hidden-stream',
  'a\u0000b.txt',
  'CON',
  'nul.txt',
  'LPT1',
  `${'x'.repeat(300)}.zip`,
];
