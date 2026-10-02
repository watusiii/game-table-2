// Catches what a bad merge leaves behind: conflict markers, broken JSON, type errors.
// Run it with `npm run check`. It exits 1 if anything is wrong.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const problems = [];
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);

for (const file of files) {
  if (!/\.(m?[jt]s|json|md|css|html|bat)$/.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted, or a folder like cli
  }
  const marker = /^(<<<<<<< |>>>>>>> )/m.exec(text);
  if (marker) problems.push(file + ': unresolved merge conflict marker (' + marker[1].trim() + ')');
  if (/\.json$/.test(file)) {
    try {
      JSON.parse(text);
    } catch (error) {
      problems.push(file + ': not valid JSON (' + error.message + ')');
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('No conflict markers, JSON is valid. Checking types...');
process.exit(spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], { stdio: 'inherit' }).status ?? 1);
