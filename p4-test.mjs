// Priority-4 unit test: SideChannel helper shape + arg building (no network).
import { SideChannel } from './listener/sidechannel.js';

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('PASS :: ' + n); } else { fail++; console.log('FAIL :: ' + n); } };

const sc = new SideChannel({ buzzBin: 'echo-not-real', privateKey: 'x', relayUrl: 'https://r' });

check('has open', typeof sc.open === 'function');
check('has post', typeof sc.post === 'function');
check('has postDiff', typeof sc.postDiff === 'function');
check('has summarizeBack', typeof sc.summarizeBack === 'function');
check('has close', typeof sc.close === 'function');

// validation guards (no CLI call)
const p1 = await sc.post('', '');
check('post requires channel+content', p1.success === false && p1.errorCategory === 'user_input');

const s1 = await sc.summarizeBack({});
check('summarizeBack requires channel+summary', s1.success === false && s1.errorCategory === 'user_input');

const d1 = await sc.postDiff('chan', { diff: 'x' });
check('postDiff requires repo+commit', d1.success === false && d1.errorCategory === 'user_input');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
