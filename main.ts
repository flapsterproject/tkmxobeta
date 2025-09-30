// main.ts
// Telegram Tic-Tac-Toe Bot (Deno) - Fixed, patched & extended
// - Inline nav menu (deletes previous menu message on navigation)
// - Requires subscription to @TkmXO for actions
// - Promocode system (admin create, user redeem once)
// - Boss battles (admin creates boss with photo & caption; users play vs boss once)
// - All messages in Turkmen
// - Deno KV persistence
//
// Requirements:
// - DENO KV enabled
// - BOT_TOKEN env var
// - Deploy as webhook on SECRET_PATH

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const TOKEN = Deno.env.get("BOT_TOKEN")!;
if (!TOKEN) throw new Error("BOT_TOKEN env var is required");
const API = `https://api.telegram.org/bot${TOKEN}`;
const SECRET_PATH = "/tkmxo"; // webhook path

const kv = await Deno.openKv();

// ADMIN (username without @) — change to your admin username or use number ID changes if desired
const ADMIN_USERNAME = "Masakoff";

// required channel that users must subscribe to
const REQUIRED_CHANNEL = "@TkmXO";

// runtime in-memory state
const queue: string[] = [];
const trophyQueue: string[] = [];
const battles: Record<string, any> = {};
const searchTimeouts: Record<string, number> = {};
const withdrawalStates: Record<string, { amount: number; step: "amount" | "phone" }> = {};
const globalMessageStates: Record<string, boolean> = {};
const promoStates: Record<string, boolean> = {}; // waiting for user to send promocode string
const bossCreationStates: Record<string, { step: "await_photo"; tmp?: any }> = {};
const bossPlayLock: Record<string, boolean> = {}; // prevent double plays

// -------------------- Telegram helpers --------------------
async function apiFetch(method: string, body: any) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.warn("telegram api error", method, data);
  }
  return data;
}

async function sendMessage(chatId: string | number, text: string, options: any = {}) {
  const body: any = { chat_id: chatId, text, ...options };
  const data = await apiFetch("sendMessage", body);
  return data.result?.message_id ?? null;
}

async function editMessageText(chatId: string | number, messageId: number, text: string, options: any = {}) {
  return apiFetch("editMessageText", { chat_id: chatId, message_id: messageId, text, ...options });
}

async function sendPhoto(chatId: string | number, photoFileId: string, caption = "", options: any = {}) {
  const body: any = { chat_id: chatId, photo: photoFileId, caption, ...options };
  const data = await apiFetch("sendPhoto", body);
  return data.result?.message_id ?? null;
}

async function answerCallbackQuery(id: string, text = "", showAlert = false) {
  return apiFetch("answerCallbackQuery", { callback_query_id: id, text, show_alert: showAlert });
}

async function getChatMember(chat: string, userId: string | number) {
  try {
    const data = await apiFetch("getChatMember", { chat_id: chat, user_id: userId });
    return data.result;
  } catch (e) {
    return null;
  }
}

// check subscription (returns true if member or creator/admin)
async function checkSubscription(userId: string) {
  try {
    // chat_id can be username like @TkmXO
    const member = await getChatMember(REQUIRED_CHANNEL, userId);
    if (!member) return false;
    const status = member.status;
    return ["member", "creator", "administrator"].includes(status);
  } catch (e) {
    console.warn("checkSubscription failed", e);
    return false;
  }
}

// -------------------- Profile helpers --------------------
type Profile = {
  id: string;
  username?: string;
  displayName: string;
  trophies: number;
  tmt: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  lastActive: number;
};

function getDisplayName(p: Profile) {
  return p.displayName && p.displayName !== "" ? p.displayName : `ID:${p.id}`;
}

async function initProfile(userId: string, username?: string, displayName?: string) {
  const key = ["profiles", userId];
  const res = await kv.get(key);
  if (!res.value) {
    const profile: Profile = {
      id: userId,
      username,
      displayName: displayName || `ID:${userId}`,
      trophies: 0,
      tmt: 0,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      lastActive: Date.now(),
    };
    await kv.set(key, profile);
    return profile;
  } else {
    const existing = res.value as Profile;
    let changed = false;
    if (username && username !== existing.username) {
      existing.username = username;
      changed = true;
    }
    if (displayName && displayName !== existing.displayName) {
      existing.displayName = displayName;
      changed = true;
    }
    existing.lastActive = Date.now();
    if (changed) await kv.set(key, existing);
    return existing;
  }
}

async function getProfile(userId: string): Promise<Profile | null> {
  const res = await kv.get(["profiles", userId]);
  return (res.value as Profile) ?? null;
}

async function updateProfile(userId: string, delta: Partial<Profile>) {
  const existing = (await getProfile(userId)) || (await initProfile(userId));
  const newProfile: Profile = {
    ...existing,
    username: delta.username ?? existing.username,
    displayName: delta.displayName ?? existing.displayName,
    trophies: Math.max(0, (existing.trophies || 0) + (delta.trophies ?? 0)),
    tmt: Math.max(0, (existing.tmt || 0) + (delta.tmt ?? 0)),
    gamesPlayed: (existing.gamesPlayed || 0) + (delta.gamesPlayed ?? 0),
    wins: (existing.wins || 0) + (delta.wins ?? 0),
    losses: (existing.losses || 0) + (delta.losses ?? 0),
    draws: (existing.draws || 0) + (delta.draws ?? 0),
    lastActive: Date.now(),
    id: existing.id,
  };
  await kv.set(["profiles", userId], newProfile);
  return newProfile;
}

function getRank(trophies: number) {
  if (trophies < 500) return "🌱 Newbie";
  if (trophies < 1000) return "🥉 Bronze";
  if (trophies < 1500) return "🥈 Silver";
  if (trophies < 2000) return "🥇 Gold";
  if (trophies < 2500) return "🏆 Platinum";
  return "💎 Diamond";
}

