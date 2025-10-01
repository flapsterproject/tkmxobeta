// main.ts
// Telegram Tic-Tac-Toe Bot (Deno) - Fixed, improved & extended version
// Features: matchmaking (/battle), trophy battles (/realbattle), private-game with inline buttons,
// profiles with stats (Deno KV), leaderboard with pagination, admin (/addtouser, /createpromocode, /createboss, /globalmessage)
// Match = best of 3 rounds (configurable for bosses)
// Withdrawal functionality (/withdraw)
// New: Subscription check (@TkmXO), Promocodes, Boss battles (vs AI), Main menu with inline buttons
// All messages in Turkmen language
// New: Referral system - 0.2 TMT per new referral who starts the bot first time
//
// Notes: Requires BOT_TOKEN env var and Deno KV. Deploy as webhook at SECRET_PATH.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const TOKEN = Deno.env.get("BOT_TOKEN")!;
if (!TOKEN) throw new Error("BOT_TOKEN env var is required");
const API = `https://api.telegram.org/bot${TOKEN}`;
const SECRET_PATH = "/tkmxo"; // make sure webhook path matches
const CHANNEL = "@TkmXO";
const BOT_USERNAME = "TkmXOBot"; // Adjust to your bot's username

// Deno KV
const kv = await Deno.openKv();

const ADMIN_USERNAME = "Masakoff"; // without @

// runtime storages
let queue: string[] = [];
let trophyQueue: string[] = [];
const battles: Record<string, any> = {};
const searchTimeouts: Record<string, number> = {};

// State helpers using KV
async function getWithdrawalState(userId: string): Promise<{ amount: number; step: "amount" | "phone" } | null> {
  const res = await kv.get<{ amount: number; step: "amount" | "phone" }>(["states", "withdrawal", userId]);
  return res.value;
}

async function setWithdrawalState(userId: string, state: { amount: number; step: "amount" | "phone" } | null) {
  if (state) {
    await kv.set(["states", "withdrawal", userId], state);
  } else {
    await kv.delete(["states", "withdrawal", userId]);
  }
}

async function getPromocodeState(userId: string): Promise<boolean> {
  const res = await kv.get<boolean>(["states", "promocode", userId]);
  return res.value ?? false;
}

async function setPromocodeState(userId: string, active: boolean) {
  if (active) {
    await kv.set(["states", "promocode", userId], true);
  } else {
    await kv.delete(["states", "promocode", userId]);
  }
}

async function getBossState(userId: string): Promise<boolean> {
  const res = await kv.get<boolean>(["states", "boss", userId]);
  return res.value ?? false;
}

async function setBossState(userId: string, active: boolean) {
  if (active) {
    await kv.set(["states", "boss", userId], true);
  } else {
    await kv.delete(["states", "boss", userId]);
  }
}

async function getCreateBossState(userId: string): Promise<boolean> {
  const res = await kv.get<boolean>(["states", "createboss", userId]);
  return res.value ?? false;
}

async function setCreateBossState(userId: string, active: boolean) {
  if (active) {
    await kv.set(["states", "createboss", userId], true);
  } else {
    await kv.delete(["states", "createboss", userId]);
  }
}

async function getGlobalMessageState(userId: string): Promise<boolean> {
  const res = await kv.get<boolean>(["states", "globalmessage", userId]);
  return res.value ?? false;
}

async function setGlobalMessageState(userId: string, active: boolean) {
  if (active) {
    await kv.set(["states", "globalmessage", userId], true);
  } else {
    await kv.delete(["states", "globalmessage", userId]);
  }
}

// -------------------- Telegram helpers --------------------
async function sendMessage(chatId: string | number, text: string, options: any = {}): Promise<number | null> {
  try {
    const body: any = { chat_id: chatId, text, ...options };
    const res = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.result?.message_id ?? null;
  } catch (e) {
    console.error("sendMessage error", e);
    return null;
  }
}

async function sendPhoto(chatId: string | number, photo: string, options: any = {}) {
  try {
    const body: any = { chat_id: chatId, photo, ...options };
    await fetch(`${API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("sendPhoto error", e);
  }
}

async function editMessageText(chatId: string | number, messageId: number, text: string, options: any = {}) {
  try {
    const body = { chat_id: chatId, message_id: messageId, text, ...options };
    await fetch(`${API}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn("editMessageText failed", e?.message ?? e);
  }
}

async function answerCallbackQuery(id: string, text = "", showAlert = false) {
  try {
    await fetch(`${API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, text, show_alert: showAlert }),
    });
  } catch (e) {
    console.warn("answerCallbackQuery failed", e?.message ?? e);
  }
}

// -------------------- Subscription check --------------------
async function isSubscribed(userId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API}/getChatMember?chat_id=${CHANNEL}&user_id=${userId}`);
    const data = await res.json();
    if (!data.ok) return false;
    const status = data.result.status;
    return ['creator', 'administrator', 'member'].includes(status);
  } catch (e) {
    console.error("isSubscribed error", e);
    return false;
  }
}

// -------------------- Profile helpers --------------------
type Profile = {
  id: string;
  username?: string;
  displayName: string;
  trophies: number;
  tmt: number; // TMT balance (number)
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  lastActive: number;
  referrals: number;
};

function getDisplayName(p: Profile) {
  if (p.username) return `@${p.username}`;
  return p.displayName && p.displayName !== "" ? p.displayName : `ID:${p.id}`;
}

async function initProfile(userId: string, username?: string, displayName?: string): Promise<{ profile: Profile; isNew: boolean }> {
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
      referrals: 0,
    };
    await kv.set(key, profile);
    return { profile, isNew: true };
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
    await kv.set(key, existing); // Always save to update lastActive
    return { profile: existing, isNew: false };
  }
}

async function getProfile(userId: string): Promise<Profile | null> {
  const res = await kv.get(["profiles", userId]);
  return (res.value as Profile) ?? null;
}

async function updateProfile(userId: string, delta: Partial<Profile>) {
  const existing = (await getProfile(userId)) || (await initProfile(userId)).profile;
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
    referrals: (existing.referrals || 0) + (delta.referrals ?? 0),
    lastActive: Date.now(),
    id: existing.id,
  };
  await kv.set(["profiles", userId], newProfile);
  return newProfile;
}

function getRank(trophies: number) {
  if (trophies < 500) return "🌱 Täze";
  if (trophies < 1000) return "🥉 Bronza";
  if (trophies < 1500) return "🥈 Kümüş";
  if (trophies < 2000) return "🥇 Altyn";
  if (trophies < 2500) return "🏆 Platin";
  return "💎 Brilliant";
}

