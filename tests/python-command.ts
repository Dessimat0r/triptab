import { execFileSync } from 'node:child_process';

type PythonCommand = { file: string; args: string[] };

/** Find a working Python 3 interpreter, ignoring Windows Store app aliases. */
export function pythonCommand(): PythonCommand {
  const candidates: PythonCommand[] = process.env.PYTHON
    ? [{ file: process.env.PYTHON, args: [] }]
    : process.platform === 'win32'
      ? [{ file: 'py', args: ['-3'] }, { file: 'python', args: [] }, { file: 'python3', args: [] }]
      : [{ file: 'python3', args: [] }, { file: 'python', args: [] }];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate.file, [...candidate.args, '-c', 'import sys; assert sys.version_info.major == 3'], {
        stdio: 'ignore', timeout: 5_000,
      });
      return candidate;
    } catch {
      // A missing command or a non-Python app alias is not an interpreter.
    }
  }
  throw new Error('Python 3 is required for backup tests. Install it or set PYTHON to its executable path.');
}
