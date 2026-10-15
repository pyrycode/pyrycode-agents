import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve protected settings from this installed agents checkout.
const root = fileURLToPath(new URL('../', import.meta.url));
const policy = JSON.parse(readFileSync(new URL('../gate-tiers.json', import.meta.url), 'utf8'));
if (policy.version !== 1 || !Array.isArray(policy.check) || !policy.check.length) {
  throw new Error('The protected gate tiers are invalid');
}
const defaults = [root + 'bin/cite-guard', root + 'bin/docs-guard', ...policy.check, 'make build'];
const configured = process.env.PYRY_VERIFIER_GATES;
const gates = configured === undefined ? defaults : configured.split(';').map(s => s.trim()).filter(Boolean)
  .flatMap(command => command === 'make check' ? policy.check : [command]);
let formats;
try { formats = JSON.parse(process.env.PYRY_VERIFIER_GATE_FORMATS || '{}'); }
catch { throw new Error('The gate output format settings are invalid'); }
if (!formats || Array.isArray(formats) || typeof formats !== 'object') throw new Error('The gate output format settings are invalid');
delete formats['make check'];
for (const command of gates) if (policy.formats[command]) formats[command] = policy.formats[command];
process.env.PYRY_VERIFIER_GATES = gates.join(';');
process.env.PYRY_VERIFIER_GATE_FORMATS = JSON.stringify(formats);
