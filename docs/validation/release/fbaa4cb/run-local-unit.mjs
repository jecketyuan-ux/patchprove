import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { validationIdentity } from '/workspace/patchprove/scripts/validation-identity.mjs';
import { runCommand } from '/workspace/patchprove/dist/exec.js';
const root='/workspace/patchprove';
const identity=validationIdentity(import.meta.url);
const report={schemaVersion:1,generatedAt:new Date().toISOString(),identity,cases:[]};
for(const [id,binary] of [['node24',process.execPath],['node22','/tmp/patchprove-node22-validation/node-v22.23.4-linux-x64/bin/node']]){
 const version=await runCommand(binary,['--version'],{cwd:root});assert.equal(version.exitCode,0);
 const args=[root+'/node_modules/vitest/vitest.mjs','run','--reporter=json','--outputFile=/tmp/patchprove-candidate-'+id+'-vitest.json'];
 const before=validationIdentity(import.meta.url);
 const result=await runCommand(binary,args,{cwd:root,timeoutMs:120000,maxOutputBytes:4*1024*1024});
 await writeFile('/tmp/patchprove-candidate-'+id+'-vitest.log',result.stdout+'\n'+result.stderr);
 assert.equal(result.exitCode,0,result.stdout+'\n'+result.stderr);
 const raw=JSON.parse(await readFile('/tmp/patchprove-candidate-'+id+'-vitest.json','utf8'));
 assert(raw.success && raw.numFailedTests===0);
 assert.equal(before.runtimeDigest,validationIdentity(import.meta.url).runtimeDigest);
 report.cases.push({id,status:'passed',node:version.stdout.trim(),command:binary,args,exitCode:result.exitCode,durationMs:result.durationMs,outputHash:result.outputHash,summary:{files:raw.testResults.length,total:raw.numTotalTests,passed:raw.numPassedTests,failed:raw.numFailedTests,skipped:raw.numPendingTests},skips:raw.testResults.flatMap(file=>file.assertionResults.filter(test=>['pending','skipped'].includes(test.status)).map(test=>({file:file.name,name:test.fullName})))});
}
await writeFile('/tmp/patchprove-candidate-unit.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.cases.map(c=>({id:c.id,...c.summary})),null,2));
