"use strict";
/* Drakkenheim WM — interactive city map.
   Public site = VIEWER (player content + amethyst Haze fog of war).
   EDITOR = local-only, enabled with ?edit=1 (a local authoring mode, NOT access control).
   No raster: v1 draws zones/markers over a fixed empty world (no upload/cache pipeline).
   GM secret (gmText) is AES-GCM encrypted; the master password is entered at runtime ONLY,
   never stored in code / localStorage / IndexedDB. Public data/*.json holds only ciphertext for gmText.
   Polygon/marker coords are NORMALIZED 0..1 of the v1 world size. */

let   EDIT    = new URLSearchParams(location.search).get("edit") === "1";   // runtime: ?edit=1 OR "Мастер" unlock
const LS_WORK = "dk_work_v1";        // {zones,markers} — editor working copy (gmText stays ciphertext here)
// v1 legacy world (landscape master). Не сводить с IMG_W/IMG_H
// map-engine.js (книжная v2) — расхождение намеренное до Ф3.4/Ф3.6.
const V1_IMG_W = 5100, V1_IMG_H = 3300;

const STATUS_COLOR = {hidden:"#5a5566", known:"#5b76b8", scouted:"#c19036", explored:"#5fae74"};
// Haze density via mask luminance = haze alpha: hidden .92 / known .42 / scouted .15 / explored 0
const FOG_HEX      = {hidden:"#ebebeb", known:"#6b6b6b", scouted:"#262626", explored:"#000000"};
const MARKER_COLOR = {location:"#c9a85f", faction:"#5b76b8", danger:"#c5453f", secret:"#b06ae0", hub:"#5fae74"};
const STATUS_LABEL = {hidden:"Скрыто", known:"Слух", scouted:"Разведано", explored:"Открыто"};
const TYPE_LABEL   = {location:"Локация", faction:"Фракция", danger:"Опасность", secret:"Секрет", hub:"Хаб"};

let S = { meta:{imgW:V1_IMG_W, imgH:V1_IMG_H}, zones:[], markers:[] };
let view = {x:0, y:0, scale:1};
let sel = null;            // {kind:'zone'|'marker', id}
let drawing = null;        // {points:[[nx,ny]...], redraw?, id?}
let placingMarker = false;
let dragging = false, last = null, moved = false;

let gmKey=null, gmSalt=null;   // GM crypto: derived AES key + file salt — in-memory ONLY, never persisted
const gmPlain={};              // "z:"/"m:"+id -> decrypted gmText — in-memory ONLY, never serialized

const SVGNS = "http://www.w3.org/2000/svg";
const $ = s => document.querySelector(s);
const viewport=$("#viewport"), world=$("#world"), canvas=$("#canvas");
const worldBorder=$("#worldBorder"), zonesLayer=$("#zonesLayer"), markersLayer=$("#markersLayer");
const drawLayer=$("#drawLayer"), fogract=$("#fogract"), fogmask=$("#fogmask"), fogbase=$("#fogbase");
const fogmaskg=$("#fogmaskg"), hazeBlur=$("#hazeBlur");
const side=$("#side"), modePill=$("#modePill");

boot();

async function boot(){
  document.body.classList.toggle("edit", EDIT);
  modePill.textContent = EDIT ? "Режим автора · локально" : "Карта кампании";
  modePill.classList.toggle("gm", EDIT);
  await loadData();
  wireUI();
  applyImage();
  fitView();
  render();
}

