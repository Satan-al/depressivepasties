import copy
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('migration',Path(__file__).parents[1]/'tools/migrate_accounts.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class IdentityMigrationTests(unittest.TestCase):
    def sample(self):
        return {
          'users': {
            'older':{'name':'Alex','createdAt':10,'lastSeen':30,'color':'#123456','emoji':'🦊','activity':{'2026-01-01':20},'settings':{'emojis':['🚀',None,{'type':'png','src':'data:image/png;base64,YQ=='}],'volume':.7}},
            'newer':{'name':'alex','createdAt':20,'lastSeen':40,'color':'#aabbcc','emoji':'🦄','activity':{'2026-01-01':10,'2026-01-02':40},'settings':{'emojis':{'0':'👍','1':'🐻'}}},
            'old-host':{'name':'Леха','createdAt':1,'emoji':'🐻'},
            'host_leha':{'name':'Лёха','createdAt':5},
            'unlisted':{'name':'Other','createdAt':1}},
          'telegram_links':{'older':{'siteUserId':'older','siteName':'Alex','siteColor':'#123456','tgUserId':42,'tgUsername':'kept','linkedAt':99}},
          'chat':{'push-id':{'uid':'newer','name':'Alex','text':'Keep the original message','t':50}},
          'music':{'queue':{'track':'unchanged'}},
          'points':{'newer':{'x':.1,'y':.2,'id':'newer','name':'alex'}},
          'presence':{'old-host':{'id':'old-host','name':'Леха','ts':40}}
        }
    def test_merge_keeps_bound_uid_activity_custom_slots(self):
        source=self.sample(); before=copy.deepcopy(source)
        out,accounts,report=m.build_plan(source,[{'name':'Alex'},{'name':'Лёха'}],now=100)
        alex=out['users']['older']
        self.assertEqual(alex['activity'],{'2026-01-01':20,'2026-01-02':40})
        self.assertEqual(alex['settings']['emojis'][:2],['🚀','🐻'])
        self.assertEqual(alex['settings']['emojis'][2]['type'],'png')
        self.assertEqual(alex['settings']['volume'],.7)
        self.assertEqual(alex['color'],'#aabbcc')
        self.assertEqual(alex['emoji'],'🦄')
        self.assertEqual(alex['createdAt'],10)
        self.assertEqual(source,before)
        self.assertNotIn('newer',out['users'])
        self.assertEqual(out['identity_aliases']['newer'],'older')
        self.assertEqual(out['chat'],before['chat'])
        self.assertEqual(out['music'],before['music'])
        self.assertEqual(out['telegram_links']['older']['tgUserId'],42)
        self.assertEqual(out['points']['older']['x'],.1)
        self.assertEqual(out['presence']['host_leha']['id'],'host_leha')
        self.assertEqual({a['name']:a['role'] for a in accounts},{'Alex':'member','Лёха':'host'})
    def test_repeat_is_idempotent_and_does_not_readmit_unknown_users(self):
        seeds=[{'name':'Alex'},{'name':'Лёха'}]
        first,accounts,_=m.build_plan(self.sample(),seeds,now=100)
        second,accounts2,_=m.build_plan(first,seeds,now=100)
        self.assertEqual(first,second)
        self.assertEqual(accounts,accounts2)
        self.assertNotIn('unlisted',[a['uid'] for a in accounts])
    def test_conflicting_telegram_users_stop_without_data_loss(self):
        source=self.sample()
        source['telegram_links']['newer']={'siteUserId':'newer','tgUserId':91}
        before=copy.deepcopy(source)
        with self.assertRaisesRegex(ValueError,'Multiple different Telegram'):
            m.build_plan(source,[{'name':'Alex'}])
        self.assertEqual(source,before)
    def test_reverse_telegram_schema_preserves_key_and_fields(self):
        source=self.sample();source['telegram_links']={'tg42':{'uid':'newer','tgUserId':42,'custom':'keep'}}
        out,_,_=m.build_plan(source,[{'name':'Alex'}],now=100)
        self.assertEqual(out['telegram_links']['tg42']['custom'],'keep')
        self.assertEqual(out['telegram_links']['tg42']['uid'],out['identity_aliases']['newer'])
    def test_alias_chains_and_names(self):
        source=self.sample();source['identity_aliases']={'first-id':'newer'}
        out,_,_=m.build_plan(source,[{'name':'Alex'}],now=100)
        self.assertEqual(out['identity_aliases']['first-id'],'older')
        self.assertEqual(m.login_email(' ЛЁХА '),m.login_email('Леха'))
        self.assertEqual(m.login_email('Alex'),m.login_email('alex'))
        self.assertNotEqual(m.encoded_password('Alex','0001'),m.encoded_password('Alex','1'))
        with self.assertRaises(ValueError):m.normalize_name('<script>')
    def test_new_account_uid_is_deterministic_and_distinct(self):
        first,accounts,_=m.build_plan({},[{'name':'Ally'},{'name':'D'}],now=100)
        second,again,_=m.build_plan(first,[{'name':'Ally'},{'name':'D'}],now=100)
        self.assertEqual(first,second)
        self.assertEqual(accounts,again)
        self.assertEqual(len({a['uid'] for a in accounts}),2)

if __name__=='__main__': unittest.main()
