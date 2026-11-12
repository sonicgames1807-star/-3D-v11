import assert from 'node:assert/strict';
import {smooth,brushSmooth,brushSmoothInPlace,simplify,pickRay,neighborsOf} from '../mesh-core.js';
function grid(n=9,z=0,noise=true){
 const p=[],ix=[];for(let y=0;y<n;y++)for(let x=0;x<n;x++)p.push(x,y,z+(noise&&x===4&&y===4?.4:0));
 for(let y=0;y<n-1;y++)for(let x=0;x<n-1;x++){let a=y*n+x;ix.push(a,a+1,a+n,a+1,a+n+1,a+n);}
 return {positions:new Float32Array(p),indices:new Uint32Array(ix),name:'test'};
}
function join(a,b){return {positions:new Float32Array([...a.positions,...b.positions]),indices:new Uint32Array([...a.indices,...Array.from(b.indices,i=>i+a.positions.length/3)])};}
function components(m){const {offsets,adjacent}=neighborsOf(m),seen=new Set();let c=0;for(let i=0;i<offsets.length-1;i++){if(seen.has(i)||offsets[i]===offsets[i+1])continue;c++;const q=[i];seen.add(i);for(let j=0;j<q.length;j++)for(let k=offsets[q[j]];k<offsets[q[j]+1];k++){let v=adjacent[k];if(!seen.has(v)){seen.add(v);q.push(v)}}}return c;}
let count=0;function test(name,fn){fn();count++;console.log('OK',name)}
test('brush lowers bump, keeps input and outside radius',()=>{const m=grid(),before=m.positions.slice(),r=brushSmooth(m,[4,4,.4],{radius:2,strength:.5});assert(r.changed>0);assert(r.mesh.positions[122]<.4);assert.deepEqual(m.positions,before);assert.equal(r.mesh.positions[2],before[2]);});
test('brush cannot reach disconnected nearby surface',()=>{const a=grid(),b=grid(9,.1),m=join(a,b),r=brushSmooth(m,[4,4,.4],{radius:2});assert.deepEqual(r.mesh.positions.slice(a.positions.length),b.positions)});
test('in-place and copied brush agree; zero strength unchanged',()=>{const m=grid(),a=brushSmooth(m,[4,4,.4],{radius:2}),b=brushSmoothInPlace(grid(),[4,4,.4],{radius:2});assert.deepEqual(a.mesh.positions,b.mesh.positions);assert.equal(brushSmooth(m,[4,4,.4],{radius:2,strength:0}).changed,0)});
test('smoothing removes normal noise even with feature protection',()=>{const m=grid(),r=smooth(m,{strength:.5,iterations:3,featureAngle:180});assert(r.positions[122]<m.positions[122]);assert.deepEqual(smooth(m,{strength:0}).positions,m.positions)});
test('edge collapse reduces plane, preserves boundaries and winding',()=>{const m=grid(9,0,false),r=simplify(m,0,{maxAngle:0});assert(r.indices.length<m.indices.length);assert.equal(components(r),1);const before=neighborsOf(m),after=neighborsOf(r);const boundary=(mesh,g)=>Array.from(g.boundary).flatMap((v,i)=>v?[Array.from(mesh.positions.slice(3*i,3*i+3)).join(',')]:[]).sort();assert.deepEqual(boundary(m,before),boundary(r,after));for(let i=0;i<r.indices.length;i+=3){const [a,b,c]=r.indices.slice(i,i+3);const p=r.positions;assert((p[3*b]-p[3*a])*(p[3*c+1]-p[3*a+1])-(p[3*b+1]-p[3*a+1])*(p[3*c]-p[3*a])>0)}assert.deepEqual(simplify(r,0,{maxAngle:0}).indices,r.indices)});
test('nearby components remain separate',()=>{const m=join(grid(9,0,false),grid(9,.001,false)),r=simplify(m,0,{maxAngle:180});assert.equal(components(r),2);assert(r.indices.length<m.indices.length);assert(Array.from(r.positions).every(Number.isFinite))});
test('angle range excludes flat edges',()=>{const m=grid(9,0,false),r=simplify(m,0,{minAngle:1,maxAngle:180});assert(r.unchanged);assert.deepEqual(r.indices,m.indices)});
test('tetrahedron cannot collapse to duplicate faces',()=>{const m={positions:new Float32Array([0,0,0,1,0,0,0,1,0,0,0,1]),indices:new Uint32Array([0,2,1,0,1,3,0,3,2,1,2,3])};assert(simplify(m,0,{maxAngle:180}).unchanged)});
test('ray picks actual surface',()=>assert(pickRay(grid(),[4,4,5],[0,0,-1])));
test('brush displacement is bounded on uneven triangles',()=>{const m=grid(),radius=2,strength=.5,r=brushSmooth(m,[4,4,.4],{radius,strength});for(let i=0;i<m.positions.length;i+=3)assert(Math.hypot(...[0,1,2].map(k=>r.mesh.positions[i+k]-m.positions[i+k]))<=radius*.02*strength+1e-6)});
test('curved thin part resists excessive collapse',()=>{const m={positions:new Float32Array([1,0,0,-1,0,0,0,1,0,0,-1,0,0,0,.1,0,0,-.1]),indices:new Uint32Array([0,2,4,2,1,4,1,3,4,3,0,4,2,0,5,1,2,5,3,1,5,0,3,5])};assert(simplify(m,0,{maxAngle:180}).unchanged)});
console.log(`${count} tests passed`);