async function sendProfile(chatId: string) {
  await initProfile(String(chatId));
  const p = (await getProfile(String(chatId)))!;
  const winRate = p.gamesPlayed ? ((p.wins / p.gamesPlayed) * 100).toFixed(1) : "0";
  const msg =
    `🏅 *Profil: ${getDisplayName(p)}*\n\n` +
    `🆔 ID: \`${p.id}\`\n\n` +
    `🏆 Kuboklar: *${p.trophies}*\n` +
    `💰 TMT Balansy: *${p.tmt}*\n` +
    `🏅 Rank: *${getRank(p.trophies)}*\n` +
    `🎲 Oýnalan Oýunlar: *${p.gamesPlayed}*\n` +
    `✅ Ýeňişler: *${p.wins}* | ❌ Utulyşlar: *${p.losses}* | 🤝 Deňe-deňler: *${p.draws}*\n` +
    `📈 Win Rate: *${winRate}%*`;
  await sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

// -------------------- Leaderboard --------------------
async function getLeaderboard(top = 10, offset = 0) {
  const players: Profile[] = [];
  try {
    for await (const entry of kv.list({ prefix: ["profiles"] })) {
      if (!entry.value) continue;
      players.push(entry.value as Profile);
    }
  } catch (e) {
    console.error("getLeaderboard kv.list error", e);
  }
  players.sort((a, b) => {
    if (b.trophies !== a.trophies) return b.trophies - a.trophies;
    return b.wins - a.wins;
  });
  return players.slice(offset, offset + top);
}

async function sendLeaderboard(chatId: string, page = 0) {
  const perPage = 10;
  const offset = page * perPage;
  const topPlayers = await getLeaderboard(perPage, offset);

  if (topPlayers.length === 0) {
    await sendMessage(chatId, "Häzirlikçe oýunçy ýok! Ilkinji oýunçylaryň biri boluň.");
    return;
  }

  let msg = `🏆 *Leaderboard* — Sahypa ${page + 1}\n\n`;
  topPlayers.forEach((p, i) => {
    const rankNum = offset + i + 1;
    const name = getDisplayName(p);
    const winRate = p.gamesPlayed ? ((p.wins / p.gamesPlayed) * 100).toFixed(1) : "0";
    msg += `*${rankNum}.* ${name} — 🏆 *${p.trophies}* | 📈 *${winRate}%*\n`;
  });

  const keyboard: any = { inline_keyboard: [] };
  const row: any[] = [];
  if (page > 0) row.push({ text: "⬅️ Öňki", callback_data: `leaderboard:${page - 1}` });
  if (topPlayers.length === perPage) row.push({ text: "Indiki ➡️", callback_data: `leaderboard:${page + 1}` });
  if (row.length) keyboard.inline_keyboard.push(row);

  await sendMessage(chatId, msg, { reply_markup: keyboard, parse_mode: "Markdown" });
}

// -------------------- Game logic --------------------
function createEmptyBoard(): string[] {
  return Array(9).fill("");
}

function boardToText(board: string[]) {
  const map: any = { "": "▫️", X: "❌", O: "⭕" };
  let text = "\n";
  for (let i = 0; i < 9; i += 3) {
    text += `${map[board[i]]}${map[board[i + 1]]}${map[board[i + 2]]}\n`;
  }
  return text;
}

function checkWin(board: string[]) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a, b, c] };
    }
  }
  if (board.every((c) => c !== "")) return { winner: "draw" };
  return null;
}

function makeInlineKeyboard(board: string[], disabled = false) {
  const keyboard: any[] = [];
  for (let r = 0; r < 3; r++) {
    const row: any[] = [];
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      const cell = board[i];
      let text = cell === "X" ? "❌" : cell === "O" ? "⭕" : `${i + 1}`;
      const callback_data = disabled ? "noop" : `hereket:${i}`;
      row.push({ text, callback_data });
    }
    keyboard.push(row);
  }
  keyboard.push([{ text: "🏳️ Tabşyrmak", callback_data: "surrender" }]);
  return { inline_keyboard: keyboard };
}

// -------------------- Battle control --------------------
async function startBattle(p1: string, p2: string, isTrophyBattle = false) {
  // clear any timeouts
  if (searchTimeouts[p1]) { clearTimeout(searchTimeouts[p1]); delete searchTimeouts[p1]; }
  if (searchTimeouts[p2]) { clearTimeout(searchTimeouts[p2]); delete searchTimeouts[p2]; }

  const battle = {
    players: [p1, p2],
    board: createEmptyBoard(),
    turn: p1,
    marks: { [p1]: "X", [p2]: "O" },
    messageIds: {} as Record<string, number>,
    idleTimerId: undefined as number | undefined,
    moveTimerId: undefined as number | undefined,
    round: 1,
    roundWins: { [p1]: 0, [p2]: 0 },
    isTrophyBattle,
  };
  battles[p1] = battle;
  battles[p2] = battle;

  await initProfile(p1);
  await initProfile(p2);

  const battleTypeText = isTrophyBattle ? "🏆 *Pul üçin oýun*" : "⚔️ *Kubok üçin oýun*";
  const stakeText = isTrophyBattle ? "\n\nGoýum: Iki oýunçy hem 1 TMT goýýar. Ýeňiji +0.75 TMT alýar." : "";

  await sendMessage(p1, `${battleTypeText}\n\nSen ❌ (X).${stakeText}\n\n*Oýun görnüşi:* 3 turdan ybarat vs ID:${p2}`, { parse_mode: "Markdown" });
  await sendMessage(p2, `${battleTypeText}\n\nSen ⭕ (O).${stakeText}\n\n*Oýun görnüşi:* 3 turdan ybarat vs ID:${p1}`, { parse_mode: "Markdown" });
  await sendRoundStart(battle);
}

function headerForPlayer(battle: any, player: string) {
  const opponent = battle.players.find((p: string) => p !== player)!;
  const yourMark = battle.marks[player];
  const opponentMark = battle.marks[opponent];
  const battleTypeText = battle.isTrophyBattle ? "🏆 *Trophy Battle*" : "🎯 *Tic-Tac-Toe*";
  const opponentDisplay = `ID:${opponent}`;
  return `${battleTypeText} — Sen (${yourMark}) vs ${opponentDisplay} (${opponentMark})`;
}

