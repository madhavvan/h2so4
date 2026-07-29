const { keyboard, Key } = require('@nut-tree-fork/nut-js');
const { spawn, execFileSync } = require('node:child_process');
const fs=require('node:fs'), path=require('node:path'), os=require('node:os');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); keyboard.config.autoDelayMs=8;
const SCRATCH=path.join(os.tmpdir(),'claude','C--Users-penta','7586704a-eea2-4204-a133-acc0ee56f32b','scratchpad');
const FILE=path.join(SCRATCH,'home_key_probe2.txt');
// L1 indented+text, L2 no indent, L3 whitespace-only, L4 empty
const STUB=['        alpha','beta','        ','','tail',''].join('\n');
const tap=async k=>{await keyboard.pressKey(k);await sleep(12);await keyboard.releaseKey(k);await sleep(12);};
const ctrlTap=async k=>{await keyboard.pressKey(Key.LeftControl);await sleep(8);await keyboard.pressKey(k);await sleep(12);await keyboard.releaseKey(k);await sleep(8);await keyboard.releaseKey(Key.LeftControl);await sleep(12);};
function fp(){const ps=`Add-Type @"
using System;using System.Runtime.InteropServices;
public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}
"@
$h=[W]::GetForegroundWindow();$p=0;[void][W]::GetWindowThreadProcessId($h,[ref]$p)
(Get-Process -Id $p).ProcessName`;try{return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{encoding:'utf8'}).trim();}catch{return '?';}}
(async()=>{
 fs.writeFileSync(FILE,STUB,'utf8');
 spawn(path.join(process.env.LOCALAPPDATA,'Programs','Microsoft VS Code','Code.exe'),['--new-window','--disable-extensions',FILE],{detached:true,stdio:'ignore'}).unref();
 await sleep(9000);
 const p=fp(); if(!/^Code$/i.test(p)){console.error('REFUSING — focused:'+p);process.exit(2);}
 const goLine=async n=>{await ctrlTap(Key.Home);for(let i=0;i<n-1;i++)await tap(Key.Down);};
 // "End then Home Home" on each line shape
 for (const [ln,mark] of [[1,'A'],[2,'B'],[3,'C'],[4,'D']]) {
   await goLine(ln); await tap(Key.End); await tap(Key.Home); await tap(Key.Home); await keyboard.type(mark);
 }
 // Also: does Ctrl+Home + Down*N alone keep column 0? (no Home at all)
 await ctrlTap(Key.Home); await tap(Key.Down); await tap(Key.Down); await tap(Key.Down); await tap(Key.Down); await keyboard.type('E');
 await sleep(400); await ctrlTap(Key.S); await sleep(1500);
 const g=fs.readFileSync(FILE,'utf8').replace(/\r\n/g,'\n').split('\n');
 const names=['indented+text','no indent','whitespace-only','empty line'];
 g.slice(0,5).forEach((l,i)=>console.log(`  L${i+1} ${(names[i]||'tail (Ctrl+Home+Down x4, NO Home)').padEnd(34)} ${JSON.stringify(l)}`));
 console.log('\nEnd+Home+Home reaches column 0 on all shapes:', g[0].startsWith('A')&&g[1].startsWith('B')&&g[2].startsWith('C')&&g[3].startsWith('D')?'YES':'NO');
 console.log('Ctrl+Home + Down xN alone lands at column 0:', g[4].startsWith('E')?'YES':'NO');
 process.exit(0);
})();