/* ---------- data (committed JSON + editor working copy) ---------- */
async function loadData(){
  if(EDIT){
    const w = readJSON(localStorage.getItem(LS_WORK));
    if(w && Array.isArray(w.zones)){ S.zones = w.zones; S.markers = w.markers || []; return; }
  }
  const zones   = await fetchJSON("data/zones.json");
  const markers = await fetchJSON("data/markers.json");
  S.zones   = Array.isArray(zones)   ? zones   : [];
  S.markers = Array.isArray(markers) ? markers : [];
}
async function fetchJSON(url){
  try{ const r = await fetch(url, {cache:"no-store"}); return r.ok ? await r.json() : null; }
  catch(e){ return null; }   // file:// or missing -> empty shell
}
function readJSON(s){ try{ return JSON.parse(s); }catch(e){ return null; } }
function saveWork(){
  if(!EDIT) return;   // S.zones/markers keep gmText as ciphertext -> no plaintext secret ever hits localStorage
  try{ localStorage.setItem(LS_WORK, JSON.stringify({zones:S.zones, markers:S.markers})); }catch(e){}
}

/* ---------- GM-layer encryption (AES-GCM; key via PBKDF2; password & plaintext never persisted) ----------
   Shared file salt (one PBKDF2 per unlock), per-field random IV. gmText -> {enc,salt,iv,ct} (base64). */
