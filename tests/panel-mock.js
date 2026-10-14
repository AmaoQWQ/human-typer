// Local preview only. The real panel receives simulated, per-character progress.
const panelListeners=[];
const mockTarget={tabId:7,kind:'google-docs',label:'Google Docs 正文'};
let mockRun=null;
function previewProgress(running=true){
 const run=mockRun;if(!run)return;
 panelListeners.forEach(fn=>fn({type:'HT_PROGRESS',tabId:7,runId:run.id,sequence:++run.sequence,
  running,paused:running&&run.paused,completed:run.completed,total:run.total,stopped:run.stopped}));
}
function previewTick(){
 const run=mockRun;if(!run||run.paused||run.stopped)return;
 run.completed++;previewProgress(run.completed<run.total);
 if(run.completed<run.total)run.timer=setTimeout(previewTick,180);
}
window.chrome={
 runtime:{onMessage:{addListener:fn=>panelListeners.push(fn)},sendMessage:async message=>{
  if(message.type==='HT_HEALTH')return{ok:true,version:'1.5.0',debuggerAvailable:true};
  if(message.type==='HT_STATE')return{ok:true,tabId:7,target:mockTarget};
  if(message.type==='HT_START'){
   mockRun={id:crypto.randomUUID(),sequence:0,completed:0,total:Array.from(message.text).length,paused:false,stopped:false};
   previewProgress();mockRun.timer=setTimeout(previewTick,180);return{ok:true,runId:mockRun.id};
  }
  if(message.type==='HT_PAUSE'){
   mockRun.paused=message.paused;clearTimeout(mockRun.timer);previewProgress();
   if(!mockRun.paused)mockRun.timer=setTimeout(previewTick,180);return{ok:true,paused:mockRun.paused,runId:mockRun.id};
  }
  if(message.type==='HT_STOP'){mockRun.stopped=true;clearTimeout(mockRun.timer);previewProgress(false);return{ok:true}}
  return{ok:true,tabId:7};
 }},
 storage:{local:{get:async()=>({draft:'这是输入测试。\n第一行测试中文输入。\n第二行测试换行。',humanMode:true,speed:42}),set:async()=>{}}},
 tabs:{onActivated:{addListener:()=>{}}}
};
