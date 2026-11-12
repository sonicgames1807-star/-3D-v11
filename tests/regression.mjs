import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {parseSTL,brushSmooth,bounds,simplify,exportSTL,exportOBJ,parseOBJ,exportPLY,parsePLY,cloneMesh} from '../mesh-core.js';
const p=[],ix=[],segments=64,rows=9;
for(let y=0;y<rows;y++)for(let x=0;x<segments;x++) {
 const t=x*2*Math.PI/segments;p.push(Math.cos(t),Math.sin(t),y*.1);
}
for(let y=0;y<rows-1;y++)for(let x=0;x<segments;x++) {
 const a=y*segments+x,b=y*segments+(x+1)%segments;
 ix.push(a,b,a+segments,b,b+segments,a+segments);
}
for(const reversed of [false,true]) {
 const m={positions:new Float32Array(p),indices:new Uint32Array(reversed?ix.slice().reverse():ix)};
 let r=m;
 for(let j=0;j<30;j++)r=brushSmooth(r,[1,0,.4],{radius:1,strength:.8}).mesh;
 assert.deepEqual(r.positions,m.positions,'cylindrical wall changes under repeated brush');
}
if(process.argv[2]) {
 const b=fs.readFileSync(process.argv[2]);
 const m=parseSTL(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
 const box=bounds(m);let r=m;
 for(let j=0;j<20;j++)r=brushSmooth(r,box.center,{radius:box.diagonal,strength:.8}).mesh;
 let displacement=0;
 for(let i=0;i<m.positions.length;i++)displacement=Math.max(displacement,Math.abs(m.positions[i]-r.positions[i]));
 assert(Array.from(r.positions).every(Number.isFinite));
 console.log(JSON.stringify({faces:m.indices.length/3,maxCoordinateDisplacement:displacement}));
 assert(displacement>0,'brush must actually process the supplied scan');
 for(let i=0;i<m.positions.length;i+=3)
  assert(Math.hypot(...[0,1,2].map(k=>m.positions[i+k]-r.positions[i+k]))<=box.diagonal*.001+1e-6);
 const restored=cloneMesh(r);
 assert(restored.brushReference===r.brushReference,'undo snapshot must retain original drift reference');
 const stl= parseSTL(await exportSTL(r).arrayBuffer());
 const obj= parseOBJ(await exportOBJ(r).text());
 const ply= parsePLY(await exportPLY(r).arrayBuffer());
 for(const roundtrip of [stl,obj,ply]) {
  assert.equal(roundtrip.indices.length,r.indices.length);
  assert(Array.from(roundtrip.positions).every(Number.isFinite));
 }
 console.time('supplied model simplify');simplify(m);console.timeEnd('supplied model simplify');
}
const size=240, gp=[],gi=[];
for(let y=0;y<size;y++)for(let x=0;x<size;x++)gp.push(x,y,0);
for(let y=0;y<size-1;y++)for(let x=0;x<size-1;x++){const a=y*size+x;gi.push(a,a+1,a+size,a+1,a+size+1,a+size);}
const large={positions:new Float32Array(gp),indices:new Uint32Array(gi)};
console.time('114242 faces simplify');
const reduced=simplify(large,60000);
console.timeEnd('114242 faces simplify');
const original=await import('data:text/javascript;base64,'+Buffer.from(execFileSync('git',['show','HEAD:mesh-core.js'])).toString('base64'));
console.time('original 114242 faces simplify');
const baseline=original.simplify(large,60000);
console.timeEnd('original 114242 faces simplify');
assert.deepEqual(reduced.positions,baseline.positions);
assert.deepEqual(reduced.indices,baseline.indices);
assert(reduced.indices.length<large.indices.length);
assert(reduced.indices.length/3>=60000);
console.log('PASS cylinder, reversed winding, supplied model and large mesh');
