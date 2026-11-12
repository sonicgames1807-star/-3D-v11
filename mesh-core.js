export function cloneMesh(mesh) {
  return {
    positions: new Float32Array(mesh.positions),
    indices: new Uint32Array(mesh.indices),
    name: mesh.name || "модель",
    brushReference: mesh.brushReference,
  };
}
export function bounds(mesh) {
  const p = mesh.positions;
  if (!p.length) throw Error("В файле нет вершин.");
  let min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (!Number.isFinite(v))
        throw Error("В модели найдены NaN или Infinity.");
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return {
    min,
    max,
    center: min.map((v, i) => (v + max[i]) / 2),
    size: min.map((v, i) => max[i] - v),
    diagonal: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]),
  };
}
function clean(mesh) {
  const p = mesh.positions,
    idx = mesh.indices;
  if (!p.length || !idx.length || idx.length % 3)
    throw Error("В файле нет корректных треугольников.");
  for (const i of idx)
    if (i >= p.length / 3) throw Error("В модели есть некорректные индексы.");
  for (const v of p)
    if (!Number.isFinite(v)) throw Error("В модели найдены NaN или Infinity.");
  return mesh;
}
const MAX_STL_TRIANGLES = 4000000,
  MAX_STL_VERTICES = MAX_STL_TRIANGLES * 3;
