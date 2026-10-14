const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../typing-behavior.js'),'utf8');
function fixture(random=Math.random){const math=Object.create(Math);math.random=random;const context=vm.createContext({Math:math,setTimeout,clearTimeout});vm.runInContext(source,context);return context.HTTyping;}
(async()=>{
 const behavior=fixture(()=>0);
 assert.equal(behavior.typo({human:true},'中'),'a');assert.equal(behavior.typo({human:true},'a'),'b');
 assert.equal(behavior.typo({human:false},'中'),null);assert.equal(behavior.typo({human:true},'\n'),null);
 console.log('PASS Chinese and ASCII use random English letters, excluding spaces and disabled mode');
 const run={human:true};assert.equal(behavior.typo(run,'中'),'a');assert.equal(behavior.typo(run,'文'),null);
 console.log('PASS random typo cooldown prevents consecutive corrections');
 let seed=17;const samples=fixture(()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296});
 const delays=Array.from({length:200},()=>samples.delay({human:true,speed:100},'中'));
 assert.ok(new Set(delays).size>20);assert.ok(delays.some(ms=>ms>280));assert.equal(samples.delay({human:false,speed:100},'中'),80);
 console.log('PASS timing varies independently of character number, and plain mode keeps fixed pacing');
 let done=false;const paused={paused:true,stopped:false};const waiting=behavior.ready(paused).then(()=>done=true);
 await new Promise(r=>setTimeout(r,15));assert.equal(done,false);paused.paused=false;paused.wake();await waiting;assert.equal(done,true);
 console.log('PASS pause gate resumes only when unpaused');
 const stopped={paused:true,stopped:false};const stopping=behavior.ready(stopped);stopped.stopped=true;stopped.wake();assert.equal(await stopping,false);
 console.log('PASS Stop wakes a paused task without waiting for its next delay');
 console.log('5 / 5 passed');
})().catch(e=>{console.error(e);process.exitCode=1});