async function endTurnIdle(battle: any) {
  const loser = battle.turn;
  const winner = battle.players.find((p: string) => p !== loser)!;

  await sendMessage(loser, "⚠️ Herekede gijä galdyňyz. Siz tabşyrdyňyz.");
  await sendMessage(winner, "⚠️ Garşydaşyňyz herekede galdy. Olar tabşyrdy. Siz ýeňdiňiz!");

  if (battle.idleTimerId) { clearTimeout(battle.idleTimerId); delete battle.idleTimerId; }
  if (battle.moveTimerId) { clearTimeout(battle.moveTimerId); delete battle.moveTimerId; }

  await finishMatch(battle, { winner, loser });
}

async function sendRoundStart(battle: any) {
  for (const player of battle.players) {
    const header = headerForPlayer(battle, player);
    const yourTurn = battle.turn === player;
    const text =
      `${header}\n\n` +
      `*Tur ${battle.round}/3*\n` +
      `📊 Bal: ${battle.roundWins[battle.players[0]]} - ${battle.roundWins[battle.players[1]]}\n` +
      `🎲 Hereket: ${yourTurn ? "*Seniň herekediň*" : "Garşydaşyň herekedi"}\n` +
      boardToText(battle.board);
    const msgId = await sendMessage(player, text, { reply_markup: makeInlineKeyboard(battle.board), parse_mode: "Markdown" });
    if (msgId) battle.messageIds[player] = msgId;
  }

  if (battle.idleTimerId) { clearTimeout(battle.idleTimerId); }
  battle.idleTimerId = setTimeout(() => endBattleIdle(battle), 5 * 60 * 1000) as unknown as number;

  if (battle.moveTimerId) { clearTimeout(battle.moveTimerId); }
  battle.moveTimerId = setTimeout(() => endTurnIdle(battle), 1 * 60 * 1000) as unknown as number;
}

async function endBattleIdle(battle: any) {
  const [p1, p2] = battle.players;
  await sendMessage(p1, "⚠️ Oýun hereketsizlik sebäpli tamamlandy (5 minut).", { parse_mode: "Markdown" });
  await sendMessage(p2, "⚠️ Oýun hereketsizlik sebäpli tamamlandy (5 minut).", { parse_mode: "Markdown" });

  if (battle.isTrophyBattle) {
    await updateProfile(p1, { tmt: 1 });
    await updateProfile(p2, { tmt: 1 });
    await sendMessage(p1, "💸 Hereketsiz oýun üçin 1 TMT yzyna gaýtaryldy.");
    await sendMessage(p2, "💸 Hereketsiz oýun üçin 1 TMT yzyna gaýtaryldy.");
  }

  delete battles[p1];
  delete battles[p2];
}

async function finishMatch(battle: any, result: { winner?: string; loser?: string; draw?: boolean }) {
  try {
    if (battle.idleTimerId) { clearTimeout(battle.idleTimerId); delete battle.idleTimerId; }
    if (battle.moveTimerId) { clearTimeout(battle.moveTimerId); delete battle.moveTimerId; }
    const [p1, p2] = battle.players;

    for (const player of battle.players) {
      const msgId = battle.messageIds[player];
      const header = headerForPlayer(battle, player);
      let text: string;
      if (result.draw) {
        text = `${header}\n\n*Oýun Netijesi:* 🤝 *Deňe-deň!*\n${boardToText(battle.board)}`;
      } else if (result.winner === player) {
        text = `${header}\n\n*Oýun Netijesi:* 🎉 *Siz oýunda ýeňdiňiz!*\n${boardToText(battle.board)}`;
      } else {
        text = `${header}\n\n*Oýun Netijesi:* 😢 *Siz oýunda utuldyňyz.*\n${boardToText(battle.board)}`;
      }
      if (msgId) {
        await editMessageText(player, msgId, text, { reply_markup: makeInlineKeyboard(battle.board, true), parse_mode: "Markdown" });
      } else {
        await sendMessage(player, text, { parse_mode: "Markdown" });
      }
    }

    if (result.draw) {
      await updateProfile(p1, { gamesPlayed: 1, draws: 1 });
      await updateProfile(p2, { gamesPlayed: 1, draws: 1 });
      await sendMessage(p1, "🤝 Oýun deňe-deň boldy!");
      await sendMessage(p2, "🤝 Oýun deňe-deň boldy!");

      if (battle.isTrophyBattle) {
        await updateProfile(p1, { tmt: 1 });
        await updateProfile(p2, { tmt: 1 });
        await sendMessage(p1, "💸 Deňlik üçin 1 TMT yzyna gaýtaryldy.");
        await sendMessage(p2, "💸 Deňlik üçin 1 TMT yzyna gaýtaryldy.");
      }
    } else if (result.winner) {
      const winner = result.winner!;
      const loser = result.loser!;
      await initProfile(winner);
      await initProfile(loser);

      await updateProfile(winner, { gamesPlayed: 1, wins: 1, trophies: 1 });
      await updateProfile(loser, { gamesPlayed: 1, losses: 1, trophies: -1 });
      await sendMessage(winner, `🎉 Siz oýunda ýeňdiňiz!\n🏆 *+1 kubok* (vs ID:${loser})`, { parse_mode: "Markdown" });
      await sendMessage(loser, `😢 Siz oýunda utuldyňyz.\n🏆 *-1 kubok* (vs ID:${winner})`, { parse_mode: "Markdown" });

      if (battle.isTrophyBattle) {
        // Winner +0.75, loser -1 (approx)
        await updateProfile(winner, { tmt: 0.75 });
        // loser already had 1 TMT deducted before match
        await sendMessage(winner, "🏆 TMT: +0.75 TMT siziň ýeňşiňiz üçin goşuldy!");
        await sendMessage(loser, "💔 TMT: 1 TMT siziň goýumyňyz üçin alyndy.");
      }
    }

    delete battles[p1];
    delete battles[p2];
  } catch (err) {
    console.error("finishMatch error:", err);
  }
}

