"""One-time identity migration. Preview is the default; writes require --apply.

No passwords or credentials belong in this repository. Initial hashes are supplied
separately; Firebase admin credentials stay on the operator's machine.
"""
from __future__ import annotations
import argparse
import base64
import copy
import hashlib
import json
import os
import re
import time
import unicodedata
from pathlib import Path

PROJECT_ID = 'dpgames-66d73'
DATABASE_URL = 'https://dpgames-66d73-default-rtdb.europe-west1.firebasedatabase.app'
SESSION = 'DepressivePasties'
SESSION_PATH = f'sessions/{SESSION}'
DEFAULT_EMOJIS = ['👍','👎','❤️','😂','😮','😢','🔥','🤡','🤬','🍷','🧐','💃','🚩','🤷‍♂️','🙄','💔','🤯','🔔']


def normalize_name(value):
    name = unicodedata.normalize('NFKC', str(value or '')).strip().lower().replace('ё', 'е')
    if not 1 <= len(name) <= 32 or not all(c.isalnum() or c in '_-' for c in name):
        raise ValueError('Invalid login name')
    return name


def legacy_name(value):
    value = unicodedata.normalize('NFKC', str(value or '')).lower().replace('ё','е')
    value = re.sub(r'\[(?:tg|тг)\]', '', value)
    return ''.join(c for c in value if c.isalnum())


def login_email(name):
    digest = hashlib.sha256(normalize_name(name).encode()).hexdigest()
    return f'{digest}@login.depressivepasties.invalid'


def encoded_password(name, password):
    """Same domain-separated protocol encoding as dp-auth.js, not password storage."""
    return hashlib.sha256(f'DepressivePasties:password:v1:{normalize_name(name)}:{password}'.encode()).hexdigest()