function weldSoupByReader(count, readPoint, name) {
  if (count < 3 || count % 3)
    throw Error("В STL нет полного набора треугольников.");
  if (count > MAX_STL_VERTICES)
    throw Error("STL слишком велик: поддерживается до 4 млн треугольников.");
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  const point = new Float32Array(3);
  for (let i = 0; i < count; i++) {
    readPoint(i, point);
    const x = point[0],
      y = point[1],
      z = point[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      throw Error("В STL найдены NaN или Infinity.");
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const tol = Math.max(
    1e-8,
    Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 1e-7,
  );
  let bucketCount = 1;
  while (bucketCount < count * 1.25) bucketCount *= 2;
  let verts = new Float32Array(Math.min(count, 65536) * 3);
  const indices = new Uint32Array(count),
    mask = bucketCount - 1;
  let slots = new Uint32Array(bucketCount);
  let unique = 0;
  for (let i = 0; i < count; i++) {
    readPoint(i, point);
    const x = point[0],
      y = point[1],
      z = point[2],
      qx = Math.round((x - minX) / tol),
      qy = Math.round((y - minY) / tol),
      qz = Math.round((z - minZ) / tol),
      hash =
        (Math.imul(qx, 73856093) ^
          Math.imul(qy, 19349663) ^
          Math.imul(qz, 83492791)) >>>
        0,
      start = hash & mask;
    let bucket = start,
      slot = slots[bucket],
      id = -1;
    while (slot) {
      const candidate = slot - 1;
      const o = candidate * 3;
      if (
        Math.round((verts[o] - minX) / tol) === qx &&
        Math.round((verts[o + 1] - minY) / tol) === qy &&
        Math.round((verts[o + 2] - minZ) / tol) === qz
      ) {
        id = candidate;
        break;
      }
      bucket = (bucket + 1) & mask;
      slot = slots[bucket];
    }
    if (id === -1) {
      id = unique++;
      if (id * 3 + 2 >= verts.length) {
        const grown = new Float32Array(
          Math.min(count, Math.max(65536, (verts.length / 3) * 2)) * 3,
        );
        grown.set(verts);
        verts = grown;
      }
      const o = id * 3;
      verts[o] = x;
      verts[o + 1] = y;
      verts[o + 2] = z;
      slots[bucket] = id + 1;
    }
    indices[i] = id;
  }
  return clean({ positions: verts.slice(0, unique * 3), indices, name });
}
function weldSoup(points, name) {
  return weldSoupByReader(
    points.length / 3,
    (i, out) => {
      const offset = i * 3;
      out[0] = points[offset];
      out[1] = points[offset + 1];
      out[2] = points[offset + 2];
    },
    name,
  );
}
function weldBinarySTL(view, triangleCount, name) {
  return weldSoupByReader(
    triangleCount * 3,
    (i, out) => {
      const offset = 84 + Math.floor(i / 3) * 50 + 12 + (i % 3) * 12;
      out[0] = view.getFloat32(offset, true);
      out[1] = view.getFloat32(offset + 4, true);
      out[2] = view.getFloat32(offset + 8, true);
    },
    name,
  );
}
export function parseSTL(buffer, name = "модель.stl") {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 15) throw Error("Файл слишком мал для STL.");
  if (bytes.length >= 84) {
    const n = new DataView(buffer).getUint32(80, true),
      expected = 84 + n * 50;
    if (n > 0 && expected <= bytes.length) {
      if (n > MAX_STL_TRIANGLES)
        throw Error(
          "STL слишком велик: поддерживается до 4 млн треугольников.",
        );
      return weldBinarySTL(new DataView(buffer), n, name);
    }
  }
  const text = new TextDecoder().decode(buffer),
    re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/gi;
  let count = 0,
    m;
  while ((m = re.exec(text)) !== null) {
    count++;
    if (count > MAX_STL_VERTICES)
      throw Error("STL слишком велик: поддерживается до 4 млн треугольников.");
  }
  if (count < 3 || count % 3)
    throw Error(
      "Не удалось распознать STL. Проверьте, что это ASCII или бинарный STL.",
    );
  const pts = new Float32Array(count * 3);
  re.lastIndex = 0;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    pts[k++] = Number(m[1]);
    pts[k++] = Number(m[2]);
    pts[k++] = Number(m[3]);
  }
  return weldSoup(pts, name);
}
export function parseOBJ(text, name = "модель.obj") {
  const verts = [],
    faces = [];
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    const parts = s.split(/\s+/);
    if (parts[0] === "v" && parts.length >= 4) {
      const v = parts.slice(1, 4).map(Number);
      if (!v.every(Number.isFinite))
        throw Error("В OBJ найдена некорректная вершина.");
      verts.push(...v);
    } else if (parts[0] === "f" && parts.length >= 4) {
      const face = parts.slice(1).map((token) => {
        const n = parseInt(token.split("/")[0], 10);
        const id = n < 0 ? verts.length / 3 + n : n - 1;
        if (!Number.isInteger(id) || id < 0 || id >= verts.length / 3)
          throw Error("В OBJ есть ссылка на отсутствующую вершину.");
        return id;
      });
      for (let i = 1; i < face.length - 1; i++)
        faces.push(face[0], face[i], face[i + 1]);
    }
  }
  if (!verts.length || !faces.length)
    throw Error("OBJ не содержит распознаваемой геометрии.");
  return clean({
    positions: new Float32Array(verts),
    indices: new Uint32Array(faces),
    name,
  });
}
export function stats(mesh) {
  const b = bounds(mesh),
    faces = mesh.indices.length / 3;
  if (faces > 100000)
    return {
      vertices: mesh.positions.length / 3,
      faces,
      bounds: b,
      boundaryEdges: null,
    };
  const edges = new Map();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i],
      c = mesh.indices[i + 1],
      d = mesh.indices[i + 2];
    for (const [u, v] of [
      [a, c],
      [c, d],
      [d, a],
    ]) {
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let boundary = 0;
  for (const n of edges.values()) if (n === 1) boundary++;
  return {
    vertices: mesh.positions.length / 3,
    faces,
    bounds: b,
    boundaryEdges: boundary,
  };
}
export function neighborsOf(mesh) {
  const n = mesh.positions.length / 3,
    ix = mesh.indices,
    faces = ix.length / 3,
    degree = new Uint32Array(n),
    boundaryKnown = true,
    boundary = new Uint8Array(n),
    edgeCounts = boundaryKnown ? new Map() : null;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i],
      b = ix[i + 1],
      c = ix[i + 2];
    if (a === b || b === c || a === c) continue;
    degree[a] += 2;
    degree[b] += 2;
    degree[c] += 2;
    if (edgeCounts) {
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
      }
    }
  }
  if (edgeCounts)
    for (const [key, count] of edgeCounts)
      if (count !== 2) {
        const comma = key.indexOf(","),
          a = Number(key.slice(0, comma)),
          b = Number(key.slice(comma + 1));
        boundary[a] = boundary[b] = 1;
      }
  const offsets = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + degree[i];
  const adjacent = new Uint32Array(offsets[n]),
    cursor = offsets.slice(0, n);
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i],
      b = ix[i + 1],
      c = ix[i + 2];
    if (a === b || b === c || a === c) continue;
    adjacent[cursor[a]++] = b;
    adjacent[cursor[a]++] = c;
    adjacent[cursor[b]++] = a;
    adjacent[cursor[b]++] = c;
    adjacent[cursor[c]++] = a;
    adjacent[cursor[c]++] = b;
  }
  return { offsets, adjacent, boundary, boundaryKnown };
}
export function vertexNormals(mesh) {
  const n = new Float32Array(mesh.positions.length),
    p = mesh.positions,
    ix = mesh.indices;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3,
      b = ix[i + 1] * 3,
      c = ix[i + 2] * 3,
      ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2],
      vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2],
      nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    n[a] += nx;
    n[a + 1] += ny;
    n[a + 2] += nz;
    n[b] += nx;
    n[b + 1] += ny;
    n[b + 2] += nz;
    n[c] += nx;
    n[c + 1] += ny;
    n[c + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (l < 1e-12) {
      n[i] = 0;
      n[i + 1] = 1;
      n[i + 2] = 0;
    } else {
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    }
  }
  return n;
}
export function smooth(
  mesh,
  {
    strength = 0.45,
    iterations = 3,
    preserveBoundary = true,
    tangential = false,
    protectFeatures = true,
    featureAngle = 35,
  } = {},
) {
  const out = cloneMesh(mesh),
    { offsets, adjacent, boundary, boundaryKnown } = neighborsOf(mesh),
    n = out.positions.length / 3,
    needsNormals = tangential || protectFeatures,
    normals = needsNormals ? vertexNormals(mesh) : null,
    features = protectFeatures
      ? featureVertexMask(mesh, normals, featureAngle)
      : null;
  if (n < 4) throw Error("Для сглаживания нужно не менее четырёх вершин.");
  if (preserveBoundary && !boundaryKnown)
    throw Error(
      "Защита открытых границ доступна для сеток до 100 000 треугольников. Отключите защиту или сначала упростите модель.",
    );
  let p = out.positions;
  const step = (lambda) => {
    const q = new Float32Array(p.length);
    for (let i = 0; i < n; i++) {
      const begin = offsets[i],
        end = offsets[i + 1],
        count = end - begin,
        o = i * 3;
      if (
        !count ||
        (preserveBoundary && boundary[i]) ||
        (features && features[i])
      ) {
        q[o] = p[o];
        q[o + 1] = p[o + 1];
        q[o + 2] = p[o + 2];
        continue;
      }
      let x = 0,
        y = 0,
        z = 0;
      for (let k = begin; k < end; k++) {
        const j = adjacent[k];
        x += p[j * 3];
        y += p[j * 3 + 1];
        z += p[j * 3 + 2];
      }
      let dx = x / count - p[o],
        dy = y / count - p[o + 1],
        dz = z / count - p[o + 2];
      if (tangential && normals) {
        const nx = normals[o],
          ny = normals[o + 1],
          nz = normals[o + 2],
          normalPart = dx * nx + dy * ny + dz * nz;
        dx -= normalPart * nx;
        dy -= normalPart * ny;
        dz -= normalPart * nz;
      }
      q[o] = p[o] + lambda * dx;
      q[o + 1] = p[o + 1] + lambda * dy;
      q[o + 2] = p[o + 2] + lambda * dz;
    }
    p = q;
  };
  const lam = 0.5 * Math.max(0, Math.min(1, strength));
  for (let k = 0; k < iterations; k++) {
    step(lam);
    step(-lam * 0.53);
  }
  out.positions = p;
  delete out.brushReference;
  return clean(out);
}
function applyBrushSmooth(
  mesh,
  center,
  {
    radius,
    strength = 0.45,
    preserveBoundary = true,
    rayDirection = null,
    protectFeatures = false,
    featureAngle = 35,
  } = {},
  inPlace,
) {
  if (!(radius > 0) || !Number.isFinite(radius) || !Number.isFinite(strength) ||
      !center || center.length!==3 || !Array.from(center).every(Number.isFinite))
    throw Error("Кисть: нужны конечные координаты, сила и положительный радиус.");
  const out = inPlace ? mesh : cloneMesh(mesh),
    { offsets, adjacent, boundary, boundaryKnown } = neighborsOf(mesh),
    p = out.positions,
    src = inPlace ? new Float32Array(mesh.positions) : mesh.positions,
    n = p.length / 3,
    normals = vertexNormals(mesh),
    features = protectFeatures
      ? featureVertexMask(mesh, normals, featureAngle)
      : null;
  let changed = 0;
  let reference=mesh.brushReference;
  if(!reference) reference={positions:src.slice(),limit:bounds(mesh).diagonal*0.001};
  out.brushReference=reference;
  // Estimate the low-frequency curvature separately from scan noise.
  // Removing only the residual avoids Laplacian shrinkage of bore walls.
  const curvature = new Float64Array(n);
  for (let i=0;i<n;i++) {
    const count=offsets[i+1]-offsets[i];
    if (!count) continue;
    for (let k=offsets[i];k<offsets[i+1];k++) {
      const j=adjacent[k];
      for (let axis=0;axis<3;axis++)
        curvature[i]+=(src[j*3+axis]-src[i*3+axis])*normals[i*3+axis]/count;
    }
  }
  if (preserveBoundary && !boundaryKnown)
    throw Error("Защита открытых границ недоступна для крупной сетки.");
  const eligible = new Uint8Array(n), selected = new Uint8Array(n);
  let seed = -1, nearest = Infinity;
  for (let i=0;i<n;i++) {
    const d=Math.hypot(src[3*i]-center[0],src[3*i+1]-center[1],src[3*i+2]-center[2]);
    if (d<radius && offsets[i+1]>offsets[i]) {
      eligible[i]=1;
      if (d<nearest) { nearest=d; seed=i; }
    }
  }
  const queue=[];
  if(seed>=0) { queue.push(seed); selected[seed]=1; }
  for(let head=0;head<queue.length;head++) {
    const i=queue[head];
    for(let k=offsets[i];k<offsets[i+1];k++) {
      const j=adjacent[k];
      if(eligible[j] && !selected[j]) { selected[j]=1; queue.push(j); }
    }
  }
  for (let i = 0; i < n; i++) {
    const o = i * 3,
      dx = src[o] - center[0],
      dy = src[o + 1] - center[1],
      dz = src[o + 2] - center[2],
      d = Math.hypot(dx, dy, dz);
    const begin = offsets[i],
      end = offsets[i + 1],
      count = end - begin;
    if (
      !selected[i] ||
      d >= radius ||
      !count ||
      (preserveBoundary && boundary[i]) ||
      (features && features[i])
    )
      continue;
    if (
      rayDirection &&
      dx * rayDirection[0] + dy * rayDirection[1] + dz * rayDirection[2] >
        radius * 0.2
    )
      continue;
    const t = Math.max(0, 1 - d / radius),
      fall = t * t * (3 - 2 * t),
      a = Math.max(0, Math.min(0.8, strength)) * fall;
    const neighborhood = [curvature[i]];
    for(let k=begin;k<end;k++) neighborhood.push(curvature[adjacent[k]]);
    neighborhood.sort((a,b)=>a-b);
    const baseline = neighborhood[Math.floor(neighborhood.length/2)];
    let residual = curvature[i]-baseline;
    // Float32 quantisation must not accumulate into drift on a smooth wall.
    if(Math.abs(residual)<Math.max(reference.limit*1e-5, Math.abs(baseline)*.02)) residual=0;
    const move = [0,1,2].map(k=>a*residual*normals[o+k]);
    const length = Math.hypot(...move);
    const scale = length ? Math.min(1, radius * 0.02 * a / length) : 0;
    p[o] = src[o] + move[0] * scale;
    p[o + 1] = src[o + 1] + move[1] * scale;
    p[o + 2] = src[o + 2] + move[2] * scale;
    const delta=[0,1,2].map(k=>p[o+k]-reference.positions[o+k]);
    const drift=Math.hypot(...delta);
    if(drift>reference.limit) {
      for(let k=0;k<3;k++) p[o+k]=reference.positions[o+k]+delta[k]*reference.limit/drift;
    }
    if (p[o] !== src[o] || p[o+1] !== src[o+1] || p[o+2] !== src[o+2]) changed++;
  }
  // Backtrack the whole step when a narrow triangle would fold.
  for(let attempt=0;changed && attempt<13;attempt++) {
   let safe=true;
   for(let f=0;f<mesh.indices.length;f+=3) {
    const a=mesh.indices[f]*3,b=mesh.indices[f+1]*3,c=mesh.indices[f+2]*3;
    const normal=q=>{
      const ux=q[b]-q[a],uy=q[b+1]-q[a+1],uz=q[b+2]-q[a+2];
      const vx=q[c]-q[a],vy=q[c+1]-q[a+1],vz=q[c+2]-q[a+2];
      return [uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx];
    };
    const old=normal(src),next=normal(p),ol=Math.hypot(...old),nl=Math.hypot(...next);
    if(ol>0 && (nl<ol*1e-6 || old.reduce((s,v,k)=>s+v*next[k],0)<=0)) {
      safe=false;break;
    }
   }
   if(safe) break;
   if(attempt===12) {p.set(src);changed=0;break;}
   for(let i=0;i<p.length;i++) p[i]=src[i]+(p[i]-src[i])*.5;
  }
  return { mesh: out, changed };
}
export function brushSmooth(mesh, center, options = {}) {
  return applyBrushSmooth(mesh, center, options, false);
}
export function brushSmoothInPlace(mesh, center, options = {}) {
  return applyBrushSmooth(mesh, center, options, true);
}
export function pickRay(mesh, origin, direction) {
  const p = mesh.positions,
    ix = mesh.indices;
  let best = Infinity,
    hit = null;
  for (let i = 0; i < ix.length; i += 3) {
    const ia = ix[i] * 3,
      ib = ix[i + 1] * 3,
      ic = ix[i + 2] * 3,
      e1x = p[ib] - p[ia],
      e1y = p[ib + 1] - p[ia + 1],
      e1z = p[ib + 2] - p[ia + 2],
      e2x = p[ic] - p[ia],
      e2y = p[ic + 1] - p[ia + 1],
      e2z = p[ic + 2] - p[ia + 2],
      hx = direction[1] * e2z - direction[2] * e2y,
      hy = direction[2] * e2x - direction[0] * e2z,
      hz = direction[0] * e2y - direction[1] * e2x,
      det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-10) continue;
    const inv = 1 / det,
      sx = origin[0] - p[ia],
      sy = origin[1] - p[ia + 1],
      sz = origin[2] - p[ia + 2],
      u = inv * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y,
      qy = sz * e1x - sx * e1z,
      qz = sx * e1y - sy * e1x,
      v = inv * (direction[0] * qx + direction[1] * qy + direction[2] * qz);
    if (v < 0 || u + v > 1) continue;
    const t = inv * (e2x * qx + e2y * qy + e2z * qz);
    if (t > 1e-5 && t < best) {
      best = t;
      hit = [
        origin[0] + direction[0] * t,
        origin[1] + direction[1] * t,
        origin[2] + direction[2] * t,
      ];
    }
  }
  return hit;
}
function vertexBend(mesh) {
  const normals = vertexNormals(mesh),
    bend = new Float32Array(mesh.positions.length / 3),
    ix = mesh.indices;
  const updateEdge = (u, v) => {
    const ou = u * 3,
      ov = v * 3,
      dot = Math.max(
        -1,
        Math.min(
          1,
          normals[ou] * normals[ov] +
            normals[ou + 1] * normals[ov + 1] +
            normals[ou + 2] * normals[ov + 2],
        ),
      ),
      angle = (Math.acos(dot) * 180) / Math.PI;
    if (angle > bend[u]) bend[u] = angle;
    if (angle > bend[v]) bend[v] = angle;
  };
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i],
      b = ix[i + 1],
      c = ix[i + 2];
    updateEdge(a, b);
    updateEdge(b, c);
    updateEdge(c, a);
  }
  return bend;
}
// A vertex is protected when its incident face normals diverge sharply from
// its averaged vertex normal. This works on welded hard-surface edges without
// storing a large edge-to-face map.
function featureVertexMask(mesh, normals, featureAngle = 35) {
  const p = mesh.positions,
    ix = mesh.indices,
    mask = new Uint8Array(p.length / 3),
    maxDeviation = new Float32Array(mask.length),
    threshold = Math.max(0, Math.min(180, Number(featureAngle) || 0)) * 0.5;
  if (threshold <= 0) return mask;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3,
      b = ix[i + 1] * 3,
      c = ix[i + 2] * 3,
      ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2],
      vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2],
      nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      length = Math.hypot(nx, ny, nz);
    if (length < 1e-20) continue;
    const faceNormal = [nx / length, ny / length, nz / length];
    for (const o of [a, b, c]) {
      const dot = Math.max(
          -1,
          Math.min(
            1,
            normals[o] * faceNormal[0] +
              normals[o + 1] * faceNormal[1] +
              normals[o + 2] * faceNormal[2],
          ),
        ),
        angle = (Math.acos(dot) * 180) / Math.PI,
      vertex = o / 3;
      if (angle > maxDeviation[vertex]) maxDeviation[vertex] = angle;
    }
  }
  for (let i = 0; i < mask.length; i++)
    if (maxDeviation[i] >= threshold) mask[i] = 1;
  return mask;
}
function compact(mesh) {
  const used = new Uint8Array(mesh.positions.length / 3);
  for (const i of mesh.indices) used[i] = 1;
  const remap = new Uint32Array(used.length);
  let usedCount = 0;
  for (let i = 0; i < used.length; i++) usedCount += used[i];
  const p = new Float32Array(usedCount * 3);
  let out = 0;
  for (let i = 0; i < used.length; i++)
    if (used[i]) {
      remap[i] = out;
      p.set(mesh.positions.subarray(i * 3, i * 3 + 3), out * 3);
      out++;
    }
  const idx = Uint32Array.from(mesh.indices, (i) => remap[i]);
  return { positions: p, indices: idx, name: mesh.name };
}
// Collapse only actual mesh edges. Rebuild candidates after each sweep;
// local face incidence is updated immediately after every accepted collapse.
export function simplify(mesh, targetFaces = 0, { minAngle = 0, maxAngle = 30 } = {}) {
  minAngle = Math.max(0, Math.min(180, Number(minAngle) || 0));
  maxAngle = Math.max(minAngle, Math.min(180, Number(maxAngle) || 0));
  const out = cloneMesh(mesh), p = out.positions, ix = out.indices;
  const incident = Array.from({length: p.length / 3}, () => new Set());
  const live = new Uint8Array(ix.length / 3).fill(1);
  let remaining = live.length, collapsed = 0;
  const floor = Math.max(0, Number(targetFaces) || 0);
  const surfaceTolerance = bounds(mesh).diagonal * 1e-5;
  for (let f = 0; f < live.length; f++)
    for (let k = 0; k < 3; k++) incident[ix[3*f+k]].add(f);
  function normal(f, u = -1, v = -1, point = null) {
    const a=ix[f*3],b=ix[f*3+1],c=ix[f*3+2];
    const ap=a===u||a===v,bp=b===u||b===v,cp=c===u||c===v;
    const ax=ap?point[0]:p[a*3],ay=ap?point[1]:p[a*3+1],az=ap?point[2]:p[a*3+2];
    const ux=(bp?point[0]:p[b*3])-ax,uy=(bp?point[1]:p[b*3+1])-ay,uz=(bp?point[2]:p[b*3+2])-az;
    const vx=(cp?point[0]:p[c*3])-ax,vy=(cp?point[1]:p[c*3+1])-ay,vz=(cp?point[2]:p[c*3+2])-az;
    return [uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx];
  }
  const ringCache = new Map();
  function ring(u) {
    if (ringCache.has(u)) return ringCache.get(u);
    const counts = new Map();
    for (const f of incident[u]) for (let k=0;k<3;k++) {
      const v=ix[3*f+k];
      if (v!==u) counts.set(v,(counts.get(v)||0)+1);
    }
    ringCache.set(u, counts);
    return counts;
  }
  let progress = true;
  while (progress && remaining > floor) {
    progress = false;
    const edges = [];
    for (let u=0;u<incident.length;u++) for (const v of ring(u).keys())
      if (u<v) edges.push([u,v,Math.hypot(p[3*u]-p[3*v],p[3*u+1]-p[3*v+1],p[3*u+2]-p[3*v+2])]);
    edges.sort((a,b)=>a[2]-b[2] || a[0]-b[0] || a[1]-b[1]);
    for (const [u,v] of edges) {
      if (remaining <= floor || !incident[u].size || !incident[v].size) continue;
      const shared = [...incident[u]].filter(f=>incident[v].has(f));
      if (shared.length!==2 || remaining-2 < floor) continue;
      const ru=ring(u), rv=ring(v);
      // Lock open and non-manifold borders. Link condition prevents handles,
      // accidental bridges and pinching two distant surface neighborhoods.
      if ([...ru.values(),...rv.values()].some(n=>n!==2)) continue;
      const common=[...ru.keys()].filter(w=>rv.has(w));
      const opposite=new Set(shared.flatMap(f=>Array.from(ix.subarray(3*f,3*f+3))).filter(w=>w!==u&&w!==v));
      if (common.length!==2 || common.some(w=>!opposite.has(w))) continue;
      const n1=normal(shared[0]), n2=normal(shared[1]);
      const length=Math.hypot(...n1)*Math.hypot(...n2);
      if (!length) continue;
      const angle=Math.acos(Math.max(-1,Math.min(1,n1.reduce((s,x,k)=>s+x*n2[k],0)/length)))*180/Math.PI;
      if (angle+1e-6<minAngle || angle-1e-6>maxAngle) continue;
      const point=[0,1,2].map(k=>Math.fround((p[3*u+k]+p[3*v+k])/2));
      const affected=new Set([...incident[u],...incident[v]]), keys=new Set();
      let safe=true;
      // Bound the displacement from every incident face plane, including
      // removed faces: topology alone does not preserve thin mechanical parts.
      for (const f of affected) {
        const norm=normal(f), len=Math.hypot(...norm), base=ix[3*f]*3;
        if (len && Math.abs(norm.reduce((sum,x,k)=>sum+x*(point[k]-p[base+k]),0))/len > surfaceTolerance) {
          safe=false; break;
        }
      }
      if (!safe) continue;
      for (const f of affected) {
        if (shared.includes(f)) continue;
        const ids=Array.from(ix.subarray(3*f,3*f+3),w=>w===v?u:w);
        const key=ids.slice().sort((a,b)=>a-b).join(',');
        if (keys.has(key)) { safe=false; break; }
        keys.add(key);
        const old=normal(f), next=normal(f,u,v,point);
        const oldLength=Math.hypot(...old), newLength=Math.hypot(...next);
        if (newLength<=oldLength*1e-8 || old.reduce((s,x,k)=>s+x*next[k],0)<=oldLength*newLength*0.1) { safe=false; break; }
      }
      if (!safe) continue;
      for (const f of affected) {
        for (let k=0;k<3;k++) ringCache.delete(ix[3*f+k]);
        for (let k=0;k<3;k++) incident[ix[3*f+k]].delete(f);
        if (shared.includes(f)) { live[f]=0; remaining--; continue; }
        for (let k=0;k<3;k++) {
          if (ix[3*f+k]===v) ix[3*f+k]=u;
          incident[ix[3*f+k]].add(f);
        }
      }
      p.set(point,3*u); collapsed++; progress=true;
    }
  }
  if (!collapsed) { out.unchanged=true; return out; }
  const indices=new Uint32Array(remaining*3);
  let at=0;
  for (let f=0;f<live.length;f++) if(live[f]) {indices.set(ix.subarray(3*f,3*f+3),at);at+=3;}
  return {...compact({...out,indices}), unchanged:false};
}
export function exportOBJ(mesh) {
  let s = "# Mesh Scan Studio — обработанная копия\n";
  for (let i = 0; i < mesh.positions.length; i += 3)
    s += `v ${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}\n`;
  for (let i = 0; i < mesh.indices.length; i += 3)
    s += `f ${mesh.indices[i] + 1} ${mesh.indices[i + 1] + 1} ${mesh.indices[i + 2] + 1}\n`;
  return new Blob([s], { type: "text/plain" });
}
export function exportSTL(mesh) {
  const count = mesh.indices.length / 3,
    buffer = new ArrayBuffer(84 + count * 50),
    view = new DataView(buffer),
    header = new TextEncoder().encode("Mesh Scan Studio binary STL");
  new Uint8Array(buffer, 0, header.length).set(header);
  view.setUint32(80, count, true);
  const p = mesh.positions,
    ix = mesh.indices;
  for (let t = 0; t < count; t++) {
    const off = 84 + t * 50,
      a = ix[t * 3],
      b = ix[t * 3 + 1],
      c = ix[t * 3 + 2],
      ax = p[a * 3],
      ay = p[a * 3 + 1],
      az = p[a * 3 + 2],
      ux = p[b * 3] - ax,
      uy = p[b * 3 + 1] - ay,
      uz = p[b * 3 + 2] - az,
      vx = p[c * 3] - ax,
      vy = p[c * 3 + 1] - ay,
      vz = p[c * 3 + 2] - az;
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      l = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(off, nx / l, true);
    view.setFloat32(off + 4, ny / l, true);
    view.setFloat32(off + 8, nz / l, true);
    for (let j = 0; j < 3; j++) {
      const id = ix[t * 3 + j];
      view.setFloat32(off + 12 + j * 12, p[id * 3], true);
      view.setFloat32(off + 16 + j * 12, p[id * 3 + 1], true);
      view.setFloat32(off + 20 + j * 12, p[id * 3 + 2], true);
    }
    view.setUint16(off + 48, 0, true);
  }
  return new Blob([buffer], { type: "model/stl" });
}
export function makeExample() {
  const pos = [],
    idx = [],
    lat = 36,
    lon = 64;
  pos.push(0, 1, 0);
  for (let y = 1; y < lat; y++) {
    const phi = (Math.PI * y) / lat;
    for (let x = 0; x < lon; x++) {
      const theta = (2 * Math.PI * x) / lon;
      const noise =
        1 +
        0.035 * Math.sin(theta * 7) * Math.sin(phi * 11) +
        0.018 * Math.cos(theta * 13 + phi * 4);
      pos.push(
        noise * Math.sin(phi) * Math.cos(theta),
        noise * Math.cos(phi) * 0.82,
        noise * Math.sin(phi) * Math.sin(theta),
      );
    }
  }
  const bottom = pos.length / 3;
  pos.push(0, -0.82, 0);
  for (let x = 0; x < lon; x++) idx.push(0, 1 + ((x + 1) % lon), 1 + x);
  for (let y = 0; y < lat - 2; y++) {
    const upper = 1 + y * lon,
      lower = upper + lon;
    for (let x = 0; x < lon; x++) {
      const next = (x + 1) % lon,
        a = upper + x,
        b = upper + next,
        c = lower + x,
        d = lower + next;
      idx.push(a, b, c, b, d, c);
    }
  }
  const last = 1 + (lat - 2) * lon;
  for (let x = 0; x < lon; x++)
    idx.push(bottom, last + x, last + ((x + 1) % lon));
  return {
    positions: new Float32Array(pos),
    indices: new Uint32Array(idx),
    name: "пример_скана",
  };
}