// -------------------- Promo & Boss helpers --------------------
// promo object: { code, amount: number, usesLeft: number }
async function createPromo(code: string, amount: number, uses: number) {
  await kv.set(["promo", code.toUpperCase()], { code: code.toUpperCase(), amount, usesLeft: uses });
}
async function getPromo(code: string) {
  const res = await kv.get(["promo", code.toUpperCase()]);
  return res.value ?? null;
}
async function usePromoForUser(code: string, userId: string) {
  // mark used by user
  await kv.set(["promoused", userId, code.toUpperCase()], { usedAt: Date.now() });
  // decrement global uses
  const p = await getPromo(code);
  if (!p) return false;
  if (p.usesLeft <= 0) return false;
  p.usesLeft = Math.max(0, p.usesLeft - 1);
  await kv.set(["promo", code.toUpperCase()], p);
  return true;
}
async function hasUserUsedPromo(code: string, userId: string) {
  const res = await kv.get(["promoused", userId, code.toUpperCase()]);
  return !!res.value;
}

// Boss object: { name, rounds, count, reward, photoFileId }
async function saveBoss(boss: any) {
  await kv.set(["boss", boss.name], boss);
}
async function getBoss(name: string) {
  const res = await kv.get(["boss", name]);
  return res.value ?? null;
}
async function listBosses() {
  const result: any[] = [];
  for await (const entry of kv.list({ prefix: ["boss"] })) {
    if (!entry.value) continue;
    result.push(entry.value);
  }
  return result;
}
async function decrementBossCount(name: string) {
  const b = await getBoss(name);
  if (!b) return false;
  if (b.count <= 0) return false;
  b.count -= 1;
  await saveBoss(b);
  return true;
}

// Simple boss AI: random moves
function bossMakeMove(board: string[], mark: string) {
  const empty = board.map((v, i) => v === "" ? i : -1).filter(i => i >= 0);
  if (empty.length === 0) return -1;
  // try to win/block: simple two-pass (win then block)
  for (const candidate of empty) {
    const copy = board.slice();
    copy[candidate] = mark;
    const res = checkWin(copy);
    if (res && res.winner === mark) return candidate;
  }
  const opponentMark = mark === "X" ? "O" : "X";
  for (const candidate of empty) {
    const copy = board.slice();
    copy[candidate] = opponentMark;
    const res = checkWin(copy);
    if (res && res.winner === opponentMark) return candidate;
  }
  // fallback random
  return empty[Math.floor(Math.random() * empty.length)];
}

// -------------------- Callbacks / Nav handling --------------------
async function handleCallback(fromId: string, data: string | null, callbackId: string, message?: { chat: { id: number }, message_id: number } | null) {
  if (!data) { await answerCallbackQuery(callbackId); return; }

  try {
    // navigation callbacks: delete menu message then call command handler
    if (data.startsWith("nav:")) {
      // delete the menu message if exists
      if (message && message.message_id) {
        try {
          await apiFetch("deleteMessage", { chat_id: message.chat.id, message_id: message.message_id });
        } catch (_) { /* ignore */ }
      }
      const cmd = data.split(":")[1];
      // simulate user sending the command
      await handleCommand(fromId, undefined, undefined, `/${cmd}`);
      await answerCallbackQuery(callbackId);
      return;
    }

    if (data.startsWith("leaderboard:")) {
      const page = parseInt(data.split(":")[1]) || 0;
      await sendLeaderboard(fromId, page);
      await answerCallbackQuery(callbackId);
      return;
    }

    if (data === "noop") {
      await answerCallbackQuery(callbackId);
      return;
    }

    // handle in-game callbacks, but sometimes callback message belongs to other user
    const battle = battles[fromId];
    if (!battle) {
      if (data === "surrender") {
        await answerCallbackQuery(callbackId, "Siz oýunda dälsiňiz.", true);
        return;
      }
      await answerCallbackQuery(callbackId);
      return;
    }

    // Reset timers
    if (battle.idleTimerId) { clearTimeout(battle.idleTimerId); battle.idleTimerId = setTimeout(() => endBattleIdle(battle), 5 * 60 * 1000) as unknown as number; }
    if (battle.moveTimerId) { clearTimeout(battle.moveTimerId); battle.moveTimerId = setTimeout(() => endTurnIdle(battle), 1 * 60 * 1000) as unknown as number; }

    if (data === "surrender") {
      const opponent = battle.players.find((p: string) => p !== fromId)!;
      await sendMessage(fromId, "🏳️ Siz oýunu tabşyrdyňyz.");
      await sendMessage(opponent, "🏳️ Garşydaşyňyz tabşyrdy. Siz ýeňdiňiz!");
      await finishMatch(battle, { winner: opponent, loser: fromId });
      await answerCallbackQuery(callbackId, "Siz tabşyrdyňyz.");
      return;
    }

    if (!data.startsWith("hereket:")) {
      await answerCallbackQuery(callbackId);
      return;
    }

    const idx = parseInt(data.split(":")[1]);
    if (isNaN(idx) || idx < 0 || idx > 8) {
      await answerCallbackQuery(callbackId, "Nädogry hereket.", true);
      return;
    }
    if (battle.turn !== fromId) {
      await answerCallbackQuery(callbackId, "Siziň herekediňiz däl.", true);
      return;
    }
    if (battle.board[idx] !== "") {
      await answerCallbackQuery(callbackId, "Bu öýjük eýýäm eýelenipdi.", true);
      return;
    }

    const mark = battle.marks[fromId];
    battle.board[idx] = mark;

    const winResult = checkWin(battle.board);
    if (winResult) {
      const { winner, line } = winResult as any;
      let roundWinner: string | undefined;
      if (winner !== "draw") {
        roundWinner = battle.players.find((p: string) => battle.marks[p] === winner)!;
        battle.roundWins[roundWinner] = (battle.roundWins[roundWinner] || 0) + 1;
      }

      let boardText = boardToText(battle.board);
      if (line) boardText += `\n🎉 *Line:* ${line.map((i: number) => i + 1).join("-")}`;
      else if (winner === "draw") boardText += `\n🤝 *Deňe-deň boldy!*`;

      for (const player of battle.players) {
        const msgId = battle.messageIds[player];
        const header = headerForPlayer(battle, player);
        let text = `${header}\n\n*Tur ${battle.round} Netije!*\n`;
        if (winner === "draw") text += `🤝 Oýun deňe-deň boldy!\n`;
        else text += `${roundWinner === player ? "🎉 Siz turda ýeňdiňiz!" : "😢 Bu turda utuldyňyz"}\n`;
        text += `📊 Bal: ${battle.roundWins[battle.players[0]]} - ${battle.roundWins[battle.players[1]]}\n${boardText}`;
        if (msgId) await editMessageText(player, msgId, text, { reply_markup: makeInlineKeyboard(battle.board, true), parse_mode: "Markdown" });
        else await sendMessage(player, text, { parse_mode: "Markdown" });
      }

      // match end check
      if (battle.roundWins[battle.players[0]] === 2 || battle.roundWins[battle.players[1]] === 2 || battle.round === 3) {
        if (battle.roundWins[battle.players[0]] > battle.roundWins[battle.players[1]]) {
          await finishMatch(battle, { winner: battle.players[0], loser: battle.players[1] });
        } else if (battle.roundWins[battle.players[1]] > battle.roundWins[battle.players[0]]) {
          await finishMatch(battle, { winner: battle.players[1], loser: battle.players[0] });
        } else {
          await finishMatch(battle, { draw: true });
        }
        await answerCallbackQuery(callbackId);
        return;
      }

      // next round
      battle.round++;
      battle.board = createEmptyBoard();
      battle.turn = battle.players[(battle.round - 1) % 2];
      if (battle.moveTimerId) clearTimeout(battle.moveTimerId);
      battle.moveTimerId = setTimeout(() => endTurnIdle(battle), 1 * 60 * 1000) as unknown as number;
      await sendRoundStart(battle);
      await answerCallbackQuery(callbackId, "Hereket edildi!");
      return;
    }

    // continue
    battle.turn = battle.players.find((p: string) => p !== fromId)!;
    for (const player of battle.players) {
      const header = headerForPlayer(battle, player);
      const yourTurn = battle.turn === player;
      const text =
        `${header}\n\n` +
        `*Tur: ${battle.round}/3*\n` +
        `📊 Bal: ${battle.roundWins[battle.players[0]]} - ${battle.roundWins[battle.players[1]]}\n` +
        `🎲 Hereket: ${yourTurn ? "*Siziň herekediňiz*" : "Garşydaşyň herekedi"}\n` +
        boardToText(battle.board);
      const msgId = battle.messageIds[player];
      if (msgId) await editMessageText(player, msgId, text, { reply_markup: makeInlineKeyboard(battle.board), parse_mode: "Markdown" });
      else await sendMessage(player, text, { reply_markup: makeInlineKeyboard(battle.board), parse_mode: "Markdown" });
    }
    await answerCallbackQuery(callbackId, "Hereket edildi!");
  } catch (e) {
    console.error("handleCallback error", e);
  }
}

