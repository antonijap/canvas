import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createShader,readShaderSource,updateShader,revOf,paperCard} from '../src/shaders.ts';
import {updateWidget} from '../src/widgets.ts';
import {cloudFileHooks} from '../src/cloud-files-runtime.ts';
test('parameterized Cloud cards read and copy their immutable source',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-shader-source-')),pkg=path.join(dir,'Design.canvas'),doc=path.join(pkg,'document.json'),old=cloudFileHooks.isCloud;
 fs.mkdirSync(pkg);fs.writeFileSync(doc,JSON.stringify({version:'2.21',children:[]}));process.env.CANVAS_ROOTS=dir;
 try{const made=await createShader(pkg,{preset:'mesh-gradient',params:{speed:0.5}});const source=paperCard('mesh-gradient',undefined,{speed:0.5}).source;
 cloudFileHooks.isCloud=()=>true;
 assert.equal((await readShaderSource(pkg,made.widget.id)).source,source);
 assert.equal(made.widget.config.source,`shaders/${made.widget.id}.src-${revOf(source)}.wgsl`);
 const copy=await createShader(pkg,{copyFrom:made.widget.id});assert.equal((await readShaderSource(pkg,copy.widget.id)).source,source);assert.notEqual(copy.widget.config.source,made.widget.config.source);
 const changed=await updateShader(pkg,made.widget.id,{params:{speed:0.9}});assert.equal(changed.widget.config.source,made.widget.config.source);assert.notEqual(changed.rev,made.rev);
 }finally{cloudFileHooks.isCloud=old;fs.unwatchFile(doc);fs.rmSync(dir,{recursive:true,force:true});}
});

test('existing parameterized Cloud cards resolve source snapshots without a source path',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-shader-existing-')),pkg=path.join(dir,'Design.canvas'),doc=path.join(pkg,'document.json'),old=cloudFileHooks.isCloud;fs.mkdirSync(pkg);fs.writeFileSync(doc,JSON.stringify({version:'2.21',children:[]}));process.env.CANVAS_ROOTS=dir;
 try{const made=await createShader(pkg,{preset:'mesh-gradient',params:{speed:0.5}});await updateWidget(pkg,made.widget.id,{config:{source:null}});cloudFileHooks.isCloud=()=>true;const got=await readShaderSource(pkg,made.widget.id);assert.equal(got.template,false);assert.equal(got.rev,made.rev);
 }finally{cloudFileHooks.isCloud=old;fs.unwatchFile(doc);fs.rmSync(dir,{recursive:true,force:true});}
});

test('pasted source keeps its mutable file return contract',async()=>{
 const {writePastedSource}=await import('../src/shaders.ts');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-shader-paste-')),pkg=path.join(dir,'Design.canvas'),doc=path.join(pkg,'document.json');fs.mkdirSync(pkg);fs.writeFileSync(doc,JSON.stringify({version:'2.21',children:[]}));
 try{const file=await writePastedSource(doc,'Pasted','fn shade() {}');assert.equal(path.basename(file),'Pasted.wgsl');assert.equal(fs.readFileSync(file,'utf8'),'fn shade() {}');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
