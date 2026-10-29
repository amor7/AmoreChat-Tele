// One-time login of the spare Telegram account the Tele e2e test uses (real Telegram).
// Run 1 (no code): sends the login code to the account. Run 2 (TG_TEST_CODE): finishes the login.
// Once logged in it makes sure the account has a private chat with the test bot (/start) and a
// group with it, and writes their ids to meta.json. The session directory is kept (encrypted) by
// the tele-login workflow and used by every later test run, so the account logs in only once.
// Env: TELEGRAM_API_ID, TELEGRAM_API_HASH, TG_TEST_PHONE, TG_TEST_BOT_TOKEN, [TG_TEST_CODE], [TG_TEST_PASSWORD]
// Usage: node server/test/tele-login.mjs <session dir>
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'tele-session');
const env = (k) => String(process.env[k] || '').trim();
for (const k of ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TG_TEST_PHONE', 'TG_TEST_BOT_TOKEN']) {
  if (!env(k)) throw new Error(`${k} is not set`);
}
const GROUP_TITLE = 'AmoreChat E2E';
const CHANNEL_TITLE = 'AmoreChat E2E channel';

const tdl = await import('tdl');
const { getTdjson } = await import('prebuilt-tdlib');
tdl.configure({ tdjson: getTdjson(), verbosityLevel: 1 });
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const client = tdl.createClient({ apiId: Number(env('TELEGRAM_API_ID')), apiHash: env('TELEGRAM_API_HASH'), databaseDirectory: path.join(dir, 'db'), filesDirectory: path.join(dir, 'files') });
client.on('error', (e) => console.warn('[tdlib]', e?.message || e));

async function state() {
  for (let i = 0; i < 100; i++) {
    const s = (await client.invoke({ _: 'getAuthorizationState' }))._;
    if (s !== 'authorizationStateWaitTdlibParameters' && s !== 'authorizationStateWaitEncryptionKey') return s;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('TDLib did not start');
}

let exitCode = 0;
try {
  let s = await state();
  console.log('state:', s);
  if (s === 'authorizationStateWaitPhoneNumber') {
    if (env('TG_TEST_CODE')) throw new Error('No login is waiting for a code (it expired). Run once without a code first.');
    await client.invoke({ _: 'setAuthenticationPhoneNumber', phone_number: env('TG_TEST_PHONE') });
    s = await state();
  }
  if (s === 'authorizationStateWaitCode') {
    if (!env('TG_TEST_CODE')) {
      console.log('\nThe login code was sent to the spare account (Telegram app or SMS).');
      console.log('Now run the tele-login workflow again with that code.');
    } else {
      await client.invoke({ _: 'checkAuthenticationCode', code: env('TG_TEST_CODE') });
      s = await state();
    }
  }
  if (s === 'authorizationStateWaitPassword') {
    if (!env('TG_TEST_PASSWORD')) throw new Error('The account has two-step verification: set the TG_TEST_PASSWORD secret.');
    await client.invoke({ _: 'checkAuthenticationPassword', password: env('TG_TEST_PASSWORD') });
    s = await state();
  }
  if (s === 'authorizationStateWaitRegistration') throw new Error('This number has no Telegram account: sign up in a Telegram app first.');
  if (s === 'authorizationStateReady') {
    const me = await client.invoke({ _: 'getMe' });
    console.log(`logged in (user id ${me.id})`);
    // The bot: its username from the Bot API, then /start once so it may write to the account.
    const bot = await (await fetch(`https://api.telegram.org/bot${env('TG_TEST_BOT_TOKEN')}/getMe`)).json();
    if (!bot.ok) throw new Error(`TG_TEST_BOT_TOKEN refused: ${bot.description}`);
    const botChat = await client.invoke({ _: 'searchPublicChat', username: bot.result.username });
    const hist = await client.invoke({ _: 'getChatHistory', chat_id: botChat.id, from_message_id: 0, offset: 0, limit: 1, only_local: false });
    if (!hist.messages?.length) {
      await client.invoke({ _: 'sendMessage', chat_id: botChat.id, input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text: '/start' } } });
    }
    // A group of the account and the bot (made once; its id is kept).
    const metaFile = path.join(dir, 'meta.json');
    const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
    let groupChatId = meta.groupChatId;
    if (groupChatId) {
      try {
        const g = await client.invoke({ _: 'getChat', chat_id: groupChatId });
        if (g.title !== GROUP_TITLE) groupChatId = null;
      } catch {
        groupChatId = null;
      }
    }
    if (!groupChatId) {
      const g = await client.invoke({ _: 'createNewBasicGroupChat', user_ids: [bot.result.id], title: GROUP_TITLE, message_auto_delete_time: 0 });
      groupChatId = g.chat_id ?? g.id;
      console.log('group made');
    }
    // A channel of the account where the bot posts (for mirroring channels into the app).
    let channelChatId = meta.channelChatId;
    if (channelChatId) {
      try {
        const c = await client.invoke({ _: 'getChat', chat_id: channelChatId });
        if (c.title !== CHANNEL_TITLE) channelChatId = null;
      } catch {
        channelChatId = null;
      }
    }
    if (!channelChatId) {
      const c = await client.invoke({ _: 'createNewSupergroupChat', title: CHANNEL_TITLE, is_forum: false, is_channel: true, description: 'AmoreChat test', location: null, message_auto_delete_time: 0, for_import: false });
      channelChatId = c.id;
      console.log('channel made');
    }
    await client.invoke({
      _: 'setChatMemberStatus',
      chat_id: channelChatId,
      member_id: { _: 'messageSenderUser', user_id: bot.result.id },
      status: { _: 'chatMemberStatusAdministrator', can_be_edited: true, rights: { _: 'chatAdministratorRights', can_manage_chat: true, can_post_messages: true, can_edit_messages: true, can_delete_messages: true } },
    });
    fs.writeFileSync(metaFile, JSON.stringify({ userId: me.id, botUserId: bot.result.id, botChatId: botChat.id, groupChatId, groupTitle: GROUP_TITLE, channelChatId, channelTitle: CHANNEL_TITLE }), { mode: 0o600 });
    console.log('\nReady: the Tele e2e test can now use this account.');
  }
} catch (e) {
  console.error('\nFAILED:', e.message || e);
  exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
process.exit(exitCode);