async function sendProfile(chatId: string) {
  const p = (await getProfile(chatId))!;
  const winRate = p.gamesPlayed ? ((p.wins / p.gamesPlayed) * 100).toFixed(1) : "0";
  const referralLink = `https://t.me/${BOT_USERNAME}?start=${p.id}`;
  const msg =
    `🏅 *Profil: ${getDisplayName(p)}*\n\n` +
    `🆔 ID: \`${p.id}\`\n\n` +
    `🏆 Kuboklar: *${p.trophies}*\n` +
    `💰 TMT Balans: *${p.tmt}*\n` +
    `🏅 Dereje: *${getRank(p.trophies)}*\n` +
    `🎲 Oýnalan oýunlar: *${p.gamesPlayed}*\n` +
    `✅ Ýeňişler: *${p.wins}* | ❌ Utulyşlar: *${p.losses}* | 🤝 Deňlikler: *${p.draws}*\n` +
    `📈 Ýeňiş göterimi: *${winRate}%*\n` +
    `👥 Referallar: *${p.referrals}*\n\n` +
    `🔗 Referral link: \`${referralLink}\``;
  await sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

async function sendUserProfile(adminChatId: string, userId: string) {
  const p = await getProfile(userId);
  if (!p) {
    await sendMessage(adminChatId, `❌ Ulanyjy ID:${userId} tapylmady.`);
    return;
  }
  const winRate = p.gamesPlayed ? ((p.wins / p.gamesPlayed) * 100).toFixed(1) : "0";
  const referralLink = `https://t.me/${BOT_USERNAME}?start=${p.id}`;
  const msg =
    `🏅 *Profil: ${getDisplayName(p)}*\n\n` +
    `🆔 ID: \`${p.id}\`\n\n` +
    `🏆 Kuboklar: *${p.trophies}*\n` +
    `💰 TMT Balans: *${p.tmt}*\n` +
    `🏅 Dereje: *${getRank(p.trophies)}*\n` +
    `🎲 Oýnalan oýunlar: *${p.gamesPlayed}*\n` +
    `✅ Ýeňişler: *${p.wins}* | ❌ Utulyşlar: *${p.losses}* | 🤝 Deňlikler: *${p.draws}*\n` +
    `📈 Ýeňiş göterimi: *${winRate}%*\n` +
    `👥 Referallar: *${p.referrals}*\n\n` +
    `🔗 Referral link: \`${referralLink}\``;
  await sendMessage(adminChatId, msg, { parse_mode: "Markdown" });
}

// -------------------- Leaderboard helpers --------------------
async function getLeaderboard(top = 10, offset = 0): Promise<{top: Profile[], total: number}> {
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
  const filtered = players.filter(p => !p.id.startsWith("boss_"));
  return {top: filtered.slice(offset, offset + top), total: filtered.length};
}

async function sendLeaderboard(chatId: string, page = 0) {
  const perPage = 10;
  const offset = page * perPage;
  const {top: topPlayers, total} = await getLeaderboard(perPage, offset);

  if (topPlayers.length === 0) {
    const msg = page === 0 ? "Entäk oýunçy ýok! Liderler tablosyna çykmak üçin oýna başlaň!" : "Indiki sahypa ýok!";
    await sendMessage(chatId, msg);
    return;
  }

  let msg = `🏆 *Liderler* — Sahypa ${page + 1}\n\n`;
  topPlayers.forEach((p, i) => {
    const rankNum = offset + i + 1;
    const name = getDisplayName(p);
    const winRate = p.gamesPlayed ? ((p.wins / p.gamesPlayed) * 100).toFixed(1) : "0";
    msg += `*${rankNum}.* [${name}](tg://user?id=${p.id}) — 🏆 *${p.trophies}* | 📈 *${winRate}%*\n`;
  });

  const keyboard: any = { inline_keyboard: [] };
  const row: any[] = [];
  if (page > 0) row.push({ text: "⬅️ Öňki", callback_data: `leaderboard:${page - 1}` });
  if (offset + topPlayers.length < total) row.push({ text: "Indiki ➡️", callback_data: `leaderboard:${page + 1}` });
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
      const callback_data = disabled ? "noop" : `move:${i}`;
      row.push({ text, callback_data });
    }
    keyboard.push(row);
  }
  keyboard.push([{ text: "🏳️ Tabşyrmak", callback_data: "surrender" }]);
  return { inline_keyboard: keyboard };
}

// -------------------- AI for Boss (Minimax) --------------------
function minimax(newBoard: string[], player: string, aiMark: string, humanMark: string): { score: number; index?: number } {
  const availSpots = newBoard.map((val, idx) => val === "" ? idx : null).filter(v => v !== null) as number[];

  const result = checkWin(newBoard);
  if (result?.winner === aiMark) return { score: 10 };
  if (result?.winner === humanMark) return { score: -10 };
  if (result?.winner === "draw") return { score: 0 };

  const moves: { index: number; score: number }[] = [];

  for (const index of availSpots) {
    newBoard[index] = player;
    const score = minimax(newBoard, player === aiMark ? humanMark : aiMark, aiMark, humanMark).score;
    moves.push({ index, score });
    newBoard[index] = "";
  }

  let bestMove;
  if (player === aiMark) {
    let bestScore = -Infinity;
    for (const move of moves) {
      if (move.score > bestScore) {
        bestScore = move.score;
        bestMove = move;
      }
    }
  } else {
    let bestScore = Infinity;
    for (const move of moves) {
      if (move.score < bestScore) {
        bestScore = move.score;
        bestMove = move;
      }
    }
  }
  return bestMove ?? { score: 0 };
}

function computerMove(board: string[], aiMark: string, humanMark: string): number {
  const result = minimax([...board], aiMark, aiMark, humanMark);
  return result.index ?? -1;
}

// -------------------- Battle control --------------------
async function startBattle(p1: string, p2: string, isTrophyBattle: boolean = false, rounds: number = 3) {
  if (searchTimeouts[p1]) {
    clearTimeout(searchTimeouts[p1]);
    delete searchTimeouts[p1];
  }
  if (searchTimeouts[p2]) {
    clearTimeout(searchTimeouts[p2]);
    delete searchTimeouts[p2];
  }

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
    isTrophyBattle: isTrophyBattle,
    isBoss: false,
    rounds,
  };
  battles[p1] = battle;
  battles[p2] = battle;

  await initProfile(p1);
  await initProfile(p2);

  const battleTypeText = isTrophyBattle ? "🏆 *TMT üçin söweş*" : "⚔️ *Kubok üçin söweş*";
  const stakeText = isTrophyBattle ? "\n\nGoýumlar: Iki oýunçy hem 1 TMT goýýar. Ýeňiji +0.75 TMT alýar." : "";

  await sendMessage(p1, `${battleTypeText}\n\nSen ❌ (X).${stakeText}\n\n*Oýun tertibi:* ${rounds} turdan ybarat vs ID:${p2}`, { parse_mode: "Markdown" });
  await sendMessage(p2, `${battleTypeText}\n\nSen ⭕ (O).${stakeText}\n\n*Oýun tertibi:* ${rounds} turdan ybarat vs ID:${p1}`, { parse_mode: "Markdown" });
  await sendRoundStart(battle);
}

