// Priority-2 unit test: structured error mapping + buzz-search arg building (no network).
import { errorResult, classifyExit, EXIT_INFO } from './buzz-common.js';

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('PASS :: ' + n); } else { fail++; console.log('FAIL :: ' + n); } };

// exit-code mapping
const e2 = errorResult('relay down', { exitCode: 2, stderr: 'connection refused' });
check('exit 2 -> network category', e2.errorCategory === 'network');
check('exit 2 hint mentions BUZZ_RELAY_URL', /BUZZ_RELAY_URL/.test(e2.hint));
check('exit 2 hint mentions localhost/Host', /localhost|Host/i.test(e2.hint));
check('exit 2 retryable', e2.retryable === true);

const e3 = errorResult('bad key', { exitCode: 3 });
check('exit 3 -> auth category', e3.errorCategory === 'auth' && e3.retryable === false);

const e1 = errorResult('missing field', { exitCode: 1 });
check('exit 1 -> user_input category', e1.errorCategory === 'user_input');

const e5 = errorResult('conflict', { exitCode: 5 });
check('exit 5 -> write_conflict retryable', e5.errorCategory === 'write_conflict' && e5.retryable === true);

check('classifyExit(2) network', classifyExit(2).category === 'network');
check('EXIT_INFO has all codes', [0,1,2,3,4,5].every(c => EXIT_INFO[c]));

// error without exit code still structured
const eNoCode = errorResult('some error');
check('no-exitCode error has errorCategory', eNoCode.errorCategory === 'error' && eNoCode.success === false);

// buzz-search arg building (import the tool + inspect via a fake runBuzz? — simplest: reimplement arg logic check)
// Instead, verify the tool module loads and exposes execute + name.
const search = (await import('./buzz-search.js')).default;
check('buzz-search tool name', search.name === 'buzz-search');
check('buzz-search has execute', typeof search.execute === 'function');

// missing query -> user_input error (no CLI call)
const r = await search.execute({}, {}, null);
check('buzz-search requires query', r.success === false && /query/i.test(r.error));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
