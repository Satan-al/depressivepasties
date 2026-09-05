// Pure module tests, with Firebase I/O replaced by explicit fakes. No browser or live credentials.
const {SourceTextModule,SyntheticModule,createContext}=require('node:vm');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');

(async()=>{
  const calls=[];
  let failAdmission=false;
  const fake={
    initializeApp:(options,name)=>{calls.push(['app',name]);return {options,name};},
    deleteApp:async()=>{calls.push(['deleteApp']);},
    getAuth:()=>({secondary:true}),
    setPersistence:async()=>{calls.push(['memoryPersistence']);},
    inMemoryPersistence:{},
    createUserWithEmailAndPassword:async(auth,email,password)=>{
      assert.equal(password.length,64); assert.ok(auth.secondary);
      calls.push(['createUser']); return {user:{uid:'new-member'}};
    },
    deleteUser:async()=>{calls.push(['rollbackUser']);},
    ref:(db,location)=>({db,location}),
    update:async(ref,patch)=>{calls.push(['admit',patch]);if(failAdmission)throw Object.assign(new Error(),{code:'permission-denied'});},
    serverTimestamp:()=>123
  };
  const context=createContext({crypto:webcrypto,TextEncoder,console});
  const module=new SourceTextModule(readFileSync(path.join(__dirname,'../dp-auth.js'),'utf8'),{context});
  await module.link(async()=>new SyntheticModule(Object.keys(fake),function(){for(const [key,value] of Object.entries(fake))this.setExport(key,value);},{context}));
  await module.evaluate();
  const f=module.namespace;
  const a=await f.loginCredentials(' ЛЁХА ','0001'),b=await f.loginCredentials('леха','0001');
  assert.deepEqual({...a},{...b});
  assert.notEqual(a.password,(await f.loginCredentials('Лёха','0002')).password);
  assert.notEqual(a.password,(await f.loginCredentials('Alex','0001')).password);
  await assert.rejects(f.loginCredentials('<img>','1234'));
  await assert.rejects(f.loginCredentials('Alex','123'));
  assert.equal(f.safeColor('red" onload="'),'#16c7b7');
  assert.equal(f.safeImageSource('javascript:alert(1)'), '');
  assert.equal(f.safeImageSource('data:image/svg+xml,<svg onload=x>'), '');
  assert.equal(f.safeImageSource('data:image/png;base64,YQ=='),'data:image/png;base64,YQ==');
  const primary={currentUser:{uid:'host'}};
  const params={app:{options:{projectId:'demo-depressivepasties'}},db:{},auth:primary,account:{uid:'host',enabled:true,role:'host'},name:'Ally',password:'1234'};
  await assert.rejects(f.registerMember({...params,account:{uid:'host',enabled:true,role:'member'}}));
  assert.equal(calls.length,0);
  assert.equal(await f.registerMember(params),'Ally');
  assert.equal(primary.currentUser.uid,'host');
  const admission=calls.find(c=>c[0]==='admit')[1];
  assert.equal(admission['access/new-member'].role,'member');
  assert.equal(admission['sessions/DepressivePasties/users/new-member'].name,'Ally');
  assert.ok(!JSON.stringify(admission).includes('password'));
  assert.equal(calls.filter(c=>c[0]==='rollbackUser').length,0);
  failAdmission=true;
  await assert.rejects(f.registerMember(params));
  assert.equal(calls.filter(c=>c[0]==='rollbackUser').length,1);
  assert.equal(calls.filter(c=>c[0]==='deleteApp').length,2);
  console.log('Auth: normalization, credentials, registration permissions, atomic admission, session preservation, rollback and safe values passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
