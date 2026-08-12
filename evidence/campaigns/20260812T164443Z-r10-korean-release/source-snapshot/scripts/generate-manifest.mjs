import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../');

function getFileHash(filePath) {
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

function scanDir(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

        // Exclude transient/build/meta directories and campaign directory (self-referential)
        if (
            relativePath.startsWith('node_modules') ||
            relativePath.startsWith('test-results') ||
            relativePath.startsWith('playwright-report') ||
            relativePath.startsWith('.git') ||
            relativePath.startsWith('.agents') ||
            relativePath.startsWith('.campaign-operations') ||
            relativePath === 'evidence/manifest.json' ||
            relativePath.startsWith('evidence/campaigns')
        ) {
            continue;
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            scanDir(fullPath, fileList);
        } else {
            fileList.push({
                path: relativePath,
                sizeBytes: stat.size,
                sha256: getFileHash(fullPath)
            });
        }
    }
    return fileList;
}

const manifestFiles = scanDir(rootDir).sort((a, b) => a.path.localeCompare(b.path));
const manifestPath = path.join(rootDir, 'evidence/manifest.json');

const manifestData = {
    generatedUtc: new Date().toISOString(),
    totalFilesCount: manifestFiles.length,
    files: manifestFiles
};

fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), 'utf-8');
console.log(`[MANIFEST GENERATOR] Successfully generated manifest.json with ${manifestFiles.length} tracked files.`);
