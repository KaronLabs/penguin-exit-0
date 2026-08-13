#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { auditAcceptedRun, validateAuditReceipt } from './public-smoke-v2-lib.mjs';

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
}

function parseArgs(argv) {
    if (argv.length !== 2 || argv[0] !== '--config' || argv[1] === '--config') throw new Error('usage: verify-public-smoke-v2.mjs --config <path>');
    return path.resolve(argv[1]);
}

try {
    const configPath = parseArgs(process.argv.slice(2));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.schemaVersion === 3) process.stderr.write(`AUDIT_TARGET_REALPATH=${fs.realpathSync(config.auditTargetRealpath)}\n`);
    const receipt = auditAcceptedRun({ configPath });
    const receiptPath = fs.realpathSync(path.dirname(path.resolve(config.auditReceiptPath))) + path.sep + path.basename(config.auditReceiptPath);
    const releaseRoot = path.resolve(config.schemaVersion === 3 ? config.mutationRootRealpath : config.releaseRoot);
    if (receiptPath === releaseRoot || !receiptPath.startsWith(`${releaseRoot}${path.sep}`)) throw new Error('auditReceiptPath escapes releaseRoot');
    if (fs.existsSync(receiptPath)) throw new Error('auditReceiptPath already exists');
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', flag: 'wx' });
    const reparsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    validateAuditReceipt(reparsed);
    process.stdout.write(`PUBLIC_SMOKE_V2_GATE=6/6 manifest_sha256=${receipt.acceptedManifestSha256} release=${receipt.releaseId}\n`);
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
}