// -------------------- Withdrawal --------------------
async function handleWithdrawal(fromId: string, text: string) {
  if (withdrawalStates[fromId]) {
    const state = withdrawalStates[fromId];

    if (state.step === "amount") {
      const amount = parseFloat(text);

      if (isNaN(amount) || amount <= 0) {
        await sendMessage(fromId, "❌ TMT çykarmak üçin hakyky san giriziň.");
        return;
      }

      const profile = await getProfile(fromId);
      if (!profile || profile.tmt < amount) {
        await sendMessage(fromId, `❌ Siziň ýeterlik TMT-ňiz ýok. Häzirki balans: ${profile?.tmt ?? 0} TMT.`);
        delete withdrawalStates[fromId];
        return;
      }

      withdrawalStates[fromId] = { amount, step: "phone" };
      await sendMessage(fromId, "📱 Telefon belgiňizi giriziň:");
      return;
    } else if (state.step === "phone") {
      const phoneNumber = text.trim();
      if (phoneNumber.length < 5) {
        await sendMessage(fromId, "❌ Hakyky telefon belgisini giriziň.");
        return;
      }

      const amount = state.amount;
      const profile = await getProfile(fromId);
      if (!profile || profile.tmt < amount) {
        await sendMessage(fromId, "❌ Balans ýeterlik däl. Täzeden synanyşyň.");
        delete withdrawalStates[fromId];
        return;
      }

      try {
        await updateProfile(fromId, { tmt: -amount });
        await sendMessage(fromId, `✅ Çykarma soragy iberildi!\n\nMukdar: ${amount} TMT\nTelefon: ${phoneNumber}\nSiziň soragyňyz işlenýär.`);

        // notify admin
        await sendMessage(ADMIN_USERNAME, `💰 *WITHDRAWAL REQUEST*\n\nUser ID: ${fromId}\nAmount: ${amount} TMT\nPhone: ${phoneNumber}`, { parse_mode: "Markdown" });

        delete withdrawalStates[fromId];
      } catch (error) {
        console.error("Withdrawal processing error:", error);
        await sendMessage(fromId, "❌ Çykarma işlemi wagtynda näsazlyk boldy. Täzeden synanyşyň.");
        delete withdrawalStates[fromId];
      }

      return;
    }
  } else {
    await sendMessage(fromId, "💰 Çykarmak isleýän TMT mukdaryny giriziň:");
    withdrawalStates[fromId] = { amount: 0, step: "amount" };
    return;
  }
}

// -------------------- Commands --------------------
async function sendMainMenu(chatId: string) {
  const text = `🎮 *TkmXO Bot* — Baş Menýu\n\nBirini saýlaýyň:`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "⚔️ Battle", callback_data: "nav:battle" }, { text: "🏆 Real Battle", callback_data: "nav:realbattle" }],
      [{ text: "👤 Profil", callback_data: "nav:profile" }, { text: "📈 Leaderboard", callback_data: "nav:leaderboard" }],
      [{ text: "🎁 Promokod", callback_data: "nav:promocode" }, { text: "👾 Boss", callback_data: "nav:boss" }],
      [{ text: "💸 Withdraw", callback_data: "nav:withdraw" }, { text: "ℹ️ Help", callback_data: "nav:start" }]
    ]
  };
  await sendMessage(chatId, text, { reply_markup: keyboard, parse_mode: "Markdown" });
}