async function startBossBattle(user: string, bossName: string, boss: any) {
  const bossId = `boss_${bossName}`;
  const battle = {
    players: [user, bossId],
    board: createEmptyBoard(),
    turn: user,
    marks: { [user]: "X", [bossId]: "O" },
    messageIds: {} as Record<string, number>,
    idleTimerId: undefined as number | undefined,
    moveTimerId: undefined as number | undefined,
    round: 1,
    roundWins: { [user]: 0, [bossId]: 0 },
    isTrophyBattle: false,
    isBoss: true,
    bossName,
    bossData: boss,
    rounds: boss.rounds,
  };
  battles[user] = battle;
  battles[bossId] = battle;

  await sendPhoto(user, boss.photoId, { caption: `Boss: ${bossName}\nTur sanaw: ${boss.rounds}\nBaha: ${boss.reward} TMT (ýeňişde)` });
  await sendMessage(user, "Boss bilen söweş başlaýar! Sen ❌ (X).", { parse_mode: "Markdown" });
  await sendRoundStart(battle);
}

function headerForPlayer(battle: any, player: string) {
  const opponent = battle.players.find((p: string) => p !== player)!;
  const yourMark = battle.marks[player];
  const opponentMark = battle.marks[opponent];
  const battleTypeText = battle.isBoss ? "🤖 *Boss bilen söweş*" : battle.isTrophyBattle ? "🏆 *TMT söweşi*" : "⚔️ *Kubok söweşi*";
  const opponentDisplay = battle.isBoss ? battle.bossName : `ID:${opponent}`;
  return `${battleTypeText} — Sen (${yourMark}) vs ${opponentDisplay} (${opponentMark})`;
}

async function endTurnIdle(battle: any) {
  const loser = battle.turn;
  const winner = battle.players.find((p: string) => p !== loser)!;

  await sendMessage(loser, "⚠️ Hereketde gijä galdyňyz. Siz tabşyrdyňyz.");
  if (!battle.isBoss) await sendMessage(winner, "⚠️ Garşydaş gijä galdy. Siz ýeňdiňiz!");

  if (battle.idleTimerId) {
    clearTimeout(battle.idleTimerId);
    delete battle.idleTimerId;
  }
  if (battle.moveTimerId) {
    clearTimeout(battle.moveTimerId);
    delete battle.moveTimerId;
  }

  await finishMatch(battle, { winner: winner, loser: loser });
}

async function sendRoundStart(battle: any) {
  for (const player of battle.players.filter((p: string) => !p.startsWith("boss_"))) {
    const header = headerForPlayer(battle, player);
    const yourTurn = battle.turn === player;
    const text =
      `${header}\n\n` +
      `*Tur ${battle.round}/${battle.rounds}*\n` +
      `📊 Hesap: ${battle.roundWins[battle.players[0]]} - ${battle.roundWins[battle.players[1]]}\n` +
      `🎲 Hereket: ${yourTurn ? "*Seniň hereketiň*" : "Garşydaşyň hereketi"}\n` +
      boardToText(battle.board);
    const msgId = await sendMessage(player, text, { reply_markup: makeInlineKeyboard(battle.board), parse_mode: "Markdown" });
    if (msgId) battle.messageIds[player] = msgId;
  }

  if (battle.idleTimerId) {
    clearTimeout(battle.idleTimerId);
  }
  battle.idleTimerId = setTimeout(() => endBattleIdle(battle), 3 * 60 * 1000); // Reduced to 3 minutes

  if (battle.moveTimerId) {
    clearTimeout(battle.moveTimerId);
  }
  battle.moveTimerId = setTimeout(() => endTurnIdle(battle), 30 * 1000); // Reduced to 30 seconds

  if (battle.isBoss && battle.turn.startsWith("boss_")) {
    await makeBossMove(battle);
  }
}

async function endBattleIdle(battle: any) {
  const [p1, p2] = battle.players;
  if (!p2.startsWith("boss_")) await sendMessage(p2, "⚠️ Oýun hereketsizlik sebäpli ýatyryldy (3 minut).");
  await sendMessage(p1, "⚠️ Oýun hereketsizlik sebäpli ýatyryldy (3 minut).");

  if (battle.isTrophyBattle) {
    await updateProfile(p1, { tmt: 1 });
    if (!p2.startsWith("boss_")) await updateProfile(p2, { tmt: 1 });
    await sendMessage(p1, "💸 Hereketsizlik üçin 1 TMT yzyna gaýtaryldy.");
    if (!p2.startsWith("boss_")) await sendMessage(p2, "💸 Hereketsizlik üçin 1 TMT yzyna gaýtaryldy.");
  }

  delete battles[p1];
  delete battles[p2];
}

