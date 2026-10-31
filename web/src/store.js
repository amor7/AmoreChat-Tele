import { create } from 'zustand';
import { api } from './api';
import { cacheChats, cachedChats, cacheMessages, cachedMessages } from './offline';
import { getPrefs, setPrefs } from './util';

const PAGE = 50;

const replaceIn = (list, m) => list?.map((x) => (x.id === m.id ? m : x));

// Low-data mode: chosen by the user, or automatic while the connection is weak.
export const useDataSaver = () => useStore((s) => !!s.prefs.dataSaver || (s.prefs.autoSaver !== false && s.netWeak));
export const dataSaverNow = () => {
  const s = useStore.getState();
  return !!s.prefs.dataSaver || (s.prefs.autoSaver !== false && s.netWeak);
};

export const useStore = create((set, get) => ({
  me: null,
  config: null,
  chats: {}, // id -> chat summary
  messages: {}, // chatId -> messages, oldest first
  hasMore: {}, // chatId -> bool
  chatVersion: {}, // chatId -> counter bumped on chat:changed so open panels refetch
  activeChatId: null,
  typing: {}, // chatId -> { userId: { name, until } }
  online: {}, // userId -> bool
  modal: null, // { type, ...props }
  emergency: null,
  toast: null,
  connected: true,
  replyTo: null,
  editing: null,
  rtc: null, // active voice room / call connection (see rtc.js)
  call: null, // 1:1 call being rung / in progress
  folders: [], // the user's chat folders
  async loadFolders() {
    const { folders } = await api('GET', '/folders');
    set({ folders });
  },
  voiceRooms: {}, // chatId -> participants currently in that chat's voice room
  voiceMeta: {}, // chatId -> { stage, hands: [userId], listeners: hidden listener count }
  pendingShare: null, // { chatId, files: [File], text } shared into the Android app, waiting for its chat
  voiceChannels: [], // voice channels visible to me (public ones included)
  async loadVoice() {
    if (!get().config?.rtc) return null;
    const [state, ch] = await Promise.all([api('GET', '/rtc/state'), api('GET', '/rtc/voice-channels')]);
    set({
      voiceRooms: Object.fromEntries(state.rooms.map((r) => [r.chatId, r.participants])),
      voiceMeta: Object.fromEntries(state.rooms.map((r) => [r.chatId, { stage: !!r.stage, hands: r.hands || [], listeners: r.listeners || 0 }])),
      voiceChannels: ch.channels,
    });
    return state;
  },
  setVoiceRoom({ chatId, participants, stage, hands, listeners }) {
    set((s) => ({
      voiceRooms: { ...s.voiceRooms, [chatId]: participants },
      voiceMeta: { ...s.voiceMeta, [chatId]: { stage: !!stage, hands: hands || [], listeners: listeners || 0 } },
      voiceChannels: s.voiceChannels.map((c) => (c.id === chatId ? { ...c, participants } : c)),
    }));
  },
  downloads: {}, // key -> { progress (0..1 or null if size unknown), received bytes }
  prefs: getPrefs(),
  setPrefs: (patch) => set({ prefs: setPrefs(patch) }),

  openModal: (type, props = {}) => set({ modal: { type, ...props } }),
  closeModal: () => set({ modal: null }),
  showToast(text) {
    const id = Date.now();
    set({ toast: { text, id } });
    setTimeout(() => get().toast?.id === id && set({ toast: null }), 3500);
  },

  outbox: [], // messages written offline, waiting to be sent (see offline.js)
  netWeak: false, // slow connection detected (socket.js): low-data mode turns on by itself
  async loadChats() {
    // Opened offline (server unreachable): show the saved list at once, refresh in the background.
    if (get().offlineBoot && !Object.keys(get().chats).length) {
      const saved = await cachedChats().catch(() => null);
      if (saved) {
        set({ chats: Object.fromEntries(saved.map((c) => [c.id, c])) });
        get()
          .loadChatsFromServer()
          .catch(() => {});
        return;
      }
    }
    return get().loadChatsFromServer();
  },
  async loadChatsFromServer() {
    let chats;
    try {
      ({ chats } = await api('GET', '/chats'));
    } catch (e) {
      if (e.status) throw e;
      chats = await cachedChats();
      if (!chats) throw e;
    }
    const next = Object.fromEntries(chats.map((c) => [c.id, c]));
    // A private chat opened but not written in yet isn't listed by the server: keep the open one.
    const open = get().chats[get().activeChatId];
    if (open?.type === 'dm' && !next[open.id]) next[open.id] = open;
    set({ chats: next });
    cacheChats(get().chats);
  },
  upsertChat(c) {
    if (c?.id) set((s) => ({ chats: { ...s.chats, [c.id]: { ...s.chats[c.id], ...c } } }));
  },
  async refreshChat(id) {
    set((s) => ({ chatVersion: { ...s.chatVersion, [id]: (s.chatVersion[id] || 0) + 1 } }));
    if (!get().chats[id]) return;
    try {
      const { chat } = await api('GET', `/chats/${id}`);
      if (chat.myRole) get().upsertChat(chat);
    } catch {
      /* removed meanwhile */
    }
  },
  removeChat(id) {
    set((s) => {
      const chats = { ...s.chats };
      delete chats[id];
      const messages = { ...s.messages };
      delete messages[id];
      return { chats, messages };
    });
    if (get().activeChatId === id) location.hash = '';
  },

  async loadMessages(chatId, older = false) {
    const cur = get().messages[chatId];
    if (older && (!cur?.length || get().hasMore[chatId] === false)) return 0;
    const before = older ? `&before=${cur[0].id}` : '';
    let messages;
    try {
      ({ messages } = await api('GET', `/chats/${chatId}/messages?limit=${PAGE}${before}`));
    } catch (e) {
      // Offline: show what this device saved for the chat.
      if (e.status || older) throw e;
      messages = await cachedMessages(chatId);
      if (!messages) throw e;
    }
    set((s) => ({
      messages: { ...s.messages, [chatId]: older ? [...messages, ...(s.messages[chatId] || [])] : messages },
      hasMore: { ...s.hasMore, [chatId]: messages.length === PAGE },
      ...(older ? {} : { hasNewer: { ...s.hasNewer, [chatId]: false } }),
    }));
    if (!older) cacheMessages(chatId, get().messages[chatId]);
    return messages.length;
  },
  // Load a window centred on one message (search results, reply quotes far up the history).
  async loadAround(chatId, messageId) {
    const { messages } = await api('GET', `/chats/${chatId}/messages?limit=${PAGE}&around=${messageId}`);
    const latest = get().chats[chatId]?.lastMessage?.id;
    set((s) => ({
      messages: { ...s.messages, [chatId]: messages },
      hasMore: { ...s.hasMore, [chatId]: true },
      hasNewer: { ...s.hasNewer, [chatId]: !!latest && messages.at(-1)?.id < latest },
    }));
  },
  async loadNewer(chatId) {
    const cur = get().messages[chatId];
    if (!cur?.length || !get().hasNewer[chatId]) return 0;
    const { messages } = await api('GET', `/chats/${chatId}/messages?limit=${PAGE}&after=${cur.at(-1).id}`);
    set((s) => {
      const known = new Set((s.messages[chatId] || []).map((m) => m.id));
      return {
        messages: { ...s.messages, [chatId]: [...(s.messages[chatId] || []), ...messages.filter((m) => !known.has(m.id))] },
        hasNewer: { ...s.hasNewer, [chatId]: messages.length === PAGE },
      };
    });
    return messages.length;
  },
  hasNewer: {}, // chatId -> true when the loaded window doesn't reach the latest message
  jumpTo: null, // { chatId, messageId } requested by search / forward links
  sentAt: 0, // bumped when I send something: the open chat jumps to its latest message

  addMessage(m) {
    setTimeout(() => {
      cacheMessages(m.chatId, get().messages[m.chatId]);
      cacheChats(get().chats);
    });
    set((s) => {
      const list = s.messages[m.chatId];
      const exists = list?.some((x) => x.id === m.id);
      // While viewing an older window, don't append: the user will load newer pages on scroll.
      const messages = list && !exists && !s.hasNewer[m.chatId] ? { ...s.messages, [m.chatId]: [...list, m] } : s.messages;
      const chat = s.chats[m.chatId];
      if (!chat || exists) return { messages };
      const mine = m.sender?.id === s.me?.id;
      const typing = { ...s.typing };
      if (m.sender && typing[m.chatId]) {
        typing[m.chatId] = { ...typing[m.chatId] };
        delete typing[m.chatId][m.sender.id];
      }
      return {
        messages,
        typing,
        chats: {
          ...s.chats,
          [m.chatId]: {
            ...chat,
            lastMessage: m,
            unread: mine || m.type === 'system' ? chat.unread : chat.unread + 1,
            unreadMentions: !mine && m.mentions?.includes(s.me?.id) ? (chat.unreadMentions || 0) + 1 : chat.unreadMentions,
            lastRead: mine ? m.id : chat.lastRead,
          },
        },
      };
    });
  },
  updateMessage(m) {
    const old = get().messages[m.chatId]?.find((x) => x.id === m.id);
    // An older copy arriving late (e.g. the reply to my reaction after the broadcast of a later one).
    if (old?.v && m.v && m.v < old.v) return;
    if (old && m.reactions?.some((r) => r.count != null && r.mine == null)) {
      m = { ...m, reactions: m.reactions.map((r) => (r.mine == null ? { ...r, mine: !!old.reactions?.find((o) => o.emoji === r.emoji)?.mine } : r)) };
    }
    set((s) => {
      const chat = s.chats[m.chatId];
      return {
        messages: s.messages[m.chatId] ? { ...s.messages, [m.chatId]: replaceIn(s.messages[m.chatId], m) } : s.messages,
        chats: chat?.lastMessage?.id === m.id ? { ...s.chats, [m.chatId]: { ...chat, lastMessage: m } } : s.chats,
      };
    });
  },
  markDeleted({ id, chatId, kept }) {
    const list = get().messages[chatId];
    const wasLast = get().chats[chatId]?.lastMessage?.id === id;
    const m = list?.find((x) => x.id === id) || get().chats[chatId]?.lastMessage;
    if (m?.id === id) get().updateMessage({ ...m, type: 'deleted', kept: !!kept, text: '', file: null, sender: null, pinned: false });
    // Replies lose their quote, and the chat list shows the message before it.
    if (list?.some((x) => x.replyTo?.id === id)) {
      set((s) => ({ messages: { ...s.messages, [chatId]: s.messages[chatId].map((x) => (x.replyTo?.id === id ? { ...x, replyTo: { ...x.replyTo, type: 'deleted', text: '' } } : x)) } }));
    }
    if (wasLast) get().refreshChat(chatId);
  },

  markRead(chatId) {
    const s = get();
    const chat = s.chats[chatId];
    const list = s.messages[chatId];
    const last = list?.[list.length - 1];
    if (!chat || !last || (last.id <= chat.lastRead && !chat.unread)) return;
    set({ chats: { ...s.chats, [chatId]: { ...chat, lastRead: Math.max(last.id, chat.lastRead), unread: 0, unreadMentions: 0 } } });
    api('POST', `/chats/${chatId}/read`, { messageId: last.id }).catch(() => {});
  },
  onRead({ chatId, userId, messageId }) {
    const s = get();
    const chat = s.chats[chatId];
    if (!chat || userId === s.me?.id || messageId <= chat.othersRead) return;
    set({ chats: { ...s.chats, [chatId]: { ...chat, othersRead: messageId } } });
  },

  setTyping({ chatId, userId, name }) {
    set((s) => ({ typing: { ...s.typing, [chatId]: { ...s.typing[chatId], [userId]: { name, until: Date.now() + 4000 } } } }));
  },
  setPresence({ userId, online, lastSeen }) {
    set((s) => {
      const chats = { ...s.chats };
      for (const c of Object.values(chats)) {
        if (c.peer?.id === userId) chats[c.id] = { ...c, peer: { ...c.peer, online, lastSeen: lastSeen ?? c.peer.lastSeen } };
      }
      return { online: { ...s.online, [userId]: online }, chats };
    });
  },
}));

export const isUserOnline = (s, user) => s.online[user?.id] ?? user?.online ?? false;