async function handleCommand(fromId: string, username: string | undefined, displayName: string | undefined, text: string) {
  // normalize
  text = text.trim();

  // allow /start and admin even if not subscribed
  if (!text.startsWith("/start") && !text.startsWith("/help") && username !== ADMIN_USERNAME) {
    // require subscription
    const ok = await checkSubscription(fromId);
    if (!ok) {
      await sendMessage(fromId, `🔔 Hoş geldiňiz! Bot ulanylmazdan ozal *${REQUIRED_CHANNEL}* kanalyna agza boluň.` , { parse_mode: "Markdown" });
      return;
    }
  }

  // ensure profile
  await initProfile(fromId, username, displayName);

  // command handling
  if (text.startsWith("/start") || text.startsWith("/help")) {
    const helpText =
      `🎮 *TkmXO Bot-a hoş geldiňiz!*\n\n` +
      `Aşakdaky buýruklary ulanyň:\n` +
      `🔹 /battle - Adaty kubok duşuşyk üçin garşydaş tap.\n` +
      `🔹 /realbattle - TMT + Kubok oýun (1 TMT goýum talap edýär).\n` +
      `🔹 /profile - Profilini gör.\n` +
      `🔹 /leaderboard - Iň ýokary oýunçylar.\n` +
      `🔹 /withdraw - TMT çykarma.\n` +
      `🔹 /promocode - Promokod girizmek.\n` +
      `🔹 /boss - Boss oýunlary görüp oýnaň.\n\n` +
      `Baş menýu üçin /menu ýazyň.`;
    await sendMessage(fromId, helpText, { parse_mode: "Markdown" });
    return;
  }

  if (text.startsWith("/menu")) {
    await sendMainMenu(fromId);
    return;
  }

  if (text.startsWith("/profile")) {
    await sendProfile(fromId);
    return;
  }

  if (text.startsWith("/leaderboard")) {
    await sendLeaderboard(fromId, 0);
    return;
  }

  if (text.startsWith("/battle")) {
    if (queue.includes(fromId)) {
      await sendMessage(fromId, "Siz eýýäm nobatda. Garşydaşyňyza garaşyň.");
      return;
    }
    if (battles[fromId]) {
      await sendMessage(fromId, "Siz eýýäm oýunda. Ilki soňky oýuny tamamlaň.");
      return;
    }
    queue.push(fromId);
    await sendMessage(fromId, "🔍 Garşydaş gözlenýär…");

    searchTimeouts[fromId] = setTimeout(async () => {
      const idx = queue.indexOf(fromId);
      if (idx !== -1) {
        queue.splice(idx, 1);
        delete searchTimeouts[fromId];
        await sendMessage(fromId, "⏱️ Gözleg 30 sekunt soň togtadyldy. Garşydaş tapylmady.");
      }
    }, 30_000) as unknown as number;

    if (queue.length >= 2) {
      const [p1, p2] = queue.splice(0, 2);
      if (searchTimeouts[p1]) { clearTimeout(searchTimeouts[p1]); delete searchTimeouts[p1]; }
      if (searchTimeouts[p2]) { clearTimeout(searchTimeouts[p2]); delete searchTimeouts[p2]; }
      await startBattle(p1, p2, false);
    }
    return;
  }

  if (text.startsWith("/realbattle")) {
    const profile = await getProfile(fromId);
    if (!profile || profile.tmt < 1) {
      await sendMessage(fromId, "❌ TMT + Kubok oýna uçin iň az 1 TMT ýüki bolmaly.");
      return;
    }
    if (trophyQueue.includes(fromId)) {
      await sendMessage(fromId, "Siz eýýäm Kubok nobatynda.");
      return;
    }
    if (battles[fromId]) {
      await sendMessage(fromId, "Siz eýýäm oýunda.");
      return;
    }
    // reserve 1 TMT
    await updateProfile(fromId, { tmt: -1 });
    trophyQueue.push(fromId);
    await sendMessage(fromId, "🔍 Kubokly duşuşyk üçin garşydaş gözlenýär... (1 TMT saklanyldy)");

    searchTimeouts[fromId] = setTimeout(async () => {
      const idx = trophyQueue.indexOf(fromId);
      if (idx !== -1) {
        trophyQueue.splice(idx, 1);
        delete searchTimeouts[fromId];
        await updateProfile(fromId, { tmt: 1 });
        await sendMessage(fromId, "⏱️ Gözleg togtadyldy. 1 TMT yzyna gaýtaryldy.");
      }
    }, 30_000) as unknown as number;

    if (trophyQueue.length >= 2) {
      const [p1, p2] = trophyQueue.splice(0, 2);
      if (searchTimeouts[p1]) { clearTimeout(searchTimeouts[p1]); delete searchTimeouts[p1]; }
      if (searchTimeouts[p2]) { clearTimeout(searchTimeouts[p2]); delete searchTimeouts[p2]; }
      // deduct second player's deposit
      await updateProfile(p2, { tmt: -1 });
      await startBattle(p1, p2, true);
    }
    return;
  }

  // withdrawal process
  if (text.startsWith("/withdraw")) {
    const profile = await getProfile(fromId);
    if (!profile) {
      await sendMessage(fromId, "❌ Çykarmak üçin profil gerek. Ilki oýna başlaň.");
      return;
    }
    await handleWithdrawal(fromId, "");
    return;
  }

  // admin commands
  if (text.startsWith("/addtouser")) {
    if (username !== ADMIN_USERNAME) { await sendMessage(fromId, "❌ Buýruk üçin admin däl."); return; }
    const parts = text.split(/\s+/);
    if (parts.length < 4) { await sendMessage(fromId, "Ulanyş: /addtouser tmt <userId> <amount> ýa-da /addtouser trophies <userId> <amount>"); return; }
    const type = parts[1];
    const userId = parts[2];
    const amount = parseFloat(parts[3]);
    if (isNaN(amount)) { await sendMessage(fromId, "San bolmaly."); return; }
    if (type === "tmt") {
      await updateProfile(userId, { tmt: amount });
      await sendMessage(fromId, `✅ ${amount} TMT goşuldy ID:${userId}`);
    } else if (type === "trophies") {
      await updateProfile(userId, { trophies: amount });
      await sendMessage(fromId, `✅ ${amount} kubok goşuldy ID:${userId}`);
    } else {
      await sendMessage(fromId, "Tüp: 'tmt' ýa-da 'trophies' ulanyň.");
    }
    return;
  }

  if (text.startsWith("/globalmessage")) {
    if (username !== ADMIN_USERNAME) { await sendMessage(fromId, "❌ Admin däl."); return; }
    globalMessageStates[fromId] = true;
    await sendMessage(fromId, "✏️ Global bildiriji ýaz (tassyklamak üçin ENTER basyň):");
    return;
  }

  // promocode admin creation: /createpromocode CODE AMOUNT USES
  if (text.startsWith("/createpromocode")) {
    if (username !== ADMIN_USERNAME) { await sendMessage(fromId, "❌ Admin däl."); return; }
    const parts = text.split(/\s+/);
    if (parts.length < 4) { await sendMessage(fromId, "Ulanyş: /createpromocode <CODE> <amount> <uses>"); return; }
    const code = parts[1].toUpperCase();
    const amount = parseFloat(parts[2]);
    const uses = parseInt(parts[3]);
    if (!code || isNaN(amount) || isNaN(uses) || uses <= 0) { await sendMessage(fromId, "Nädogry parametrler."); return; }
    await createPromo(code, amount, uses);
    await sendMessage(fromId, `✅ Promokod döredildi: ${code} — ${amount} TMT — ${uses} gezek.`);
    return;
  }

  // user /promocode flow
  if (text.startsWith("/promocode")) {
    promoStates[fromId] = true;
    await sendMessage(fromId, "🔑 Promokody giriziň:");
    return;
  }
  if (promoStates[fromId]) {
    // user sent the code
    const code = text.trim().toUpperCase();
    const promo = await getPromo(code);
    if (!promo) { await sendMessage(fromId, "❌ Bu promokod tapylmady."); delete promoStates[fromId]; return; }
    if (promo.usesLeft <= 0) { await sendMessage(fromId, "❌ Bu promokodyň düzümi gutardy."); delete promoStates[fromId]; return; }
    const used = await hasUserUsedPromo(code, fromId);
    if (used) { await sendMessage(fromId, "❌ Siz bu promokody eýýäm ulandyňyz."); delete promoStates[fromId]; return; }
    // give amount
    await updateProfile(fromId, { tmt: promo.amount });
    await usePromoForUser(code, fromId);
    await sendMessage(fromId, `🎉 Promokod kabul edildi! ${promo.amount} TMT size goşuldy.`);
    delete promoStates[fromId];
    return;
  }

  // boss creation admin: admin runs /createboss then sends a photo with caption "Name|rounds|count|reward"
  if (text.startsWith("/createboss")) {
    if (username !== ADMIN_USERNAME) { await sendMessage(fromId, "❌ Admin däl."); return; }
    bossCreationStates[fromId] = { step: "await_photo" };
    await sendMessage(fromId, "📸 Boss üçin surat iberiň we kapsarynda şu format ulanyň:\n`<name>|<rounds>|<count>|<tmtReward>`\nMeselem: `Guly|3|10|1`", { parse_mode: "Markdown" });
    return;
  }

  // user sees bosses with /boss
  if (text.startsWith("/boss")) {
    const bosses = await listBosses();
    if (!bosses || bosses.length === 0) { await sendMessage(fromId, "Häzirlikçe boss ýok."); return; }
    for (const b of bosses) {
      const caption = `👾 *${b.name}*\nTäze howa: ${b.count}\nTur sany: ${b.rounds}\nÝeňse aljak TMT: ${b.reward}`;
      if (b.photoFileId) await sendPhoto(fromId, b.photoFileId, caption, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Oýna", callback_data: `bossplay:${b.name}` }]] } });
      else await sendMessage(fromId, caption, { reply_markup: { inline_keyboard: [[{ text: "Oýna", callback_data: `bossplay:${b.name}` }]] }, parse_mode: "Markdown" });
    }
    return;
  }

  // if unknown
  await sendMessage(fromId, "❓ Näbelli buýruk. Kömek üçin /help ýazyň.");
}

// -------------------- Webhook server --------------------
serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    if (url.pathname !== SECRET_PATH) return new Response("Not found", { status: 404 });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const update = await req.json();

    // handle message
    if (update.message) {
      const msg = update.message;
      const from = msg.from;
      const chatId = String(msg.chat.id);
      const fromId = String(from.id);
      const username = from.username;
      const displayName = msg.from.first_name || msg.from.username || fromId;

      // initialize profile
      await initProfile(fromId, username, displayName);

      // admin global message state
      if (globalMessageStates[fromId] && msg.text) {
        globalMessageStates[fromId] = false;
        // broadcast
        const text = msg.text;
        for await (const entry of kv.list({ prefix: ["profiles"] })) {
          const p = entry.value as Profile;
          if (!p) continue;
          await sendMessage(p.id, `📢 *Global Bildiriş:*\n\n${text}`, { parse_mode: "Markdown" });
        }
        await sendMessage(fromId, "✅ Global bildiriş ugratdyňyz.");
        return new Response("OK");
      }

      // handle boss creation: expecting photo with caption in correct format
      if (bossCreationStates[fromId] && bossCreationStates[fromId].step === "await_photo" && msg.photo) {
        // get largest photo file_id
        const photos = msg.photo as any[];
        const largest = photos[photos.length - 1];
        const fileId = largest.file_id;
        const caption = msg.caption || "";
        const parts = caption.split("|").map(s => s.trim());
        if (parts.length < 4) {
          await sendMessage(fromId, "❌ Kapsynda dogry format ýok. Format: <name>|<rounds>|<count>|<tmtReward>");
          delete bossCreationStates[fromId];
          return new Response("OK");
        }
        const name = parts[0];
        const rounds = parseInt(parts[1]);
        const count = parseInt(parts[2]);
        const reward = parseFloat(parts[3]);
        if (!name || isNaN(rounds) || isNaN(count) || isNaN(reward)) {
          await sendMessage(fromId, "❌ Parametrlerde näsazlyk. Täzeden synanyşyň.");
          delete bossCreationStates[fromId];
          return new Response("OK");
        }
        const boss = { name, rounds, count, reward, photoFileId: fileId };
        await saveBoss(boss);
        delete bossCreationStates[fromId];
        await sendMessage(fromId, `✅ Boss "${name}" döredildi. Count: ${count}, Rounds: ${rounds}, Reward: ${reward} TMT.`);
        return new Response("OK");
      }

      // if message is a photo but not boss creation, ignore
      // handle /promocode text continuing flow
      if (promoStates[fromId] && msg.text) {
        const code = msg.text.trim().toUpperCase();
        const promo = await getPromo(code);
        if (!promo) { await sendMessage(fromId, "❌ Bu promokod tapylmady."); delete promoStates[fromId]; return new Response("OK"); }
        if (promo.usesLeft <= 0) { await sendMessage(fromId, "❌ Bu promokodyň düzümi gutardy."); delete promoStates[fromId]; return new Response("OK"); }
        const used = await hasUserUsedPromo(code, fromId);
        if (used) { await sendMessage(fromId, "❌ Siz bu promokody eýýäm ulandyňyz."); delete promoStates[fromId]; return new Response("OK"); }
        await updateProfile(fromId, { tmt: promo.amount });
        await usePromoForUser(code, fromId);
        await sendMessage(fromId, `🎉 Promokod kabul edildi! ${promo.amount} TMT size goşuldy.`);
        delete promoStates[fromId];
        return new Response("OK");
      }

      // handle withdrawal state text
      if (withdrawalStates[fromId] && msg.text) {
        await handleWithdrawal(fromId, msg.text.trim());
        return new Response("OK");
      }

      // ignore chat while in queue or battles for normal text (so they don't break states)
      if (queue.includes(fromId) || trophyQueue.includes(fromId) || battles[fromId]) {
        return new Response("OK");
      }

      // catch normal commands or other texts
      if (msg.text && msg.text.startsWith("/")) {
        await handleCommand(fromId, username, displayName, msg.text.trim());
        return new Response("OK");
      }

      // unknown text
      if (msg.text) {
        await sendMessage(fromId, "❓ Näbelli maglumat. Buýruk üçin /help ýa-da /menu yazyp görüň.");
        return new Response("OK");
      }

      return new Response("OK");
    }

    // handle callback_query
    else if (update.callback_query) {
      const cb = update.callback_query;
      const fromId = String(cb.from.id);
      const data = cb.data ?? null;
      const message = cb.message ? { chat: { id: cb.message.chat.id }, message_id: cb.message.message_id } : null;
      await handleCallback(fromId, data, cb.id, message);

      // handle bossplay callback: play vs boss (callback_data 'bossplay:Name')
      if (data && data.startsWith("bossplay:")) {
        const parts = data.split(":");
        const bossName = parts[1];
        // quick guard to prevent double triggers
        if (bossPlayLock[fromId]) { await answerCallbackQuery(cb.id, "Ýüklenýär, biraz garaşyň..."); return new Response("OK"); }
        bossPlayLock[fromId] = true;

        const boss = await getBoss(bossName);
        if (!boss) { await answerCallbackQuery(cb.id, "Bu boss ýok ýa-da täzeden barlaň.", true); bossPlayLock[fromId] = false; return new Response("OK"); }
        if (boss.count <= 0) { await answerCallbackQuery(cb.id, "Bu bossyň ýeterlik sany ýok.", true); bossPlayLock[fromId] = false; return new Response("OK"); }

        // check if user already played this boss before (permanent one-play rule)
        const playedRes = await kv.get(["bossplayed", fromId, bossName]);
        if (playedRes.value) { await answerCallbackQuery(cb.id, "Siz bu boss bilen oýnan ozal.", true); bossPlayLock[fromId] = false; return new Response("OK"); }

        // start a quick game vs boss: best of boss.rounds (we will play 1 round for simplicity, or you can extend)
        const pId = fromId;
        // generate small battle object for single-player
        const singleBattle = {
          players: [pId, `boss:${bossName}`],
          board: createEmptyBoard(),
          turn: pId,
          marks: { [pId]: "X", [`boss:${bossName}`]: "O" },
          messageIds: {} as Record<string, number>,
          round: 1,
          roundsTotal: boss.rounds,
          bossName,
        };
        battles[pId] = singleBattle;

        // send boss stats and start
        const header = `👾 *Boss: ${boss.name}* — Tur: ${boss.rounds} | Gala: ${boss.count} | Mukdar: ${boss.reward} TMT`;
        if (boss.photoFileId) {
          await sendPhoto(pId, boss.photoFileId, `${header}\n\nOýnaň ýa-da - tabşyrmagyňyz mümkin.`, { parse_mode: "Markdown", reply_markup: makeInlineKeyboard(singleBattle.board) });
        } else {
          await sendMessage(pId, `${header}\n\nOýnaň ýa-da - tabşyrmagyňyz mümkin.`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: makeInlineKeyboard(singleBattle.board).inline_keyboard } });
        }

        await answerCallbackQuery(cb.id, "Boss oýnuna başlandy!");
        bossPlayLock[fromId] = false;
        return new Response("OK");
      }

      return new Response("OK");
    }

    return new Response("OK");
  } catch (e) {
    console.error("server error", e);
    return new Response("Error", { status: 500 });
  }
});