async function finishMatch(battle: any, result: { winner?: string; loser?: string; draw?: boolean }) {
  try {
    if (battle.idleTimerId) {
      clearTimeout(battle.idleTimerId);
      delete battle.idleTimerId;
    }
    if (battle.moveTimerId) {
      clearTimeout(battle.moveTimerId);
      delete battle.moveTimerId;
    }
    const [p1, p2] = battle.players;

    for (const player of battle.players.filter((p: string) => !p.startsWith("boss_"))) {
      const msgId = battle.messageIds[player];
      const header = headerForPlayer(battle, player);
      let text: string;
      if (result.draw) {
        text = `${header}\n\n*Oýun Netijesi:* 🤝 *Deňlik!*\n${boardToText(battle.board)}`;
      } else if (result.winner === player) {
        text = `${header}\n\n*Oýun Netijesi:* 🎉 *Siz ýeňdiňiz!*\n${boardToText(battle.board)}`;
      } else {
        text = `${header}\n\n*Oýun Netijesi:* 😢 *Siz utuldyňyz.*\n${boardToText(battle.board)}`;
      }
      if (msgId) {
        await editMessageText(player, msgId, text, { reply_markup: makeInlineKeyboard(battle.board, true), parse_mode: "Markdown" });
      } else {
        await sendMessage(player, text, { parse_mode: "Markdown" });
      }
    }

    if (result.draw) {
      await updateProfile(p1, { gamesPlayed: 1, draws: 1 });
      if (!p2.startsWith("boss_")) await updateProfile(p2, { gamesPlayed: 1, draws: 1 });
      await sendMessage(p1, "🤝 Oýun deňlik boldy!");
      if (!p2.startsWith("boss_")) await sendMessage(p2, "🤝 Oýun deňlik boldy!");

      if (battle.isTrophyBattle) {
        await updateProfile(p1, { tmt: 1 });
        await updateProfile(p2, { tmt: 1 });
        await sendMessage(p1, "💸 Deňlik üçin 1 TMT yzyna gaýtaryldy.");
        await sendMessage(p2, "💸 Deňlik üçin 1 TMT yzyna gaýtaryldy.");
      }
      if (battle.isBoss) {
        await sendMessage(p1, "Gyzgyn deňlik boldy, ýöne baha ýok.");
      }
    } else if (result.winner) {
      const winner = result.winner!;
      const loser = result.loser!;
      await initProfile(winner);
      if (!loser.startsWith("boss_")) await initProfile(loser);

      await updateProfile(winner, { gamesPlayed: 1, wins: 1, trophies: battle.isBoss ? 0 : 1 });
      if (!loser.startsWith("boss_")) await updateProfile(loser, { gamesPlayed: 1, losses: 1, trophies: -1 });
      await sendMessage(winner, `🎉 Siz ýeňdiňiz!\n🏆 *+1 kubok* (vs ${battle.isBoss ? battle.bossName : `ID:${loser}`})`, { parse_mode: "Markdown" });
      if (!loser.startsWith("boss_")) await sendMessage(loser, `😢 Siz utuldyňyz.\n🏆 *-1 kubok* (vs ID:${winner})`, { parse_mode: "Markdown" });

      if (battle.isTrophyBattle) {
        await updateProfile(winner, { tmt: 1.75 });
        await sendMessage(winner, "🏆 TMT söweşde ýeňeniňiz üçin +0.75 TMT!");
        await sendMessage(loser, "💔 TMT söweşde utulanyňyz üçin -1 TMT.");
      }
      if (battle.isBoss && winner === p1) {
        await updateProfile(p1, { tmt: battle.bossData.reward });
        await sendMessage(p1, `🎉 Bossy ýeňdiňiz! +${battle.bossData.reward} TMT!`);
      } else if (battle.isBoss) {
        await sendMessage(p1, "Bossdan utuldyň...");
      }
    }

    delete battles[p1];
    delete battles[p2];
  } catch (err) {
    console.error("finishMatch error:", err);
  }
}

// -------------------- Boss move handler --------------------
async function makeBossMove(battle: any) {
  const boss = battle.players.find((p: string) => p.startsWith("boss_"))!;
  const user = battle.players.find((p: string) => !p.startsWith("boss_"))!;
  const mark = battle.marks[boss];
  const humanMark = battle.marks[user];
  const idx = computerMove(battle.board, mark, humanMark);
  if (idx === -1) return; // no move

  battle.board[idx] = mark;

  const winResult = checkWin(battle.board);
  let roundWinner: string | undefined;
  if (winResult) {
    const { winner, line } = winResult as any;
    if (winner !== "draw") {
      roundWinner = battle.players.find((p: string) => battle.marks[p] === winner)!;
      battle.roundWins[roundWinner] = (battle.roundWins[roundWinner] || 0) + 1;
    }

    let boardText = boardToText(battle.board);
    if (line) {
      boardText += `\n🎉 *Çyzyk:* ${line.map((i: number) => i + 1).join("-")}`;
    } else if (winner === "draw") {
      boardText += `\n🤝 *Deňlik!*`;
    }

    const msgId = battle.messageIds[user];
    const header = headerForPlayer(battle, user);
    let text = `${header}\n\n*Tur ${battle.round} Netijesi!*\n`;
    if (winner === "draw") text += `🤝 Deňlik boldy!\n`;
    else text += `${roundWinner === user ? "🎉 Siz turda ýeňdiňiz!" : "😢 Siz turda utuldyňyz"}\n`;
    text += `📊 Hesap: ${battle.roundWins[user]} - ${battle.roundWins[boss]}\n${boardText}`;
    if (msgId) await editMessageText(user, msgId, text, { reply_markup: makeInlineKeyboard(battle.board, true), parse_mode: "Markdown" });
    else await sendMessage(user, text, { parse_mode: "Markdown" });

    // Check if match over
    const neededWins = Math.ceil(battle.rounds / 2);
    if (battle.roundWins[user] >= neededWins || battle.roundWins[boss] >= neededWins || battle.round === battle.rounds) {
      if (battle.roundWins[user] > battle.roundWins[boss]) {
        await finishMatch(battle, { winner: user, loser: boss });
      } else if (battle.roundWins[boss] > battle.roundWins[user]) {
        await finishMatch(battle, { winner: boss, loser: user });
      } else {
        await finishMatch(battle, { draw: true });
      }
      return;
    }

    // Next round
    battle.round++;
    battle.board = createEmptyBoard();
    battle.turn = battle.players[(battle.round - 1) % 2];

    if (battle.moveTimerId) clearTimeout(battle.moveTimerId);
    battle.moveTimerId = setTimeout(() => endTurnIdle(battle), 30 * 1000); // Reduced to 30 seconds

    await sendRoundStart(battle);
    return;
  }

  // Update board for user
  battle.turn = user;
  const header = headerForPlayer(battle, user);
  const text =
    `${header}\n\n` +
    `*Tur: ${battle.round}/${battle.rounds}*\n` +
    `📊 Hesap: ${battle.roundWins[user]} - ${battle.roundWins[boss]}\n` +
    `🎲 Hereket: *Seniň hereketiň*\n` +
    boardToText(battle.board);
  const msgId = battle.messageIds[user];
  if (msgId) await editMessageText(user, msgId, text, { reply_markup: makeInlineKeyboard(battle.board), parse_mode: "Markdown" });
  else await sendMessage(user, text, { reply_markup: makeInlineKeyboard(battle.board), parse_mode: "Markdown" });
}