def merge_dict(older, newer):
    result = copy.deepcopy(older) if isinstance(older, dict) else {}
    for key, value in (newer or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_dict(result[key], value)
        elif value is not None:
            result[key] = copy.deepcopy(value)
    return result


def slots(value):
    if isinstance(value, list):
        return value[:36]
    if isinstance(value, dict):
        valid = {int(k): v for k, v in value.items() if str(k).isdigit() and 0 <= int(k) < 36}
        return [valid.get(i) for i in range(max(valid, default=-1) + 1)]
    return []


def stamp(data):
    return max(float(data.get('lastSeen') or 0), float(data.get('createdAt') or 0), float(data.get('updatedAt') or 0))


def merge_profiles(records, name, now):
    ordered = sorted(records, key=lambda item: (stamp(item[1]), item[0]))
    result = {}
    activity = {}
    emoji_slots = []
    conflicts = []
    for uid, profile in ordered:
        result = merge_dict(result, profile)
        for day, value in (profile.get('activity') or {}).items():
            old = activity.get(day)
            activity[day] = max(old, value) if isinstance(old,(float,int)) and isinstance(value,(float,int)) else (old if old is not None else value)
        for i, value in enumerate(slots((profile.get('settings') or {}).get('emojis'))):
            while len(emoji_slots) <= i:
                emoji_slots.append(None)
            old = emoji_slots[i]
            default = DEFAULT_EMOJIS[i] if i < len(DEFAULT_EMOJIS) else ''
            if old is not None and value is not None and old != value and old != default and value != default:
                conflicts.append({'slot': i, 'source': uid})
            # Keep a customized slot if another duplicate merely has the default.
            if value is not None and (old is None or value != default):
                emoji_slots[i] = copy.deepcopy(value)
    result.update(name=name, displayName=name, activity=activity, mergedAt=now)
    dates = [v.get('createdAt') for _,v in records if isinstance(v.get('createdAt'),(int,float)) and v['createdAt'] > 0]
    result['createdAt'] = min(dates) if dates else now
    result['lastSeen'] = max([v.get('lastSeen') or 0 for _,v in records] or [0])
    if not re.fullmatch(r'#[a-fA-F0-9]{6}', str(result.get('color',''))):
        result['color'] = '#1e40af' if legacy_name(name) == 'леха' else '#16c7b7'
    if 'emoji' not in result:
        result['emoji'] = '🐻' if legacy_name(name) == 'леха' else '🐶'
    if emoji_slots:
        result.setdefault('settings', {})['emojis'] = [v if v is not None else (DEFAULT_EMOJIS[i] if i<len(DEFAULT_EMOJIS) else '') for i,v in enumerate(emoji_slots)]
    return result, conflicts


def build_plan(session, seeds, now=None):
    """Pure function; preserves unknown fields and produces an idempotent UID map."""
    now = int(time.time()*1000) if now is None else now
    current = copy.deepcopy(session or {})
    users = current.setdefault('users', {})
    groups = {}
    for uid, profile in users.items():
        if not isinstance(profile,dict):
            continue
        key = legacy_name(profile.get('name') or profile.get('displayName'))
        if key:
            groups.setdefault(key, []).append((uid, profile))
    requested = {legacy_name(v['name']): v for v in seeds}
    if len(requested) != len(seeds):
        raise ValueError('Ambiguous initial names')
    links = current.get('telegram_links') or {}
    linked = {str(link.get('siteUserId') or link.get('uid') or key) for key,link in links.items() if isinstance(link,dict)}
    aliases = dict(current.get('identity_aliases') or {})
    accounts, report = [], []
    all_keys = sorted(set(groups) | set(requested))
    for key in all_keys:
        records = groups.get(key, [])
        seed = requested.get(key)
        if not seed and len(records)<2:
            continue
        name = seed['name'] if seed else max(records,key=lambda item:stamp(item[1]))[1].get('name')
        if key == 'леха' and seed:
            keep = 'host_leha'
        elif records:
            # Preserve a Telegram-bound identifier where possible, then the oldest profile.
            keep = min(records, key=lambda item:(item[0] not in linked, item[1].get('createdAt') or float('inf'), item[0]))[0]
        else:
            keep = 'dp_' + hashlib.sha256(normalize_name(name).encode()).hexdigest()[:24]
        # Never reuse a UID belonging to a different named account.
        if keep in users and legacy_name(users[keep].get('name')) != key:
            raise ValueError(f'UID collision for {name}')
        merged, conflicts = merge_profiles(records, name, now)
        for uid,_ in records:
            aliases[uid] = keep
            if uid != keep:
                users.pop(uid, None)
        aliases[keep] = keep
        users[keep] = merged
        if seed:
            accounts.append({'uid': keep, 'name':name, 'email':login_email(name), 'role':'host' if key=='леха' else 'member', 'seed':seed})
        report.append({'name':name,'keep':keep,'merged':len(records),'emoji_conflicts':conflicts})
    # Flatten previous aliases so already-merged links also resolve.
    for uid in list(aliases):
        seen=set(); target=aliases[uid]
        while target in aliases and aliases[target]!=target and target not in seen:
            seen.add(target); target=aliases[target]
        aliases[uid]=target
    current['identity_aliases']=aliases
    new_links={}
    for key, link in links.items():
        if not isinstance(link,dict):
            new_links[key]=link; continue
        value=copy.deepcopy(link)
        old=str(value.get('siteUserId') or value.get('uid') or key)
        target=aliases.get(old,old)
        new_key=aliases.get(key,key)
        for field in ('siteUserId','uid','userId'):
            if field in value and str(value[field]) in aliases:
                value[field]=aliases[str(value[field])]
        profile=users.get(target)
        if profile:
            if 'siteName' in value: value['siteName']=profile['name']
            if 'siteColor' in value: value['siteColor']=profile['color']
        if new_key in new_links and new_links[new_key]!=value:
            old_tg=str(new_links[new_key].get('tgUserId',''))
            new_tg=str(value.get('tgUserId',''))
            if old_tg != new_tg:
                raise ValueError('Multiple different Telegram accounts for '+users.get(target,{}).get('name',target)+'. Resolve before applying; nothing was discarded.')
            value=merge_dict(new_links[new_key],value)
        new_links[new_key]=value
    current['telegram_links']=new_links
    # Stale ephemeral rows only; active games block application below.
    for node in ('points','presence'):
        table=current.get(node)
        if not isinstance(table,dict): continue
        for old,target in aliases.items():
            if old==target or old not in table: continue
            source=table.pop(old)
            if target not in table: table[target]=source
        for uid,value in table.items():
            if uid in users and isinstance(value,dict):
                for field in ('name','color','emoji'):
                    if field in users[uid]: value[field]=users[uid][field]
                if 'id' in value: value['id']=uid
    # Keep chat IDs stable for bot delivery/replies; ownership resolves via identity_aliases.
    return current, accounts, report


def private_json(path, value):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w',encoding='utf-8') as out:
        json.dump(value,out,ensure_ascii=False,indent=2)


def validate_seed(seed):
    if seed.get('version')!=1 or seed.get('hash') != {'algorithm':'STANDARD_SCRYPT','memoryCost':32768,'parallelization':1,'blockSize':8,'derivedKeyLength':64}:
        raise ValueError('Unsupported bootstrap hash format')
    accounts=seed.get('accounts') or []
    if len(accounts)!=7 or len({normalize_name(a['name']) for a in accounts})!=7:
        raise ValueError('Expected the seven initial accounts')
    for record in accounts:
        if len(base64.b64decode(record['passwordHash'],validate=True))!=64 or len(base64.b64decode(record['passwordSalt'],validate=True))!=32:
            raise ValueError('Invalid import hash')
    return accounts


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--key', help='Local Firebase service-account JSON path; never committed')
    parser.add_argument('--seed',required=True,help='Private initial-account-hashes.json')
    parser.add_argument('--snapshot',help='Offline session JSON for a read-only preview')
    parser.add_argument('--apply',action='store_true',help='Back up, import accounts, merge profiles and enforce rules')
    parser.add_argument('--backup-dir',default='backups')
    args=parser.parse_args()
    seed=validate_seed(json.loads(Path(args.seed).read_text(encoding='utf-8')))
    if args.snapshot:
        if args.apply: parser.error('--snapshot is preview only')
        _,_,report=build_plan(json.loads(Path(args.snapshot).read_text(encoding='utf-8')),seed)
        print(json.dumps(report,ensure_ascii=False,indent=2)); return
    if not args.key: parser.error('--key is required for live access')
    key=json.loads(Path(args.key).read_text(encoding='utf-8'))
    if key.get('project_id')!=PROJECT_ID:
        raise SystemExit('Wrong Firebase project; stopped')
    try:
        import firebase_admin
        from firebase_admin import auth, credentials, db
    except ImportError:
        raise SystemExit('Install the host setup dependency: python -m pip install firebase-admin')
    from google.oauth2 import service_account
    from google.auth.transport.requests import AuthorizedSession
    # Restrict OAuth to this task's Firebase database and Authentication APIs.
    google_credential=service_account.Credentials.from_service_account_info(key,scopes=[
        'https://www.googleapis.com/auth/firebase.database',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/identitytoolkit',
        'https://www.googleapis.com/auth/firebase',
    ])
    class ScopedCredential(credentials.Base):
        def get_credential(self): return google_credential
    app=firebase_admin.initialize_app(ScopedCredential(),{'databaseURL':DATABASE_URL,'projectId':PROJECT_ID})
    client=AuthorizedSession(google_credential)
    session_ref=db.reference(SESSION_PATH,app=app)
    session=session_ref.get() or {}
    proposed,accounts,report=build_plan(session,seed)
    print(json.dumps(report,ensure_ascii=False,indent=2))
    existing_access=db.reference('/access',app=app).get() or {}
    rules=json.loads((Path(__file__).resolve().parent.parent/'database.rules.json').read_text())
    rules_url=DATABASE_URL+'/.settings/rules.json'
    response=client.get(rules_url,timeout=30)
    response.raise_for_status()
    old_rules=response.json()
    if existing_access and old_rules==rules and all(existing_access.get(a['uid'],{}).get('name')==a['name'] for a in accounts):
        print('Already migrated. Existing passwords and subsequently registered members were preserved.'); return
    if existing_access and args.apply:
        raise SystemExit('An access registry already exists. Stopped to avoid resetting accounts; inspect a previous partial migration first.')
    old_auth=[]
    # Read-only preflight: check email uniqueness before touching any auth user.
    for account in accounts:
        try:
            existing=auth.get_user_by_email(account['email'],app=app)
            if existing.uid!=account['uid']:
                raise SystemExit('An existing login conflicts with '+account['name']+'; stopped')
        except auth.UserNotFoundError:
            pass
        try:
            prior=auth.get_user(account['uid'],app=app)
            if prior.email or prior.provider_data:
                raise SystemExit('An existing non-anonymous login would be replaced for '+account['name']+'; stopped')
            old_auth.append({'uid':prior.uid,'disabled':prior.disabled,'displayName':prior.display_name,'customClaims':prior.custom_claims,'creationTimestamp':prior.user_metadata.creation_timestamp})
        except auth.UserNotFoundError:
            old_auth.append({'uid':account['uid'],'didNotExist':True})
    if not args.apply:
        print('PREVIEW ONLY. No data or accounts changed.'); return
    if (session.get('games') or {}).get('active',{}).get('state') not in (None,'ended','cancelled') or (session.get('duels') or {}).get('active',{}).get('state') not in (None,'ended','cancelled') or (session.get('game_v1') or {}).get('public',{}).get('active'):
        raise SystemExit('Finish the active game before migrating.')
    backup=Path(args.backup_dir)/time.strftime('%Y%m%d-%H%M%S')
    private_json(backup/'session.json',session)
    private_json(backup/'access.json',existing_access)
    private_json(backup/'database.rules.json',old_rules)
    private_json(backup/'auth-records.json',old_auth)
    # Back up only account metadata; all source profiles and every emoji variant are in session.json.
    private_json(backup/'plan.json',report)
    # Enable Firebase's password provider through its documented project configuration API.
    config_url=f'https://identitytoolkit.googleapis.com/admin/v2/projects/{PROJECT_ID}/config'
    old_config=client.get(config_url,timeout=30)
    old_config.raise_for_status()
    private_json(backup/'auth-config.json',old_config.json())
    config=client.patch(config_url,params={'updateMask':'signIn.email'},json={'signIn':{'email':{'enabled':True,'passwordRequired':True}}},timeout=30)
    config.raise_for_status()
    # Password hashes, not reversible credentials. Firebase rehashes on first successful sign-in.
    records=[auth.ImportUserRecord(uid=a['uid'],email=a['email'],display_name=a['name'],password_hash=base64.b64decode(a['seed']['passwordHash']),password_salt=base64.b64decode(a['seed']['passwordSalt']),disabled=False) for a in accounts]
    result=auth.import_users(records,hash_alg=auth.UserImportHash.standard_scrypt(memory_cost=32768,parallelization=1,block_size=8,derived_key_length=64),app=app)
    if result.failure_count:
        raise SystemExit('Account import incomplete. Backups are saved; admission/rules were not changed. See import errors by index: '+str([(e.index,e.reason) for e in result.errors]))
    for account in accounts: auth.revoke_refresh_tokens(account['uid'],app=app)
    expected={a['name']:a['uid'] for a in accounts}
    def migrate_latest(latest):
        merged,new_accounts,_=build_plan(latest or {},seed)
        if {a['name']:a['uid'] for a in new_accounts}!=expected:
            raise RuntimeError('Profiles changed during migration. Re-run preview before applying.')
        return merged
    session_ref.transaction(migrate_latest)
    # All admission rows are installed together. No anonymous UID or unknown profile is admitted.
    access={a['uid']:{'name':a['name'],'role':a['role'],'enabled':True,'version':1,'createdAt':int(time.time()*1000)} for a in accounts}
    db.reference('/access',app=app).set(access)
    # Rules last: the new users are ready before we close legacy anonymous access.
    response=client.put(rules_url,json=rules,timeout=30)
    response.raise_for_status()
    private_json(backup/'completed.json',{'accounts':[{'name':a['name'],'uid':a['uid']} for a in accounts],'completedAt':int(time.time()*1000)})
    print('Migration complete. Install the matching frontend and updated overlay together.')


if __name__=='__main__':
    main()
