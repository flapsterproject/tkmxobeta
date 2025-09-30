// main.ts
// Telegram Tic-Tac-Toe Bot (Deno) - Fixed, Patched & Improved
// - Inline navigation main menu (delete previous menu and create "touched" section)
// - Require subscription to @TkmXO for actions (except /start, /help, admin createpromocode)
// - Promocode system: /createpromocode <name> <amount> (admin), /promocode (user flow)
// - Improved callback handling (passes message id/chat id), small bugfixes

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const TOKEN = Deno.env.get("BOT_TOKEN")!;
if (!TOKEN) throw new Error("BOT_TOKEN env var is required");
const API = `https://api.telegram.org/bot${TOKEN}`;
const SECRET_PATH = "/tkmxo"; // webhook path
const REQUIRED_CHANNEL = "@TkmXO"; // channel to require subscription

// Deno KV
const kv = await Deno.openKv();

const ADMIN_USERNAME = "@Masakoff"; // admin username (with @)

// runtime storages
let queue: string[] = [];
let trophyQueue: string[] = [];
const battles: Record<string, any> = {};
const searchTimeouts: Record<string, number> = {};
const withdrawalStates: Record<string, { amount: number; step: "amount" | "phone" }> = {};
const globalMessageStates: Record<string, boolean> = {};
const promocodeStates: Record<string, boolean> = {};

// -------------------- Telegram helpers --------------------
async function sendMessage(chatId: string | number, text: string, options: any = {}) {
  try {
    const body: any = { chat_id: chatId, text, ...options };
    const res = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()).result?.message_id ?? null;
  } catch (e) {
    console.error("sendMessage error", e);
    return null;
  }
}

async function editMessageText(chatId: string | number, messageId: number, text: string, options: any = {}) {
  try {
    const body = { chat_id: chatId, message_id: messageId, text, ...options };
    await fetch(`${API}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    console.warn("editMessageText failed", e?.message ?? e);
  }
}

async function answerCallbackQuery(id: string, text = "", showAlert = false) {
  try {
    await fetch(`${API}/answerCallbackQuery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: id, text, show_alert: showAlert }) });
  } catch (e) {
    console.warn("answerCallbackQuery failed", e?.message ?? e);
  }
}

