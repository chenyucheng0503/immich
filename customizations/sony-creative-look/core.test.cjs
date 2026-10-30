'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { lookCode, mergeDescription, inScope, safePath, sidecarPath, Processor, Conflict, Skip } = require('./core.cjs');
const { Store } = require('./store.cjs');
const { authenticate, scanQuery } = require('./service.cjs');
const id = '12345678-1234-4123-8123-123456789abc';
test('标准外观严格映射，六个新外观、未知值不推断为 ST', () => {
  const pairs = [['Standard','ST'],['Portrait','PT'],['Neutral','NT'],['Vivid','VV'],['Vivid 2','VV2'],
    ['FL','FL'],['IN','IN'],['SH','SH'],['B&W','BW'],['Sepia','SE']];
  for (const [name, code] of pairs) {
    assert.equal(lookCode(name), code);
    assert.equal(lookCode(' '+code.toLowerCase()+' '), code);
  }
  for (const value of [249,254,'Off','None','',undefined,'Classic Neg.','Classic Chrome','Nostalgic Neg.','Astia','GR Positive Film','GR Negative Film','FL2']) {
    assert.equal(lookCode(value), null);
  }
});
test('描述保留人工文字、转换旧全称、重复事件不重复追加', () => {
  assert.equal(mergeDescription('', 'PT'), 'PT');
  assert.equal(mergeDescription('Portrait', 'PT'), 'PT');
  assert.equal(mergeDescription('京都旅行', 'PT'), '京都旅行\nPT');
  assert.equal(mergeDescription('京都旅行\nPT', 'PT'), '京都旅行\nPT');
  assert.throws(() => mergeDescription('FL', 'PT'), Conflict);
  assert.throws(() => mergeDescription('京都\nFL', 'PT'), Conflict);
});
test('回填按拍摄本地日期边界，自动补漏按入库时间', () => {
  const scope = {kind:'backfill',from:'2026-10-22',to:'2026-10-31'};
  assert.equal(inScope({localDateTime:'2026-10-22T00:00:00.000Z'},scope),true);
  assert.equal(inScope({localDateTime:'2026-10-31T00:00:00.000Z'},scope),false);
  assert.equal(inScope({localDateTime:'2026-10-21T23:59:59.000Z'},scope),false);
  assert.equal(inScope({createdAt:'2026-10-30T05:00:00Z'}, {kind:'auto',from:'2026-10-30T04:00:00Z'}),true);
  const query=scanQuery({spec:{kind:'auto',from:'2026-10-30T04:00:00Z',to:'2026-10-30T05:00:00Z'}});
  assert.equal(query.filter.model,undefined);
  assert.ok(query.filter.createdAt);
});
test('Webhook 鉴权拒绝错误或缺失密钥', () => {
  assert.equal(authenticate('abc', 'abc'),true);
  assert.equal(authenticate('abd', 'abc'),false);
  assert.equal(authenticate(undefined, 'abc'),false);
});
async function fixture(t, options = {}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sony-look-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'DSC001.JPG');
  await fs.writeFile(file,'original image bytes');
  const asset={id,ownerId:'owner',type:'IMAGE',hasMetadata:true,originalPath:file,checksum:'original-checksum',
    localDateTime:'2026-10-22T12:00:00Z',createdAt:'2026-10-30T00:00:00Z',
    exifInfo:{model:'ILCE-7CM2',description:options.description??''}};
  let writes=0, saved=null;
  const read=async(name)=>{
    if(name===file)return {'IFD0:Make':'SONY','IFD0:Model':'ILCE-7CM2','Sony:CreativeStyle':options.look??'Portrait'};
    const text=await fs.readFile(name,'utf8');
    return {'XMP-dc:Description':text,'XMP-tiff:ImageDescription':text};
  };
  const api=async(method,route,body)=>{
    if(method==='GET')return structuredClone(asset);
    writes++;
    asset.exifInfo.description=body.description;
    if(!options.failXmp)await fs.writeFile(file+'.xmp',body.description);
    if(options.timeout)throw new Error('request_timeout');
  };
  const processor=new Processor({api,roots:[root],read,saveIntent:async(_,value)=>{saved=value;},delays:[0]});
  return {root,file,asset,processor,read,job:{id,scope:{kind:'explicit'}},get saved(){return saved;},get writes(){return writes;}};
}
test('真实处理流程：API 与磁盘均一致才完成，原片不改',async(t)=>{
  const f=await fixture(t,{description:'京都'});
  const result=await f.processor.process(f.job);
  assert.equal(result.target,'京都\nPT');
  assert.equal(f.writes,1);
  assert.equal(await fs.readFile(f.file,'utf8'),'original image bytes');
  assert.equal(f.saved.old,'京都');
  assert.equal(f.saved.previousXmp,null);
});
test('API 成功但磁盘写入失败不误报完成',async(t)=>{
  const f=await fixture(t,{failXmp:true});
  await assert.rejects(f.processor.process(f.job),/xmp_write_not_verified/);
  assert.equal(f.saved.target,'PT');
});
test('API 超时但已成功：重启重试回读并跳过重复写入',async(t)=>{
  const f=await fixture(t,{timeout:true});
  await assert.rejects(f.processor.process(f.job),/request_timeout/);
  await f.processor.process({...f.job,intent:f.saved});
  assert.equal(f.writes,1);
});
test('崩溃后检测人工描述变化，停止覆盖',async(t)=>{
  const f=await fixture(t,{failXmp:true});
  await assert.rejects(f.processor.process(f.job));
  f.asset.exifInfo.description='用户已修改';
  await assert.rejects(f.processor.process({...f.job,intent:f.saved}),/manual_description_change/);
  assert.equal(f.writes,1);
});
test('原片被替换，不能重用上次的写入意图',async(t)=>{
  const f=await fixture(t,{failXmp:true});
  await assert.rejects(f.processor.process(f.job));
  await fs.writeFile(f.file,'replacement');
  await assert.rejects(f.processor.process({...f.job,intent:f.saved}),/original_changed/);
});
test('未知或新增自定义外观跳过，无 API 写入',async(t)=>{
  const f=await fixture(t,{look:'Astia'});
  await assert.rejects(f.processor.process(f.job),Skip);
  assert.equal(f.writes,0);
});
test('旁车已存在且一致时不再写入',async(t)=>{
  const f=await fixture(t,{description:'PT'});
  await fs.writeFile(f.file+'.xmp','PT');
  await f.processor.process(f.job);
  assert.equal(f.writes,0);
});
test('RAW/JPEG 共享旁车、符号链接均不自动修改',async(t)=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.root,'DSC001.ARW'),'raw');
  await fs.writeFile(path.join(f.root,'DSC001.xmp'),'');
  await assert.rejects(sidecarPath(f.file),/shared_raw_jpeg_sidecar/);
  await fs.symlink(f.file,path.join(f.root,'link.JPG'));
  await assert.rejects(safePath(path.join(f.root,'link.JPG'),[f.root]),/symlink_path/);
});
test('多语言 XMP 保留并转冲突',async(t)=>{
  const f=await fixture(t);
  await fs.writeFile(f.file+'.xmp','<rdf:li xml:lang="fr">bonjour</rdf:li>');
  await assert.rejects(f.processor.process(f.job),/multilingual_sidecar/);
  assert.equal(f.writes,0);
});
test('持久化任务、分页游标和崩溃恢复保持幂等',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sony-store-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.sqlite');
  let store=new Store(file);
  store.addScan('batch',{kind:'backfill',from:'2026-10-22',to:'2026-10-31'});
  store.page(store.nextScan(),[{id}],'page-2');
  store.enqueue(id,{kind:'explicit'});
  const job=store.next();store.saveIntent(id,{target:'PT'});
  store.close();
  store=new Store(file);
  assert.equal(store.nextScan().cursor,'page-2');
  const restored=store.next();
  assert.deepEqual(restored.intent,{target:'PT'});
  assert.equal(restored.attempts,2);
  store.finish(restored,'done');
  store.enqueue(id,{kind:'explicit'});
  assert.equal(store.next(),null);
  assert.equal(store.status('batch').counts[0].count,1);
  store.close();
});
