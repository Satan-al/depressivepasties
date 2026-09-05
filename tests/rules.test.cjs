// Run with FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000 and local test dependencies.
const {createMockUserToken}=require('@firebase/util');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');

(async()=>{
  const project='demo-depressivepasties';
  const namespace=project+'-default-rtdb';
  // REST avoids WebSocket proxy settings on CI. Requests still run through the real rules emulator.
  function database(token){
    return {ref:(location='')=>{
      const url=new URL('http://127.0.0.1:9000/'+location.replace(/^\//,'')+'.json');
      url.searchParams.set('ns',namespace);
      if(token && token!=='owner') url.searchParams.set('auth',token);
      async function request(method,data){
        const response=await fetch(url,{method,headers:{'Content-Type':'application/json',...(token==='owner'?{Authorization:'Bearer owner'}:{})},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(10000)});
        const value=await response.json();
        if(!response.ok) throw Object.assign(new Error(value.error||String(value)),{status:response.status});
        return {val:()=>value};
      }
      return {set:data=>request('PUT',data),update:data=>request('PATCH',data),remove:()=>request('DELETE'),once:()=>request('GET')};
    }};
  }
  const env={
    authenticatedContext:(uid,claims)=>({database:()=>database(createMockUserToken({sub:uid,iat:Math.floor(Date.now()/1000),...claims},project))}),
    unauthenticatedContext:()=>({database:()=>database(null)}),
    withSecurityRulesDisabled:fn=>fn({database:()=>database('owner')}),
    cleanup:async()=>{}
  };
  const assertSucceeds=p=>p;
  async function assertFails(p){
    try{await p;}catch(e){if([401,403].includes(e.status))return;throw e;}
    throw new Error('Expected permission denial');
  }
  await database('owner').ref('.settings/rules').set(JSON.parse(readFileSync(path.join(__dirname,'../database.rules.json'),'utf8')));
  const session='sessions/DepressivePasties';
  const claims={firebase:{sign_in_provider:'password'}};
  const alice=env.authenticatedContext('alice',claims).database();
  const bob=env.authenticatedContext('bob',claims).database();
  const host=env.authenticatedContext('host_leha',claims).database();
  const outsider=env.authenticatedContext('intruder',claims).database();
  const anonymous=env.authenticatedContext('alice',{firebase:{sign_in_provider:'anonymous'}}).database();
  let checks=0;
  async function test(name,fn){await fn();checks++;console.log('PASS',name);}
  try {
    await env.withSecurityRulesDisabled(async ctx=>{
      await ctx.database().ref().set({access:{alice:{name:'Alice',role:'member',enabled:true,version:1},bob:{name:'Bob',role:'member',enabled:true,version:1},host_leha:{name:'Лёха',role:'host',enabled:true,version:1}},sessions:{DepressivePasties:{users:{alice:{name:'Alice'},bob:{name:'Bob'}},identity_aliases:{old_alice:'alice'},chat:{old:{uid:'old_alice',name:'Alice',text:'old message',t:1},telegram:{uid:'alice',name:'Alice',text:'bot schema',t:2,source:'telegram'}},telegram_links:{alice:{siteUserId:'alice',tgUserId:42,siteName:'Alice'}},games:{active:{type:'durak',state:'lobby'}}}}});
    });
    await test('signed-out cannot read chat',()=>assertFails(env.unauthenticatedContext().database().ref(`${session}/chat`).once('value')));
    await test('legacy anonymous token cannot reuse approved UID',()=>assertFails(anonymous.ref(`${session}/points`).once('value')));
    await test('unlisted password account cannot access room',()=>assertFails(outsider.ref(`${session}/chat`).once('value')));
    await test('member can write own profile',()=>assertSucceeds(alice.ref(`${session}/users/alice`).update({color:'#aabbcc',emoji:'🦄'})));
    await test('member cannot rename itself to host',()=>assertFails(alice.ref(`${session}/users/alice/name`).set('Лёха')));
    await test('member cannot edit another profile',()=>assertFails(alice.ref(`${session}/users/bob/color`).set('#abcdef')));
    await test('member cannot approve a new login',()=>assertFails(alice.ref('access/intruder').set({name:'Intruder',role:'member',enabled:true,version:1,createdAt:1})));
    await test('host can atomically register member and profile',()=>assertSucceeds(host.ref().update({'access/ally':{name:'Ally',role:'member',enabled:true,version:1,createdAt:1},[`${session}/users/ally`]:{name:'Ally',color:'#16c7b7',emoji:'🐶',createdAt:1}})));
    await test('host registration cannot grant another host role',()=>assertFails(host.ref('access/fake_host').set({name:'Fake',role:'host',enabled:true,version:1,createdAt:1})));
    await test('registered member can send chat',()=>assertSucceeds(alice.ref(`${session}/chat/new`).set({uid:'alice',name:'Alice',text:'hello',t:Date.now(),color:'#abcdef'})));
    await test('member cannot forge another chat sender',()=>assertFails(alice.ref(`${session}/chat/forged`).set({uid:'bob',name:'Bob',text:'no',t:Date.now()})));
    await test('merged alias retains ownership of old messages',()=>assertSucceeds(alice.ref(`${session}/chat/old/text`).set('edited')));
    await test('different member cannot edit that message',()=>assertFails(bob.ref(`${session}/chat/old/text`).set('forged')));
    await test('bot messages and TG link schema remain readable',async()=>{
      assert.equal((await alice.ref(`${session}/chat/telegram/source`).once('value')).val(),'telegram');
      assert.equal((await alice.ref(`${session}/telegram_links/alice/tgUserId`).once('value')).val(),42);
    });
    await test('member cannot rewrite Telegram binding',()=>assertFails(alice.ref(`${session}/telegram_links/bob`).set({siteUserId:'bob',tgUserId:42})));
    await test('own unlink remains available',()=>assertSucceeds(alice.ref(`${session}/telegram_links/alice`).remove()));
    await test('link code uses unchanged bot payload',()=>assertSucceeds(alice.ref(`${session}/link_codes/LINK-TEST`).set({userId:'alice',name:'Alice',color:'#abcdef',createdAt:Date.now(),expiresAt:Date.now()+300000,used:false})));
    await test('link codes cannot be enumerated by another member',()=>assertFails(bob.ref(`${session}/link_codes`).once('value')));
    await test('games and quiz state remain writable to members',async()=>{
      for (const node of ['games/active','duels/active','game_v1/public','quote_game/movie_quotes','music/votes/alice']) await assertSucceeds(alice.ref(`${session}/${node}`).update({test:1}));
    });
    await test('only host changes video source',async()=>{
      await assertFails(alice.ref(`${session}/vdo/viewId`).set('example'));
      await assertSucceeds(host.ref(`${session}/vdo/viewId`).set('example'));
    });
    await test('custom PNG emoji schema accepted; injected URL denied',async()=>{
      await assertSucceeds(alice.ref(`${session}/users/alice/settings/emojis/1`).set({type:'png',src:'data:image/png;base64,YQ=='}));
      await assertFails(alice.ref(`${session}/users/alice/settings/emojis/1`).set({type:'png',src:'x" onerror="alert(1)'}));
    });
    await test('disabled admission removes access immediately',async()=>{
      await env.withSecurityRulesDisabled(ctx=>ctx.database().ref('access/alice/enabled').set(false));
      await assertFails(alice.ref(`${session}/chat`).once('value'));
    });
    console.log(`${checks} rules checks passed`);
  } finally { await env.cleanup(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