async function deleteMessage(chatId: string | number, messageId: number) {
  try {
    await fetch(`${API}/deleteMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, message_id: messageId }) });
  } catch (e) {
    console.warn("deleteMessage failed", e?.message ?? e);
  }
}

// Check user subscription to REQUIRED_CHANNEL
async function isSubscribed(userId: string) {
  try {
    // getChatMember requires bot to be able to query that channel; channel must be public
    const res = await fetch(`${API}/getChatMember?chat_id=${encodeURIComponent(REQUIRED_CHANNEL)}&user_id=${encodeURIComponent(userId)}`);
    const j = await res.json();
    if (!j || !j.result) return false;
    const status = j.result.status;
    return status === "creator" || status === "administrator" || status === "member";
  } catch (e) {
    console.warn("isSubscribed check failed", e);
    // if we can't check, conservative approach: require subscription by returning false
    return false;
  }
}

// -------------------- Profile helpers --------------------

type Profile = {
  id: string;
  username?: string;
  displayName: string;
  trophies: number;
  tmt: number; // TMT balance
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
    // allow decimals for tmt
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

// -------------------- Leaderboard helpers --------------------
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
    await sendMessage(chatId, "No players yet! Start playing to climb the leaderboard!");
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

// -------------------- Game logic (unchanged, minor fixes) --------------------
function createEmptyBoard(): string[] { return Array(9).fill(""); }
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

// -------------------- Battle control (mostly unchanged) --------------------
async function startBattle(p1: string, p2: string, isTrophyBattle: boolean = false) {
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
    isTrophyBattle: isTrophyBattle,
  };
  battles[p1] = battle; battles[p2] = battle;

  await initProfile(p1); await initProfile(p2);

  const battleTypeText = isTrophyBattle ? "🏆 *Pul üçin oýun*" : "⚔️ *Kubok uchun oýun*";
  const stakeText = isTrophyBattle ? "\n\nGoýumlar: Iki oýunçy hem 1 TMT töwekgelçilige salýar. Ýeňiji +0.75 TMT alýar." : "";

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
  const loser = battle.turn; const winner = battle.players.find((p: string) => p !== loser)!;
  await sendMessage(loser, "⚠️ Herekede gijä galdyňyz. Siz tabşyrdyňyz.");
  await sendMessage(winner, "⚠️ Garşydaşyňyz herekede gijä galdy. Olar tabşyrdy. Siz ýeňdiňiz!");

  if (battle.idleTimerId) { clearTimeout(battle.idleTimerId); delete battle.idleTimerId; }
  if (battle.moveTimerId) { clearTimeout(battle.moveTimerId); delete battle.moveTimerId; }

  await finishMatch(battle, { winner: winner, loser: loser });
}

async function sendRoundStart(battle: any) {
  for (const player of battle.players) {
    const header = headerForPlayer(battle, player);
    const yourTurn = battle.turn === player;
    const text =
      `${header}\n\n` +
      `*Tur ${battle.round}/3*\n` +
      `📊 Bal: ${battle.roundWins[battle.players[0]]} - ${battle.roundWins[battle.players[1]]}\n` +
      `🎲 Hereket: ${yourTurn ? "*Seniň hereketiň" : "Garşydaşyň hereketi"}\n` +
      boardToText(battle.board);
    const msgId = await sendMessage(player, text, { reply_markup: makeInlineKeyboard(battle.board), parse_mode: "Markdown" });
    if (msgId) battle.messageIds[player] = msgId;
  }

  if (battle.idleTimerId) clearTimeout(battle.idleTimerId);
  battle.idleTimerId = setTimeout(() => endBattleIdle(battle), 5 * 60 * 1000);

  if (battle.moveTimerId) clearTimeout(battle.moveTimerId);
  battle.moveTimerId = setTimeout(() => endTurnIdle(battle), 1 * 60 * 1000);
}

async function endBattleIdle(battle: any) {
  const [p1, p2] = battle.players;
  await sendMessage(p1, "⚠️ Oýun hereketsizlik sebäpli tamamlandy (5 minut).", { parse_mode: "Markdown" });
  await sendMessage(p2, "⚠️ Oýun hereketsizlik sebäpli tamamlandy (5 minut).", { parse_mode: "Markdown" });

  if (battle.isTrophyBattle) {
    await updateProfile(p1, { tmt: 1 });
    await updateProfile(p2, { tmt: 1 });
    await sendMessage(p1, "💸 Hereketsiz oýun üçin size 1 TMT yzyna gaýtaryldy.");
    await sendMessage(p2, "💸 Hereketsiz oýun üçin size 1 TMT yzyna gaýtaryldy.");
  }

  delete battles[p1]; delete battles[p2];
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
        await sendMessage(p1, "💸 Deňlik üçin size 1 TMT yzyna gaýtaryldy.");
        await sendMessage(p2, "💸 Deňlik üçin size 1 TMT yzyna gaýtaryldy.");
      }
    } else if (result.winner) {
      const winner = result.winner!; const loser = result.loser!;
      await initProfile(winner); await initProfile(loser);

      await updateProfile(winner, { gamesPlayed: 1, wins: 1, trophies: 1 });
      await updateProfile(loser, { gamesPlayed: 1, losses: 1, trophies: -1 });
      await sendMessage(winner, `🎉 Siz oýunda ýeňdiňiz!\n🏆 *+1 kubok* (vs ID:${loser})`, { parse_mode: "Markdown" });
      await sendMessage(loser, `😢 Siz oýunda utuldyňyz.\n🏆 *-1 kubok* (vs ID:${winner})`, { parse_mode: "Markdown" });

      if (battle.isTrophyBattle) {
        await updateProfile(winner, { tmt: 1.75 });
        await updateProfile(loser, { tmt: -0 });
        await sendMessage(winner, "🏆 TMT + Kubok oýunda ýeňeniňiz üçin 0.75 TMT aldyňyz!");
        await sendMessage(loser, "💔 TMT + Kubok oýunda utulanyňyz üçin 1 TMT alyndy.");
      }
    }

    delete battles[p1]; delete battles[p2];
  } catch (err) {
    console.error("finishMatch error:", err);
  }
}

// -------------------- Promocode helpers --------------------
async function createPromoCode(codeName: string, count: number) {
  await kv.set(["promocodes", codeName.toLowerCase()], { remaining: count });
}
async function getPromoCode(codeName: string) {
  const res = await kv.get(["promocodes", codeName.toLowerCase()]);
  return res.value as { remaining: number } | null;
}
async function usePromoCode(codeName: string, userId: string) {
  const key = ["promocodes", codeName.toLowerCase()];
  const res = await kv.get(key);
  if (!res.value) return { ok: false, reason: "not_exist" };
  const data = res.value as { remaining: number };
  if ((data.remaining || 0) <= 0) return { ok: false, reason: "out" };

  // check used
  const used = (await kv.get(["used_promocodes", userId, codeName.toLowerCase()])).value;
  if (used) return { ok: false, reason: "already" };

  // decrement
  data.remaining = (data.remaining || 0) - 1;
  await kv.set(key, data);
  await kv.set(["used_promocodes", userId, codeName.toLowerCase()], true);
  return { ok: true };
}

// -------------------- Callback handler --------------------
// Modified to accept callback message identifiers so we can delete the menu
async function handleCallback(fromId: string, data: string | null, callbackId: string, cbChatId?: number | string, cbMessageId?: number) {
  if (!data) { await answerCallbackQuery(callbackId); return; }
  try {
    // leaderboard pagination
    if (data.startsWith("leaderboard:")) {
      const page = parseInt(data.split(":")[1]) || 0;
      await sendLeaderboard(fromId, page);
      await answerCallbackQuery(callbackId);
      return;
    }

    if (data === "noop") { await answerCallbackQuery(callbackId); return; }

    // Menu navigation actions: delete menu and send section message
    if (data.startsWith("menu:")) {
      const section = data.split(":")[1] || "";
      if (cbChatId && cbMessageId) {
        await deleteMessage(cbChatId, cbMessageId);
      }
      const sectionText = `🧭 Section: *${section}*\n(touched to inline button)`;
      const keyboard = { inline_keyboard: [[{ text: "🔙 Back to menu", callback_data: "menu:main" }]] };
      await sendMessage(fromId, sectionText, { parse_mode: "Markdown", reply_markup: keyboard });
      await answerCallbackQuery(callbackId);
      return;
    }

    // if the user is in a battle, use game handlers (we keep using fromId to find battles)
    const battle = battles[fromId];

    if (!battle) {
      if (data === "surrender") { await answerCallbackQuery(callbackId, "Siz oýunda dälsiňiz.", true); return; }
      await answerCallbackQuery(callbackId); return;
    }

    // Reset timers
    if (battle.idleTimerId) { clearTimeout(battle.idleTimerId); battle.idleTimerId = setTimeout(() => endBattleIdle(battle), 5 * 60 * 1000); }
    if (battle.moveTimerId) { clearTimeout(battle.moveTimerId); battle.moveTimerId = setTimeout(() => endTurnIdle(battle), 1 * 60 * 1000); }

    if (data === "surrender") {
      const opponent = battle.players.find((p: string) => p !== fromId)!;
      await sendMessage(fromId, "🏳️ Siz oýunu tabşyrdyňyz.");
      await sendMessage(opponent, "🏳️ Garşydaşyňyz tabşyrdy. Oýunu siz ýeňdiňiz!");
      await finishMatch(battle, { winner: opponent, loser: fromId });
      await answerCallbackQuery(callbackId, "Siz tabşyrdyňyz.");
      return;
    }

    if (!data.startsWith("hereket:")) { await answerCallbackQuery(callbackId); return; }

    const idx = parseInt(data.split(":")[1]);
    if (isNaN(idx) || idx < 0 || idx > 8) { await answerCallbackQuery(callbackId, "Nädogry hereket.", true); return; }
    if (battle.turn !== fromId) { await answerCallbackQuery(callbackId, "Siziň herekediňiz däl.", true); return; }
    if (battle.board[idx] !== "") { await answerCallbackQuery(callbackId, "Bu öýjük eýýäm eýelenipdi.", true); return; }

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

      // Start next round
      battle.round++;
      battle.board = createEmptyBoard();
      battle.turn = battle.players[(battle.round - 1) % 2];

      if (battle.moveTimerId) clearTimeout(battle.moveTimerId);
      battle.moveTimerId = setTimeout(() => endTurnIdle(battle), 1 * 60 * 1000);

      await sendRoundStart(battle);
      await answerCallbackQuery(callbackId, "Hereket edildi!");
      return;
    }

    // Continue game
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

// -------------------- Withdrawal functionality --------------------
async function handleWithdrawal(fromId: string, text: string) {
  if (withdrawalStates[fromId]) {
    const state = withdrawalStates[fromId];

    if (state.step === "amount") {
      const amount = parseFloat(text);

      if (isNaN(amount) || amount <= 0) {
        await sendMessage(fromId, "❌ TMT çykarmak mukdary üçin hakyky san giriziň.");
        return;
      }

      const profile = await getProfile(fromId);
      if (!profile || profile.tmt < amount) {
        await sendMessage(fromId, `❌ Siziň ýeterlik TMT-ňiz ýok. Häzirki balansyňyz: ${profile?.tmt ?? 0} TMT.`);
        delete withdrawalStates[fromId];
        return;
      }

      withdrawalStates[fromId] = { amount, step: "phone" };
      await sendMessage(fromId, "📱 TMT çykarmak üçin telefon belgäňizi giriziň:");
      return;
    } else if (state.step === "phone") {
      const phoneNumber = text.trim();
      if (phoneNumber.length < 5) { await sendMessage(fromId, "❌ Hakyky telefon belgini giriziň."); return; }

      const amount = state.amount; const profile = await getProfile(fromId);
      if (!profile || profile.tmt < amount) { await sendMessage(fromId, "❌ Näsazlyk: Balans ýeterlik däl. Täzeden synanyşyň."); delete withdrawalStates[fromId]; return; }

      try {
        await updateProfile(fromId, { tmt: -amount });

        await sendMessage(fromId, `✅ Çykarma soragy üstünlikli iberildi!\n\nMukdar: ${amount} TMT\nTelefon nomer: ${phoneNumber}\n\nSiziň soragyňyz işlenýär.`);

        const adminProfile = await getProfileByUsername(ADMIN_USERNAME.replace("@", ""));
        const adminId = adminProfile?.id || ADMIN_USERNAME;
        const userDisplayName = profile.displayName || `ID:${fromId}`;
        const adminMessage = `💰 *WITHDRAWAL REQUEST*\n\nUser: ${userDisplayName} (ID: ${fromId})\nAmount: ${amount} TMT\nPhone: ${phoneNumber}\n\nPlease process this withdrawal manually.`;
        await sendMessage(adminId, adminMessage, { parse_mode: "Markdown" });

        delete withdrawalStates[fromId];
      } catch (error) {
        console.error("Withdrawal processing error:", error);
        await sendMessage(fromId, "❌ Çykarma işlemi ýerine ýetirilýän wagty bir näsazlyk ýüze çykdy. Täzeden synanyşyň.");
        delete withdrawalStates[fromId];
      }

      return;
    }
  } else {
    await sendMessage(fromId, "💰 Çykarmak isleýän TMT mukdaryňy giriziň:");
    withdrawalStates[fromId] = { amount: 0, step: "amount" };
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
  } catch (e) { console.error("getProfileByUsername kv.list error", e); }
  return null;
}

// -------------------- Menu helpers --------------------
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "👤 Profile", callback_data: "menu:profile" },
        { text: "🏆 Leaderboard", callback_data: "menu:leaderboard" }
      ],
      [
        { text: "⚔️ Battle", callback_data: "menu:battle" },
        { text: "🏅 RealBattle", callback_data: "menu:realbattle" }
      ],
      [
        { text: "💸 Withdraw", callback_data: "menu:withdraw" },
        { text: "🎟️ Promocode", callback_data: "menu:promocode" }
      ]
    ]
  };
}

// -------------------- Commands --------------------
async function handleCommand(fromId: string, username: string | undefined, displayName: string, text: string) {
  const uid = fromId;
  // allow /start and /help without subscription
  if (text.startsWith("/start") || text.startsWith("/help")) {
    const helpText =
      `🎮 *TkmXO Bot-a hoş geldiňiz!*\n\n` +
      `Aşakdaky buýruklary ulanyň:\n` +
      `🔹 /battle - Adaty kubok duşuşyk üçin garşydaş tap.\n` +
      `🔹 /realbattle - TMT + Kubok duşyk (1 TMT goýum talap edýär).\n` +
      `🔹 /profile - Statistikalaryňy we derejäňizi gör.\n` +
      `🔹 /leaderboard - Iň ýokary oýunçylary gör.\n` +
      `🔹 /withdraw - TMT balansyňy çykarmak.\n` +
      `🔹 /promocode - Aktiwleştirmek üçin promo kody giriziň.\n\n` +
      `Also you can use inline menu below.`;
    const msgId = await sendMessage(uid, helpText, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
    return;
  }

  // Admin create promocode allowed without subscription
  if (text.startsWith("/createpromocode")) {
    if (username !== ADMIN_USERNAME.replace("@", "")) { await sendMessage(uid, "❌ Unauthorized."); return; }
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) { await sendMessage(uid, "Usage: /createpromocode <name> <count>"); return; }
    const code = parts[1]; const count = parseInt(parts[2]);
    if (isNaN(count) || count <= 0) { await sendMessage(uid, "Count must be positive integer."); return; }
    await createPromoCode(code, count);
    await sendMessage(uid, `✅ Promocode ${code} created with ${count} uses.`);
    return;
  }

  // For most actions ensure subscription
  if (!(text.startsWith("/createpromocode") || text.startsWith("/start") || text.startsWith("/help"))) {
    const ok = await isSubscribed(uid);
    if (!ok) {
      await sendMessage(uid, `❗️ Please subscribe to ${REQUIRED_CHANNEL} to use the bot.`);
      return;
    }
  }

  if (text.startsWith("/battle")) {
    if (queue.includes(uid)) { await sendMessage(uid, "Siz eýýäm oýun nobatynda dursyňyz. Garşydaşyňyza garaşyň."); return; }
    if (battles[uid]) { await sendMessage(uid, "Siz eýýäm oýunda. Ilki häzirki oýunyňyzy tamamlaň."); return; }
    queue.push(uid); await sendMessage(uid, "🔍 Garşydaş gözlenýär…");

    searchTimeouts[uid] = setTimeout(async () => {
      const index = queue.indexOf(uid);
      if (index !== -1) { queue.splice(index, 1); delete searchTimeouts[uid]; await sendMessage(uid, "⏱️ Gözleg 30 sekuntdan soň togtadyldy. Garşydaş tapylmady."); }
    }, 30_000) as unknown as number;

    if (queue.length >= 2) {
      const [p1, p2] = queue.splice(0, 2);
      if (searchTimeouts[p1]) { clearTimeout(searchTimeouts[p1]); delete searchTimeouts[p1]; }
      if (searchTimeouts[p2]) { clearTimeout(searchTimeouts[p2]); delete searchTimeouts[p2]; }
      await startBattle(p1, p2);
    }
    return;
  }

  if (text.startsWith("/realbattle")) {
    const profile = await getProfile(uid);
    if (!profile || profile.tmt < 1) { await sendMessage(uid, "❌ TMT + Kubok oýna girmek üçin iň az 1 TMT gerek.Balansyňyzy doldurmak üçin 👉 @Masakoff"); return; }
    if (trophyQueue.includes(uid)) { await sendMessage(uid, "Siz eýýäm Kubokly oýun nobatynda dursyňyz. Garşydaşyňyza garaşyň."); return; }
    if (battles[uid]) { await sendMessage(uid, "Siz eýýäm bir oýunda. Ilki häzirki oýunyňy tamamlaň."); return; }

    await updateProfile(uid, { tmt: -1 }); trophyQueue.push(uid);
    await sendMessage(uid, "🔍 Kubokly duşuşyk üçin garşydaş gözlenýär...\n(Bu oýun üçin 1 TMT saklanyldy)");

    searchTimeouts[uid] = setTimeout(async () => {
      const index = trophyQueue.indexOf(uid);
      if (index !== -1) { trophyQueue.splice(index, 1); delete searchTimeouts[uid]; await updateProfile(uid, { tmt: 1 }); await sendMessage(uid, "⏱️ Gözleg 30 sekuntdan soň togtadyldy. Garşydaş tapylmady. 1 TMT yzyna gaýtaryldy."); }
    }, 30_000) as unknown as number;

    if (trophyQueue.length >= 2) {
      const [p1, p2] = trophyQueue.splice(0, 2);
      if (searchTimeouts[p1]) { clearTimeout(searchTimeouts[p1]); delete searchTimeouts[p1]; }
      if (searchTimeouts[p2]) { clearTimeout(searchTimeouts[p2]); delete searchTimeouts[p2]; }
      await updateProfile(p2, { tmt: -1 }); await startBattle(p1, p2, true);
    }
    return;
  }

  if (text.startsWith("/profile")) { await sendProfile(uid); return; }
  if (text.startsWith("/leaderboard")) { await sendLeaderboard(uid, 0); return; }

  if (text.startsWith("/addtouser")) {
    const adminNameWithoutAt = ADMIN_USERNAME.replace("@", "");
    if (username !== adminNameWithoutAt) { await sendMessage(uid, "❌ Unauthorized."); return; }
    const parts = text.trim().split(/\s+/);
    if (parts.length < 4) { await sendMessage(uid, "Usage: `/addtouser tmt <userId> <amount>` or `/addtouser trophies <userId> <amount>`", { parse_mode: "Markdown" }); return; }
    const type = parts[1]; const userId = parts[2]; const amount = parseFloat(parts[3]);
    if (isNaN(amount)) { await sendMessage(uid, "Invalid amount value. Please provide a number."); return; }
    if (type === "tmt") { await updateProfile(userId, { tmt: amount }); await sendMessage(uid, `✅ Added ${amount} TMT to ID:${userId}`); }
    else if (type === "trophies") { await updateProfile(userId, { trophies: amount }); await sendMessage(uid, `✅ Added ${amount} trophies to ID:${userId}`); }
    else { await sendMessage(uid, "Invalid type. Use 'tmt' or 'trophies'."); }
    return;
  }

  if (text.startsWith("/globalmessage")) {
    if (username !== ADMIN_USERNAME.replace("@", "")) { await sendMessage(uid, "❌ Unauthorized."); return; }
    globalMessageStates[uid] = true; await sendMessage(uid, "✏️ Write your global message:"); return;
  }

  if (text.startsWith("/withdraw")) {
    const profile = await getProfile(uid);
    if (!profile) { await sendMessage(uid, "❌ TMT çykarmak üçin profil gerek. Ilki oýna başla!"); return; }
    await handleWithdrawal(uid, ""); return;
  }

  if (text.startsWith("/promocode")) {
    // ask user to send promocode string
    await sendMessage(uid, "🔐 Please send the promocode you want to activate (case-insensitive).");
    promocodeStates[uid] = true;
    return;
  }

  // ongoing promocode state
  if (promocodeStates[uid]) {
    const code = text.trim().toLowerCase();
    promocodeStates[uid] = false;
    const promo = await getPromoCode(code);
    if (!promo) { await sendMessage(uid, "❌ This promocode is not available."); return; }
    // check used
    const used = (await kv.get(["used_promocodes", uid, code])).value;
    if (used) { await sendMessage(uid, "❌ You already used this promocode."); return; }
    if ((promo.remaining || 0) <= 0) { await sendMessage(uid, "❌ This promocode has no remaining uses."); return; }
    const res = await usePromoCode(code, uid);
    if (!res.ok) {
      if (res.reason === "already") await sendMessage(uid, "❌ You already used this promocode.");
      else if (res.reason === "out") await sendMessage(uid, "❌ This promocode has no remaining uses.");
      else await sendMessage(uid, "❌ Promocode not available.");
      return;
    }
    await updateProfile(uid, { tmt: 1 });
    await sendMessage(uid, "✅ Promocode activated. You received +1 TMT!");
    return;
  }

  // ongoing withdrawal input
  if (withdrawalStates[uid]) { await handleWithdrawal(uid, text); return; }

  await sendMessage(uid, "❓ Näbelli buýruk. Buýruklaryň sanawyny görmek üçin /help ýazyň.");
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

      // Ensure profile exists
      await initProfile(fromId, username, displayName);

      // Ignore messages if user is searching or in battle (don't block non-bot admin commands though)
      if (queue.includes(fromId) || trophyQueue.includes(fromId) || battles[fromId]) {
        return new Response("OK");
      }

      if (text.startsWith("/")) { await handleCommand(fromId, username, displayName, text); }
      else if (globalMessageStates[fromId]) {
        globalMessageStates[fromId] = false;
        for await (const entry of kv.list({ prefix: ["profiles"] })) {
          const profile = entry.value as Profile;
          if (!profile) continue;
          await sendMessage(profile.id, `📢 *Global Bildiriş:*\n\n${text}`, { parse_mode: "Markdown" });
        }
        await sendMessage(fromId, "✅ Global message sent!");
      } else if (withdrawalStates[fromId]) { await handleWithdrawal(fromId, text); }
      else if (promocodeStates[fromId]) { await handleCommand(fromId, username, displayName, text); }
      else { await sendMessage(fromId, "❓ Näbelli buýruk. Buýruklaryň sanawyny görmek üçin /help ýazyň."); }

    }
    // handle callback queries
    else if (update.callback_query) {
      const cb = update.callback_query;
      const fromId = String(cb.from.id);
      const data = cb.data ?? null;
      const cbChatId = cb.message?.chat?.id;
      const cbMsgId = cb.message?.message_id;
      await handleCallback(fromId, data, cb.id, cbChatId, cbMsgId);
    }

    return new Response("OK");
  } catch (e) {
    console.error("server error", e);
    return new Response("Error", { status: 500 });
  }
});



