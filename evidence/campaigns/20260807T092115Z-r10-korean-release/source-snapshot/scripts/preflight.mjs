import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

const rawDir = path.resolve('evidence/raw');
if (!fs.existsSync(rawDir)) {
    fs.mkdirSync(rawDir, { recursive: true });
}

const targetZip = 'C:\\07_LastMoveProject\\penguin_exit_game_submission\\exit-0-web-build.zip';
const fileBuffer = fs.readFileSync(targetZip);
const hashSum = crypto.createHash('sha256');
hashSum.update(fileBuffer);
const actualHash = hashSum.digest('hex').toUpperCase();

const expectedHash = '96D6F8407DF3B4E5D3DDB4CBEB42F6430F221C909B56353118D3B14D3777884B';
const isMatch = actualHash === expectedHash;

const logContent = [
    `started_utc=${new Date().toISOString()}`,
    `expected=${expectedHash}`,
    `actual=${actualHash}`,
    `match=${isMatch}`
].join('\n');

fs.writeFileSync(path.join(rawDir, 'baseline-preflight.log'), logContent, 'utf-8');
console.log(`Preflight status: match=${isMatch}`);
if (!isMatch) {
    process.exit(1);
}
