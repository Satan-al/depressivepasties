# Messenger frontend

The private-messages icon is installed in index.html after room authentication. Each conversation can also be opened in a draggable window. The same UI and authentication are available at /messenger/.

The server is the companion change in Satan-al/dp-telegram-bot. Deploy and configure that service before releasing this frontend. Its MESSENGER_DEPLOYMENT.md describes the required encryption secret, Storage bucket, operator Telegram binding and live acceptance tests.

A new room automatically requests Telegram setup. Its composer remains disabled with "Создание беседы" until the operator has created the Telegram group and left it. The first message is a persistent bot invitation. Joining Telegram is optional for participants.

Private messages do not use sessions/DepressivePasties/chat, RAT archives or the quote-game dataset. Firebase clients have no access to the messenger namespace; the API checks Firebase password identity and per-room membership.

Test:
  node --experimental-vm-modules tests/auth.test.cjs
  node tests/messenger.browser.cjs

Browser tests require Playwright/Chromium and use HTTP fixtures, not real accounts. Lucide icon assets are distributed with their original license in messenger/icons/LICENSE.

No encryption keys, bot tokens or account passwords belong in this frontend.