// -------------------- Callback handler --------------------
async function handleCallback(cb: any) {
  const fromId = String(cb.from.id);
  const data = cb.data ?? null;
  const callbackId = cb.id;
  const username = cb.from.username;
  const displayName = cb.from.first_name || cb.from.username || fromId;

  if (!data) {
    await answerCallbackQuery(callbackId);
    return;
  }

  if (data.startsWith("menu:")) {
    const cmd = data.split(":")[1];
    await handleCommand(fromId, username, displayName, `/${cmd}`);
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

  const battle = battles[fromId];
  if (!battle) {
    if (data === "surrender") {
      await answerCallbackQuery(callbackId, "Siz oýunda däl.", true);
      return;
    }
    await answerCallbackQuery(callbackId);
    return;
  }

  // Reset timers
  if (battle.idleTimerId) {
    clearTimeout(battle.idleTimerId);
    battle.idleTimerId = setTimeout(() => endBattleIdle(battle), 3 * 60 * 1000); // Reduced to 3 minutes
  }

  if (battle.moveTimerId) {
    clearTimeout(battle.moveTimerId);
    battle.moveTimerId = setTimeout(() => endTurnIdle(battle), 30 * 1000); // Reduced to 30 seconds
  }

  if (data === "surrender") {
    const opponent = battle.players.find((p: string) => p !== fromId)!;
    await sendMessage(fromId, "🏳️ Siz tabşyrdyňyz.");
    if (!battle.isBoss) await sendMessage(opponent, "🏳️ Garşydaş tabşyrdy. Siz ýeňdiňiz!");
    await finishMatch(battle, { winner: opponent, loser: fromId });
    await answerCallbackQuery(callbackId, "Siz tabşyrdyňyz.");
    return;
  }

  if (!data.startsWith("move:")) {
    await answerCallbackQuery(callbackId);
    return;
  }

  const idx = parseInt(data.split(":")[1]);
  if (isNaN(idx) || idx < 0 || idx > 8) {
    await answerCallbackQuery(callbackId, "Nädogry hereket.", true);
    return;
  }
  if (battle.turn !== fromId) {
    await answerCallbackQuery(callbackId, "Seniň hereketiň däl.", true);
    return;
  }
  if (battle.board[idx] !== "") {
    await answerCallbackQuery(callbackId, "Bu ýer eýýäm eýelenen.", true);
    return;
  }

  const mark = battle.marks[fromId];
  battle.board[idx] = mark;

  const winResult = checkWin(battle.board);
  let roundWinner: string | undefined;
  if (winResult) {
    const { winner, line } = winResult as any;
    if (winner !== "draw") {
      roundWinner = battle.players.find((p: string) => battle.marks[p] === winner)!;
      battle.roundWins[roundWinner] = (battle.roundWins[roundWinner] || 0) + 1;
    }

    let boardText = boardToText(battle.board);
    if (line) {
      boardText += `\n🎉 *Çyzyk:* ${line.map((i: number) => i + 1).join("-")}`;
    } else if (winner === "draw") {
      boardText += `\n🤝 *Deňlik!*`;
    }

    for (const player of battle.players.filter((p: string) => !p.startsWith("boss_"))) {
      const msgId = battle.messageIds[player];
      const header = headerForPlayer(battle, player);
      let text = `${header}\n\n*Tur ${battle.round} Netijesi!*\n`;
      if (winner === "draw") text += `🤝 Deňlik boldy!\n`;
      else text += `${roundWinner === player ? "🎉 Siz turda ýeňdiňiz!" : "😢 Siz turda utuldyňyz"}\n`;
      text += `📊 Hesap: ${battle.roundWins[battle.players[0]]} - ${battle.roundWins[battle.players[1]]}\n${boardText}`;
      if (msgId) await editMessageText(player, msgId, text, { reply_markup: makeInlineKeyboard(battle.board, true), parse_mode: "Markdown" });
      else await sendMessage(player, text, { parse_mode: "Markdown" });
    }

    // Check if match over
    const neededWins = Math.ceil(battle.rounds / 2);
    if (battle.roundWins[battle.players[0]] >= neededWins || battle.roundWins[battle.players[1]] >= neededWins || battle.round === battle.rounds) {
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

    // Next round
    battle.round++;
    battle.board = createEmptyBoard();
    battle.turn = battle.players[(battle.round - 1) % 2];

    if (battle.moveTimerId) clearTimeout(battle.moveTimerId);
    battle.moveTimerId = setTimeout(() => endTurnIdle(battle), 30 * 1000); // Reduced to 30 seconds

    await sendRoundStart(battle);
    await answerCallbackQuery(callbackId, "Hereket edildi!");
    return;
  }

  // Continue
  battle.turn = battle.players.find((p: string) => p !== fromId)!;
  for (const player of battle.players.filter((p: string) => !p.startsWith("boss_"))) {
    const header = headerForPlayer(battle, player);
    const yourTurn = battle.turn === player;
    const text =
      `${header}\n\n` +
      `*Tur: ${battle.round}/${battle.rounds}*\n` +
      `📊 Hesap: ${battle.roundWins[battle.players[0]]} - ${battle.roundWins[battle.players[1]]}\n` +
      `🎲 Hereket: ${yourTurn ? "*Seniň hereketiň*" : "Garşydaşyň hereketi"}\n` +
      boardToText(battle.board);
    const msgId = battle.messageIds[player];
    if (msgId) await editMessageText(player, msgId, text, { reply_markup: makeInlineKeyboard(battle.board), parse_mode: "Markdown" });
    else await sendMessage(player, text, { reply_markup: makeInlineKeyboard(battle.board), parse_mode: "Markdown" });
  }
  await answerCallbackQuery(callbackId, "Hereket edildi!");

  if (battle.isBoss && battle.turn.startsWith("boss_")) {
    await makeBossMove(battle);
  }
}

// -------------------- Withdrawal functionality --------------------
async function handleWithdrawal(fromId: string, text: string) {
  const state = await getWithdrawalState(fromId);
  if (state) {
    if (state.step === "amount") {
      const amount = parseFloat(text);

      if (isNaN(amount) || amount <= 0) {
        await sendMessage(fromId, "❌ TMT mukdary dogry san bolmaly.");
        return;
      }

      if (amount < 5) {
        await sendMessage(fromId, "❌ Çykarmak üçin iň az 5 TMT gerek.");
        return;
      }

      const profile = await getProfile(fromId);
      if (!profile || profile.tmt < amount) {
        await sendMessage(fromId, `❌ Ýeterlik TMT ýok. Balans: ${profile?.tmt ?? 0} TMT.`);
        await setWithdrawalState(fromId, null);
        return;
      }

      await setWithdrawalState(fromId, { amount, step: "phone" });
      await sendMessage(fromId, "📱 Telefon nomeriňizi giriziň:");
      return;
    } else if (state.step === "phone") {
      const phoneNumber = text.trim();
      if (phoneNumber.length < 5) {
        await sendMessage(fromId, "❌ Dogry telefon giriziň.");
        return;
      }

      const amount = state.amount;
      const profile = await getProfile(fromId);
      if (!profile || profile.tmt < amount) {
        await sendMessage(fromId, "❌ Balans ýeterlik däl. Täzeden synanyşyň.");
        await setWithdrawalState(fromId, null);
        return;
      }

      try {
        await updateProfile(fromId, { tmt: -amount });

        await sendMessage(
          fromId,
          `✅ Çykarma islegi üstünlikli! Mukdar: ${amount} TMT\nTelefon: ${phoneNumber}\nİşlenýär...`,
        );

        const adminProfile = await getProfileByUsername(ADMIN_USERNAME);
        const adminId = adminProfile?.id || `@${ADMIN_USERNAME}`;
        const userDisplayName = getDisplayName(profile);
        const adminMessage = `💰 *ÇYKARMA ISLEGI*\n\nUlanyjy: ${userDisplayName} (ID: ${fromId})\nMukdar: ${amount} TMT\nTelefon: ${phoneNumber}\n\nEl bilen işläň.`;
        await sendMessage(adminId, adminMessage, { parse_mode: "Markdown" });

        await setWithdrawalState(fromId, null);
      } catch (error) {
        console.error("Withdrawal error:", error);
        await sendMessage(fromId, "❌ Näsazlyk ýüze çykdy. Täzeden synanyşyň.");
        await setWithdrawalState(fromId, null);
      }

      return;
    }
  } else {
    await sendMessage(fromId, "💰 Çykarmak isleýän TMT mukdary giriziň:");
    await setWithdrawalState(fromId, { amount: 0, step: "amount" });
    return;
  }
}

async function getProfileByUsername(username: string): Promise<Profile | null> {
  try {
    for await (const entry of kv.list({ prefix: ["profiles"] })) {
      const profile = entry.value as Profile;
      if (!profile) continue;
      if (profile.username === username) return profile;
    }
  } catch (e) {
    console.error("getProfileByUsername error", e);
  }
  return null;
}

// -------------------- Promocode handler --------------------
async function handlePromocodeInput(fromId: string, text: string) {
  const code = text.trim();
  const promoRes = await kv.get(["promocodes", code]);
  if (!promoRes.value) {
    await sendMessage(fromId, "Bu promokod ýok ýa-da ulanylan.");
    await setPromocodeState(fromId, false);
    return;
  }

  const promo = promoRes.value as { maxUses: number; currentUses: number };
  if (promo.currentUses >= promo.maxUses) {
    await sendMessage(fromId, "Bu promokod ýok ýa-da ulanylan.");
    await setPromocodeState(fromId, false);
    return;
  }

  const usedRes = await kv.get(["used_promos", code, fromId]);
  if (usedRes.value) {
    await sendMessage(fromId, "Siz bu promokody eýýäm ulandyňyz.");
    await setPromocodeState(fromId, false);
    return;
  }

  const atomic = kv.atomic()
    .set(["used_promos", code, fromId], true)
    .set(["promocodes", code], { ...promo, currentUses: promo.currentUses + 1 });

  await atomic.commit();

  await updateProfile(fromId, { tmt: 1 });
  await sendMessage(fromId, "✅ Promokod üstünlikli! +1 TMT aldyňyz.");
  await setPromocodeState(fromId, false);
}

// -------------------- Boss input handler --------------------
async function handleBossInput(fromId: string, text: string) {
  const name = text.trim();
  const bossRes = await kv.get(["bosses", name]);
  if (!bossRes.value) {
    await sendMessage(fromId, "Bu boss ýok ýa-da ulanylan.");
    await setBossState(fromId, false);
    return;
  }

  const boss = bossRes.value as { photoId: string; rounds: number; maxUses: number; currentUses: number; reward: number };
  if (boss.currentUses >= boss.maxUses) {
    await sendMessage(fromId, "Bu boss ýok ýa-da ulanylan.");
    await setBossState(fromId, false);
    return;
  }

  const playedRes = await kv.get(["played_boss", name, fromId]);
  if (playedRes.value) {
    await sendMessage(fromId, "Siz bu boss bilen eýýäm oýnadyňyz.");
    await setBossState(fromId, false);
    return;
  }

  const atomic = kv.atomic()
    .set(["played_boss", name, fromId], true)
    .set(["bosses", name], { ...boss, currentUses: boss.currentUses + 1 });

  await atomic.commit();

  await startBossBattle(fromId, name, boss);
  await setBossState(fromId, false);
}

// -------------------- Create boss handler --------------------
async function handleCreateBoss(msg: any, fromId: string) {
  const photo = msg.photo;
  if (!photo) {
    await sendMessage(fromId, "Surat gerek.");
    return;
  }
  const photoId = photo[photo.length - 1].file_id;
  const caption = msg.caption?.trim();
  if (!caption) {
    await sendMessage(fromId, "Ýazgy gerek.");
    return;
  }
  const parts = caption.split(/\s+/);
  if (parts.length < 4) {
    await sendMessage(fromId, "Format: aty turlar sany max_sany baha");
    return;
  }
  const [name, roundsStr, maxStr, rewardStr] = parts;
  const rounds = parseInt(roundsStr);
  const maxUses = parseInt(maxStr);
  const reward = parseFloat(rewardStr);
  if (isNaN(rounds) || isNaN(maxUses) || isNaN(reward) || rounds < 1 || maxUses < 1 || reward <= 0) {
    await sendMessage(fromId, "Nädogry format.");
    return;
  }

  await kv.set(["bosses", name], { photoId, rounds, maxUses, currentUses: 0, reward });
  await sendMessage(fromId, `✅ Boss döredildi: ${name}`);
  await setCreateBossState(fromId, false);
}

// -------------------- Stats for admin --------------------
async function sendStats(chatId: string) {
  let userCount = 0;
  let totalTMTFromPromos = 0;
  let totalGamesPlayed = 0;
  let totalTrophies = 0;
  let totalTMT = 0;
  let bossCount = 0;
  let bossBattlesPlayed = 0;

  // Count users and sum stats
  for await (const entry of kv.list({ prefix: ["profiles"] })) {
    if (!entry.value) continue;
    const p = entry.value as Profile;
    if (p.id.startsWith("boss_")) continue; // Exclude bosses
    userCount++;
    totalGamesPlayed += p.gamesPlayed || 0;
    totalTrophies += p.trophies || 0;
    totalTMT += p.tmt || 0;
  }

  // Sum TMT from promocodes (assuming each use gives 1 TMT)
  for await (const entry of kv.list({ prefix: ["promocodes"] })) {
    if (!entry.value) continue;
    const promo = entry.value as { maxUses: number; currentUses: number };
    totalTMTFromPromos += promo.currentUses;
  }

  // Count bosses and sum battles
  for await (const entry of kv.list({ prefix: ["bosses"] })) {
    if (!entry.value) continue;
    const boss = entry.value as { photoId: string; rounds: number; maxUses: number; currentUses: number; reward: number };
    bossCount++;
    bossBattlesPlayed += boss.currentUses;
  }

  const msg = 
    `📊 *Bot Statistika*\n\n` +
    `👥 Ulanyjylar sany: *${userCount}*\n` +
    `💰 Promokodlar arkaly berlen TMT: *${totalTMTFromPromos}*\n` +
    `🎲 Jemi oýnalan oýunlar: *${totalGamesPlayed}*\n` +
    `🏆 Jemi kuboklar: *${totalTrophies}*\n` +
    `💰 Jemi TMT ulgamynda: *${totalTMT}*\n` +
    `🤖 Bosslar sany: *${bossCount}*\n` +
    `⚔️ Boss söweşleri sany: *${bossBattlesPlayed}*`;

  await sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

// -------------------- User count helper --------------------
async function getUserCount(): Promise<number> {
  let count = 0;
  try {
    for await (const entry of kv.list({ prefix: ["profiles"] })) {
      if (!entry.value) continue;
      const p = entry.value as Profile;
      if (p.id.startsWith("boss_")) continue;
      count++;
    }
  } catch (e) {
    console.error("getUserCount error", e);
  }
  return count;
}

// -------------------- Commands --------------------
async function handleCommand(fromId: string, username: string | undefined, displayName: string, text: string, isNew: boolean) {
  if (!(await isSubscribed(fromId))) {
    await sendMessage(fromId, "Bot ulanmak üçin @TkmXO kanala ýazyl. Ýazyl we täzeden synanyş.", {
      reply_markup: { inline_keyboard: [[{ text: "Ýazyl", url: "https://t.me/TkmXO" }]] }
    });
    return;
  }

  // Close any active states before handling new command
  if (await getWithdrawalState(fromId)) {
    await sendMessage(fromId, "Çykarma sahypasy ýapyldy");
    await setWithdrawalState(fromId, null);
  }
  if (await getPromocodeState(fromId)) {
    await sendMessage(fromId, "Promokod sahypasy ýapyldy");
    await setPromocodeState(fromId, false);
  }
  if (await getBossState(fromId)) {
    await sendMessage(fromId, "Boss sahypasy ýapyldy");
    await setBossState(fromId, false);
  }
  if (await getCreateBossState(fromId)) {
    await sendMessage(fromId, "Boss döretme sahypasy ýapyldy");
    await setCreateBossState(fromId, false);
  }
  if (await getGlobalMessageState(fromId)) {
    await sendMessage(fromId, "Global habar sahypasy ýapyldy");
    await setGlobalMessageState(fromId, false);
  }

  if (text.startsWith("/battle")) {
    if (queue.includes(fromId) || trophyQueue.includes(fromId)) {
      await sendMessage(fromId, "Siz eýýäm nobatda.");
      return;
    }
    if (battles[fromId]) {
      await sendMessage(fromId, "Siz eýýäm oýunda.");
      return;
    }
    queue.push(fromId);
    await sendMessage(fromId, "🔍 Garşydaş gözlenýär...");

    searchTimeouts[fromId] = setTimeout(async () => {
      const index = queue.indexOf(fromId);
      if (index !== -1) {
        queue.splice(index, 1);
        delete searchTimeouts[fromId];
        await sendMessage(fromId, "⏱️ Gözleg togtadyldy. Garşydaş tapylmady.");
      }
    }, 30_000) as unknown as number;

    if (queue.length >= 2) {
      const [p1, p2] = queue.splice(0, 2);
      await startBattle(p1, p2);
    }
    return;
  }

  if (text.startsWith("/realbattle")) {
    const profile = await getProfile(fromId);
    if (!profile || profile.tmt < 1) {
      await sendMessage(fromId, "❌ TMT söweş üçin 1 TMT gerek. @Masakoff bilen baglanyş.");
      return;
    }

    if (queue.includes(fromId) || trophyQueue.includes(fromId)) {
      await sendMessage(fromId, "Siz eýýäm nobatda.");
      return;
    }
    if (battles[fromId]) {
      await sendMessage(fromId, "Siz eýýäm oýunda.");
      return;
    }

    await updateProfile(fromId, { tmt: -1 });
    trophyQueue.push(fromId);
    await sendMessage(fromId, "🔍 TMT söweş üçin garşydaş gözlenýär... (1 TMT goýuldy)");

    searchTimeouts[fromId] = setTimeout(async () => {
      const index = trophyQueue.indexOf(fromId);
      if (index !== -1) {
        trophyQueue.splice(index, 1);
        await updateProfile(fromId, { tmt: 1 });
        await sendMessage(fromId, "⏱️ Gözleg togtadyldy. 1 TMT yzyna gaýtaryldy.");
        delete searchTimeouts[fromId];
      }
    }, 30_000) as unknown as number;

    if (trophyQueue.length >= 2) {
      const [p1, p2] = trophyQueue.splice(0, 2);
      await startBattle(p1, p2, true);
    }
    return;
  }

  if (text.startsWith("/profile")) {
    await sendProfile(fromId);
    return;
  }

  if (text.startsWith("/userprofile")) {
    if (username !== ADMIN_USERNAME) {
      await sendMessage(fromId, "❌ Ruhsat ýok.");
      return;
    }
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      await sendMessage(fromId, "Ulanyş: /userprofile <userId>");
      return;
    }
    const [, userId] = parts;
    await sendUserProfile(fromId, userId);
    return;
  }

  if (text.startsWith("/leaderboard")) {
    await sendLeaderboard(fromId, 0);
    return;
  }

  if (text.startsWith("/promocode")) {
    await setPromocodeState(fromId, true);
    await sendMessage(fromId, "Promokody giriziň:");
    return;
  }

  if (text.startsWith("/boss")) {
    await setBossState(fromId, true);
    await sendMessage(fromId, "Boss adyny giriziň:");
    return;
  }

  if (text.startsWith("/createpromocode")) {
    if (username !== ADMIN_USERNAME) {
      await sendMessage(fromId, "❌ Ruhsat ýok.");
      return;
    }
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) {
      await sendMessage(fromId, "Ulanyş: /createpromocode <aty> <sany>");
      return;
    }
    const [, code, maxStr] = parts;
    const maxUses = parseInt(maxStr);
    if (isNaN(maxUses) || maxUses < 1) {
      await sendMessage(fromId, "Nädogry san.");
      return;
    }
    await kv.set(["promocodes", code], { maxUses, currentUses: 0 });
    await sendMessage(fromId, `✅ Promokod döredildi: ${code} (sany: ${maxUses})`);
    return;
  }

  if (text.startsWith("/createboss")) {
    if (username !== ADMIN_USERNAME) {
      await sendMessage(fromId, "❌ Ruhsat ýok.");
      return;
    }
    await setCreateBossState(fromId, true);
    await sendMessage(fromId, "Boss suratyny ýazgy bilen iberiň: <aty> <turlar> <max_sany> <baha>");
    return;
  }

  if (text.startsWith("/addtouser")) {
    if (username !== ADMIN_USERNAME) {
      await sendMessage(fromId, "❌ Ruhsat ýok.");
      return;
    }
    const parts = text.trim().split(/\s+/);
    if (parts.length < 4) {
      await sendMessage(fromId, "Ulanyş: /addtouser tmt|trophies <userId> <mukdar>");
      return;
    }
    const [, type, userId, amountStr] = parts;
    const amount = parseFloat(amountStr);
    if (isNaN(amount)) {
      await sendMessage(fromId, "Nädogry mukdar.");
      return;
    }
    if (type === "tmt") {
      await updateProfile(userId, { tmt: amount });
      await sendMessage(fromId, `✅ ${amount} TMT goşuldy ID:${userId}`);
    } else if (type === "trophies") {
      await updateProfile(userId, { trophies: amount });
      await sendMessage(fromId, `✅ ${amount} kubok goşuldy ID:${userId}`);
    } else {
      await sendMessage(fromId, "Nädogry tip: tmt ýa-da trophies.");
    }
    return;
  }

  if (text.startsWith("/globalmessage")) {
    if (username !== ADMIN_USERNAME) {
      await sendMessage(fromId, "❌ Ruhsat ýok.");
      return;
    }
    await setGlobalMessageState(fromId, true);
    await sendMessage(fromId, "✏️ Global habary ýazyň:");
    return;
  }

  if (text.startsWith("/withdraw")) {
    const profile = await getProfile(fromId);
    if (!profile) {
      await sendMessage(fromId, "❌ Profil ýok. Ilki oýna başlaň!");
      return;
    }
    if (profile.tmt < 5) {
      await sendMessage(fromId, "❌ Çykarmak üçin iň az 5 TMT gerek.");
      return;
    }
    await handleWithdrawal(fromId, "");
    return;
  }

  if (text.startsWith("/stats")) {
    if (username !== ADMIN_USERNAME) {
      await sendMessage(fromId, "❌ Ruhsat ýok.");
      return;
    }
    await sendStats(fromId);
    return;
  }

  if (text.startsWith("/deleteuser")) {
    if (username !== ADMIN_USERNAME) {
      await sendMessage(fromId, "❌ Ruhsat ýok.");
      return;
    }
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      await sendMessage(fromId, "Ulanyş: /deleteuser <userId>");
      return;
    }
    const userId = parts[1];
    // Remove from queues
    queue = queue.filter(id => id !== userId);
    trophyQueue = trophyQueue.filter(id => id !== userId);
    // Clear search timeout
    if (searchTimeouts[userId]) {
      clearTimeout(searchTimeouts[userId]);
      delete searchTimeouts[userId];
    }
    // If in battle
    if (battles[userId]) {
      await endBattleIdle(battles[userId]);
    }
    // Delete profile
    await kv.delete(["profiles", userId]);
    // Delete used_promos
    for await (const entry of kv.list({ prefix: ["promocodes"] })) {
      const code = entry.key[1] as string;
      await kv.delete(["used_promos", code, userId]);
    }
    // Delete played_boss
    for await (const entry of kv.list({ prefix: ["bosses"] })) {
      const name = entry.key[1] as string;
      await kv.delete(["played_boss", name, userId]);
    }
    // Delete states
    await setWithdrawalState(userId, null);
    await setPromocodeState(userId, false);
    await setBossState(userId, false);
    await setCreateBossState(userId, false);
    await setGlobalMessageState(userId, false);
    await sendMessage(fromId, `✅ Ulanyjy ID:${userId} öçürildi.`);
    return;
  }

  if (text.startsWith("/start") || text.startsWith("/help")) {
    let referrerId: string | undefined;
    const parts = text.split(" ");
    if (parts.length > 1) {
      referrerId = parts[1];
    }
    if (referrerId && isNew && referrerId !== fromId) {
      const refProfile = await getProfile(referrerId);
      if (refProfile) {
        await updateProfile(referrerId, { tmt: 0.2, referrals: 1 });
        await sendMessage(referrerId, "✅ Täze referral! +0.2 TMT aldyňyz.");
        await sendMessage(fromId, `Siz ID:${referrerId} tarapyndan çagyryldyňyz.`);
      }
    }

    const userCount = await getUserCount();
    const helpText =
      `🌟 Salam! TkmXO BOT-a hoş geldiňiz!\n\n` +
      `🎮 TkmXO oyuny bilen, dostlaryňyz bilen ýa-da AI bilen söweş ediň. ⚔️\n\n` +
      `🎁 Ilkinji synanyşyk mugt! Başlangyç üçin mugt /battle bilen botu barlaň. Has köp oýnamak üçin /realbattle-da TMT goýuň. 😄\n\n` +
      `👥 Dostlaryňyzy çagyryň we TMT gazanyň! Çagyrýan her bir dostuňyz üçin 0.2 TMT gazanyň. 💸\n\n` +
      `👥 Umumy ulanyjy sany: ${userCount}\n\n` +
      `🚀 Başlamak üçin aşakdaky düwmelerden birini saýla:`;
    const mainMenu = {
      inline_keyboard: [
        [{ text: "⚔️ Battle", callback_data: "menu:battle" }, { text: "🏆 Real Battle", callback_data: "menu:realbattle" }],
        [{ text: "🤖 Boss", callback_data: "menu:boss" }, { text: "🎟️ Promocode", callback_data: "menu:promocode" }],
        [{ text: "📊 Profile", callback_data: "menu:profile" }, { text: "🏅 Leaderboard", callback_data: "menu:leaderboard" }],
        [{ text: "💸 Withdraw", callback_data: "menu:withdraw" }],
      ]
    };
    await sendMessage(fromId, helpText, { parse_mode: "Markdown", reply_markup: mainMenu });
    return;
  }

  await sendMessage(fromId, "❓ Näbelli buýruk. /help gör.");
}

