# Closed-room migration

This release changes the room from anonymous entry to Firebase password accounts.
Deploy the frontend, database rules and account migration in one maintenance window.

## Before deployment

1. Finish any active duel or game and stop starting new ones.
2. Keep the Firebase service-account JSON and the generated account-hash seed outside the repository.
3. Install the migration dependency in a local virtual environment:

   ```bash
   python -m pip install firebase-admin
   ```

4. Run a live preview. It reads the current session and prints the proposed profile merges without changing data:

   ```bash
   python tools/migrate_accounts.py --key /private/service-account.json --seed /private/initial-account-hashes.json
   ```

Check every reported account and any emoji conflict. A conflicting Telegram binding stops the migration instead of discarding either binding.

## Apply

Publish the matching frontend and run the migration close together:

```bash
python tools/migrate_accounts.py --key /private/service-account.json --seed /private/initial-account-hashes.json --apply --backup-dir /private/dp-backups
```

The command creates private backups before the first write, enables Firebase email/password sign-in, imports the initial account hashes, merges duplicate profiles, preserves identity aliases for old chat ownership, moves Telegram bindings, installs the allowlist and applies `database.rules.json` last.

The updated host overlay opens the same website in a dedicated sign-in window once and keeps the Firebase session in its persistent Qt profile. The Python source contains no password.

## Checks after deployment

- A listed account can sign in with its name and password.
- An unknown name and an old anonymous browser session cannot enter.
- The host can create a member with `/reg Ally 7878`; the command never appears in chat.
- Existing colors, emoji slots, Telegram links, chat history, games and quiz data remain available.
- Only the host account can register members or change the VDO.Ninja view ID.

Backups contain private room data and must stay outside the repository.
