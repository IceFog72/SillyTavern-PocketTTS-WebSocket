const { chromium, firefox, webkit } = require('playwright');
const { createServer } = require('http');
const { readFileSync } = require('fs');
const root = require('path').join(__dirname, '../dist');
const server = createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type','text/html'); res.end('<button>Enable audio</button>'); return; }
  res.setHeader('Content-Type','text/javascript');
  if (req.url === '/tts/index.js') { res.end('export const saveTtsProviderSettings=()=>{}; export const getPreviewString=()=>"Preview"; export const registerTtsProvider=()=>{};'); return; }
  if (req.url === '/script.js') { res.end('export const event_types={}; export const eventSource={};'); return; }
  if (req.url === '/extensions.js') { res.end('export const extension_settings={tts:{}};'); return; }
  try {
   const path = req.url.replace('/extension/dist', '');
   let source = readFileSync(root + path, 'utf8');
   if (req.url === '/extension/dist/index.js') source += '\nexport {adp, processNewText, flushBuffer, playNextInQueue, pttsAudio};';
   res.end(source);
  }
  catch { res.statusCode = 404; res.end(); }
});
(async () => {
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 for (const [name, engine, options] of [
  ['chromium',chromium,process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {}],
  ['firefox',firefox,{}],['webkit',webkit,{}],
 ]) {
  let browser;
  try {
   browser=await engine.launch({headless:true,...options});
   const page=await browser.newPage();
   await page.goto(`http://127.0.0.1:${server.address().port}`);
   await page.evaluate(async()=>{
    window.pcm=await import('/pcm-playback.js');
    document.querySelector('button').onclick=()=>{
     window.context=new AudioContext();
     window.context.resume();
    };
   });
   await page.click('button');
   const result=await page.evaluate(async()=>{
    const {createPcmStream,appendPcm,pumpPcm,stopPcm}=window.pcm;
    const stream=createPcmStream(window.context,24000);
    stream.playing=true;
    const start=performance.now();
    // 24kHz input resamples to the device rate. MediaSource is unused.
    appendPcm(stream,new Uint8Array(3840));
    if(!stream.started) throw Error('Playback did not start');
    const firstSchedule=performance.now()-start;
    await new Promise(r=>setTimeout(r,160));
    appendPcm(stream,new Uint8Array(960));
    if(stream.buffer.underruns!==1 || !stream.rebuffering) throw Error('No adaptive recovery');
    stream.closed=true;
    await new Promise(resolve=>{stream.onEnded=resolve;pumpPcm(stream);});
    if(stream.nextTime<0.1) throw Error('Samples missing');
    const result={contextRate:window.context.sampleRate,firstScheduleMs:firstSchedule,underruns:stream.buffer.underruns,targetMs:stream.buffer.target*1000};
    stopPcm(stream);
    await window.context.close();
    return result;
   });
   console.log(name,JSON.stringify(result));
   await page.click('button');
   const playlist = await page.evaluate(async()=>{
    const queue = await import('/extension/dist/index.js');
    const {PocketTtsProvider} = await import('/extension/dist/pocket-tts.js');
    const provider = new PocketTtsProvider();
    provider.settings = {...provider.defaultSettings, streamingFormat:'live-webm'};
    const select=document.createElement('select');
    select.id='ptts_streaming_format';
    document.body.append(select);
    for(const saved of ['pcm','webm','mp3','live-webm','auto','off']) {
     provider.settings.streamingFormat=saved;
     await provider._refreshStreamingFormatOptions(false);
     if(select.options.length!==2 || provider.settings.streamingFormat!==(saved==='off'?'off':'auto')) throw Error('Streaming mode migration failed: '+saved);
    }
    select.remove();
    provider.settings.streamingFormat='live-webm';
    provider.ready = true;
    provider._pcmContext = window.context;
    window._pttsProvider = provider;
    provider.resetSession = () => {};
    const requests = [];
    provider._worker = {postMessage(message) { if(message.type==='send') requests.push(message.payload); }};
    const played = [];
    const start = provider._startPcmStream.bind(provider);
    provider._startPcmStream = stream => { played.push(stream); start(stream); };
    queue.adp.active = true;
    // Exercise the saved legacy mode through the actual text capture and provider.
    queue.processNewText('First complete sentence. Second complete sentence. Third complete sentence.', 7);
    queue.flushBuffer();
    if(requests.length!==3 || provider._wsPending.length!==3) throw Error(`Only ${provider._wsPending.length} sentences have playback destinations`);
    for(const request of requests) {
     provider._onWorkerMessage({data:{type:'json',msg:{status:'audio_start',request_id:[request.request_id],format:'pcm',sample_rate:24000}}});
     provider._onWorkerMessage({data:{type:'audio',data:new Uint8Array(4800).buffer}});
     provider._onWorkerMessage({data:{type:'json',msg:{status:'done',request_id:[request.request_id],audio_duration:0.1}}});
    }
    const deadline=performance.now()+4000;
    while(queue.adp.tracks.length && performance.now()<deadline) await new Promise(r=>setTimeout(r,20));
    if(played.length!==3 || queue.adp.tracks.length || queue.adp.isPlaying) throw Error(`Playlist stalled: played=${played.length}, remaining=${queue.adp.tracks.length}`);
    if(played.some(stream=>!stream.started || !stream.stopped)) throw Error('A sentence was skipped or not drained');
    await window.context.close();
    return {requests:requests.length,played:played.length,remaining:queue.adp.tracks.length};
   });
   console.log(name,'multi-sentence',JSON.stringify(playlist));
   await page.click('button');
   const controls=await page.evaluate(async()=>{
    const queue=await import('/extension/dist/index.js');
    const {PocketTtsProvider}=await import('/extension/dist/pocket-tts.js');
    const {initTtsBar}=await import('/extension/dist/tts-bar.js');
    const pcm=await import('/pcm-playback.js');
    const provider=new PocketTtsProvider();
    window._pttsProvider=provider;
    window._pttsAudio=queue.pttsAudio;
    const settings={tts:{enabled:true,currentProvider:'PocketTTS WebSocket'}};
    const cleanup=initTtsBar(settings);
    const wav=new ArrayBuffer(44+96000), header=new DataView(wav);
    const ascii=(offset,text)=>[...text].forEach((char,i)=>header.setUint8(offset+i,char.charCodeAt(0)));
    ascii(0,'RIFF');header.setUint32(4,wav.byteLength-8,true);ascii(8,'WAVE');ascii(12,'fmt ');
    header.setUint32(16,16,true);header.setUint16(20,1,true);header.setUint16(22,1,true);
    header.setUint32(24,24000,true);header.setUint32(28,48000,true);header.setUint16(32,2,true);header.setUint16(34,16,true);
    ascii(36,'data');header.setUint32(40,96000,true);
    const streams=[1,2,3].map(()=>{
     const stream=pcm.createPcmStream(window.context);
     pcm.appendPcm(stream,new Uint8Array(24000*2*2));
     stream.closed=true;
     return stream;
    });
    queue.adp.tracks=streams.map((stream,i)=>({trackId:100+i,msgId:99,text:'Sentence '+i,pending:false,audioStream:stream}));
    queue.adp.playingIdx=-1;
    queue.playNextInQueue();
    await new Promise(r=>setTimeout(r,120));
    document.getElementById('ptts-play').click();
    if(streams[0].playing) throw Error('Pause does not pause PCM');
    const player=window._pttsGetPlayback();
    const pausedAt=player.currentTime;
    await new Promise(r=>setTimeout(r,180));
    if(Math.abs(player.currentTime-pausedAt)>0.01 || !queue.adp.isPlaying) throw Error('Paused clock advanced or playlist skipped');
    document.getElementById('ptts-play').click();
    if(!streams[0].playing) throw Error('Resume does not resume PCM');
    const volume=document.getElementById('ptts-volume');
    volume.value='25';volume.dispatchEvent(new Event('input'));
    if(streams[0].output.gain.value!==0.25) throw Error('Volume did not reach PCM output');
    document.getElementById('ptts-vol-btn').click();
    if(streams[0].output.gain.value!==0) throw Error('Mute failed');
    document.getElementById('ptts-vol-btn').click();
    if(streams[0].output.gain.value!==0.25) throw Error('Unmute failed');
    document.getElementById('ptts-speed').click();
    if(streams[0].playbackRate!==1.1 || [...streams[0].sources].some(source=>Math.abs(source.playbackRate.value-1.1)>0.000001)) throw Error('Speed did not reach scheduled PCM');
    const seek=document.getElementById('ptts-seeker');
    seek.value='1.2';seek.dispatchEvent(new Event('input'));seek.dispatchEvent(new Event('change'));
    if(Math.abs(player.currentTime-1.2)>0.05) throw Error('Seek failed');
    await new Promise(r=>setTimeout(r,220));
    if(!document.getElementById('ptts-play').querySelector('i').classList.contains('fa-pause') || Number(seek.max)!==2) throw Error('Playback display is stale');
    document.getElementById('ptts-skip').click();
    if(!streams[0].stopped || !streams[1].playing || Math.abs(streams[1].playbackRate-1.1)>0.000001 || streams[1].output.gain.value!==0.25) throw Error('Skip or next-track settings failed: '+JSON.stringify(streams.map(stream=>({stopped:stream.stopped,playing:stream.playing,rate:stream.playbackRate,volume:stream.output.gain.value}))));
    const stAudio=new Audio(URL.createObjectURL(new Blob([wav],{type:'audio/wav'})));
    stAudio.id='tts_audio';document.body.append(stAudio);
    // Switch providers while a Pocket sentence is still active. Late Pocket
    // media events must not take control back from the selected provider.
    settings.tts.currentProvider='Other TTS';
    await stAudio.play();
    queue.pttsAudio.dispatchEvent(new Event('play'));
    document.getElementById('ptts-play').click();
    if(!stAudio.paused || !streams[1].playing) throw Error('Provider selection did not route pause to tts_audio');
    volume.value='65';volume.dispatchEvent(new Event('input'));
    await new Promise(r=>setTimeout(r,60));
    if(streams[1].output.gain.value!==0.25 || localStorage.getItem('ptts-bar-volume')!=='0.65') throw Error('Other provider volume changed Pocket audio');
    document.getElementById('ptts-speed').click();
    if(Math.abs(stAudio.playbackRate-1.2)>0.000001 || Math.abs(streams[1].playbackRate-1.1)>0.000001 || settings.tts.playback_rate!==1.2) throw Error('Other provider speed routing failed');
    seek.value='0.5';seek.dispatchEvent(new Event('input'));seek.dispatchEvent(new Event('change'));
    await new Promise(r=>setTimeout(r,60));
    if(Math.abs(stAudio.currentTime-0.5)>0.05) throw Error('Other provider seek failed');
    document.getElementById('ptts-play').click();
    await new Promise(r=>setTimeout(r,60));
    if(stAudio.paused) throw Error('Other provider resume failed');
    if(Math.abs(stAudio.volume-0.65)>0.0001) throw Error('Other provider volume failed after resume: '+stAudio.volume);
    const ended=new Promise((resolve,reject)=>{
     const timeout=setTimeout(()=>reject(Error('Other provider skip did not end media')),2000);
     stAudio.addEventListener('ended',()=>{clearTimeout(timeout);resolve();},{once:true});
    });
    document.getElementById('ptts-skip').click();
    await ended;
    if(streams[1].stopped) throw Error('Other provider skip touched Pocket queue');
    let nativeStops=0;
    const nativeStop=document.createElement('button');nativeStop.id='ttsExtensionMenuItem';
    nativeStop.innerHTML='<i id="tts_media_control" class="fa-stop-circle"></i>';
    nativeStop.onclick=()=>{nativeStops++;};document.body.append(nativeStop);
    document.getElementById('ptts-stop').click();
    if(nativeStops!==1) throw Error('Stop did not invoke SillyTavern queue reset');
    nativeStop.remove();
    if(!stAudio.paused || stAudio.getAttribute('src') || streams[1].stopped) throw Error('Other provider stop routing failed');
    stAudio.remove();
    settings.tts.currentProvider='PocketTTS WebSocket';
    document.getElementById('ptts-stop').click();
    if(streams.some(stream=>!stream.stopped) || queue.adp.tracks.length || queue.adp.isPlaying) throw Error('Stop did not clear message');
    // Exercise the same controls on an actual buffered WAV media element.
    queue.adp.tracks=[{trackId:200,msgId:100,text:'Buffered sentence',pending:false,url:URL.createObjectURL(new Blob([wav],{type:'audio/wav'}))}];
    queue.playNextInQueue();
    const deadline=performance.now()+4000;
    while((queue.pttsAudio.paused || !Number.isFinite(queue.pttsAudio.duration)) && performance.now()<deadline) await new Promise(r=>setTimeout(r,20));
    if(queue.pttsAudio.paused || !queue.adp.isPlaying) throw Error('Buffered playback did not start');
    document.getElementById('ptts-play').click();
    if(!queue.pttsAudio.paused) throw Error('Buffered pause failed');
    document.getElementById('ptts-play').click();
    await new Promise(r=>setTimeout(r,100));
    if(queue.pttsAudio.paused) throw Error('Buffered resume failed');
    volume.value='45';volume.dispatchEvent(new Event('input'));
    document.getElementById('ptts-speed').click();
    document.getElementById('ptts-play').click();
    seek.value='0.5';seek.dispatchEvent(new Event('input'));seek.dispatchEvent(new Event('change'));
    await new Promise(r=>setTimeout(r,60));
    if(Math.abs(queue.pttsAudio.volume-0.45)>0.0001 || Math.abs(queue.pttsAudio.playbackRate-1.3)>0.000001 || Math.abs(queue.pttsAudio.currentTime-0.5)>0.05) throw Error('Buffered volume/speed/seek failed: '+JSON.stringify({volume:queue.pttsAudio.volume,rate:queue.pttsAudio.playbackRate,time:queue.pttsAudio.currentTime}));
    document.getElementById('ptts-stop').click();
    if(queue.adp.tracks.length || !queue.pttsAudio.paused) throw Error('Buffered stop failed');
    queue.adp.tracks=[{trackId:201,msgId:101,text:'Waiting for synthesis',pending:true}];
    document.getElementById('ptts-stop').click();
    if(queue.adp.tracks.length) throw Error('Stop did not clear pending message');
    document.getElementById('ptts-playlist').click();
    if(document.getElementById('ptts-playlist-panel').style.display!=='block') throw Error('Playlist toggle failed');
    const enabled=document.createElement('input');enabled.type='checkbox';enabled.id='tts_enabled';enabled.checked=true;document.body.append(enabled);
    queue.adp.tracks=[{trackId:202,msgId:102,text:'Pending when disabled',pending:true}];
    document.getElementById('ptts-toggle').click();
    if(enabled.checked || queue.adp.tracks.length) throw Error('Disable did not stop queue');
    enabled.remove();

    cleanup();
    localStorage.clear();
    queue.pttsAudio.volume=1;queue.pttsAudio.playbackRate=1;
    await window.context.close();
    return {pause:true,resume:true,volume:true,mute:true,speed:true,seek:true,skip:true,stop:true,buffered:true,pendingStop:true,playlist:true,toggle:true,providerSwitch:true};
   });
   console.log(name,'controls',JSON.stringify(controls));

   if(process.env.TTS_TEST_ENDPOINT) {
    await page.click('button');
    const live = await page.evaluate(async endpoint=>{
     const queue = await import('/extension/dist/index.js');
     const {PocketTtsProvider} = await import('/extension/dist/pocket-tts.js');
     const provider = new PocketTtsProvider();
     provider.settings = {...provider.defaultSettings,provider_endpoint:endpoint,voice:'alba',streamingFormat:'live-webm'};
     provider.ready=true;
     provider._pcmContext=window.context;
     window._pttsProvider=provider;
     let played=0;
     const start=provider._startPcmStream.bind(provider);
     provider._startPcmStream=stream=>{played++;start(stream);};
     provider._initWorker();
     queue.adp.active=true;
     queue.adp.lastMsgId=null;
     queue.processNewText('The first sentence is here. The second sentence is here. The third sentence is here.',8);
     queue.flushBuffer();
     provider.sendTextDone();
     const deadline=performance.now()+45000;
     while(queue.adp.tracks.length && performance.now()<deadline) await new Promise(r=>setTimeout(r,50));
     const errors=queue.adp.tracks.filter(t=>t.error).map(t=>t.error);
     provider._closeWorker();
     await window.context.close();
     if(played!==3 || queue.adp.tracks.length) throw Error(`Real server stalled: played=${played},remaining=${queue.adp.tracks.length},errors=${errors}`);
     return {played,remaining:queue.adp.tracks.length};
    },process.env.TTS_TEST_ENDPOINT);
    console.log(name,'real-server',JSON.stringify(live));
   }

  } catch(error) { console.error(name,error.message);process.exitCode=1; }
  finally {await browser?.close();}
 }
 server.close();
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