const PLY_SCALARS = {
  char: ["getInt8", 1],
  int8: ["getInt8", 1],
  uchar: ["getUint8", 1],
  uint8: ["getUint8", 1],
  short: ["getInt16", 2],
  int16: ["getInt16", 2],
  ushort: ["getUint16", 2],
  uint16: ["getUint16", 2],
  int: ["getInt32", 4],
  int32: ["getInt32", 4],
  uint: ["getUint32", 4],
  uint32: ["getUint32", 4],
  float: ["getFloat32", 4],
  float32: ["getFloat32", 4],
  double: ["getFloat64", 8],
  float64: ["getFloat64", 8],
};
export function parsePLY(buffer, name = "модель.ply") {
  const bytes = new Uint8Array(buffer);
  let headerEnd = -1;
  for (let i = 0; i < bytes.length - 10; i++)
    if (
      bytes[i] === 101 &&
      bytes[i + 1] === 110 &&
      bytes[i + 2] === 100 &&
      bytes[i + 3] === 95 &&
      bytes[i + 4] === 104 &&
      bytes[i + 5] === 101 &&
      bytes[i + 6] === 97 &&
      bytes[i + 7] === 100 &&
      bytes[i + 8] === 101 &&
      bytes[i + 9] === 114
    ) {
      headerEnd = i + 10;
      break;
    }
  if (headerEnd < 0) throw Error("В PLY не найден конец заголовка.");
  if (bytes[headerEnd] === 13) headerEnd++;
  if (bytes[headerEnd] === 10) headerEnd++;
  else throw Error("Некорректное окончание заголовка PLY.");
  const header = new TextDecoder().decode(bytes.subarray(0, headerEnd)),
    lines = header.split(/\r?\n/);
  if (lines[0].trim() !== "ply") throw Error("Файл не является PLY.");
  let format = "",
    current = null;
  const elements = [];
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (t[0] === "format") format = t[1];
    else if (t[0] === "element") {
      current = { name: t[1], count: Number(t[2]), props: [] };
      if (!Number.isInteger(current.count) || current.count < 0)
        throw Error("Некорректное число элементов в PLY.");
      elements.push(current);
    } else if (t[0] === "property" && current) {
      if (t[1] === "list")
        current.props.push({
          list: true,
          countType: t[2],
          itemType: t[3],
          name: t[4],
        });
      else current.props.push({ list: false, type: t[1], name: t[2] });
    }
  }
  if (!["ascii", "binary_little_endian", "binary_big_endian"].includes(format))
    throw Error("Этот вариант формата PLY не поддерживается.");
  const ve = elements.find((e) => e.name === "vertex"),
    fe = elements.find((e) => e.name === "face");
  if (!ve) throw Error("В PLY не найден список вершин.");
  const xProp = ve.props.findIndex((p) => p.name === "x"),
    yProp = ve.props.findIndex((p) => p.name === "y"),
    zProp = ve.props.findIndex((p) => p.name === "z");
  if ([xProp, yProp, zProp].some((i) => i < 0))
    throw Error("В PLY отсутствуют координаты x, y или z.");
  const positions = [],
    faces = [];
  if (format === "ascii") {
    const body = new TextDecoder()
      .decode(bytes.subarray(headerEnd))
      .split(/\r?\n/);
    let row = 0;
    for (const el of elements)
      for (let r = 0; r < el.count; r++) {
        while (
          row < body.length &&
          (!body[row].trim() || body[row].trim().startsWith("comment"))
        )
          row++;
        if (row >= body.length)
          throw Error("Данные PLY неожиданно закончились.");
        const tok = body[row++].trim().split(/\s+/);
        let k = 0,
          xyz = {},
          face = null;
        for (const p of el.props) {
          if (p.list) {
            const c = Number(tok[k++]);
            if (!Number.isInteger(c) || c < 0 || k + c > tok.length)
              throw Error("Некорректный список значений в PLY.");
            const values = tok.slice(k, k + c).map(Number);
            k += c;
            if (
              el.name === "face" &&
              ["vertex_indices", "vertex_index"].includes(p.name)
            )
              face = values;
          } else {
            const value = Number(tok[k++]);
            if (el.name === "vertex") xyz[p.name] = value;
          }
        }
        if (el.name === "vertex") positions.push(xyz.x, xyz.y, xyz.z);
        if (el.name === "face" && face) {
          for (let i = 1; i < face.length - 1; i++)
            faces.push(face[0], face[i], face[i + 1]);
        }
      }
  } else {
    const view = new DataView(buffer),
      little = format === "binary_little_endian";
    let off = headerEnd;
    const read = (type) => {
      const spec = PLY_SCALARS[type];
      if (!spec) throw Error(`Неподдерживаемый тип PLY: ${type}`);
      const [method, size] = spec;
      if (off + size > view.byteLength)
        throw Error("Бинарные данные PLY неожиданно закончились.");
      const value = view[method](off, little);
      off += size;
      return value;
    };
    for (const el of elements)
      for (let r = 0; r < el.count; r++) {
        let xyz = {},
          face = null;
        for (const p of el.props) {
          if (p.list) {
            const c = read(p.countType);
            if (!Number.isInteger(c) || c < 0 || c > 10000000)
              throw Error("Некорректная длина списка в PLY.");
            const values = new Array(c);
            for (let j = 0; j < c; j++) values[j] = read(p.itemType);
            if (
              el.name === "face" &&
              ["vertex_indices", "vertex_index"].includes(p.name)
            )
              face = values;
          } else {
            const value = read(p.type);
            if (el.name === "vertex") xyz[p.name] = value;
          }
        }
        if (el.name === "vertex") positions.push(xyz.x, xyz.y, xyz.z);
        if (el.name === "face" && face)
          for (let i = 1; i < face.length - 1; i++)
            faces.push(face[0], face[i], face[i + 1]);
      }
  }
  if (!positions.length) throw Error("В PLY не найдено точек или вершин.");
  if (!faces.length) {
    const pointMesh = {
      positions: new Float32Array(positions),
      indices: new Uint32Array(),
      name,
      pointCloud: true,
    };
    bounds(pointMesh);
    return pointMesh;
  }
  return clean({
    positions: new Float32Array(positions),
    indices: new Uint32Array(faces),
    name,
  });
}
export function parseOFF(text, name = "модель.off") {
  const tokens = text
    .replace(/#[^\n]*/g, " ")
    .trim()
    .split(/\s+/);
  if (!tokens.length || !["OFF", "COFF"].includes(tokens[0]))
    throw Error("Ожидается файл OFF или COFF.");
  let k = 1,
    nv,
    nf;
  if (tokens.length >= 4 && Number.isFinite(Number(tokens[1]))) {
    nv = Number(tokens[k++]);
    nf = Number(tokens[k++]);
    k++;
  } else {
    nv = Number(tokens[k++]);
    nf = Number(tokens[k++]);
    k++;
  }
  if (!Number.isInteger(nv) || !Number.isInteger(nf) || nv < 1 || nf < 0)
    throw Error("Некорректное число вершин или граней в OFF.");
  const positions = [];
  for (let i = 0; i < nv; i++) {
    if (k + 2 >= tokens.length)
      throw Error("В OFF неожиданно закончились вершины.");
    const xyz = tokens.slice(k, k + 3).map(Number);
    k += 3;
    if (!xyz.every(Number.isFinite))
      throw Error("В OFF найдена нечисловая вершина.");
    positions.push(...xyz);
    if (tokens[0] === "COFF") k += 4;
  }
  const faces = [];
  for (let i = 0; i < nf; i++) {
    const n = Number(tokens[k++]);
    if (!Number.isInteger(n) || n < 3 || k + n > tokens.length)
      throw Error("Некорректная грань в OFF.");
    const poly = tokens.slice(k, k + n).map(Number);
    k += n;
    for (const v of poly)
      if (!Number.isInteger(v) || v < 0 || v >= nv)
        throw Error("В OFF индекс грани выходит за пределы сетки.");
    for (let j = 1; j < n - 1; j++) faces.push(poly[0], poly[j], poly[j + 1]);
  }
  return clean({
    positions: new Float32Array(positions),
    indices: new Uint32Array(faces),
    name,
  });
}
function identity4() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function multiply4(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const t = node.translation || [0, 0, 0],
    s = node.scale || [1, 1, 1],
    q = node.rotation || [0, 0, 0, 1],
    [x, y, z, w] = q;
  return [
    (1 - 2 * y * y - 2 * z * z) * s[0],
    (2 * x * y + 2 * z * w) * s[0],
    (2 * x * z - 2 * y * w) * s[0],
    0,
    (2 * x * y - 2 * z * w) * s[1],
    (1 - 2 * x * x - 2 * z * z) * s[1],
    (2 * y * z + 2 * x * w) * s[1],
    0,
    (2 * x * z + 2 * y * w) * s[2],
    (2 * y * z - 2 * x * w) * s[2],
    (1 - 2 * x * x - 2 * y * y) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}
function transformPoint(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}
function dataUriBytes(uri) {
  const comma = uri.indexOf(",");
  if (comma < 0) throw Error("Повреждённый data URI в glTF.");
  const meta = uri.slice(0, comma),
    payload = uri.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const raw = atob(payload),
      b = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) b[i] = raw.charCodeAt(i);
    return b;
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}
export async function parseGLTF(
  jsonText,
  name = "модель.gltf",
  files = [],
  embeddedBin = null,
) {
  let doc;
  try {
    doc = JSON.parse(jsonText);
  } catch {
    throw Error("Файл glTF содержит некорректный JSON.");
  }
  if (doc.asset?.version?.split(".")[0] !== "2")
    throw Error("Поддерживается glTF 2.0.");
  const fileMap = new Map(files.map((f) => [f.name, f]));
  const buffers = [];
  for (let i = 0; i < (doc.buffers || []).length; i++) {
    const b = doc.buffers[i];
    let bytes;
    if (b.uri) {
      if (b.uri.startsWith("data:")) bytes = dataUriBytes(b.uri);
      else {
        const base = decodeURIComponent(
          b.uri.split(/[?#]/)[0].split("/").pop(),
        );
        const file = fileMap.get(base);
        if (!file)
          throw Error(
            `Не найден внешний файл ${base}. Выберите glTF и его бинарные файлы вместе.`,
          );
        bytes = new Uint8Array(await file.arrayBuffer());
      }
    } else if (i === 0 && embeddedBin) bytes = embeddedBin;
    else throw Error("В glTF отсутствуют данные геометрии.");
    if (b.byteLength && bytes.length < b.byteLength)
      throw Error("Данные буфера glTF короче ожидаемого размера.");
    buffers.push(bytes);
  }
  const component = {
      5120: ["getInt8", 1],
      5121: ["getUint8", 1],
      5122: ["getInt16", 2],
      5123: ["getUint16", 2],
      5125: ["getUint32", 4],
      5126: ["getFloat32", 4],
    },
    components = {
      SCALAR: 1,
      VEC2: 2,
      VEC3: 3,
      VEC4: 4,
      MAT2: 4,
      MAT3: 9,
      MAT4: 16,
    };
  function accessorData(id) {
    const a = doc.accessors?.[id];
    if (!a || a.sparse)
      throw Error(
        "Отсутствующий или sparse-accessor glTF пока не поддерживается.",
      );
    const v = doc.bufferViews?.[a.bufferView];
    if (!v) throw Error("В glTF отсутствует bufferView.");
    const c = component[a.componentType],
      cc = components[a.type];
    if (!c || !cc) throw Error("Тип accessor glTF не поддерживается.");
    const data = buffers[v.buffer];
    if (!data) throw Error("В glTF указан отсутствующий buffer.");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength),
      stride = v.byteStride || c[1] * cc,
      base = (v.byteOffset || 0) + (a.byteOffset || 0),
      out = new Array(a.count);
    for (let i = 0; i < a.count; i++) {
      const row = [];
      for (let j = 0; j < cc; j++) {
        const off = base + i * stride + j * c[1];
        if (off + c[1] > data.length)
          throw Error("Accessor glTF выходит за границы буфера.");
        row.push(view[c[0]](off, true));
      }
      out[i] = row;
    }
    return out;
  }
  const positions = [],
    indices = [];
  function appendMesh(meshIndex, world) {
    const m = doc.meshes?.[meshIndex];
    if (!m) throw Error("Узел glTF ссылается на отсутствующую сетку.");
    for (const prim of m.primitives || []) {
      if (prim.attributes?.POSITION === undefined) continue;
      const pts = accessorData(prim.attributes.POSITION);
      const offset = positions.length / 3;
      for (const v of pts)
        positions.push(...transformPoint(world, v[0], v[1], v[2]));
      let ix =
        prim.indices !== undefined
          ? accessorData(prim.indices).map((v) => v[0])
          : pts.map((_, i) => i);
      const mode = prim.mode ?? 4;
      if (mode === 4) {
        if (ix.length % 3) throw Error("Число индексов glTF не кратно трём.");
        for (const v of ix) indices.push(offset + v);
      } else if (mode === 5) {
        for (let i = 0; i + 2 < ix.length; i++)
          i % 2
            ? indices.push(
                offset + ix[i + 1],
                offset + ix[i],
                offset + ix[i + 2],
              )
            : indices.push(
                offset + ix[i],
                offset + ix[i + 1],
                offset + ix[i + 2],
              );
      } else if (mode === 6) {
        for (let i = 1; i + 1 < ix.length; i++)
          indices.push(offset + ix[0], offset + ix[i], offset + ix[i + 1]);
      } else
        throw Error(
          "В glTF найдены линии или точки; поддерживаются только поверхности из треугольников.",
        );
    }
  }
  const nodes = doc.nodes || [],
    scene = doc.scenes?.[doc.scene ?? 0],
    roots =
      scene?.nodes ||
      nodes
        .map((n, i) => i)
        .filter((i) => !nodes.some((n) => (n.children || []).includes(i)));
  const visited = new Set();
  function visit(i, parent) {
    const node = nodes[i];
    if (!node || visited.has(i)) return;
    visited.add(i);
    const world = multiply4(parent, nodeMatrix(node));
    if (node.mesh !== undefined) appendMesh(node.mesh, world);
    for (const ch of node.children || []) visit(ch, world);
  }
  if (roots.length) for (const i of roots) visit(i, identity4());
  else
    for (let i = 0; i < (doc.meshes || []).length; i++)
      appendMesh(i, identity4());
  if (!indices.length)
    throw Error("glTF не содержит поддерживаемых треугольных поверхностей.");
  return clean({
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    name,
  });
}
export function parseGLB(buffer, name = "модель.glb", files = []) {
  const view = new DataView(buffer);
  if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67)
    throw Error("Файл не является бинарным glTF (GLB).");
  if (view.getUint32(4, true) !== 2)
    throw Error("Поддерживается GLB версии 2.");
  const total = view.getUint32(8, true);
  if (total > view.byteLength) throw Error("Файл GLB обрезан.");
  let off = 12,
    json = "",
    bin = null;
  while (off + 8 <= total) {
    const length = view.getUint32(off, true),
      type = view.getUint32(off + 4, true);
    off += 8;
    if (off + length > total) throw Error("В GLB повреждён блок данных.");
    const chunk = new Uint8Array(buffer, off, length);
    if (type === 0x4e4f534a)
      json = new TextDecoder().decode(chunk).replace(/[\u0000\u0020]+$/g, "");
    else if (type === 0x004e4942) bin = chunk;
    off += length;
  }
  if (!json) throw Error("В GLB отсутствует JSON-блок.");
  return parseGLTF(json, name, files, bin);
}
export function exportPLY(mesh) {
  let s = `ply\nformat ascii 1.0\nelement vertex ${mesh.positions.length / 3}\nproperty float x\nproperty float y\nproperty float z\nelement face ${mesh.indices.length / 3}\nproperty list uchar uint vertex_indices\nend_header\n`;
  for (let i = 0; i < mesh.positions.length; i += 3)
    s += `${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}\n`;
  for (let i = 0; i < mesh.indices.length; i += 3)
    s += `3 ${mesh.indices[i]} ${mesh.indices[i + 1]} ${mesh.indices[i + 2]}\n`;
  return new Blob([s], { type: "application/octet-stream" });
}