const PBKDF2_ITERS = 600000;
const _enc=new TextEncoder(), _dec=new TextDecoder();
const isEnc = v => !!v && typeof v==="object" && v.enc===true;
function b64(buf){ let s=""; const a=new Uint8Array(buf); for(let i=0;i<a.length;i++) s+=String.fromCharCode(a[i]); return btoa(s); }
function unb64(str){ return Uint8Array.from(atob(str), c=>c.charCodeAt(0)); }
async function deriveKey(password, salt){
  const base=await crypto.subtle.importKey("raw", _enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2", salt, iterations:PBKDF2_ITERS, hash:"SHA-256"},
    base, {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"]);
}
async function aesEncrypt(key, salt, plaintext){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, _enc.encode(plaintext));
  return {enc:true, salt:b64(salt), iv:b64(iv), ct:b64(ct)};
}
async function aesDecrypt(key, obj){   // throws on wrong key (GCM auth fail) -> caller leaves data untouched
  const pt=await crypto.subtle.decrypt({name:"AES-GCM", iv:unb64(obj.iv)}, key, unb64(obj.ct));
  return _dec.decode(pt);
}
function encBlocks(){
  const out=[]; S.zones.forEach(z=>{ if(isEnc(z.gmText)) out.push(z.gmText); });
  S.markers.forEach(m=>{ if(isEnc(m.gmText)) out.push(m.gmText); }); return out;
}
async function unlockGM(password){
  if(!password) return false;
  const blocks=encBlocks();
  const salt = blocks.length ? unb64(blocks[0].salt) : crypto.getRandomValues(new Uint8Array(16));
  let key; try{ key=await deriveKey(password, salt); }catch(e){ return false; }
  const tmp={};
  try{   // decrypt every gmText up front: a wrong password fails the GCM auth tag here, before we commit anything
    for(const z of S.zones) tmp["z:"+z.id] = isEnc(z.gmText) ? await aesDecrypt(key, z.gmText) : (typeof z.gmText==="string"? z.gmText : "");
    for(const m of S.markers) tmp["m:"+m.id] = isEnc(m.gmText) ? await aesDecrypt(key, m.gmText) : (typeof m.gmText==="string"? m.gmText : "");
  }catch(e){ return false; }   // wrong password -> reject; S and gmPlain untouched
  gmKey=key; gmSalt=salt; Object.assign(gmPlain, tmp);
  return true;
}
function lockGM(){ gmKey=null; gmSalt=null; for(const k in gmPlain) delete gmPlain[k]; }

/* ---------- v1 world sizing (fixed; no raster) ---------- */
function applyImage(){
  const w=S.meta.imgW, h=S.meta.imgH;
  canvas.style.display="block";
  canvas.setAttribute("width", w); canvas.setAttribute("height", h);
  canvas.setAttribute("viewBox", `0 0 ${w} ${h}`);
  world.style.width=w+"px"; world.style.height=h+"px";
  fogract.setAttribute("width", w); fogract.setAttribute("height", h);
  fogbase.setAttribute("width", w); fogbase.setAttribute("height", h);
  worldBorder.setAttribute("width", w); worldBorder.setAttribute("height", h);
}

/* ---------- pan / zoom + coord helpers ---------- */
function applyView(){ world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.scale})`; }
function fitView(){
  const vw=viewport.clientWidth, vh=viewport.clientHeight, w=S.meta.imgW, h=S.meta.imgH;
  if(!w || !h) return;
  const s=Math.min(vw/w, vh/h)*0.96;
  view.scale=s; view.x=(vw-w*s)/2; view.y=(vh-h*s)/2; applyView();
}
function denorm(p){ return [p[0]*S.meta.imgW, p[1]*S.meta.imgH]; }
function ptsStr(poly){ return poly.map(p => (p[0]*S.meta.imgW).toFixed(1)+","+(p[1]*S.meta.imgH).toFixed(1)).join(" "); }
function centroidN(poly){ let x=0,y=0; poly.forEach(p=>{x+=p[0]; y+=p[1];}); return [x/poly.length, y/poly.length]; }
function screenToNorm(e){
  const rect=viewport.getBoundingClientRect();
  const ix=(e.clientX-rect.left-view.x)/view.scale;
  const iy=(e.clientY-rect.top -view.y)/view.scale;
  return [ix/S.meta.imgW, iy/S.meta.imgH];
}

viewport.addEventListener("mousedown", e=>{
  if(e.button!==0) return;
  if(EDIT && drawing){ drawing.points.push(screenToNorm(e)); renderDraw(); return; }
  if(EDIT && placingMarker){ placeMarkerAt(e); return; }
  dragging=true; moved=false; last=[e.clientX,e.clientY]; viewport.classList.add("grabbing");
});
window.addEventListener("mousemove", e=>{
  if(!dragging) return;
  const dx=e.clientX-last[0], dy=e.clientY-last[1];
  if(Math.abs(dx)+Math.abs(dy)>3) moved=true;
  view.x+=dx; view.y+=dy; last=[e.clientX,e.clientY]; applyView();
});
window.addEventListener("mouseup", ()=>{ dragging=false; viewport.classList.remove("grabbing"); });
viewport.addEventListener("wheel", e=>{
  e.preventDefault();
  const rect=viewport.getBoundingClientRect();
  const cx=e.clientX-rect.left, cy=e.clientY-rect.top;
  const ix=(cx-view.x)/view.scale, iy=(cy-view.y)/view.scale;
  const f=e.deltaY<0 ? 1.12 : 1/1.12;
  view.scale=Math.max(0.05, Math.min(8, view.scale*f));
  view.x=cx-ix*view.scale; view.y=cy-iy*view.scale; applyView();
}, {passive:false});
viewport.addEventListener("click", ()=>{ if(!moved && !EDIT) hidePop(); });

/* ---------- render ---------- */
function render(){
  applyImage();
  renderZones(); renderFog(); renderMarkers(); renderDraw();
  if(EDIT) renderSide();
}
function renderZones(){
  zonesLayer.innerHTML="";
  S.zones.forEach(z=>{
    if(!z.polygon || z.polygon.length<3) return;
    const revealed = z.status!=="hidden";
    if(!EDIT && !revealed) return;                 // viewer: hidden zones not drawn (fog covers them)
    const col = STATUS_COLOR[z.status]||STATUS_COLOR.hidden;
    const poly=document.createElementNS(SVGNS,"polygon");
    poly.setAttribute("points", ptsStr(z.polygon));
    poly.setAttribute("class", "zone"+(sel&&sel.kind==="zone"&&sel.id===z.id?" sel":""));
    poly.setAttribute("fill", col); poly.setAttribute("stroke", col);
    if(EDIT){
      poly.addEventListener("click", ev=>{ if(moved)return; ev.stopPropagation(); select("zone",z.id); });
    } else {
      poly.style.fillOpacity=0; poly.style.strokeOpacity=0;   // invisible wash; map shows through
      poly.setAttribute("pointer-events","all");              // ...but the district is clickable
      poly.addEventListener("click", ev=>{ if(moved)return; ev.stopPropagation(); showZonePop(z); });
    }
    zonesLayer.appendChild(poly);
    if(EDIT){
      const c=denorm(centroidN(z.polygon));
      const t=document.createElementNS(SVGNS,"text");
      t.setAttribute("x",c[0]); t.setAttribute("y",c[1]); t.setAttribute("class","zlabel");
      t.setAttribute("font-size", Math.max(11, S.meta.imgW/70)); t.textContent=z.name;
      zonesLayer.appendChild(t);
    }
  });
}
function renderFog(){
  // Viewer = themed amethyst Haze (4 densities by status); editor shows the full map (no Haze).
  const on = !EDIT;
  document.body.classList.toggle("haze-on", on);
  if(!on){ clearMaskZones(); return; }
  hazeBlur.setAttribute("stdDeviation", Math.max(3, S.meta.imgW/145).toFixed(1)); // feather scaled to image
  fogbase.setAttribute("fill", FOG_HEX.hidden);                                   // default = dense Haze
  // persistent per-zone mask polygons: update fill in place so CSS transitions the reveal
  const seen=new Set();
  S.zones.forEach(z=>{
    if(!z.polygon || z.polygon.length<3) return;
    seen.add(z.id);
    let p=fogmaskg.querySelector('polygon[data-zone="'+z.id+'"]');
    if(!p){ p=document.createElementNS(SVGNS,"polygon"); p.setAttribute("data-zone",z.id); p.setAttribute("class","hazezone"); fogmaskg.appendChild(p); }
    p.setAttribute("points", ptsStr(z.polygon));
    p.setAttribute("fill", FOG_HEX[z.status]||FOG_HEX.hidden);
  });
  fogmaskg.querySelectorAll('polygon[data-zone]').forEach(p=>{ if(!seen.has(p.getAttribute("data-zone"))) p.remove(); });
}
function clearMaskZones(){ fogmaskg.querySelectorAll('polygon[data-zone]').forEach(n=>n.remove()); }
function renderMarkers(){
  markersLayer.innerHTML="";
  const r=Math.max(5, S.meta.imgW/180);
  S.markers.forEach(m=>{
    if(!EDIT){
      if(m.status==="hidden") return;
      const zone=S.zones.find(z=>z.id===m.zone);
      if(zone && zone.status==="hidden") return;   // hide markers inside undiscovered zones
    }
    const [mx,my]=denorm([m.x, m.y]);
    const g=document.createElementNS(SVGNS,"g");
    g.setAttribute("class", "marker"+(sel&&sel.kind==="marker"&&sel.id===m.id?" sel":""));
    g.setAttribute("transform", `translate(${mx},${my})`);
    const halo=document.createElementNS(SVGNS,"circle"); halo.setAttribute("class","halo"); halo.setAttribute("r", r*1.5);
    const dot =document.createElementNS(SVGNS,"circle"); dot.setAttribute("class","dot"); dot.setAttribute("r", r);
    dot.setAttribute("fill", MARKER_COLOR[m.type]||MARKER_COLOR.location);
    g.appendChild(halo); g.appendChild(dot);
    const nm = EDIT ? (m.name||m.visibleName||"маркер") : (m.visibleName||"");
    if(nm){
      const t=document.createElementNS(SVGNS,"text"); t.setAttribute("class","mlabel"); t.setAttribute("y",-r*1.9);
      t.setAttribute("font-size", Math.max(10, S.meta.imgW/95)); t.textContent=nm;
      g.appendChild(t);
    }
    g.addEventListener("click", ev=>{ if(moved)return; ev.stopPropagation();
      if(EDIT) select("marker",m.id); else showMarkerPop(m); });
    markersLayer.appendChild(g);
  });
}
function renderDraw(){
  drawLayer.innerHTML="";
  if(!drawing) return;
  if(drawing.points.length>=2){
    const pl=document.createElementNS(SVGNS,"polygon");
    pl.setAttribute("points", ptsStr(drawing.points)); pl.setAttribute("class","drawline");
    drawLayer.appendChild(pl);
  }
  const r=Math.max(4, S.meta.imgW/200);
  drawing.points.forEach(p=>{
    const [cx,cy]=denorm(p);
    const c=document.createElementNS(SVGNS,"circle");
    c.setAttribute("cx",cx); c.setAttribute("cy",cy); c.setAttribute("r",r); c.setAttribute("class","drawpt");
    drawLayer.appendChild(c);
  });
}

/* ---------- player dossier popup (viewer; gmText is NEVER shown here) ---------- */
function showZonePop(z){ showPop(z.band?("Пояс "+z.band):"", z.name, z.playerText); }
function showMarkerPop(m){ showPop(TYPE_LABEL[m.type]||"", m.visibleName||"", m.playerText); }
function showPop(band, title, body){
  const b=$("#popBand"); b.textContent=band||""; b.style.display=band?"inline-block":"none";
  $("#popH").textContent=title||""; $("#popP").textContent=body||"";
  $("#pop").classList.add("show");
}
function hidePop(){ $("#pop").classList.remove("show"); }

/* ---------- editor: selection + side panel ---------- */
function select(kind,id){ sel={kind,id}; render(); }
function gmBar(){
  return gmKey
   ? `<div class="gmbar on">🔓 GM-слой расшифрован <button class="btn" id="gmLock">Запереть</button></div>`
   : `<div class="gmbar"><input type="password" id="gmPw" placeholder="Пароль мастера" autocomplete="off"><button class="btn gold" id="gmUnlock">Расшифровать GM</button></div>`;
}
function gmField(prefix, obj, idAttr){   // GM-only secret field: plaintext when unlocked, padlock otherwise
  if(gmKey) return `<label>Заметки автора (GM · шифруется)</label><textarea id="${idAttr}">${esc(gmPlain[prefix+obj.id]||"")}</textarea>`;
  const locked=isEnc(obj.gmText);
  return `<label>Заметки автора (GM)</label><div class="gmlock">${locked?"🔒 зашифровано — введите пароль мастера выше":"не зашифровано; введите пароль мастера, чтобы редактировать как GM"}</div>`;
}
function renderSide(){
  side.classList.remove("hidden");
  let html = `
    <div class="sec">
      <h3>Инструменты автора</h3>
      <div class="btnrow">
        <button class="btn gold" id="drawZoneBtn">${drawing?"Завершить зону (Enter)":"Рисовать зону"}</button>
        <button class="btn" id="addMarkerBtn">${placingMarker?"…клик по карте":"+ Маркер"}</button>
      </div>
      <p class="muted">Зона: «Рисовать зону» → клики по углам → «Завершить»/Enter. Маркер: «+ Маркер» → клик. Esc — отмена.</p>
      <div class="legend">
        <span><i style="background:${STATUS_COLOR.hidden}"></i>скрыто</span>
        <span><i style="background:${STATUS_COLOR.known}"></i>слух</span>
        <span><i style="background:${STATUS_COLOR.scouted}"></i>разведано</span>
        <span><i style="background:${STATUS_COLOR.explored}"></i>открыто</span>
      </div>
      <p class="muted">Зон: ${S.zones.length} · маркеров: ${S.markers.length}. Правки сохраняются локально; «Данные ▾» → экспорт для коммита.</p>
      ${gmBar()}
    </div>`;
  if(sel && sel.kind==="zone"){ const z=S.zones.find(x=>x.id===sel.id); if(z) html+=zoneEditor(z); }
  else if(sel && sel.kind==="marker"){ const m=S.markers.find(x=>x.id===sel.id); if(m) html+=markerEditor(m); }
  else html += `<div class="sec"><p class="muted">Выбери зону или маркер на карте, чтобы редактировать.</p></div>`;
  side.innerHTML=html;
  wireSide();
}
function statusButtons(obj){
  const cur=obj.status;
  const b=s=>`<button class="sb-${s} ${cur===s?'on':''}" data-status="${s}">${STATUS_LABEL[s]}</button>`;
  return `<div class="statusgrid">${b('hidden')}${b('known')}${b('scouted')}${b('explored')}</div>`;
}
function zoneEditor(z){
  return `<div class="sec">
    <h3>Зона <span class="pill-band">${esc(z.band||"—")}</span></h3>
    <label>Название</label><input type="text" id="z_name" value="${esc(z.name)}">
    <div class="row">
      <div><label>Пояс</label><input type="text" id="z_band" value="${esc(z.band||"")}"></div>
      <div><label>Владелец</label><input type="text" id="z_owner" value="${esc(z.owner||"")}"></div>
    </div>
    <label>Статус открытия</label>${statusButtons(z)}
    <label>Текст для игроков</label><textarea id="z_ptext">${esc(z.playerText||"")}</textarea>
    ${gmField("z:", z, "z_gtext")}
    <div class="btnrow">
      <button class="btn" id="z_redraw">Перерисовать контур</button>
      <button class="btn warn" id="z_del">Удалить</button>
    </div>
  </div>`;
}
function markerEditor(m){
  return `<div class="sec">
    <h3>Маркер</h3>
    <label>Внутреннее имя (автор)</label><input type="text" id="m_name" value="${esc(m.name||"")}">
    <label>Видно игрокам</label><input type="text" id="m_vname" value="${esc(m.visibleName||"")}">
    <div class="row">
      <div><label>Тип</label><select id="m_type">
        ${["location","faction","danger","secret","hub"].map(t=>`<option value="${t}" ${m.type===t?'selected':''}>${TYPE_LABEL[t]}</option>`).join("")}
      </select></div>
      <div><label>Зона</label><select id="m_zone">
        <option value="">—</option>
        ${S.zones.map(z=>`<option value="${z.id}" ${m.zone===z.id?'selected':''}>${esc(z.name)}</option>`).join("")}
      </select></div>
    </div>
    <label>Статус</label>${statusButtons(m)}
    <label>Текст для игроков</label><textarea id="m_ptext">${esc(m.playerText||"")}</textarea>
    ${gmField("m:", m, "m_gtext")}
    <div class="btnrow"><button class="btn warn" id="m_del">Удалить</button></div>
  </div>`;
}
function wireSide(){
  const db=$("#drawZoneBtn"); if(db) db.onclick=toggleDrawZone;
  const am=$("#addMarkerBtn"); if(am) am.onclick=()=>{ placingMarker=!placingMarker; viewport.classList.toggle("draw",placingMarker); render(); };
  const gu=$("#gmUnlock"); if(gu) gu.onclick=async ()=>{ const ok=await unlockGM(($("#gmPw")||{}).value||""); render(); toast(ok?"GM-слой расшифрован":"Неверный пароль мастера"); };
  const gl=$("#gmLock"); if(gl) gl.onclick=()=>{ lockGM(); render(); toast("GM-слой заперт"); };
  if(sel && sel.kind==="zone"){
    const z=S.zones.find(x=>x.id===sel.id); if(!z) return;
    bindInput("z_name", v=>z.name=v, true); bindInput("z_band", v=>z.band=v); bindInput("z_owner", v=>z.owner=v);
    bindInput("z_ptext", v=>z.playerText=v);
    if(gmKey) bindInput("z_gtext", v=>{ gmPlain["z:"+z.id]=v; });   // edit decrypted text in memory only
    bindStatus(z);
    $("#z_redraw").onclick=()=>{ drawing={points:[], redraw:true, id:z.id}; viewport.classList.add("draw"); render(); toast("Кликай углы, Enter — готово"); };
    $("#z_del").onclick=()=>{ if(!confirm("Удалить зону?"))return; S.zones=S.zones.filter(x=>x.id!==z.id); delete gmPlain["z:"+z.id]; sel=null; saveWork(); render(); toast("Зона удалена"); };
  }
  if(sel && sel.kind==="marker"){
    const m=S.markers.find(x=>x.id===sel.id); if(!m) return;
    bindInput("m_name", v=>m.name=v); bindInput("m_vname", v=>m.visibleName=v, true);
    bindInput("m_ptext", v=>m.playerText=v);
    if(gmKey) bindInput("m_gtext", v=>{ gmPlain["m:"+m.id]=v; });
    bindSelect("m_type", v=>{m.type=v; render();}); bindSelect("m_zone", v=>m.zone=v);
    bindStatus(m);
    $("#m_del").onclick=()=>{ if(!confirm("Удалить маркер?"))return; S.markers=S.markers.filter(x=>x.id!==m.id); delete gmPlain["m:"+m.id]; sel=null; saveWork(); render(); toast("Маркер удалён"); };
  }
}
function bindInput(id, fn, rerender){
  const el=$("#"+id); if(!el) return;
  el.addEventListener("input", ()=>{ fn(el.value); saveWork(); if(rerender){ renderZones(); renderMarkers(); } });
}
function bindSelect(id, fn){ const el=$("#"+id); if(!el) return; el.addEventListener("change", ()=>{ fn(el.value); saveWork(); }); }
function bindStatus(obj){
  side.querySelectorAll(".statusgrid button").forEach(b=>{ b.onclick=()=>{ obj.status=b.dataset.status; saveWork(); render(); }; });
}

/* ---------- editor: drawing zones / placing markers ---------- */
function toggleDrawZone(){ if(drawing){ finishZone(); return; } drawing={points:[]}; viewport.classList.add("draw"); render(); toast("Кликай углы, Enter — готово"); }
function finishZone(){
  const pts=drawing.points;
  if(pts.length<3){ cancelDraw(); toast("Нужно ≥3 точек"); return; }
  if(drawing.redraw){
    const z=S.zones.find(x=>x.id===drawing.id); if(z) z.polygon=pts;
    sel={kind:"zone", id:drawing.id};
  } else {
    const id="z"+Date.now();
    S.zones.push({id, name:"Новая зона", band:"", owner:"[TBD]", status:"hidden", playerText:"", gmText:"", polygon:pts});
    if(gmKey) gmPlain["z:"+id]="";   // new zone is editable as GM right away
    sel={kind:"zone", id};
  }
  drawing=null; viewport.classList.remove("draw"); saveWork(); render(); toast("Зона сохранена");
}
function placeMarkerAt(e){
  const [x,y]=screenToNorm(e);
  const zone=zoneAt(x,y);
  const id="m"+Date.now();
  const m={id, name:"", visibleName:"Новый маркер", type:"location",
           zone:zone?zone.id:"", status:"hidden", playerText:"", gmText:"", x, y};
  S.markers.push(m); if(gmKey) gmPlain["m:"+id]="";
  placingMarker=false; viewport.classList.remove("draw");
  sel={kind:"marker", id}; saveWork(); render();
}
function cancelDraw(){ drawing=null; placingMarker=false; viewport.classList.remove("draw"); render(); }
function zoneAt(x,y){ for(const z of S.zones){ if(z.polygon && z.polygon.length>=3 && pointInPoly(x,y,z.polygon)) return z; } return null; }
function pointInPoly(x,y,poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];
    if(((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}

/* ---------- export (re-encrypts gmText when unlocked; never writes plaintext) ---------- */
async function exportArr(which){
  const arr=which==="zones"?S.zones:S.markers, pfx=which==="zones"?"z:":"m:";
  const out=[];
  for(const it of arr){
    const o={...it}, key=pfx+it.id;
    if(gmKey && (key in gmPlain)) o.gmText=await aesEncrypt(gmKey, gmSalt, gmPlain[key]);   // re-encrypt current plaintext
    out.push(o);                                                                            // else keep gmText as loaded (ciphertext)
  }
  return out;
}
async function doExport(which){
  if(!gmKey && !confirm("GM-слой не расшифрован — gmText экспортируется как есть (зашифрованным). Чтобы менять секреты, введите пароль мастера. Продолжить?")) return;
  const out=await exportArr(which);
  const s=JSON.stringify(out,null,2).replace(/\[\s+(-?[\d.eE]+),\s+(-?[\d.eE]+)\s+\]/g, "[$1, $2]");
  download(which+".json", s);
  toast(which+".json экспортирован"+(gmKey?" · gmText зашифрован":""));
}

/* ---------- UI wiring ---------- */
function wireUI(){
  $("#fitBtn").addEventListener("click", fitView);
  $("#popX").addEventListener("click", hidePop);
  // master entry: visible "Мастер" button (viewer) + password modal — alternative to ?edit=1
  setMasterBtn();
  $("#masterBtn").addEventListener("click", ()=>{ if(EDIT) exitMaster(); else openMasterModal(); });
  $("#masterCancel").addEventListener("click", ()=>$("#masterModal").classList.remove("show"));
  $("#masterOk").addEventListener("click", tryMaster);
  $("#masterPw").addEventListener("keydown", e=>{ if(e.key==="Enter") tryMaster(); });
  if(EDIT) wireEditor();
  window.addEventListener("resize", ()=>{ /* keep current view */ });
}

/* ---------- master mode: visible button + password modal (alternative to ?edit=1) ---------- */
let editorWired=false;
function wireEditor(){   // attach EDIT-only handlers once (?edit=1 boot OR after master unlock)
  if(editorWired) return; editorWired=true;
  $("#menuBtn").addEventListener("click", ()=>$("#menuModal").classList.add("show"));
  $("#menuClose").addEventListener("click", ()=>$("#menuModal").classList.remove("show"));
  $("#exportZones").addEventListener("click", ()=>doExport("zones"));
  $("#exportMarkers").addEventListener("click", ()=>doExport("markers"));
  $("#resetWork").addEventListener("click", resetWork);
  window.addEventListener("keydown", e=>{
    if(e.key==="Enter" && drawing) finishZone();
    if(e.key==="Escape" && (drawing||placingMarker)) cancelDraw();
  });
}
function setMasterBtn(){ const b=$("#masterBtn"); if(b) b.textContent = EDIT ? "Выйти из мастера" : "Мастер"; }
function openMasterModal(){ $("#masterPw").value=""; $("#masterErr").textContent=""; $("#masterModal").classList.add("show"); $("#masterPw").focus(); }
async function tryMaster(){
  const ok = await unlockGM($("#masterPw").value);   // password verified against the encrypted gmText
  if(ok){ $("#masterModal").classList.remove("show"); enterMaster(); }
  else $("#masterErr").textContent="Неверный пароль мастера.";
}
function enterMaster(){
  EDIT=true; document.body.classList.add("edit");
  modePill.textContent="Режим автора · локально"; modePill.classList.add("gm");
  wireEditor(); setMasterBtn(); render();
  toast("Режим мастера — GM-слой расшифрован");
}
function exitMaster(){ lockGM(); location.href = location.pathname; }   // reload back to a clean viewer

async function resetWork(){
  try{ localStorage.removeItem(LS_WORK); }catch(e){}
  lockGM();
  const zones=await fetchJSON("data/zones.json"); const markers=await fetchJSON("data/markers.json");
  S.zones=Array.isArray(zones)?zones:[]; S.markers=Array.isArray(markers)?markers:[];
  sel=null; $("#menuModal").classList.remove("show"); render(); toast("Загружено из репозитория");
}

/* ---------- utils ---------- */
function esc(s){ return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function download(name, content){
  const b=new Blob([content], {type:"application/json"}); const u=URL.createObjectURL(b);
  const a=document.createElement("a"); a.href=u; a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(u), 1500);
}
let toastT=null;
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove("show"), 2200); }
