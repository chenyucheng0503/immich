'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { lookCode, mergeDescription, inScope, safePath, sidecarPath, Processor, Conflict, Skip,
  resolveLook, cameraFingerprint, captureInstant, validateProfiles, retryableCustomSkip } = require('./core.cjs');
const { prepare, renderXmp } = require('./prepare.cjs');
const { Store } = require('./store.cjs');
const { authenticate, scanQuery } = require('./service.cjs');
const id = '12345678-1234-4123-8123-123456789abc';
test('标准外观严格映射，数字槽位和未知值不直接推断为 ST', () => {
  const pairs = [['Standard','ST'],['Portrait','PT'],['Neutral','NT'],['Vivid','VV'],['Vivid 2','VV2'],
    ['FL','FL'],['IN','IN'],['SH','SH'],['B&W','BW'],['Sepia','SE']];
  for (const [name, code] of pairs) {
    assert.equal(lookCode(name), code);
    assert.equal(lookCode(' '+code.toLowerCase()+' '), code);
  }
  for (const value of [249,254,'Off','None','',undefined,'FL2']) {
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
test('无配置的自定义槽位跳过，无 API 写入',async(t)=>{
  const f=await fixture(t,{look:'Unknown (249)'});
  await assert.rejects(f.processor.process(f.job),Skip);
  assert.equal(f.writes,0);
});
const customTags = {
  'IFD0:Make': 'SONY', 'IFD0:Model': 'ILCE-7CM2',
  'Sony:InternalSerialNumber': 'test-body-a', 'Sony:CreativeStyle': 'Unknown (249)',
  'Sony:Copy1:CreativeStyle': 'Standard',
  'ExifIFD:DateTimeOriginal': '2026:10:30 21:09:47', 'ExifIFD:OffsetTimeOriginal': '+08:00',
};
const customProfile = {
  id: 'test-six-order', cameraHash: cameraFingerprint(customTags), from: '2026-10-28T13:49:43Z',
  slots: ['Astia','GR正片','GR负片','NN','CC','NC'],
};
test('六槽数字和 Unknown 字符串映射正确，忽略重复的 Standard', () => {
  validateProfiles([customProfile]);
  for (let n=249;n<=254;n++) for (const marker of [n,String(n),'Unknown ('+n+')']) {
    const result=resolveLook({...customTags,'Sony:CreativeStyle':marker},[customProfile]);
    assert.equal(result.code,customProfile.slots[n-249]);
    assert.equal(result.profileId,customProfile.id);
  }
});
test('六种完整名称和指定缩写均保留准确大小写、中文', () => {
  for (const [full,code] of [['Classic Neg.','NC'],['Classic Chrome','CC'],['Nostalgic Neg.','NN'],
    ['GR Negative Film','GR负片'],['GR Positive Film','GR正片'],['Astia','Astia']]) {
    assert.equal(lookCode(full),code);
    assert.equal(mergeDescription(code,code),code);
    assert.equal(resolveLook({'Sony:CreativeStyle':full}).code,code);
  }
  assert.equal(mergeDescription('旅途','GR负片'),'旅途\nGR负片');
});
test('不同机身、配置生效前、缺失时间或时区均不误用当前槽位', () => {
  for (const change of [
    {'Sony:InternalSerialNumber':'different-body'}, {'Sony:InternalSerialNumber':0},
    {'ExifIFD:DateTimeOriginal':'2026:10:27 22:00:00'},
    {'ExifIFD:DateTimeOriginal':undefined}, {'ExifIFD:OffsetTimeOriginal':undefined},
    {'ExifIFD:DateTimeOriginal':'2026:02:30 21:09:47'},
  ]) assert.throws(()=>resolveLook({...customTags,...change},[customProfile]),Skip);
});
test('按拍摄时间切换历史配置，重叠配置停止匹配', () => {
  const next={...customProfile,id:'next',from:'2026-11-01T00:00:00Z',slots:[...customProfile.slots].reverse()};
  const previous={...customProfile,until:next.from};
  assert.equal(resolveLook(customTags,[previous,next]).code,'Astia');
  const later={...customTags,'ExifIFD:DateTimeOriginal':'2026:11:01 08:00:00'};
  assert.equal(resolveLook(later,[previous,next]).code,'NC');
  assert.throws(()=>resolveLook(later,[customProfile,next]),Conflict);
});
test('毫秒和时区按相机元数据计算，配置拒绝拼错标签', () => {
  assert.equal(captureInstant({...customTags,'ExifIFD:SubSecTimeOriginal':'043'}),Date.parse('2026-10-30T13:09:47.043Z'));
  assert.throws(()=>validateProfiles([{...customProfile,slots:['ASTIA','GR正片','GR负片','NN','CC','NC']}]));
});
test('重试自订项不会重新处理普通未知值或人工冲突', () => {
  for (const reason of ['unknown_or_custom_look:Unknown (249)','unknown_or_custom_look:254','unknown_or_custom_look:Astia','custom_profile_not_found']) {
    assert.equal(retryableCustomSkip(reason),true);
  }
  for (const reason of ['unknown_or_custom_look:Off','unknown_or_custom_look:missing','different_camera','manual_description_change']) {
    assert.equal(retryableCustomSkip(reason),false);
  }
});
test('入库前新建独立旁车并保持原片字节，重复执行不覆盖',async(t)=>{
  const f=await fixture(t);
  const read=async(file)=>{
    if(file===f.file)return {...customTags,'Sony:CreativeStyle':'Unknown (254)'};
    const xml=await fs.readFile(file,'utf8');
    assert.ok(xml.includes('<tiff:ImageDescription>NC</tiff:ImageDescription>'));
    return {'XMP-dc:Description':'NC','XMP-tiff:ImageDescription':'NC'};
  };
  const opts={files:[f.file],roots:[f.root],profiles:[customProfile],read,auditDir:path.join(f.root,'audit')};
  const dry=await prepare(opts);
  assert.equal(dry.plans[0].code,'NC');
  await assert.rejects(fs.stat(f.file+'.xmp'),{code:'ENOENT'});
  const applied=await prepare({...opts,apply:true});
  assert.equal(applied.plans[0].originalUnchanged,true);
  const previous=await fs.readFile(f.file+'.xmp');
  const repeated=await prepare({...opts,apply:true});
  assert.equal(repeated.plans[0].status,'unchanged');
  assert.deepEqual(await fs.readFile(f.file+'.xmp'),previous);
  assert.equal(await fs.readFile(f.file,'utf8'),'original image bytes');
});
test('入库前整批预检失败不写入前面的文件',async(t)=>{
  const f=await fixture(t);
  await assert.rejects(prepare({files:[f.file,path.join(f.root,'missing.JPG')],roots:[f.root],profiles:[customProfile],
    read:async()=>customTags,auditDir:path.join(f.root,'audit'),apply:true}));
  await assert.rejects(fs.stat(f.file+'.xmp'),{code:'ENOENT'});
  const xml=renderXmp('中文 & <引用>\nGR负片');
  assert.ok(xml.includes('中文 &amp; &lt;引用&gt;\nGR负片'));
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