// -------------------- Server / Webhook --------------------
serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    if (url.pathname !== SECRET_PATH) return new Response("Not found", { status: 404 });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const update = await req.json();

    // handle normal messages
    if (update.message) {
      const msg = update.message;
      const from = msg.from;
      const text = (msg.text || "").trim();
      const fromId = String(from.id);
      const username = from.username;
      const displayName = from.first_name || from.username || fromId;

      const { isNew } = await initProfile(fromId, username, displayName);

      if (text.startsWith("/")) {
        await handleCommand(fromId, username, displayName, text, isNew);
      } else if (await getGlobalMessageState(fromId)) {
        await setGlobalMessageState(fromId, false);
        for await (const entry of kv.list({ prefix: ["profiles"] })) {
          const profile = entry.value as Profile;
          if (!profile) continue;
          await sendMessage(profile.id, `📢 *Global habar:*\n\n${text}`, { parse_mode: "Markdown" });
        }
        await sendMessage(fromId, "✅ Global habar iberildi!");
      } else if (await getWithdrawalState(fromId)) {
        await handleWithdrawal(fromId, text);
      } else if (await getPromocodeState(fromId)) {
        await handlePromocodeInput(fromId, text);
      } else if (await getBossState(fromId)) {
        await handleBossInput(fromId, text);
      } else if (await getCreateBossState(fromId) && msg.photo) {
        await handleCreateBoss(msg, fromId);
      } else {
        await sendMessage(fromId, "❓ Näbelli buýruk. /help gör.");
      }
    }
    // handle callback queries
    else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }

    return new Response("OK");
  } catch (e) {
    console.error("server error", e);
    return new Response("Error", { status: 500 });
  }
});





